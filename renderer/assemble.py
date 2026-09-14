"""KB Studio assembler: slides + narration -> narrated MP4 (with captions, zoom, music) + interactive HTML.
Usage: .venv/bin/python renderer/assemble.py out/<name> [--music assets/music_bed.wav] [--voice en-US-AndrewNeural]
"""
import asyncio, json, os, subprocess, sys, textwrap, shutil, html
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image, ImageDraw, ImageFont
from title_card import generate_title_video

out = Path(sys.argv[1]); args = sys.argv[2:]
MUSIC = Path(args[args.index('--music') + 1]) if '--music' in args else Path('assets/music_upbeat.wav')
VOICE = args[args.index('--voice') + 1] if '--voice' in args else 'en-US-EmmaNeural'
RATE = args[args.index('--rate') + 1] if '--rate' in args else '+0%'
PITCH = args[args.index('--pitch') + 1] if '--pitch' in args else '+3Hz'

def find_clip(arg_name, candidates):
    if arg_name in args:
        return Path(args[args.index(arg_name) + 1])
    for c in candidates:
        p = Path(c)
        if p.exists():
            return p
    return None

ROOT = Path(__file__).resolve().parent.parent
# No intro by default: videos open on the title card and dissolve into the recording.
# Pass --intro <clip> explicitly to prepend one.
INTRO = Path(args[args.index('--intro') + 1]) if '--intro' in args else None
OUTRO = find_clip('--outro', [
    '/Users/stephenskalamera/Videos/Hadrius Studio Outtro.mp4',
    '/Users/stephenskalamera/Videos/Hadrius Studio Outro.mp4',
    ROOT / 'assets' / 'outro.mp4',
    'assets/outro.mp4',
])
rep = json.load(open(out / 'report.json'))
slides = rep['slides']
# Only renderer/from-recording.mjs needs a drawn-on highlight: it renders straight from screenshots
# captured by the extension at ORIGINAL recording time, with no live page to inject a callout into.
# from-recipe.mjs and replay.mjs both drive a real browser and bake their own red pulsing outline +
# pointer icon into the pixels before every screenshot (tools/stage-lib.mjs's CALLOUT_ON, and
# replay.mjs's own copy of the same mechanism) — drawing a second one on top of an already-highlighted
# frame would just double up. `source` is the one field that distinguishes this reliably: only
# from-recipe.mjs and from-recording.mjs set it ('recipe' / 'recording'); replay.mjs sets neither, so
# checking specifically for 'recording' (not "!= 'recipe'") is what keeps replay.mjs's own untouched.
NEEDS_DRAWN_HIGHLIGHT = rep.get('source') == 'recording'
W, H, FPS = 1920, 1080, 30
HOLD_NO_NARR = 1.9        # seconds for a slide with no narration
PAD_AFTER = 1.1           # breathing room after a line ends, before the next slide starts dissolving in
GAP = 0.25                # min silence between lines
XF = 0.8                  # dissolve length between slides
FONT = '/System/Library/Fonts/Helvetica.ttc'
tmp = out / '_build'; tmp.mkdir(exist_ok=True)

# ---------- 1. narration (edge-tts) ----------
async def tts():
    import edge_tts
    for s in slides:
        if not s['narration']: s['audio'] = None; continue
        f = tmp / f"n{s['slide']:02d}.mp3"
        if not f.exists():
            await edge_tts.Communicate(s['narration'], VOICE, rate=RATE, pitch=PITCH).save(str(f))
        s['audio'] = str(f)
asyncio.run(tts())

def dur(f):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', f]).decode())
for s in slides:
    s['adur'] = dur(s['audio']) if s['audio'] else 0.0
    s['sdur'] = round(max(HOLD_NO_NARR, s['adur'] + PAD_AFTER + XF), 3) if s['audio'] else HOLD_NO_NARR
# merge consecutive un-narrated slides into the previous narrated slide's tail? keep them short instead.

