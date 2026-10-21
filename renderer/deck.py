#!/usr/bin/env python3
"""Render a Create ✨ slide deck: annotated screenshots -> PowerPoint -> PDF -> page thumbnails.

Input is a deck spec written by tools/deck-studio.mjs (out/_decks/<id>/spec.json). Every
screenshot is a recorded step's own capture (out/_recordings/<recording>/step_<id>.png) and every
red box comes from data, never from a guess:

  1. the recorder's DOM bounding box for the clicked/typed element (target.hint.bbox, CSS px of
     the captured viewport, scaled by image width / viewport width), else
  2. macOS Vision OCR of the screenshot, boxing the step's target label when it appears exactly
     once (icon-only controls and ambiguous labels get no box rather than a wrong one).

A slide can group several steps on one screen. The slide shows the LAST step's screenshot and a
step only gets a numbered box if its own capture and that screenshot look the same inside the box
(a menu that has closed, a dialog that covers it, or a scrolled page fails the check). Numbers in
the text always match the badges drawn, because both are assigned here.

Usage: deck.py <spec.json>   ->  prints a JSON result line {pptx, pdf, thumbs, stats}
"""
from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / 'assets' / 'academy_logo.png'
HB = '/System/Library/Fonts/Helvetica.ttc'

PURPLE = RGBColor(0x4C, 0x3D, 0xAB)
PURPLE_DARK = RGBColor(0x3E, 0x31, 0x94)
INK = RGBColor(0x13, 0x25, 0x1F)
GRAY = RGBColor(0x69, 0x78, 0x72)
LIGHT = RGBColor(0xF5, 0xF3, 0xFF)
LINE = RGBColor(0xDD, 0xD6, 0xFE)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
PALE = RGBColor(0xC9, 0xC2, 0xF0)
FONT = 'Arial'
BOX_RGB = (229, 57, 53)
BADGE_RGB = (76, 61, 171)


def log(msg):
    print(f'[deck] {msg}', file=sys.stderr, flush=True)


def font(size, bold=False):
    try:
        return ImageFont.truetype(HB, int(size), index=1 if bold else 0)
    except Exception:
        return ImageFont.load_default()


# --------------------------------------------------------------------------- box resolution
_ocr_cache: dict[str, list] = {}


def ocr_lines(path):
    if path in _ocr_cache:
        return _ocr_cache[path]
    lines = []
    try:
        from ocrmac import ocrmac  # macOS Vision; optional
        for text, _conf, box in ocrmac.OCR(path, recognition_level='accurate').recognize(px=True):
            lines.append((text, [float(v) for v in box]))
    except Exception as e:  # not on macOS / not installed: OCR fallback simply finds nothing
        log(f'OCR unavailable for {os.path.basename(path)}: {str(e)[:80]}')
    _ocr_cache[path] = lines
    return lines


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def ocr_box(path, label):
    """Box around `label` if the OCR finds it exactly once, else None."""
    want = norm(label)
    if len(want) < 3:
        return None
    hits = []
    for text, (x0, y0, x1, y1) in ocr_lines(path):
        t = norm(text)
        if not t:
            continue
        # OCR prefixes icons as stray glyphs ("@ Add artifact"), so compare after dropping one
        # leading token too, and accept a close fuzzy match only for short lines.
        cands = {t, ' '.join(t.split()[1:])}
        if any(c == want or (len(c) <= len(want) + 4 and difflib.SequenceMatcher(None, c, want).ratio() >= 0.88) for c in cands if c):
            hits.append((x0, y0, x1, y1))
    if len(hits) != 1:
        return None
    x0, y0, x1, y1 = hits[0]
    return [x0 - 8, y0 - 6, x1 + 8, y1 + 6]


def step_box(step, img_size):
    """Box for a step in its OWN capture's pixel space, with where it came from."""
    bb, vp = step.get('bbox'), step.get('viewport')
    if bb and vp and vp.get('w') and bb.get('w', 0) > 2 and bb.get('h', 0) > 2:
        k = img_size[0] / float(vp['w'])
        x0, y0 = bb['x'] * k, bb['y'] * k
        x1, y1 = (bb['x'] + bb['w']) * k, (bb['y'] + bb['h']) * k
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(img_size[0], x1), min(img_size[1], y1)
        if x1 - x0 > 4 and y1 - y0 > 4:
            return [x0, y0, x1, y1], 'dom'
    if step.get('label') and step.get('image'):
        b = ocr_box(step['image'], step['label'])
        if b:
            return b, 'ocr'
    return None, None


