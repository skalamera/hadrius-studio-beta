"""LOCAL combined drift update: ONE candidate for ANY number of approved step changes on a one-time rebaseline.

    TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.drift_update \\
        --rebaseline-dir $TMPDIR/<rebaseline> --script <stable-ID script copy> --recordings-dir <dir of media.pre captures> \\
        --changes <approved change manifest> --build-dir out/<name>/_build --output $TMPDIR/NEW-directory \\
        [--take-mode elevenlabs|manifest|standin --allow-standin] [--report out/<name>/report.json] [--dry-run]
    ... -m renderer.drift_update --real-pilot a|b|golden|noop --rebaseline-dir <dir> --output $TMPDIR/NEW-directory

Approved change manifest (trusted LOCAL input, bound to the baseline manifest hash):
    {"baselineManifestHash": "<sha256 of baseline-manifest.json>",
     "changes": [{"stepId": "<stable step id>",
                  "screenshot": {"path": "/abs/new.png", "sha256": "..."},            (optional)
                  "target": {...recorded target, same semantics, new geometry...},   (optional)
                  "dpr": 2,                                                         (optional)
                  "narration": {"oldText": "...", "newText": "...", "newCaption": "(optional)",
                                "take": {"path": "/abs/take.mp3", "sha256": "...", "source": "..."}}}]}  (take optional)
An empty `changes` list returns the baseline artifact itself (no remux). A change that re-applies the baseline's own
screenshot/target/narration is rendered anyway (golden check) and reported under `golden_reapply`.

Composition (no building block is duplicated):
  validate (pure; every rejection before any output) -> candidate script (tools/drift/candidate.mjs for all visual
  changes at once, narration applied on top) -> preflight plan at baseline timing (fail closed before any TTS spend)
  -> takes (manifest-provided, or renderer.take_provider: the production tts.py CLI in the script's saved ElevenLabs
  voice) -> plan: quantized sdurs (retime.quantize_sdur), ONE re-plan of the whole video through assemble's own planner
  (fx_draw.load_planner, gated on re-planning the UNCHANGED script reproducing every persisted plan field), dirty =
  changed steps UNION every slide whose render-relevant plan differs (screen re-plan expansion: same-screen followers
  and predecessors of a re-timed slide, regroups, moved targets), any number of dirty runs; cells = fx_scope.timeline
  of the new assembly, mapped by retime.map_cells, reused cells' camera views asserted unchanged
  (retime.protected_views_equal) -> render every dirty slide ONCE (fx_draw) -> assemble's own stitch + card crossfade
  chain on real _build segments/cards (video-only with the stored offsets when timing is unchanged; WITH the re-mixed
  content audio when narration changed, offsets from the new intermediates exactly like crossfade_pair) gated by a
  control chain that must decode-equal the original final -> dirty cells cut + encoded in the rebaseline profile ->
  splice (rebaseline.assemble_candidate + preservation when audio is unchanged; byte copies at shifted positions + ONE
  audio_rebuild soundtrack otherwise) -> verify.
Never imports assemble.py/tts.py; real inputs are read-only and snapshotted; outputs only in a NEW scratch dir.
"""
import argparse
import copy
import json
import math
import os
import shutil
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NoReturn

from . import audio_rebuild as ar, drift_render, fx_draw, fx_scope, rebaseline, retime, take_provider as tp
from .preservation import file_hash

REPO = Path(__file__).resolve().parent.parent
MANIFEST_KEYS = {'baselineManifestHash', 'changes'}
CHANGE_KEYS = {'stepId', 'screenshot', 'target', 'dpr', 'narration'}
NARRATION_KEYS, NARRATION_OPTIONAL = {'oldText', 'newText'}, {'newCaption', 'take'}
FILE_KEYS, TAKE_OPTIONAL = {'path', 'sha256'}, {'source'}
WHISPER_PY = Path('/Users/stephenskalamera/.hermes/hermes-agent/venv/bin/python')
REAPPLY_PSNR_MIN = 45.0  # established donor golden: control donor >= 45.2 dB vs the rebaseline (drift_render README)
SYNC_TOLERANCE_MS = 1.5
LAG_TOLERANCE = 2


class UpdateRejected(ValueError):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def reject(code, detail=None) -> NoReturn:
    raise UpdateRejected(code, detail)


