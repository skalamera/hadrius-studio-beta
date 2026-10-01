"""Re-voice Gina's extra walkthrough videos using VoiceStudio narration.

Converts all videos in /Users/stephenskalamera/Downloads/ginas_extra_vids/ so that they use
VoiceStudio narration (profile 4bfebca6, "The Upbeat") while preserving original video
frames, 1080p resolution, visual captions, and timing.
"""
from __future__ import annotations
import json, os, re, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

REPO_ROOT = Path('/Users/stephenskalamera/hadrius-studio-beta').resolve()
sys.path.insert(0, str(REPO_ROOT))

from renderer.tts import _key, normalize_pronunciation, CACHE, VOICESTUDIO_URL, VOICESTUDIO_VOICE

VIDEOS_DIR = Path('/Users/stephenskalamera/Downloads/ginas_extra_vids')
BACKUP_DIR = VIDEOS_DIR / '_original_backups'
MUSIC_PATH = REPO_ROOT / 'assets' / 'music_upbeat.wav'
TMP_DIR = REPO_ROOT / '.hermes' / 'revoice_tmp'

CACHE.mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def get_duration(path: str | Path) -> float:
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(json.loads(res.stdout)['format']['duration'])


def synthesize_line_vs(text: str, voice: str = VOICESTUDIO_VOICE) -> Path:
    """Synthesize a line with VoiceStudio, ensuring vs is used with no fallback."""
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
            if 'timed out' in str(e).lower() or '500' in str(e):
                print("    Restarting hung OmniVoice worker subprocess...")
                subprocess.run(['pkill', '-9', '-f', 'engines/omnivoice_subprocess/main.py'])
            time.sleep(5.0)

    raise RuntimeError(f"VoiceStudio failed to synthesize: '{text}' after 8 attempts")


def prepare_timed_audio(lines: list[dict], content_end: float) -> list[dict]:
    """Ensure all lines fit in their visual windows, applying atempo if necessary."""
    prepared = []
    for i, l in enumerate(lines):
        audio_path = synthesize_line_vs(l['text'])
        dur = get_duration(audio_path)
        
        # Calculate available window until next speech starts or content ends
        if i < len(lines) - 1:
            window = lines[i+1]['start'] - l['start']
        else:
            window = content_end - l['start']
            
        final_audio = audio_path
        # If line exceeds available window significantly, compress slightly with atempo
        if dur > window + 0.15 and window > 1.0:
            speed = min(1.25, max(1.02, dur / window + 0.02))
            compressed_path = TMP_DIR / f"atempo_{audio_path.name}"
            subprocess.run([
                'ffmpeg', '-y', '-i', str(audio_path),
                '-filter:a', f'atempo={speed:.4f}',
                str(compressed_path)
            ], check=True, capture_output=True)
            new_dur = get_duration(compressed_path)
            print(f"    Line {i:2d} atempo compressed ({speed:.2f}x): {dur:.2f}s -> {new_dur:.2f}s (window: {window:.2f}s)")
            final_audio = compressed_path
            dur = new_dur
            
        prepared.append({
            'text': l['text'],
            'start': l['start'],
            'orig_end': l['end'],
            'audio': final_audio,
            'dur': dur
        })
    return prepared


