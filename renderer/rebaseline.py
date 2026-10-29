"""LOCAL one-time rebaseline of an existing Extra FX walkthrough into independently decodable cells.

    TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.rebaseline \
        --repo /path/to/hadrius-studio --name <script-name> --output $TMPDIR/NEW-directory

Reads out/<name>/assembly.json and out/<name>/<name>.mp4 READ-ONLY (sha256/size/mtime snapshotted before
and after). Never imports assemble.py/tts.py, never renders new content, never calls TTS, network,
Drive, Pylon or the bridge. Everything is written into a NEW directory under TMPDIR, outside the repo.

The ORIGINAL decoded frames are re-encoded (a disclosed lossy re-encode, not bit-identical) per cell
of the renderer.fx_scope timeline with one fixed delivery profile (IDR at every cell start, no
B-frames, closed GOP, zero-based 1/15360 timestamps like the original), concatenated by stream copy,
and the ORIGINAL audio stream is remuxed by stream copy. The pinned baseline-manifest.json is usable
by renderer.preservation (profile LEGACY_FX_PROFILE).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import fx_scope
from .preservation import probe, toolchain, file_hash, frames, audio, load_scope, verify_visual_update

PROFILE_NAME = 'legacy-fx-rebaseline-h264-1080p30-v1'
W, H, FPS, TIMESCALE, GOP = 1920, 1080, 30, 15360, 300
TICKS = TIMESCALE // FPS  # 512
ENCODE = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', str(GOP), '-bf', '0',
          '-x264-params', 'scenecut=0:open-gop=0', '-video_track_timescale', str(TIMESCALE)]
SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def sh(*args, timeout=600, cwd=None):
    return subprocess.check_output([str(x) for x in args], stderr=subprocess.PIPE, timeout=timeout, cwd=cwd)


def profile():
    return {'name': PROFILE_NAME, 'width': W, 'height': H, 'fps': f'{FPS}/1', 'timescale': TIMESCALE, 'gop': GOP,
            'encode': ENCODE, 'audio': 'original stream copy', 'toolchain': toolchain()}


def profile_hash():
    return hashlib.sha256(json.dumps(profile(), sort_keys=True).encode()).hexdigest()


def snapshot(paths):
    return {str(p): {'sha256': fx_scope.sha256_file(p), 'size': p.stat().st_size, 'mtime_ns': p.stat().st_mtime_ns} for p in paths}


def new_output(path, repo):
    p = Path(path).absolute()
    root = Path(os.environ['TMPDIR']).resolve()
    if not p.parent.resolve().is_relative_to(root):
        raise ValueError('output_must_be_under_TMPDIR')
    if p.parent.resolve().is_relative_to(Path(repo).resolve()):
        raise ValueError('output_inside_repo')
    p.mkdir()  # exclusive: the caller supplies a NEW directory with an existing parent
    return p


# ---------- media ----------

def count_frames(path):
    out = sh('ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path, timeout=120)
    return int(out.decode().strip().rstrip(','))


def native_timing(path):
    rows = probe(path, '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=pts,duration,key_frame,pict_type')['frames']
    return rows


def encode_cell(source, a, b, output, vf=None):
    chain = f'trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS' + (f',{vf}' if vf else '')
    sh('ffmpeg', '-nostdin', '-v', 'error', '-i', source, '-map', '0:v:0', '-an', '-vf', chain, *ENCODE, output)


def cell_signature(path, n):
    info = probe(path)
    if len(info['streams']) != 1:
        raise ValueError('unsupported_cell_streams')
    s = info['streams'][0]
    if (s['codec_name'] != 'h264' or s['width'] != W or s['height'] != H or s['pix_fmt'] != 'yuv420p' or s['time_base'] != f'1/{TIMESCALE}'
            or s['r_frame_rate'] != f'{FPS}/1' or s.get('has_b_frames') != 0 or s.get('start_pts') != 0):
        raise ValueError('unsupported_cell_profile')
    packets = probe(path, '-show_packets')['packets']
    if len(packets) != n or 'K' not in packets[0]['flags']:
        raise ValueError('unsupported_cell_profile')
    for i, p in enumerate(packets):
        if int(p['pts']) != i * TICKS or p['pts'] != p['dts'] or int(p['duration']) != TICKS:
            raise ValueError('invalid_cell_timing')
    if len(frames(path)[1]) != n:
        raise ValueError('invalid_cell_decode')
    return {k: s.get(k) for k in ('codec_name', 'profile', 'level', 'width', 'height', 'pix_fmt', 'time_base', 'r_frame_rate', 'extradata_hash')}


def concat(cells, output):
    if any("'" in str(p) or '\n' in str(p) for p in cells):
        raise ValueError('unsafe_concat_path')
    listing = output.with_suffix('.concat.txt')
    listing.write_text(''.join("file '" + str(Path(p).resolve()) + "'\n" for p in cells))
    sh('ffmpeg', '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listing, '-map', '0:v:0', '-c', 'copy', '-video_track_timescale', str(TIMESCALE), output)
    listing.unlink()


def mux(video, audio_source, output):
    sh('ffmpeg', '-nostdin', '-v', 'error', '-i', video, '-i', audio_source, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
        '-video_track_timescale', str(TIMESCALE), '-movflags', '+faststart', output)


# ---------- manifest ----------

def validate_manifest(m, root):
    """Called by preservation.load_scope for PROFILE_NAME: bind cells to the pinned assembly's FX timeline."""
    if m.get('schema') != 1 or m.get('profileHash') != profile_hash():
        raise ValueError('unsupported_rebaseline_profile')
    a_path = Path(root) / m['assembly']['file']
    if Path(m['assembly']['file']).name != m['assembly']['file'] or fx_scope.sha256_file(a_path) != m['assembly']['sha256']:
        raise ValueError('assembly_conflict')
    tl = fx_scope.timeline(json.loads(a_path.read_bytes()), m['frameCount'])
    keys = ('id', 'kind', 'dependsOn', 'startFrame', 'endFrame')
    if ([{k: c.get(k) for k in keys} for c in m['cells']] != [{k: c[k] for k in keys} for c in tl['cells']]
            or [s['id'] for s in m['steps']] != tl['steps']):
        raise ValueError('cells_do_not_match_fx_timeline')
    for c in m['cells']:
        if Path(c['file']).name != c['file']:
            raise ValueError('unsafe_cell_path')


