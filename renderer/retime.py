"""LOCAL re-timing of an Extra FX walkthrough when ONE interior slide's narration take changes duration.

Grounded in renderer/assemble.py (never imported/executed; the formulas below are pinned against its source):
  sdur   = round(max(HOLD_NO_NARR, adur + PAD_AFTER + XF), 3)
  start  = round(t, 3), t += sdur - XF            (audio loop; fx_plan uses the same offsets)
  frame  = ceil(round(start, 3) * FPS - 1e-6)     (xfade puts slide i there)
  fx_plan per screen: one keyframed camera path; a slide with a move gets
      dur = min(FX_MOVE, max(0.8, sdur*0.4)) if push else min(FX_PAN, max(0.6, sdur*0.4)); ts0 = max(t0, last)
      keys += [(ts0, cur), (ts0 + dur, v)]; move = (round(ts0 - t0, 4), round(dur, 4))
      span = round((frame_last - F0) / FPS + sdur_last, 4)  -> slow FX_SCREEN_DRIFT zoom = z * (1 + 0.04 * ta / span)

Policies (disclosed in every plan):
  * frame quantization: the new sdur is assemble's sdur rounded UP to a whole number of frames relative to the old
    one (at most 1/30 s of extra pause after the line). Every downstream boundary then shifts by exactly
    `shift_frames`, so downstream cells keep their sub-frame dissolve phase and can be reused byte-for-byte.
  * frozen span: the changed screen keeps its persisted `span`, so earlier slides on that screen (whose drift zoom
    depends on span) keep their frames. A full assemble re-plan would change their drift by a few pixels and would
    also touch the lead/card crossfade; `replan_span` and the max view displacement are reported.
  * key re-timing: moves on the changed screen are re-timed with fx_plan's rule (views/push are frozen); views of
    every protected (reused) frame are asserted unchanged.
Only interior slides (not the first/last: their dissolves are card crossfades) on a screen where the changed slide
has no same-screen followers are supported; anything else is rejected before rendering.
"""
import ast
import copy
import json
import math
from pathlib import Path

from . import fx_draw, fx_scope

FPS, XF, HOLD_NO_NARR, PAD_AFTER, FX_MOVE, FX_PAN = 30, 0.8, 1.9, 1.1, 1.5, 1.1
PINNED = (
    "HOLD_NO_NARR = 1.9", "PAD_AFTER = 1.1", "XF = 0.8", "FX_MOVE = 1.5", "FX_PAN = 1.1", "W, H, FPS = 1920, 1080, 30",
    "s['sdur'] = round(max(HOLD_NO_NARR, s['adur'] + PAD_AFTER + XF), 3) if s['audio'] else HOLD_NO_NARR",
    "off += slides_[i - 1]['sdur'] - XF",
    "frames.append(math.ceil(round(off, 3) * FPS - 1e-6))",
    "push = cur == wide",
    "dur = min(FX_MOVE, max(0.8, s['sdur'] * 0.4)) if push else min(FX_PAN, max(0.6, s['sdur'] * 0.4))",
    "ts0 = max(t0, last)",
    "keys += [(ts0, cur), (ts0 + dur, v)]",
    "move, last, cur = (round(ts0 - t0, 4), round(dur, 4)), ts0 + dur, v",
    "span = round((sc[-1][1] - F0) / FPS + sc[-1][0]['sdur'], 4)",
    "s['_cap_edges'] = (prev_s is not None and cap_text != prev_s['_cap_text'], False)",
    "cap_text = (s.get('caption') or s.get('narration') or '').strip()",
)
CAP_CELL_KEYS = ('slide', 'file', 'narration', 'caption', 'target', 'viewport', 'route', 'action', 'sdur', '_cam', '_cap_edges',
                 '_cap_text', '_cap_top')
FX_OWN_KEYS = ('off', 'first', 'move', 'push', 'blur_in', 'blur_out')


class RetimeRejected(ValueError):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def _canon(v):
    return json.dumps(v, sort_keys=True)


def check_source_pins(source=fx_draw.ASSEMBLE):
    text = Path(source).read_text()
    missing = [p for p in PINNED if p not in text]
    if missing:
        raise RetimeRejected('assemble_timing_source_changed', missing[0])
    return True


def frame_of(seconds):
    return math.ceil(round(seconds, 3) * FPS - 1e-6)


