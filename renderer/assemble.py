"""KB Studio assembler: slides + narration -> narrated MP4 (with captions, zoom, music) + interactive HTML.
Usage: .venv/bin/python renderer/assemble.py out/<name> [--music assets/music_bed.wav] [--voice en-US-AndrewNeural]
"""
from __future__ import annotations
import hashlib, json, os, subprocess, sys, textwrap, shutil, html, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image, ImageDraw, ImageFont
from title_card import generate_title_video, generate_support_card_video

out = Path(sys.argv[1]); args = sys.argv[2:]
MUSIC = Path(args[args.index('--music') + 1]) if '--music' in args else Path('assets/music_upbeat.wav')
VOICE = args[args.index('--voice') + 1] if '--voice' in args else 'en-US-EmmaNeural'
RATE = args[args.index('--rate') + 1] if '--rate' in args else '+0%'
PITCH = args[args.index('--pitch') + 1] if '--pitch' in args else '+3Hz'
MODULE_ARG = args[args.index('--module') + 1] if '--module' in args else None
SHOW_ACADEMY = '--show-academy' in args

def resolve_module(rep: dict, root: Path, out_path: Path | None = None) -> str | None:
    if rep.get('module'):
        return rep['module']
    name = rep.get('name') or (out_path.name if out_path else '')
    candidates = [
        root / 'scripts' / f'{name}.script.json',
        root / 'scripts' / f'{name}-ai.script.json',
    ]
    if name.endswith('-ai'):
        candidates.append(root / 'scripts' / f'{name[:-3]}.script.json')
    for c in candidates:
        if c.exists():
            try:
                data = json.load(open(c))
                if data.get('module'):
                    return data['module']
            except Exception:
                pass
    cov_path = root / '.coverage-plans.json'
    if cov_path.exists():
        try:
            plans = json.load(open(cov_path))
            norm_name = re.sub(r'[^a-z0-9]+', '', name.lower())
            for k, v in plans.items():
                norm_k = re.sub(r'[^a-z0-9]+', '', k.lower())
                if norm_name and (norm_name in norm_k or norm_k in norm_name):
                    m = v.get('plan', {}).get('module')
                    if m:
                        return m
        except Exception:
            pass
    slides = rep.get('slides') or rep.get('steps') or []
    for s in slides:
        route = (s.get('route') or s.get('url') or '').lower()
        if '/testing-program' in route:
            return 'Testing program'
        if '/people-oversight' in route or '/employees' in route:
            return 'People oversight'
        if '/branches' in route or '/branch-exams' in route or '/finra' in route:
            return 'Branches'
        if '/communications' in route or '/cases' in route or '/archive' in route:
            return 'Communications'
        if '/marketing' in route:
            return 'Marketing'
        if '/account-surveillance' in route or '/trade_surveillance' in route:
            return 'Account surveillance'
    text = f'{name} {rep.get("title", "")}'.lower()
    if any(w in text for w in ['branch']):
        return 'Branches'
    if any(w in text for w in ['trade', 'surveillance', 'brokerage']):
        return 'Account surveillance'
    if any(w in text for w in ['employee', 'certification', 'disclosure', 'u4', 'u5', 'attestation']):
        return 'People oversight'
    if any(w in text for w in ['marketing', 'campaign']):
        return 'Marketing'
    if any(w in text for w in ['email', 'instant message', 'social media', 'lexicon', 'communication']):
        return 'Communications'
    if any(w in text for w in ['policy', 'test', 'finding', 'control', 'risk', 'calendar', 'entity']):
        return 'Testing program'
    return None

def find_clip(arg_name, candidates):
    if arg_name in args:
        return Path(args[args.index(arg_name) + 1])
    for c in candidates:
        p = Path(c)
        if p.exists():
            return p
    return None

ROOT = Path(__file__).resolve().parent.parent
# Intro/outro default to the Hadrius Academy logo card (built below); --intro / --outro <clip> override.
INTRO = Path(args[args.index('--intro') + 1]) if '--intro' in args else None
OUTRO = Path(args[args.index('--outro') + 1]) if '--outro' in args else None
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

# ---------- 1. narration (VoiceStudio > ElevenLabs > edge-tts), cached by text ----------
# renderer/tts.py owns the provider chain and a persistent cache outside out/<name>/ (which
# render.sh wipes every time), so an edit re-voices only the lines that actually changed. The
# panel's per-step preview writes into the same cache, so a previewed line is free at render time.
import tts as narration
narration.prune()
narrator = narration.Narrator(
    vs_voice=args[args.index('--vs-voice') + 1] if '--vs-voice' in args else None,
    edge_voice=VOICE, edge_rate=RATE, edge_pitch=PITCH)
