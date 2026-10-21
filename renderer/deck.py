#!/usr/bin/env python3
"""Render a Create ✨ slide deck: annotated screenshots -> PowerPoint -> PDF -> page thumbnails.

Input is a deck spec written by tools/deck-studio.mjs (out/_decks/<id>/spec.json). Every
screenshot is a recorded step's own capture (out/_recordings/<recording>/step_<id>.png) and every
red box comes from data, never from a guess:

  1. the recorder's DOM bounding box for the clicked/typed element (target.hint.bbox, CSS px of
     the captured viewport, scaled by image width / viewport width), else
  2. macOS Vision OCR of the screenshot, boxing the step's target label when it appears exactly
     once (icon-only controls and ambiguous labels get no box rather than a wrong one).

Every box is checked against its own screenshot before it is drawn: a box over blank space (the
capture is stale or the page had scrolled) is dropped, and a box sitting on other text while the
step's label is clearly elsewhere on screen moves to the label (clicks) or is dropped (typing).
A capture that is byte-identical to an earlier step's capture from more than a second before, and
doesn't show the step's element where the recorder says it was, is stale (the recorder reused an old
screenshot): it gets no box and is never used as a slide picture. A text field found only by OCR of
its placeholder is boxed along the field's own border.

A slide can group several steps on one screen. The slide shows the last boxed step's screenshot
and an earlier step only keeps its box there if the element's edges are still in the same place on
that screenshot (a closed menu, a dialog that covers it, or a scrolled page fails the check);
otherwise the step starts a "(continued)" slide with its own screenshot. Numbers in the text always
match the badges drawn, because both are assigned here.

Usage: deck.py <spec.json>   ->  prints a JSON result line {pptx, pdf, thumbs, stats}
"""
from __future__ import annotations

import difflib
import hashlib
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


# --------------------------------------------------------------------------- text measurement
# Text boxes don't grow or shrink on their own (python-pptx writes no autofit, and LibreOffice's PDF export
# draws overflowing text past the shape), so every layout decision measures the text with the real Arial
# metrics and wraps it the way PowerPoint/LibreOffice do: greedy, at spaces, bold runs (**...**) in Arial Bold.
ARIAL = ('/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf')
LINE_EM = 1.35          # line pitch at line_spacing 1.12 (measured 1.342 em in the exported PDFs), slightly padded
_mfonts: dict = {}


def _mfont(bold):
    if bold not in _mfonts:
        try:
            _mfonts[bold] = ImageFont.truetype(ARIAL[1 if bold else 0], 100)
        except Exception:
            _mfonts[bold] = font(100, bold)
    return _mfonts[bold]


def _width_pt(s, size, bold):
    return _mfont(bold).getlength(s) * size / 100


def wrap_count(text, width_in, size, bold=False):
    """Lines `text` takes in a text box `width_in` wide (box margins included) at `size` pt."""
    avail = (width_in - 0.04) * 72 - 3          # 0.02in margins each side, a little slack for rounding
    total = 0
    for para in str(text).split('\n'):
        words = []                               # each word: [(chunk, bold), ...] (a word can straddle a ** edge)
        cur, glued = [], False
        for j, chunk in enumerate(re.split(r'\*\*', para)):
            b = bold or (j % 2 == 1)
            parts = chunk.split(' ')
            for k, part in enumerate(parts):
                if k > 0:
                    if cur:
                        words.append(cur)
                    cur = []
                if part:
                    cur.append((part, b))
        if cur:
            words.append(cur)
        space = _width_pt(' ', size, bold)
        lines, x = 1, 0.0
        for w in words:
            ww = sum(_width_pt(c, size, b) for c, b in w)
            if x and x + space + ww > avail:
                lines += 1
                x = ww
            else:
                x = x + space + ww if x else ww
            while x > avail:                     # a single word wider than the box breaks mid-word
                lines += 1
                x -= avail
        total += lines
    return total


def line_h(size):
    return size * LINE_EM / 72