def quantize_sdur(old_sdur, new_adur):
    a_sdur = round(max(HOLD_NO_NARR, new_adur + PAD_AFTER + XF), 3)
    k = math.ceil((a_sdur - old_sdur) * FPS - 1e-9)
    sdur = round(old_sdur + k / FPS, 3)
    if int(round(sdur * FPS)) != int(round(old_sdur * FPS)) + k or sdur < a_sdur - 0.0005:
        raise RetimeRejected('frame_quantization_failed', {'old': old_sdur, 'assemble': a_sdur, 'k': k, 'sdur': sdur})
    return {'assemble_sdur': a_sdur, 'sdur': sdur, 'shift_frames': k, 'extra_pause_s': round(sdur - a_sdur, 6)}


def starts_of(sdurs):
    t, out = 0.0, []
    for k, d in enumerate(sdurs):
        out.append(round(t, 3))
        t += d - (XF if k < len(sdurs) - 1 else 0)
    return out


def screens_of(slides):
    sc = []
    for i, s in enumerate(slides):
        if s['_fx']['first']:
            sc.append([])
        if not sc:
            raise RetimeRejected('inconsistent_fx_plan')
        sc[-1].append(i)
    return sc


def _views(slides, sc):
    """The frozen target views of each move on a screen, read back from its persisted keys."""
    keys = slides[sc[0]]['_fx']['keys']
    movers = [i for i in sc if slides[i]['_fx']['move'] is not None]
    if len(keys) != 1 + 2 * len(movers):
        raise RetimeRejected('fx_timing_port_mismatch', {'screen': sc, 'reason': 'keys_vs_moves'})
    return keys[0][1], {i: keys[2 + 2 * m][1] for m, i in enumerate(movers)}


def retime_screen(slides, sc, sdurs, frames):
    """fx_plan's timing for one screen with frozen views/push. Returns {i: new _fx} (span = re-planned value)."""
    wide, views = _views(slides, sc)
    F0 = frames[sc[0]]
    cur, keys, last = wide, [[0.0, wide]], 0.0
    own = {}
    for i in sc:
        fx = slides[i]['_fx']
        t0 = (frames[i] - F0) / FPS
        move, push = None, False
        if i in views:
            v = views[i]
            push = cur == wide
            sd = sdurs[i]
            dur = min(FX_MOVE, max(0.8, sd * 0.4)) if push else min(FX_PAN, max(0.6, sd * 0.4))
            ts0 = max(t0, last)
            keys += [[ts0, cur], [ts0 + dur, v]]
            move, last, cur = [round(ts0 - t0, 4), round(dur, 4)], ts0 + dur, v
        own[i] = {'off': frames[i] - F0, 'first': i == sc[0], 'move': move, 'push': push, 'blur_in': fx['blur_in'], 'blur_out': fx['blur_out']}
    span = round((frames[sc[-1]] - F0) / FPS + sdurs[sc[-1]], 4)
    return {i: {**own[i], 'keys': keys, 'span': span} for i in sc}


def check_fx_timing_port(assembly):
    """Golden: the port re-derives every persisted _fx (moves, keys, span, off, push) from the persisted sdurs."""
    slides = assembly['slides']
    sdurs = [s['sdur'] for s in slides]
    frames = [frame_of(s['start']) for s in slides]
    mism = []
    try:
        for sc in screens_of(slides):
            new = retime_screen(slides, sc, sdurs, frames)
            for i in sc:
                if _canon(json.loads(json.dumps(new[i]))) != _canon(slides[i]['_fx']):
                    mism.append({'slide': slides[i]['slide'], 'port': new[i], 'persisted': slides[i]['_fx']})
    except RetimeRejected as e:
        mism.append({'error': e.code, 'detail': e.detail})
    starts_ok = starts_of(sdurs) == [s['start'] for s in slides]
    return {'ok': not mism and starts_ok, 'starts_equal': starts_ok, 'mismatches': mism}


def caption_edges(texts):
    edges = [[False, False] for _ in texts]
    for i in range(1, len(texts)):
        if texts[i] != texts[i - 1]:
            edges[i][0] = True
            edges[i - 1][1] = True
    return edges


def caption_runs(texts, tops):
    """assemble's pass: consecutive identical non-empty captions share one position (any top -> all top)."""
    tops, i = list(tops), 0
    while i < len(texts):
        j = i
        while j + 1 < len(texts) and texts[i] and texts[j + 1] == texts[i]:
            j += 1
        if any(tops[k] for k in range(i, j + 1)):
            for k in range(i, j + 1):
                tops[k] = True
        i = j + 1
    return tops


