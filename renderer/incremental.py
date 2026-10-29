"""Local synthetic harness, not an adapter for assemble.py or existing videos.
Run: python -m renderer.incremental --output NEW_DIRECTORY_UNDER_TMPDIR
"""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
from .preservation import run, probe, frames, file_hash, toolchain, load_scope, verify_visual_update


def scratch_new(path):
    p = Path(path).absolute()
    root = Path(os.environ['TMPDIR']).resolve()
    if not p.parent.resolve().is_relative_to(root):
        raise ValueError('output_must_be_under_TMPDIR')
    p.mkdir()  # exclusive; caller must supply an existing parent
    return p


def encode(image, output):
    run('ffmpeg', '-nostdin', '-v', 'error', '-loop', '1', '-framerate', '12', '-i', image, '-frames:v', '12', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '0', '-x264-params', 'scenecut=0:open-gop=0', '-video_track_timescale', '90000', output)


def cell_signature(path):
    info = probe(path)
    if len(info['streams']) != 1:
        raise ValueError('unsupported_cell_streams')
    s = info['streams'][0]
    keys = ('codec_name', 'profile', 'level', 'width', 'height', 'pix_fmt', 'time_base', 'r_frame_rate', 'extradata_hash')
    sig = {k: s.get(k) for k in keys}
    packets = probe(path, '-show_packets')['packets']
    if s['codec_name'] != 'h264' or s['time_base'] != '1/90000' or s['r_frame_rate'] != '12/1' or s['width'] != 320 or s['height'] != 180 or s.get('has_b_frames') != 0 or len(packets) != 12 or 'K' not in packets[0]['flags']:
        raise ValueError('unsupported_cell_profile')
    for i, p in enumerate(packets):
        if int(p['pts']) != i * 7500 or p['pts'] != p['dts'] or int(p['duration']) != 7500:
            raise ValueError('invalid_cell_timing')
    if len(frames(path)[1]) != 12:
        raise ValueError('invalid_cell_decode')
    return sig


def concat(cells, output):
    listing = output.with_suffix('.concat.txt')
    # Names are generated locally, never arbitrary demuxer directives.
    if any("'" in str(p) or '\n' in str(p) for p in cells):
        raise ValueError('unsafe_concat_path')
    listing.write_text(''.join("file '" + str(p.resolve()) + "'\n" for p in cells))
    run('ffmpeg', '-nostdin', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listing, '-map', '0:v:0', '-c', 'copy', '-video_track_timescale', '90000', output)


def mux(video, audio_source, output):
    run('ffmpeg', '-nostdin', '-v', 'error', '-i', video, '-i', audio_source, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-video_track_timescale', '90000', '-movflags', '+faststart', output)


def assemble(manifest_path, approval, replacements, output):
    m, dirty = load_scope(manifest_path, approval)
    root = Path(manifest_path).resolve().parent
    before = root / 'baseline.mp4'
    if file_hash(before) != m['final']['sha256']:
        raise ValueError('baseline_conflict')
    expected = {c['id'] for c in m['cells'] if set(c['dependsOn']) & set(approval['changedStepIds'])}
    if set(replacements) != expected:
        raise ValueError('replacement_scope_mismatch')
    cells, signature = [], None
    for c in m['cells']:
        if Path(c['file']).name != c['file']:
            raise ValueError('unsafe_cell_path')
        old = root / c['file']
        if file_hash(old) != c['sha256']:
            raise ValueError('corrupt_cell')
        sig = cell_signature(old)
        if signature is None:
            signature = sig
        if sig != signature:
            raise ValueError('incompatible_cell')
        selected = Path(replacements[c['id']]) if c['id'] in expected else old
        if cell_signature(selected) != signature:
            raise ValueError('incompatible_replacement')
        cells.append(selected)
    out = scratch_new(output)
    if not dirty:
        # Return the original artifact itself; never remux a no-op.
        report = verify_visual_update(before, before, manifest_path, approval)
        report['artifact'] = str(before)
    else:
        reused = []
        for c, src in zip(m['cells'], cells):
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
    (out / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def demo(output):
    from PIL import Image, ImageDraw
    out = scratch_new(output)
    cells = []
    for i, color in enumerate(('navy', 'darkgreen', 'maroon')):
        image = Image.new('RGB', (320, 180), color)
        ImageDraw.Draw(image).text((30, 80), f'SYNTHETIC slide {i + 1}', fill='white')
        image.save(out / f'slide-{i}.png')
        cell = out / f'cell-{i}.mp4'
        encode(out / f'slide-{i}.png', cell)
        cell_signature(cell)
        cells.append({'id': f'hold-{i}', 'dependsOn': [f'synthetic-step-{i}'], 'startFrame': i * 12, 'endFrame': (i + 1) * 12, 'file': cell.name, 'sha256': file_hash(cell)})
    concat([out / c['file'] for c in cells], out / 'baseline-video.mp4')
    run('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'aac', '-b:a', '128k', out / 'tone.m4a')
    mux(out / 'baseline-video.mp4', out / 'tone.m4a', out / 'baseline.mp4')
    profile = {'name': 'local-synthetic-h264-holds-v1', 'width': 320, 'height': 180, 'fps': '12/1', 'cellFrames': 12, 'toolchain': toolchain()}
    m = {'schema': 1, 'profile': profile['name'], 'profileHash': hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest(), 'toolchain': toolchain(), 'frameCount': 36, 'final': {'sha256': file_hash(out / 'baseline.mp4')}, 'steps': [{'id': f'synthetic-step-{i}'} for i in range(3)], 'cells': cells}
    manifest = out / 'baseline-manifest.json'
    manifest.write_text(json.dumps(m, indent=2) + '\n')
    approval = {'baselineManifestHash': file_hash(manifest), 'renderProfileHash': m['profileHash'], 'changedStepIds': ['synthetic-step-1']}
    (out / 'local-approval.json').write_text(json.dumps(approval, indent=2) + '\n')
    image = Image.new('RGB', (320, 180), 'darkblue')
    ImageDraw.Draw(image).text((30, 80), 'APPROVED synthetic replacement', fill='yellow')
    image.save(out / 'replacement.png')
    encode(out / 'replacement.png', out / 'replacement.mp4')
    report = assemble(manifest, approval, {'hold-1': out / 'replacement.mp4'}, out / 'repair')
    noop = assemble(manifest, {**approval, 'changedStepIds': []}, {}, out / 'noop')
    report['no_op_original_hash_reused'] = noop['candidate_sha256'] == m['final']['sha256']
    (out / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    print(json.dumps(demo(parser.parse_args().output), indent=2))