def text_h(paras, width_in, size, space=6, bold=False):
    """Height (in) a text() box needs for these paragraphs."""
    if isinstance(paras, str):
        paras = [paras]
    paras = [p for p in paras if p]
    if not paras:
        return 0.0
    n = sum(wrap_count(p, width_in, size, bold) for p in paras)
    return n * line_h(size) + space * (len(paras) - 1) / 72 + 0.06


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


def content_ok(img: Image.Image, box, edge=False) -> bool:
    """Something is drawn inside the box (text, a border, an icon, a toggle). A recorded box over blank page or
    a flat dialog backdrop means the screenshot doesn't show the element there (stale capture, scrolled page).
    Calibrated on real decks: boxes on the element have a grey-level range of 89+, blank ones 0-27; pale
    controls (an "off" toggle) have a small range but fill a large share of the box. `edge` (text fields) widens
    the crop by 8 CSS px: a recorded input is often just the borderless text area inside the visible field, so
    an empty one is blank inside while its border sits a few px outside."""
    p = int(round(8 * img.size[0] / 1600.0)) if edge else 0
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    c = img.crop((max(0, x0 - p), max(0, y0 - p), min(img.size[0], x1 + p), min(img.size[1], y1 + p))).convert('L')
    if c.size[0] < 2 or c.size[1] < 2:
        return False
    lo, hi = c.getextrema()
    if hi - lo >= 48:
        return True
    px = c.tobytes()
    med = sorted(px)[len(px) // 2]
    return sum(1 for v in px if abs(v - med) > 10) / len(px) >= 0.06


def _label_match(t, want):
    return t == want or (len(t) <= len(want) + 4 and difflib.SequenceMatcher(None, t, want).ratio() >= 0.88)


def _gap(a, b):
    """Distance between two boxes (0 if they touch or overlap)."""
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + dy * dy) ** 0.5


def label_elsewhere(step, box, img_size):
    """The OCR box of the step's label if the DOM box sits on OTHER text while the label shows exactly once,
    well away from it (the recorder's box belongs to a different element than the screenshot shows)."""
    want = norm(step.get('label'))
    if len(want) < 3 or len(want.split()) > 5:
        return None
    lines = [(norm(t), b) for t, b in ocr_lines(step['image'])]
    hits = [b for t, b in lines if t and any(_label_match(c, want) for c in {t, ' '.join(t.split()[1:])} if c)]
    if len(hits) != 1:
        return None
    s = img_size[0] / 1600.0
    if _gap(hits[0], box) <= 90 * s:  # a field label above its input, a checkbox's text beside it
        return None
    inside = [t for t, b in lines if t and _overlap_frac(b, box) > 0.5]
    if not inside or any(want in t or t in want for t in inside):
        return None
    x0, y0, x1, y1 = hits[0]
    return [x0 - 8, y0 - 6, x1 + 8, y1 + 6]


def _overlap_frac(b, box):
    ix = max(0, min(b[2], box[2]) - max(b[0], box[0]))
    iy = max(0, min(b[3], box[3]) - max(b[1], box[1]))
    return ix * iy / max(1.0, (b[2] - b[0]) * (b[3] - b[1]))


TYPING = ('type', 'fill')
VALUE_ROLES = {'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider'}


def _is_field(step):
    return step.get('action') in TYPING or str(step.get('role') or '').lower() in VALUE_ROLES


