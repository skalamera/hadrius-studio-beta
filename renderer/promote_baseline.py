"""Stage a PUBLISHED drift update as the video's next original (the input of a normal baseline enrollment).

    TMPDIR=$HOME/.hermes/cache/scratch .venv/bin/python -m renderer.promote_baseline \
        --repo /path/to/hadrius-studio --name <script-name> --old-baseline <rebaseline dir the update was made on> \
        --render <drift_update output dir that produced the published candidate> --published <the published MP4> \
        --output $TMPDIR/NEW-directory

Why not just enroll the published file: it is a cell splice (old baseline cells for untouched slides + the update's
rendered cells), not a renderer output, so its `_build` cannot reproduce it and every later update's full
original-image control would fail. Instead this stages exactly what assemble would have left behind had the current
version been rendered from scratch, which is what drift_update itself computed:

  source/<name>.mp4   the update's chain output (assemble's own encoders, every slide) + the published audio,
                      stream-copied. Visually identical to the published file (gated: frame count, audio packets
                      and PCM equal; PSNR/SSIM per frame above the enrollment re-encode floor) — the same
                      relationship the first enrollment had with the original assemble output.
  source/_build/      the old build with the changed slides' artifacts (segNN/capNN/...) and assemble's chain
                      stages (video/content/body_*) replaced by the update's chain; stages that carried audio keep
                      their audio stream (a visual-only update never changes timing or audio)
  source/assembly.json  the update's candidate assembly; source/script.json the candidate script it binds to

The installer (tools/drift/promote.mjs) puts these in out/<name>/, enrolls a NEW baseline with the normal
rebaseline (all its own checks) and runs a full original-image control through the real renderer. This module only
stages and gates: visual-only updates only (`promotion_narration_unsupported` otherwise). Never imports
assemble.py/tts.py; no TTS, network, Drive, Pylon or bridge; writes only into the NEW output directory under TMPDIR.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import drift_render
from .preservation import file_hash, audio, probe

SAFE_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$')
# The first enrollment's own lossy cell re-encode measured min PSNR 44.96-45.32 dB / SSIM >= 0.9958 on these videos.
MIN_PSNR_DB, MIN_SSIM = 40.0, 0.99


class PromotionRejected(Exception):
    def __init__(self, code, detail=None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code, self.detail = code, detail


def reject(code, detail=None):
    raise PromotionRejected(code, detail)


def _streams(path):
    return [s['codec_type'] for s in probe(path)['streams']]


def _mux(video, audio_source, output):
    """video stream of `video` + audio stream of `audio_source`, both stream-copied (assemble's container flags)."""
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(video), '-i', str(audio_source), '-map', '0:v:0', '-map', '1:a:0',
                    '-c', 'copy', '-movflags', '+faststart', str(output)], check=True, capture_output=True, timeout=600)


def _count_frames(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
                          '-of', 'csv=p=0', str(path)], check=True, capture_output=True, text=True, timeout=600).stdout
    return int(out.strip())


def _similarity(a, b, workdir):
    wd = Path(workdir)
    wd.mkdir()
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(Path(a).resolve()), '-i', str(Path(b).resolve()), '-lavfi',
                    '[0:v][1:v]psnr=stats_file=psnr.log;[0:v][1:v]ssim=stats_file=ssim.log', '-f', 'null', '-'],
                   check=True, capture_output=True, timeout=1200, cwd=wd)
    psnr = [float(re.search(r'psnr_avg:(\S+)', l).group(1)) for l in (wd / 'psnr.log').read_text().splitlines() if l.strip()]
    ssim = [float(re.search(r'All:(\S+)', l).group(1)) for l in (wd / 'ssim.log').read_text().splitlines() if l.strip()]
    shutil.rmtree(wd)
    finite = [p for p in psnr if p != float('inf')]
    return {'frames': len(psnr), 'psnr_min': round(min(finite), 3) if finite else 999.0,
            'psnr_mean': round(sum(finite) / len(finite), 3) if finite else 999.0, 'identical_frames': len(psnr) - len(finite),
            'ssim_min': round(min(ssim), 6), 'worst_frames': sorted(range(len(psnr)), key=lambda i: psnr[i])[:5]}


def _new_output(path, repo):
    p = Path(path).absolute()
    tmp = Path(os.environ.get('TMPDIR') or '/nonexistent').resolve()
    if not p.parent.resolve().is_relative_to(tmp):
        reject('output_must_be_under_TMPDIR')
    if p.parent.resolve().is_relative_to(Path(repo).resolve()):
        reject('output_inside_repo')
    if p.exists():
        reject('output_exists')
    p.mkdir()
    return p.resolve()