def assemble_candidate(manifest_path, approval, replacements, output):
    """Copy protected cells byte-for-byte, splice approved replacements, concat, remux the baseline audio."""
    m, dirty = load_scope(manifest_path, approval)
    root = Path(manifest_path).resolve().parent
    before = root / m['final']['file']
    if file_hash(before) != m['final']['sha256']:
        raise ValueError('baseline_conflict')
    expected = {c['id'] for c in m['cells'] if set(c['dependsOn']) & set(approval['changedStepIds'])}
    if set(replacements) != expected:
        raise ValueError('replacement_scope_mismatch')
    signature, chosen = None, []
    for c in m['cells']:
        old = root / c['file']
        if file_hash(old) != c['sha256']:
            raise ValueError('corrupt_cell')
        n = c['endFrame'] - c['startFrame']
        sig = cell_signature(old, n)
        signature = signature or sig
        if sig != signature:
            raise ValueError('incompatible_cell')
        new = Path(replacements[c['id']]) if c['id'] in expected else old
        if cell_signature(new, n) != signature:
            raise ValueError('incompatible_replacement')
        chosen.append(new)
    out = Path(output)
    out.mkdir()
    if not dirty:
        report = verify_visual_update(before, before, manifest_path, approval)
        report['artifact'] = str(before)  # the original artifact itself; a no-op never remuxes
        return report
    reused = []
    for c, src in zip(m['cells'], chosen):
        dst = out / c['file']
        shutil.copyfile(src, dst)
        if c['id'] not in expected:
            if file_hash(dst) != c['sha256']:
                raise ValueError('copy_mismatch')
            reused.append(c['id'])
    concat([out / c['file'] for c in m['cells']], out / 'candidate-video.mp4')
    mux(out / 'candidate-video.mp4', before, out / 'candidate.mp4')
    report = verify_visual_update(before, out / 'candidate.mp4', manifest_path, approval)
    report.update(artifact=str(out / 'candidate.mp4'), reused_cells=reused)
    return report