for s in slides:
    s['audio'] = str(narrator.speak(s['narration'])[0]) if s['narration'] else None
print(narrator.describe())

def dur(f):
    if not shutil.which('ffprobe'):
        sys.exit('Error: ffprobe was not found. Please install FFmpeg (brew install ffmpeg).')
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

# ---------- 3. per-slide video segment (cached by everything that determines its pixels) ----------
# Like narration, segments live in out/_cache/ so they survive render.sh's rm -rf of out/<name>/.
# The key includes the drawing code itself, so a change to how captions/highlights look
# invalidates every old segment on its own instead of silently reusing stale frames.
import inspect
SEG_CACHE = ROOT / 'out' / '_cache' / 'seg'; SEG_CACHE.mkdir(parents=True, exist_ok=True)
SEG_ENCODE = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '19']
# For files that get decoded and re-encoded again later (the stitched slide video, the title-card
# crossfade): ultrafast is several times quicker, and the lower CRF keeps the extra generation
# visually lossless — only the last encode in the chain uses the normal 'fast' settings.
INTERMEDIATE_ENCODE = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12']
_SEG_CODE = hashlib.sha256((inspect.getsource(caption_png) + inspect.getsource(highlight_png)
                            + FONT + json.dumps(SEG_ENCODE) + f'{W}x{H}@{FPS}').encode()).hexdigest()
seg_hits = 0
for f in SEG_CACHE.iterdir():  # same LRU-ish pruning as the narration cache (hits touch mtime)
    try:
        if f.stat().st_mtime < __import__('time').time() - narration.MAX_AGE_DAYS * 86400: f.unlink()
    except OSError:
        pass

def segment_key(s):
    src = out / 'slides' / s['file']
    parts = [_SEG_CODE, hashlib.sha256(src.read_bytes()).hexdigest(), str(s['sdur']),
             s.get('caption') or s.get('narration') or '',
             json.dumps(s.get('target') if NEEDS_DRAWN_HIGHLIGHT else None, sort_keys=True)]
    return hashlib.sha256('\x00'.join(parts).encode()).hexdigest()[:32]

def build_segment(s):
    global seg_hits
    key = segment_key(s)
    cached, cached_ann = SEG_CACHE / f'{key}.mp4', SEG_CACHE / f'{key}.ann.png'
    seg = tmp / f"seg{s['slide']:02d}.mp4"
    if cached.exists() and cached.stat().st_size > 0 and (not (NEEDS_DRAWN_HIGHLIGHT and s.get('target')) or cached_ann.exists()):
        shutil.copyfile(cached, seg); os.utime(cached)
        if cached_ann.exists():
            ann = out / 'annotated'; ann.mkdir(exist_ok=True)
            shutil.copyfile(cached_ann, ann / s['file']); os.utime(cached_ann)
        seg_hits += 1
        return seg
    _render_segment(s, seg)
    part = cached.with_suffix('.part'); shutil.copyfile(seg, part); part.replace(cached)
    if (out / 'annotated' / s['file']).exists() and NEEDS_DRAWN_HIGHLIGHT and s.get('target'):
        shutil.copyfile(out / 'annotated' / s['file'], cached_ann)
    return seg

def _render_segment(s, seg):
    src = out / 'slides' / s['file']
    im = Image.open(src); sw, sh = im.size
    inputs = ['-loop', '1', '-i', str(src)]
    chain = [f"[0:v]scale={W}:{H}:flags=lanczos,fps={FPS}[v0]"]
    stage = 0
    if NEEDS_DRAWN_HIGHLIGHT and s.get('target'):
        hp = tmp / f"hl{s['slide']:02d}.png"; highlight_png(s['target'], sw, sh, hp)
        # Same frame the video shows (highlight + pointer, no caption bar), kept as a still so the
        # knowledge-base article's screenshots match the video instead of being the bare capture.
        ann = out / 'annotated'; ann.mkdir(exist_ok=True)
        overlay = Image.open(hp).convert('RGBA')
        still = im.convert('RGB').resize((W, H), Image.LANCZOS)
        still.paste(overlay, (0, 0), overlay)
        still.save(ann / s['file'])
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
                    *SEG_ENCODE, str(seg)], check=True, capture_output=True)