# ---------- 2. caption cards ----------
font = ImageFont.truetype(FONT, 40)
def caption_png(text, path):
    lines = textwrap.wrap(text, 78); lh, px, py = 50, 34, 20
    tw = max(font.getlength(l) for l in lines); bw, bh = int(tw + 2 * px), int(len(lines) * lh + 2 * py)
    img = Image.new('RGBA', (W, bh + 16), (0, 0, 0, 0)); d = ImageDraw.Draw(img); x0 = (W - bw) // 2
    d.rounded_rectangle([x0, 8, x0 + bw, 8 + bh], radius=18, fill=(15, 15, 20, 205))
    y = 8 + py
    for l in lines:
        d.text(((W - font.getlength(l)) / 2, y), l, font=font, fill='white'); y += lh
    img.save(path)

# Full-frame transparent overlay: a purple pulsing-style glow + outline around the target, plus the
# white/purple pointer glyph — styled in Hadrius brand purple (#4c3dab / #5b46d6).
def highlight_png(target, sw, sh, path):
    sx, sy = W / sw, H / sh
    x, y = target['x'] * sx, target['y'] * sy
    w, h = target['width'] * sx, target['height'] * sy
    pad = 6
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    purple_glow = (91, 70, 214)
    purple_solid = (76, 61, 171)
    for glow_width, alpha in ((20, 55), (12, 100), (6, 160)):  # soft purple glow, wide+faint to narrow+strong
        o = glow_width / 2
        d.rounded_rectangle([x - pad - o, y - pad - o, x + w + pad + o, y + h + pad + o], radius=9, outline=purple_glow + (alpha,), width=int(glow_width))
    d.rounded_rectangle([x - pad, y - pad, x + w + pad, y + h + pad], radius=8, outline=purple_solid + (255,), width=4)
    # pointer glyph, anchored just outside the highlight's bottom-right corner, scaled up for visibility
    px, py = x + w + pad + 8, y + h + pad + 8
    scale = 1.85  # larger pointer glyph
    tip = [
        (px, py),
        (px, py + 16.5 * scale),
        (px + 3.8 * scale, py + 12.9 * scale),
        (px + 5.7 * scale, py + 18.7 * scale),
        (px + 8.2 * scale, py + 17.5 * scale),
        (px + 5.4 * scale, py + 11.9 * scale),
        (px + 9.5 * scale, py + 11.9 * scale),
    ]
    # subtle drop shadow so pointer pops against any background
    shadow_tip = [(p[0] + 2, p[1] + 2) for p in tip]
    d.polygon(shadow_tip, fill=(0, 0, 0, 80))
    d.polygon(tip, fill=(255, 255, 255, 255), outline=purple_solid + (255,), width=3)
    img.save(path)