def same_region(a: Image.Image, b: Image.Image, box, loose=False):
    """True if the box looks the same in both captures (element still visible, not covered)."""
    if a.size != b.size:
        return False
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    pad = 4
    crop = (max(0, x0 - pad), max(0, y0 - pad), min(a.size[0], x1 + pad), min(a.size[1], y1 + pad))
    if crop[2] - crop[0] < 4 or crop[3] - crop[1] < 4:
        return False
    # Compare on a grid scaled to the box's aspect. A mostly-white area can hide a big change in
    # its average, so also cap the share of cells that changed a lot.
    gw = 48
    gh = max(6, min(48, round(gw * (crop[3] - crop[1]) / max(1, crop[2] - crop[0]))))
    ca = a.crop(crop).convert('L').resize((gw, gh)).tobytes()
    cb = b.crop(crop).convert('L').resize((gw, gh)).tobytes()
    diffs = [abs(p - q) for p, q in zip(ca, cb)]
    mean = sum(diffs) / len(diffs)
    changed = sum(1 for d in diffs if d > 40) / len(diffs)
    return mean < (26 if loose else 14) and changed < (0.22 if loose else 0.06)


# --------------------------------------------------------------------------- image annotation
def draw_badge(d, cx, cy, r, num, s):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BADGE_RGB, outline=(255, 255, 255), width=max(2, int(2 * s)))
    d.text((cx, cy), str(num), font=font(r * 1.25, True), fill='white', anchor='mm')


def badge_pos(box, r, s, W, H):
    x0, y0, x1, y1 = box
    gap = 6 * s
    if x0 - gap - 2 * r > 0:  # left of the box, vertically centred: never covers a field label
        return x0 - gap - r, min(max((y0 + y1) / 2, r + 2), H - r - 2)
    cx, cy = x0, y0  # top-left corner
    return min(max(cx, r + 2), W - r - 2), min(max(cy, r + 2), H - r - 2)


def callout(d, box, text, s, W, H, taken):
    """Pill label next to a box (visual style), placed where it overlaps nothing already drawn."""
    f = font(17 * s, True)
    tw = d.textlength(text, font=f)
    pw, ph = tw + 26 * s, 34 * s
    x0, y0, x1, y1 = box
    gap = 14 * s
    options = [
        (x1 + gap, (y0 + y1) / 2 - ph / 2),          # right
        (x0 - gap - pw, (y0 + y1) / 2 - ph / 2),     # left
        ((x0 + x1) / 2 - pw / 2, y1 + gap),          # below
        ((x0 + x1) / 2 - pw / 2, y0 - gap - ph),     # above
    ]

    def overlaps(r):
        return any(not (r[2] < t[0] or r[0] > t[2] or r[3] < t[1] or r[1] > t[3]) for t in taken)

    best = None
    for px, py in options:
        r = (px, py, px + pw, py + ph)
        if r[0] < 4 or r[1] < 4 or r[2] > W - 4 or r[3] > H - 4:
            continue
        if not overlaps(r):
            best = r
            break
    if best is None:
        px = min(max(options[2][0], 4), W - pw - 4)
        py = min(max(options[2][1], 4), H - ph - 4)
        best = (px, py, px + pw, py + ph)
    # leader line from the box edge to the pill
    bx = min(max((best[0] + best[2]) / 2, x0), x1)
    by = min(max((best[1] + best[3]) / 2, y0), y1)
    d.line([(bx, by), ((best[0] + best[2]) / 2, (best[1] + best[3]) / 2)], fill=BOX_RGB, width=max(2, int(2.5 * s)))
    d.rounded_rectangle(best, radius=ph / 2, fill=(29, 24, 64), outline=(255, 255, 255), width=max(1, int(1.5 * s)))
    d.text(((best[0] + best[2]) / 2, (best[1] + best[3]) / 2), text, font=f, fill='white', anchor='mm')
    taken.append(best)


_img_cache: dict[str, Image.Image] = {}