segs = [build_segment(s) for s in slides]
print(f"segments: {seg_hits} cached, {len(slides) - seg_hits} rendered")
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
                    *INTERMEDIATE_ENCODE, '-pix_fmt', 'yuv420p', str(video)], check=True, capture_output=True)
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
# Both cards are drawn frame by frame in Python (~10s title, ~15s support — the single biggest cost
# of a re-render once narration and segments are cached), yet the support card is identical on
# every video and the title card only changes with its title/module. Cache them like segments,
# keyed on title_card.py's own source and the assets it reads so a design change still regenerates.
_CARD_CODE = hashlib.sha256(
    (Path(__file__).resolve().parent / 'title_card.py').read_bytes()
    + ''.join(f'{p}:{p.stat().st_size}:{int(p.stat().st_mtime)}' for p in
              [MUSIC, ROOT / 'assets' / 'title_bg.png', ROOT / 'assets' / 'fonts' / 'Satoshi-Bold.otf',
               ROOT / 'assets' / 'fonts' / 'Satoshi-Medium.otf'] if p.exists()).encode()).hexdigest()

def cached_card(dest, key_parts, make):
    key = hashlib.sha256('\x00'.join([_CARD_CODE, *map(str, key_parts)]).encode()).hexdigest()[:32]
    cached = SEG_CACHE / f'card-{key}.mp4'
    if cached.exists() and cached.stat().st_size > 0:
        shutil.copyfile(cached, dest); os.utime(cached)
        return True
    make()
    if dest.exists():
        part = cached.with_suffix('.part'); shutil.copyfile(dest, part); part.replace(cached)
    return False

title_clip = tmp / 'title_card.mp4'
try:
    mod_name = MODULE_ARG or resolve_module(rep, ROOT, out)
    title_text = rep.get('title') or rep['name']
    cached_card(title_clip, ['title', title_text, mod_name, SHOW_ACADEMY], lambda: generate_title_video(
        title_text,
        title_clip,
        module=mod_name,
        music_path=MUSIC if MUSIC.exists() else None,
        show_academy=SHOW_ACADEMY
    ))
except Exception as e:
    print(f"warning: could not generate title card: {e}")

support_clip = tmp / 'support_card.mp4'
try:
    cached_card(support_clip, ['support'], lambda: generate_support_card_video(
        support_clip, music_path=MUSIC if MUSIC.exists() else None))
except Exception as e:
    print(f"warning: could not generate support card: {e}")

# Hadrius Academy logo card: opens every video (dissolving into the title card) and closes it (the
# support card dissolves into it). Built once from assets/academy_logo.png and cached like the other
# cards. An explicit --intro / --outro clip still takes precedence.
LOGO_PNG = ROOT / 'assets' / 'academy_logo.png'
LOGO_HOLD = 2.5
logo_clip = tmp / 'logo_card.mp4'
if LOGO_PNG.exists() and not (INTRO and OUTRO):
    try:
        st = LOGO_PNG.stat()
        # The PNG's background is an uneven off-white (compression noise), which showed as a faint box
        # on a white card; key it out so the logo sits on clean white.
        logo_filter = (f"color=white:s={W}x{H}:r={FPS}:d={LOGO_HOLD}[bg];"
                       f"[0:v]format=rgba,colorkey=0xfdfdfd:0.06:0.08,scale={int(W * 0.72)}:-2[lg];"
                       f"[bg][lg]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]")
        cached_card(logo_clip, ['logo', st.st_size, int(st.st_mtime), logo_filter], lambda: subprocess.run([
            'ffmpeg', '-y', '-loop', '1', '-framerate', str(FPS), '-i', str(LOGO_PNG),
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-filter_complex', logo_filter,
            '-map', '[v]', '-map', '1:a', '-t', str(LOGO_HOLD),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', str(logo_clip)
        ], check=True, capture_output=True))
        if logo_clip.exists():
            INTRO = INTRO or logo_clip
            OUTRO = OUTRO or logo_clip
    except Exception as e:
        print(f"warning: could not generate logo card: {e}")

