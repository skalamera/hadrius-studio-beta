"""Batch convert all legacy videos in Hadrius Academy Drive folder to Hadrius Academy theme & VoiceStudio.

For every video in Google Drive folder 1fYjVjmRG1wgh4v1FF3EpdAdC5oN-LFcP that needs conversion:
1. Synthesizes all script narration lines with VoiceStudio (profile 4bfebca6) with pronunciation normalization.
2. Extracts fresh 1080p slide captures from local out/_recordings/<id>.
3. Assembles complete video using Hadrius Academy white theme cards (intro, title with module, support, outro).
4. Applies broadcast audio mixing with ducked upbeat music and loudness normalization.
5. In-place updates Google Drive file media via Drive API (preserving fileId, webViewLink, and embeds).
6. Mirrors canonical video to ~/Desktop/Circle/<name>.mp4.
"""
from __future__ import annotations
import json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

REPO_ROOT = Path('/Users/stephenskalamera/hadrius-studio-beta').resolve()
sys.path.insert(0, str(REPO_ROOT))

from renderer.tts import _key, normalize_pronunciation, CACHE, VOICESTUDIO_URL, VOICESTUDIO_VOICE

JOBS_FILE = REPO_ROOT / '.hermes' / 'mapped_60_jobs.json'
PROGRESS_FILE = REPO_ROOT / '.hermes' / 'drive_conversion_progress.json'
CIRCLE_DIR = Path('/Users/stephenskalamera/Desktop/Circle')
TOKEN_PATH = Path('/Users/stephenskalamera/.hermes/google_token.json')
HERMES_PYTHON = Path('/Users/stephenskalamera/.hermes/hermes-agent/venv/bin/python')

CIRCLE_DIR.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)


def get_drive_service():
    creds_data = json.load(open(TOKEN_PATH))
    creds = Credentials.from_authorized_user_info(creds_data)
    return build('drive', 'v3', credentials=creds)


def get_duration(path: str | Path) -> float:
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(json.loads(res.stdout)['format']['duration'])


def synthesize_line_vs(text: str, voice: str = VOICESTUDIO_VOICE) -> Path:
    norm = normalize_pronunciation(text)
    k = _key('vs', norm, voice)
    dest = CACHE / f"vs-{k}.mp3"
    if dest.exists() and dest.stat().st_size > 1000:
        return dest

    body = json.dumps({'input': norm, 'voice': voice, 'response_format': 'mp3', 'speed': 1.0}).encode()
    req = urllib.request.Request(
        f'{VOICESTUDIO_URL}/v1/audio/speech',
        data=body,
        method='POST',
        headers={'Content-Type': 'application/json'}
    )

    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
                if len(data) > 1000:
                    dest.write_bytes(data)
                    return dest
        except Exception as e:
            print(f"    [VoiceStudio retry {attempt+1}/8] error: {e}")
            if 'timed out' in str(e).lower() or '500' in str(e) or '429' in str(e):
                print("    Restarting hung OmniVoice worker subprocess...")
                subprocess.run(['pkill', '-9', '-f', 'engines/omnivoice_subprocess/main.py'])
            time.sleep(5.0)

    raise RuntimeError(f"VoiceStudio failed to synthesize: '{text}' after 8 attempts")


def pre_synthesize_script(script_path: str | Path):
    with open(script_path) as sf:
        sdata = json.load(sf)
    steps = sdata.get('steps', [])
    for st in steps:
        narr = st.get('narration', '').strip()
        if narr:
            synthesize_line_vs(narr)


def update_drive_in_place(drive, file_id: str, local_path: Path):
    media = MediaFileUpload(str(local_path), mimetype='video/mp4', resumable=True)
    updated = drive.files().update(
        fileId=file_id,
        media_body=media,
        fields='id, name, mimeType, modifiedTime, size, webViewLink'
    ).execute()
    return updated


