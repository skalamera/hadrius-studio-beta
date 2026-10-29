"""Import-safe FX dependency closure for targeted slide updates (local planning only).

Given a baseline Extra FX assembly.json (as written by renderer/assemble.py) and a proposed change
set {slide -> {screenshot_changed, target_changed}}, return the exact integer frame scope in the
FINAL video that must be re-rendered, the complementary protected frames, and the approval scope.

Grounded in assemble.py (never imported here: its import prunes/touches shared caches and may call
paid TTS):
- FPS = 30, slide dissolve XF = 0.8 s, card crossfades 0.65 s (title->content, content->support),
  0.80 s support->outro.
- Slide i's first content frame is where xfade puts it: ceil(round(start, 3) * FPS - 1e-6) (fx_plan).
  Its segment is round(sdur * FPS) frames long, so it overlaps the next slide's dissolve-in.
- Content frame 0 lands at ceil(round(content_offset, 3) * FPS - 1e-6) in the final video (the lead
  crossfade starts at the first lead frame with pts >= offset). Verified on the real pilot: observed
  dissolve frames 163-182, 436-459 and 591-610 sit inside the computed windows.
- Screens: fx_plan persists one camera path (keys, span) per screen, `first` marks a screen's first
  slide, `off` is the slide's frame offset inside the screen.
- Captions hand over and different-screen dissolves defocus INSIDE the first/last XF of each segment,
  i.e. inside the dissolve windows, so a slide's dirty frames are its dissolve-in, hold and dissolve-out.

Rules:
- screenshot pixels only (identical target geometry): the persisted _fx/_cam keys stay frozen, so
  dirty = that slide's own cells (dissolve-in, hold, dissolve-out). A donor renderer must therefore
  reuse the persisted plan rather than re-plan (re-planning could regroup screens by thumbnail MAD).
- target geometry: the screen's area/zoom plan (and so every slide's camera on it) and the caption
  top/bottom decision can change, so the closure is every slide on that screen plus the screen's
  boundary transitions, plus any slide sharing a caption-position run (assemble keeps consecutive
  identical captions at one position, even across screens). Returned as scope_expansion_required.

Windows are rounded outward by GUARD frames each side so they always cover affected frames.
"""
import hashlib
import json
import math
import subprocess
from pathlib import Path

FPS = 30
XF = 0.8           # assemble.XF: dissolve between slides
CARD_XF = 0.65     # crossfade_pair(..., xf_dur=0.65): intro->title, lead->content, content->support
OUTRO_XF = 0.8     # crossfade_pair(active_body, OUTRO, ..., xf_dur=0.80)
GUARD = 1          # frames of outward rounding on every transition window

FX_KEYS = ('off', 'first', 'move', 'push', 'blur_in', 'blur_out', 'keys', 'span')


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _frame(seconds):
    return math.ceil(round(seconds, 3) * FPS - 1e-6)


def slide_id(s):
    return f"slide-{s['slide']:02d}"


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _validate(assembly):
    if not isinstance(assembly, dict) or not isinstance(assembly.get('slides'), list) or not assembly['slides']:
        raise ValueError('invalid_assembly')
    if assembly.get('fx') is not True:
        raise ValueError('unsupported_non_fx_render')
    slides = assembly['slides']
    nums = [s.get('slide') for s in slides]
    if any(type(n) is not int for n in nums) or len(set(nums)) != len(nums):
        raise ValueError('duplicate_slide')
    if nums != sorted(nums):
        raise ValueError('inconsistent_timeline')
    for s in slides:
        if not _num(s.get('sdur')) or s['sdur'] <= 0 or not _num(s.get('start')):
            raise ValueError('inconsistent_timeline')
        fx = s.get('_fx')
        if not isinstance(fx, dict) or any(k not in fx for k in FX_KEYS):
            raise ValueError('missing_fx_data')
    # start_i exactly as assemble's audio loop records it.
    t = 0.0
    for k, s in enumerate(slides):
        if abs(s['start'] - round(t, 3)) > 5e-4:
            raise ValueError('inconsistent_timeline')
        t += s['sdur'] - (XF if k < len(slides) - 1 else 0)
    co = assembly.get('content_offset')
    if not _num(co) or co < 0:
        raise ValueError('inconsistent_timeline')
    lead = bool(assembly.get('intro') or assembly.get('title_card'))
    if lead != (co > 0):
        raise ValueError('inconsistent_timeline')
    return slides, t