def plan_retime(assembly, k, new_adur, narration, caption, cap_top=None, audio=None, audio_filter='', base_total_frames=None):
    check_source_pins()
    if assembly.get('fx') is not True:
        raise RetimeRejected('unsupported_non_fx_render')
    slides = assembly['slides']
    n = len(slides)
    if not 0 < k < n - 1:
        raise RetimeRejected('unsupported_edge_slide')
    if not (narration or '').strip():
        raise RetimeRejected('unsupported_narration_removal')
    gold = check_fx_timing_port(assembly)
    if not gold['ok']:
        raise RetimeRejected('fx_timing_port_mismatch', gold['mismatches'][:2])
    base_total = base_total_frames if base_total_frames is not None else int(round(assembly['duration'] * FPS))
    q = quantize_sdur(slides[k]['sdur'], new_adur)
    texts_old = [s['_cap_text'] for s in slides]
    texts = list(texts_old)
    texts[k] = (caption or narration or '').strip()
    edges = caption_edges(texts)
    if [list(e) for e in (s['_cap_edges'] for s in slides)] != caption_edges(texts_old):
        raise RetimeRejected('caption_edges_port_mismatch')
    if edges != [list(s['_cap_edges']) for s in slides]:
        raise RetimeRejected('scope_expansion_required:caption_handover_changed', {'old': [s['_cap_edges'] for s in slides], 'new': edges})
    new = copy.deepcopy(assembly)
    ns = new['slides']
    sdurs = [s['sdur'] for s in slides]
    sdurs[k] = q['sdur']
    starts = starts_of(sdurs)
    frames = [frame_of(x) for x in starts]
    old_frames = [frame_of(s['start']) for s in slides]
    screens = screens_of(slides)
    sc_k = next(sc for sc in screens if k in sc)
    dirty = [k]
    replan_span = None
    for sc in screens:
        fx_new = retime_screen(slides, sc, sdurs, frames)
        for i in sc:
            f = fx_new[i]
            if sc is sc_k:
                replan_span = f['span']
                f = {**f, 'span': slides[i]['_fx']['span']}  # frozen span policy
                if i > k:
                    dirty.append(i)
            elif _canon(json.loads(json.dumps(f))) != _canon(slides[i]['_fx']):
                raise RetimeRejected('unexpected_fx_change_on_other_screen', slides[i]['slide'])
            ns[i]['_fx'] = json.loads(json.dumps(f))
    if len(dirty) > 1:
        raise RetimeRejected('scope_expansion_required:same_screen_followers', [slides[i]['slide'] for i in dirty])
    for i, s in enumerate(ns):
        s['sdur'], s['start'] = sdurs[i], starts[i]
    s = ns[k]
    s.update(narration=narration, caption=caption, _cap_text=texts[k], adur=new_adur, audio=str(audio) if audio else s.get('audio'),
             audio_filter=audio_filter or '')
    if cap_top is not None:
        s['_cap_top'] = bool(cap_top)
    tops = caption_runs(texts, [x['_cap_top'] for x in ns])
    if [t for i, t in enumerate(tops) if i != k] != [x['_cap_top'] for i, x in enumerate(slides) if i != k]:
        raise RetimeRejected('scope_expansion_required:caption_position_changed')
    s['_cap_top'] = tops[k]
    total = base_total + q['shift_frames']
    new['duration'] = round(total / FPS, 2)
    new['narration_update'] = {'slide': slides[k]['slide'], 'quantize': q, 'span_policy': 'frozen', 'replan_span': replan_span}
    return {'assembly': new, 'k': k, 'shift_frames': q['shift_frames'], 'quantize': q, 'dirty_slides': [fx_scope.slide_id(slides[i]) for i in dirty],
            'changed_screen': [fx_scope.slide_id(slides[i]) for i in sc_k], 'span_policy': 'frozen', 'frozen_span': slides[k]['_fx']['span'],
            'replan_span': replan_span, 'total_frames': total, 'base_total_frames': base_total, 'frames': frames, 'base_frames': old_frames,
            'starts': starts, 'base_starts': [x['start'] for x in slides], 'sdurs': sdurs, 'base_sdurs': [x['sdur'] for x in slides]}