# ---------- verification helpers ----------

def fidelity(original, rebuilt, workdir):
    """Per-frame PSNR/SSIM of rebuilt vs original (ffmpeg psnr/ssim filters)."""
    sh('ffmpeg', '-nostdin', '-v', 'error', '-i', original, '-i', rebuilt, '-lavfi',
        '[0:v]settb=1/15360,setpts=PTS-STARTPTS,split[a0][a1];[1:v]settb=1/15360,setpts=PTS-STARTPTS,split[b0][b1];'
        '[a0][b0]psnr=stats_file=psnr.log;[a1][b1]ssim=stats_file=ssim.log', '-f', 'null', '-', cwd=workdir)
    psnr = [float(re.search(r'psnr_avg:(\S+)', l).group(1)) for l in (Path(workdir) / 'psnr.log').read_text().splitlines() if l.strip()]
    ssim = [float(re.search(r'All:(\S+)', l).group(1)) for l in (Path(workdir) / 'ssim.log').read_text().splitlines() if l.strip()]
    finite = [p for p in psnr if p != float('inf')]
    return {'frames_compared': len(psnr), 'ssim_frames': len(ssim),
            'psnr_min': round(min(finite), 3) if finite else float('inf'), 'psnr_mean': round(sum(finite) / len(finite), 3) if finite else float('inf'),
            'psnr_infinite_frames': len(psnr) - len(finite),
            'ssim_min': round(min(ssim), 6), 'ssim_mean': round(sum(ssim) / len(ssim), 6)}


def contact_sheet(sources, picks, output):
    """Rows: picked frames; columns: each labelled source + 4x amplified |original - rebuilt|."""
    from PIL import Image, ImageChops, ImageDraw
    import numpy as np
    tw, th = 480, 270
    idx = [i for i, _ in picks]
    expr = '+'.join(f'eq(n\\,{i})' for i in idx)
    def grab_all(path):
        raw = sh('ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-map', '0:v:0', '-vf', f'select={expr}', '-fps_mode', 'passthrough',
                 '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-')
        size = W * H * 3
        if len(raw) != size * len(idx):
            raise ValueError('contact_sheet_frame_count')
        return [Image.frombytes('RGB', (W, H), raw[k * size:(k + 1) * size]) for k in range(len(idx))]
    grabbed = [grab_all(p) for _, p in sources]
    labels = [l for l, _ in sources] + ['|orig-rebuilt| x4']
    sheet = Image.new('RGB', (tw * len(labels) + 120, (th + 6) * len(picks) + 30), 'white')
    d = ImageDraw.Draw(sheet)
    for j, l in enumerate(labels):
        d.text((120 + j * tw + 6, 8), l, fill='black')
    for r, (i, why) in enumerate(picks):
        ims = [g[r] for g in grabbed]
        diff = np.clip(np.asarray(ImageChops.difference(ims[0], ims[1]), dtype=np.int32) * 4, 0, 255).astype('uint8')
        y = 30 + r * (th + 6)
        d.text((4, y + 4), f'frame {i}\n{why}', fill='black')
        for j, im in enumerate(ims + [Image.fromarray(diff)]):
            sheet.paste(im.resize((tw, th)), (120 + j * tw, y))
    sheet.save(output, quality=90)


def _err(fn):
    try:
        fn()
    except ValueError as e:
        return str(e)
    except subprocess.CalledProcessError as e:
        return 'ffmpeg_error'
    return None


# ---------- main flow ----------