def _screens(slides):
    frames = [_frame(s['start']) for s in slides]
    screens = []
    for i, s in enumerate(slides):
        fx = s['_fx']
        if fx['first'] is not (fx['off'] == 0) or (i == 0 and not fx['first']):
            raise ValueError('inconsistent_fx_plan')
        if fx['first']:
            screens.append([])
        screens[-1].append(i)
    for sc in screens:
        f0 = frames[sc[0]]
        span = round((frames[sc[-1]] - f0) / FPS + slides[sc[-1]]['sdur'], 4)
        keys = json.dumps(slides[sc[0]]['_fx']['keys'])
        for i in sc:
            fx = slides[i]['_fx']
            if (fx['off'] != frames[i] - f0 or json.dumps(fx['keys']) != keys or abs(fx['span'] - span) > 1e-3
                    or fx['blur_in'] is not (i == sc[0] and i != 0)
                    or fx['blur_out'] is not (i == sc[-1] and i != len(slides) - 1)):
                raise ValueError('inconsistent_fx_plan')
    return screens, frames


def timeline(assembly, total_frames, check_duration=True, guard=GUARD):
    """Integer, gap-free cell partition of the final video [0, total_frames)."""
    if type(total_frames) is not int or total_frames <= 0:
        raise ValueError('invalid_total_frames')
    slides, total = _validate(assembly)
    if check_duration and abs(assembly.get('duration', -1) - total_frames / FPS) > 0.05:
        raise ValueError('duration_mismatch')
    screens, frames = _screens(slides)
    lead = assembly['content_offset'] > 0
    c0 = _frame(assembly['content_offset']) if lead else 0
    seg_end = [frames[i] + int(round(s['sdur'] * FPS)) for i, s in enumerate(slides)]
    content_end = c0 + max(_frame(total), seg_end[-1])
    ids = [slide_id(s) for s in slides]
    xf = int(round(XF * FPS))
    windows = []  # (id, deps, start, end) transition windows, ordered
    if lead:
        windows.append(('lead-dissolve', ['card:lead', ids[0]], c0 - guard, c0 + math.ceil(CARD_XF * FPS) + guard))
    for i in range(1, len(slides)):
        a, b = c0 + frames[i], c0 + max(frames[i] + xf, seg_end[i - 1])
        windows.append((f'dissolve-{slides[i - 1]["slide"]:02d}-{slides[i]["slide"]:02d}', [ids[i - 1], ids[i]], a - guard, b + guard))
    tail_xf = CARD_XF if assembly.get('support_card') else (OUTRO_XF if assembly.get('outro') else None)
    if tail_xf is not None:
        windows.append(('tail-dissolve', [ids[-1], 'card:tail'], content_end - math.ceil(tail_xf * FPS) - guard, content_end + guard))
        tail_end = content_end + guard
        if tail_end >= total_frames:
            raise ValueError('inconsistent_timeline')
    else:
        tail_end = content_end
        if content_end != total_frames:
            raise ValueError('inconsistent_timeline')
    cells, cursor = [], 0
    if lead:
        if windows[0][2] <= 0:
            raise ValueError('inconsistent_timeline')
        cells.append({'id': 'lead-card', 'kind': 'bookend', 'dependsOn': ['card:lead'], 'startFrame': 0, 'endFrame': windows[0][2]})
        cursor = windows[0][2]
    # holds sit between consecutive windows; slide k's hold follows its dissolve-in
    hold_after = windows if lead else [None] + windows
    for k in range(len(slides)):
        win_in = hold_after[k]
        if win_in is not None:
            cid, deps, a, b = win_in
            if a != cursor or b <= a:
                raise ValueError('overlapping_transitions')
            cells.append({'id': cid, 'kind': 'dissolve', 'dependsOn': deps, 'startFrame': a, 'endFrame': b})
            cursor = b
        nxt = hold_after[k + 1] if k + 1 < len(hold_after) else None
        end = nxt[2] if nxt is not None else tail_end
        if end <= cursor:
            raise ValueError('overlapping_transitions')
        cells.append({'id': f'hold-{slides[k]["slide"]:02d}', 'kind': 'hold', 'dependsOn': [ids[k]], 'startFrame': cursor, 'endFrame': end})
        cursor = end
    if tail_xf is not None:
        cid, deps, a, b = windows[-1]
        if a != cursor or b <= a:
            raise ValueError('overlapping_transitions')
        cells.append({'id': cid, 'kind': 'dissolve', 'dependsOn': deps, 'startFrame': a, 'endFrame': b})
        cells.append({'id': 'tail-card', 'kind': 'bookend', 'dependsOn': ['card:tail'], 'startFrame': b, 'endFrame': total_frames})
        cursor = total_frames
    if cursor != total_frames or any(type(c['startFrame']) is not int or c['endFrame'] <= c['startFrame'] for c in cells):
        raise ValueError('inconsistent_timeline')
    steps = (['card:lead'] if lead else []) + ids + (['card:tail'] if tail_xf is not None else [])
    return {'fps': FPS, 'xf_frames': xf, 'guard_frames': guard, 'total_frames': total_frames,
            'content_start_frame': c0, 'content_end_frame': content_end, 'steps': steps,
            'screens': [[ids[i] for i in sc] for sc in screens], 'cells': cells}


