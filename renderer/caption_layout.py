"""Detect a legacy caption layout from exact saved caption pixels; no TTS/assemble import or media render."""
import argparse
import json
from pathlib import Path

from . import drift_render, fx_draw


def detect_caption_layout(assembly_path, build_dir, output, report_fields=None):
    assembly = json.loads(Path(assembly_path).read_bytes())
    build = Path(build_dir)
    flags = report_fields or {}
    expected, missing = [], []
    if not flags.get('no_captions'):
        for slide in assembly['slides']:
            text = slide.get('_cap_text') or slide.get('caption') or slide.get('narration') or ''
            if text and not str(slide.get('file', '')).endswith('.mp4'):
                path = build / f"cap{slide['slide']:02d}.png"
                if not path.is_file() or path.is_symlink():
                    missing.append(slide['slide'])
                    continue
                expected.append((slide, text, path))
    if missing and not expected:
        raise ValueError(f"baseline_caption_missing:{missing[0]}")
    out = drift_render.new_dir(output)
    if not expected:
        result = {'ok': True, 'font_layout': 'basic', 'reason': 'no_caption_pixels_used', 'captions': 0, 'matches': {}}
    else:
        from PIL import Image
        matches = {}
        for layout in fx_draw.FONT_LAYOUTS:
            engine_dir = out / layout
            engine_dir.mkdir()
            try:
                drawer = fx_draw.load(out_dir=engine_dir, tmp_dir=engine_dir,
                                      needs_drawn_highlight=flags.get('source') == 'recording', font_layout=layout)
                rows = []
                for slide, text, path in expected:
                    candidate = engine_dir / path.name
                    pos = slide.get('caption_pos') or flags.get('caption_pos') or 'center'
                    drawer.ns['caption_png'](text, candidate, pos=pos)
                    with Image.open(path) as a, Image.open(candidate) as b:
                        left, right = a.convert('RGBA'), b.convert('RGBA')
                        equal = left.size == right.size and left.tobytes() == right.tobytes()
                    rows.append({'slide': slide['slide'], 'pixels_equal': equal,
                                 'baseline_sha256': fx_draw.sha256_file(path), 'probe_sha256': fx_draw.sha256_file(candidate)})
                matches[layout] = {'all_pixels_equal': all(row['pixels_equal'] for row in rows), 'rows': rows}
            except (OSError, RuntimeError) as error:
                matches[layout] = {'all_pixels_equal': False, 'error': str(error)}
        good = [layout for layout in fx_draw.FONT_LAYOUTS if matches[layout]['all_pixels_equal']]
        result = {'ok': bool(good), 'font_layout': good[0] if good else None,
                  'reason': 'all_saved_caption_pixels_equal' if good else 'no_layout_reproduces_saved_captions',
                  'captions': len(expected), 'missing_caption_slides': missing, 'equivalent_layouts': good, 'matches': matches,
                  'limitation': 'Layout proposal from available saved caption images; the full original-image control remains mandatory for every changed slide, including missing caption PNGs.'}
    (out / 'caption-layout.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assembly', required=True)
    parser.add_argument('--build-dir', required=True)
    parser.add_argument('--report')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    flags = json.loads(Path(args.report).read_bytes()) if args.report else {}
    result = detect_caption_layout(args.assembly, args.build_dir, args.output, flags)
    print(json.dumps({'ok': result['ok'], 'font_layout': result['font_layout'], 'captions': result['captions'], 'reason': result['reason']}))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
