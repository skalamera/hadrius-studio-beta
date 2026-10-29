"""LOCAL changed-narration + timing-shift update of ONE interior slide on a one-time rebaseline.

    TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.narration_update \\
        --rebaseline-dir $TMPDIR/<rebaseline> --script <stable-ID script copy> --recordings-dir <captures dir> \\
        --narration-manifest <approved change JSON> --build-dir out/<name>/_build --output $TMPDIR/NEW-directory

Approved narration manifest (trusted LOCAL input, not authenticated approval; tools/drift/candidate.mjs rejects
narration edits by design, so the narration change travels separately):
    {"baselineManifestHash": "<sha256 of baseline-manifest.json>",
     "changes": [{"stepId": "...", "oldText": "<current narration>", "newText": "...", "newTakePath": "/abs/take.mp3",
                  "newTakeSha256": "...", "newCaption": "(optional)", "takeSource": "(free text label)"}]}

Pipeline: validate (oldText == script == assembly narration, take hash, interior slide) -> audio golden (re-mix the
UNCHANGED soundtrack and require packet-identity with the baseline) -> retime (renderer.retime: whole-frame shift,
frozen camera views, caption position re-decided by assemble's own cam_caption_top) -> render only the changed
slide's dissolve-in/hold/dissolve-out through assemble's frozen drawing code -> copy every other cell byte-for-byte
at its shifted position -> re-mix the soundtrack once (unchanged takes reused byte-for-byte) -> mux -> verify.
No paid TTS, network, bridge, Drive/Pylon or publishing; real inputs are read-only and snapshotted.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from . import audio_rebuild as ar, drift_render, fx_draw, fx_scope, rebaseline, retime

REPO = Path(__file__).resolve().parent.parent
STANDIN_LABEL = 'LOCAL STAND-IN take (macOS `say`), NOT the provider voice; for local verification only'
MANIFEST_KEYS = {'baselineManifestHash', 'changes'}
CHANGE_KEYS = {'stepId', 'oldText', 'newText', 'newTakePath', 'newTakeSha256'}
CHANGE_OPTIONAL = {'newCaption', 'takeSource', 'audioFilter'}


class NarrationRejected(ValueError):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def make_standin_take(text, output, voice=None):
    """macOS `say` -> AIFF -> mp3 44.1 kHz mono 128k (the cached ElevenLabs take profile). Clearly a stand-in."""
    out = Path(output)
    aiff = out.with_suffix('.aiff')
    cmd = ['say', '-o', str(aiff)] + (['-v', voice] if voice else []) + [text]
    subprocess.check_call(cmd, timeout=120)
    ar.sh('ffmpeg', '-nostdin', '-v', 'error', '-i', aiff, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', out)
    aiff.unlink()
    info = {'label': STANDIN_LABEL, 'text': text, 'voice': voice or 'system default', 'path': str(out), 'sha256': ar.sha256_file(out),
            'duration': ar.ffprobe_duration(out), 'profile': 'mp3 44100 Hz mono 128 kb/s (libmp3lame)'}
    out.with_suffix('.standin.json').write_text(json.dumps(info, indent=2) + '\n')
    return info


def _load_manifest(path, baseline_manifest):
    nm = json.loads(Path(path).read_bytes())
    if not isinstance(nm, dict) or set(nm) != MANIFEST_KEYS or not isinstance(nm['changes'], list):
        raise NarrationRejected('invalid_narration_manifest')
    if nm['baselineManifestHash'] != ar.sha256_file(baseline_manifest):
        raise NarrationRejected('baseline_manifest_conflict')
    if len(nm['changes']) != 1:
        raise NarrationRejected('unsupported_multiple_changes', len(nm['changes']))
    ch = nm['changes'][0]
    if not isinstance(ch, dict) or not CHANGE_KEYS <= set(ch) or set(ch) - CHANGE_KEYS - CHANGE_OPTIONAL:
        raise NarrationRejected('invalid_narration_manifest')
    if any(not isinstance(ch[x], str) for x in CHANGE_KEYS):
        raise NarrationRejected('invalid_narration_manifest')
    return nm, ch


def validate(assembly, script, ch):
    """All checks that need no rendering. Returns (k, step, new caption)."""
    ids = [st.get('id') for st in script['steps']]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise NarrationRejected('script_needs_stable_step_ids')
    if ch['stepId'] not in ids:
        raise NarrationRejected('unknown_step')
    caps = drift_render._captured(script)
    slides = assembly['slides']
    if len(caps) != len(slides):
        raise NarrationRejected('assembly_script_mismatch')
    cfn = bool(script.get('captionsFromNarration'))
    for st, s in zip(caps, slides):
        if s.get('step') != st['index'] or s.get('src') != st['media']['pre']:
            raise NarrationRejected('assembly_script_mismatch', s['slide'])
        cap = ((st.get('narration') if cfn else st.get('caption')) or st.get('narration') or '')
        if (st.get('narration') or '') != (s.get('narration') or '') or cap != (s.get('caption') or ''):
            raise NarrationRejected('script_not_baseline', s['slide'])
    k = next((i for i, st in enumerate(caps) if st['id'] == ch['stepId']), None)
    if k is None:
        raise NarrationRejected('unknown_step', 'not a captured slide')
    step = caps[k]
    if ch['oldText'] != (step.get('narration') or '') or ch['oldText'] != (slides[k].get('narration') or ''):
        raise NarrationRejected('old_text_mismatch')
    if ch['newText'] == ch['oldText']:
        raise NarrationRejected('no_narration_change')
    if not ch['newText'].strip():
        raise NarrationRejected('unsupported_narration_removal')
    if not 0 < k < len(slides) - 1:
        raise NarrationRejected('unsupported_edge_slide')
    if 'newCaption' in ch:
        caption = ch['newCaption']
    elif cfn or (step.get('caption') or '') in ('', ch['oldText']):
        caption = ch['newText']  # the caption mirrored the narration: it follows it
    else:
        caption = step.get('caption')  # an independent caption stays
    take = Path(ch['newTakePath'])
    if not take.is_absolute() or not take.is_file() or take.is_symlink():
        raise NarrationRejected('missing_take')
    if ar.sha256_file(take) != ch['newTakeSha256']:
        raise NarrationRejected('take_hash_mismatch')
    try:
        info = ar.stream_info(take)
    except (subprocess.CalledProcessError, IndexError, KeyError):
        raise NarrationRejected('invalid_take') from None
    return k, step, caption, info


def _caption_band(img):
    return img.crop((0, 780, 1920, 1080))


def _band_diff(a, b):
    import numpy as np
    x = np.asarray(_caption_band(a).convert('L'), dtype=np.int16)
    y = np.asarray(_caption_band(b).convert('L'), dtype=np.int16)
    return round(float(np.abs(x - y).mean()), 3)


def contact_sheet(rows, output):
    """rows: [(label, baseline_path, baseline_idx|None, candidate_path, candidate_idx)] -> labelled 2-column JPEG."""
    from PIL import Image, ImageDraw
    tw, th = 640, 360
    sheet = Image.new('RGB', (tw * 2 + 200, (th + 8) * len(rows) + 36), 'white')
    d = ImageDraw.Draw(sheet)
    d.text((200 + 6, 10), 'baseline (rebaseline)', fill='black')
    d.text((200 + tw + 6, 10), 'candidate (new narration + retimed)', fill='black')
    for r, (label, bp, bi, cp, ci) in enumerate(rows):
        y = 36 + r * (th + 8)
        d.text((4, y + 4), f'{label}\nbase {bi}\ncand {ci}', fill='black')
        for j, (p, i) in enumerate(((bp, bi), (cp, ci))):
            if i is None:
                continue
            sheet.paste(drift_render.grab(p, i).resize((tw, th)), (200 + j * tw, y))
    sheet.save(output, quality=88)


def run(rebaseline_dir, script_path, recordings_dir, narration_manifest, build_dir, music, output, golden_build_dir=None,
        font_layout='basic', report_flags=None):
    pins = ar.assemble_audio_pins()
    retime.check_source_pins()
    rdir, manifest_path, m, assembly, final = drift_render.load_rebaseline(rebaseline_dir)
    nm, ch = _load_manifest(narration_manifest, manifest_path)
    script = json.loads(Path(script_path).read_bytes())
    k, step, caption, take_info = validate(assembly, script, ch)
    cards = ar.card_clips(build_dir, assembly)
    slides = assembly['slides']
    takes = [Path(s['audio']) if s.get('audio') else None for s in slides]
    if any(t is not None and (not t.is_file() or t.is_symlink()) for t in takes):
        raise NarrationRejected('baseline_take_missing')
    new_take = Path(ch['newTakePath'])
    new_adur = ar.ffprobe_duration(new_take)
    rep_flags = dict(report_flags or {})
    if rep_flags.get('caption_pos') or rep_flags.get('no_captions'):
        raise NarrationRejected('unsupported_report_caption_flags')
    # pure planning BEFORE any output exists (rejections write nothing)
    try:
        pre = retime.plan_retime(assembly, k, new_adur, ch['newText'], caption, base_total_frames=m['frameCount'])
    except retime.RetimeRejected as e:
        raise NarrationRejected(e.code, e.detail) from None
    out = drift_render.new_dir(output)
    rec = Path(recordings_dir)
    real = sorted({Path(p) for p in [script_path, narration_manifest, music, fx_draw.ASSEMBLE, new_take, *[t for t in takes if t], *cards.values(),
                                     *(rec / st['media']['pre'] for st in drift_render._captured(script)),
                                     manifest_path, final, rdir / m['assembly']['file'], *(rdir / c['file'] for c in m['cells'])]}
                  | ({p for p in Path(golden_build_dir).iterdir() if p.is_file()} if golden_build_dir else set()))
    before = fx_draw.snapshot(real)
    # 1. inputs copied into the output (takes reused byte-for-byte from these copies)
    inp = out / 'inputs'
    (inp / 'takes').mkdir(parents=True)
    copies = []
    for s, t in zip(slides, takes):
        if t is None:
            copies.append(None)
            continue
        dst = inp / 'takes' / f"slide-{s['slide']:02d}-{t.name}"
        shutil.copyfile(t, dst)
        copies.append(dst)
    new_copy = inp / 'takes' / f"slide-{slides[k]['slide']:02d}-NEW-{new_take.name}"
    shutil.copyfile(new_take, new_copy)
    card_copies = {}
    for key, p in cards.items():
        card_copies[key] = inp / f'card-{key}-{p.name}'
        shutil.copyfile(p, card_copies[key])
    music_copy = inp / Path(music).name
    shutil.copyfile(music, music_copy)
    filters = [s.get('audio_filter') or '' for s in slides]
    # 2. audio golden: the UNCHANGED soundtrack must re-mix packet-identically to the baseline audio
    g = ar.rebuild_soundtrack(copies, [s['sdur'] for s in slides], music_copy, card_copies, out / 'audio' / 'golden', filters)
    golden = {'final': {'packets_equal': ar.packets(g['final']) == ar.packets(final), 'pcm': ar.compare_pcm(final, g['final'])},
              'schedule_starts_equal_assembly': [x['start'] for x in g['schedule']['slides']] == [s['start'] for s in slides],
              'generations': g['generations']}
    base_loc = ar.locate_takes(final, copies, filters, g['schedule'], g['content_origin'], out / 'audio')
    golden['take_calibration'] = base_loc
    if not golden['final']['packets_equal']:
        (out / 'verification.json').write_text(json.dumps({'ok': False, 'rejected': 'audio_golden_mismatch', 'golden': golden}, indent=2, default=str))
        raise NarrationRejected('audio_golden_mismatch', golden['final']['pcm'])
    # 3. drawer + fitted captures (drift_render's checks with the UNCHANGED script: geometry, screens, fx_scope)
    work = out / 'work'
    try:
        donor = drift_render.plan_donor(assembly, script, script, ch['stepId'], rec, m['frameCount'], work, font_layout=font_layout)
    except drift_render.DonorRejected as e:
        raise NarrationRejected(e.code, e.detail) from None
    drawer = donor['drawer']
    cap_top_fn, cap_top_src = retime.load_caption_top(drawer, rep_flags)
    cap_gold = [bool(cap_top_fn(fx_draw.frozen_slide(s))) for s in slides]
    if retime.caption_runs([s['_cap_text'] for s in slides], cap_gold) != [s['_cap_top'] for s in slides]:
        raise NarrationRejected('caption_top_port_mismatch', cap_gold)
    # 4. retime with the new caption position decided by assemble's own rule on the new plan
    new_ct = bool(cap_top_fn(fx_draw.frozen_slide(pre['assembly']['slides'][k])))
    try:
        plan = retime.plan_retime(assembly, k, new_adur, ch['newText'], caption, cap_top=new_ct, audio=new_copy,
                                  audio_filter=ch.get('audioFilter', filters[k]), base_total_frames=m['frameCount'])
    except retime.RetimeRejected as e:
        raise NarrationRejected(e.code, e.detail) from None
    new_asm = plan['assembly']
    base_tl = fx_scope.timeline(assembly, m['frameCount'])
    if [c['id'] for c in base_tl['cells']] != [c['id'] for c in m['cells']]:
        raise NarrationRejected('baseline_cells_mismatch')
    tl = retime.timeline_for(new_asm, plan['total_frames'], plan)
    cmap = retime.map_cells(m['cells'], tl['cells'], plan['dirty_slides'])
    views = retime.protected_views_equal(drawer, assembly, new_asm, cmap)
    if not views['ok']:
        raise NarrationRejected('scope_expansion_required:protected_camera_changed', views['mismatches'][:3])
    deviation = retime.replan_drift_deviation(drawer, assembly, plan)
    # 5. render the dirty cells on the new timeline
    rend = retime.render_cells(drawer, new_asm, plan, cmap, tl, out / 'render', caption_pos=rep_flags.get('caption_pos'))
    neighbours = {}
    if golden_build_dir:
        for j in (k - 1, k + 1):
            s_new, s_old = new_asm['slides'][j], slides[j]
            seg = rend['segments'][s_new['file']]['path']
            same_plan = retime._canon(fx_draw.frozen_slide(s_new)) == retime._canon(fx_draw.frozen_slide(s_old))
            gold = Path(golden_build_dir) / f"seg{s_new['slide']:02d}.mp4"
            neighbours[fx_scope.slide_id(s_new)] = {'plan_unchanged': same_plan, 'golden': str(gold),
                                                    'decoded_frames_equal': (fx_draw.framehashes(seg) == fx_draw.framehashes(gold)) if same_plan else None}
            if same_plan and not neighbours[fx_scope.slide_id(s_new)]['decoded_frames_equal']:
                raise NarrationRejected('neighbour_render_mismatch', fx_scope.slide_id(s_new))
    # 6. ordered cells: reused bytes copied from the rebaseline, rendered cells from the donor
    cdir = out / 'cells'
    cdir.mkdir()
    base_cells = {c['id']: c for c in m['cells']}
    sig0 = rebaseline.cell_signature(rdir / m['cells'][0]['file'], m['cells'][0]['endFrame'] - m['cells'][0]['startFrame'])
    ordered, reused, rendered = [], {}, {}
    for c in cmap:
        dst = cdir / f"cell-{c['id']}.mp4"
        if c['action'] == 'reuse':
            src = rdir / base_cells[c['id']]['file']
            shutil.copyfile(src, dst)
            reused[c['id']] = {'base': c['base'], 'new': c['new'], 'sha256': ar.sha256_file(dst),
                               'byte_identical': ar.sha256_file(dst) == base_cells[c['id']]['sha256']}
        else:
            shutil.copyfile(rend['cells'][c['id']]['file'], dst)
            if rend['cells'][c['id']]['signature'] != sig0:
                raise NarrationRejected('incompatible_replacement', c['id'])
            rendered[c['id']] = {'base': c['base'], 'new': c['new'], 'sha256': ar.sha256_file(dst)}
        ordered.append(dst)
    video = out / 'candidate-video.mp4'
    rebaseline.concat(ordered, video)
    # 7. soundtrack re-mix: unchanged takes byte-for-byte, new take at its retimed slot, same music + cards
    new_takes = list(copies)
    new_takes[k] = new_copy
    new_filters = list(filters)
    new_filters[k] = ch.get('audioFilter', filters[k])
    snd = ar.rebuild_soundtrack(new_takes, plan['sdurs'], music_copy, card_copies, out / 'audio' / 'candidate', new_filters)
    cand = out / 'candidate.mp4'
    rebaseline.mux(video, snd['final'], cand)
    # 8. verification
    cf, bf = fx_draw.framehashes(cand), fx_draw.framehashes(final)
    timing = rebaseline.native_timing(cand)
    ticks = rebaseline.TICKS
    ts_ok = [int(x['pts']) for x in timing] == [i * ticks for i in range(len(timing))] and all(int(x['duration']) == ticks for x in timing)
    keys = [i for i, x in enumerate(timing) if int(x['key_frame']) == 1]
    reused_frames_ok = all(cf[c['new'][0]:c['new'][1]] == bf[c['base'][0]:c['base'][1]] for c in cmap if c['action'] == 'reuse')
    changed_in_rendered = {cid: sum(1 for i in range(*v['new']) if i - v['new'][0] < v['base'][1] - v['base'][0]
                                     and cf[i] != bf[v['base'][0] + i - v['new'][0]]) for cid, v in rendered.items()}
    # captions
    from PIL import Image
    ref_dir = out / 'caption-ref'
    ref_dir.mkdir()
    drawer.ns['caption_png'](caption or ch['newText'], ref_dir / 'cap-new.png', pos='center')
    cap_k = drawer.ns['tmp'] / f"cap{slides[k]['slide']:02d}.png"
    cap_checks = {'changed_caption_png_matches_new_text': cap_k.read_bytes() == (ref_dir / 'cap-new.png').read_bytes()}
    if golden_build_dir:
        for j in (k - 1, k + 1):
            nm_ = f"cap{slides[j]['slide']:02d}.png"
            cap_checks[f'{nm_}_equals_golden'] = (drawer.ns['tmp'] / nm_).read_bytes() == (Path(golden_build_dir) / nm_).read_bytes()
    hold = next(c for c in cmap if c['id'] == f"hold-{slides[k]['slide']:02d}")
    mid_new = (hold['new'][0] + hold['new'][1]) // 2
    mid_base = (hold['base'][0] + hold['base'][1]) // 2
    sub_frame = mid_new - rend['subchain_origin_frame']
    a_c, a_b = drift_render.grab(cand, mid_new), drift_render.grab(final, mid_base)
    a_s = drift_render.grab(rend['subchain'], sub_frame)
    cap_checks.update(changed_slide_caption_band_mean_diff_vs_baseline=_band_diff(a_c, a_b),
                      changed_slide_caption_band_mean_diff_vs_lossless_donor=_band_diff(a_c, a_s))
    cap_checks['changed_slide_caption_band_differs'] = (cap_checks['changed_slide_caption_band_mean_diff_vs_baseline'] > 2.0
                                                        and cap_checks['changed_slide_caption_band_mean_diff_vs_lossless_donor'] < 1.0)
    cap_checks['other_captions_unchanged'] = all(retime._canon([s.get('caption'), s.get('narration'), s.get('_cap_text'), s.get('_cap_top')])
                                                 == retime._canon([o.get('caption'), o.get('narration'), o.get('_cap_text'), o.get('_cap_top')])
                                                 for i, (s, o) in enumerate(zip(new_asm['slides'], slides)) if i != k)
    # audio
    cand_packets, snd_packets = ar.packets(cand), ar.packets(snd['final'])
    loc = ar.locate_takes(cand, new_takes, new_filters, snd['schedule'], snd['content_origin'], out / 'audio')
    cal = sorted(x['lag_samples'] for x in base_loc)[len(base_loc) // 2]
    c0 = tl['content_start_frame']
    takes_report, at_offsets, sync_ok = [], True, True
    for x in loc:
        j = x['slide'] - 1
        b = next((y for y in base_loc if y['slide'] == x['slide']), None)
        v_new = (c0 + plan['frames'][j]) / 30
        v_old = (c0 + plan['base_frames'][j]) / 30
        r = {**x, 'role': 'NEW stand-in take' if j == k else 'unchanged take (byte-identical input)',
             'baseline_lag_samples': b['lag_samples'] if b else None, 'calibration_lag_samples': cal,
             'video_slide_start_s': round(v_new, 6), 'audio_minus_video_s': round(x['position_s'] - v_new, 6),
             'baseline_audio_minus_video_s': round(b['position_s'] - v_old, 6) if b else None}
        ref_lag = b['lag_samples'] if (b and j != k) else cal
        r['lag_ok'] = abs(x['lag_samples'] - ref_lag) <= 2 and x['peak'] > 0.6
        at_offsets &= r['lag_ok']
        if b and j != k:
            r['sync_delta_ms'] = round((r['audio_minus_video_s'] - r['baseline_audio_minus_video_s']) * 1000, 3)
            sync_ok &= abs(r['sync_delta_ms']) <= 1.5
        takes_report.append(r)
    reuse_bytes = all(ar.sha256_file(c) == ar.sha256_file(t) for c, t in zip(copies, takes) if t is not None)
    audio = {'golden': golden, 'policy': ('whole soundtrack re-mixed and re-encoded through assemble\'s 4-generation AAC chain '
                                          '(content -> lead/support/outro crossfades); unchanged take FILES are fed byte-for-byte'),
             'candidate_audio_stream_copied': cand_packets == snd_packets, 'unchanged_takes_reused_byte_for_byte': reuse_bytes,
             'input_take_sha256': {f'slide-{j + 1:02d}': (ar.sha256_file(t) if t else None) for j, t in enumerate(new_takes)},
             'takes': takes_report, 'takes_at_expected_offsets': at_offsets, 'av_sync_preserved': sync_ok,
             'prefix_vs_baseline': ar.common_prefix(final, cand), 'candidate': ar.audio_evidence(cand),
             'baseline': ar.audio_evidence(final), 'music_sha256': ar.sha256_file(music_copy), 'new_take': {**take_info, 'adur': new_adur,
                                                                                                           'source': ch.get('takeSource')}}
    checks = {'frames_total': len(cf), 'expected_frames': plan['total_frames'], 'decodable': len(cf) == plan['total_frames'],
              'timestamps_contiguous': ts_ok, 'keyframes_at_cell_starts': [c['new'][0] for c in cmap if c['new'][0] not in keys] == [],
              'reused_cells': reused, 'rendered_cells': rendered, 'reused_cells_byte_identical': all(v['byte_identical'] for v in reused.values()),
              'reused_frames_equal_at_shifted_positions': reused_frames_ok, 'rendered_frames_differing_from_baseline_overlap': changed_in_rendered,
              'protected_views': views, 'neighbour_golden': neighbours, 'captions': cap_checks,
              'caption_top': {'golden_recomputed': cap_gold, 'changed_slide_new': new_ct},
              'duration_s': round(len(cf) / 30, 4), 'audio_duration_s': audio['candidate']['duration_s']}
    shifts = {c['id']: c['new'][0] - c['base'][0] for c in cmap}
    timing_rep = {'shift_frames': plan['shift_frames'], 'quantize': plan['quantize'], 'sdurs': {'base': plan['base_sdurs'], 'new': plan['sdurs']},
                  'starts': {'base': plan['base_starts'], 'new': plan['starts']}, 'cell_shift_frames': shifts,
                  'tail_card_start_frame': {'base': next(c['base'][0] for c in cmap if c['id'] == 'tail-card'),
                                            'new': next(c['new'][0] for c in cmap if c['id'] == 'tail-card')},
                  'content_offset_s': assembly['content_offset'], 'span_policy': plan['span_policy'], 'frozen_span': plan['frozen_span'],
                  'replan_span': plan['replan_span'], 'replan_drift_deviation_px': deviation,
                  'camera_move': {'base': slides[k]['_fx']['move'], 'new': new_asm['slides'][k]['_fx']['move']},
                  'frames': {'base': m['frameCount'], 'new': plan['total_frames']}}
    asm_path = out / 'candidate-assembly.json'
    asm_path.write_text(json.dumps(new_asm, indent=1, default=str) + '\n')
    picks = []
    for c in cmap:
        if c['kind'] == 'bookend':
            continue
        a, b = (c['new'][0] + c['new'][1]) // 2, (c['base'][0] + c['base'][1]) // 2
        picks.append((f"{c['id']} ({c['action']})", final, b, cand, a))
    picks.append(('hold start +12 (new caption)', final, hold['base'][0] + 12, cand, hold['new'][0] + 12))
    picks.append(('hold end -12', final, hold['base'][1] - 12, cand, hold['new'][1] - 12))
    tc = next(c for c in cmap if c['id'] == 'tail-card')
    picks.append(('tail-card +30 (shifted)', final, tc['base'][0] + 30, cand, tc['new'][0] + 30))
    contact_sheet(picks, out / 'contact-sheet.jpg')
    after = fx_draw.snapshot(real)
    ok = (golden['final']['packets_equal'] and checks['decodable'] and ts_ok and checks['keyframes_at_cell_starts']
          and checks['reused_cells_byte_identical'] and reused_frames_ok and views['ok'] and audio['candidate_audio_stream_copied']
          and reuse_bytes and at_offsets and sync_ok and cap_checks['changed_caption_png_matches_new_text'] and cap_checks['changed_slide_caption_band_differs']
          and cap_checks['other_captions_unchanged'] and all(v for kk, v in cap_checks.items() if kk.endswith('_equals_golden'))
          and len(reused) + len(rendered) == len(m['cells']) and before == after)
    report = {'ok': bool(ok), 'output': str(out), 'candidate': str(cand), 'candidate_sha256': ar.sha256_file(cand),
              'candidate_assembly': str(asm_path), 'contact_sheet': str(out / 'contact-sheet.jpg'),
              'baseline_sha256': m['final']['sha256'], 'step_mapping': {ch['stepId']: fx_scope.slide_id(slides[k])},
              'narration': {'old': ch['oldText'], 'new': ch['newText'], 'caption_new': caption}, 'timing': timing_rep,
              'checks': {**checks, 'rendered_cells': sorted(rendered), 'reused_cells': sorted(reused), 'reused_detail': reused, 'rendered_detail': rendered},
              'audio': audio, 'donor': {'drawer_fingerprint': drawer.fingerprint(), 'font_layout': font_layout, 'segments': rend['segments'],
                                         'cam_caption_top_sha256': hashlib.sha256(cap_top_src.encode()).hexdigest()},
              'pins': {'audio': {k_: v for k_, v in pins.items() if k_ != 'fragments'}, 'timing': list(retime.PINNED)},
              'source_unchanged': before == after, 'source_snapshot': {'before': before, 'after': after},
              'disclosure': ('LOCAL review artifact. Rendered cells are one fresh generation next to protected cells that are the lossy '
                             'rebaseline of the published final; sdur is rounded up to whole frames; the changed screen keeps its '
                             'persisted drift span; the soundtrack is fully re-mixed/re-encoded (4 AAC generations like assemble).')}
    (out / 'verification.json').write_text(json.dumps(report, indent=2, default=str) + '\n')
    return report


# ---------- real pilot end-to-end (local, read-only on the repo) ----------

CASES = {
    'longer': ("Opening up this project takes us straight into its details page, where the name, the owner, the current status "
               "and the unique project ID are all listed together."),
    'shorter': 'Open the project.',
}


def real_pilot_end_to_end(rebaseline_dir, output, case='longer', name='How-to-Find-a-Project-ID', text=None):
    out = drift_render.new_dir(output)
    script_path = REPO / 'scripts' / f'{name}.script.json'
    pilot = REPO / 'out' / name
    script = json.loads(script_path.read_bytes())
    rec_src = REPO / 'out' / '_recordings' / script['recording']['id']
    music = REPO / 'assets' / 'music_upbeat.wav'
    assembly = json.loads((pilot / 'assembly.json').read_bytes())
    real = sorted({script_path, fx_draw.ASSEMBLE, music, *(p for p in rec_src.iterdir() if p.is_file()),
                   *(p for d in (pilot, pilot / 'slides', pilot / 'annotated', pilot / '_build') for p in d.iterdir() if p.is_file()),
                   *(Path(s['audio']) for s in assembly['slides'] if s.get('audio'))})
    before = fx_draw.snapshot(real)
    src = out / 'source'
    (src / '_recordings' / script['recording']['id']).mkdir(parents=True)
    for p in rec_src.iterdir():
        if p.is_file():
            shutil.copyfile(p, src / '_recordings' / script['recording']['id'] / p.name)
    stable = json.loads(json.dumps(script))
    stable.setdefault('id', str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}')))
    for st in stable['steps']:
        if not st.get('id'):
            st['id'] = str(uuid.uuid5(uuid.NAMESPACE_URL, f'hadrius-studio:{name}:step:{st["index"]}'))
    base_path = src / 'stable-base.script.json'
    base_path.write_text(json.dumps(stable, indent=2) + '\n')
    step = stable['steps'][1]
    new_text = text or CASES[case]
    take = make_standin_take(new_text, src / f'standin-{case}.mp3')
    _, manifest_path, _, _, _ = drift_render.load_rebaseline(rebaseline_dir)
    nm = {'baselineManifestHash': ar.sha256_file(manifest_path),
          'changes': [{'stepId': step['id'], 'oldText': step['narration'], 'newText': new_text, 'newTakePath': take['path'],
                       'newTakeSha256': take['sha256'], 'takeSource': STANDIN_LABEL}]}
    mpath = src / 'narration-manifest.json'
    mpath.write_text(json.dumps(nm, indent=2) + '\n')
    flags = {k: v for k, v in json.loads((pilot / 'report.json').read_bytes()).items() if k in ('caption_pos', 'no_captions')}
    rep = run(rebaseline_dir, base_path, src / '_recordings' / script['recording']['id'], mpath, pilot / '_build', music, out / 'update',
              golden_build_dir=pilot / '_build', report_flags=flags)
    after = fx_draw.snapshot(real)
    summary = {'ok': bool(rep['ok'] and before == after), 'case': case, 'step_id': step['id'], 'standin_take': take,
               'candidate': rep['candidate'], 'verification': str(out / 'update' / 'verification.json'), 'contact_sheet': rep['contact_sheet'],
               'timing': rep['timing'], 'checks': {k: rep['checks'][k] for k in ('frames_total', 'expected_frames', 'decodable', 'timestamps_contiguous',
                                                                                 'keyframes_at_cell_starts', 'reused_cells', 'rendered_cells',
                                                                                 'reused_cells_byte_identical', 'reused_frames_equal_at_shifted_positions',
                                                                                 'captions', 'caption_top', 'neighbour_golden')},
               'audio': {k: rep['audio'][k] for k in ('takes', 'takes_at_expected_offsets', 'av_sync_preserved', 'candidate_audio_stream_copied',
                                                        'unchanged_takes_reused_byte_for_byte', 'prefix_vs_baseline')},
               'audio_golden': {'packets_equal': rep['audio']['golden']['final']['packets_equal'], 'pcm': rep['audio']['golden']['final']['pcm']},
               'source_unchanged': before == after and rep['source_unchanged'], 'source_files_snapshotted': len(real) + len(rep['source_snapshot']['before'])}
    (out / 'end-to-end.json').write_text(json.dumps(summary, indent=2, default=str) + '\n')
    return summary


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--rebaseline-dir', required=True)
    p.add_argument('--script', required=True, help='stable-ID script copy matching the baseline (e.g. candidate.mjs identified-base)')
    p.add_argument('--recordings-dir', required=True, help='directory holding the script media.pre captures (read-only)')
    p.add_argument('--narration-manifest', required=True)
    p.add_argument('--build-dir', required=True, help='baseline out/<name>/_build (card clips; read-only)')
    p.add_argument('--music', default=str(REPO / 'assets' / 'music_upbeat.wav'))
    p.add_argument('--output', required=True)
    p.add_argument('--golden-build-dir')
    p.add_argument('--font-layout', default='basic', choices=fx_draw.FONT_LAYOUTS)
    a = p.parse_args(argv)
    try:
        r = run(a.rebaseline_dir, a.script, a.recordings_dir, a.narration_manifest, a.build_dir, a.music, a.output,
                golden_build_dir=a.golden_build_dir, font_layout=a.font_layout)
    except NarrationRejected as e:
        print(json.dumps({'ok': False, 'rejected': e.code, 'detail': e.detail}, default=str))
        return 2
    print(json.dumps({k: r[k] for k in ('ok', 'output', 'candidate', 'candidate_sha256')}, indent=2))
    return 0 if r['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