def _canon(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def _sid(s):
    return fx_scope.slide_id(s)


# ---------- validation (pure: nothing is written) ----------

def _file_entry(v, keys_optional=frozenset()):
    return isinstance(v, dict) and FILE_KEYS <= set(v) and not (set(v) - FILE_KEYS - set(keys_optional)) and all(
        isinstance(v[k], str) for k in v)


def load_change_manifest(src, manifest_path):
    cm = src if isinstance(src, dict) else json.loads(Path(src).read_bytes())
    if not isinstance(cm, dict) or set(cm) != MANIFEST_KEYS or not isinstance(cm['changes'], list):
        reject('invalid_change_manifest')
    if cm['baselineManifestHash'] != ar.sha256_file(manifest_path):
        reject('baseline_manifest_conflict')
    seen = set()
    for ch in cm['changes']:
        if not isinstance(ch, dict) or not isinstance(ch.get('stepId'), str) or set(ch) - CHANGE_KEYS:
            reject('invalid_change_manifest', ch if isinstance(ch, dict) else None)
        if ch['stepId'] in seen:
            reject('duplicate_change', ch['stepId'])
        seen.add(ch['stepId'])
        if set(ch) == {'stepId'}:
            reject('empty_change', ch['stepId'])
        if 'screenshot' in ch and not _file_entry(ch['screenshot']):
            reject('invalid_change_manifest', 'screenshot')
        if 'target' in ch and not (ch['target'] is None or isinstance(ch['target'], dict)):
            reject('invalid_change_manifest', 'target')
        if 'dpr' in ch and not (isinstance(ch['dpr'], (int, float)) and not isinstance(ch['dpr'], bool) and math.isfinite(ch['dpr']) and ch['dpr'] > 0):
            reject('invalid_geometry', 'dpr')
        if 'narration' in ch:
            n = ch['narration']
            if (not isinstance(n, dict) or not NARRATION_KEYS <= set(n) or set(n) - NARRATION_KEYS - NARRATION_OPTIONAL
                    or any(not isinstance(n[k], str) for k in NARRATION_KEYS | ({'newCaption'} & set(n)))):
                reject('invalid_change_manifest', 'narration')
            if 'take' in n and not _file_entry(n['take'], TAKE_OPTIONAL):
                reject('invalid_change_manifest', 'narration.take')
    return cm


def validate_baseline(assembly, script):
    if assembly.get('fx') is not True:
        reject('unsupported_non_fx_render')
    ids = [st.get('id') for st in script['steps']]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        reject('script_needs_stable_step_ids')
    caps = drift_render._captured(script)
    slides = assembly['slides']
    if len(caps) != len(slides):
        reject('assembly_script_mismatch')
    cfn = bool(script.get('captionsFromNarration'))
    for st, s in zip(caps, slides):
        if s.get('step') != st['index'] or s.get('src') != st['media']['pre']:
            reject('assembly_script_mismatch', s['slide'])
        if str(s.get('file', '')).endswith('.mp4'):
            reject('unsupported_clip_slide', s['slide'])
        cap = ((st.get('narration') if cfn else st.get('caption')) or st.get('narration') or '')
        if (st.get('narration') or '') != (s.get('narration') or '') or cap != (s.get('caption') or ''):
            reject('script_not_baseline', s['slide'])
    return caps


def _semantics(target):
    """candidate.mjs semantics(): the target minus geometry (bbox/viewport, also inside hint)."""
    c = copy.deepcopy(target if target is not None else {})
    if isinstance(c, dict):
        c.pop('bbox', None)
        c.pop('viewport', None)
        if isinstance(c.get('hint'), dict):
            c['hint'].pop('bbox', None)
            c['hint'].pop('viewport', None)
            if not c['hint']:
                del c['hint']
    return c


def _geometry_ok(t):
    for g in (t, (t or {}).get('hint')):
        if not isinstance(g, dict):
            continue
        b = g.get('bbox')
        if 'bbox' in g and not (isinstance(b, dict) and all(isinstance(b.get(k), (int, float)) for k in 'xywh') and b['w'] > 0 and b['h'] > 0):
            return False
        v = g.get('viewport')
        if 'viewport' in g and not (isinstance(v, dict) and all(isinstance(v.get(k), (int, float)) and v[k] > 0 for k in 'wh')):
            return False
    return True


def _png_size(path):
    try:
        return drift_render._png_size(path)
    except drift_render.DonorRejected:
        reject('unsupported_asset', str(path))
    except Exception:
        reject('unsupported_asset', str(path))


def validate_changes(changes, script, assembly, caps, rec, take_provider_given):
    slides = assembly['slides']
    all_ids = [st['id'] for st in script['steps']]
    cap_ids = [st['id'] for st in caps]
    cfn = bool(script.get('captionsFromNarration'))
    narrated = [s for s in slides if s.get('audio')]
    filters = {s.get('audio_filter') or '' for s in narrated}
    out = []
    for ch in changes:
        if ch['stepId'] not in all_ids or ch['stepId'] not in cap_ids:
            reject('unknown_step', ch['stepId'])
        k = cap_ids.index(ch['stepId'])
        st, s = caps[k], slides[k]
        cur_png = Path(rec) / st['media']['pre']
        c = {'stepId': ch['stepId'], 'k': k, 'slide_id': _sid(s), 'screenshot': None, 'has_target': 'target' in ch, 'target': ch.get('target'),
             'has_dpr': 'dpr' in ch, 'dpr': ch.get('dpr'), 'narration': None, 'reapply': {}}
        if 'screenshot' in ch:
            p = Path(ch['screenshot']['path'])
            if not p.is_absolute() or not p.is_file() or p.is_symlink():
                reject('missing_screenshot', str(p))
            if ar.sha256_file(p) != ch['screenshot']['sha256']:
                reject('screenshot_hash_mismatch', ch['stepId'])
            c['screenshot'] = {'path': str(p), 'sha256': ch['screenshot']['sha256'], 'size': list(_png_size(p))}
            c['reapply']['screenshot'] = cur_png.is_file() and ar.sha256_file(cur_png) == ch['screenshot']['sha256']
        if c['has_target']:
            if _canon(_semantics(ch['target'])) != _canon(_semantics(st.get('target'))):
                reject('unsupported_target_semantics_change', ch['stepId'])
            if not _geometry_ok(ch['target']):
                reject('invalid_geometry', ch['stepId'])
            c['reapply']['target'] = _canon(ch['target']) == _canon(st.get('target'))
        if c['has_dpr']:
            c['reapply']['dpr'] = ch['dpr'] == st.get('dpr')
        if 'narration' in ch:
            n = ch['narration']
            old, new = n['oldText'], n['newText']
            if old != (st.get('narration') or '') or old != (s.get('narration') or ''):
                reject('old_text_mismatch', ch['stepId'])
            if not new.strip():
                reject('unsupported_narration_removal', ch['stepId'])
            if not s.get('audio'):
                reject('unsupported_narration_addition', ch['stepId'])
            if 'newCaption' in n:
                if cfn and n['newCaption'] != new:
                    reject('caption_conflicts_with_captionsFromNarration', ch['stepId'])
                caption_field = n['newCaption']
            elif cfn or (st.get('caption') or '') in ('', old):
                caption_field = new  # the caption mirrored the narration: it follows it
            else:
                caption_field = st.get('caption')  # an independent caption stays
            effective = ((new if cfn else caption_field) or new)
            if new == old and effective != (s.get('caption') or ''):
                reject('unsupported_caption_only_change', ch['stepId'])
            if len(filters) > 1:
                reject('inconsistent_audio_filter', sorted(filters))
            take = None
            if 'take' in n:
                tpth = Path(n['take']['path'])
                if not tpth.is_absolute() or not tpth.is_file() or tpth.is_symlink():
                    reject('missing_take', str(tpth))
                if ar.sha256_file(tpth) != n['take']['sha256']:
                    reject('take_hash_mismatch', ch['stepId'])
                try:
                    ar.stream_info(tpth)
                except (subprocess.CalledProcessError, IndexError, KeyError, ValueError):
                    reject('invalid_take', ch['stepId'])
                take = dict(n['take'])
            elif not take_provider_given:
                reject('take_required', ch['stepId'])
            c['narration'] = {'old': old, 'new': new, 'caption_field': caption_field, 'caption': effective, 'take': take,
                              'audio_filter': next(iter(filters)) if filters else ''}
            c['reapply']['narration'] = new == old
        out.append(c)
    return sorted(out, key=lambda c: c['k'])


# ---------- candidate script ----------

def make_candidate_script(script_path, script, rec, changes, out):
    """All visual changes in ONE tools/drift/candidate.mjs call (PNG validation, captureId regeneration, target
    semantics guard, content-addressed captures); narration/caption applied on top (candidate.mjs rejects them)."""
    vis = [c for c in changes if c['screenshot'] or c['has_target'] or c['has_dpr']]
    rec = Path(rec)
    if rec.name != script['recording']['id']:
        reject('recordings_dir_mismatch', {'dir': rec.name, 'recording': script['recording']['id']})
    meta = None
    if vis:
        dg = drift_render.node_digests(script_path)
        idx = {st['id']: i for i, st in enumerate(script['steps'])}
        mch = []
        for c in vis:
            i = idx[c['stepId']]
            img = Path(c['screenshot']['path']) if c['screenshot'] else rec / script['steps'][i]['media']['pre']
            e = {'stepId': c['stepId'], 'beforeHash': dg['steps'][i], 'imagePath': str(img), 'sha256': ar.sha256_file(img)}
            if c['has_target']:
                e['target'] = c['target']
            if c['has_dpr']:
                e['dpr'] = c['dpr']
            mch.append(e)
        mpath = out / 'candidate.manifest.json'
        mpath.write_text(json.dumps({'baseHash': dg['base'], 'structuralChanges': [], 'changes': mch}, indent=2) + '\n')
        try:
            fx_draw.sh('node', REPO / 'tools' / 'drift' / 'candidate.mjs', '--base', script_path, '--recordings-root', rec.parent,
                       '--manifest', mpath, '--output', out / 'candidate')
        except subprocess.CalledProcessError as e:
            reject('candidate_rejected', (e.stderr or b'').decode(errors='replace').strip().splitlines()[-1:])
        _, meta, ibase, cand, rec_c = drift_render.load_candidate(out / 'candidate')
        if _canon(ibase) != _canon(script):
            reject('candidate_base_mismatch')
        if sorted(meta['changedStepIds']) != sorted(c['stepId'] for c in vis):
            reject('candidate_changes_other_steps')
    else:
        cand, rec_c = copy.deepcopy(script), rec
    by_id = {st['id']: st for st in cand['steps']}
    for c in changes:
        if c['narration']:
            st = by_id[c['stepId']]
            st['narration'] = c['narration']['new']
            st['caption'] = c['narration']['caption_field']
    path = out / 'candidate-final.script.json'
    path.write_text(json.dumps(cand, indent=2, ensure_ascii=False) + '\n')
    # only the approved steps may differ (narration/caption/media/captureId/target/dpr)
    allowed = {'media', 'captureId', 'target', 'dpr', 'narration', 'caption'}
    changed_ids = {c['stepId'] for c in changes}
    for b, x in zip(script['steps'], cand['steps']):
        diff = {f for f in set(b) | set(x) if _canon(b.get(f)) != _canon(x.get(f))}
        if (b['id'] not in changed_ids and diff) or not diff <= allowed:
            reject('unrelated_step_changed', b['id'])
    return path, cand, Path(rec_c), meta


# ---------- planning (no rendering) ----------

def _runs(idx):
    runs = []
    for j in idx:
        if runs and runs[-1][-1] == j - 1:
            runs[-1].append(j)
        else:
            runs.append([j])
    return runs


def _ceil_frame(seconds):
    return math.ceil(round(seconds, 3) * 30 - 1e-6)


def card_phase(build, base_sdurs, new_sdurs, shift):
    """Does assemble's chain shift EVERY boundary after the content start by exactly `shift` frames? The content cut is
    `-t f'{total:.3f}'` and each crossfade_pair offset is `f'{dur(c1) - xf:.3f}'` (dur = format duration = video
    duration here), so the 3-decimal rounding of (N + shift)/30 can move a card start by one extra frame (pilot: outro
    offset 24.5 -> 26.7667 -> '26.767' starts the logo card 69 frames later for a 68-frame shift). Returns per-boundary
    deltas; ok only if all equal `shift`."""
    xf = retime.XF
    tb = sum(base_sdurs) - xf * (len(base_sdurs) - 1)
    tn = sum(new_sdurs) - xf * (len(new_sdurs) - 1)
    rows = [{'boundary': 'content_end', 'delta': _ceil_frame(tn) - _ceil_frame(tb)}]
    active = Path(build['dir']) / 'content.mp4'
    for st in build['stages']:
        if not st['content_second']:
            n1 = rebaseline.count_frames(active)
            if round(max(0.05, n1 / 30 - st['xf']), 3) != round(st['offset'], 3):
                reject('card_phase_unpredictable', {'stage': st['stage'], 'frames': n1, 'offset': st['offset']})
            ob, on = max(0.05, n1 / 30 - st['xf']), max(0.05, (n1 + shift) / 30 - st['xf'])
            rows.append({'boundary': f"{st['stage']}_start", 'offset_base': round(ob, 3), 'offset_new': round(on, 3),
                         'delta': _ceil_frame(on) - _ceil_frame(ob)})
        if st['real_output']:
            active = Path(st['real_output'])
    return {'ok': all(r['delta'] == shift for r in rows), 'shift': shift, 'boundaries': rows}


def plan_update(assembly, base, cand, rec_base, rec_cand, changes, takes, m, work, *, font_layout='basic', report_fields=None, build=None):
    """takes: {k: {'path', 'adur', 'audio_filter'}} for narration changes ({} = baseline timing, used as preflight)."""
    slides = assembly['slides']
    n = len(slides)
    caps_b, caps_c = drift_render._captured(base), drift_render._captured(cand)
    if len(caps_c) != n:
        reject('assembly_script_mismatch')
    sdurs, quant = [s['sdur'] for s in slides], {}
    for k, t in sorted(takes.items()):
        try:
            q = retime.quantize_sdur(slides[k]['sdur'], t['adur'])
        except retime.RetimeRejected as e:
            reject(e.code, e.detail)
        sdurs[k] = q['sdur']
        quant[_sid(slides[k])] = q
    shift = sum(q['shift_frames'] for q in quant.values())
    phase = None
    if takes and build is not None:
        # extra whole frames of pause on the LAST re-timed slide until every card boundary shifts by exactly `shift`
        last = max(takes)
        q = quant[_sid(slides[last])]
        for pad in range(0, 6):
            k_ = q['shift_frames'] + pad
            sd = round(slides[last]['sdur'] + k_ / 30, 3)
            if int(round(sd * 30)) != int(round(slides[last]['sdur'] * 30)) + k_:
                continue
            trial = list(sdurs)
            trial[last] = sd
            sh_ = shift + pad
            phase = card_phase(build, [s['sdur'] for s in slides], trial, sh_)
            if phase['ok']:
                sdurs, shift = trial, sh_
                quant[_sid(slides[last])] = {**q, 'sdur': sd, 'shift_frames': k_, 'card_phase_padding_frames': pad,
                                             'extra_pause_s': round(sd - q['assemble_sdur'], 6)}
                break
        if not phase or not phase['ok']:
            reject('card_phase_unresolvable', phase)
    starts = retime.starts_of(sdurs)
    gdir, cdir = work / 'replan-golden' / 'out', work / 'out'
    (gdir / 'slides').mkdir(parents=True)
    (cdir / 'slides').mkdir(parents=True)
    sizes_b, sizes_c = {}, {}
    for j, a in enumerate(slides):
        src_b, src_c = Path(rec_base) / caps_b[j]['media']['pre'], Path(rec_cand) / caps_c[j]['media']['pre']
        for src in (src_b, src_c):
            if not src.is_file() or src.is_symlink():
                reject('missing_capture', src.name)
        sizes_b[a['slide']], sizes_c[a['slide']] = _png_size(src_b), _png_size(src_c)
        shutil.copyfile(src_b, gdir / 'slides' / a['file'])
        shutil.copyfile(src_c, cdir / 'slides' / a['file'])
    rf = dict(report_fields or {})
    kw = dict(needs_drawn_highlight=True, report=rf, font_layout=font_layout)
    try:
        gp = fx_draw.load_planner(out_dir=gdir, tmp_dir=gdir / '_build', **kw)
        golden, _ = gp.replan(fx_draw.report_slides(assembly, base, sizes_b))
    except ValueError as e:
        reject('replan_failed_closed', str(e))
    diff = fx_draw.plan_diff(golden, slides)
    if diff:
        reject('replan_golden_mismatch', diff[:6])
    timed = copy.deepcopy(assembly)
    for j, s in enumerate(timed['slides']):
        s['sdur'] = sdurs[j]
    try:
        cp = fx_draw.load_planner(out_dir=cdir, tmp_dir=work / 'replan-candidate-build', **kw)
        planned, screens = cp.replan(fx_draw.report_slides(timed, cand, sizes_c))
    except ValueError as e:
        reject('replan_failed_closed', str(e))
    by_k = {c['k']: c for c in changes}
    reasons, plan_only = {}, {}
    for j, (p, a) in enumerate(zip(planned, slides)):
        rv, av = fx_draw.render_view(p), fx_draw.render_view(a)
        why = sorted(f for f in set(rv) | set(av) if rv.get(f) != av.get(f))
        text_diff = [f for f in ('narration', 'caption', 'route', 'action') if p.get(f) != a.get(f)]
        if j in by_k:
            c = by_k[j]
            what = [x for x, on in (('screenshot', c['screenshot']), ('target', c['has_target']), ('dpr', c['has_dpr']),
                                    ('narration', c['narration'])) if on]
            why = ['changed_step', *what, *text_diff, *why]
        elif text_diff:
            reject('unrelated_step_changed', _sid(a))
        if why:
            reasons[_sid(a)] = why
        pv, apv = fx_draw.plan_view(p), fx_draw.plan_view(a)
        extra = sorted(f for f in set(pv) | set(apv) if pv.get(f) != apv.get(f) and f not in why)
        if extra and _sid(a) not in reasons:
            plan_only[_sid(a)] = extra
    dirty = [j for j, a in enumerate(slides) if _sid(a) in reasons]
    new = copy.deepcopy(assembly)
    for j, s in enumerate(new['slides']):
        if j in dirty:
            for f in fx_draw.PLAN_FIELDS:
                if f in planned[j]:
                    s[f] = planned[j][f]
                else:
                    s.pop(f, None)
            for f in ('narration', 'caption', 'src'):
                s[f] = planned[j].get(f)
        s['sdur'], s['start'] = sdurs[j], starts[j]
        if j in takes:
            s.update(adur=takes[j]['adur'], audio=str(takes[j]['path']), audio_filter=takes[j]['audio_filter'])
    total = m['frameCount'] + shift
    new['duration'] = round(total / 30, 2)
    new = json.loads(json.dumps(new))
    try:
        tl = fx_scope.timeline(new, total)
    except ValueError as e:
        reject('cell_topology_changed', str(e))
    if [c['id'] for c in fx_scope.timeline(assembly, m['frameCount'])['cells']] != [c['id'] for c in m['cells']]:
        reject('baseline_cells_mismatch')
    dirty_ids = [_sid(slides[j]) for j in dirty]
    try:
        cmap = retime.map_cells(m['cells'], tl['cells'], dirty_ids)
    except retime.RetimeRejected as e:
        reject(e.code, e.detail)
    drawer = fx_draw.load(out_dir=cdir, tmp_dir=cdir / '_build', needs_drawn_highlight=True, font_layout=font_layout)
    views = retime.protected_views_equal(drawer, assembly, new, cmap)
    if not views['ok']:
        reject('scope_expansion_required:protected_camera_changed', views['mismatches'][:3])
    old_first = [bool(a['_fx']['first']) for a in slides]
    new_first = [bool(p['_fx']['first']) for p in planned]
    summary = {'changed_steps': {c['stepId']: c['slide_id'] for c in changes}, 'dirty_slides': dirty_ids,
               'dirty_runs': [[_sid(slides[j]) for j in r] for r in _runs(dirty)], 'reasons': reasons, 'plan_only_differences': plan_only,
               'shift_frames': shift, 'quantize': quant, 'card_phase': phase, 'sdurs': {'base': [s['sdur'] for s in slides], 'new': sdurs},
               'starts': {'base': [s['start'] for s in slides], 'new': starts}, 'frames': {'base': m['frameCount'], 'new': total},
               'rendered_cells': [c['id'] for c in cmap if c['action'] == 'render'], 'reused_cells': [c['id'] for c in cmap if c['action'] == 'reuse'],
               'cell_map': cmap, 'edges': {'lead': 0 in dirty, 'tail': (n - 1) in dirty},
               'screen_grouping_changed': old_first != new_first, 'screens_before': old_first, 'screens_after': new_first,
               'protected_views': {k: v for k, v in views.items() if k != 'mismatches'}, 'planner_fingerprint': cp.fingerprint(),
               'replan_golden': {'equal': True, 'slides': len(golden)}, 'report_fields': rf}
    return {'summary': summary, 'dirty': dirty, 'cmap': cmap, 'timeline': tl, 'assembly': new, 'drawer': drawer, 'sdurs': sdurs,
            'total': total, 'shift': shift, 'planned': planned}


# ---------- takes ----------

def resolve_takes(changes, take_provider, voice, dest):
    out = {}
    for c in changes:
        n = c['narration']
        if not n:
            continue
        tag = c['slide_id']
        if n['take'] is not None:
            src = Path(n['take']['path'])
            d = Path(dest) / 'takes'
            d.mkdir(parents=True, exist_ok=True)
            p = d / f'{tag}-{src.name}'
            shutil.copyfile(src, p)
            info = {'path': str(p), 'sha256': ar.sha256_file(p), 'source': n['take'].get('source', 'manifest-provided take'),
                    'provider': 'manifest', 'cached': None, 'characters': 0, 'provider_path': str(src)}
            if info['sha256'] != n['take']['sha256']:
                reject('take_hash_mismatch', c['stepId'])
        else:
            try:
                info = take_provider(n['new'], voice, dest, tag)
            except tp.TakeRejected as e:
                reject(e.code, e.detail)
            if ar.sha256_file(info['path']) != info['sha256']:
                reject('take_hash_mismatch', c['stepId'])
        info['adur'] = ar.ffprobe_duration(info['path'])
        info['audio_filter'] = n['audio_filter']
        info['text'] = n['new']
        out[c['k']] = info
    return out


# ---------- rendering ----------

def content_av_command(video, takes, sdurs, music, filters, output):
    """assemble step 4's ONE command: `-i video.mp4` + takes + looped music, the verbatim audio graph
    (audio_rebuild.content_filter; inputs numbered from 1 like assemble), `-map 0:v -map [aout] -c:v copy` + AAC 192k,
    `-t total`. A separate stream-copy remux of the content audio is NOT equivalent: it drops the AAC track's start
    offset (start_pts 1024 -> 0) and 160 samples, which changes every later crossfade (caught by the chain golden)."""
    sched = ar.voice_schedule(sdurs, [t is not None for t in takes])
    inputs, voices, idx = ['-i', str(video)], [], 1
    for k, t in enumerate(takes):
        if t is not None:
            voices.append((idx, sched['slides'][k]['delay_ms'], filters[k]))
            inputs += ['-i', str(t)]
            idx += 1
    inputs += ['-stream_loop', '-1', '-i', str(music)]
    fc = ar.content_filter(voices, sched['total'], idx)
    return ['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', fc, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', *ar.AAC,
            '-movflags', '+faststart', '-t', f"{sched['total']:.3f}", str(output)]


def run_chain_av(drawer, build, slides, segs, audio, workdir):
    """assemble's stitch + content.mp4 (step 4 command) + crossfade_pair chain WITH audio: offsets = format duration of
    each new intermediate - xf, exactly like crossfade_pair (needed once the content duration changes).
    audio: {'takes': [path|None], 'filters': [...], 'music': path}."""
    ns, wd = drawer.ns, Path(workdir)
    wd.mkdir(parents=True)
    video = wd / 'video.mp4'
    sdurs = [s['sdur'] for s in slides]
    if len(segs) == 1:
        shutil.copyfile(segs[0], video)
    else:
        fx_draw.sh(*fx_draw.xfade_command(segs, sdurs, video, ns['XF'], ns['FPS'], ns['INTERMEDIATE_ENCODE']))
    content = wd / 'content.mp4'
    fx_draw.sh(*content_av_command(video, audio['takes'], sdurs, audio['music'], audio['filters'], content))
    cur, counts, offsets = content, {'content': rebaseline.count_frames(content)}, {}
    for st in build['stages']:
        nxt = wd / f"{st['stage']}.mp4"
        c1, c2 = (st['clip'], cur) if st['content_second'] else (cur, st['clip'])
        off = max(0.05, drift_render.media_duration(c1) - st['xf'])
        enc = ns['INTERMEDIATE_ENCODE'] if st['intermediate'] else drift_render.CROSSFADE_FINAL_ENCODE
        fx_draw.sh(*drift_render.crossfade_command(c1, c2, nxt, st['xf'], off, enc, audio=True))
        offsets[st['stage']] = round(off, 3)
        cur = nxt
        counts[st['stage']] = rebaseline.count_frames(cur)
    return cur, counts, offsets


def _render_segments(d, entries, idx, report_fields):
    segs = {j: d.ns['tmp'] / f"seg{entries[j]['slide']:02d}.mp4" for j in idx}
    rf = report_fields or {}
    with ThreadPoolExecutor(max_workers=max(1, min(4, len(idx)))) as pool:
        list(pool.map(lambda j: fx_draw.render_segment(d, entries[j], segs[j], caption_pos=rf.get('caption_pos'),
                                                       no_captions=bool(rf.get('no_captions'))), idx))
    return segs


def _cut(stream, a, b, path, sig0):
    rebaseline.encode_cell(stream, a, b, path, vf='setsar=1')  # SAR into the SPS like the rebaseline cells
    sig = rebaseline.cell_signature(path, b - a)
    if sig != sig0:
        reject('incompatible_replacement', path.name)
    return {'file': str(path), 'sha256': file_hash(path), 'frames': [a, b]}


# ---------- review helpers ----------

def contact_sheet(rows, base, cand, output):
    """rows: [(label, base_index|None, cand_index|None)] -> baseline | candidate | |diff| x4 (JPEG)."""
    import numpy as np
    from PIL import Image, ImageChops, ImageDraw
    tw, th = 480, 270
    sheet = Image.new('RGB', (tw * 3 + 210, (th + 6) * len(rows) + 30), 'white')
    d = ImageDraw.Draw(sheet)
    for j, lab in enumerate(('baseline (rebaseline)', 'candidate', '|baseline - candidate| x4')):
        d.text((210 + j * tw + 6, 8), lab, fill='black')
    for r, (label, bi, ci) in enumerate(rows):
        y = 30 + r * (th + 6)
        d.text((4, y + 4), f'{label}\nbase {bi}\ncand {ci}', fill='black')
        ims = [drift_render.grab(base, bi) if bi is not None else None, drift_render.grab(cand, ci) if ci is not None else None]
        for j, im in enumerate(ims):
            if im is not None:
                sheet.paste(im.resize((tw, th)), (210 + j * tw, y))
        if all(ims):
            diff = np.clip(np.asarray(ImageChops.difference(*ims), dtype=np.int32) * 4, 0, 255).astype('uint8')
            sheet.paste(Image.fromarray(diff).resize((tw, th)), (210 + 2 * tw, y))
    sheet.save(output, quality=88)


def _band_diff(a, b):
    import numpy as np
    x = np.asarray(a.crop((0, 780, 1920, 1080)).convert('L'), dtype=np.int16)
    y = np.asarray(b.crop((0, 780, 1920, 1080)).convert('L'), dtype=np.int16)
    return round(float(np.abs(x - y).mean()), 3)


# ---------- orchestration ----------

def run(rebaseline_dir, script_path, recordings_dir, change_manifest, build_dir, output, *, music=None, take_provider=None,
        font_layout='basic', report_fields=None, dry_run=False, baseline_voice_check=False):
    ar.assemble_audio_pins()
    retime.check_source_pins()
    rdir, manifest_path, m, assembly, final = drift_render.load_rebaseline(rebaseline_dir)
    cm = load_change_manifest(change_manifest, manifest_path)
    if not cm['changes']:
        out = drift_render.new_dir(output)
        rep = {'ok': file_hash(final) == m['final']['sha256'], 'noop': True, 'rendered': False, 'candidate': str(final),
               'candidate_sha256': file_hash(final), 'baseline_sha256': m['final']['sha256'], 'output': str(out),
               'note': 'empty change manifest: the baseline artifact itself is the candidate (no render, no remux)'}
        (out / 'verification.json').write_text(json.dumps(rep, indent=2) + '\n')
        return rep
    script_path = Path(script_path)
    script = json.loads(script_path.read_bytes())
    caps = validate_baseline(assembly, script)
    rf = dict(report_fields or {})
    if set(rf) - set(fx_draw.REPORT_FIELDS):
        reject('unsupported_report_field', sorted(set(rf) - set(fx_draw.REPORT_FIELDS)))
    if build_dir is None:
        reject('build_dir_required')
    original = Path(build_dir).resolve().parent / f"{m['original']['name']}.mp4"
    if not original.is_file() or file_hash(original) != m['original']['sha256']:
        reject('build_dir_not_baseline_source', str(original))
    try:
        build = drift_render.load_build(build_dir, assembly)
    except drift_render.DonorRejected as e:
        reject(e.code, e.detail)
    rec = Path(recordings_dir).resolve()
    changes = validate_changes(cm['changes'], script, assembly, caps, rec, take_provider is not None)
    narr = [c for c in changes if c['narration']]
    slides = assembly['slides']
    base_takes = [Path(s['audio']) if s.get('audio') else None for s in slides]
    music = Path(music or REPO / 'assets' / 'music_upbeat.wav')
    cards = None
    if narr:
        if any(t is not None and (not t.is_file() or t.is_symlink()) for t in base_takes):
            reject('baseline_take_missing')
        try:
            cards = ar.card_clips(build_dir, assembly)
        except ValueError as e:
            reject(str(e))
        if not music.is_file():
            reject('missing_music_bed', str(music))
    voice_check = None
    if baseline_voice_check and any(c['narration'] and c['narration']['take'] is None for c in changes):
        try:
            voice_check = tp.verify_baseline_takes(assembly, script.get('voice'))
        except tp.TakeRejected as e:
            reject(e.code, e.detail)
        if not voice_check['ok']:
            reject('baseline_voice_unverified', voice_check)
    real = sorted({Path(p) for p in [script_path, music, fx_draw.ASSEMBLE, tp.TTS, original, manifest_path, final, rdir / m['assembly']['file'],
                                     *(rdir / c['file'] for c in m['cells']), *(rec / st['media']['pre'] for st in caps),
                                     *(Path(c['screenshot']['path']) for c in changes if c['screenshot']),
                                     *(Path(c['narration']['take']['path']) for c in narr if c['narration']['take']),
                                     *(t for t in base_takes if t and t.is_file()),
                                     *(p for p in Path(build_dir).iterdir() if p.is_file())]}
                  | ({Path(change_manifest)} if not isinstance(change_manifest, dict) else set()))
    before = fx_draw.snapshot(real)
    out = drift_render.new_dir(output)
    (out / 'inputs').mkdir()
    shutil.copyfile(manifest_path, out / 'inputs' / 'baseline-manifest.json')
    (out / 'inputs' / 'change-manifest.json').write_text(json.dumps(cm, indent=2, ensure_ascii=False) + '\n')
    cand_path, cand, rec_c, cand_meta = make_candidate_script(script_path, script, rec, changes, out)
    # preflight at baseline timing: every planning rejection before any TTS spend
    plan_update(assembly, script, cand, rec, rec_c, changes, {}, m, out / 'work-preflight', font_layout=font_layout, report_fields=rf, build=build)
    takes = resolve_takes(changes, take_provider, script.get('voice'), out / 'inputs')
    plan = plan_update(assembly, script, cand, rec, rec_c, changes, takes, m, out / 'work', font_layout=font_layout, report_fields=rf, build=build)
    summary = plan['summary']
    takes_rep = {_sid(slides[k]): {kk: v for kk, v in t.items()} for k, t in takes.items()}
    if dry_run:
        rep = {'ok': True, 'dry_run': True, 'output': str(out), 'plan': summary, 'takes': takes_rep, 'voice_check': voice_check}
        (out / 'plan.json').write_text(json.dumps(rep, indent=2, default=str) + '\n')
        return rep
    return _render_and_verify(rdir, manifest_path, m, assembly, final, original, build, build_dir, changes, takes, plan, out, rf,
                              music, cards, base_takes, before, real, cand_path, cand_meta, voice_check)


def _render_and_verify(rdir, manifest_path, m, assembly, final, original, build, build_dir, changes, takes, plan, out, rf, music, cards,
                       base_takes, before, real, cand_path, cand_meta, voice_check):
    slides, n = assembly['slides'], len(assembly['slides'])
    d, new, cmap, tl = plan['drawer'], plan['assembly'], plan['cmap'], plan['timeline']
    summary = plan['summary']
    dirty = plan['dirty']
    narr = bool(takes)
    entries = {j: fx_draw.frozen_slide(new['slides'][j]) for j in range(n)}
    orig_entries = [fx_draw.frozen_slide(s) for s in slides]
    real_segs = [Path(build['segs'][s['slide']]) for s in slides]
    golden = {'replan': summary['replan_golden']}
    filters = [s.get('audio_filter') or '' for s in slides]
    # inputs for the soundtrack: unchanged takes fed byte-for-byte from copies
    snd = g = None
    copies, card_copies, music_copy = [], {}, None
    if narr:
        tdir = out / 'inputs' / 'baseline-takes'
        tdir.mkdir()
        for s, t in zip(slides, base_takes):
            if t is None:
                copies.append(None)
                continue
            dst = tdir / f"{_sid(s)}-{t.name}"
            shutil.copyfile(t, dst)
            copies.append(dst)
        for key, p in cards.items():
            card_copies[key] = out / 'inputs' / f'card-{key}-{p.name}'
            shutil.copyfile(p, card_copies[key])
        music_copy = out / 'inputs' / music.name
        shutil.copyfile(music, music_copy)
        g = ar.rebuild_soundtrack(copies, [s['sdur'] for s in slides], music_copy, card_copies, out / 'audio' / 'golden', filters)
        golden['audio'] = {'packets_equal': ar.packets(g['final']) == ar.packets(final), 'pcm': ar.compare_pcm(final, g['final']),
                           'schedule_starts_equal_assembly': [x['start'] for x in g['schedule']['slides']] == [s['start'] for s in slides]}
        if not golden['audio']['packets_equal']:
            (out / 'verification.json').write_text(json.dumps({'ok': False, 'rejected': 'audio_golden_mismatch', 'golden': golden}, indent=2, default=str))
            reject('audio_golden_mismatch', golden['audio']['pcm'])
    # chain golden (control over the untouched real segments must decode-equal the original final)
    if narr:
        ctrl, ctrl_counts, ctrl_off = run_chain_av(d, build, orig_entries, real_segs, {'takes': copies, 'filters': filters, 'music': music_copy},
                                                   out / 'chain-control')
        stored = {st['stage']: round(st['offset'], 3) for st in build['stages']}
    else:
        ctrl, ctrl_counts = drift_render.run_chain(d, build, orig_entries, real_segs, out / 'chain-control')
        ctrl_off = stored = {st['stage']: round(st['offset'], 3) for st in build['stages']}
    a_, b_ = fx_draw.framehashes(ctrl), fx_draw.framehashes(original)
    golden['chain'] = {'mode': 'with_audio' if narr else 'video_only', 'original_final': str(original), 'frames': len(a_),
                       'decoded_frames_equal': a_ == b_, 'equal_frames': sum(x == y for x, y in zip(a_, b_)), 'stage_frames': ctrl_counts,
                       'offsets': ctrl_off, 'stored_offsets': stored, 'offsets_equal': ctrl_off == stored}
    if narr:
        golden['chain']['audio_packets_equal_original'] = ar.packets(ctrl) == ar.packets(original)
        golden['chain']['content_audio_packets_equal_real_content'] = (ar.packets(Path(out / 'chain-control' / 'content.mp4'))
                                                                       == ar.packets(Path(build['dir']) / 'content.mp4'))
    if not (golden['chain']['decoded_frames_equal'] and golden['chain']['offsets_equal'] and golden['chain'].get('audio_packets_equal_original', True)):
        (out / 'verification.json').write_text(json.dumps({'ok': False, 'rejected': 'chain_golden_mismatch', 'golden': golden}, indent=2, default=str))
        reject('chain_golden_mismatch', golden['chain'])
    sig0 = rebaseline.cell_signature(rdir / m['cells'][0]['file'], m['cells'][0]['endFrame'] - m['cells'][0]['startFrame'])
    base_cells = {c['id']: c for c in m['cells']}
    cc = out / 'control-cells'
    cc.mkdir()
    golden['control_cells_byte_identical_to_rebaseline'] = {}
    for c in cmap:
        if c['action'] == 'render':
            x = _cut(ctrl, c['base'][0], c['base'][1], cc / f"cell-{c['id']}.mp4", sig0)
            golden['control_cells_byte_identical_to_rebaseline'][c['id']] = x['sha256'] == base_cells[c['id']]['sha256']
    # render every dirty slide ONCE, then assemble's chain
    rendered_segs = _render_segments(d, entries, dirty, rf)
    segs = [rendered_segs.get(j, real_segs[j]) for j in range(n)]
    chain_slides = [entries[j] for j in range(n)]
    if narr:
        new_takes = list(copies)
        new_filters = list(filters)
        for k, t in takes.items():
            new_takes[k] = Path(t['path'])
            new_filters[k] = t['audio_filter']
        snd = ar.rebuild_soundtrack(new_takes, plan['sdurs'], music_copy, card_copies, out / 'audio' / 'candidate', new_filters)
        chain_final, counts, offsets = run_chain_av(d, build, chain_slides, segs, {'takes': new_takes, 'filters': new_filters, 'music': music_copy},
                                                    out / 'chain')
    else:
        chain_final, counts = drift_render.run_chain(d, build, chain_slides, segs, out / 'chain')
        offsets = stored
    nframes = rebaseline.count_frames(chain_final)
    if nframes != plan['total']:
        reject('chain_frame_count_mismatch', {'chain': nframes, 'expected': plan['total']})
    cdir = out / 'cells'
    cdir.mkdir()
    rendered = {}
    for c in cmap:
        if c['action'] == 'render':
            rendered[c['id']] = {**_cut(chain_final, c['new'][0], c['new'][1], cdir / f"cell-{c['id']}.mp4", sig0), 'base': c['base'], 'new': c['new']}
    # splice
    preservation_rep = None
    if not narr:
        approval = {'baselineManifestHash': file_hash(manifest_path), 'renderProfileHash': m['profileHash'], 'changedStepIds': summary['dirty_slides']}
        (out / 'local-approval.json').write_text(json.dumps(approval, indent=2) + '\n')
        try:
            preservation_rep = rebaseline.assemble_candidate(manifest_path, approval, {cid: Path(v['file']) for cid, v in rendered.items()},
                                                              out / 'assembled')
        except ValueError as e:
            reject(str(e))
        cand = Path(preservation_rep['artifact'])
        reused_files = {c['id']: out / 'assembled' / base_cells[c['id']]['file'] for c in cmap if c['action'] == 'reuse'}
    else:
        ordered, reused_files = [], {}
        sdir = out / 'spliced'
        sdir.mkdir()
        for c in cmap:
            dst = sdir / f"cell-{c['id']}.mp4"
            shutil.copyfile(rdir / base_cells[c['id']]['file'] if c['action'] == 'reuse' else rendered[c['id']]['file'], dst)
            if c['action'] == 'reuse':
                reused_files[c['id']] = dst
            ordered.append(dst)
        video = out / 'candidate-video.mp4'
        rebaseline.concat(ordered, video)
        cand = out / 'candidate.mp4'
        rebaseline.mux(video, snd['final'], cand)
    # ---------- verification ----------
    cf, bf = fx_draw.framehashes(cand), fx_draw.framehashes(final)
    timing = rebaseline.native_timing(cand)
    ticks = rebaseline.TICKS
    ts_ok = [int(x['pts']) for x in timing] == [i * ticks for i in range(len(timing))] and all(int(x['duration']) == ticks for x in timing)
    keys = {i for i, x in enumerate(timing) if int(x['key_frame']) == 1}
    reused = {c['id']: {'base': c['base'], 'new': c['new'], 'shift_frames': c['new'][0] - c['base'][0], 'sha256': file_hash(reused_files[c['id']]),
                        'byte_identical': file_hash(reused_files[c['id']]) == base_cells[c['id']]['sha256']} for c in cmap if c['action'] == 'reuse'}
    reused_frames_ok = all(cf[c['new'][0]:c['new'][1]] == bf[c['base'][0]:c['base'][1]] for c in cmap if c['action'] == 'reuse')
    differing = {cid: sum(1 for i in range(*v['new']) if i - v['new'][0] < v['base'][1] - v['base'][0]
                          and cf[i] != bf[v['base'][0] + i - v['new'][0]]) for cid, v in rendered.items()}
    checks = {'frames_total': len(cf), 'expected_frames': plan['total'], 'decodable': len(cf) == plan['total'], 'timestamps_contiguous': ts_ok,
              'keyframes_at_cell_starts': all(c['new'][0] in keys for c in cmap), 'reused_cells': reused,
              'reused_cells_byte_identical': all(v['byte_identical'] for v in reused.values()),
              'reused_frames_equal_at_shifted_positions': reused_frames_ok, 'rendered_cells': {k: {kk: v[kk] for kk in ('sha256', 'base', 'new')}
                                                                                              for k, v in rendered.items()},
              'rendered_frames_differing_from_baseline_overlap': differing, 'cells_accounted': len(reused) + len(rendered) == len(m['cells']),
              'chain_stage_frames': counts, 'chain_offsets': offsets}
    if preservation_rep is not None:
        merged = fx_scope._ranges(sorted(tuple(x) for x in preservation_rep['dirty_frames']))
        changed = [i for i, (x, y) in enumerate(zip(bf, cf)) if x != y]
        checks.update(preservation={k: v for k, v in preservation_rep.items() if k not in ('pcm',)}, dirty_frames=merged,
                      frames_changed=len(changed), changed_range=[changed[0], changed[-1] + 1] if changed else None,
                      changed_frames_inside_dirty=all(any(a <= i < b for a, b in merged) for i in changed))
    # captions of every narration-changed slide
    cap = {}
    ref_dir = out / 'caption-ref'
    ref_dir.mkdir()
    for k, t in takes.items():
        s_new = new['slides'][k]
        txt = s_new.get('caption') or s_new.get('narration')
        ref = ref_dir / f"cap{s_new['slide']:02d}-ref.png"
        d.ns['caption_png'](txt, ref, pos=s_new.get('caption_pos') or rf.get('caption_pos') or 'center')
        got = d.ns['tmp'] / f"cap{s_new['slide']:02d}.png"
        cap[_sid(s_new)] = {'caption': txt, 'png_matches_new_text': got.is_file() and got.read_bytes() == ref.read_bytes()}
        hold = next(c for c in cmap if c['id'] == f"hold-{s_new['slide']:02d}")
        mid_n, mid_b = (hold['new'][0] + hold['new'][1]) // 2, (hold['base'][0] + hold['base'][1]) // 2
        cap[_sid(s_new)]['caption_band_mean_diff_vs_baseline'] = _band_diff(drift_render.grab(cand, mid_n), drift_render.grab(final, mid_b))
    checks['captions'] = {'slides': cap, 'changed_caption_pngs_match_new_text': all(v['png_matches_new_text'] for v in cap.values()),
                          'changed_caption_bands_differ': all(v['caption_band_mean_diff_vs_baseline'] > 2.0 for v in cap.values()),
                          'other_captions_unchanged': all(_canon([s.get('caption'), s.get('narration'), s.get('_cap_text')])
                                                          == _canon([o.get('caption'), o.get('narration'), o.get('_cap_text')])
                                                          for j, (s, o) in enumerate(zip(new['slides'], slides)) if j not in takes)}
    audio = None
    if narr:
        audio = _verify_audio(final, cand, snd, g, chain_final, copies, base_takes, takes, slides, plan, tl, out, golden)
    # golden re-apply
    is_reapply = all(all(c['reapply'].values()) for c in changes) and all(
        t['sha256'] == ar.sha256_file(base_takes[k]) for k, t in takes.items())
    gr = {'is_reapply': is_reapply}
    if is_reapply:
        q = {}
        for cid, v in rendered.items():
            if v['new'][1] - v['new'][0] == v['base'][1] - v['base'][0] and differing[cid]:
                w = fx_draw.window_quality(v['file'], 0, final, v['base'][0], v['base'][1] - v['base'][0], out, f'reapply-{cid}')
                q[cid] = {k: w[k] for k in ('psnr_min', 'psnr_mean', 'ssim_min')}
        psnr_min = min([v['psnr_min'] for v in q.values() if v['psnr_min'] != 'inf'] or [float('inf')])
        gr.update(frames_differing_from_baseline=sum(1 for x, y in zip(cf, bf) if x != y) + abs(len(cf) - len(bf)),
                  rendered_cells_quality=q, psnr_min=psnr_min, psnr_tolerance_db=REAPPLY_PSNR_MIN,
                  audio_packets_equal_baseline=ar.packets(cand) == ar.packets(final),
                  candidate_sha256_equals_baseline=file_hash(cand) == m['final']['sha256'])
        gr['within_tolerance'] = bool(len(cf) == len(bf) and (gr['frames_differing_from_baseline'] == 0 or psnr_min >= REAPPLY_PSNR_MIN)
                                      and gr['audio_packets_equal_baseline'])
    # contact sheet
    rows = []
    for c in cmap:
        if c['kind'] == 'bookend' and c['action'] == 'reuse':
            rows.append((f"{c['id']} ({c['action']}) +20", c['base'][0] + 20, c['new'][0] + 20))
            continue
        rows.append((f"{c['id']} ({c['action']})", (c['base'][0] + c['base'][1]) // 2, (c['new'][0] + c['new'][1]) // 2))
    for c in cmap:
        if c['kind'] == 'hold' and c['action'] == 'render':
            rows.append((f"{c['id']} end-12", c['base'][1] - 12, c['new'][1] - 12))
    sheet = out / 'contact-sheet.jpg'
    contact_sheet(rows, final, cand, sheet)
    asm_path = out / 'candidate-assembly.json'
    asm_path.write_text(json.dumps(new, indent=1, default=str) + '\n')
    after = fx_draw.snapshot(real)
    ok = (golden['chain']['decoded_frames_equal'] and checks['decodable'] and ts_ok and checks['keyframes_at_cell_starts']
          and checks['reused_cells_byte_identical'] and reused_frames_ok and checks['cells_accounted']
          and checks['captions']['changed_caption_pngs_match_new_text'] and checks['captions']['other_captions_unchanged']
          and (not cap or checks['captions']['changed_caption_bands_differ'] or is_reapply) and before == after)
    if preservation_rep is not None:
        ok = ok and preservation_rep['protected_frames_equal'] and preservation_rep['complete_audio_equal'] and checks['changed_frames_inside_dirty']
    if audio is not None:
        ok = ok and audio['ok']
    if is_reapply:
        ok = ok and gr['within_tolerance']
    report = {'ok': bool(ok), 'output': str(out), 'candidate': str(cand), 'candidate_sha256': file_hash(cand), 'baseline_sha256': m['final']['sha256'],
              'candidate_assembly': str(asm_path), 'candidate_script': str(cand_path), 'candidate_capture_manifest': cand_meta,
              'contact_sheet': str(sheet), 'plan': summary, 'takes': {_sid(slides[k]): t for k, t in takes.items()},
              'elevenlabs_characters': sum(t.get('characters') or 0 for t in takes.values() if t.get('provider') == 'el'),
              'voice_check': voice_check, 'golden': golden, 'golden_reapply': gr, 'checks': checks, 'audio': audio,
              'donor': {'drawer_fingerprint': d.fingerprint(), 'font_layout': d.font_layout, 'assemble_sha256': file_hash(fx_draw.ASSEMBLE),
                        'segments': {entries[j]['file']: file_hash(p) for j, p in rendered_segs.items()}},
              'source_unchanged': before == after, 'source_snapshot': {'files': len(before), 'before': before, 'after': after},
              'disclosure': ('LOCAL review artifact, never uploaded. Rendered cells come from assemble\'s own chain (dirty segments '
                             're-rendered, other segments/cards = the real _build files) re-encoded per cell like the rebaseline, next to '
                             'protected cells that are the lossy rebaseline of the published final. Narration changes re-mix and re-encode '
                             'the whole soundtrack once (4 AAC generations like assemble); sdur is rounded up to whole frames; reused '
                             'cells after a timing shift keep the baseline\'s sub-ms blend phase.')}
    (out / 'verification.json').write_text(json.dumps(report, indent=2, default=str) + '\n')
    return report


def _verify_audio(final, cand, snd, g, chain_final, copies, base_takes, takes, slides, plan, tl, out, golden):
    new_takes = list(copies)
    new_filters = [s.get('audio_filter') or '' for s in slides]
    for k, t in takes.items():
        new_takes[k] = Path(t['path'])
        new_filters[k] = t['audio_filter']
    base_loc = ar.locate_takes(final, copies, [s.get('audio_filter') or '' for s in slides], g['schedule'], g['content_origin'], out / 'audio')
    loc = ar.locate_takes(cand, new_takes, new_filters, snd['schedule'], snd['content_origin'], out / 'audio')
    cal = sorted(x['lag_samples'] for x in base_loc)[len(base_loc) // 2]
    c0 = tl['content_start_frame']
    frames_new = [retime.frame_of(x) for x in plan['summary']['starts']['new']]
    frames_old = [retime.frame_of(x) for x in plan['summary']['starts']['base']]
    rows, at_off, sync = [], True, True
    for x in loc:
        j = x['slide'] - 1
        b = next((y for y in base_loc if y['slide'] == x['slide']), None)
        v_new, v_old = (c0 + frames_new[j]) / 30, (c0 + frames_old[j]) / 30
        r = {**x, 'role': ('NEW take: ' + takes[j].get('source', '')) if j in takes else 'unchanged take (byte-identical input)',
             'baseline_lag_samples': b['lag_samples'] if b else None, 'calibration_lag_samples': cal, 'video_slide_start_s': round(v_new, 6),
             'audio_minus_video_s': round(x['position_s'] - v_new, 6), 'baseline_audio_minus_video_s': round(b['position_s'] - v_old, 6) if b else None}
        ref = b['lag_samples'] if (b and j not in takes) else cal
        r['lag_ok'] = abs(x['lag_samples'] - ref) <= LAG_TOLERANCE and x['peak'] > 0.6
        at_off &= r['lag_ok']
        if b and j not in takes:
            r['sync_delta_ms'] = round((r['audio_minus_video_s'] - r['baseline_audio_minus_video_s']) * 1000, 3)
            sync &= abs(r['sync_delta_ms']) <= SYNC_TOLERANCE_MS
        rows.append(r)
    reuse_bytes = all(ar.sha256_file(c) == ar.sha256_file(t) for c, t in zip(copies, base_takes) if t is not None)
    cand_p, snd_p = ar.packets(cand), ar.packets(snd['final'])
    res = {'golden': golden['audio'], 'policy': ('whole soundtrack re-mixed once through assemble\'s 4-generation AAC chain; unchanged take '
                                                 'FILES fed byte-for-byte; new takes at their re-timed slots'),
           'candidate_audio_stream_copied': cand_p == snd_p, 'chain_audio_equals_soundtrack': ar.packets(chain_final) == snd_p,
           'unchanged_takes_reused_byte_for_byte': reuse_bytes, 'takes': rows, 'takes_at_expected_offsets': at_off, 'av_sync_preserved': sync,
           'input_take_sha256': {f'slide-{j + 1:02d}': (ar.sha256_file(t) if t else None) for j, t in enumerate(new_takes)},
           'prefix_vs_baseline': ar.common_prefix(final, cand), 'candidate': ar.audio_evidence(cand), 'baseline': ar.audio_evidence(final)}
    res['ok'] = bool(golden['audio']['packets_equal'] and res['candidate_audio_stream_copied'] and res['chain_audio_equals_soundtrack']
                     and reuse_bytes and at_off and sync)
    return res


# ---------- real pilot (local, read-only on the repo) ----------

PILOT = 'How-to-Find-a-Project-ID'
LONGER_03 = 'And here we are on the project page. The unique project ID is shown in the page header, ready to copy.'
SHORTER_02 = 'Open the project.'
BANNER_BOX = (760, 440, 1180, 520)


def _stable_copy(script, name):
    stable = json.loads(json.dumps(script))
    stable.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}')))
    for st in stable['steps']:
        st.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}:step:{st["index"]}')))
    return stable


TRANSCRIBE = r'''
import json, sys
from faster_whisper import WhisperModel
m = WhisperModel(sys.argv[2], device='cpu', compute_type='int8')
segs, info = m.transcribe(sys.argv[1], language='en', word_timestamps=True, beam_size=5, vad_filter=False)
print(json.dumps([{'start': s.start, 'end': s.end, 'text': s.text, 'words': [{'w': w.word, 's': w.start, 'e': w.end} for w in (s.words or [])]} for s in segs]))
'''


def transcribe(media, workdir, model='small.en', python=WHISPER_PY):
    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    wav = wd / f'{Path(media).stem}-16k.wav'
    fx_draw.sh('ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', media, '-vn', '-ac', '1', '-ar', '16000', wav)
    env = {**os.environ, 'HF_HUB_OFFLINE': '1'}
    res = subprocess.run([str(python), '-c', TRANSCRIBE, str(wav), model], capture_output=True, text=True, timeout=900, env=env)
    if res.returncode != 0:
        raise RuntimeError('transcription_failed: ' + (res.stderr or '').strip()[-300:])
    segs = json.loads(res.stdout.strip().splitlines()[-1])
    (wd / f'{Path(media).stem}.transcript.json').write_text(json.dumps(segs, indent=1) + '\n')
    return segs


def _tokens(text):
    import re
    return [t for t in re.findall(r"[a-z0-9]+", text.lower().replace("'", '')) if t]


def transcript_check(segs, lines):
    """lines: [(slide_id, expected_text, start_s, end_s)] -> per-line word recall inside its time window."""
    words = [(w['s'], w['e'], _tokens(w['w'])) for s in segs for w in s['words']]
    out = {}
    for sid, text, a, b in lines:
        got = [t for s, e, ts in words if e >= a and s <= b for t in ts]
        exp = _tokens(text)
        pool = list(got)
        hit = 0
        for t in exp:
            if t in pool:
                pool.remove(t)
                hit += 1
        out[sid] = {'expected': text, 'heard': ' '.join(got), 'window_s': [round(a, 3), round(b, 3)],
                    'recall': round(hit / max(1, len(exp)), 3)}
    return out


def _banner_check(drawer, entry, start_frame, c0, hold, cand, final, box, cand_seg=None, orig_png=None, probe=None, rf=None):
    """Banner visible where (and only where) it was added. Primary evidence: the candidate's OWN segment vs a CONTROL
    segment rendered from the same new plan with the ORIGINAL screenshot (isolates the screenshot change even when the
    slide was re-timed/re-planned). Secondary: candidate vs baseline at mid-hold (meaningful only if the plan is unchanged)."""
    import numpy as np

    def diff(a, b, bx, exclude_band):
        x = np.abs(np.asarray(a.convert('L'), dtype=np.int16) - np.asarray(b.convert('L'), dtype=np.int16)).astype(float)
        m = np.zeros_like(x, dtype=bool)
        x0, y0, x1, y1 = max(0, bx[0] - 24), max(0, bx[1] - 24), min(1920, bx[2] + 24), min(1080, bx[3] + 24)
        m[y0:y1, x0:x1] = True
        rest = ~m
        if exclude_band:
            rest[780:, :] = False
        return {'box': [x0, y0, x1, y1], 'inside_mean': round(float(x[m].mean()), 3), 'outside_mean': round(float(x[rest].mean()), 3),
                'outside_max': int(x[rest].max())}
    F = (hold['new'][0] + hold['new'][1]) // 2
    Fb = (hold['base'][0] + hold['base'][1]) // 2
    lf = F - c0 - start_frame
    bx = drift_render.project_box(drawer, entry, lf, list(box))
    res = {'frame_candidate': F, 'frame_baseline': Fb, 'local_frame': lf, 'banner_box_out_px': bx,
           'candidate_vs_baseline_excl_caption_band': diff(drift_render.grab(cand, F), drift_render.grab(final, Fb), bx, True)}
    if cand_seg is not None:
        d = fx_draw.load(out_dir=probe / 'out', tmp_dir=probe / 'out' / '_build', needs_drawn_highlight=True, font_layout=drawer.font_layout)
        (probe / 'out' / 'slides').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(orig_png, probe / 'out' / 'slides' / entry['file'])
        ctrl = probe / f"control-seg{entry['slide']:02d}.mp4"
        fx_draw.render_segment(d, json.loads(json.dumps(entry)), ctrl, caption_pos=(rf or {}).get('caption_pos'),
                               no_captions=bool((rf or {}).get('no_captions')))
        rows = []
        for f in (12, lf, int(round(entry['sdur'] * 30)) - 12):
            r = diff(drift_render.grab(cand_seg, f), drift_render.grab(ctrl, f), drift_render.project_box(drawer, entry, f, list(box)), False)
            rows.append({'segment_frame': f, **r})
        res['candidate_segment_vs_control_segment'] = rows
        res['ok'] = all(r['inside_mean'] > 20 and r['outside_mean'] < 0.5 for r in rows)
        res['rule'] = 'inside the camera-projected banner box mean grey diff > 20, outside < 0.5 (candidate vs original-screenshot control, same new plan)'
    else:
        c = res['candidate_vs_baseline_excl_caption_band']
        res['ok'] = c['inside_mean'] > 20 and c['outside_mean'] < 1.5
    return res


def real_pilot(rebaseline_dir, output, case='a', name=PILOT, take_mode='elevenlabs', do_transcribe=True):
    """Real pilot, local only. a: slide-01 banner + slide-03 longer narration (two dirty runs, last-slide narration);
    b: slide-02 banner + shorter narration (same step; screen re-plan); golden: re-apply the baseline's own slide-01
    screenshot, slide-02 target and slide-03 narration+take; noop: empty manifest."""
    out = drift_render.new_dir(output)
    script_path = REPO / 'scripts' / f'{name}.script.json'
    pilot = REPO / 'out' / name
    script = json.loads(script_path.read_bytes())
    rec_src = REPO / 'out' / '_recordings' / script['recording']['id']
    assembly = json.loads((pilot / 'assembly.json').read_bytes())
    report = json.loads((pilot / 'report.json').read_bytes())
    real = sorted({script_path, fx_draw.ASSEMBLE, tp.TTS, REPO / 'assets' / 'music_upbeat.wav', *(p for p in rec_src.iterdir() if p.is_file()),
                   *(p for d in (pilot, pilot / 'slides', pilot / 'annotated', pilot / '_build') for p in d.iterdir() if p.is_file()),
                   *(Path(s['audio']) for s in assembly['slides'] if s.get('audio'))})
    before = fx_draw.snapshot(real)
    src = out / 'source'
    recd = src / '_recordings' / script['recording']['id']
    recd.mkdir(parents=True)
    for p in rec_src.iterdir():
        if p.is_file():
            shutil.copyfile(p, recd / p.name)
    stable = _stable_copy(script, name)
    base_path = src / 'stable-base.script.json'
    base_path.write_text(json.dumps(stable, indent=2, ensure_ascii=False) + '\n')
    steps = stable['steps']
    _, manifest_path, m, _, final = drift_render.load_rebaseline(rebaseline_dir)
    changes, banners = [], {}
    if case in ('a', 'b'):
        i = 0 if case == 'a' else 1
        label = 'NEW: Archived projects' if case == 'a' else 'NEW: Export project IDs'
        png = drift_render.drift_banner(recd / steps[i]['media']['pre'], src / f'slide-{i + 1:02d}-banner.png', BANNER_BOX, label)
        banners[i] = BANNER_BOX
        ch = {'stepId': steps[i]['id'], 'screenshot': {'path': str(png), 'sha256': ar.sha256_file(png)}}
        if case == 'a':
            changes = [ch, {'stepId': steps[2]['id'], 'narration': {'oldText': steps[2]['narration'], 'newText': LONGER_03}}]
        else:
            ch['narration'] = {'oldText': steps[1]['narration'], 'newText': SHORTER_02}
            changes = [ch]
    elif case == 'golden':
        t3 = Path(assembly['slides'][2]['audio'])
        o1 = recd / steps[0]['media']['pre']
        changes = [{'stepId': steps[0]['id'], 'screenshot': {'path': str(o1), 'sha256': ar.sha256_file(o1)}},
                   {'stepId': steps[1]['id'], 'target': steps[1]['target']},
                   {'stepId': steps[2]['id'], 'narration': {'oldText': steps[2]['narration'], 'newText': steps[2]['narration'],
                                                            'take': {'path': str(t3), 'sha256': ar.sha256_file(t3), 'source': 'baseline take (re-applied)'}}}]
    elif case != 'noop':
        raise ValueError(f'unknown case {case}')
    mpath = src / 'change-manifest.json'
    mpath.write_text(json.dumps({'baselineManifestHash': ar.sha256_file(manifest_path), 'changes': changes}, indent=2, ensure_ascii=False) + '\n')
    flags = {k: v for k, v in report.items() if k in fx_draw.REPORT_FIELDS}
    provider = tp.provider(take_mode, allow_standin=take_mode == 'standin')
    rep = run(rebaseline_dir, base_path, recd, mpath, pilot / '_build', out / 'update', take_provider=provider, report_fields=flags,
              baseline_voice_check=take_mode == 'elevenlabs')
    summary = {'case': case, 'ok': bool(rep['ok']), 'candidate': rep['candidate'], 'candidate_sha256': rep['candidate_sha256'],
               'verification': str(out / 'update' / 'verification.json')}
    if not rep.get('noop'):
        new = json.loads(Path(rep['candidate_assembly']).read_bytes())
        d = fx_draw.load(out_dir=out / 'probe', tmp_dir=out / 'probe' / '_build', needs_drawn_highlight=True)
        c0 = fx_scope.timeline(assembly, m['frameCount'])['content_start_frame']
        bchecks = {}
        for i, box in banners.items():
            hold = next(c for c in rep['plan']['cell_map'] if c['id'] == f'hold-{i + 1:02d}')
            entry = fx_draw.frozen_slide(new['slides'][i])
            seg = Path(rep['output']) / 'work' / 'out' / '_build' / f"seg{entry['slide']:02d}.mp4"
            bchecks[f'slide-{i + 1:02d}'] = _banner_check(d, entry, retime.frame_of(new['slides'][i]['start']), c0, hold, Path(rep['candidate']),
                                                          final, box, cand_seg=seg, orig_png=recd / steps[i]['media']['pre'],
                                                          probe=out / f'banner-probe-{i + 1:02d}', rf=flags)
        tr = None
        if do_transcribe and rep.get('audio'):
            segs = transcribe(rep['candidate'], out / 'transcript')
            lines = []
            for x in rep['audio']['takes']:
                s = new['slides'][x['slide'] - 1]
                lines.append((f"slide-{x['slide']:02d}", s['narration'], x['position_s'] - 0.3, x['position_s'] + s['adur'] + 0.6))
            tr = {'model': 'faster-whisper small.en (int8, cpu, offline)', 'lines': transcript_check(segs, lines),
                  'text': ' '.join(s['text'].strip() for s in segs)}
            old_lines = [(f'OLD slide-{k + 1:02d}', assembly['slides'][k]['narration']) for k in range(len(assembly['slides']))
                         if assembly['slides'][k]['narration'] != new['slides'][k]['narration']]
            heard = {t for s in segs for w in s['words'] for t in _tokens(w['w'])}
            current = {t for s in new['slides'] for t in _tokens(s.get('narration') or '')}
            tr['replaced_lines'] = {sid: {'old': txt, 'distinguishing_words': sorted(set(_tokens(txt)) - current),
                                          'distinguishing_words_heard': sorted((set(_tokens(txt)) - current) & heard)} for sid, txt in old_lines}
            tr['ok'] = (all(v['recall'] >= 0.8 for v in tr['lines'].values())
                        and not any(v['distinguishing_words_heard'] for v in tr['replaced_lines'].values()))
        summary.update(plan={k: rep['plan'][k] for k in ('changed_steps', 'dirty_slides', 'dirty_runs', 'reasons', 'shift_frames', 'quantize',
                                                         'rendered_cells', 'reused_cells', 'edges', 'frames', 'sdurs')},
                       takes=rep['takes'], elevenlabs_characters=rep['elevenlabs_characters'], voice_check=rep['voice_check'],
                       golden={k: v for k, v in rep['golden'].items()}, golden_reapply=rep['golden_reapply'],
                       checks={k: rep['checks'][k] for k in ('frames_total', 'expected_frames', 'decodable', 'timestamps_contiguous',
                                                             'keyframes_at_cell_starts', 'reused_cells_byte_identical',
                                                             'reused_frames_equal_at_shifted_positions', 'captions',
                                                             'rendered_frames_differing_from_baseline_overlap')},
                       preservation=rep['checks'].get('preservation'),
                       audio=({k: rep['audio'][k] for k in ('ok', 'takes_at_expected_offsets', 'av_sync_preserved', 'candidate_audio_stream_copied',
                                                            'chain_audio_equals_soundtrack', 'unchanged_takes_reused_byte_for_byte', 'takes',
                                                            'prefix_vs_baseline')} if rep['audio'] else None),
                       banners=bchecks, transcript=tr, contact_sheet=rep['contact_sheet'])
        summary['ok'] = bool(summary['ok'] and all(v['ok'] for v in bchecks.values()) and (tr is None or tr['ok']))
    else:
        summary.update(noop=True, candidate_is_baseline=rep['candidate_sha256'] == m['final']['sha256'])
        summary['ok'] = bool(summary['ok'] and summary['candidate_is_baseline'])
    after = fx_draw.snapshot(real)
    summary['source_unchanged'] = before == after and rep.get('source_unchanged', True)
    summary['source_files_snapshotted'] = len(real)
    summary['ok'] = bool(summary['ok'] and summary['source_unchanged'])
    (out / 'end-to-end.json').write_text(json.dumps(summary, indent=2, default=str) + '\n')
    return summary


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--rebaseline-dir', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--real-pilot', choices=('a', 'b', 'golden', 'noop'))
    p.add_argument('--script')
    p.add_argument('--recordings-dir', help='directory holding the script media.pre captures (named after recording.id; read-only)')
    p.add_argument('--changes', help='approved change manifest JSON')
    p.add_argument('--build-dir', help="the baseline's real out/<name>/_build (read-only)")
    p.add_argument('--music', default=str(REPO / 'assets' / 'music_upbeat.wav'))
    p.add_argument('--report', help='out/<name>/report.json (caption_pos/no_captions flags only)')
    p.add_argument('--font-layout', default='basic', choices=fx_draw.FONT_LAYOUTS)
    p.add_argument('--take-mode', default='elevenlabs', choices=('elevenlabs', 'manifest', 'standin'))
    p.add_argument('--allow-standin', action='store_true', help='TESTS ONLY: allow the macOS say stand-in take')
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args(argv)
    try:
        if a.real_pilot:
            r = real_pilot(a.rebaseline_dir, a.output, case=a.real_pilot, take_mode=a.take_mode)
            print(json.dumps({k: r.get(k) for k in ('case', 'ok', 'candidate', 'candidate_sha256', 'verification')}, indent=2))
            return 0 if r['ok'] else 1
        if not (a.script and a.recordings_dir and a.changes and a.build_dir):
            p.error('--script, --recordings-dir, --changes and --build-dir are required')
        provider = None
        if a.take_mode == 'elevenlabs':
            provider = tp.provider('elevenlabs')
        elif a.take_mode == 'standin':
            provider = tp.provider('standin', allow_standin=a.allow_standin)
        flags = {}
        if a.report:
            flags = {k: v for k, v in json.loads(Path(a.report).read_bytes()).items() if k in fx_draw.REPORT_FIELDS}
        r = run(a.rebaseline_dir, a.script, a.recordings_dir, a.changes, a.build_dir, a.output, music=a.music, take_provider=provider,
                font_layout=a.font_layout, report_fields=flags, dry_run=a.dry_run, baseline_voice_check=a.take_mode == 'elevenlabs')
    except (UpdateRejected, tp.TakeRejected) as e:
        print(json.dumps({'ok': False, 'rejected': e.code, 'detail': e.detail}, default=str))
        return 2
    print(json.dumps({k: r.get(k) for k in ('ok', 'output', 'candidate', 'candidate_sha256', 'dry_run', 'noop')}, indent=2))
    return 0 if r['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