def main():
    if not JOBS_FILE.exists():
        print(f"ERROR: {JOBS_FILE} not found!")
        return

    with open(JOBS_FILE) as f:
        jobs = json.load(f)

    progress = {}
    if PROGRESS_FILE.exists():
        try:
            progress = json.load(open(PROGRESS_FILE))
        except Exception:
            progress = {}

    drive = get_drive_service()
    total_jobs = len(jobs)
    print(f"Loaded {total_jobs} jobs for batch conversion and Drive sync.")

    for idx, job in enumerate(jobs, 1):
        drive_name = job['drive_name']
        drive_id = job['drive_id']
        script_path = REPO_ROOT / job['script_path']

        # Skip if already completed in progress
        if drive_name in progress and progress[drive_name].get('completed'):
            print(f"[{idx}/{total_jobs}] Already completed: {drive_name}")
            continue

        print(f"\n=======================================================")
        print(f"[{idx}/{total_jobs}] Processing: {drive_name}")
        print(f"Script: {script_path.name} | Drive ID: {drive_id}")
        t0 = time.time()

        try:
            # 1. Pre-synthesize all lines with VoiceStudio
            print("  Step 1: Ensuring VoiceStudio narration lines are synthesized...")
            pre_synthesize_script(script_path)

            # 2. Extract slides and assemble video
            with open(script_path) as sf:
                sdata = json.load(sf)
            name = sdata['name']
            out_dir = REPO_ROOT / 'out' / name
            shutil.rmtree(out_dir, ignore_errors=True)

            print(f"  Step 2: Extracting captured slides to out/{name}...")
            subprocess.run(['node', 'renderer/from-recording.mjs', str(script_path), str(out_dir)], check=True)

            print(f"  Step 3: Assembling 1080p Hadrius Academy video...")
            subprocess.run(['.venv/bin/python', 'renderer/assemble.py', str(out_dir)], check=True)

            rendered_mp4 = out_dir / f"{name}.mp4"
            if not rendered_mp4.exists():
                raise RuntimeError(f"Expected render {rendered_mp4} does not exist!")

            dur = get_duration(rendered_mp4)
            vdetect = subprocess.run([
                'ffmpeg', '-i', str(rendered_mp4), '-af', 'volumedetect', '-f', 'null', '-'
            ], capture_output=True, text=True)
            mean_vol = 'N/A'
            for vl in vdetect.stderr.splitlines():
                if 'mean_volume' in vl: mean_vol = vl.strip()

            print(f"  Render complete: duration={dur:.2f}s | {mean_vol}")

            # 3. Mirror locally to ~/Desktop/Circle/
            circle_target = CIRCLE_DIR / drive_name
            shutil.copy2(rendered_mp4, circle_target)
            print(f"  Step 4: Mirrored to Circle: {circle_target.name}")

            # 4. In-place update to Google Drive
            print(f"  Step 5: Overwriting Google Drive file in-place (ID: {drive_id})...")
            updated = update_drive_in_place(drive, drive_id, rendered_mp4)
            print(f"  ✓ Updated in Drive: {updated.get('name')} ({updated.get('modifiedTime')})")

            # 5. Record progress
            progress[drive_name] = {
                'completed': True,
                'drive_id': drive_id,
                'duration': dur,
                'mean_vol': mean_vol,
                'modifiedTime': updated.get('modifiedTime'),
                'elapsed_s': round(time.time() - t0, 1)
            }
            with open(PROGRESS_FILE, 'w') as pf:
                json.dump(progress, pf, indent=2)

            print(f"  ✓ [{idx}/{total_jobs}] Finished {drive_name} in {time.time()-t0:.1f}s")

        except Exception as e:
            print(f"  ✗ ERROR processing {drive_name}: {e}")
            progress[drive_name] = {'completed': False, 'error': str(e)}
            with open(PROGRESS_FILE, 'w') as pf:
                json.dump(progress, pf, indent=2)

    completed_count = sum(1 for v in progress.values() if v.get('completed'))
    print(f"\n=======================================================")
    print(f"BATCH PROCESSING COMPLETE: {completed_count}/{total_jobs} videos converted and synced to Drive!")


if __name__ == '__main__':
    main()
