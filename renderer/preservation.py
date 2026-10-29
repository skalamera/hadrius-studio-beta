"""Import-safe verifier for LOCAL synthetic fixed-timeline media only.
Approval is a trusted caller input, not authentication or a production approval service.
"""
import hashlib
import json
import subprocess
from pathlib import Path


def run(*args):
    return subprocess.check_output([str(x) for x in args], stderr=subprocess.PIPE, timeout=60)


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def probe(path, *options):
    return json.loads(run('ffprobe', '-v', 'error', '-show_streams', '-show_data_hash', 'sha256', *options, '-of', 'json', path))


def toolchain():
    return {x: run(x, '-version').decode().splitlines()[0] for x in ('ffmpeg', 'ffprobe')}


def frames(path):
    text = run('ffmpeg', '-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-an', '-c:v', 'rawvideo', '-fps_mode', 'passthrough', '-f', 'framehash', '-hash', 'sha256', '-').decode()
    headers = [x for x in text.splitlines() if x.startswith(('#tb ', '#dimensions ', '#sar '))]
    rows = [tuple(y.strip() for y in x.split(',')) for x in text.splitlines() if x and not x.startswith('#')]
    if not rows or not headers:
        raise ValueError('missing_frame_evidence')
    return headers, rows


def audio(path):
    packets = probe(path, '-select_streams', 'a:0', '-show_packets')['packets']
    fields = ('pts', 'dts', 'duration', 'size', 'flags', 'data_hash')
    if not packets or any(any(k not in p for k in fields) for p in packets):
        raise ValueError('incomplete_audio_evidence')
    packets = [{**{k: p[k] for k in fields}, 'side_data_list': p.get('side_data_list', [])} for p in packets]
    pcm = run('ffmpeg', '-v', 'error', '-xerror', '-i', path, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', '-')
    if not pcm:
        raise ValueError('missing_pcm')
    return packets, {'sha256': hashlib.sha256(pcm).hexdigest(), 'bytes': len(pcm)}


def load_scope(manifest_path, approval):
    if set(approval) != {'baselineManifestHash', 'renderProfileHash', 'changedStepIds'}:
        raise ValueError('invalid_approval_fields')
    if file_hash(manifest_path) != approval['baselineManifestHash']:
        raise ValueError('manifest_conflict')
    m = json.loads(Path(manifest_path).read_bytes())
    if m['profile'] not in ('local-synthetic-h264-holds-v1', 'local-synthetic-h264-dissolves-v1', 'legacy-fx-rebaseline-h264-1080p30-v1') or m['toolchain'] != toolchain():
        raise ValueError('unsupported_profile_or_toolchain')
    if approval['renderProfileHash'] != m['profileHash']:
        raise ValueError('profile_conflict')
    ids = [s['id'] for s in m['steps']]
    changed = approval['changedStepIds']
    if not isinstance(changed, list) or len(set(ids)) != len(ids) or len(set(changed)) != len(changed) or not set(changed) <= set(ids):
        raise ValueError('invalid_approved_step_set')
    cursor, dirty, cell_ids, covered = 0, [], set(), set()
    for c in m['cells']:
        a, b, deps = c['startFrame'], c['endFrame'], c['dependsOn']
        if (type(a) is not int or type(b) is not int or a != cursor or b <= a or b > m['frameCount'] or c['id'] in cell_ids or not deps or len(set(deps)) != len(deps) or not set(deps) <= set(ids)):
            raise ValueError('invalid_cell_partition')
        cell_ids.add(c['id']); covered.update(deps)
        if set(deps) & set(changed):
            dirty.append((a, b))
        cursor = b
    if cursor != m['frameCount'] or covered != set(ids):
        raise ValueError('incomplete_cell_partition')
    if m['profile'] == 'legacy-fx-rebaseline-h264-1080p30-v1':
        # One-time local rebaseline of a real FX walkthrough: cells must equal the FX timeline that
        # renderer.fx_scope derives from the pinned (hash-bound) copy of its assembly.json.
        from .rebaseline import validate_manifest
        validate_manifest(m, Path(manifest_path).resolve().parent)
        return m, dirty
    if m['profile'] == 'local-synthetic-h264-dissolves-v1':
        from .transitions import topology, profile
        expected_hash = hashlib.sha256(json.dumps(profile(), sort_keys=True).encode()).hexdigest()
        expected = topology(ids) if len(ids) == 3 else []
        if (m.get('schema') != 1 or m['frameCount'] != 84 or m['profileHash'] != expected_hash
                or len(m['cells']) != len(expected)
                or any(any(c.get(k) != e[k] for k in e) for c, e in zip(m['cells'], expected))):
            raise ValueError('unsupported_synthetic_transition_partition')
        return m, dirty
    # Only the demonstrated three hard-cut holds are supported. No implicit FX,
    # transition closure, cards, variable durations or legacy enrollment.
    if (m.get('schema') != 1 or m['frameCount'] != 36 or len(ids) != 3
            or len(m['cells']) != 3
            or any(c['startFrame'] != i * 12 or c['endFrame'] != (i + 1) * 12
                   or c['dependsOn'] != [ids[i]] for i, c in enumerate(m['cells']))):
        raise ValueError('unsupported_synthetic_partition')
    return m, dirty


def verify_visual_update(before, after, manifest_path, approval):
    m, dirty = load_scope(manifest_path, approval)
    if file_hash(before) != m['final']['sha256']:
        raise ValueError('baseline_conflict')
    left, right = probe(before)['streams'], probe(after)['streams']
    if [s['codec_type'] for s in left] != ['video', 'audio'] or [s['codec_type'] for s in right] != ['video', 'audio']:
        raise ValueError('unsupported_stream_layout')
    fields = ('codec_name', 'width', 'height', 'pix_fmt', 'sample_aspect_ratio', 'avg_frame_rate', 'r_frame_rate', 'time_base', 'start_pts', 'duration_ts', 'sample_rate', 'channels', 'channel_layout', 'initial_padding', 'extradata_hash', 'color_range', 'color_space', 'color_transfer', 'color_primaries', 'field_order')
    for a, b in zip(left, right):
        if any(a.get(k) != b.get(k) for k in fields):
            raise ValueError('stream_profile_or_timing_changed')
    # Preserve native 90kHz presentation timestamps too: framehash's output
    # time base can round away sub-frame timestamp corruption.
    timing_fields = ('pts', 'best_effort_timestamp', 'duration')
    def native_timing(path):
        rows = probe(path, '-select_streams', 'v:0', '-show_frames')['frames']
        if not rows or any('pts' not in r or 'duration' not in r for r in rows):
            raise ValueError('missing_native_frame_timing')
        return [tuple(r.get(k) for k in timing_fields) for r in rows]
    if native_timing(before) != native_timing(after):
        raise ValueError('presentation_timing_changed')
    lh, lf = frames(before); rh, rf = frames(after)
    if lh != rh or len(lf) != m['frameCount'] or len(rf) != len(lf):
        raise ValueError('frame_count_or_geometry_changed')
    for i, (a, b) in enumerate(zip(lf, rf)):
        if a[:4] != b[:4]:
            raise ValueError('presentation_timing_changed')
        if not any(x <= i < y for x, y in dirty) and a != b:
            raise ValueError('protected_frame_changed')
    ap, ac = audio(before); bp, bc = audio(after)
    if ap != bp:
        raise ValueError('audio_packet_or_priming_changed')
    if ac != bc:
        raise ValueError('protected_audio_changed')
    if not dirty and file_hash(before) != file_hash(after):
        raise ValueError('no_op_must_reuse_original_file')
    return {'protected_frames_equal': True, 'protected_frame_count': sum(not any(a <= i < b for a, b in dirty) for i in range(len(lf))), 'complete_audio_equal': True, 'audio_packets_and_timing_equal': True, 'audio_packet_count': len(ap), 'pcm': ac, 'dirty_frames': dirty, 'baseline_sha256': file_hash(before), 'candidate_sha256': file_hash(after)}