def _resolve(slides, key):
    for s in slides:
        if key == s['slide'] or key == slide_id(s) or (isinstance(key, str) and key == s.get('src')):
            if isinstance(key, bool):
                break
            return slide_id(s)
    raise ValueError(f'unknown_slide:{key}')


def _ranges(frames_sorted):
    out = []
    for a, b in frames_sorted:
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def closure(assembly, changes, total_frames, check_duration=True, guard=GUARD):
    tl = timeline(assembly, total_frames, check_duration=check_duration, guard=guard)
    slides = assembly['slides']
    ids = [slide_id(s) for s in slides]
    if not isinstance(changes, dict):
        raise ValueError('invalid_change')
    norm = {}
    for key, ch in changes.items():
        sid = _resolve(slides, key)
        if sid in norm:
            raise ValueError('duplicate_change')
        if (not isinstance(ch, dict) or set(ch) != {'screenshot_changed', 'target_changed'}
                or any(type(v) is not bool for v in ch.values())):
            raise ValueError('invalid_change')
        norm[sid] = dict(ch)
    screen_of = {sid: sc for sc in tl['screens'] for sid in sc}
    # consecutive identical captions share one top/bottom position (assemble's caption-run pass)
    runs, i = [], 0
    while i < len(slides):
        j = i
        txt = slides[i].get('_cap_text')
        while j + 1 < len(slides) and txt and slides[j + 1].get('_cap_text') == txt:
            j += 1
        runs.append(ids[i:j + 1]); i = j + 1
    run_of = {sid: r for r in runs for sid in r}
    requested = sorted(sid for sid, ch in norm.items() if ch['screenshot_changed'] or ch['target_changed'])
    scope, expansion = set(requested), []
    for sid in requested:
        if norm[sid]['target_changed']:
            for other in screen_of[sid]:
                if other not in scope:
                    scope.add(other); expansion.append({'slide': other, 'reason': 'same_fx_screen', 'because': sid})
    for sid in sorted(scope):
        if any(norm.get(x, {}).get('target_changed') for x in screen_of[sid]):
            for other in run_of[sid]:
                if other not in scope:
                    scope.add(other); expansion.append({'slide': other, 'reason': 'shared_caption_position', 'because': sid})
    scope_ids = [x for x in ids if x in scope]
    dirty_cells = [c for c in tl['cells'] if set(c['dependsOn']) & scope]
    dirty = _ranges(sorted((c['startFrame'], c['endFrame']) for c in dirty_cells))
    protected, cursor = [], 0
    for a, b in dirty:
        if a > cursor:
            protected.append([cursor, a])
        cursor = b
    if cursor < total_frames:
        protected.append([cursor, total_frames])
    n_dirty = sum(b - a for a, b in dirty)
    return {'fps': FPS, 'guard_frames': guard, 'total_frames': total_frames, 'changes': norm, 'requested': requested,
            'scope_expansion_required': bool(expansion),
            'expansion': [{'slide': e['slide'], 'reason': e['reason']} for e in expansion],
            'expansion_detail': expansion,
            'approval_scope': {'stepIds': scope_ids},
            'dirty_cells': [c['id'] for c in dirty_cells], 'dirty_frames': dirty, 'protected_frames': protected,
            'dirty_frame_count': n_dirty, 'protected_frame_count': total_frames - n_dirty,
            'assumptions': ['persisted _fx/_cam/_cap_* plan is frozen for screenshot-only changes',
                            'narration, captions, sdur and timing unchanged (audio not re-rendered)'],
            'timeline': tl}