def load(path):
    if path not in _img_cache:
        _img_cache[path] = Image.open(path).convert('RGB')
    return _img_cache[path]


LOOSE_ROLES = {'checkbox', 'switch', 'radio', 'option', 'tab', 'combobox', 'textbox', 'searchbox', 'spinbutton'}


def resolve_boxes(slide_steps, stats):
    """Each step's box in its own capture (or None)."""
    out = []
    for st in slide_steps:
        if not st.get('image') or not os.path.isfile(st['image']) or st.get('nobox'):
            out.append(None)
            continue
        box, src = step_box(st, load(st['image']).size)
        if box:
            stats['boxed_' + str(src)] += 1
        else:
            stats['unboxed'] += 1
        out.append(box)
    return out


def visible_on(st, box, base_path):
    if st['image'] == base_path:
        return True
    loose = st.get('action') in ('type', 'select', 'fill') or str(st.get('role') or '').lower() in LOOSE_ROLES
    return same_region(load(st['image']), load(base_path), box, loose=loose)


def split_runs(slide_steps, boxes):
    """Group consecutive steps that can share one screenshot (the run's last capture) with every
    box still visible on it. A step whose element is gone from the later screen (menu closed,
    dialog opened, page changed) starts a new run instead of losing its box."""
    runs, cur = [], []
    for i, st in enumerate(slide_steps):
        has_img = bool(st.get('image') and os.path.isfile(st['image']))
        if not has_img or boxes[i] is None:
            cur.append(i)  # nothing to point at: rides along without changing the run's screenshot
            continue
        boxed = [j for j in cur if boxes[j] is not None]
        if all(visible_on(slide_steps[j], boxes[j], st['image']) for j in boxed):
            cur.append(i)
        else:
            runs.append(cur)
            cur = [i]
    if cur:
        runs.append(cur)
    return runs


def annotate(run_steps, run_boxes, style, out_path):
    """Draw boxes on the run's base screenshot. Returns (path, [badge number or None per step])."""
    with_img = [s for s in run_steps if s.get('image') and os.path.isfile(s['image'])]
    if not with_img:
        return None, [None] * len(run_steps)
    boxed_imgs = [s['image'] for s, b in zip(run_steps, run_boxes) if b is not None and s.get('image') and os.path.isfile(s['image'])]
    base_path = boxed_imgs[-1] if boxed_imgs else with_img[0]['image']
    base = load(base_path)
    W, H = base.size
    s = max(W / 1600.0, 0.75)
    placed = [(i, b) for i, b in enumerate(run_boxes) if b is not None]
    numbers = [None] * len(run_steps)
    img = base.copy()
    if style == 'visual' and placed:
        # spotlight: dim everything outside the boxes
        mask = Image.new('L', img.size, 0)
        md = ImageDraw.Draw(mask)
        for _, (x0, y0, x1, y1) in placed:
            md.rounded_rectangle([x0 - 8 * s, y0 - 8 * s, x1 + 8 * s, y1 + 8 * s], radius=int(8 * s), fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(3 * s))
        dark = Image.blend(img, Image.new('RGB', img.size, (20, 18, 40)), 0.42)
        img = Image.composite(img, dark, mask)
    d = ImageDraw.Draw(img)
    width = {'detailed': max(2, int(2.5 * s)), 'standard': max(3, int(3.5 * s)), 'visual': max(4, int(4.5 * s))}[style]
    taken = [tuple(b) for _, b in placed]
    for _, (x0, y0, x1, y1) in placed:
        p = 5 * s
        d.rounded_rectangle([x0 - p, y0 - p, x1 + p, y1 + p], radius=int(7 * s), outline=BOX_RGB, width=width)
    order, k = {}, 0
    if style == 'visual':  # no step list to match: number the boxes in order
        order = {i: n + 1 for n, (i, _) in enumerate(placed)}
    else:  # the text numbers every step; a badge carries its step's number
        for i, st in enumerate(run_steps):
            if st.get('text'):
                k += 1
                order[i] = k
    for i, box in placed:
        if style == 'detailed':
            continue  # minimal markup: outlines only
        n = order.get(i) or (max(order.values(), default=0) + 1)
        numbers[i] = n
        r = int((17 if style == 'visual' else 15) * s)
        cx, cy = badge_pos([box[0] - 5 * s, box[1] - 5 * s, box[2] + 5 * s, box[3] + 5 * s], r, s, W, H)
        draw_badge(d, cx, cy, r, n, s)
        taken.append((cx - r, cy - r, cx + r, cy + r))
    if style == 'visual':
        for i, box in placed:
            text = re.sub(r'\*\*', '', run_steps[i].get('callout') or run_steps[i].get('label') or '').strip()
            if text:
                callout(d, [box[0] - 5 * s, box[1] - 5 * s, box[2] + 5 * s, box[3] + 5 * s], text[:48], s, W, H, taken)
    if img.size[0] > 2200:
        img = img.resize((2200, round(img.size[1] * 2200 / img.size[0])), Image.Resampling.LANCZOS)
    img.save(out_path, optimize=True)
    return out_path, numbers