def run_rebaseline(repo, name, output):
    repo = Path(repo).resolve()
    if not SAFE_NAME.match(name or ''):
        raise ValueError('unsafe_name')
    d = repo / 'out' / name
    src, a_path = d / f'{name}.mp4', d / 'assembly.json'
    if not src.is_file() or not a_path.is_file() or src.is_symlink() or a_path.is_symlink():
        raise ValueError('missing_pilot_files')
    sources = [a_path, src]
    before = snapshot(sources)
    assembly = json.loads(a_path.read_bytes())
    info = probe(src)
    kinds = [s['codec_type'] for s in info['streams']]
    v = info['streams'][0]
    if kinds != ['video', 'audio'] or v['width'] != W or v['height'] != H or v['r_frame_rate'] != f'{FPS}/1' or v['codec_name'] != 'h264':
        raise ValueError('unsupported_source_profile')
    n = count_frames(src)
    tl = fx_scope.timeline(assembly, n)  # validates timeline/FX data before anything is written
    out = new_output(output, repo)
    shutil.copyfile(a_path, out / 'baseline-assembly.json')
    cells = []
    for c in tl['cells']:
        f = f"cell-{c['id']}.mp4"
        encode_cell(src, c['startFrame'], c['endFrame'], out / f)
        cell_signature(out / f, c['endFrame'] - c['startFrame'])
        cells.append({**c, 'file': f, 'sha256': file_hash(out / f)})
    concat([out / c['file'] for c in cells], out / 'baseline-video.mp4')
    final = out / 'baseline-rebuilt.mp4'
    mux(out / 'baseline-video.mp4', src, final)
    (out / 'baseline-video.mp4').unlink()
    o_packets, o_pcm = audio(src)
    channels = int(info['streams'][1]['channels'])
    m = {'schema': 1, 'profile': PROFILE_NAME, 'profileHash': profile_hash(), 'profileSpec': profile(), 'toolchain': toolchain(),
         'frameCount': n, 'fps': FPS,
         'final': {'file': final.name, 'sha256': file_hash(final), 'size': final.stat().st_size},
         'original': {'name': name, 'file': f'out/{name}/{name}.mp4', 'sha256': before[str(src)]['sha256'], 'size': before[str(src)]['size'],
                      'videoFrames': n},
         'assembly': {'file': 'baseline-assembly.json', 'sha256': fx_scope.sha256_file(out / 'baseline-assembly.json'),
                      'source_sha256': before[str(a_path)]['sha256']},
         'audio': {'packets': len(o_packets), 'pcm_sha256': o_pcm['sha256'], 'decoded_samples_per_channel': o_pcm['bytes'] // 4 // channels,
                   'channels': channels, 'sample_rate': int(info['streams'][1]['sample_rate']), 'mode': 'original stream copy'},
         'screens': tl['screens'], 'steps': [{'id': s} for s in tl['steps']], 'cells': cells,
         'note': 'LOCAL review artifact: lossy one-time re-encode of the original frames; not uploaded'}
    manifest = out / 'baseline-manifest.json'
    manifest.write_text(json.dumps(m, indent=2) + '\n')
    mhash = file_hash(manifest)
    approval = lambda ids: {'baselineManifestHash': mhash, 'renderProfileHash': m['profileHash'], 'changedStepIds': ids}
    checks = {}

    # frames + native presentation timing
    ot, rt = native_timing(src), native_timing(final)
    r_n = count_frames(final)
    checks['frame_count'] = {'original': n, 'rebuilt': r_n, 'equal': n == r_n == len(ot) == len(rt)}
    checks['time_base'] = {'original': v['time_base'], 'rebuilt': probe(final)['streams'][0]['time_base']}
    checks['presentation_timestamps_equal'] = (checks['time_base']['original'] == checks['time_base']['rebuilt']
                                               and [(x['pts'], x['duration']) for x in ot] == [(x['pts'], x['duration']) for x in rt]
                                               and int(rt[0]['pts']) == 0)
    # audio
    r_packets, r_pcm = audio(final)
    a0 = [s for s in probe(src)['streams'] if s['codec_type'] == 'audio'][0]
    a1 = [s for s in probe(final)['streams'] if s['codec_type'] == 'audio'][0]
    akeys = ('codec_name', 'profile', 'sample_rate', 'channels', 'channel_layout', 'initial_padding', 'time_base', 'start_pts', 'duration_ts', 'extradata_hash', 'nb_frames')
    checks['audio'] = {'packets_timing_priming_equal': o_packets == r_packets, 'packet_count': len(r_packets),
                       'decoded_pcm_equal': o_pcm == r_pcm, 'pcm_sha256': r_pcm['sha256'],
                       'decoded_samples_per_channel': r_pcm['bytes'] // 4 // channels,
                       'stream_params_equal': all(a0.get(k) == a1.get(k) for k in akeys),
                       'original_sha256_stream_copy': o_packets == r_packets and o_pcm == r_pcm,
                       'priming_side_data': r_packets[0].get('side_data_list')}
    # cells
    key_idx = [i for i, x in enumerate(rt) if int(x['key_frame']) == 1]
    alone = all(len(frames(out / c['file'])[1]) == c['endFrame'] - c['startFrame'] for c in cells)
    starts_k = all('K' in probe(out / c['file'], '-show_packets', '-read_intervals', '%+#1')['packets'][0]['flags'] for c in cells)
    sigs = {json.dumps(cell_signature(out / c['file'], c['endFrame'] - c['startFrame']), sort_keys=True) for c in cells}
    checks['cells'] = {'count': len(cells), 'each_cell_starts_with_keyframe': starts_k, 'each_cell_decodes_alone': alone,
                       'no_b_frames': all(probe(out / c['file'])['streams'][0]['has_b_frames'] == 0 for c in cells),
                       'identical_signatures': len(sigs) == 1, 'rebuilt_keyframes': key_idx,
                       'keyframes_exactly_at_cell_starts_or_gop': set(c['startFrame'] for c in cells) <= set(key_idx)
                       and all(any(c['startFrame'] <= k < c['endFrame'] and (k - c['startFrame']) % GOP == 0 for c in cells) for k in key_idx),
                       'partition_gap_free': cells[0]['startFrame'] == 0 and cells[-1]['endFrame'] == n
                       and all(x['endFrame'] == y['startFrame'] for x, y in zip(cells, cells[1:]))}
    # fidelity (disclosed re-encode)
    fid = fidelity(src, final, out)
    fid['bit_identical'] = [r[-1] for r in frames(src)[1]] == [r[-1] for r in frames(final)[1]]
    checks['fidelity'] = fid
    # no-op via preservation against the NEW baseline
    noop = verify_visual_update(final, final, manifest, approval([]))
    noop_c = assemble_candidate(manifest, approval([]), {}, out / 'noop')
    checks['noop'] = {'ok': noop['candidate_sha256'] == m['final']['sha256'] and noop_c['artifact'] == str(final),
                      'candidate_sha256': noop['candidate_sha256'], 'artifact': noop_c['artifact']}
    # synthetic single-slide replacement (screenshot-only on the middle slide), scope from fx_scope
    slides = assembly['slides']
    target = fx_scope.slide_id(slides[len(slides) // 2])
    scope = fx_scope.closure(assembly, {target: {'screenshot_changed': True, 'target_changed': False}}, n)
    geo = fx_scope.closure(assembly, {target: {'screenshot_changed': False, 'target_changed': True}}, n)
    ap = approval(scope['approval_scope']['stepIds'])
    repl_dir = out / 'replacement-donors'; repl_dir.mkdir()
    repl = {}
    for c in cells:
        if c['id'] in scope['dirty_cells']:
            p = repl_dir / c['file']
            encode_cell(final, c['startFrame'], c['endFrame'], p, vf='hue=h=110:s=1.6')  # recolored copy of its own frames
            repl[c['id']] = p
    rep = assemble_candidate(manifest, ap, repl, out / 'single-slide-candidate')
    _, dirty = load_scope(manifest, ap)
    merged = fx_scope._ranges(sorted(dirty))
    cand = out / 'single-slide-candidate' / 'candidate.mp4'
    bf, cf = frames(final)[1], frames(cand)[1]
    changed = sum(1 for i, (x, y) in enumerate(zip(bf, cf)) if x != y)
    in_dirty = all(any(a <= i < b for a, b in merged) for i, (x, y) in enumerate(zip(bf, cf)) if x != y)
    checks['single_slide_replacement'] = {
        'ok': rep['protected_frames_equal'] and rep['complete_audio_equal'] and merged == scope['dirty_frames'] and in_dirty and changed > 0,
        'slide': target, 'approval_step_ids': ap['changedStepIds'], 'replaced_cells': sorted(repl),
        'dirty_frames': merged, 'fx_scope_dirty_frames': scope['dirty_frames'], 'protected_frames_equal': rep['protected_frames_equal'],
        'protected_frame_count': rep['protected_frame_count'], 'complete_audio_equal': rep['complete_audio_equal'],
        'audio_packets_and_timing_equal': rep['audio_packets_and_timing_equal'], 'dirty_frames_changed': changed,
        'all_changed_frames_inside_scope': in_dirty, 'reused_cells': rep['reused_cells'], 'candidate': rep['artifact'],
        'candidate_sha256': rep['candidate_sha256']}
    # deliberate out-of-scope frame change must be rejected
    victim = next(c for c in cells if c['id'] not in scope['dirty_cells'] and c['kind'] == 'hold')
    bad = repl_dir / f"OUT-OF-SCOPE-{victim['file']}"
    encode_cell(final, victim['startFrame'], victim['endFrame'], bad, vf='negate')
    assemble_err = _err(lambda: assemble_candidate(manifest, ap, {**repl, victim['id']: bad}, out / 'rejected-assemble'))
    forged = out / 'forged-out-of-scope'; forged.mkdir()
    parts = [repl.get(c['id'], out / c['file']) if c['id'] != victim['id'] else bad for c in cells]
    concat(parts, forged / 'video.mp4'); mux(forged / 'video.mp4', final, forged / 'candidate.mp4')
    verifier_err = _err(lambda: verify_visual_update(final, forged / 'candidate.mp4', manifest, ap))
    checks['out_of_scope'] = {'victim_cell': victim['id'], 'assemble_rejected': assemble_err, 'verifier_rejected': verifier_err,
                              'ok': assemble_err == 'replacement_scope_mismatch' and verifier_err == 'protected_frame_changed'}
    checks['scope'] = {'screenshot_only': {k: scope[k] for k in ('requested', 'approval_scope', 'scope_expansion_required', 'dirty_cells', 'dirty_frames', 'protected_frames', 'dirty_frame_count', 'protected_frame_count')},
                       'target_geometry': {k: geo[k] for k in ('requested', 'approval_scope', 'scope_expansion_required', 'expansion', 'dirty_cells', 'dirty_frames', 'protected_frames', 'dirty_frame_count', 'protected_frame_count')}}
    # review image
    picks = []
    for c in cells:
        picks.append(((c['startFrame'] + c['endFrame']) // 2, c['id']))
    contact_sheet([('original', src), ('rebuilt (re-encoded)', final), ('single-slide candidate', cand)], picks, out / 'contact-sheet.jpg')
    after = snapshot(sources)
    ok = (checks['frame_count']['equal'] and checks['presentation_timestamps_equal'] and checks['audio']['packets_timing_priming_equal']
          and checks['audio']['decoded_pcm_equal'] and checks['audio']['stream_params_equal']
          and all(checks['cells'][k] for k in ('each_cell_starts_with_keyframe', 'each_cell_decodes_alone', 'no_b_frames', 'identical_signatures', 'keyframes_exactly_at_cell_starts_or_gop', 'partition_gap_free'))
          and fid['frames_compared'] == n and checks['noop']['ok'] and checks['single_slide_replacement']['ok'] and checks['out_of_scope']['ok']
          and before == after)
    report = {'ok': bool(ok), 'name': name, 'output': str(out), 'manifest_sha256': mhash, 'final_sha256': m['final']['sha256'],
              'original_sha256': m['original']['sha256'], 'source_unchanged': before == after,
              'source_snapshot': {'before': before, 'after': after}, 'checks': checks,
              'disclosure': 'Video is a lossy re-encode of the original decoded frames (see fidelity); audio is the original stream, stream-copied.'}
    (out / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def run(repo, name, output):
    """Public alias of run_rebaseline."""
    return run_rebaseline(repo, name, output)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--repo', required=True)
    p.add_argument('--name', required=True)
    p.add_argument('--output', required=True)
    a = p.parse_args(argv)
    report = run_rebaseline(a.repo, a.name, a.output)
    print(json.dumps({k: report[k] for k in ('ok', 'output', 'final_sha256', 'manifest_sha256', 'source_unchanged')}, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
