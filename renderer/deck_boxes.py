"""Contact sheets of every red box a deck draws, for reviewing markup by eye.

Each tile is the screenshot the slide actually shows (the run's base capture), cropped around one box, with the
step's label in the caption. Yellow captions: the box is on the step's own capture. Cyan: it was carried onto a
later step's capture (the cases same_region()/same_text() have to get right).

    .venv/bin/python renderer/deck_boxes.py out/_decks/<id>/spec.json <out dir>   ->  <out dir>/boxes_NN.png
"""
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import deck as D  # noqa: E402

TW, TH = 480, 300


def tile(im, box, caption, shared):
    x0, y0, x1, y1 = box
    s = im.size[0] / 1600
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w = max(x1 - x0 + 260 * s, 520 * s)
    h = max(w * TH / TW, y1 - y0 + 160 * s)
    w = h * TW / TH
    cr = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    c = Image.new('RGB', (int(w), int(h)), (60, 60, 60))
    c.paste(im.crop(tuple(int(v) for v in cr)), (0, 0))
    ImageDraw.Draw(c).rectangle([x0 - cr[0], y0 - cr[1], x1 - cr[0], y1 - cr[1]], outline=(255, 0, 0), width=max(2, int(3 * s)))
    c = c.resize((TW, TH))
    d = ImageDraw.Draw(c)
    try:
        f = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 15)
    except OSError:
        f = ImageFont.load_default()
    d.rectangle([0, 0, TW, 20], fill=(0, 0, 0))
    d.text((4, 2), caption[:64], font=f, fill=(0, 255, 255) if shared else (255, 255, 0))
    return c


def main(spec_path, out_dir):
    spec = json.loads(Path(spec_path).read_text())
    os.makedirs(out_dir, exist_ok=True)
    D.mark_stale(spec)
    stats = {'slides': 0, 'boxed_dom': 0, 'boxed_ocr': 0, 'unboxed': 0, 'split_extra': 0}
    tiles = []
    for si, sec in enumerate(spec.get('sections') or []):
        for li, sd in enumerate(sec.get('slides') or []):
            steps = sd.get('steps') or []
            if not steps or sd.get('kind') == 'concept':
                continue
            boxes = D.resolve_boxes(steps, stats)
            for run in D.split_runs(steps, boxes):
                boxed = [i for i in run if boxes[i] is not None]
                if not boxed:
                    continue
                base = steps[boxed[-1]]['image']
                im = D.load(base)
                for i in boxed:
                    shared = steps[i]['image'] != base
                    cap = f"#{len(tiles)} {si}.{li}.{i} {'shared' if shared else 'own'} {steps[i].get('action')}: {steps[i].get('label') or ''}"
                    tiles.append(tile(im, boxes[i], cap, shared))
    for n in range(0, len(tiles), 20):
        sheet = Image.new('RGB', (TW * 4, TH * 5), 'white')
        for k, t in enumerate(tiles[n:n + 20]):
            sheet.paste(t, ((k % 4) * TW, (k // 4) * TH))
        sheet.save(os.path.join(out_dir, f'boxes_{n // 20:02d}.png'))
    print(json.dumps({'boxes': len(tiles), 'sheets': -(-len(tiles) // 20), 'stats': stats}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