# ---------- 3. per-slide video segment ----------
def build_segment(s):
    src = out / 'slides' / s['file']; seg = tmp / f"seg{s['slide']:02d}.mp4"
    n = int(s['sdur'] * FPS)
    im = Image.open(src); sw, sh = im.size
    inputs = ['-loop', '1', '-i', str(src)]
    chain = [f"[0:v]scale={W}:{H}:flags=lanczos,fps={FPS}[v0]"]
    stage = 0
    if NEEDS_DRAWN_HIGHLIGHT and s.get('target'):
        hp = tmp / f"hl{s['slide']:02d}.png"; highlight_png(s['target'], sw, sh, hp)
        inputs += ['-loop', '1', '-i', str(hp)]
        stage += 1
        chain.append(f"[v{stage - 1}][{stage}:v]overlay=0:0[v{stage}]")
    cap = s.get('caption') or s.get('narration')
    if cap:
        cp = tmp / f"cap{s['slide']:02d}.png"; caption_png(cap, cp)
        inputs += ['-loop', '1', '-i', str(cp)]
        stage += 1
        chain.append(f"[v{stage - 1}][{stage}:v]overlay=0:H-h-56:eof_action=repeat[v{stage}]")
    chain.append(f"[v{stage}]format=yuv420p[v]")
    fc = ';'.join(chain)
    subprocess.run(['ffmpeg', '-y', *inputs, '-filter_complex', fc, '-map', '[v]', '-t', f"{s['sdur']}", '-r', str(FPS),
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', str(seg)], check=True, capture_output=True)
    return seg

segs = [build_segment(s) for s in slides]
video = tmp / 'video.mp4'
if len(segs) == 1:
    shutil.copy(segs[0], video)
else:
    ins = []; [ins.extend(['-i', str(p)]) for p in segs]
    chain = []; prev = '[0:v]'; offset = 0.0
    for i in range(1, len(segs)):
        offset += slides[i - 1]['sdur'] - XF
        out_lbl = f'[x{i}]' if i < len(segs) - 1 else '[v]'
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={XF}:offset={offset:.3f}{out_lbl}"); prev = out_lbl
    subprocess.run(['ffmpeg', '-y', *ins, '-filter_complex', ';'.join(chain), '-map', '[v]', '-r', str(FPS),
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', str(video)], check=True, capture_output=True)
total = sum(s['sdur'] for s in slides) - XF * (len(slides) - 1)

# ---------- 4. audio: narration at slide start (zero-overlap by construction) + music bed ----------
t = 0.0; mix_in = []; filt = []; idx = 1
inputs = ['-i', str(video)]
for k, s in enumerate(slides):
    s['start'] = round(t, 3)
    if s['audio']:
        inputs += ['-i', s['audio']]; d = int((t + (XF if k else 0.15)) * 1000)
        filt.append(f"[{idx}:a]aresample=48000,adelay={d}|{d},volume=1.0[a{idx}]"); mix_in.append(f"[a{idx}]"); idx += 1
    t += s['sdur'] - (XF if k < len(slides) - 1 else 0)
if MUSIC.exists():
    inputs += ['-stream_loop', '-1', '-i', str(MUSIC)]
    filt.append(f"[{idx}:a]aresample=48000,atrim=0:{total:.3f},afade=t=in:d=2,afade=t=out:st={max(total-3,0):.3f}:d=3,volume=-5dB[mus]"); mix_in.append('[mus]'); idx += 1
filt.append(''.join(mix_in) + f"amix=inputs={len(mix_in)}:duration=longest:normalize=0,atrim=0:{total:.3f},alimiter=limit=0.95[aout]")
content_video = tmp / 'content.mp4'
subprocess.run(['ffmpeg', '-y', *inputs, '-filter_complex', ';'.join(filt), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', f'{total:.3f}', str(content_video)], check=True, capture_output=True)

# ---------- 5. stitch intro + title card + content + outro clips ----------
title_clip = tmp / 'title_card.mp4'
try:
    generate_title_video(rep.get('title') or rep['name'], title_clip, music_path=MUSIC if MUSIC.exists() else None)
except Exception as e:
    print(f"warning: could not generate title card: {e}")

# Crossfade title card into content recording
body_video = tmp / 'body_crossfaded.mp4'
if title_clip.exists():
    try:
        t_dur = dur(str(title_clip))
        xf_dur = 0.65
        offset = max(0.1, t_dur - xf_dur)
        subprocess.run([
            'ffmpeg', '-y',
            '-i', str(title_clip),
            '-i', str(content_video),
            '-filter_complex',
            f"[0:v][1:v]xfade=transition=fade:duration={xf_dur}:offset={offset:.3f}[v];"
            f"[0:a][1:a]acrossfade=d={xf_dur}[a]",
            '-map', '[v]', '-map', '[a]',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            str(body_video)
        ], check=True, capture_output=True)
    except Exception as e:
        print(f"warning: crossfade failed, falling back to straight concat: {e}")
        body_video = None
else:
    body_video = None

parts = []
if INTRO and INTRO.exists():
    parts.append(INTRO)

if body_video and body_video.exists():
    parts.append(body_video)
else:
    if title_clip.exists():
        parts.append(title_clip)
    parts.append(content_video)

if OUTRO and OUTRO.exists():
    parts.append(OUTRO)

final = out / f"{rep['name']}.mp4"
if len(parts) == 1:
    shutil.move(str(content_video), str(final))
else:
    ins = []
    fc_parts = []
    for idx, p in enumerate(parts):
        ins.extend(['-i', str(p)])
        fc_parts.append(f"[{idx}:v][{idx}:a]")
    fc = "".join(fc_parts) + f"concat=n={len(parts)}:v=1:a=1[v][a]"
    subprocess.run(['ffmpeg', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
                    str(final)], check=True, capture_output=True)

full_duration = sum(dur(str(p)) for p in parts)

# ---------- 6. interactive (Arcade-style) HTML ----------
web = out / 'interactive'; (web / 'slides').mkdir(parents=True, exist_ok=True)
for s in slides: shutil.copy(out / 'slides' / s['file'], web / 'slides' / s['file'])
data = [{'file': f"slides/{s['file']}", 'caption': s.get('caption') or s.get('narration') or '', 'target': s.get('target'), 'vw': s['viewport']['width'], 'vh': s['viewport']['height']} for s in slides]
(web / 'index.html').write_text(f"""<!doctype html><meta charset=utf-8><title>{html.escape(rep.get('title') or rep['name'])}</title>
<style>body{{margin:0;background:#fafafa;color:#18181b;font:14px/1.4 "Satoshi",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}#stage{{position:relative;max-width:1200px;margin:18px auto 14px;aspect-ratio:16/9;background:#18181b;border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.12);border:1px solid #e4e4e7}}
#stage img{{width:100%;height:100%;display:block}}.hot{{position:absolute;border:3px solid #4c3dab;border-radius:8px;box-shadow:0 0 0 9999px rgba(39,30,90,.3),0 0 16px rgba(76,61,171,.85);cursor:pointer;animation:p 1.3s infinite}}
@keyframes p{{50%{{box-shadow:0 0 0 9999px rgba(39,30,90,.3),0 0 28px rgba(76,61,171,1)}}}}#cap{{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(39,30,90,.92);backdrop-filter:blur(6px);color:#fff;padding:10px 20px;border-radius:12px;max-width:80%;font-size:16px;box-shadow:0 4px 16px rgba(0,0,0,.2);border:1px solid rgba(223,219,249,.25)}}
#bar{{max-width:1200px;margin:0 auto;display:flex;gap:10px;align-items:center;padding:0 6px}}button{{background:#4c3dab;color:#fff;border:1px solid #4c3dab;border-radius:7px;padding:7px 15px;cursor:pointer;font-family:inherit;font-weight:600;font-size:13px;transition:background .15s}}button:hover{{background:#3e3194}}.n{{color:#4c3dab;background:#efecff;border:1px solid #dfdbf9;padding:2px 10px;border-radius:999px;font-weight:700;font-size:12px}}</style>
<div id=stage><img id=img><div id=hot class=hot hidden></div><div id=cap></div></div>
<div id=bar><button onclick="go(-1)">‹ Back</button><span class=n id=n></span><button onclick="go(1)">Next ›</button><span style="color:#71717a;margin-left:auto;font-size:13px">Click the highlighted area or press ➔ to advance</span></div>
<script>const S={json.dumps(data)};let i=0;const img=document.getElementById('img'),hot=document.getElementById('hot'),cap=document.getElementById('cap'),n=document.getElementById('n');
function show(){{const s=S[i];img.src=s.file;cap.textContent=s.caption;cap.hidden=!s.caption;n.textContent=(i+1)+' / '+S.length;
if(s.target){{const t=s.target;hot.hidden=false;hot.style.left=(t.x/s.vw*100)+'%';hot.style.top=(t.y/s.vh*100)+'%';hot.style.width=(t.width/s.vw*100)+'%';hot.style.height=(t.height/s.vh*100)+'%';}}else hot.hidden=true;}}
function go(d){{i=Math.max(0,Math.min(S.length-1,i+d));show();}}hot.onclick=()=>go(1);document.addEventListener('keydown',e=>{{if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1);}});show();</script>""")

json.dump({'video': str(final), 'duration': round(full_duration, 2), 'slides': slides, 'intro': bool(INTRO), 'title_card': bool(title_clip.exists()), 'outro': bool(OUTRO)}, open(out / 'assembly.json', 'w'), indent=1)
print(f"video {final} ({full_duration:.1f}s, {len(slides)} slides, intro={bool(INTRO)}, title_card={bool(title_clip.exists())}, outro={bool(OUTRO)}) · interactive {web/'index.html'}")