def explicit_scope(assembly, slide_ids, total_frames, check_duration=True, guard=GUARD, reasons=None):
    """Scope for an EXACT dirty slide set (e.g. the slides whose re-planned camera/FX/caption plan differs from the
    persisted one, plus the changed slide). Same cell semantics as closure(): a cell is dirty when it depends on a dirty
    slide, so card frames outside the lead/tail dissolves stay protected. The set must be one contiguous run of slides
    (a re-plan diff is a screen plus caption runs; anything else is rejected rather than guessed)."""
    tl = timeline(assembly, total_frames, check_duration=check_duration, guard=guard)
    slides = assembly['slides']
    ids = [slide_id(s) for s in slides]
    if not isinstance(slide_ids, (list, tuple)) or not slide_ids:
        raise ValueError('empty_scope')
    norm = [_resolve(slides, x) for x in slide_ids]
    if len(set(norm)) != len(norm):
        raise ValueError('duplicate_change')
    idx = sorted(ids.index(x) for x in norm)
    if idx != list(range(idx[0], idx[-1] + 1)):
        raise ValueError('noncontiguous_scope')
    scope = {ids[i] for i in idx}
    dirty_cells = [c for c in tl['cells'] if set(c['dependsOn']) & scope]
    dirty = _ranges(sorted((c['startFrame'], c['endFrame']) for c in dirty_cells))
    protected, cursor = [], 0
    for a, b in dirty:
        if a > cursor:
            protected.append([cursor, a])
        cursor = b
    if cursor < total_frames:
        protected.append([cursor, total_frames])
    n_dirty = sum(b - a for a, b in dirty)
    return {'fps': FPS, 'guard_frames': guard, 'total_frames': total_frames, 'requested': [ids[i] for i in idx],
            'range': [idx[0], idx[-1]], 'edges': {'lead': idx[0] == 0 and 'card:lead' in tl['steps'],
                                                  'tail': idx[-1] == len(ids) - 1 and 'card:tail' in tl['steps']},
            'reasons': {k: list(v) for k, v in (reasons or {}).items()}, 'scope_expansion_required': False,
            'approval_scope': {'stepIds': [ids[i] for i in idx]},
            'dirty_cells': [c['id'] for c in dirty_cells], 'dirty_frames': dirty, 'protected_frames': protected,
            'dirty_frame_count': n_dirty, 'protected_frame_count': total_frames - n_dirty,
            'assumptions': ['dirty slides = changed slide + slides whose re-planned render plan differs from the persisted plan',
                            'narration, captions, sdur and timing unchanged (audio not re-rendered)'],
            'timeline': tl}


def observed_transitions(mp4, threshold=0.4):
    """READ-ONLY helper: frame indices whose 160x90 grey mean abs diff vs the previous frame exceeds threshold."""
    import numpy as np
    raw = subprocess.check_output(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(mp4), '-map', '0:v:0', '-vf',
                                   'scale=160:90,format=gray', '-f', 'rawvideo', '-'], timeout=120)
    a = np.frombuffer(raw, np.uint8).reshape(-1, 90, 160).astype(float)
    d = np.abs(np.diff(a, axis=0)).mean(axis=(1, 2))
    return [i + 1 for i, v in enumerate(d) if v > threshold]
