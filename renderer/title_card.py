#!/usr/bin/env python3
"""Generate a sleek 1080p typewriter title card for Hadrius Studio walkthroughs."""

from __future__ import annotations
import os
import re
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
DURATION_SEC = 4.8
TOTAL_FRAMES = int(DURATION_SEC * FPS) # 144 frames

FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
if not os.path.exists(FONT_BOLD):
    FONT_BOLD = '/System/Library/Fonts/Helvetica.ttc'

LOWER_WORDS = {'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to'}

def format_title(raw: str) -> str:
    cleaned = re.sub(r'[-_.]+', ' ', raw).strip()
    words = cleaned.split()
    if not words:
        return 'Walkthrough'
    res = []
    for i, w in enumerate(words):
        lw = w.lower()
        if i > 0 and lw in LOWER_WORDS:
            res.append(lw)
        else:
            res.append(w.capitalize())
    return ' '.join(res)

def generate_title_video(title_text: str, output_mp4: Path, music_path: Path | None = None) -> Path:
    output_mp4 = Path(output_mp4)
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    frames_dir = output_mp4.parent / '_title_frames'
    frames_dir.mkdir(parents=True, exist_ok=True)

    title = format_title(title_text)
    
    # Calculate font size to fit comfortably within 1600px width
    font_size = 76
    if len(title) > 35:
        font_size = 60
    if len(title) > 50:
        font_size = 48

    title_font = ImageFont.truetype(FONT_BOLD, font_size)

    # Base background: deep sleek dark canvas with soft ambient glow
    bg = Image.new('RGB', (W, H), (10, 9, 14))
    bg_draw = ImageDraw.Draw(bg)
    
    cx, cy = W // 2, H // 2
    for r in range(500, 0, -15):
        alpha_ratio = 1.0 - (r / 500.0)
        r_val = int(10 + 26 * (alpha_ratio ** 1.5))
        g_val = int(9 + 18 * (alpha_ratio ** 1.5))
        b_val = int(14 + 50 * (alpha_ratio ** 1.5))
        bbox = [cx - int(r * 1.8), cy - r, cx + int(r * 1.8), cy + r]
        bg_draw.ellipse(bbox, fill=(r_val, g_val, b_val))

    start_type_frame = 12     # ~0.40s
    end_type_frame = 64       # ~2.13s (gives ~2.7s to comfortably read the full title)
    type_span = end_type_frame - start_type_frame
    total_chars = len(title)

    # Full title bounding box for steady centering
    full_bbox = title_font.getbbox(title)
    full_w = full_bbox[2] - full_bbox[0]
    full_h = full_bbox[3] - full_bbox[1]
    tx = cx - full_w // 2
    ty = cy - full_h // 2 - 10

    for f in range(TOTAL_FRAMES):
        frame = bg.copy()
        draw = ImageDraw.Draw(frame)

        if f < start_type_frame:
            visible_count = 0
            show_cursor = (f // 6) % 2 == 0
        elif f <= end_type_frame:
            progress = (f - start_type_frame) / float(type_span)
            visible_count = min(total_chars, int(progress * total_chars) + 1)
            show_cursor = True
        else:
            visible_count = total_chars
            # Blinking cursor after typing finishes
            show_cursor = ((f - end_type_frame) // 10) % 2 == 0

        displayed_text = title[:visible_count]
        
        t_bbox = title_font.getbbox(displayed_text) if displayed_text else (0, 0, 0, 0)
        tw = t_bbox[2] - t_bbox[0]

        if displayed_text:
            # Soft dark drop shadow for crisp readability
            draw.text((tx + 2, ty + 2), displayed_text, font=title_font, fill=(0, 0, 0))
            draw.text((tx, ty), displayed_text, font=title_font, fill=(255, 255, 255))

        if show_cursor:
            cur_x = tx + tw + 4
            draw.text((cur_x, ty), "|", font=title_font, fill=(168, 85, 247))

        frame.save(frames_dir / f"f_{f:04d}.png")

    # Audio track
    audio_wav = output_mp4.parent / '_title_audio.wav'
    if music_path and Path(music_path).exists():
        subprocess.run([
            'ffmpeg', '-y', '-i', str(music_path),
            '-t', f'{DURATION_SEC:.2f}',
            '-af', f'afade=t=in:d=0.5,afade=t=out:st={DURATION_SEC-0.7:.2f}:d=0.7,volume=-4dB',
            '-ar', '48000', '-ac', '2',
            str(audio_wav)
        ], check=True, capture_output=True)
    else:
        subprocess.run([
            'ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-t', f'{DURATION_SEC:.2f}',
            str(audio_wav)
        ], check=True, capture_output=True)

    # Encode video
    subprocess.run([
        'ffmpeg', '-y',
        '-framerate', str(FPS),
        '-i', str(frames_dir / 'f_%04d.png'),
        '-i', str(audio_wav),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
        '-movflags', '+faststart',
        str(output_mp4)
    ], check=True, capture_output=True)

    # Cleanup temp frame files
    for p in frames_dir.glob('*.png'):
        p.unlink()
    frames_dir.rmdir()
    if audio_wav.exists():
        audio_wav.unlink()

    return output_mp4

if __name__ == '__main__':
    import sys
    name = sys.argv[1] if len(sys.argv) > 1 else 'How-to-create-a-test'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('/tmp/test_title.mp4')
    generate_title_video(name, out)
    print(f"Generated title card: {out}")
