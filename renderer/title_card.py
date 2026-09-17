#!/usr/bin/env python3
"""Generate a sleek 1080p typewriter title card for Hadrius Academy walkthroughs.

Matches the Hadrius Academy cinematic logo reveal theme:
- Deep obsidian canvas (#08070D)
- Volumetric violet/amber ambient glow
- Authentic Satoshi font
- Hadrius brand colors (Luminous white, Hadrius Gold #F59E0B, Violet #7C6BF5)
- Smooth typewriter letter-by-letter reveal with gold blinking cursor
- Module badge above title (Testing Program, Communications, Marketing, etc.)
"""

from __future__ import annotations
import os
import re
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1920, 1080, 30
DURATION_SEC = 4.2
TOTAL_FRAMES = int(DURATION_SEC * FPS) # 126 frames

ROOT = Path(__file__).resolve().parent.parent
FONT_BOLD_FILE = ROOT / 'assets' / 'fonts' / 'Satoshi-Bold.otf'
if not FONT_BOLD_FILE.exists():
    FONT_BOLD_FILE = Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf')

FONT_MEDIUM_FILE = ROOT / 'assets' / 'fonts' / 'Satoshi-Medium.otf'
if not FONT_MEDIUM_FILE.exists():
    FONT_MEDIUM_FILE = FONT_BOLD_FILE

BG_IMAGE_FILE = ROOT / 'assets' / 'title_bg.png'

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

def format_module_badge(raw: str) -> str:
    cleaned = re.sub(r'[-_.]+', ' ', str(raw)).strip()
    words = cleaned.split()
    if not words:
        return ''
    return '   '.join(' '.join(w.upper()) for w in words)

def get_base_background() -> Image.Image:
    if BG_IMAGE_FILE.exists():
        return Image.open(BG_IMAGE_FILE).convert('RGBA')
    # Fallback procedural background
    bg = Image.new('RGBA', (W, H), (8, 7, 13, 255))
    draw = ImageDraw.Draw(bg)
    cx, cy = W // 2, H // 2
    for r in range(600, 0, -20):
        p = 1.0 - (r / 600.0)
        alpha = int(70 * (p ** 1.8))
        draw.ellipse([cx - int(r * 1.6), cy - r, cx + int(r * 1.6), cy + r], fill=(97, 76, 225, alpha))
    return bg