def _field_box(img: Image.Image, box):
    """A text field found by OCR of its placeholder ("Title") gets boxed around the placeholder text only, which
    looks wrong once the field holds a longer value ("Compliance Testi|ng"). Find the field's own border instead:
    flood-fill its background from just right of the text and take the filled area. None unless the fill closes
    (the field has a visible border), stays field-sized and keeps the text at its top-left, as a field's
    content is; then the OCR box stays as it was."""
    W, H = img.size
    s = W / 1600.0
    tx0, ty0, tx1, ty1 = box[0] + 8, box[1] + 6, box[2] - 8, box[3] - 6       # ocr_box() pads 8/6
    max_w, max_h = 1000 * s, 220 * s
    cx0, cy0 = max(0, int(tx0 - 60 * s)), max(0, int(ty0 - 40 * s))
    cx1, cy1 = min(W, int(tx0 + max_w)), min(H, int(ty0 + max_h))
    c = img.crop((cx0, cy0, cx1, cy1)).convert('L')
    cw, ch = c.size
    px = c.load()
    sx, sy = int(tx1 + 6 * s) - cx0, int((ty0 + ty1) / 2) - cy0
    if not (0 <= sx < cw and 0 <= sy < ch):
        return None
    bg = px[sx, sy]
    seen = bytearray(cw * ch)
    seen[sy * cw + sx] = 1
    stack, n = [(sx, sy)], 0
    minx = maxx = sx
    miny = maxy = sy
    while stack:
        x, y = stack.pop()
        n += 1
        minx, maxx, miny, maxy = min(minx, x), max(maxx, x), min(miny, y), max(maxy, y)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if not (0 <= nx < cw and 0 <= ny < ch):
                return None                      # ran out of the search area: no closed border
            i = ny * cw + nx
            if not seen[i] and abs(px[nx, ny] - bg) <= 8:
                seen[i] = 1
                stack.append((nx, ny))
    fx0, fy0, fx1, fy1 = cx0 + minx, cy0 + miny, cx0 + maxx + 1, cy0 + maxy + 1
    if not (fx0 <= tx0 + 2 * s and fx1 >= tx1 and fy0 <= ty0 + 2 * s and fy1 >= ty1 - 2 * s):
        return None                              # the fill didn't flow around the text
    if tx0 - fx0 > 48 * s or ty0 - fy0 > 24 * s or n < 0.6 * (fx1 - fx0) * (fy1 - fy0):
        return None                              # text not at the top-left, or not a mostly empty rectangle
    p = 2 * s
    return [max(0, fx0 - p), max(0, fy0 - p), min(W, fx1 + p), min(H, fy1 + p)]


def step_box(step, img_size, why=None):
    """Box for a step in its OWN capture's pixel space, with where it came from. `why` (a dict) collects
    the reason a recorded box was dropped or moved, for the build stats."""
    why = why if why is not None else {}
    img = load(step['image']) if step.get('image') else None
    bb, vp = step.get('bbox'), step.get('viewport')
    if bb and vp and vp.get('w') and bb.get('w', 0) > 2 and bb.get('h', 0) > 2 and img is not None:
        k = img_size[0] / float(vp['w'])
        x0, y0 = bb['x'] * k, bb['y'] * k
        x1, y1 = (bb['x'] + bb['w']) * k, (bb['y'] + bb['h']) * k
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(img_size[0], x1), min(img_size[1], y1)
        if x1 - x0 > 4 and y1 - y0 > 4:
            box = [x0, y0, x1, y1]
            if not content_ok(img, box, edge=_is_field(step)):
                why['blank'] = why.get('blank', 0) + 1     # the screenshot doesn't show the element there
            else:
                moved = label_elsewhere(step, box, img_size) if step.get('label') else None
                if moved is None:
                    return box, 'dom'
                if step.get('action') in TYPING:
                    why['conflict'] = why.get('conflict', 0) + 1
                    return None, None
                why['moved'] = why.get('moved', 0) + 1
                return moved, 'ocr'
    if step.get('label') and step.get('image'):
        b = ocr_box(step['image'], step['label'])
        if b and content_ok(img, b):
            return ((_field_box(img, b) or b) if _is_field(step) else b), 'ocr'
    return None, None


def _edges(img: Image.Image, win):
    g = img.crop(win).convert('L').filter(ImageFilter.FIND_EDGES)
    return g.point(lambda v: 255 if v > 48 else 0)


def _edge_keep(a: Image.Image, b: Image.Image, win):
    """Share of a's edge pixels with an edge within 1px on b, and the reverse (min of the two). None if either
    side has no edges at all (nothing to compare)."""
    ea, eb = _edges(a, win), _edges(b, win)
    da, db = ea.filter(ImageFilter.MaxFilter(3)), eb.filter(ImageFilter.MaxFilter(3))
    pa, pb, qa, qb = ea.tobytes(), eb.tobytes(), da.tobytes(), db.tobytes()
    na = sum(1 for v in pa if v)
    nb = sum(1 for v in pb if v)
    if na == 0 or nb == 0:
        return None
    keep_a = sum(1 for v, w in zip(pa, qb) if v and w) / na
    keep_b = sum(1 for v, w in zip(pb, qa) if v and w) / nb
    return min(keep_a, keep_b)


