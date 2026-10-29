"""READ-ONLY baseline inventory of existing Hadrius Studio walkthroughs.

Classifies which legacy videos have the local assets needed for a safe targeted-update pilot.
Import-safe: stdlib only, no work at import. Never writes, renames, touches or prunes anything
under the repository; the only writes are new files inside a NEW output directory outside the repo.
Optional ``--probe-media`` runs read-only ``ffprobe`` (timeout-bounded) on final MP4s.

    python -m renderer.baseline_inventory --repo <repo> --output <new dir> [--only <name>] [--probe-media]
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

INTERNAL_PREFIX = '_studio'
STRICT_REASON = ('legacy final MP4 is not segmented into independently decodable cells; '
                 'requires approved one-time rebaseline')
PNG_SIG = b'\x89PNG\r\n\x1a\n'
PNG_IEND = b'\x00\x00\x00\x00IEND\xaeB`\x82'
DURATION_TOLERANCE_S = 1.0
FFPROBE_TIMEOUT_S = 30
TIERS = ('candidate_ready', 'visual_render_evidence', 'audio_takes_recoverable')


# ---------- read-only helpers ----------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _stat(path):
    try:
        st = os.stat(path)
        return {'size': st.st_size, 'mtime_ns': st.st_mtime_ns}
    except OSError:
        return {'missing': True}


def snapshot(paths, hashed=True):
    """{path: {sha256?, size, mtime_ns}} — compare before/after to prove sources were untouched."""
    out = {}
    for p in sorted({str(x) for x in paths}):
        rec = _stat(p)
        if hashed and not rec.get('missing') and os.path.isfile(p):
            rec['sha256'] = sha256_file(p)
        out[p] = rec
    return out


def _real(path):
    return Path(os.path.realpath(path))


def _within(path, root):
    """Resolved path if it stays inside resolved root (symlinks followed), else None."""
    p, r = _real(path), _real(root)
    return p if (p == r or r in p.parents) else None


def _safe_flat_name(name):
    return (isinstance(name, str) and name and name not in ('.', '..') and '/' not in name
            and '\\' not in name and '\x00' not in name)


def png_problem(path):
    """None when the file has a PNG signature, a well-formed IHDR (length, CRC, dims, depth/type) and ends with IEND."""
    try:
        size = os.path.getsize(path)
        if size < 8 + 25 + 12:
            return 'png_too_small'
        with open(path, 'rb') as f:
            head = f.read(33)
            f.seek(-12, os.SEEK_END)
            tail = f.read(12)
    except OSError as e:
        return f'unreadable:{e.__class__.__name__}'
    if head[:8] != PNG_SIG:
        return 'png_bad_signature'
    length, kind = struct.unpack('>I4s', head[8:16])
    if kind != b'IHDR' or length != 13:
        return 'png_ihdr_missing'
    data, crc = head[16:29], struct.unpack('>I', head[29:33])[0]
    if zlib.crc32(kind + data) & 0xffffffff != crc:
        return 'png_ihdr_crc'
    w, h, depth, ctype, comp, filt, inter = struct.unpack('>IIBBBBB', data)
    valid = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
    if not w or not h or depth not in valid.get(ctype, ()) or comp or filt or inter > 1:
        return 'png_ihdr_invalid'
    if tail != PNG_IEND:
        return 'png_truncated_no_iend'
    return None


def ffprobe(path):
    """Read-only container/stream probe (no decode). Never raises."""
    exe = shutil.which('ffprobe')
    if not exe:
        return {'ok': False, 'error': 'ffprobe_not_found'}
    try:
        r = subprocess.run([exe, '-v', 'error', '-show_entries',
                            'format=duration:stream=index,codec_type,codec_name,avg_frame_rate,nb_frames,width,height',
                            '-of', 'json', str(path)],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=FFPROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'ffprobe_timeout'}
    except OSError as e:
        return {'ok': False, 'error': f'ffprobe_oserror:{e.__class__.__name__}'}
    if r.returncode:
        return {'ok': False, 'error': 'ffprobe_failed', 'stderr': r.stderr.decode(errors='replace')[-300:]}
    try:
        info = json.loads(r.stdout or b'{}')
        streams = info.get('streams', [])
        video = next((s for s in streams if s.get('codec_type') == 'video'), None)
        audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
        duration = float(info.get('format', {}).get('duration'))
    except (ValueError, TypeError):
        return {'ok': False, 'error': 'ffprobe_unparseable'}
    fps = None
    if video and video.get('avg_frame_rate', '0/0') not in ('0/0', ''):
        num, _, den = video['avg_frame_rate'].partition('/')
        try:
            fps = round(float(num) / float(den or 1), 3)
        except (ValueError, ZeroDivisionError):
            fps = None
    frames = None
    if video and str(video.get('nb_frames', '')).isdigit():
        frames = int(video['nb_frames'])
    return {'ok': bool(video), 'error': None if video else 'no_video_stream', 'duration': round(duration, 3),
            'fps': fps, 'frame_count': frames, 'has_audio': bool(audio),
            'video_codec': video and video.get('codec_name'), 'audio_codec': audio and audio.get('codec_name'),
            'width': video and video.get('width'), 'height': video and video.get('height')}


def _load_json(path):
    try:
        with open(path, 'rb') as f:
            return json.loads(f.read().decode('utf-8')), None
    except (OSError, ValueError) as e:
        return None, e.__class__.__name__


def _num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


# ---------- per-walkthrough inventory ----------

class _Roots:
    def __init__(self, repo):
        self.repo = _real(repo)
        if not self.repo.is_dir():
            raise ValueError(f'repo not a directory: {repo}')
        self.scripts = self.repo / 'scripts'
        out = self.repo / 'out'
        if not _within(out, self.repo):
            raise ValueError('out/ resolves outside the repository')
        self.out = _real(out)
        self.recordings = self.out / '_recordings'


def _expected_caption(script, step):
    narration = step.get('narration') or ''
    return ((narration if script.get('captionsFromNarration') else step.get('caption')) or narration or '')


def inventory_item(roots, name, probe_media=False, stat_log=None):
    stat_log = stat_log if stat_log is not None else {}
    blockers, warnings = set(), set()

    def note_stat(p):
        stat_log.setdefault(str(p), _stat(p))

    item = {'name': name, 'script_file': f'scripts/{name}.script.json'}
    sp = _within(roots.scripts / f'{name}.script.json', roots.scripts)
    script, err = (None, 'path_escape') if sp is None else _load_json(sp)
    if not isinstance(script, dict) or not isinstance(script.get('steps'), list):
        item.update({'error': err or 'not_a_script', 'blockers': ['path_escape' if err == 'path_escape' else 'script_unreadable']})
        return _finish(item, set(item['blockers']), warnings, None)
    steps = [s if isinstance(s, dict) else {} for s in script['steps']]
    fx = bool(script.get('fx'))
    item.update({'title': script.get('title'), 'module': script.get('module'), 'fx': fx,
                 'script_name_field_matches': script.get('name') == name,
                 'ids': {'driveVideoId': script.get('driveVideoId') or None,
                         'pylonArticleId': script.get('pylonArticleId') or None}})
    if not item['script_name_field_matches']:
        warnings.add('script_name_field_differs_from_filename')
    if not item['ids']['driveVideoId']:
        blockers.add('missing_drive_video_id')
    if not item['ids']['pylonArticleId']:
        blockers.add('missing_pylon_article_id')

    # stable IDs
    with_id = sum(1 for s in steps if isinstance(s.get('id'), str) and s['id'])
    item['stable_ids'] = {'steps_with_id': with_id, 'all_steps_have_id': bool(steps) and with_id == len(steps)}
    if not item['stable_ids']['all_steps_have_id']:
        warnings.add('no_stable_step_ids_identify_local_copy_first')

    # recording + captures
    rec = script.get('recording') if isinstance(script.get('recording'), dict) else {}
    rid = rec.get('id')
    rec_dir = None
    if not rid:
        blockers.add('no_recording_id')
    elif not _safe_flat_name(rid) or not _within(roots.recordings / rid, roots.recordings):
        blockers.add('path_escape')
    else:
        rec_dir = _real(roots.recordings / rid)
    item['recording'] = {'id': rid if isinstance(rid, str) else None,
                         'dir_present': bool(rec_dir and rec_dir.is_dir())}
    if rid and rec_dir is not None and not item['recording']['dir_present']:
        blockers.add('recording_dir_missing')

    caps = {'missing': [], 'invalid': [], 'missing_ref_steps': [], 'unsupported_ref_steps': [],
            'capture_id_mismatch': [], 'duplicate_refs': {}}
    expected = []  # steps from-recording.mjs would turn into slides (in order)
    refs = collections.defaultdict(list)
    valid = 0
    checked = {}
    for pos, s in enumerate(steps):
        idx = s.get('index', pos)
        if s.get('capture') is False:
            continue
        media = s.get('media')
        pre = media.get('pre') if isinstance(media, dict) else None
        if media is not None and not isinstance(media, dict) or (isinstance(media, dict) and pre is not None and not isinstance(pre, str)):
            caps['unsupported_ref_steps'].append(idx)
            continue
        if not pre:
            caps['missing_ref_steps'].append(idx)
            continue
        expected.append((idx, s, pre))
        refs[pre].append(idx)
        cid = s.get('captureId')
        if cid is not None and pre != f'step_{cid}.png':
            caps['capture_id_mismatch'].append(idx)
        if pre in checked:
            continue
        if not _safe_flat_name(pre):
            checked[pre] = 'unsafe_filename'
        elif rec_dir is None or not item['recording']['dir_present']:
            checked[pre] = 'missing'
        else:
            raw = rec_dir / pre
            if not os.path.lexists(raw):
                checked[pre] = 'missing'
            elif not _within(raw, rec_dir):
                checked[pre] = 'path_escape'
            elif not _real(raw).is_file():
                checked[pre] = 'not_a_regular_file'
            else:
                note_stat(_real(raw))
                checked[pre] = png_problem(_real(raw))
        problem = checked[pre]
        if problem == 'missing':
            caps['missing'].append(pre)
        elif problem:
            caps['invalid'].append({'step': idx, 'file': pre, 'reason': problem})
        else:
            valid += 1
    caps['duplicate_refs'] = {k: v for k, v in refs.items() if len(v) > 1}
    if caps['missing']:
        blockers.add('missing_capture')
    if caps['missing_ref_steps']:
        blockers.add('missing_capture_ref')
    if caps['unsupported_ref_steps']:
        blockers.add('unsupported_media_ref')
    if caps['invalid']:
        blockers.add('invalid_capture')
        if any(x['reason'] == 'path_escape' for x in caps['invalid']):
            blockers.add('path_escape')
    if caps['capture_id_mismatch'] or caps['duplicate_refs']:
        blockers.add('ambiguous_capture_ref')
    if not expected:
        blockers.add('no_captures')
    item['captures'] = caps
    item['counts'] = {'steps': len(steps), 'capture_steps': sum(1 for s in steps if s.get('capture') is not False),
                      'expected_slides': len(expected), 'unique_capture_refs': len(refs), 'captures_valid': valid,
                      'narrated_steps': sum(1 for s in steps if (s.get('narration') or '').strip())}
    candidate_blockers = blockers & {'no_recording_id', 'recording_dir_missing', 'path_escape', 'missing_capture',
                                     'missing_capture_ref', 'unsupported_media_ref', 'invalid_capture',
                                     'ambiguous_capture_ref', 'no_captures'}
    candidate_ready = not candidate_blockers

    # local out dir
    od_raw = roots.out / name
    od = _within(od_raw, roots.out) if os.path.lexists(od_raw) else None
    if os.path.lexists(od_raw) and od is None:
        blockers.add('path_escape')
    od_ok = bool(od and od.is_dir())
    lo = {'dir': od_ok, 'report': False, 'assembly': False, 'render_key': False, 'build_segments': 0}
    assembly = None
    if od_ok:
        for key, fname in (('report', 'report.json'), ('assembly', 'assembly.json'), ('render_key', 'render-key.json')):
            p = _within(od / fname, od)
            lo[key] = bool(p and p.is_file())
            if os.path.lexists(od / fname) and p is None:
                blockers.add('path_escape')
        b = _within(od / '_build', od)
        if b and b.is_dir():
            lo['build_segments'] = sum(1 for f in os.listdir(b) if f.startswith('seg') and f.endswith('.mp4'))
        if lo['assembly']:
            assembly, aerr = _load_json(od / 'assembly.json')
            if not isinstance(assembly, dict) or not isinstance(assembly.get('slides'), list):
                assembly = None
                blockers.add('assembly_unreadable')
    else:
        blockers.add('missing_out_dir')
    if od_ok and not lo['report']:
        blockers.add('missing_report')
    if od_ok and not lo['assembly']:
        blockers.add('missing_assembly')
    if od_ok and not lo['render_key']:
        warnings.add('no_render_key')
    item['local_out'] = lo

    # final MP4
    fm = {'present': False, 'size': None, 'probe': None, 'assembly_video_name_matches': None}
    if od_ok:
        mp = od / f'{name}.mp4'
        mpr = _within(mp, od) if os.path.lexists(mp) else None
        if os.path.lexists(mp) and mpr is None:
            blockers.add('path_escape')
        if mpr and mpr.is_file() and os.path.getsize(mpr) > 0:
            note_stat(mpr)
            fm['present'] = True
            fm['size'] = os.path.getsize(mpr)
            if probe_media:
                fm['probe'] = ffprobe(mpr)
    if assembly is not None and isinstance(assembly.get('video'), str):
        fm['assembly_video_name_matches'] = os.path.basename(assembly['video']) == f'{name}.mp4'
        if not fm['assembly_video_name_matches']:
            warnings.add('assembly_video_name_differs')
    if not fm['present']:
        blockers.add('missing_final_mp4')
    item['final_mp4'] = fm

    # assembly <-> script mapping, timing, audio
    mapping = {'assembly_slides': None, 'expected_slides': len(expected), 'count_match': False,
               'src_or_step_mismatch_slides': [], 'narration_mismatch_slides': [],
               'caption_mismatch_slides': [], 'consistent': False}
    timing = {'available': False, 'content_offset': None, 'assembly_duration': None,
              'slides_with_start_and_sdur': 0, 'starts_monotonic': False}
    audio = {'narrated_slides': 0, 'present': 0, 'missing_slides': [], 'escaped_slides': [], 'outside_repo_slides': [],
             'outside_tts_cache': 0}
    if assembly is not None:
        slides = [x if isinstance(x, dict) else {} for x in assembly['slides']]
        mapping['assembly_slides'] = len(slides)
        mapping['count_match'] = len(slides) == len(expected)
        for k, sl in enumerate(slides):
            no = sl.get('slide', k + 1)
            if k >= len(expected):
                mapping['src_or_step_mismatch_slides'].append(no)
                continue
            idx, st, pre = expected[k]
            if sl.get('src') != pre or sl.get('step') != idx:
                mapping['src_or_step_mismatch_slides'].append(no)
            if (sl.get('narration') or '') != (st.get('narration') or ''):
                mapping['narration_mismatch_slides'].append(no)
            if (sl.get('caption') or '') != _expected_caption(script, st):
                mapping['caption_mismatch_slides'].append(no)
        mapping['legacy_no_src'] = bool(slides) and all(not sl.get('src') for sl in slides)
        mapping['consistent'] = mapping['count_match'] and not mapping['src_or_step_mismatch_slides']
        if mapping['legacy_no_src']:
            # Pre-`src` assemblies cannot be mapped to captures; name that instead of calling it drift.
            blockers.add('assembly_legacy_no_src')
        elif not mapping['consistent']:
            blockers.add('assembly_script_mismatch')
        if mapping['narration_mismatch_slides']:
            blockers.add('narration_changed_since_render')
        if mapping['caption_mismatch_slides']:
            blockers.add('caption_changed_since_render')

        co = assembly.get('content_offset')
        timing['content_offset'] = co if _num(co) else None
        timing['assembly_duration'] = assembly.get('duration') if _num(assembly.get('duration')) else None
        good = [sl for sl in slides if _num(sl.get('start')) and _num(sl.get('sdur')) and sl['sdur'] > 0]
        timing['slides_with_start_and_sdur'] = len(good)
        starts = [sl['start'] for sl in good]
        timing['starts_monotonic'] = starts == sorted(starts)
        timing['available'] = bool(slides) and len(good) == len(slides) and timing['starts_monotonic'] \
            and timing['content_offset'] is not None and timing['assembly_duration'] is not None
        if not timing['available']:
            blockers.add('timing_unavailable')

        tts_root = roots.out / '_cache' / 'tts'
        for k, sl in enumerate(slides):
            if not (sl.get('narration') or '').strip():
                continue
            no = sl.get('slide', k + 1)
            audio['narrated_slides'] += 1
            a = sl.get('audio')
            if not isinstance(a, str) or not a:
                audio['missing_slides'].append(no)
                continue
            ap = Path(os.path.normpath(a if os.path.isabs(a) else roots.repo / a))
            ar = _within(ap, roots.out)
            if ar is None:
                # Lexically outside (e.g. rendered from another checkout): refused, not stat'ed.
                # Lexically inside but resolving outside (symlink / ..): path escape.
                lexical = ap == roots.out or roots.out in ap.parents or (roots.repo / 'out') in ap.parents
                (audio['escaped_slides'] if lexical else audio['outside_repo_slides']).append(no)
                continue
            if not _within(ar, tts_root):
                audio['outside_tts_cache'] += 1
            if ar.is_file() and os.path.getsize(ar) > 0:
                note_stat(ar)
                audio['present'] += 1
            else:
                audio['missing_slides'].append(no)
        if audio['missing_slides']:
            blockers.add('narration_audio_pruned')
        if audio['escaped_slides']:
            blockers.add('path_escape')
        if audio['outside_repo_slides']:
            blockers.add('narration_audio_outside_repo')
    elif od_ok and lo['assembly']:
        pass  # assembly_unreadable already recorded
    item['mapping'], item['timing'], item['audio'] = mapping, timing, audio

    probe = fm['probe']
    if probe is not None:
        if not probe.get('ok'):
            blockers.add('final_mp4_probe_failed')
        else:
            if not probe.get('has_audio'):
                blockers.add('final_mp4_no_audio')
            ad = timing['assembly_duration']
            if ad is not None and abs(probe['duration'] - ad) > DURATION_TOLERANCE_S:
                blockers.add('final_mp4_duration_mismatch')
    item['fx'] = fx or bool(assembly and assembly.get('fx'))

    # tiers
    tiers = {}
    tiers['candidate_ready'] = {'value': candidate_ready, 'reasons': sorted(candidate_blockers) or [
        f'all {valid} referenced capture(s) present and valid PNGs; unambiguous step->capture mapping']}
    visual_need = {'missing_out_dir', 'missing_assembly', 'assembly_unreadable', 'missing_final_mp4',
                   'assembly_script_mismatch', 'assembly_legacy_no_src', 'narration_changed_since_render', 'caption_changed_since_render',
                   'timing_unavailable', 'final_mp4_probe_failed', 'final_mp4_no_audio', 'final_mp4_duration_mismatch'}
    vb = sorted(blockers & visual_need) + ([] if candidate_ready else ['not_candidate_ready'])
    ok_v = [f'final MP4 present; assembly maps {len(expected)} slide(s) 1:1 to script captures with current narration/captions; start/sdur/content_offset present']
    if probe is not None and probe.get('ok'):
        ok_v.append(f"ffprobe duration {probe['duration']}s within {DURATION_TOLERANCE_S}s of assembly {timing['assembly_duration']}s")
    elif probe is None:
        ok_v.append('final MP4 not probed (run with --probe-media)')
    tiers['visual_render_evidence'] = {'value': not vb, 'reasons': vb or ok_v}
    ab = []
    if assembly is None:
        ab.append('no_readable_assembly_referencing_takes')
    if audio['missing_slides']:
        ab.append(f"narration_audio_pruned: slides {audio['missing_slides']}")
    if audio['escaped_slides']:
        ab.append(f"audio_path_escape: slides {audio['escaped_slides']}")
    if audio['outside_repo_slides']:
        ab.append(f"narration_audio_outside_repo (rendered from another checkout; not read): slides {audio['outside_repo_slides']}")
    ok_a = [f"{audio['present']}/{audio['narrated_slides']} narrated slide take(s) still on disk"]
    if mapping['narration_mismatch_slides']:
        ok_a.append('note: takes are for the narration as rendered, which differs from the current script')
    tiers['audio_takes_recoverable'] = {'value': not ab, 'reasons': ab or ok_a}
    item['tiers'] = tiers
    return _finish(item, blockers, warnings, tiers)


def _finish(item, blockers, warnings, tiers):
    if tiers is None:
        item['tiers'] = {t: {'value': False, 'reasons': ['script_unreadable']} for t in TIERS}
    item['strict_exact_preservation_ready'] = {'value': False, 'reasons': [STRICT_REASON]}
    item['blockers'] = sorted(blockers)
    item['warnings'] = sorted(warnings)
    return item


# ---------- whole-repo inventory ----------

def _check_only(only):
    if only is not None and (not _safe_flat_name(only) or only.startswith('.')):
        raise ValueError(f'invalid --only name: {only!r}')


def enumerate_scripts(roots):
    files = sorted(f for f in os.listdir(roots.scripts) if f.endswith('.script.json')) if roots.scripts.is_dir() else []
    names = [f[:-len('.script.json')] for f in files]
    internal = [n for n in names if n.startswith(INTERNAL_PREFIX)]
    return files, [n for n in names if not n.startswith(INTERNAL_PREFIX)], internal


def rank_pilots(items, limit=10):
    pool = [x for x in items if all(x['tiers'][t]['value'] for t in TIERS)
            and x.get('ids', {}).get('driveVideoId') and x.get('ids', {}).get('pylonArticleId')]
    pool.sort(key=lambda x: (x['fx'], x['counts']['steps'], x['name']))
    out = []
    for rank, x in enumerate(pool[:limit], 1):
        reasons = ['candidate_ready', 'visual_render_evidence', 'audio_takes_recoverable',
                   'has driveVideoId and pylonArticleId',
                   f"{x['counts']['steps']} steps / {x['counts']['expected_slides']} slides",
                   'no FX (simpler timeline)' if not x['fx'] else 'FX enabled (camera moves; harder to match)']
        p = x['final_mp4'].get('probe')
        if p and p.get('ok'):
            reasons.append(f"probed {p['duration']}s @ {p['fps']} fps, {p['frame_count']} frames, audio={p['has_audio']}")
        if x['warnings']:
            reasons.append('warnings: ' + ', '.join(x['warnings']))
        out.append({'rank': rank, 'name': x['name'], 'title': x.get('title'), 'module': x.get('module'),
                    'steps': x['counts']['steps'], 'fx': x['fx'], 'driveVideoId': x['ids']['driveVideoId'],
                    'pylonArticleId': x['ids']['pylonArticleId'], 'reasons': reasons})
    return out


def summarize(items, files, internal, enumerated, pilots, probe_media):
    blockers = collections.Counter(b for x in items for b in x['blockers'])
    warnings = collections.Counter(w for x in items for w in x['warnings'])
    s = {
        'counts': {'script_files_found': len(files), 'excluded_internal': internal,
                   'walkthroughs_enumerated': len(enumerated), 'items_in_inventory': len(items),
                   'enumerated_equals_inventory': len(enumerated) == len(items)},
        'tiers': {t: sum(1 for x in items if x['tiers'][t]['value']) for t in TIERS},
        'all_three_tiers': sum(1 for x in items if all(x['tiers'][t]['value'] for t in TIERS)),
        'strict_exact_preservation_ready': sum(1 for x in items if x['strict_exact_preservation_ready']['value']),
        'pilot_eligible': None, 'pilot_candidates_listed': len(pilots),
        'blockers': dict(sorted(blockers.items(), key=lambda kv: (-kv[1], kv[0]))),
        'warnings': dict(sorted(warnings.items(), key=lambda kv: (-kv[1], kv[0]))),
        'local': {k: sum(1 for x in items if x.get('local_out', {}).get(k)) for k in ('dir', 'report', 'assembly', 'render_key')},
        'final_mp4_present': sum(1 for x in items if x.get('final_mp4', {}).get('present')),
        'ids': {'driveVideoId': sum(1 for x in items if x.get('ids', {}).get('driveVideoId')),
                'pylonArticleId': sum(1 for x in items if x.get('ids', {}).get('pylonArticleId')),
                'driveVideoId_without_local_mp4': sum(1 for x in items if x.get('ids', {}).get('driveVideoId')
                                                      and not x.get('final_mp4', {}).get('present'))},
        'fx': sum(1 for x in items if x.get('fx')),
        'stable_ids_all_steps': sum(1 for x in items if x.get('stable_ids', {}).get('all_steps_have_id')),
        'probe_media': probe_media,
    }
    if probe_media:
        probes = [x['final_mp4']['probe'] for x in items if x.get('final_mp4', {}).get('probe') is not None]
        s['probe'] = {'probed': len(probes), 'ok': sum(1 for p in probes if p.get('ok')),
                      'errors': dict(collections.Counter(p['error'] for p in probes if not p.get('ok')))}
    s['pilot_eligible'] = sum(1 for x in items if all(x['tiers'][t]['value'] for t in TIERS)
                              and x.get('ids', {}).get('driveVideoId') and x.get('ids', {}).get('pylonArticleId'))
    return s


def build_inventory(repo, only=None, probe_media=False, stat_log=None):
    _check_only(only)
    roots = _Roots(repo)
    files, enumerated, internal = enumerate_scripts(roots)
    if only is not None:
        if only.startswith(INTERNAL_PREFIX) or only not in enumerated:
            raise ValueError(f'no walkthrough named {only!r}')
        enumerated = [only]
    stat_log = stat_log if stat_log is not None else {}
    items = [inventory_item(roots, n, probe_media, stat_log) for n in enumerated]
    pilots = rank_pilots(items)
    return {'items': items, 'pilot_candidates': pilots,
            'summary': summarize(items, files, internal, enumerated, pilots, probe_media)}


def json_sources(repo, names):
    """Script JSON + the per-video report/assembly/render-key JSON the inventory reads (hash-checked)."""
    roots = _Roots(repo)
    files, _, _ = enumerate_scripts(roots)
    paths = [roots.scripts / f for f in files]
    for n in names:
        for f in ('report.json', 'assembly.json', 'render-key.json'):
            p = roots.out / n / f
            if os.path.lexists(p):
                paths.append(p)
    return paths


# ---------- CLI ----------

def _write_new(path, obj):
    with open(path, 'x', encoding='utf-8') as f:
        json.dump(obj, f, indent=1, sort_keys=False)
        f.write('\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description='READ-ONLY baseline inventory of existing Hadrius Studio walkthroughs.')
    ap.add_argument('--repo', required=True)
    ap.add_argument('--output', required=True, help='NEW directory (must not exist) outside the repo')
    ap.add_argument('--only')
    ap.add_argument('--probe-media', action='store_true')
    a = ap.parse_args(argv)
    try:
        roots = _Roots(a.repo)
        _check_only(a.only)
    except ValueError as e:
        ap.error(str(e))
    output = Path(os.path.abspath(a.output))
    if os.path.lexists(output):
        ap.error(f'output already exists: {output}')
    parent = _real(output.parent)
    if not parent.is_dir():
        ap.error(f'output parent does not exist: {output.parent}')
    target = parent / output.name
    if _within(target, roots.repo) or _within(target, roots.out):
        ap.error('output must be outside the repository and out/ roots')

    _, enumerated, _ = enumerate_scripts(roots)
    names = [a.only] if a.only else enumerated
    hashed_before = snapshot(json_sources(roots.repo, names))
    stat_log = {}
    try:
        inv = build_inventory(roots.repo, only=a.only, probe_media=a.probe_media, stat_log=stat_log)
    except ValueError as e:
        ap.error(str(e))
    hashed_after = snapshot(hashed_before.keys())
    stat_after = {p: _stat(p) for p in stat_log}
    changed = sorted([p for p in hashed_before if hashed_before[p] != hashed_after.get(p)]
                     + [p for p in stat_log if stat_log[p] != stat_after[p]])
    check = {'unchanged': not changed, 'files_checked': len(hashed_before) + len(stat_log),
             'hashed_json_files': len(hashed_before), 'stat_checked_media_files': len(stat_log),
             'method': 'sha256+size+mtime_ns for JSON; size+mtime_ns for PNG/MP4/MP3 read during the run',
             'changed': changed}

    os.mkdir(target)
    meta = {'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'repo': str(roots.repo), 'only': a.only, 'probe_media': a.probe_media, 'read_only': True}
    _write_new(target / 'inventory.json', {**meta, 'items': inv['items']})
    _write_new(target / 'summary.json', {**meta, **inv['summary']})
    _write_new(target / 'pilot_candidates.json', {**meta, 'pilot_candidates': inv['pilot_candidates']})
    _write_new(target / 'source_check.json', check)
    print(json.dumps({'output': str(target), 'items': len(inv['items']), 'tiers': inv['summary']['tiers'],
                      'pilot_candidates': [p['name'] for p in inv['pilot_candidates']],
                      'source_unchanged': check['unchanged']}, indent=1))
    return 0 if check['unchanged'] else 3


if __name__ == '__main__':
    sys.exit(main())
