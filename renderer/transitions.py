"""LOCAL PNG fixture only: explicit one-second cells, not Academy/legacy FX.
Run with --output NEW_DIRECTORY_UNDER_TMPDIR. No providers or narration synthesis.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from .incremental import scratch_new, encode, concat, mux, assemble, cell_signature
from .preservation import file_hash, run, toolchain, load_scope


def profile():
    return {'name': 'local-synthetic-h264-dissolves-v1', 'width': 320, 'height': 180,
            'fps': '12/1', 'cellFrames': 12, 'blend': '(frame+1)/13', 'toolchain': toolchain()}


def topology(ids):
    specs = [('intro', 'bookend', [ids[0]]), ('hold-0', 'hold', [ids[0]]),
             ('dissolve-0', 'dissolve', ids[:2]), ('hold-1', 'hold', [ids[1]]),
             ('dissolve-1', 'dissolve', ids[1:]), ('hold-2', 'hold', [ids[2]]),
             ('outro', 'bookend', [ids[2]])]
    return [{'id': name, 'kind': kind, 'dependsOn': deps, 'startFrame': i * 12,
             'endFrame': (i + 1) * 12} for i, (name, kind, deps) in enumerate(specs)]


def render_cell(cell, images, output):
    """Render only 320x180 RGB PNG donors. Dissolves use both ordered donors."""
    from PIL import Image
    donors = []
    for step in cell['dependsOn']:
        path = Path(images[step])
        with Image.open(path) as image:
            if image.format != 'PNG' or image.size != (320, 180) or image.mode != 'RGB':
                raise ValueError('unsupported_synthetic_png')
            image.load()
            donors.append(image.copy())
    if cell['kind'] != 'dissolve':
        encode(images[cell['dependsOn'][0]], output)
    else:
        # Pillow's explicit rational blend makes fixture math independent of xfade
        # filter threading/timebase behavior. Encode each cell as a closed GOP.
        raw = output.with_suffix('.rgb')
        raw.write_bytes(b''.join(Image.blend(donors[0], donors[1], (i + 1) / 13).tobytes() for i in range(12)))
        run('ffmpeg', '-nostdin', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '320x180', '-framerate', '12', '-i', raw,
            '-frames:v', '12', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '12', '-bf', '0',
            '-x264-params', 'scenecut=0:open-gop=0', '-video_track_timescale', '90000', output)
        raw.unlink()
    cell_signature(output)


def render_approved(manifest, approval, images, output):
    """Dependency closure comes only from the pinned baseline; never dirty ranges."""
    m, _ = load_scope(manifest, approval)
    out = scratch_new(output)
    replacements = {}
    for cell in m['cells']:
        if set(cell['dependsOn']) & set(approval['changedStepIds']):
            path = out / f"replacement-{cell['id']}.mp4"
            render_cell(cell, images, path)
            replacements[cell['id']] = path
    return replacements


def candidate_fixture(out, images, replacement):
    """Exercise the existing Node CLI against scratch-only stable-ID JSON/PNGs."""
    recordings = out / '_recordings' / 'synthetic'
    recordings.mkdir(parents=True)
    base = {'id': 'synthetic-script', 'recording': {'id': 'synthetic'}, 'steps': []}
    for i, (step, image) in enumerate(images.items()):
        name = f'slide-{i}.png'
        shutil.copyfile(image, recordings / name)
        base['steps'].append({'id': step, 'capture': True, 'media': {'pre': name},
                              'narration': f'Original synthetic narration text {i}.', 'caption': '' if i == 1 else f'Caption {i}'})
    source = out / 'base.script.json'
    source.write_text(json.dumps(base, indent=2) + '\n')
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    plan = {'baseHash': digest(base), 'structuralChanges': [], 'changes': [
        {'stepId': base['steps'][1]['id'], 'beforeHash': digest(base['steps'][1]), 'imagePath': str(replacement.resolve()), 'sha256': file_hash(replacement)}]}
    manifest = out / 'candidate-plan.json'
    manifest.write_text(json.dumps(plan, indent=2) + '\n')
    cli = Path(__file__).resolve().parents[1] / 'tools/drift/candidate.mjs'
    result = json.loads(run('node', cli, '--base', source, '--recordings-root', recordings.parent, '--manifest', manifest, '--output', out / 'local-candidate'))
    candidate = json.loads(Path(result['scriptPath']).read_text())
    for a, b in zip(base['steps'], candidate['steps']):
        if any(a[k] != b[k] for k in ('id', 'narration', 'caption')):
            raise ValueError('candidate_text_or_identity_changed')
    return {s['id']: Path(result['recordingPath']) / s['media']['pre'] for s in candidate['steps']}


def demo(output):
    from PIL import Image, ImageDraw
    out = scratch_new(output)
    ids = [f'synthetic-step-{i}' for i in range(3)]
    images = {}
    for i, color in enumerate(('navy', 'darkgreen', 'maroon')):
        image = Image.new('RGB', (320, 180), color)
        ImageDraw.Draw(image).text((30, 80), f'SYNTHETIC slide {i}', fill='white')
        path = out / f'slide-{i}.png'
        image.save(path)
        images[ids[i]] = path
    cells = topology(ids)
    for cell in cells:
        path = out / f"{cell['id']}.mp4"
        render_cell(cell, images, path)
        cell.update(file=path.name, sha256=file_hash(path))
    concat([out / c['file'] for c in cells], out / 'baseline-video.mp4')
    run('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=7', '-c:a', 'aac', '-b:a', '128k', out / 'tone.m4a')
    mux(out / 'baseline-video.mp4', out / 'tone.m4a', out / 'baseline.mp4')
    p = profile()
    m = {'schema': 1, 'profile': p['name'], 'profileHash': hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest(),
         'toolchain': toolchain(), 'frameCount': 84, 'final': {'sha256': file_hash(out / 'baseline.mp4')}, 'steps': [{'id': x} for x in ids], 'cells': cells}
    manifest = out / 'baseline-manifest.json'
    manifest.write_text(json.dumps(m, indent=2) + '\n')
    approval = {'baselineManifestHash': file_hash(manifest), 'renderProfileHash': m['profileHash'], 'changedStepIds': [ids[1]]}
    (out / 'local-approval.json').write_text(json.dumps(approval, indent=2) + '\n')
    replacement = out / 'replacement.png'
    Image.new('RGB', (320, 180), 'darkblue').save(replacement)
    candidate_images = candidate_fixture(out, images, replacement)
    replacements = render_approved(manifest, approval, candidate_images, out / 'donors')
    # Keep explicit replacement artifacts at fixture root for negative tests.
    for path in replacements.values():
        shutil.copyfile(path, out / path.name)
    report = assemble(manifest, approval, replacements, out / 'repair')
    noop = assemble(manifest, {**approval, 'changedStepIds': []}, {}, out / 'noop')
    report.update(no_op_original_hash_reused=noop['candidate_sha256'] == m['final']['sha256'],
                  protected_ranges=[[0, 24], [60, 84]], candidate_engine_exercised=True,
                  limitation='LOCAL synthetic PNG dissolve cells only; tone audio, no TTS or Academy/legacy FX integration')
    (out / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    print(json.dumps(demo(parser.parse_args().output), indent=2))