def stage(repo, name, old_baseline, render, published, output):
    repo, render, published = Path(repo).resolve(), Path(render).resolve(), Path(published).resolve()
    if not SAFE_NAME.match(name or ''):
        reject('unsafe_name')
    # ---------- 1. this render produced exactly the published bytes, visual-only, on this baseline ----------
    v = json.loads((render / 'verification.json').read_text())
    if not v.get('ok') or v.get('dry_run') or v.get('noop'):
        reject('render_not_a_completed_update')
    if v.get('takes') or v.get('elevenlabs_characters') or v.get('audio'):
        reject('promotion_narration_unsupported', 'only visual-only updates can be promoted for now')
    pub_sha = file_hash(published)
    rendered = render / 'assembled' / 'candidate.mp4'
    if not rendered.is_file() or file_hash(rendered) != pub_sha or v.get('candidate_sha256') != pub_sha:
        reject('published_file_not_reproduced', {'published': pub_sha, 'render': v.get('candidate_sha256')})
    ordir, omanifest_path, om, oasm, _ = drift_render.load_rebaseline(old_baseline)
    if file_hash(render / 'inputs' / 'baseline-manifest.json') != file_hash(omanifest_path):
        reject('render_not_made_on_this_baseline')
    if om['original']['name'] != name:
        reject('baseline_name_mismatch')
    old_build = ordir / 'source' / '_build'
    if not old_build.is_dir():
        reject('old_baseline_build_snapshot_missing')
    cand_asm, cand_script = render / 'candidate-assembly.json', Path(v['candidate_script'])
    rec = render / 'candidate' / '_recordings' / json.loads(cand_script.read_bytes())['recording']['id']
    if not cand_asm.is_file() or not cand_script.is_file() or not rec.is_dir() or rec.is_symlink():
        reject('render_outputs_missing')
    out = _new_output(output, repo)
    src = out / 'source'
    build = src / '_build'
    build.mkdir(parents=True)

    # ---------- 2. the current version's _build ----------
    for p in sorted(old_build.iterdir()):
        if p.is_file() and not p.is_symlink() and not p.name.startswith('.'):
            shutil.copyfile(p, build / p.name)
    work_build = render / 'work' / 'out' / '_build'
    dirty_files = sorted(p.name for p in work_build.iterdir() if p.is_file() and not p.name.startswith('.'))
    for n in dirty_files:  # the changed slides' own segNN/capNN/hlNN/... exactly as rendered
        shutil.copyfile(work_build / n, build / n)
    for s in v['plan']['dirty_slides']:
        if f"seg{int(s.split('-')[1]):02d}.mp4" not in dirty_files:
            reject('dirty_segment_missing', s)
    stages = drift_render.load_build(old_build, oasm)['stages']
    chain = render / 'chain'
    replaced = {'video.mp4': chain / 'video.mp4', 'content.mp4': chain / 'content.mp4'}
    for st in stages:
        if st.get('real_output'):
            replaced[Path(st['real_output']).name] = chain / f"{st['stage']}.mp4"
    last = chain / f"{stages[-1]['stage']}.mp4" if stages else chain / 'content.mp4'
    for fname, new in replaced.items():
        if not new.is_file():
            reject('chain_stage_missing', new.name)
        old = old_build / fname
        if old.is_file() and 'audio' in _streams(old):
            if 'audio' in _streams(new):
                reject('unexpected_chain_audio', new.name)
            (build / fname).unlink()
            _mux(new, old, build / fname)  # same timing: the stage's own audio stream, stream-copied
        else:
            shutil.copyfile(new, build / fname)

    # ---------- 3. the current version's original + gates against the published file ----------
    original = src / f'{name}.mp4'
    _mux(last, published, original)
    n = _count_frames(published)
    if _count_frames(original) != n:
        reject('original_frame_count_mismatch')
    if audio(original) != audio(published):
        reject('original_audio_differs_from_published')
    sim = _similarity(original, published, out / 'similarity')
    if sim['frames'] != n or sim['psnr_min'] < MIN_PSNR_DB or sim['ssim_min'] < MIN_SSIM:
        reject('original_not_visually_identical_to_published', sim)
    shutil.copyfile(cand_asm, src / 'assembly.json')
    shutil.copyfile(cand_script, src / 'script.json')
    report = {'ok': True, 'name': name, 'output': str(out), 'original': str(original), 'original_sha256': file_hash(original),
              'build': str(build), 'assembly': str(src / 'assembly.json'), 'assembly_sha256': file_hash(src / 'assembly.json'),
              'script': str(src / 'script.json'), 'recordings': str(rec), 'recording_id': rec.name,
              'published_sha256': pub_sha, 'frames': n, 'audio_equal_to_published': True, 'similarity_to_published': sim,
              'build_replaced': {'dirty_slide_artifacts': dirty_files, 'chain_stages': sorted(replaced)},
              'old_baseline_manifest_sha256': file_hash(omanifest_path), 'dirty_slides': v['plan']['dirty_slides'],
              'font_layout': v['donor']['font_layout']}
    (out / 'stage.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for a in ('--repo', '--name', '--old-baseline', '--render', '--published', '--output'):
        p.add_argument(a, required=True)
    a = p.parse_args(argv)
    try:
        r = stage(a.repo, a.name, a.old_baseline, a.render, a.published, a.output)
    except PromotionRejected as e:
        print(json.dumps({'ok': False, 'rejected': e.code, 'detail': e.detail}, default=str))
        return 2
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as e:
        print(json.dumps({'ok': False, 'rejected': 'promotion_stage_error', 'detail': str(e)[:1000]}))
        return 2
    print(json.dumps(r, default=str))
    return 0


if __name__ == '__main__':
    sys.exit(main())