def generate_title_video(
    title_text: str,
    output_mp4: Path,
    module: str | None = None,
    music_path: Path | None = None,
    show_academy: bool = False,
    **kwargs,
) -> Path:
    output_mp4 = Path(output_mp4)
    output_mp4.parent.mkdir(parents=True, exist_ok=True)
    frames_dir = output_mp4.parent / '_title_frames'
    frames_dir.mkdir(parents=True, exist_ok=True)

    # Handle backward-compatible positional or kwargs invocation
    if 'music_path' in kwargs and kwargs['music_path'] is not None:
        music_path = kwargs['music_path']
    if 'module' in kwargs and kwargs['module'] is not None:
        module = kwargs['module']
    if isinstance(module, Path) or (isinstance(module, str) and (module.endswith(('.wav', '.mp3', '.m4a')) or '/' in module)):
        music_path = Path(module)
        module = None

    title = format_title(title_text)
    
    # Calculate optimal font size and line wrapping
    font_size = 68
    if len(title) > 36:
        font_size = 56
    if len(title) > 48:
        font_size = 46
    if len(title) > 64:
        font_size = 40

    title_font = ImageFont.truetype(str(FONT_BOLD_FILE), font_size)
    badge_font = ImageFont.truetype(str(FONT_BOLD_FILE), 22)

    # Base background with persistent glow
    base_bg = get_base_background()
    cx, cy = W // 2, H // 2

    # Calculate full title width for centering
    full_bbox = title_font.getbbox(title)
    full_w = full_bbox[2] - full_bbox[0]
    full_h = full_bbox[3] - full_bbox[1]
    tx = cx - full_w // 2
    ty = cy - 25

    # Draw static badge on the base canvas (module name above title or fallback)
    badge_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    b_draw = ImageDraw.Draw(badge_layer)
    badge_text = format_module_badge(module) if module else "H A D R I U S   A C A D E M Y"
    bbox_b = badge_font.getbbox(badge_text)
    bw = bbox_b[2] - bbox_b[0]
    bx = cx - bw // 2
    by = cy - 120

    # Delicate gold accent lines
    line_w = 70
    b_draw.line([(bx - line_w - 24, by + 14), (bx - 24, by + 14)], fill=(245, 158, 11, 200), width=2)
    b_draw.line([(bx + bw + 24, by + 14), (bx + bw + line_w + 24, by + 14)], fill=(245, 158, 11, 200), width=2)
    b_draw.text((bx, by), badge_text, font=badge_font, fill=(245, 158, 11, 240))

    # Optional: "HADRIUS ACADEMY" underneath title
    if show_academy and module:
        sub_font = ImageFont.truetype(str(FONT_MEDIUM_FILE), 18)
        acad_text = "H A D R I U S   A C A D E M Y"
        bbox_a = sub_font.getbbox(acad_text)
        aw = bbox_a[2] - bbox_a[0]
        ax = cx - aw // 2
        ay = ty + full_h + 55
        b_draw.text((ax, ay), acad_text, font=sub_font, fill=(160, 155, 185, 170))

    base_composite = Image.alpha_composite(base_bg, badge_layer)

    # Timing:
    # 0 - 10 frames (~0.33s): badge visible, cursor starts blinking
    # 10 - 70 frames (~2.0s): typing letters
    # 70 - 126 frames (~1.86s): full title hold with blinking cursor
    start_type_frame = 10
    end_type_frame = 70
    type_span = end_type_frame - start_type_frame
    total_chars = len(title)

    # Pre-render text shadow for the typed characters
    for f in range(TOTAL_FRAMES):
        frame = base_composite.copy()

        if f < start_type_frame:
            visible_count = 0
            show_cursor = (f // 5) % 2 == 0
        elif f <= end_type_frame:
            progress = (f - start_type_frame) / float(type_span)
            visible_count = min(total_chars, int(progress * total_chars) + 1)
            show_cursor = True
        else:
            visible_count = total_chars
            show_cursor = ((f - end_type_frame) // 8) % 2 == 0

        displayed_text = title[:visible_count]
        t_bbox = title_font.getbbox(displayed_text) if displayed_text else (0, 0, 0, 0)
        tw = t_bbox[2] - t_bbox[0]

        if displayed_text:
            text_layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            t_draw = ImageDraw.Draw(text_layer)
            # Soft purple glow bloom shadow behind letters
            t_draw.text((tx, ty), displayed_text, font=title_font, fill=(124, 107, 245, 175))
            glow_text = text_layer.filter(ImageFilter.GaussianBlur(14))
            frame = Image.alpha_composite(frame, glow_text)

            # Crisp white foreground text
            draw = ImageDraw.Draw(frame)
            draw.text((tx, ty), displayed_text, font=title_font, fill=(255, 255, 255, 255))
        else:
            draw = ImageDraw.Draw(frame)

        if show_cursor:
            cur_x = tx + tw + 6
            cur_y = ty + 6
            cur_h = max(36, full_h + 8)
            draw.rectangle([cur_x, cur_y, cur_x + 5, cur_y + cur_h], fill=(245, 158, 11, 255))

        frame.convert('RGB').save(frames_dir / f"f_{f:04d}.png")

    # Audio track
    audio_wav = output_mp4.parent / '_title_audio.wav'
    if music_path and Path(music_path).exists():
        subprocess.run([
            'ffmpeg', '-y', '-i', str(music_path),
            '-t', f'{DURATION_SEC:.2f}',
            '-af', f'afade=t=in:d=0.4,afade=t=out:st={DURATION_SEC-0.6:.2f}:d=0.6,volume=-5dB',
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
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
        '-movflags', '+faststart',
        str(output_mp4)
    ], check=True, capture_output=True)

    # Cleanup temp frame files
    for p in frames_dir.glob('*.png'):
        p.unlink()
    try:
        frames_dir.rmdir()
    except OSError:
        pass
    if audio_wav.exists():
        audio_wav.unlink()

    return output_mp4

if __name__ == '__main__':
    import sys
    name = sys.argv[1] if len(sys.argv) > 1 else 'How to Add an Affiliated Firm'
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('/tmp/test_title_card.mp4')
    mod = sys.argv[3] if len(sys.argv) > 3 else 'Branches'
    show_acad = '--show-academy' in sys.argv
    generate_title_video(name, out, module=mod, show_academy=show_acad)
    print(f"Generated title card: {out}")