def crossfade_pair(c1: Path, c2: Path, out_path: Path, xf_dur: float = 0.65, intermediate: bool = False) -> bool:
    if not (c1 and c1.exists() and c2 and c2.exists()):
        return False
    try:
        d1 = dur(str(c1))
        offset = max(0.05, d1 - xf_dur)
        subprocess.run([
            'ffmpeg', '-y',
            '-i', str(c1),
            '-i', str(c2),
            '-filter_complex',
            f"[0:v][1:v]xfade=transition=fade:duration={xf_dur}:offset={offset:.3f}[v];"
            f"[0:a][1:a]acrossfade=d={xf_dur}[a]",
            '-map', '[v]', '-map', '[a]',
            *(INTERMEDIATE_ENCODE if intermediate else ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18']), '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
            str(out_path)
        ], check=True, capture_output=True)
        return out_path.exists()
    except Exception as e:
        print(f"warning: crossfade {c1.name} -> {c2.name} failed: {e}")
        return False

# 1. Crossfade INTRO into title card
lead_clip = None
if INTRO and INTRO.exists() and title_clip.exists():
    intro_title_path = tmp / 'intro_title_crossfaded.mp4'
    if crossfade_pair(INTRO, title_clip, intro_title_path, xf_dur=0.65, intermediate=True):
        lead_clip = intro_title_path
    else:
        lead_clip = title_clip
elif title_clip.exists():
    lead_clip = title_clip
elif INTRO and INTRO.exists():
    lead_clip = INTRO

# 2. Crossfade lead (intro + title card) into content recording
body_video = None
if lead_clip and lead_clip.exists():
    body_path = tmp / 'body_crossfaded.mp4'
    # Only an intermediate if something still gets crossfaded after it (support card / outro).
    if crossfade_pair(lead_clip, content_video, body_path, xf_dur=0.65,
                      intermediate=support_clip.exists() or bool(OUTRO and OUTRO.exists())):
        body_video = body_path

# 3. Crossfade last slide of content into the support/"need help?" card
lead_included = bool(body_video)  # intro+title already merged into active_body, below
active_body = body_video or content_video
support_included = False
if support_clip.exists() and active_body and active_body.exists():
    support_path = tmp / 'body_with_support.mp4'
    if crossfade_pair(active_body, support_clip, support_path, xf_dur=0.65, intermediate=bool(OUTRO and OUTRO.exists())):
        active_body = support_path
        support_included = True

# 4. Crossfade that into OUTRO
final_video = None
if OUTRO and OUTRO.exists() and active_body and active_body.exists():
    outro_path = tmp / 'full_crossfaded.mp4'
    if crossfade_pair(active_body, OUTRO, outro_path, xf_dur=0.80):
        final_video = outro_path

final = out / f"{rep['name']}.mp4"
if final_video and final_video.exists():
    shutil.move(str(final_video), str(final))
elif lead_included and active_body and active_body.exists():
    # Intro+title are already crossfaded in; concat whatever crossfades above didn't cover
    # (support, if that one crossfade failed, then outro) rather than dissolving into it.
    concat_inputs = [active_body]
    if not support_included and support_clip.exists():
        concat_inputs.append(support_clip)
    if OUTRO and OUTRO.exists():
        concat_inputs.append(OUTRO)
    if len(concat_inputs) == 1:
        shutil.move(str(active_body), str(final))
    else:
        ins, fc_parts = [], []
        for idx, p in enumerate(concat_inputs):
            ins.extend(['-i', str(p)])
            fc_parts.append(f"[{idx}:v][{idx}:a]")
        fc = "".join(fc_parts) + f"concat=n={len(concat_inputs)}:v=1:a=1[v][a]"
        subprocess.run(['ffmpeg', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
                        '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(final)], check=True, capture_output=True)
else:
    # Full fallback straight concat — intro/title were never merged in (or don't exist), so build
    # the whole sequence part by part. `active_body` already covers content (+support, if that one
    # crossfade above succeeded even though the lead one didn't) — never list content twice.
    parts = []
    if INTRO and INTRO.exists():
        parts.append(INTRO)
    if title_clip.exists():
        parts.append(title_clip)
    parts.append(active_body)
    if not support_included and support_clip.exists():
        parts.append(support_clip)
    if OUTRO and OUTRO.exists():
        parts.append(OUTRO)

    if len(parts) == 1:
        shutil.move(str(parts[0]), str(final))
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

alt_final = out / f"{out.name}.mp4"
if final != alt_final and final.exists():
    try:
        shutil.copyfile(str(final), str(alt_final))
    except Exception:
        pass

full_duration = dur(str(final)) if final.exists() else 0.0

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

json.dump({'video': str(final), 'duration': round(full_duration, 2), 'slides': slides, 'intro': bool(INTRO), 'title_card': bool(title_clip.exists()), 'support_card': bool(support_clip.exists()), 'outro': bool(OUTRO)}, open(out / 'assembly.json', 'w'), indent=1)
print(f"video {final} ({full_duration:.1f}s, {len(slides)} slides, intro={bool(INTRO)}, title_card={bool(title_clip.exists())}, outro={bool(OUTRO)}) · interactive {web/'index.html'}")