def timeline_for(new_assembly, total_frames, plan):
    """fx_scope.timeline on a validation copy whose changed-screen span is the re-planned one (the cell partition
    does not depend on span; fx_scope validates span against fx_plan's rule)."""
    v = copy.deepcopy(new_assembly)
    for s in v['slides']:
        if fx_scope.slide_id(s) in plan['changed_screen']:
            s['_fx']['span'] = plan['replan_span']
    return fx_scope.timeline(v, total_frames)


def map_cells(base_cells, new_cells, dirty_slides):
    base = {c['id']: c for c in base_cells}
    if [c['id'] for c in base_cells] != [c['id'] for c in new_cells]:
        raise RetimeRejected('cell_topology_changed')
    out = []
    for c in new_cells:
        b = base[c['id']]
        if b['dependsOn'] != c['dependsOn'] or b['kind'] != c['kind']:
            raise RetimeRejected('cell_topology_changed', c['id'])
        render = bool(set(c['dependsOn']) & set(dirty_slides))
        if not render and (c['endFrame'] - c['startFrame']) != (b['endFrame'] - b['startFrame']):
            raise RetimeRejected('reused_cell_length_changed', c['id'])
        out.append({'id': c['id'], 'kind': c['kind'], 'dependsOn': c['dependsOn'], 'new': [c['startFrame'], c['endFrame']],
                    'base': [b['startFrame'], b['endFrame']], 'action': 'render' if render else 'reuse'})
    return out


def protected_views_equal(drawer, base_assembly, new_assembly, cell_map):
    """Every frame of every reused cell: each contributing slide shows the same camera view, at the same local
    segment frame, with the same per-slide drawing inputs (caption, edges, move/push, blur, sdur...)."""
    ns = drawer.ns
    c0 = frame_of(base_assembly['content_offset']) if base_assembly['content_offset'] > 0 else 0
    ob, nb = base_assembly['slides'], new_assembly['slides']
    fo, fn = [frame_of(s['start']) for s in ob], [frame_of(s['start']) for s in nb]
    ids = [fx_scope.slide_id(s) for s in ob]
    mism, checked, max_dev = [], 0, 0.0
    for c in cell_map:
        if c['action'] != 'reuse':
            continue
        shift = c['new'][0] - c['base'][0]
        for sid in c['dependsOn']:
            if sid not in ids:
                continue
            j = ids.index(sid)
            so, sn = fx_draw.frozen_slide(ob[j]), fx_draw.frozen_slide(nb[j])
            if any(_canon(so.get(x)) != _canon(sn.get(x)) for x in CAP_CELL_KEYS) or any(_canon(so['_fx'][x]) != _canon(sn['_fx'][x]) for x in FX_OWN_KEYS):
                mism.append({'cell': c['id'], 'slide': sid, 'reason': 'slide_inputs_changed'})
                continue
            nfr = int(round(so['sdur'] * FPS))
            for f in range(c['new'][0], c['new'][1]):
                ln, lo = f - c0 - fn[j], (f - shift) - c0 - fo[j]
                if ln != lo:
                    mism.append({'cell': c['id'], 'slide': sid, 'frame': f, 'reason': 'local_frame_shift'})
                    break
                if 0 <= ln < nfr:
                    a, b = ns['cam_view_at'](so, ln / FPS), ns['cam_view_at'](sn, ln / FPS)
                    checked += 1
                    if a != b:
                        max_dev = max(max_dev, max(abs(x - y) for x, y in zip(a, b)))
                        mism.append({'cell': c['id'], 'slide': sid, 'frame': f, 'old': a, 'new': b})
    return {'ok': not mism, 'frames_checked': checked, 'mismatches': mism[:10], 'mismatch_count': len(mism)}