def plain_image(path, out_path):
    img = Image.open(path).convert('RGB')
    if img.size[0] > 2200:
        img = img.resize((2200, round(img.size[1] * 2200 / img.size[0])), Image.Resampling.LANCZOS)
    img.save(out_path, optimize=True)
    return out_path


# --------------------------------------------------------------------------- pptx helpers
class Deck:
    def __init__(self, spec):
        self.spec = spec
        self.prs = Presentation()
        self.prs.slide_width = Inches(13.333)
        self.prs.slide_height = Inches(7.5)
        self.blank = self.prs.slide_layouts[6]
        self.page = 0
        self.footer_text = f"{spec.get('title', 'Hadrius guide')}"

    def rect(self, sl, x, y, w, h, fill, line=None, shape=MSO_SHAPE.RECTANGLE):
        sh = sl.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
        sh.fill.solid()
        sh.fill.fore_color.rgb = fill
        if line is None:
            sh.line.fill.background()
        else:
            sh.line.color.rgb = line
            sh.line.width = Pt(0.75)
        sh.shadow.inherit = False
        return sh

    def text(self, sl, x, y, w, h, paras, size=14, color=INK, bold=False, align=PP_ALIGN.LEFT,
             anchor=MSO_ANCHOR.TOP, space=6, line_spacing=1.12):
        tb = sl.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = Inches(0.02)
        tf.margin_top = tf.margin_bottom = Inches(0.02)
        tf.vertical_anchor = anchor
        if isinstance(paras, str):
            paras = [paras]
        for i, para in enumerate(paras):
            pp = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            pp.alignment = align
            pp.space_after = Pt(space)
            pp.line_spacing = line_spacing
            psize, pcolor, pbold = size, color, bold
            if isinstance(para, tuple):
                para, o = para
                psize, pcolor, pbold = o.get('size', size), o.get('color', color), o.get('bold', bold)
            for j, chunk in enumerate(re.split(r'\*\*', str(para))):
                if not chunk:
                    continue
                r = pp.add_run()
                r.text = chunk
                r.font.name = FONT
                r.font.size = Pt(psize)
                r.font.color.rgb = pcolor
                r.font.bold = pbold or (j % 2 == 1)
        return tb

    def footer(self, sl, dark=False):
        self.page += 1
        if dark:
            return
        self.rect(sl, 0.5, 7.02, 12.333, 0.01, LINE)
        self.text(sl, 0.5, 7.08, 9, 0.3, self.footer_text, size=9, color=GRAY)
        self.text(sl, 11.8, 7.08, 1.033, 0.3, str(self.page), size=9, color=GRAY, align=PP_ALIGN.RIGHT)

    def header(self, sl, section, title, compact=False):
        if section:
            self.text(sl, 0.5, 0.28 if not compact else 0.22, 12, 0.3, section.upper(), size=10.5, color=PURPLE, bold=True)
        self.text(sl, 0.5, 0.54 if not compact else 0.45, 12.3, 0.6, title, size=25 if not compact else 21, bold=True)

    def picture(self, sl, path, x, y, w, h, center=False):
        im = Image.open(path)
        ar = im.size[1] / im.size[0]
        pw, ph = (w, w * ar) if w * ar <= h else (h / ar, h)
        if center:
            x += (w - pw) / 2
        pic = sl.shapes.add_picture(path, Inches(x), Inches(y), Inches(pw), Inches(ph))
        pic.line.color.rgb = LINE
        pic.line.width = Pt(0.75)
        return pw, ph

    @staticmethod
    def lines_for(s, width_in, size):
        cpl = max(10, int(width_in * 72 / (size * 0.5)))
        plain = str(s).replace('**', '')
        return max(1, -(-len(plain) // cpl))

    def list_height(self, items, w, size, gap):
        h = 0
        for num, s in items:
            tw = w - (0.45 if num is not None else 0)
            h += max(self.lines_for(s, tw, size) * size * 1.27 / 72 + 0.05, 0.36) + gap
        return h

    def steps_list(self, sl, items, x, y, w, max_h, size=12.5, gap=0.14):
        """items: [(number|'•'|None, text)]; shrinks the font until the list fits max_h."""
        while size > 9.5 and self.list_height(items, w, size, gap) > max_h:
            size -= 0.5
            gap = max(0.06, gap - 0.01)
        cy = y
        for num, s in items:
            indent = 0.45 if num is not None else 0
            if isinstance(num, int):
                c = self.rect(sl, x, cy + 0.01, 0.32, 0.32, PURPLE, shape=MSO_SHAPE.OVAL)
                tf = c.text_frame
                tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
                tf.vertical_anchor = MSO_ANCHOR.MIDDLE
                p = tf.paragraphs[0]
                p.alignment = PP_ALIGN.CENTER
                r = p.add_run()
                r.text = str(num)
                r.font.size = Pt(11.5)
                r.font.bold = True
                r.font.color.rgb = WHITE
                r.font.name = FONT
            elif num == '•':
                self.rect(sl, x + 0.12, cy + 0.12, 0.09, 0.09, PURPLE, shape=MSO_SHAPE.OVAL)
            hgt = self.lines_for(s, w - indent, size) * size * 1.27 / 72 + 0.05
            self.text(sl, x + indent, cy, w - indent, hgt, s, size=size, space=0)
            cy += max(hgt, 0.36) + gap
        return cy

    def tip(self, sl, s, x=0.5, y=6.27, w=8.3, h=0.62):
        self.rect(sl, x, y, w, h, LIGHT)
        self.rect(sl, x, y, 0.06, h, PURPLE)
        size = 11.5 if self.lines_for(s, w - 0.3, 11.5) <= 2 else 10
        self.text(sl, x + 0.2, y, w - 0.3, h, s, size=size, anchor=MSO_ANCHOR.MIDDLE)

    # ------------------------------------------------------------------ slide types
    def cover(self):
        sp = self.spec
        sl = self.prs.slides.add_slide(self.blank)
        self.rect(sl, 0, 5.6, 13.333, 1.9, PURPLE)
        if LOGO.exists():
            sl.shapes.add_picture(str(LOGO), Inches(0.9), Inches(0.75), height=Inches(0.72))
        # long titles wrap: shrink a little and push the subtitle down so the two never overlap
        title = sp.get('title') or 'Getting Started Guide'
        size = 40 if self.lines_for(title, 11.6, 40 * 1.08) <= 1 else 34
        n = min(3, self.lines_for(title, 11.6, size * 1.08))
        y = 2.0 if n == 1 else 1.75
        th = n * size * 1.2 / 72 + 0.1
        self.text(sl, 0.9, y, 11.6, th, title, size=size, bold=True)
        if sp.get('subtitle'):
            self.text(sl, 0.9, max(3.35, y + th + 0.2), 11.4, 1.1, sp['subtitle'], size=18, color=GRAY)
        aud = {'admin': 'For admins', 'employee': 'For employees', 'both': 'For admins and employees'}.get(sp.get('audience'), '')
        kind = {'standard': 'Step-by-step guide', 'detailed': 'Detailed guide', 'visual': 'Visual guide'}.get(sp.get('style'), 'Guide')
        bits = [b for b in (sp.get('module'), aud, kind) if b]
        self.text(sl, 0.9, 6.2, 11.5, 0.6, '  ·  '.join(bits), size=15, color=WHITE)
        self.footer(sl, dark=True)

    def contents(self, sections):
        sl = self.prs.slides.add_slide(self.blank)
        self.header(sl, 'Overview', "What's in this guide")
        n = len(sections)
        cols = 1 if n <= 6 else 2
        per = -(-n // cols)
        row_h = min(0.88, 5.2 / max(per, 1))
        for i, sec in enumerate(sections):
            col, row = divmod(i, per)
            x = 0.5 + col * 6.3
            y = 1.5 + row * row_h
            self.text(sl, x, y, 0.7, 0.5, f'{i + 1:02d}', size=19, color=PURPLE, bold=True)
            self.text(sl, x + 0.7, y, 5.4, 0.35, sec.get('title', ''), size=14.5, bold=True)
            if sec.get('summary') and row_h >= 0.7:
                self.text(sl, x + 0.7, y + 0.32, 5.4, 0.42, sec['summary'], size=11, color=GRAY)
        self.footer(sl)

    def section(self, num, title, blurb):
        sl = self.prs.slides.add_slide(self.blank)
        self.rect(sl, 0, 0, 13.333, 7.5, PURPLE)
        self.text(sl, 0.9, 2.2, 3, 1.2, f'{num:02d}', size=60, color=PALE, bold=True)
        n = min(3, self.lines_for(title, 11.4, 34 * 1.08))
        th = n * 34 * 1.2 / 72 + 0.1
        self.text(sl, 0.9, 3.35, 11.4, th, title, size=34, color=WHITE, bold=True)
        if blurb:
            self.text(sl, 0.9, max(4.35, 3.35 + th + 0.2), 10.8, 1.4, blurb, size=16, color=RGBColor(0xE4, 0xE0, 0xF7))
        self.footer(sl, dark=True)

    def concept(self, section, sd, image=None):
        sl = self.prs.slides.add_slide(self.blank)
        self.header(sl, section, sd.get('title', ''))
        body = [p for p in (sd.get('body') or []) if p]
        bullets = [b for b in (sd.get('bullets') or []) if b]
        if image:
            self.picture(sl, image, 0.5, 1.45, 7.4, 5.3)
            x, w = 8.2, 4.63
        else:
            x, w = 0.5, 12.3
        y = 1.5
        if sd.get('lead'):
            self.text(sl, x, y, w, 0.9, sd['lead'], size=15, color=PURPLE_DARK)
            y += 0.4 + 0.3 * self.lines_for(sd['lead'], w, 15)
        if body:
            size = 13 if sum(self.lines_for(p, w, 13) for p in body) * 0.25 < 6.6 - y else 11
            self.text(sl, x, y, w, 6.8 - y, body, size=size, space=8)
            y += sum(self.lines_for(p, w, size) for p in body) * size * 1.3 / 72 + 0.12 * len(body) + 0.1
        if bullets:
            self.steps_list(sl, [('•', b) for b in bullets], x, y, w, 6.85 - y, size=12.5, gap=0.1)
        self.footer(sl)

    def steps_slide(self, section, sd, style, img, numbers):
        steps = sd['steps']
        sl = self.prs.slides.add_slide(self.blank)
        if style == 'visual':
            self.header(sl, section, sd.get('title', ''), compact=True)
            if img:
                self.picture(sl, img, 0.5, 1.05, 12.333, 5.85, center=True)
            self.footer(sl)
            return
        self.header(sl, section, sd.get('title', ''))
        if style == 'standard':
            has_tip = bool(sd.get('tip'))
            if img:
                self.picture(sl, img, 0.5, 1.45, 8.3, 4.67 if has_tip else 5.35)
            items = []
            if sd.get('lead'):
                items.append((None, sd['lead']))
            k = 0
            for st in steps:
                if st.get('text'):
                    k += 1
                    items.append((k, st['text']))
            for extra in sd.get('after') or []:
                items.append((None, extra))
            self.steps_list(sl, items, 9.05, 1.45, 3.8, 5.4)
            if has_tip:
                self.tip(sl, sd['tip'])
        else:  # detailed: smaller image, rich text, outline-only markup
            if img:
                self.picture(sl, img, 0.5, 1.45, 6.9, 3.95)
            x, w = 7.65, 5.18
            y = 1.45
            if sd.get('lead'):
                self.text(sl, x, y, w, 1.0, sd['lead'], size=13.5, color=PURPLE_DARK)
                y += self.lines_for(sd['lead'], w, 13.5) * 13.5 * 1.3 / 72 + 0.18
            items = [(i + 1, st['text']) for i, st in enumerate([s for s in steps if s.get('text')])]
            y = self.steps_list(sl, items, x, y, w, 6.85 - y, size=12, gap=0.1)
            body = [p for p in (sd.get('body') or []) if p]
            notes_y = 5.6
            notes = body + ([f"**Good to know:** {sd['tip']}"] if sd.get('tip') else [])
            if notes:
                size = 11.5
                while size > 9 and sum(self.lines_for(p, 6.5, size) for p in notes) * size * 1.3 / 72 > 1.15:
                    size -= 0.5
                nh = min(1.28, sum(self.lines_for(p, 6.5, size) for p in notes) * size * 1.3 / 72 + 0.06 * len(notes) + 0.2)
                self.rect(sl, 0.5, notes_y, 6.9, nh, LIGHT)
                self.rect(sl, 0.5, notes_y, 0.06, nh, PURPLE)
                self.text(sl, 0.72, notes_y + 0.08, 6.55, nh - 0.1, notes, size=size, space=4)
        if sd.get('notes'):
            sl.notes_slide.notes_text_frame.text = str(sd['notes'])
        self.footer(sl)

    def quickref(self, rows):
        rows = rows[:14]
        sl = self.prs.slides.add_slide(self.blank)
        self.header(sl, 'Quick reference', 'Where to find it')
        tbl = sl.shapes.add_table(len(rows) + 1, 2, Inches(0.5), Inches(1.45), Inches(12.333), Inches(min(5.4, 0.38 * (len(rows) + 1)))).table
        tbl.columns[0].width = Inches(5.0)
        tbl.columns[1].width = Inches(7.333)
        for r, (a, b) in enumerate([('I want to...', 'Go to')] + [(x.get('task', ''), x.get('where', '')) for x in rows]):
            for c, val in enumerate((a, b)):
                cell = tbl.cell(r, c)
                cell.text = ''
                cell.fill.solid()
                cell.fill.fore_color.rgb = PURPLE if r == 0 else (LIGHT if r % 2 == 0 else WHITE)
                p = cell.text_frame.paragraphs[0]
                run = p.add_run()
                run.text = str(val).replace('**', '')
                run.font.name = FONT
                run.font.size = Pt(12)
                run.font.bold = (r == 0 or c == 0)
                run.font.color.rgb = WHITE if r == 0 else INK
                cell.margin_left = Inches(0.15)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        self.footer(sl)

    def closing(self):
        sl = self.prs.slides.add_slide(self.blank)
        self.rect(sl, 0, 0, 13.333, 7.5, PURPLE)
        self.text(sl, 0.9, 2.2, 11, 1, 'Need help?', size=40, bold=True, color=WHITE)
        self.text(sl, 0.9, 3.3, 11, 2.5, [
            'Click **Need help?** at the bottom of the left menu in Hadrius to contact Hadrius support.',
        ], size=17, color=WHITE, space=14)
        self.footer(sl, dark=True)


# --------------------------------------------------------------------------- export
def find_soffice():
    for c in (shutil.which('soffice'), '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice',
              '/Applications/LibreOffice.app/Contents/MacOS/soffice'):
        if c and os.path.exists(c):
            return c
    return None


def export_pdf(pptx_path: Path) -> tuple[Path | None, str | None]:
    pdf = pptx_path.with_suffix('.pdf')
    if pdf.exists():
        pdf.unlink()
    so = find_soffice()
    if so:
        try:
            subprocess.run([so, '--headless', '--convert-to', 'pdf', '--outdir', str(pptx_path.parent), str(pptx_path)],
                           check=True, capture_output=True, timeout=600)
            if pdf.exists():
                return pdf, None
        except Exception as e:
            log(f'LibreOffice export failed: {e}')
    if sys.platform == 'darwin' and os.path.isdir('/Applications/Keynote.app'):
        script = (
            'on run argv\n'
            '  set src to POSIX file (item 1 of argv)\n'
            '  set dst to POSIX file (item 2 of argv)\n'
            '  tell application "Keynote"\n'
            '    set d to open src\n'
            '    export d to dst as PDF\n'
            '    close d saving no\n'
            '  end tell\n'
            'end run')
        try:
            subprocess.run(['osascript', '-e', script, str(pptx_path), str(pdf)], check=True, capture_output=True, timeout=600)
            if pdf.exists():
                return pdf, None
        except Exception as e:
            log(f'Keynote export failed: {e}')
    return None, 'PDF export needs LibreOffice (brew install --cask libreoffice) or Keynote.'


def thumbnails(pdf: Path | None, out_dir: Path, fallback_images: list[str]):
    tdir = out_dir / 'thumbs'
    if tdir.exists():
        shutil.rmtree(tdir)
    tdir.mkdir(parents=True)
    names = []
    if pdf:
        try:
            import pymupdf
            doc = pymupdf.open(str(pdf))
            for i, page in enumerate(doc):
                n = f'{i + 1:03d}.png'
                page.get_pixmap(dpi=60).save(str(tdir / n))
                names.append(n)
            return names
        except Exception as e:
            log(f'thumbnails from PDF failed: {e}')
    for i, p in enumerate(fallback_images):
        n = f'{i + 1:03d}.png'
        im = Image.open(p).convert('RGB')
        im.thumbnail((800, 450))
        im.save(tdir / n)
        names.append(n)
    return names


def safe_filename(s):
    s = re.sub(r'[\\/:*?"<>|]+', '', str(s or 'Hadrius guide')).strip()
    return re.sub(r'\s+', ' ', s)[:120] or 'Hadrius guide'


def main():
    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text())
    out_dir = Path(spec.get('out_dir') or spec_path.parent)
    img_dir = out_dir / 'images'
    if img_dir.exists():
        shutil.rmtree(img_dir)
    img_dir.mkdir(parents=True)
    style = spec.get('style') if spec.get('style') in ('standard', 'detailed', 'visual') else 'standard'
    stats = {'slides': 0, 'boxed_dom': 0, 'boxed_ocr': 0, 'unboxed': 0, 'split_extra': 0}
    deck = Deck(spec)
    deck.cover()
    sections = [s for s in spec.get('sections') or [] if s.get('slides')]
    content_slides = sum(len(s['slides']) for s in sections)
    show_dividers = len(sections) >= 2 and content_slides >= 6
    if len(sections) >= 2 and style != 'visual':
        deck.contents(sections)
    images_used = []
    k = 0
    for si, sec in enumerate(sections):
        if show_dividers:
            deck.section(si + 1, sec.get('title', ''), sec.get('summary', ''))
        label = sec.get('title', '') if len(sections) > 1 else (spec.get('module') or '')
        for sd in sec['slides']:
            k += 1
            if sd.get('kind') == 'concept' or not sd.get('steps'):
                if style == 'visual' and not sd.get('image'):
                    continue
                img = plain_image(sd['image'], str(img_dir / f'{k:03d}.png')) if sd.get('image') and os.path.isfile(sd['image']) else None
                if img:
                    images_used.append(img)
                deck.concept(label, sd, img)
            else:
                boxes = resolve_boxes(sd['steps'], stats)
                runs = split_runs(sd['steps'], boxes)
                for ri, run in enumerate(runs):
                    part = dict(sd)
                    part['steps'] = [sd['steps'][i] for i in run]
                    if ri > 0:
                        part['lead'] = None
                        part['title'] = f"{sd.get('title', '')} (continued)"
                    if ri < len(runs) - 1:
                        part['tip'] = None
                        part['after'] = None
                    img, numbers = annotate(part['steps'], [boxes[i] for i in run], style, str(img_dir / f'{k:03d}_{ri + 1}.png'))
                    if img:
                        images_used.append(img)
                    deck.steps_slide(label, part, style, img, numbers)
                    stats['slides'] += 1
                    stats['split_extra'] += 1 if ri else 0
                continue
            stats['slides'] += 1
    if style != 'visual' and spec.get('quickref'):
        deck.quickref(spec['quickref'])
    deck.closing()
    name = safe_filename(spec.get('title'))
    pptx_path = out_dir / f'{name}.pptx'
    deck.prs.save(str(pptx_path))
    pdf, pdf_error = export_pdf(pptx_path)
    thumbs = thumbnails(pdf, out_dir, images_used)
    print(json.dumps({'ok': True, 'pptx': str(pptx_path), 'pdf': str(pdf) if pdf else None, 'pdfError': pdf_error,
                      'pages': len(deck.prs.slides), 'thumbs': thumbs, 'stats': stats}))


if __name__ == '__main__':
    main()