def _mean(img: Image.Image, win):
    c = img.crop(win).convert('L').resize((16, 16))
    return sum(c.tobytes()) / 256.0


def same_region(a: Image.Image, b: Image.Image, box, loose=False):
    """True if the element in `box` (on capture `a`) is still drawn, unchanged and uncovered, in the same place
    on capture `b`, so a box drawn there on `b` still points at it.

    Compares edges (text strokes, borders, icons) in the box plus a 12px ring, at least 64px tall: 75%+ of each
    side's edge pixels must have an edge within 1px on the other. Calibrated on 82 labelled shares from four
    decks: wrong ones (closed dropdown, scrolled dialog, popover over the control, different page, a look-alike
    checkbox that slid into place) scored <= 0.68, so 0.75 keeps a margin; a right share that scores lower just
    starts a "(continued)" slide. The box interior must match the same way unless `loose` (typing, toggles,
    selects: the value inside may change). A window that got much darker or lighter means a modal backdrop now
    covers the element (or was lifted). Button text that changed in place ("Next" -> "Save and next") is caught
    by same_text()."""
    if a.size != b.size:
        return False
    W, H = a.size
    s = W / 1600.0
    x0, y0, x1, y1 = box
    m = 12 * s
    # at least 64 CSS px tall: a small control (a row's checkbox) needs the rows around it in view, or a
    # look-alike that slid into its place (the header checkbox, once a toolbar pushed the table down) matches
    cy, hh = (y0 + y1) / 2, max((y1 - y0) / 2 + m, 32 * s)
    win = (int(max(0, x0 - m)), int(max(0, cy - hh)), int(min(W, x1 + m)), int(min(H, cy + hh)))
    if win[2] - win[0] < 4 or win[3] - win[1] < 4:
        return False
    la, lb = _mean(a, win), _mean(b, win)
    if lb < 0.85 * la or la < 0.85 * lb:
        return False
    keep = _edge_keep(a, b, win)
    if keep is None or keep < 0.75:
        return False                                     # nothing to compare, or the surroundings changed
    if loose:
        return True
    inner = (int(max(0, x0)), int(max(0, y0)), int(min(W, x1)), int(min(H, y1)))
    if inner[2] - inner[0] < 3 or inner[3] - inner[1] < 3:
        return True
    k_in = _edge_keep(a, b, inner)
    return k_in is None or k_in >= 0.8


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