def replan_drift_deviation(drawer, assembly, plan):
    """What a full assemble re-plan (span updated) would change on the frozen screen's earlier slides: max view
    displacement in output pixels over their segment frames (disclosure only; the frozen plan is rendered)."""
    ns = drawer.ns
    worst = {'max_px': 0.0, 'slide': None, 'frame': None}
    for s in assembly['slides']:
        if fx_scope.slide_id(s) not in plan['changed_screen'] or fx_scope.slide_id(s) in plan['dirty_slides']:
            continue
        fz = fx_draw.frozen_slide(next(x for x in plan['assembly']['slides'] if x['slide'] == s['slide']))
        rp = copy.deepcopy(fz)
        rp['_fx']['span'] = plan['replan_span']
        sw, sh = fz['_cam'][2]
        for i in range(int(round(fz['sdur'] * FPS))):
            a, b = ns['cam_view_at'](fz, i / FPS), ns['cam_view_at'](rp, i / FPS)
            # displacement of the frame corner: (c - vw/2) and (c + vw/2) in output px
            for sgn in (-1, 1):
                pa = (a[0] + sgn * sw / a[2] / 2, a[1] + sgn * sh / a[2] / 2)
                pb = (b[0] + sgn * sw / b[2] / 2, b[1] + sgn * sh / b[2] / 2)
                d = max(abs(pa[0] - pb[0]) * ns['W'] / (sw / a[2]), abs(pa[1] - pb[1]) * ns['H'] / (sh / a[2]))
                if d > worst['max_px']:
                    worst = {'max_px': round(d, 3), 'slide': fx_scope.slide_id(s), 'frame': i}
    return worst


# ---------- assemble's caption-position decision (cam_caption_top), AST-extracted ----------

def load_caption_top(drawer, rep=None):
    text = fx_draw.ASSEMBLE.read_text()
    tree = ast.parse(text)
    found = fx_draw._assignments(tree)
    hits = [n for n, _ in found.get('cam_caption_top', []) if isinstance(n, ast.FunctionDef)]
    if len(hits) != 1 or len(found['cam_caption_top']) != 1 or hits[0].decorator_list:
        raise RetimeRejected('assemble_caption_top_source_changed')
    src = ast.get_source_segment(text, hits[0])
    ns = dict(drawer.ns)
    ns.update(rep=dict(rep or {}), args=[])
    import builtins
    for g in fx_draw._function_globals(src):
        if g not in ns and not hasattr(builtins, g):
            raise RetimeRejected('assemble_caption_top_source_changed', g)
    exec(compile(ast.Module(body=[hits[0]], type_ignores=[]), '<assemble.py:cam_caption_top>', 'exec'), ns)
    return ns['cam_caption_top'], src


# ---------- rendering the dirty cells on the new timeline ----------

def render_cells(drawer, new_assembly, plan, cell_map, timeline, workdir, caption_pos=None):
    from . import rebaseline
    out = Path(workdir)
    out.mkdir(parents=True)
    ns, slides = drawer.ns, new_assembly['slides']
    k = plan['k']
    lo, hi = k - 1, k + 1
    sub = [fx_draw.frozen_slide(slides[j]) for j in range(lo, hi + 1)]
    segs = [ns['tmp'] / f"seg{s['slide']:02d}.mp4" for s in sub]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=len(sub)) as pool:
        list(pool.map(lambda a: fx_draw.render_segment(drawer, *a, caption_pos=caption_pos), zip(sub, segs)))
    frames = plan['frames']
    sd = [s['sdur'] for s in sub]
    off = 0.0
    for i in range(1, len(sub)):
        off += sd[i - 1] - ns['XF']
        if frame_of(off) != frames[lo + i] - frames[lo]:
            raise RetimeRejected('subchain_offset_mismatch')
    content = out / 'content-subchain.mkv'
    fx_draw.sh(*fx_draw.xfade_command(segs, sd, content, ns['XF'], ns['FPS'], ['-c:v', 'ffv1', '-level', '3']))
    n_sub = len(fx_draw.framehashes(content))
    base = timeline['content_start_frame'] + frames[lo]
    cells = {}
    for c in cell_map:
        if c['action'] != 'render':
            continue
        a, b = c['new'][0] - base, c['new'][1] - base
        if a < 0 or b > n_sub:
            raise RetimeRejected('dirty_cell_outside_subchain', c['id'])
        p = out / f"cell-{c['id']}.mp4"
        rebaseline.encode_cell(content, a, b, p, vf='setsar=1')
        sig = rebaseline.cell_signature(p, b - a)
        cells[c['id']] = {'file': str(p), 'sha256': fx_draw.sha256_file(p), 'startFrame': c['new'][0], 'endFrame': c['new'][1],
                          'subchain_frames': [a, b], 'signature': sig}
    return {'cells': cells, 'segments': {s['file']: {'path': str(p), 'sha256': fx_draw.sha256_file(p)} for s, p in zip(sub, segs)},
            'subchain': str(content), 'subchain_frames': n_sub, 'subchain_origin_frame': base}