def process_video(video_name: str, lines: list[dict]):
    src_video = VIDEOS_DIR / f"{video_name}.mp4"
    if not src_video.exists():
        print(f"ERROR: Video {src_video} does not exist!")
        return False

    backup_video = BACKUP_DIR / f"{video_name}.mp4"
    if not backup_video.exists():
        print(f"  Backing up original video to {backup_video}...")
        shutil.copy2(src_video, backup_video)

    total_dur = get_duration(src_video)
    print(f"\n=======================================================")
    print(f"Processing {video_name} (duration: {total_dur:.2f}s, {len(lines)} lines)")
    
    # 1. Synthesize and prepare timed audio
    t_synth_start = time.time()
    print("  Synthesizing dialogue lines via VoiceStudio...")
    prepared = prepare_timed_audio(lines, content_end=total_dur - 5.5)
    print(f"  All {len(prepared)} lines ready in {time.time()-t_synth_start:.1f}s.")

    # 2. Build filter complex for dialogue
    inputs = []
    filt = []
    mix_inputs = []

    for idx, item in enumerate(prepared):
        inputs += ['-i', str(item['audio'])]
        start_ms = int(round(item['start'] * 1000))
        filt.append(f"[{idx}:a]aresample=48000,adelay={start_ms}|{start_ms},volume=1.0[a{idx}]")
        mix_inputs.append(f"[a{idx}]")

    dialogue_mix = "".join(mix_inputs) + f"amix=inputs={len(mix_inputs)}:normalize=0:duration=longest,loudnorm=I=-20:TP=-2:LRA=11[dialogue]"
    filt.append(dialogue_mix)

    # 3. Background music ducking envelope
    music_idx = len(prepared)
    inputs += ['-stream_loop', '-1', '-i', str(MUSIC_PATH)]

    first_start = prepared[0]['start']
    last_end = prepared[-1]['start'] + prepared[-1]['dur']
    fade_out_start = max(0.0, total_dur - 2.5)

    # Smooth piecewise volume envelope:
    # - 0.56 (-5dB) on title card and support/outro bumpers
    # - 0.14 (-17dB) during dialogue
    duck_expr = (
        f"if(isnan(t), 0.56, "
        f"if(lt(t, {first_start-0.8:.2f}), 0.56, "
        f"if(lt(t, {first_start:.2f}), 0.56 - 0.42 * (t - {first_start-0.8:.2f}) / 0.8, "
        f"if(lt(t, {last_end+0.5:.2f}), 0.14, "
        f"if(lt(t, {last_end+1.8:.2f}), 0.14 + 0.42 * (t - {last_end+0.5:.2f}) / 1.3, "
        f"if(lt(t, {fade_out_start:.2f}), 0.56, "
        f"if(lt(t, {total_dur:.2f}), 0.56 * ({total_dur:.2f} - t) / 2.5, 0)"
        f"))))))"
    )

    filt.append(f"[{music_idx}:a]aresample=48000,atrim=0:{total_dur:.3f},volume='{duck_expr}':eval=frame[music]")

    # Mix dialogue and ducked music
    filt.append(f"[music][dialogue]amix=inputs=2:normalize=0:duration=first,atrim=0:{total_dur:.3f},alimiter=limit=0.95[aout]")

    temp_audio = TMP_DIR / f"{video_name}_audio.wav"
    audio_cmd = [
        'ffmpeg', '-y',
        *inputs,
        '-filter_complex', ';'.join(filt),
        '-map', '[aout]',
        '-c:a', 'pcm_s16le',
        '-ar', '48000',
        str(temp_audio)
    ]
    subprocess.run(audio_cmd, check=True, capture_output=True)

    # 4. Lossless video remux
    temp_video = TMP_DIR / f"{video_name}_final.mp4"
    remux_cmd = [
        'ffmpeg', '-y',
        '-i', str(src_video),
        '-i', str(temp_audio),
        '-map', '0:v',
        '-map', '1:a',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        str(temp_video)
    ]
    subprocess.run(remux_cmd, check=True, capture_output=True)

    # 5. Verify output
    out_dur = get_duration(temp_video)
    if abs(out_dur - total_dur) > 0.1:
        raise RuntimeError(f"Duration mismatch for {video_name}: expected {total_dur:.2f}s, got {out_dur:.2f}s")

    # Volume check
    vdetect = subprocess.run([
        'ffmpeg', '-i', str(temp_video), '-af', 'volumedetect', '-f', 'null', '-'
    ], capture_output=True, text=True)
    mean_vol = 'N/A'
    max_vol = 'N/A'
    for vl in vdetect.stderr.splitlines():
        if 'mean_volume' in vl: mean_vol = vl.strip()
        if 'max_volume' in vl: max_vol = vl.strip()

    print(f"  Verified render: duration={out_dur:.2f}s | {mean_vol} | {max_vol}")

    # 6. Replace target file
    shutil.move(str(temp_video), str(src_video))
    print(f"  ✓ Successfully updated {src_video.name}")
    return True


def main():
    cleaned_lines_file = REPO_ROOT / '.hermes' / 'all_cleaned_lines.json'
    with open(cleaned_lines_file) as f:
        data = json.load(f)

    order = [
        'Creating-Entities-in-Firm-Oversight',
        'Uploading-Policies-in-Firm-Oversight',
        'Creating-Branch-Profiles',
        'Creating-Visibility-Barriers',
        'Utilizing-the-Document-Library',
        'Uploading-Marketing-Disclosures',
        'Creating-a-Marketing-Review-Workflow',
        'Building-a-Certification-Template'
    ]

    total_start = time.time()
    print(f"Starting conversion of {len(order)} videos to VoiceStudio narration...")
    for idx, v in enumerate(order, 1):
        print(f"\n>>> Video {idx}/{len(order)}: {v}")
        process_video(v, data[v])

    print(f"\n=======================================================")
    print(f"ALL {len(order)} VIDEOS CONVERTED TO VOICESTUDIO IN {time.time()-total_start:.1f}s!")


if __name__ == '__main__':
    main()