LOOSE_ROLES = {'checkbox', 'switch', 'radio', 'option', 'tab', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider'}


def resolve_boxes(slide_steps, stats):
    """Each step's box in its own capture (or None)."""
    out = []
    for st in slide_steps:
        if not st.get('image') or not os.path.isfile(st['image']) or st.get('nobox'):
            out.append(None)
            continue
        if st.get('_stale'):
            stats['stale'] = stats.get('stale', 0) + 1
            out.append(None)
            continue
        why = {}
        box, src = step_box(st, load(st['image']).size, why)
        for k, v in why.items():
            stats['box_' + k] = stats.get('box_' + k, 0) + v
        if box:
            stats['boxed_' + str(src)] += 1
        else:
            stats['unboxed'] += 1
        out.append(box)
    return out


def capture_ms(path):
    """Capture time in ms from a recorder file name (step_<base36 ms><3 random>.png), or None."""
    m = re.match(r'step_([0-9a-z]{8})[0-9a-z]{4}\.png$', os.path.basename(str(path)))
    if not m:
        return None
    ms = int(m.group(1), 36)
    return ms if 1.5e12 < ms < 2.2e12 else None


def _dom_box(step, size):
    bb, vp = step.get('bbox'), step.get('viewport')
    if not (bb and vp and vp.get('w') and bb.get('w', 0) > 2 and bb.get('h', 0) > 2):
        return None
    k = size[0] / float(vp['w'])
    return [max(0, bb['x'] * k), max(0, bb['y'] * k), min(size[0], (bb['x'] + bb['w']) * k), min(size[1], (bb['y'] + bb['h']) * k)]


def mark_stale(spec):
    """Flag captures the recorder reused from an earlier moment: byte-identical to an earlier step's capture
    taken more than a second before it AND the step's recorded element isn't drawn where the recorder says
    (seen on a recording where five steps on a policy page all carry the policies-list screenshot). Such a
    picture doesn't show what the step describes, so it gets no box and never becomes a slide's picture.
    Identical frames alone aren't enough: clicking an already-selected radio legitimately changes nothing,
    and two steps captured in the same instant (a typed value flushed by the next click) share one frame."""
    first = {}
    for sec in spec.get('sections') or []:
        for sd in sec.get('slides') or []:
            for st in sd.get('steps') or []:
                p = st.get('image')
                st['_stale'] = False
                if not p or not os.path.isfile(p):
                    continue
                h = hashlib.md5(Path(p).read_bytes()).hexdigest()
                p0 = first.setdefault(h, p)
                t0, t1 = capture_ms(p0), capture_ms(p)
                if p0 == p or t0 is None or t1 is None or abs(t1 - t0) <= 1000:
                    continue
                img = load(p)
                box = _dom_box(st, img.size)
                st['_stale'] = box is not None and not content_ok(img, box, edge=_is_field(st))


def _texts_in(path, box):
    return [norm(t) for t, b in ocr_lines(path) if norm(t) and _overlap_frac(b, box) >= 0.5]


def _says(texts, want):
    return any(_label_match(c, want) for t in texts for c in (t, ' '.join(t.split()[1:])) if c)


def same_text(st, box, base_path):
    """If the step's own capture shows its label as the element's text inside the box, the base must show the
    same text there: edges alone can't tell "Next" from "Save and next" in the same spot."""
    want = norm(st.get('label'))
    if not want or len(want.split()) > 5 or _is_field(st):
        return True
    if not _says(_texts_in(st['image'], box), want):
        return True          # the label isn't visible text inside the box (icon button, checkbox): nothing to compare
    return _says(_texts_in(base_path, box), want)


def visible_on(st, box, base_path):
    if st['image'] == base_path:
        return True
    loose = st.get('action') in ('type', 'select', 'fill') or str(st.get('role') or '').lower() in LOOSE_ROLES
    return same_region(load(st['image']), load(base_path), box, loose=loose) and same_text(st, box, base_path)


def split_runs(slide_steps, boxes):
    """Group consecutive steps that can share one screenshot (the run's last capture) with every
    box still visible on it. A step whose element is gone from the later screen (menu closed,
    dialog opened, page changed) starts a new run instead of losing its box."""
    runs, cur = [], []
    for i, st in enumerate(slide_steps):
        has_img = bool(st.get('image') and os.path.isfile(st['image'])) and not st.get('_stale')
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
    with_img = [s for s in run_steps if s.get('image') and os.path.isfile(s['image']) and not s.get('_stale')]
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
        self.overflows = []
        self.footer_text = f"{spec.get('title', 'Hadrius guide')}"

    def overflow(self, msg):
        self.overflows.append(f'slide {len(self.prs.slides)}: {msg}')
        log(f'layout: {msg}')

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
        size = 25 if not compact else 21
        while size > 16 and self.lines_for(title, 12.3, size, bold=True) > 1:
            size -= 1
        self.text(sl, 0.5, 0.54 if not compact else 0.45, 12.3, 0.6, title, size=size, bold=True)

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
    def lines_for(s, width_in, size, bold=False):
        return wrap_count(s, width_in, size, bold)

    def list_height(self, items, w, size, gap):
        h = 0
        for num, s in items:
            tw = w - (0.45 if num is not None else 0)
            h += max(self.lines_for(s, tw, size) * line_h(size) + 0.06, 0.36) + gap
        return h - gap if items else 0

    def fit_list(self, items, w, max_h, size=12.5, gap=0.14, min_size=9.5):
        """Largest (size, gap) at which the list fits max_h, or None if it doesn't fit even at min_size."""
        while True:
            if self.list_height(items, w, size, gap) <= max_h:
                return size, gap
            if size <= min_size:
                return None
            size -= 0.5
            gap = max(0.06, gap - 0.01)

    def steps_list(self, sl, items, x, y, w, max_h, size=12.5, gap=0.14):
        """items: [(number|'•'|None, text)]; shrinks the font until the list fits max_h."""
        fit = self.fit_list(items, w, max_h, size, gap)
        if fit:
            size, gap = fit
        else:
            size, gap = 9.5, 0.06
            self.overflow(f'list does not fit {max_h:.2f}in: {str(items[0][1])[:50]}')
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
            hgt = self.lines_for(s, w - indent, size) * line_h(size) + 0.06
            self.text(sl, x + indent, cy, w - indent, hgt, s, size=size, space=0)
            cy += max(hgt, 0.36) + gap
        return cy

    def tip_layout(self, s, w=8.3, max_h=1.5):
        """(size, box height) for a tip box: 11.5pt down to 9.5pt, the box grows to fit (at least 0.62in)."""
        for size in (11.5, 11, 10.5, 10, 9.5):
            h = max(0.62, text_h(s, w - 0.3, size) + 0.16)
            if h <= max_h:
                return size, h
        return 9.5, h

    def tip(self, sl, s, x=0.5, bottom=6.92, w=8.3):
        size, h = self.tip_layout(s, w)
        y = bottom - h
        self.rect(sl, x, y, w, h, LIGHT)
        self.rect(sl, x, y, 0.06, h, PURPLE)
        self.text(sl, x + 0.2, y, w - 0.3, h, s, size=size, anchor=MSO_ANCHOR.MIDDLE)
        return y

    # ------------------------------------------------------------------ slide types
    def cover(self):
        sp = self.spec
        sl = self.prs.slides.add_slide(self.blank)
        self.rect(sl, 0, 5.6, 13.333, 1.9, PURPLE)
        if LOGO.exists():
            sl.shapes.add_picture(str(LOGO), Inches(0.9), Inches(0.75), height=Inches(0.72))
        # long titles wrap: shrink a little and push the subtitle down so the two never overlap
        title = sp.get('title') or 'Getting Started Guide'
        size = 40 if self.lines_for(title, 11.6, 40, bold=True) <= 1 else 34
        n = min(3, self.lines_for(title, 11.6, size, bold=True))
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
                sz = next((z for z in (11, 10.5, 10, 9.5) if text_h(sec['summary'], 5.4, z) <= row_h - 0.34), None)
                if sz:
                    self.text(sl, x + 0.7, y + 0.32, 5.4, row_h - 0.34, sec['summary'], size=sz, color=GRAY)
        self.footer(sl)

    def section(self, num, title, blurb):
        sl = self.prs.slides.add_slide(self.blank)
        self.rect(sl, 0, 0, 13.333, 7.5, PURPLE)
        self.text(sl, 0.9, 2.2, 3, 1.2, f'{num:02d}', size=60, color=PALE, bold=True)
        n = min(3, self.lines_for(title, 11.4, 34, bold=True))
        th = n * 34 * 1.2 / 72 + 0.1
        self.text(sl, 0.9, 3.35, 11.4, th, title, size=34, color=WHITE, bold=True)
        if blurb:
            self.text(sl, 0.9, max(4.35, 3.35 + th + 0.2), 10.8, 1.4, blurb, size=16, color=RGBColor(0xE4, 0xE0, 0xF7))
        self.footer(sl, dark=True)

    def concept(self, section, sd, image=None):
        sl = self.prs.slides.add_slide(self.blank)
        self.header(sl, section, sd.get('title', ''))
        lead = sd.get('lead')
        body = [p for p in (sd.get('body') or []) if p]
        bullets = [('•', b) for b in (sd.get('bullets') or []) if b]
        top, bottom = 1.5, 6.85

        def layout(w, k):
            """Heights of the lead, body and bullets at scale k, or None if they don't fit."""
            lh = text_h(lead, w, 15 * k) if lead else 0
            bh = text_h(body, w, 13 * k, space=8 * k) if body else 0
            gaps = 0.16 * (bool(lead) + bool(body) + bool(bullets) - 1) if (lead or body or bullets) else 0
            room = bottom - top - lh - bh - max(gaps, 0)
            if room < 0:
                return None
            fit = self.fit_list(bullets, w, room, 12.5 * k, 0.1, min_size=9.5) if bullets else (0, 0)
            return (lh, bh, fit) if fit else None

        # text column options: beside the full-size picture, beside a narrower picture, then (last resort) the
        # smallest text beside the narrow picture even if it still overflows (reported, never silently clipped)
        options = [(7.4, 8.2, 4.63), (6.3, 7.1, 5.73)] if image else [(None, 0.5, 12.3)]
        chosen = None
        for pic_w, x, w in options:
            for k in (1.0, 0.95, 0.9, 0.85, 0.8, 0.76):
                got = layout(w, k)
                if got:
                    chosen = (pic_w, x, w, k, got)
                    break
            if chosen:
                break
        if not chosen:
            # too much for one slide: move trailing bullets, then trailing body paragraphs, to a "(continued)"
            # text-only slide until this one fits beside the picture
            items = [('b', p) for p in body] + [('u', t) for _, t in bullets]
            rest = []
            while items and not chosen:
                rest.insert(0, items.pop())
                body = [t for kind, t in items if kind == 'b']
                bullets = [('•', t) for kind, t in items if kind == 'u']
                for pic_w, x, w in options:
                    got = layout(w, 0.9)
                    if got:
                        chosen = (pic_w, x, w, 0.9, got)
                        break
            if chosen and not items and not lead:
                chosen = None           # nothing would stay on this slide: splitting can't help
            if not chosen:  # a single block too big for a slide: smallest text, reported
                body = [p for p in (sd.get('body') or []) if p]
                bullets = [('•', b) for b in (sd.get('bullets') or []) if b]
                rest = []
                pic_w, x, w = options[-1]
                chosen = (pic_w, x, w, 0.76, (text_h(lead, w, 15 * 0.76) if lead else 0,
                                              text_h(body, w, 13 * 0.76, space=6) if body else 0, (9.5, 0.06)))
                self.overflow(f'concept text does not fit: {sd.get("title", "")[:50]}')
            cont = {'title': f"{sd.get('title', '')} (continued)".replace(' (continued) (continued)', ' (continued)'),
                    'body': [t for kind, t in rest if kind == 'b'], 'bullets': [t for kind, t in rest if kind == 'u']}
        else:
            cont = None
        pic_w, x, w, k, (lh, bh, fit) = chosen
        if image:
            self.picture(sl, image, 0.5, 1.45, pic_w, 5.3)
        y = top
        if lead:
            self.text(sl, x, y, w, lh, lead, size=15 * k, color=PURPLE_DARK)
            y += lh + 0.16
        if body:
            self.text(sl, x, y, w, bh, body, size=13 * k, space=8 * k)
            y += bh + 0.16
        if bullets:
            self.steps_list(sl, bullets, x, y, w, bottom - y, size=fit[0], gap=fit[1])
        self.footer(sl)
        if cont and (cont['body'] or cont['bullets']):
            self.concept(section, cont)

    def text_only_steps(self, sl, sd, steps):
        """A steps slide with no trustworthy screenshot (every capture was stale or missing): the lead, the
        numbered steps and any notes across the full width instead of beside an empty picture area."""
        x, w, y = 0.5, 12.3, 1.5
        if sd.get('lead'):
            lh = text_h(sd['lead'], w, 15)
            self.text(sl, x, y, w, lh, sd['lead'], size=15, color=PURPLE_DARK)
            y += lh + 0.18
        notes = [p for p in (sd.get('body') or []) if p] + [p for p in (sd.get('after') or []) if p]
        tip = sd.get('tip')
        tip_h = self.tip_layout(tip, w)[1] if tip else 0
        items = [(i + 1, st['text']) for i, st in enumerate([s for s in steps if s.get('text')])]
        items += [('•', p) for p in notes]
        bottom = 6.85 - (tip_h + 0.15 if tip else 0)
        if items:
            self.steps_list(sl, items, x, y, w, bottom - y, size=13.5, gap=0.12)
        if tip:
            self.tip(sl, tip, x=x, w=w)

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
        more = []
        if not img:
            self.text_only_steps(sl, sd, steps)
        elif style == 'standard':
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
            # the step list gets a wider column (narrower picture) when it can't fit beside the full-size one
            pic_w, tx, tw = 8.3, 9.05, 3.8
            if items and not self.fit_list(items, tw, 5.4):
                pic_w, tx, tw = 7.3, 8.05, 4.8
            pic_bottom = 6.85
            if sd.get('tip'):
                pic_bottom = self.tip(sl, sd['tip'], w=pic_w) - 0.12
            if img:
                self.picture(sl, img, 0.5, 1.45, pic_w, pic_bottom - 1.45)
            self.steps_list(sl, items, tx, 1.45, tw, 5.4)
        else:  # detailed: smaller image, rich text, outline-only markup
            x, w = 7.65, 5.18
            y = 1.45
            if sd.get('lead'):
                lh = text_h(sd['lead'], w, 13.5)
                self.text(sl, x, y, w, lh, sd['lead'], size=13.5, color=PURPLE_DARK)
                y += lh + 0.14
            items = [(i + 1, st['text']) for i, st in enumerate([s for s in steps if s.get('text')])]
            y = self.steps_list(sl, items, x, y, w, 6.85 - y, size=12, gap=0.1)
            body = [p for p in (sd.get('body') or []) if p]
            notes = body + ([f"**Good to know:** {sd['tip']}"] if sd.get('tip') else [])
            pic_h = 3.95
            more = []
            if notes:
                # the notes box sits under the picture and grows to fit its text; the picture gives up height
                # (down to 2.6in) when the notes need more room. Whatever still doesn't fit continues on a
                # text-only "(continued)" slide rather than running out of the box.
                max_nh = 6.9 - 1.45 - 0.15 - 2.6
                while True:
                    for size in (11.5, 11, 10.5, 10, 9.5):
                        nh = text_h(notes, 6.55, size, space=4) + 0.16
                        if nh <= 1.3:
                            break
                    if nh <= max_nh or len(notes) == 1:
                        break
                    more.insert(0, notes.pop())
                if nh > max_nh:                 # one paragraph too long for the box on its own
                    more.insert(0, notes.pop())
                    nh = 0
                pic_h = min(3.95, 6.9 - 1.45 - 0.15 - nh) if notes else 3.95
            ph = 0
            if img:
                _, ph = self.picture(sl, img, 0.5, 1.45, 6.9, pic_h)
            if notes:
                notes_y = 1.45 + (ph or pic_h) + 0.15
                nh = min(nh, 6.92 - notes_y)
                self.rect(sl, 0.5, notes_y, 6.9, nh, LIGHT)
                self.rect(sl, 0.5, notes_y, 0.06, nh, PURPLE)
                self.text(sl, 0.72, notes_y + 0.08, 6.55, nh - 0.1, notes, size=size, space=4)
        if sd.get('notes'):
            sl.notes_slide.notes_text_frame.text = str(sd['notes'])
        self.footer(sl)
        if style == 'detailed' and more:
            self.concept(section, {'title': f"{sd.get('title', '')} (continued)".replace(' (continued) (continued)', ' (continued)'),
                                   'body': more})

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
    mark_stale(spec)
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
                        part['body'] = None          # the notes go with the first part, not repeated on each
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
    # check what was actually exported: text past the footer, out of its box, onto a screenshot, into other text
    layout = list(deck.overflows)
    if pdf:
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            import deck_qa
            found, _ = deck_qa.check(pptx_path)
            layout += [f'page {pg}: {msg}' for pg, msg in found]
        except Exception as e:  # never fail a build over the check itself
            log(f'layout check skipped: {e}')
    for m in layout:
        log(f'LAYOUT {m}')
    stats['layout_issues'] = len(layout)
    print(json.dumps({'ok': True, 'pptx': str(pptx_path), 'pdf': str(pdf) if pdf else None, 'pdfError': pdf_error,
                      'pages': len(deck.prs.slides), 'thumbs': thumbs, 'stats': stats, 'layout': layout}))


if __name__ == '__main__':
    main()
