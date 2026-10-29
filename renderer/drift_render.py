"""LOCAL Extra FX donor renderer + end-to-end targeted update on a one-time rebaseline.

    TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_render \\
        --rebaseline-dir $TMPDIR/<rebaseline> --candidate-dir $TMPDIR/<candidate> \\
        --slide-step-id <stable step id> --output $TMPDIR/NEW-directory \\
        [--build-dir out/<name>/_build] [--golden-build-dir out/<name>/_build] [--no-replan]

Inputs: a renderer.rebaseline directory (baseline-manifest.json, baseline-assembly.json, cells, final) and a
tools/drift/candidate.mjs output (candidate.script.json, identified-base.script.json, manifest.json,
_recordings/<id>/). Slides are rendered through assemble.py's OWN drawing functions (renderer.fx_draw, AST-extracted,
never imported/executed).

Planning (before anything is rendered):
- screenshot-only interior change whose size/geometry/grouping reproduce the persisted plan: the FROZEN persisted
  _cam/_fx/_cap_* plan, dirty = that slide;
- otherwise (moved target, other screenshot size, regrouped screen): assemble's planner (fx_draw.load_planner) re-plans
  the video; re-planning the UNCHANGED script must reproduce every persisted plan field (else replan_golden_mismatch);
  dirty = changed slide + every slide whose render-relevant plan differs (one contiguous run; a regroup just expands it).
  --no-replan keeps the explicit scope_expansion_required:* rejections.
- a dirty first/last slide needs --build-dir: its dissolve is assemble's card crossfade (title/intro lead 0.65 s,
  support 0.65 s), else unsupported_edge_slide.

Rendering: with --build-dir ('assemble_chain'), only the dirty slides are re-rendered; the other segments and the card
clips are the real _build files (bound to the baseline by the original final's sha256), then assemble's own stitch +
crossfade_pair chain (same encoders) runs; a control chain over the untouched segments must decode-equal the original
final first (chain golden). Without it ('lossless_subchain', interior only): dirty slides + neighbours, xfade to FFV1.
The dirty cells are cut, encoded in the rebaseline profile, spliced by renderer.rebaseline.assemble_candidate and
verified by renderer.preservation. Not supported: clip slides, narration/caption/timing changes, multi-step candidates,
a crossfade that fell back to concat. Never writes under the repository; no TTS, network, bridge or publishing.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import fx_draw, fx_scope, rebaseline
from .preservation import file_hash, load_scope

REPO = Path(__file__).resolve().parent.parent
STEP_FIELDS_ALLOWED = {'media', 'captureId', 'target', 'dpr'}


class DonorRejected(ValueError):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def _canon(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def new_dir(path):
    p = Path(path).absolute()
    root = Path(os.environ['TMPDIR']).resolve()
    if not p.parent.resolve().is_relative_to(root):
        raise ValueError('output_must_be_under_TMPDIR')
    if p.parent.resolve().is_relative_to(REPO.resolve()):
        raise ValueError('output_inside_repo')
    p.mkdir()  # exclusive
    return p


def _png_size(path):
    from PIL import Image
    with Image.open(path) as im:
        if im.format != 'PNG':
            raise DonorRejected('unsupported_asset')
        return im.size


def load_rebaseline(rdir):
    rdir = Path(rdir).resolve()
    manifest = rdir / 'baseline-manifest.json'
    m = json.loads(manifest.read_bytes())
    if m.get('profile') != rebaseline.PROFILE_NAME:
        raise ValueError('unsupported_rebaseline_profile')
    rebaseline.validate_manifest(m, rdir)  # assembly hash bound + cells == fx timeline
    assembly = json.loads((rdir / m['assembly']['file']).read_bytes())
    final = rdir / m['final']['file']
    if file_hash(final) != m['final']['sha256']:
        raise ValueError('baseline_conflict')
    return rdir, manifest, m, assembly, final


def load_candidate(cdir):
    cdir = Path(cdir).resolve()
    meta = json.loads((cdir / 'manifest.json').read_bytes())
    cand = json.loads((cdir / 'candidate.script.json').read_bytes())
    base = json.loads((cdir / 'identified-base.script.json').read_bytes())
    if meta.get('status') != 'local_candidate_ready' or cand['recording']['id'] != meta['recordingId']:
        raise ValueError('invalid_candidate')
    rec = cdir / '_recordings' / meta['recordingId']
    if not rec.is_dir() or rec.is_symlink():
        raise ValueError('invalid_candidate')
    for a in meta['assets']:
        p = rec / a['name']
        if Path(a['name']).name != a['name'] or file_hash(p) != a['sha256']:
            raise ValueError('candidate_asset_mismatch')
    return cdir, meta, base, cand, rec


def _captured(script):
    return [st for st in script['steps'] if st.get('capture') is not False and (st.get('media') or {}).get('pre')]


# ---------- assemble's card crossfade chain (step 5), video only ----------

CARD_XF, OUTRO_XF = fx_scope.CARD_XF, fx_scope.OUTRO_XF
CROSSFADE_FINAL_ENCODE = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18']  # crossfade_pair(..., intermediate=False)


def media_duration(path):
    """assemble.dur(): FORMAT duration (audio included), which is what crossfade_pair's offset is computed from."""
    return float(fx_draw.sh('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path).decode())


def crossfade_command(c1, c2, output, xf, offset, encode, audio=False):
    """assemble.crossfade_pair's ffmpeg call (video graph verbatim; audio only when asked, e.g. for fixtures)."""
    fc = f"[0:v][1:v]xfade=transition=fade:duration={xf}:offset={offset:.3f}[v]"
    maps = ['-map', '[v]']
    tail = []
    if audio:
        fc += f";[0:a][1:a]acrossfade=d={xf}[a]"
        maps += ['-map', '[a]']
        tail = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
    return ['ffmpeg', '-y', '-v', 'error', '-i', str(c1), '-i', str(c2), '-filter_complex', fc, *maps, *encode, '-pix_fmt', 'yuv420p',
            *tail, str(output)]


def load_build(build_dir, assembly):
    """The real assemble `_build` artifacts (READ-ONLY) the chain re-uses: segNN.mp4 of untouched slides and the card
    clips, plus the crossfade offsets assemble derived from its intermediates' format durations. Mirrors assemble step 5:
    lead = intro+title crossfade (or title, or intro alone) -> body (0.65 s) -> support (0.65 s) -> outro (0.8 s); fails
    closed when an intermediate is missing (a crossfade failed -> concat fallback) or the lead offset disagrees with
    assembly.content_offset."""
    b = Path(build_dir).resolve()

    def need(name):
        q = b / name
        if not q.is_file() or q.is_symlink():
            raise DonorRejected('missing_build_artifact', name)
        return q
    segs = {s['slide']: need(f"seg{s['slide']:02d}.mp4") for s in assembly['slides']}
    stages = []
    lead = None
    if assembly.get('intro') and assembly.get('title_card'):
        lead = need('intro_title_crossfaded.mp4')
    elif assembly.get('title_card'):
        lead = need('title_card.mp4')
    elif assembly.get('intro'):
        lead = need('logo_card.mp4')
    support = need('support_card.mp4') if assembly.get('support_card') else None
    outro = need('logo_card.mp4') if assembly.get('outro') else None
    active = need('content.mp4')
    if lead is not None:
        d = media_duration(lead)
        if round(max(0.0, d - CARD_XF), 3) != round(assembly['content_offset'], 3):
            raise DonorRejected('card_timing_mismatch', {'lead_duration': d, 'content_offset': assembly['content_offset']})
        stages.append({'stage': 'lead', 'clip': str(lead), 'content_second': True, 'xf': CARD_XF, 'offset': max(0.05, d - CARD_XF),
                       'intermediate': bool(support or outro), 'real_output': str(need('body_crossfaded.mp4'))})
        active = need('body_crossfaded.mp4')
    elif assembly.get('content_offset'):
        raise DonorRejected('card_timing_mismatch', 'content_offset_without_lead')
    if support is not None:
        stages.append({'stage': 'support', 'clip': str(support), 'content_second': False, 'xf': CARD_XF,
                       'offset': max(0.05, media_duration(active) - CARD_XF), 'intermediate': bool(outro),
                       'real_output': str(need('body_with_support.mp4')) if outro else None})
        if outro:
            active = need('body_with_support.mp4')
    if outro is not None:
        stages.append({'stage': 'outro', 'clip': str(outro), 'content_second': False, 'xf': OUTRO_XF,
                       'offset': max(0.05, media_duration(active) - OUTRO_XF), 'intermediate': False, 'real_output': None})
    files = sorted({str(x) for x in [*segs.values(), *(st['clip'] for st in stages), *(st['real_output'] for st in stages if st['real_output'])]})
    return {'dir': str(b), 'segs': {k: str(v) for k, v in segs.items()}, 'stages': stages,
            'sha256': {f: file_hash(f) for f in files}}


def run_chain(drawer, build, slides, segs, workdir):
    """assemble's content stitch + card crossfades on the given segments (video only, assemble's own encoders).
    Returns the final video path and per-stage frame counts."""
    ns, wd = drawer.ns, Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    video = wd / 'video.mp4'
    if len(segs) == 1:
        shutil.copyfile(segs[0], video)
    else:
        fx_draw.sh(*fx_draw.xfade_command(segs, [s['sdur'] for s in slides], video, ns['XF'], ns['FPS'], ns['INTERMEDIATE_ENCODE']))
    total = sum(s['sdur'] for s in slides) - ns['XF'] * (len(slides) - 1)
    content = wd / 'content.mp4'
    fx_draw.sh('ffmpeg', '-y', '-v', 'error', '-i', video, '-map', '0:v', '-c:v', 'copy', '-t', f'{total:.3f}', content)
    cur, counts = content, {'content': rebaseline.count_frames(content)}
    for st in build['stages']:
        nxt = wd / f"{st['stage']}.mp4"
        c1, c2 = (st['clip'], cur) if st['content_second'] else (cur, st['clip'])
        enc = ns['INTERMEDIATE_ENCODE'] if st['intermediate'] else CROSSFADE_FINAL_ENCODE
        fx_draw.sh(*crossfade_command(c1, c2, nxt, st['xf'], st['offset'], enc))
        cur = nxt
        counts[st['stage']] = rebaseline.count_frames(cur)
    return cur, counts


# ---------- planning ----------

def _frozen_checks(d, caps_c, caps_b, slides, k, recording_dir, new_png, cfn, work):
    """The frozen-plan path (no re-plan): changed slide + neighbours must reproduce the persisted geometry and grouping."""
    fitted, checks = {}, {}
    js = [j for j in (k - 1, k, k + 1) if 0 <= j < len(slides)]
    for j in js:
        st, frozen = caps_c[j], slides[j]
        src = Path(new_png) if (j == k and new_png is not None) else Path(recording_dir) / st['media']['pre']
        if not src.is_file() or src.is_symlink():
            raise DonorRejected('missing_capture', st['media']['pre'])
        size = _png_size(src)
        if j == k:
            old_size = _png_size(Path(recording_dir) / caps_b[k]['media']['pre'])
            if size != old_size:
                raise DonorRejected('scope_expansion_required:screenshot_size_changed', {'old': old_size, 'new': size})
        rs = fx_draw.from_recording_slide(st, frozen['slide'], size, cfn)
        dst = work / 'out' / 'slides' / frozen['file']
        shutil.copyfile(src, dst)
        d.ns['fit_slide_to_frame'](rs)  # pads to 16:9 + shifts the target, exactly like assemble
        geo = {'target': rs['target'], 'viewport': rs['viewport']}
        want = {'target': frozen.get('target'), 'viewport': frozen.get('viewport')}
        if _canon(geo) != _canon(want):
            code = 'scope_expansion_required:target_geometry_changed' if j == k else 'frozen_plan_mismatch'
            if j == k and geo['target'] == want['target']:
                code = 'scope_expansion_required:viewport_changed'
            raise DonorRejected(code, {'derived': geo, 'frozen': want})
        fitted[j] = dst
        checks[fx_scope.slide_id(frozen)] = {'source': str(src), 'sha256': file_hash(src), 'size': list(size), 'geometry_equal_frozen': True}
    mad = d.ns['FX_SCREEN_MAD']
    for a, b in zip(js, js[1:]):
        new = fx_draw.starts_new_screen(slides[a], fitted[a], slides[b], fitted[b], mad)
        if new is not bool(slides[b]['_fx']['first']):
            raise DonorRejected('scope_expansion_required:screen_grouping_changed', {'between': [a + 1, b + 1], 'now_new_screen': new})
    return fitted, checks


def _replan(assembly, caps_b, caps_c, base, cand, k, recording_dir, new_png, work, font_layout, needs_drawn_highlight, report_fields):
    """Re-run assemble's planner (fx_draw.load_planner: fit_slide_to_frame, cam_views, fx_plan, cam_caption_top and the
    caption-run pass, verbatim) for the whole video, twice: the UNCHANGED script must reproduce every persisted plan
    field exactly (golden, else replan_golden_mismatch), then the candidate. Dirty slides = changed slide + every slide
    whose render-relevant plan differs. Grouping changes are detected from the re-planned _fx.first and simply expand
    the dirty set (rendered with the new plan)."""
    slides = assembly['slides']
    cfn = bool(base.get('captionsFromNarration'))
    sizes_b, sizes_c = {}, {}
    gdir, cdir = work / 'replan-golden' / 'out', work / 'out'
    (gdir / 'slides').mkdir(parents=True)
    for j, (sb, sc, a) in enumerate(zip(caps_b, caps_c, slides)):
        src_b = Path(recording_dir) / sb['media']['pre']
        src_c = Path(new_png) if (j == k and new_png is not None) else Path(recording_dir) / sc['media']['pre']
        for src in (src_b, src_c):
            if not src.is_file() or src.is_symlink():
                raise DonorRejected('missing_capture', src.name)
        sizes_b[a['slide']], sizes_c[a['slide']] = _png_size(src_b), _png_size(src_c)
        shutil.copyfile(src_b, gdir / 'slides' / a['file'])
        shutil.copyfile(src_c, cdir / 'slides' / a['file'])
    kw = dict(needs_drawn_highlight=needs_drawn_highlight, report=report_fields or {}, font_layout=font_layout)
    gp = fx_draw.load_planner(out_dir=gdir, tmp_dir=gdir / '_build', **kw)
    try:
        golden, _ = gp.replan(fx_draw.report_slides(assembly, base, sizes_b))
    except ValueError as e:
        raise DonorRejected('replan_failed_closed', str(e)) from None
    diff = fx_draw.plan_diff(golden, slides)
    if diff:
        raise DonorRejected('replan_golden_mismatch', diff[:6])
    cp = fx_draw.load_planner(out_dir=cdir, tmp_dir=work / 'replan-candidate-build', **kw)
    try:
        planned, screens = cp.replan(fx_draw.report_slides(assembly, cand, sizes_c))
    except ValueError as e:
        raise DonorRejected('replan_failed_closed', str(e)) from None
    for f in ('narration', 'caption', 'route', 'action'):
        if planned[k][f] != slides[k].get(f):
            raise DonorRejected('unsupported_narration_or_caption_change', f)
    reasons, plan_only = {}, {}
    for j, (p, a) in enumerate(zip(planned, slides)):
        rv, av = fx_draw.render_view(p), fx_draw.render_view(a)
        why = sorted(f for f in set(rv) | set(av) if rv.get(f) != av.get(f))
        if j == k:
            why = ['changed_step', *why]
        if why:
            reasons[fx_scope.slide_id(a)] = why
        pv, apv = fx_draw.plan_view(p), fx_draw.plan_view(a)
        extra = sorted(f for f in set(pv) | set(apv) if pv.get(f) != apv.get(f) and f not in why)
        if extra and fx_scope.slide_id(a) not in reasons:
            plan_only[fx_scope.slide_id(a)] = extra
    old_first = [bool(a['_fx']['first']) for a in slides]
    new_first = [bool(p['_fx']['first']) for p in planned]
    return {'planner_fingerprint': cp.fingerprint(), 'golden_equal': True, 'golden_slides': len(golden),
            'report_fields': cp.report, 'args': list(cp.args), 'reasons': reasons, 'plan_only_differences': plan_only,
            'dirty_slides': [fx_scope.slide_id(a) for a in slides if fx_scope.slide_id(a) in reasons],
            'screen_grouping_changed': old_first != new_first, 'screens_before': old_first, 'screens_after': new_first,
            'fx_plan_screens': json.loads(json.dumps(screens)), 'changed_slide_png_size': list(sizes_c[slides[k]['slide']]),
            'changed_slide_viewport': planned[k]['viewport'], 'changed_slide_target': planned[k].get('target'),
            'planned': planned}


def plan_donor(assembly, base, cand, step_id, recording_dir, total_frames, work, new_png=None, font_layout='basic',
               needs_drawn_highlight=True, allow_replan=True, report_fields=None, build=None):
    """All checks that must pass before anything is rendered. Returns the frozen render plan.

    Screenshot-only interior change whose geometry/grouping reproduce the persisted plan -> frozen-plan path (dirty =
    that slide). Otherwise, with allow_replan, assemble's planner re-plans (golden-gated) and the dirty set is the exact
    re-plan diff. A dirty first/last slide needs `build` (load_build: the card clips) because its dissolve is a card
    crossfade; without it -> unsupported_edge_slide."""
    if assembly.get('fx') is not True:
        raise DonorRejected('unsupported_non_fx_render')
    ids = [st.get('id') for st in base['steps']]
    if step_id not in ids or [st.get('id') for st in cand['steps']] != ids:
        raise DonorRejected('unknown_step')
    for b, c in zip(base['steps'], cand['steps']):
        if b['id'] == step_id:
            changed = {k for k in set(b) | set(c) if _canon(b.get(k)) != _canon(c.get(k))}
            if not changed <= STEP_FIELDS_ALLOWED:
                raise DonorRejected('unsupported_step_change', sorted(changed - STEP_FIELDS_ALLOWED))
        elif _canon(b) != _canon(c):
            raise DonorRejected('unrelated_step_changed', b['id'])
    top = {k for k in set(base) | set(cand) if k not in ('steps', 'recording') and _canon(base.get(k)) != _canon(cand.get(k))}
    if top:
        raise DonorRejected('unsupported_script_change', sorted(top))
    caps_b, caps_c = _captured(base), _captured(cand)
    slides = assembly['slides']
    if len(caps_b) != len(slides) or len(caps_c) != len(slides):
        raise DonorRejected('assembly_script_mismatch')
    for st, s in zip(caps_b, slides):
        if s.get('step') != st['index'] or s.get('src') != st['media']['pre']:
            raise DonorRejected('assembly_script_mismatch', s['slide'])
    k = next(i for i, st in enumerate(caps_c) if st['id'] == step_id)
    for st in caps_c:
        if Path(st['media']['pre']).name != st['media']['pre']:
            raise DonorRejected('missing_capture', st['media']['pre'])
    d = fx_draw.load(out_dir=work / 'out', tmp_dir=work / 'out' / '_build', needs_drawn_highlight=needs_drawn_highlight,
                     font_layout=font_layout)
    (work / 'out' / 'slides').mkdir(parents=True, exist_ok=True)
    cfn = bool(cand.get('captionsFromNarration'))
    rs = fx_draw.from_recording_slide(caps_c[k], slides[k]['slide'], (1, 1), cfn)
    for f in ('narration', 'caption', 'route', 'action'):
        if rs[f] != slides[k].get(f):
            raise DonorRejected('unsupported_narration_or_caption_change', f)
    replan, frozen_reason = None, None
    try:
        fitted, checks = _frozen_checks(d, caps_c, caps_b, slides, k, recording_dir, new_png, cfn, work)
    except DonorRejected as e:
        if not (allow_replan and e.code.startswith('scope_expansion_required:')):
            raise
        frozen_reason = {'code': e.code, 'detail': e.detail}
        for f in (work / 'out' / 'slides').iterdir():
            f.unlink()
        replan = _replan(assembly, caps_b, caps_c, base, cand, k, recording_dir, new_png, work, font_layout, needs_drawn_highlight, report_fields)
        fitted = {j: work / 'out' / 'slides' / s['file'] for j, s in enumerate(slides)}
        checks = {fx_scope.slide_id(slides[k]): {'source': str(new_png or Path(recording_dir) / caps_c[k]['media']['pre']),
                                                 'size': replan['changed_slide_png_size'], 'geometry_equal_frozen': False}}
    if replan is None:
        dirty_ids, reasons = [fx_scope.slide_id(slides[k])], {fx_scope.slide_id(slides[k]): ['changed_step']}
        entries = {j: fx_draw.frozen_slide(s) for j, s in enumerate(slides)}
    else:
        dirty_ids, reasons = replan['dirty_slides'], replan['reasons']
        entries = {j: fx_draw.frozen_slide(replan['planned'][j] if fx_scope.slide_id(s) in reasons else s) for j, s in enumerate(slides)}
    try:
        scope = fx_scope.explicit_scope(assembly, dirty_ids, total_frames, reasons=reasons)
    except ValueError as e:
        raise DonorRejected('scope_expansion_required:' + str(e), dirty_ids) from None
    if (scope['edges']['lead'] or scope['edges']['tail']) and build is None:
        raise DonorRejected('unsupported_edge_slide', {'reason': 'card_sources_required', 'edges': scope['edges'], 'dirty': dirty_ids})
    closure_ref = fx_scope.closure(assembly, {fx_scope.slide_id(slides[k]): {
        'screenshot_changed': True, 'target_changed': _canon(caps_b[k].get('target')) != _canon(caps_c[k].get('target'))}}, total_frames)
    lo, hi = scope['range']
    sid = fx_scope.slide_id(slides[k])
    if replan is not None:
        replan = {kk: v for kk, v in replan.items() if kk != 'planned'}
        replan['frozen_path_rejected'] = frozen_reason
    return {'k': k, 'range': (lo, hi), 'slide_id': sid, 'drawer': d, 'scope': scope, 'checks': checks, 'fitted': fitted,
            'entries': entries, 'dirty_idx': list(range(lo, hi + 1)), 'replan': replan,
            'closure_reference': {x: closure_ref[x] for x in ('approval_scope', 'dirty_cells', 'dirty_frames', 'scope_expansion_required')}}


# ---------- rendering ----------

def _render_segments(d, entries, idx, caption_pos=None):
    sub = [entries[j] for j in idx]
    segs = [d.ns['tmp'] / f"seg{s['slide']:02d}.mp4" for s in sub]
    with ThreadPoolExecutor(max_workers=max(1, min(4, len(sub)))) as pool:
        list(pool.map(lambda a: fx_draw.render_segment(d, *a, caption_pos=caption_pos), zip(sub, segs)))
    return dict(zip(idx, segs))


def _cut_cells(stream, base, tl, scope, out, n_avail):
    cells = {}
    for c in tl['cells']:
        if c['id'] not in scope['dirty_cells']:
            continue
        a, b = c['startFrame'] - base, c['endFrame'] - base
        if a < 0 or b > n_avail:
            raise DonorRejected('dirty_cell_outside_subchain', c['id'])
        p = out / f"cell-{c['id']}.mp4"
        # setsar=1: metadata only. The rebaseline's cells carry SAR 1:1 (from the final's crossfade encodes), raw-piped
        # segments carry none, and x264 writes SAR into the SPS, so without it the extradata (cell signature) differs.
        rebaseline.encode_cell(stream, a, b, p, vf='setsar=1')
        rebaseline.cell_signature(p, c['endFrame'] - c['startFrame'])
        cells[c['id']] = {'file': str(p), 'sha256': file_hash(p), 'startFrame': c['startFrame'], 'endFrame': c['endFrame'],
                          'subchain_frames': [a, b]}
    return cells


def render_slide_donor(assembly, slide_plan, output, rebaseline_final=None, golden_build_dir=None, caption_pos=None, build=None,
                       original_final=None, rebaseline_dir=None):
    """Render the dirty cells of slide_plan['range'] into `output`.

    mode 'assemble_chain' (build given): re-render ONLY the dirty slides, reuse the real _build segments of every other
    slide, then run assemble's own stitch + card crossfades (same encoders) and cut the dirty cells from that final. With
    original_final, a control chain over the untouched real segments must decode-equal it first (chain golden).
    mode 'lossless_subchain' (no build; interior only): dirty slides + unchanged neighbours, xfade to FFV1."""
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    d, scope, entries = slide_plan['drawer'], slide_plan['scope'], slide_plan['entries']
    lo, hi = slide_plan['range']
    ns, slides = d.ns, assembly['slides']
    tl = scope['timeline']
    frames = [math_frame(s['start']) for s in slides]
    report = {'slide_id': slide_plan['slide_id'], 'range': [slides[lo]['slide'], slides[hi]['slide']], 'dirty_cells': scope['dirty_cells'],
              'dirty_frames': scope['dirty_frames'], 'replan': slide_plan.get('replan'), 'scope_reasons': scope.get('reasons'),
              'closure_reference': slide_plan.get('closure_reference'), 'drawer_fingerprint': d.fingerprint(), 'font_layout': d.font_layout,
              'assemble_source_hashes': d.source_hashes, 'assemble_sha256': file_hash(fx_draw.ASSEMBLE),
              'geometry_checks': slide_plan['checks']}
    neighbours, consistency = {}, {}
    if build is not None:
        report['mode'] = 'assemble_chain'
        rendered = _render_segments(d, entries, list(range(lo, hi + 1)), caption_pos)
        chain_slides = [entries[j] for j in range(len(slides))]
        real_segs = [Path(build['segs'][s['slide']]) for s in slides]
        if original_final is not None:
            ctrl, counts = run_chain(d, build, chain_slides, real_segs, out / 'chain-control')
            a, b = fx_draw.framehashes(ctrl), fx_draw.framehashes(original_final)
            report['chain_golden'] = {'original_final': str(original_final), 'frames': len(a), 'stage_frames': counts,
                                      'decoded_frames_equal': a == b, 'equal_frames': sum(x == y for x, y in zip(a, b))}
            if a != b:
                raise DonorRejected('chain_golden_mismatch', report['chain_golden'])
            (out / 'control-cells').mkdir()
            ctrl_cells = _cut_cells(ctrl, 0, tl, scope, out / 'control-cells', len(a))
            report['control_cells'] = ctrl_cells
            if rebaseline_dir is not None:
                m = json.loads((Path(rebaseline_dir) / 'baseline-manifest.json').read_bytes())
                byid = {c['id']: c for c in m['cells']}
                report['control_cells_byte_identical_to_rebaseline'] = {cid: c['sha256'] == byid[cid]['sha256'] for cid, c in ctrl_cells.items()}
        segs = [rendered.get(j, real_segs[j]) for j in range(len(slides))]
        final, counts = run_chain(d, build, chain_slides, segs, out / 'chain')
        n = rebaseline.count_frames(final)
        if n != tl['total_frames']:
            raise DonorRejected('chain_frame_count_mismatch', {'chain': n, 'baseline': tl['total_frames']})
        report.update(chain={'final': str(final), 'stage_frames': counts, 'stages': build['stages'], 'build_sha256': build['sha256'],
                             'reused_real_segments': {fx_scope.slide_id(s): str(real_segs[j]) for j, s in enumerate(slides) if j not in rendered}},
                      segments={entries[j]['file']: file_hash(p) for j, p in rendered.items()},
                      encode={'segments': ns['SEG_ENCODE'], 'chain': {'stitch': ns['INTERMEDIATE_ENCODE'], 'final_crossfade': CROSSFADE_FINAL_ENCODE},
                              'cells': rebaseline.ENCODE})
        cells = _cut_cells(final, 0, tl, scope, out, n)
    else:
        report['mode'] = 'lossless_subchain'
        if lo == 0 or hi == len(slides) - 1:
            raise DonorRejected('unsupported_edge_slide', {'reason': 'card_sources_required'})
        idx = list(range(lo - 1, hi + 2))
        segs = _render_segments(d, entries, idx, caption_pos)
        if golden_build_dir:
            for j in (lo - 1, hi + 1):
                g = Path(golden_build_dir) / segs[j].name
                eq = fx_draw.framehashes(segs[j]) == fx_draw.framehashes(g)
                neighbours[fx_scope.slide_id(slides[j])] = {'golden': str(g), 'decoded_frames_equal': eq}
                if not eq:
                    raise DonorRejected('neighbour_render_mismatch', fx_scope.slide_id(slides[j]))
        base = tl['content_start_frame'] + frames[lo - 1]
        sd = [entries[j]['sdur'] for j in idx]
        off = 0.0
        for i in range(1, len(idx)):
            off += sd[i - 1] - ns['XF']
            if math_frame(off) != frames[idx[i]] - frames[idx[0]]:
                raise DonorRejected('subchain_offset_mismatch')
        content = out / 'content-subchain.mkv'
        fx_draw.sh(*fx_draw.xfade_command([segs[j] for j in idx], sd, content, ns['XF'], ns['FPS'], ['-c:v', 'ffv1', '-level', '3']))
        n_sub = len(fx_draw.framehashes(content))
        cells = _cut_cells(content, base, tl, scope, out, n_sub)
        report.update(segments={entries[j]['file']: file_hash(p) for j, p in segs.items()}, subchain_frames=n_sub,
                      encode={'segments': ns['SEG_ENCODE'], 'subchain': 'ffv1 lossless (assemble uses INTERMEDIATE_ENCODE here)',
                              'cells': rebaseline.ENCODE})
    if rebaseline_final is not None:
        # first/last frame of the dirty range: show ONLY an unchanged neighbour or card -> donor vs rebaseline
        first = min(cells.values(), key=lambda x: x['startFrame'])
        last = max(cells.values(), key=lambda x: x['endFrame'])
        for tag, cell, i in (('first_guard', first, 0), ('last_guard', last, last['endFrame'] - last['startFrame'] - 1)):
            q = fx_draw.window_quality(cell['file'], i, rebaseline_final, cell['startFrame'] + i, 1, out, tag)
            cap = _caption_band_psnr(cell['file'], i, rebaseline_final, cell['startFrame'] + i, out, tag)
            consistency[tag] = {'frame': cell['startFrame'] + i, 'psnr': q['psnr_min'], 'ssim': q['ssim_min'], 'caption_band_psnr': cap}
    k = slide_plan['k']
    ann = ns['out'] / 'annotated' / slides[k]['file']
    report.update(cells=cells, neighbour_golden=neighbours, neighbour_consistency=consistency, kb_still=str(ann) if ann.is_file() else None,
                  dirty_entries={fx_scope.slide_id(slides[j]): entries[j] for j in range(lo, hi + 1)})
    (out / 'donor.json').write_text(json.dumps(report, indent=2, default=str) + '\n')
    return report


def math_frame(seconds):
    import math
    return math.ceil(round(seconds, 3) * 30 - 1e-6)


def _caption_band_psnr(a, ai, b, bi, workdir, tag):
    """PSNR of the bottom 180 px (caption band) of one frame each; sensitive to caption glyph layout."""
    import re
    wd = Path(workdir)
    log = f'{tag}-capband.log'
    fx_draw.sh('ffmpeg', '-nostdin', '-v', 'error', '-i', Path(a).resolve(), '-i', Path(b).resolve(), '-lavfi',
               f'[0:v]trim=start_frame={ai}:end_frame={ai + 1},setpts=PTS-STARTPTS,crop=1920:180:0:900[x];'
               f'[1:v]trim=start_frame={bi}:end_frame={bi + 1},setpts=PTS-STARTPTS,crop=1920:180:0:900[y];[x][y]psnr=stats_file={log}',
               '-f', 'null', '-', cwd=wd)
    v = re.search(r'psnr_avg:(\S+)', (wd / log).read_text()).group(1)
    return float(v) if v != 'inf' else 'inf'


def run(rebaseline_dir, candidate_dir, step_id, output, golden_build_dir=None, font_layout='basic', new_png=None, build_dir=None,
        allow_replan=True, report_fields=None, verify_chain=True):
    """build_dir: the real out/<name>/_build of the rebaseline's ORIGINAL final (read-only). Enables first/last slides and
    renders through assemble's own chain (bound to the baseline: build_dir/../<name>.mp4 must hash to the manifest's
    original). verify_chain: first prove that the chain over the untouched real segments decode-equals that original."""
    rdir, manifest, m, assembly, final = load_rebaseline(rebaseline_dir)
    cdir, meta, base, cand, rec = load_candidate(candidate_dir)
    if meta['changedStepIds'] != [step_id]:
        raise DonorRejected('candidate_changes_other_steps')
    build, original = None, None
    if build_dir is not None:
        original = Path(build_dir).resolve().parent / f"{m['original']['name']}.mp4"
        if not original.is_file() or file_hash(original) != m['original']['sha256']:
            raise DonorRejected('build_dir_not_baseline_source', str(original))
        build = load_build(build_dir, assembly)
    out = new_dir(output)
    plan = plan_donor(assembly, base, cand, step_id, rec, m['frameCount'], out / 'work', new_png=new_png, font_layout=font_layout,
                      allow_replan=allow_replan, report_fields=report_fields, build=build)
    donor = render_slide_donor(assembly, plan, out / 'donor', rebaseline_final=final, golden_build_dir=golden_build_dir, build=build,
                               original_final=original if verify_chain else None, rebaseline_dir=rdir)
    approval = {'baselineManifestHash': file_hash(manifest), 'renderProfileHash': m['profileHash'],
                'changedStepIds': plan['scope']['approval_scope']['stepIds']}
    (out / 'local-approval.json').write_text(json.dumps(approval, indent=2) + '\n')
    repl = {cid: Path(c['file']) for cid, c in donor['cells'].items()}
    rep = rebaseline.assemble_candidate(manifest, approval, repl, out / 'assembled')
    cand_mp4 = Path(rep['artifact'])
    _, dirty = load_scope(manifest, approval)
    bf, cf = fx_draw.framehashes(final), fx_draw.framehashes(cand_mp4)
    changed = [i for i, (x, y) in enumerate(zip(bf, cf)) if x != y]
    merged = fx_scope._ranges(sorted(dirty))
    reused = {c['id']: {'sha256': c['sha256'], 'byte_identical': file_hash(out / 'assembled' / c['file']) == c['sha256']}
              for c in m['cells'] if c['id'] in rep['reused_cells']}
    checks = {
        'preservation': rep,
        'step_mapping': {step_id: plan['slide_id']},
        'approved_slides': approval['changedStepIds'],
        'dirty_frames': merged, 'fx_scope_dirty_frames': plan['scope']['dirty_frames'],
        'frames_total': len(cf), 'frames_changed': len(changed),
        'changed_frames_inside_dirty': all(any(a <= i < b for a, b in merged) for i in changed),
        'changed_range': [changed[0], changed[-1] + 1] if changed else None,
        'reused_cells': reused, 'all_reused_byte_identical': all(v['byte_identical'] for v in reused.values()),
        'replaced_cells': sorted(repl),
    }
    ok = (rep['protected_frames_equal'] and rep['complete_audio_equal'] and rep['audio_packets_and_timing_equal']
          and merged == plan['scope']['dirty_frames'] and checks['changed_frames_inside_dirty'] and checks['all_reused_byte_identical']
          and len(reused) + len(repl) == len(m['cells']) and (build is None or not verify_chain or donor['chain_golden']['decoded_frames_equal']))
    disclosure = ('donor cells are ONE fresh generation (assemble segment encode -> lossless xfade -> delivery cell) while '
                  'protected frames are the lossy rebaseline of the published final; local review artifact only')
    if build is not None:
        disclosure = ('donor cells come from assemble\'s own chain (dirty segments re-rendered, other segments = the real _build '
                      'segments, same stitch/crossfade encoders) re-encoded per cell exactly like the rebaseline; local review artifact only')
    report = {'ok': bool(ok), 'output': str(out), 'candidate': str(cand_mp4), 'candidate_sha256': rep['candidate_sha256'],
              'baseline_sha256': m['final']['sha256'], 'donor': donor, 'checks': checks, 'disclosure': disclosure}
    (out / 'verification.json').write_text(json.dumps(report, indent=2, default=str) + '\n')
    return report


# ---------- real pilot end-to-end (local, read-only on the repo) ----------

NODE_DIGEST = ("import {digest} from %s; import {readFileSync} from 'node:fs';"
               "const s=JSON.parse(readFileSync(process.argv[1],'utf8'));"
               "console.log(JSON.stringify({base:digest(s),steps:s.steps.map(x=>digest(x))}));")


def node_digests(script_path):
    mod = json.dumps((REPO / 'tools' / 'drift' / 'contracts.mjs').as_uri())
    return json.loads(fx_draw.sh('node', '--input-type=module', '-e', NODE_DIGEST % mod, script_path))


def make_candidate(base_script, recordings_root, step_id, image, output, target=None):
    """tools/drift/candidate.mjs CLI with a single-step replacement manifest (scratch only)."""
    dg = node_digests(base_script)
    base = json.loads(Path(base_script).read_text())
    i = [st['id'] for st in base['steps']].index(step_id)
    change = {'stepId': step_id, 'beforeHash': dg['steps'][i], 'imagePath': str(image), 'sha256': file_hash(image)}
    if target is not None:
        change['target'] = target
    mpath = Path(output).with_name(Path(output).name + '.manifest.json')
    mpath.write_text(json.dumps({'baseHash': dg['base'], 'structuralChanges': [], 'changes': [change]}, indent=2))
    fx_draw.sh('node', REPO / 'tools' / 'drift' / 'candidate.mjs', '--base', base_script, '--recordings-root', recordings_root,
               '--manifest', mpath, '--output', output)
    return Path(output)


def drift_banner(src, dst, box, text):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.open(src).convert('RGB')
    d = ImageDraw.Draw(im)
    d.rounded_rectangle(box, radius=10, fill=(196, 30, 58))
    f = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 30, layout_engine=ImageFont.Layout.BASIC)
    d.text((box[0] + 18, box[1] + (box[3] - box[1] - 30) // 2), text, font=f, fill='white')
    im.save(dst)
    return dst


def project_box(drawer, slide, local_frame, box):
    """Slide-pixel box -> output-pixel box at a frame of the slide's own segment (frozen camera)."""
    ns = drawer.ns
    sw, sh_ = slide['_cam'][2]
    cx, cy, z = ns['cam_view_at'](slide, local_frame / ns['FPS'])
    vw, vh = sw / z, sh_ / z
    x0, y0 = cx - vw / 2, cy - vh / 2
    W, H = ns['W'], ns['H']
    return [int((box[0] - x0) / vw * W), int((box[1] - y0) / vh * H), int((box[2] - x0) / vw * W) + 1, int((box[3] - y0) / vh * H) + 1]


def grab(path, index):
    from PIL import Image
    raw = fx_draw.sh('ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-map', '0:v:0', '-vf', f'select=eq(n\\,{index})', '-fps_mode',
                     'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-')
    return Image.frombytes('RGB', (1920, 1080), raw)


def region_diff(a, b, box, margin=24):
    import numpy as np
    x = np.abs(np.asarray(a.convert('L'), dtype=np.int16) - np.asarray(b.convert('L'), dtype=np.int16)).astype(float)
    m = np.zeros_like(x, dtype=bool)
    x0, y0, x1, y1 = max(0, box[0] - margin), max(0, box[1] - margin), min(1920, box[2] + margin), min(1080, box[3] + margin)
    m[y0:y1, x0:x1] = True
    return {'inside_mean': round(float(x[m].mean()), 3), 'outside_mean': round(float(x[~m].mean()), 3),
            'outside_max': int(x[~m].max()), 'outside_pixels_over_24': int((x[~m] > 24).sum()), 'box': [x0, y0, x1, y1]}


def real_pilot_end_to_end(rebaseline_dir, output, name='How-to-Find-a-Project-ID'):
    out = new_dir(output)
    script_path = REPO / 'scripts' / f'{name}.script.json'
    pilot = REPO / 'out' / name
    script = json.loads(script_path.read_bytes())
    rec_src = REPO / 'out' / '_recordings' / script['recording']['id']
    real = [script_path, fx_draw.ASSEMBLE, *sorted(p for p in rec_src.iterdir() if p.is_file()),
            *sorted(p for d in (pilot, pilot / 'slides', pilot / 'annotated', pilot / '_build') for p in d.iterdir() if p.is_file())]
    before = fx_draw.snapshot(real)
    # 1. stable-ID LOCAL copy (deterministic ids, created once here) + scratch copy of the captures
    import uuid
    stable = json.loads(json.dumps(script))
    stable.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}')))
    for st in stable['steps']:
        st.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}:step:{st["index"]}')))
    src_dir = out / 'source'
    (src_dir / '_recordings' / script['recording']['id']).mkdir(parents=True)
    for p in rec_src.iterdir():
        if p.is_file():
            shutil.copyfile(p, src_dir / '_recordings' / script['recording']['id'] / p.name)
    base_path = src_dir / 'stable-base.script.json'
    base_path.write_text(json.dumps(stable, indent=2) + '\n')
    step = stable['steps'][1]
    step_id = step['id']
    orig = src_dir / '_recordings' / script['recording']['id'] / step['media']['pre']
    # 2. genuinely new screenshot: a visible banner away from the highlight target (289,227 415x147)
    banner_box = (760, 440, 1180, 520)
    new_png = drift_banner(orig, src_dir / 'slide-02-new.png', banner_box, 'NEW: Export project IDs')
    cand = make_candidate(base_path, src_dir / '_recordings', step_id, new_png, out / 'candidate')
    # 3. donor -> incremental assembly -> preservation
    rep = run(rebaseline_dir, cand, step_id, out / 'drift', golden_build_dir=pilot / '_build')
    # 4. control donor: the ORIGINAL screenshot through the same donor path (donor fidelity vs rebaseline)
    rdir, manifest, m, assembly, final = load_rebaseline(rebaseline_dir)
    cdir, meta, b, c, rec = load_candidate(cand)
    ctrl_dir = out / 'control'
    ctrl_dir.mkdir()
    cplan = plan_donor(assembly, b, c, step_id, rec, m['frameCount'], ctrl_dir / 'work', new_png=orig)
    ctrl = render_slide_donor(assembly, cplan, ctrl_dir / 'donor', rebaseline_final=final)
    ctrl_q = {}
    for cid, cell in ctrl['cells'].items():
        q = fx_draw.window_quality(cell['file'], 0, final, cell['startFrame'], cell['endFrame'] - cell['startFrame'], ctrl_dir, cid)
        ctrl_q[cid] = {k: v for k, v in q.items() if k != 'psnr_per_frame'}
    # 5. changed label visible where (and only where) the banner is, at hold-02 frames
    tl = cplan['scope']['timeline']
    c0, f2 = tl['content_start_frame'], math_frame(assembly['slides'][1]['start'])
    s2 = fx_draw.frozen_slide(assembly['slides'][1])
    cand_mp4 = Path(rep['candidate'])
    hold = next(x for x in tl['cells'] if x['id'] == 'hold-02')
    label = []
    for F in (hold['startFrame'] + 5, (hold['startFrame'] + hold['endFrame']) // 2, hold['endFrame'] - 5):
        box = project_box(cplan['drawer'], s2, F - c0 - f2, banner_box)
        cf, bf = grab(cand_mp4, F), grab(final, F)
        ctrl_cell = ctrl['cells']['hold-02']
        ctrl_f = grab(ctrl_cell['file'], F - ctrl_cell['startFrame'])
        label.append({'frame': F, 'banner_box_out_px': box, 'candidate_vs_baseline': region_diff(cf, bf, box),
                      'candidate_vs_control_donor': region_diff(cf, ctrl_f, box)})
    label_ok = all(x['candidate_vs_control_donor']['inside_mean'] > 10 * max(0.05, x['candidate_vs_control_donor']['outside_mean'])
                   and x['candidate_vs_baseline']['inside_mean'] > 20 for x in label)
    # 6. contact sheet original|candidate|diff
    picks = [(250, 'hold-01 (protected)'), (326, 'dissolve-01-02'), (345, 'hold-02 push-in'), (400, 'hold-02'), (448, 'dissolve-02-03'),
             (520, 'hold-03 (protected)')]
    rebaseline.contact_sheet([('rebuilt baseline', final), ('candidate (new slide 2)', cand_mp4)], picks, out / 'contact-sheet.jpg')
    # 7. negatives (frozen-plan-only mode, allow_replan=False): must be rejected BEFORE rendering. With re-planning
    #    enabled these are handled by real_pilot_replan_and_edges instead.
    from PIL import Image
    negatives = {}
    moved = json.loads(json.dumps(step['target']))
    moved['hint']['bbox']['x'] += 200
    small = src_dir / 'slide-02-1440.png'
    Image.open(orig).convert('RGB').resize((1440, 900)).save(small)
    inverted = src_dir / 'slide-02-inverted.png'
    from PIL import ImageOps
    ImageOps.invert(Image.open(orig).convert('RGB')).save(inverted)
    for tag, img, tgt in (('moved_highlight', new_png, moved), ('different_size', small, None), ('screen_regroup', inverted, None)):
        cdir_n = make_candidate(base_path, src_dir / '_recordings', step_id, img, out / f'neg-{tag}-candidate', target=tgt)
        try:
            run(rebaseline_dir, cdir_n, step_id, out / f'neg-{tag}', allow_replan=False)  # frozen-plan-only mode
            negatives[tag] = {'rejected': None}
        except DonorRejected as e:
            rendered = sorted(str(p) for p in (out / f'neg-{tag}').rglob('*.mp4'))
            negatives[tag] = {'rejected': e.code, 'detail': e.detail, 'rendered_files': rendered}
    neg_ok = (negatives['moved_highlight']['rejected'] == 'scope_expansion_required:target_geometry_changed'
              and negatives['different_size']['rejected'] == 'scope_expansion_required:screenshot_size_changed'
              and negatives['screen_regroup']['rejected'] == 'scope_expansion_required:screen_grouping_changed'
              and all(not v.get('rendered_files') for v in negatives.values()))
    after = fx_draw.snapshot(real)
    pres = rep['checks']['preservation']
    summary = {
        'ok': bool(rep['ok'] and label_ok and neg_ok and before == after
                   and all(v['decoded_frames_equal'] for v in rep['donor']['neighbour_golden'].values())),
        'step_id': step_id, 'slide': rep['checks']['step_mapping'][step_id], 'candidate_dir': str(cand), 'candidate_mp4': str(cand_mp4),
        'protected_frame_count': pres['protected_frame_count'], 'protected_frames_equal': pres['protected_frames_equal'],
        'complete_audio_equal': pres['complete_audio_equal'], 'audio_packets_and_timing_equal': pres['audio_packets_and_timing_equal'],
        'dirty_frames': rep['checks']['dirty_frames'], 'frames_changed': rep['checks']['frames_changed'],
        'changed_range': rep['checks']['changed_range'], 'changed_frames_inside_dirty': rep['checks']['changed_frames_inside_dirty'],
        'reused_cells': rep['checks']['reused_cells'], 'replaced_cells': rep['checks']['replaced_cells'],
        'neighbour_golden': rep['donor']['neighbour_golden'], 'neighbour_consistency': rep['donor']['neighbour_consistency'],
        'control_donor_vs_rebaseline': ctrl_q, 'control_neighbour_consistency': ctrl['neighbour_consistency'],
        'label': label, 'label_visible_only_in_banner': label_ok, 'negatives': negatives, 'negatives_ok': neg_ok,
        'contact_sheet': str(out / 'contact-sheet.jpg'), 'source_unchanged': before == after,
        'source_snapshot': {'before': before, 'after': after}}
    (out / 'end-to-end.json').write_text(json.dumps(summary, indent=2, default=str) + '\n')
    return summary


# ---------- real pilot: moved highlight (screen re-plan) + first/last slides (card crossfades) ----------

def card_chain_golden(pilot, output):
    """Re-run assemble's card crossfades (crossfade_pair's exact ffmpeg calls, WITH audio) on the pilot's real _build
    inputs into scratch and compare every intermediate and the final with the real files (sha256)."""
    b, out = Path(pilot) / '_build', Path(output)
    out.mkdir()
    a = json.loads((Path(pilot) / 'assembly.json').read_bytes())
    d = fx_draw.load(out_dir=out / 'o', tmp_dir=out / 'o' / '_build', needs_drawn_highlight=True)
    inter, fin = d.ns['INTERMEDIATE_ENCODE'], CROSSFADE_FINAL_ENCODE
    steps = [('intro_title_crossfaded.mp4', b / 'logo_card.mp4', b / 'title_card.mp4', CARD_XF, inter),
             ('body_crossfaded.mp4', out / 'intro_title_crossfaded.mp4', b / 'content.mp4', CARD_XF, inter),
             ('body_with_support.mp4', out / 'body_crossfaded.mp4', b / 'support_card.mp4', CARD_XF, inter),
             ('final.mp4', out / 'body_with_support.mp4', b / 'logo_card.mp4', OUTRO_XF, fin)]
    res = {}
    for name, c1, c2, xf, enc in steps:
        off = max(0.05, media_duration(c1) - xf)
        fx_draw.sh(*crossfade_command(c1, c2, out / name, xf, off, enc, audio=True))
        real = Path(pilot) / f'{Path(pilot).name}.mp4' if name == 'final.mp4' else b / name
        res[name] = {'offset': round(off, 3), 'xf': xf, 'sha256': file_hash(out / name), 'real_sha256': file_hash(real),
                     'sha256_equal': file_hash(out / name) == file_hash(real)}
    return {'steps': res, 'final_sha256_equal': res['final.mp4']['sha256_equal'], 'all_equal': all(v['sha256_equal'] for v in res.values()),
            'content_offset': a['content_offset'], 'lead_offset': res['body_crossfaded.mp4']['offset']}


def purple_mask(img):
    import numpy as np
    x = np.asarray(img.convert('RGB')).astype(int)
    r, g, b_ = x[..., 0], x[..., 1], x[..., 2]
    return (b_ > 130) & (b_ - r > 60) & (b_ - g > 70)  # house callout purple (76,61,171)/(91,70,214) incl. glow


def highlight_location(img, box, margin=40):
    import numpy as np
    m = purple_mask(img)
    ys, xs = np.nonzero(m)
    if not len(xs):
        return {'pixels': 0}
    x0, y0, x1, y1 = box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin
    inside = int(((xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)).sum())
    return {'pixels': int(len(xs)), 'inside_expected_box': inside, 'fraction_inside': round(inside / len(xs), 4),
            'centroid': [round(float(xs.mean()), 1), round(float(ys.mean()), 1)]}


def highlighted_element(img, box_out, png, candidates, inset=0.12):
    """Which page element sits inside the callout: grey MAD between the frame's (inset) callout box and each candidate
    slide-pixel bbox cropped from the capture, resized to the same size. The camera re-centres on a moved target, so the
    callout's OUTPUT position barely moves; the element under it is what changes."""
    import numpy as np
    from PIL import Image
    x0, y0, x1, y1 = box_out
    dx, dy = (x1 - x0) * inset, (y1 - y0) * inset
    crop = img.convert('L').crop((int(x0 + dx), int(y0 + dy), int(x1 - dx), int(y1 - dy)))
    src = Image.open(png).convert('L')
    res = {}
    for name, (bx, by, bw, bh) in candidates.items():
        ref = src.crop((int(bx + bw * inset), int(by + bh * inset), int(bx + bw * (1 - inset)), int(by + bh * (1 - inset)))).resize(crop.size, Image.BICUBIC)
        res[name] = round(float(np.abs(np.asarray(crop, dtype=float) - np.asarray(ref, dtype=float)).mean()), 3)
    return res


def _case(tag, rb, cand, step_id, out, pilot, report_fields, picks, final):
    rep = run(rb, cand, step_id, out / tag, golden_build_dir=pilot / '_build', build_dir=pilot / '_build', report_fields=report_fields)
    sheet = out / f'contact-sheet-{tag}.jpg'
    rebaseline.contact_sheet([('rebuilt baseline', final), (f'candidate ({tag})', Path(rep['candidate']))], picks, sheet)
    donor, pres = rep['donor'], rep['checks']['preservation']
    q = {}
    for cid, c in donor['cells'].items():
        w = fx_draw.window_quality(c['file'], 0, final, c['startFrame'], c['endFrame'] - c['startFrame'], out / tag, f'q-{cid}')
        q[cid] = {k: v for k, v in w.items() if k != 'psnr_per_frame'}
    ctrl = donor.get('control_cells_byte_identical_to_rebaseline') or {}
    return rep, {
        'ok': bool(rep['ok']), 'output': rep['output'], 'candidate_mp4': rep['candidate'], 'candidate_sha256': rep['candidate_sha256'],
        'approved_slides': rep['checks']['approved_slides'], 'replaced_cells': rep['checks']['replaced_cells'],
        'reused_cells': sorted(rep['checks']['reused_cells']), 'all_reused_byte_identical': rep['checks']['all_reused_byte_identical'],
        'dirty_frames': rep['checks']['dirty_frames'], 'protected_frame_count': pres['protected_frame_count'],
        'protected_frames_equal': pres['protected_frames_equal'], 'complete_audio_equal': pres['complete_audio_equal'],
        'audio_packets_and_timing_equal': pres['audio_packets_and_timing_equal'], 'frames_changed': rep['checks']['frames_changed'],
        'changed_range': rep['checks']['changed_range'], 'changed_frames_inside_dirty': rep['checks']['changed_frames_inside_dirty'],
        'chain_golden': donor.get('chain_golden'), 'control_cells': ctrl,
        'control_cells_byte_identical_to_rebaseline': bool(ctrl) and all(ctrl.values()),
        'candidate_vs_baseline_in_dirty_cells': q, 'neighbour_consistency': donor['neighbour_consistency'],
        'replan': {k: v for k, v in (donor.get('replan') or {}).items() if k not in ('fx_plan_screens',)},
        'scope_reasons': donor.get('scope_reasons'), 'closure_reference': donor.get('closure_reference'), 'contact_sheet': str(sheet)}


def real_pilot_replan_and_edges(rebaseline_dir, output, name='How-to-Find-a-Project-ID'):
    """Real pilot, local + read-only on the repo: (1) card-chain golden (assemble's crossfades re-run on the real _build
    inputs must reproduce body/support/final sha256), (2) re-plan golden, (3) moved highlight on slide 2 (whole screen
    [slide-01, slide-02] re-planned, lead dissolve included), (4) new slide-01 screenshot (lead card crossfade),
    (5) new slide-03 screenshot (support card crossfade). Each spliced onto the rebaseline and verified."""
    import uuid
    out = new_dir(output)
    script_path = REPO / 'scripts' / f'{name}.script.json'
    pilot = REPO / 'out' / name
    script = json.loads(script_path.read_bytes())
    report = json.loads((pilot / 'report.json').read_bytes())
    rec_src = REPO / 'out' / '_recordings' / script['recording']['id']
    real = [script_path, fx_draw.ASSEMBLE, *sorted(p for p in rec_src.iterdir() if p.is_file()),
            *sorted(p for d in (pilot, pilot / 'slides', pilot / 'annotated', pilot / '_build') for p in d.iterdir() if p.is_file())]
    before = fx_draw.snapshot(real)
    rdir, manifest, m, assembly, final = load_rebaseline(rebaseline_dir)
    chain_golden = card_chain_golden(pilot, out / 'card-chain-golden')
    replan_golden = fx_draw.replan_golden(REPO, name, out / 'replan-golden', render_segments=True)
    stable = json.loads(json.dumps(script))
    stable.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}')))
    for st in stable['steps']:
        st.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}:step:{st["index"]}')))
    src_dir = out / 'source'
    recd = src_dir / '_recordings' / script['recording']['id']
    recd.mkdir(parents=True)
    for p in rec_src.iterdir():
        if p.is_file():
            shutil.copyfile(p, recd / p.name)
    base_path = src_dir / 'stable-base.script.json'
    base_path.write_text(json.dumps(stable, indent=2) + '\n')
    fields = {k: report[k] for k in fx_draw.REPORT_FIELDS if k in report}
    steps = stable['steps']
    cases, summaries = {}, {}
    # (3) moved highlight: same screenshot, the click target is the SECOND project card instead of the first
    moved_png = src_dir / 'slide-02-same-pixels.png'
    shutil.copyfile(recd / steps[1]['media']['pre'], moved_png)
    moved = json.loads(json.dumps(steps[1]['target']))
    moved['hint']['bbox'] = {'x': 289, 'y': 383, 'w': 415, 'h': 142}
    cand = make_candidate(base_path, src_dir / '_recordings', steps[1]['id'], moved_png, out / 'cand-moved_highlight', target=moved)
    picks = [(150, 'lead-card (protected)'), (173, 'lead-dissolve'), (250, 'hold-01'), (326, 'dissolve-01-02'), (345, 'hold-02 push-in'),
             (400, 'hold-02 settled'), (448, 'dissolve-02-03'), (520, 'hold-03 (protected)')]
    rep, summaries['moved_highlight'] = _case('moved_highlight', rdir, cand, steps[1]['id'], out, pilot, fields, picks, final)
    d = fx_draw.load(out_dir=out / 'probe', tmp_dir=out / 'probe' / '_build', needs_drawn_highlight=True)
    tl = fx_scope.timeline(assembly, m['frameCount'])
    c0, f2 = tl['content_start_frame'], math_frame(assembly['slides'][1]['start'])
    old_e = fx_draw.frozen_slide(assembly['slides'][1])
    new_e = rep['donor']['dirty_entries']['slide-02']
    old_t, new_t = old_e['target'], new_e['target']
    hm = []
    png = recd / steps[1]['media']['pre']
    els = {'old_target': (old_t['x'], old_t['y'], old_t['width'], old_t['height']), 'new_target': (new_t['x'], new_t['y'], new_t['width'], new_t['height'])}
    for F in (380, 400, 420):
        lf = F - c0 - f2
        ob = project_box(d, old_e, lf, [old_t['x'], old_t['y'], old_t['x'] + old_t['width'], old_t['y'] + old_t['height']])
        nb = project_box(d, new_e, lf, [new_t['x'], new_t['y'], new_t['x'] + new_t['width'], new_t['y'] + new_t['height']])
        bimg, cimg = grab(final, F), grab(Path(rep['candidate']), F)
        hm.append({'frame': F, 'old_box_out_px': ob, 'new_box_out_px': nb,
                   'camera_view_old': [round(v, 2) for v in d.ns['cam_view_at'](old_e, lf / 30)],
                   'camera_view_new': [round(v, 2) for v in d.ns['cam_view_at'](new_e, lf / 30)],
                   'baseline_callout_in_old_box': highlight_location(bimg, ob), 'candidate_callout_in_new_box': highlight_location(cimg, nb),
                   'baseline_element_mad': highlighted_element(bimg, ob, png, els), 'candidate_element_mad': highlighted_element(cimg, nb, png, els)})
    hm_ok = all(x['baseline_callout_in_old_box'].get('fraction_inside', 0) > 0.8 and x['candidate_callout_in_new_box'].get('fraction_inside', 0) > 0.8
                and x['candidate_element_mad']['new_target'] * 1.5 < x['candidate_element_mad']['old_target']
                and x['baseline_element_mad']['old_target'] * 1.5 < x['baseline_element_mad']['new_target'] for x in hm)
    summaries['moved_highlight']['highlight_moved'] = {
        'ok': hm_ok, 'target_old_px': old_t, 'target_new_px': new_t, 'frames': hm,
        'rule': ('callout pixels (>80%) inside the camera-projected target box, AND the element under the callout matches the NEW '
                 'target crop of the capture at least 1.5x better than the old one (baseline: the reverse)')}
    # (4) first slide, (5) last slide: genuinely new screenshots (visible banner away from any target)
    for tag, i, box, text, picks in (
            ('first_slide', 0, (760, 440, 1180, 520), 'NEW: Archived projects', [(100, 'lead-card (protected)'), (165, 'lead-dissolve'),
             (175, 'lead-dissolve'), (250, 'hold-01'), (326, 'dissolve-01-02'), (400, 'hold-02 (protected)')]),
            ('last_slide', 2, (1080, 640, 1500, 720), 'NEW: Copy project ID', [(400, 'hold-02 (protected)'), (448, 'dissolve-02-03'),
             (520, 'hold-03'), (595, 'tail-dissolve'), (605, 'tail-dissolve'), (700, 'tail-card (protected)')])):
        png = drift_banner(recd / steps[i]['media']['pre'], src_dir / f'{tag}-new.png', box, text)
        cand = make_candidate(base_path, src_dir / '_recordings', steps[i]['id'], png, out / f'cand-{tag}')
        rep, summaries[tag] = _case(tag, rdir, cand, steps[i]['id'], out, pilot, fields, picks, final)
        e = rep['donor']['dirty_entries'][f'slide-{i + 1:02d}']
        hold = next(c for c in tl['cells'] if c['id'] == f'hold-{i + 1:02d}')
        F = (hold['startFrame'] + hold['endFrame']) // 2
        bx = project_box(d, e, F - c0 - math_frame(assembly['slides'][i]['start']), box)
        rd = region_diff(grab(Path(rep['candidate']), F), grab(final, F), bx)
        summaries[tag]['banner'] = {'frame': F, **rd, 'ok': rd['inside_mean'] > 20 and rd['outside_mean'] < 1.0}
    after = fx_draw.snapshot(real)
    ok = (chain_golden['all_equal'] and replan_golden['ok'] and before == after and summaries['moved_highlight']['highlight_moved']['ok']
          and all(v['ok'] and v['control_cells_byte_identical_to_rebaseline'] for v in summaries.values())
          and all(summaries[t]['banner']['ok'] for t in ('first_slide', 'last_slide')))
    res = {'ok': bool(ok), 'output': str(out), 'rebaseline': str(rdir), 'card_chain_golden': chain_golden,
           'replan_golden': {k: replan_golden[k] for k in ('ok', 'plan_equal', 'plan_diff', 'segments', 'slide_pixels_equal', 'fields_compared')},
           'cases': summaries, 'source_unchanged': before == after, 'source_snapshot': {'before': before, 'after': after}}
    (out / 'end-to-end.json').write_text(json.dumps(res, indent=2, default=str) + '\n')
    return res


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--rebaseline-dir', required=True)
    p.add_argument('--candidate-dir', required=True)
    p.add_argument('--slide-step-id', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--golden-build-dir')
    p.add_argument('--font-layout', default='basic', choices=fx_draw.FONT_LAYOUTS)
    p.add_argument('--build-dir', help="the baseline's real out/<name>/_build (read-only): enables first/last slides + assemble chain")
    p.add_argument('--no-replan', action='store_true', help='reject target/size/grouping changes instead of re-planning')
    a = p.parse_args(argv)
    try:
        r = run(a.rebaseline_dir, a.candidate_dir, a.slide_step_id, a.output, golden_build_dir=a.golden_build_dir, font_layout=a.font_layout,
                build_dir=a.build_dir, allow_replan=not a.no_replan)
    except DonorRejected as e:
        print(json.dumps({'ok': False, 'rejected': e.code, 'detail': e.detail}, default=str))
        return 2
    print(json.dumps({k: r[k] for k in ('ok', 'output', 'candidate', 'candidate_sha256')}, indent=2))
    return 0 if r['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
