"""renderer.fx_draw: AST extraction of assemble.py's Extra FX drawing code (never imported/executed as a
module) and read-only golden fidelity against a real pilot's _build segments when present."""
import ast
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from renderer import fx_draw

ROOT = Path(__file__).resolve().parents[2]
PILOT = ROOT / 'out' / 'How-to-Find-a-Project-ID'


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Extraction(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='fxdraw-', dir=os.environ.get('TMPDIR')))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_loads_real_source_without_side_effects(self):
        before = _sha(fx_draw.ASSEMBLE)
        d = fx_draw.load(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)
        self.assertEqual(_sha(fx_draw.ASSEMBLE), before)
        self.assertEqual((d.ns['W'], d.ns['H'], d.ns['FPS'], d.ns['XF']), (1920, 1080, 30, 0.8))
        self.assertIs(d.ns['FX'], True)
        self.assertEqual(d.ns['SEG_ENCODE'], ['-c:v', 'libx264', '-preset', 'fast', '-crf', '19'])
        for name in fx_draw.FUNCTIONS:
            self.assertTrue(callable(d.ns[name]), name)
            self.assertEqual(d.ns[name].__module__, fx_draw.NAMESPACE_MODULE)
        # nothing else from assemble.py leaks in (no tts, rep, args, narrator, cache paths)
        for forbidden in ('narration', 'narrator', 'rep', 'args', 'slides', 'SEG_CACHE', 'segment_key', 'fx_plan'):
            self.assertNotIn(forbidden, d.ns)
        self.assertEqual(set(d.sources), set(fx_draw.FUNCTIONS))
        self.assertTrue(all(len(h) == 64 for h in d.source_hashes.values()))

    def _write(self, text):
        p = self.tmp / 'assemble.py'
        p.write_text(text)
        return p

    def _real(self):
        return fx_draw.ASSEMBLE.read_text()

    def test_missing_function_fails_closed(self):
        src = self._real().replace('def fx_ripple(', 'def fx_ripple_renamed(')
        with self.assertRaisesRegex(ValueError, 'missing_function:fx_ripple'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_non_literal_constant_fails_closed(self):
        src = self._real().replace('FX_DIM = 0.32', 'FX_DIM = float("0.32")')
        with self.assertRaisesRegex(ValueError, 'non_literal_constant:FX_DIM'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_missing_constant_fails_closed(self):
        src = self._real().replace('FX_BLUR = 6.0', 'FX_BLURX = 6.0')
        with self.assertRaisesRegex(ValueError, 'missing_constant:FX_BLUR'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_duplicate_definition_fails_closed(self):
        src = self._real() + '\nFX_DIM = 0.5\n'
        with self.assertRaisesRegex(ValueError, 'ambiguous_constant:FX_DIM'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)
        src = self._real() + '\ndef cam_clamp(v, sw, sh):\n    return v\n'
        with self.assertRaisesRegex(ValueError, 'ambiguous_function:cam_clamp'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_unknown_global_fails_closed(self):
        # a drawing function that starts depending on module state outside the frozen namespace
        src = self._real().replace("    R, SS = 64, 3\n", "    R, SS = 64, 3\n    _ = rep.get('x')\n")
        with self.assertRaisesRegex(ValueError, 'unresolved_global:fx_ripple:rep'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_font_layout_is_explicit(self):
        with self.assertRaisesRegex(ValueError, 'unsupported_font_layout'):
            fx_draw.load(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True, font_layout='auto')
        a = fx_draw.load(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True, font_layout='basic')
        b = fx_draw.load(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True, font_layout='raqm')
        self.assertNotEqual(a.fingerprint(), b.fingerprint())

    def test_font_statement_must_match(self):
        src = self._real().replace('font = ImageFont.truetype(FONT, 40)', 'font = ImageFont.truetype(FONT, 41)')
        with self.assertRaisesRegex(ValueError, 'unexpected_statement:font'):
            fx_draw.load(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_from_recording_slide_port_reproduces_report(self):
        # JS Math.round semantics (half up), CSS bbox scaled into PNG pixels
        step = {'index': 1, 'media': {'pre': 'a.png'}, 'narration': 'n', 'caption': 'c', 'route': '/r', 'action': 'click',
                'target': {'hint': {'bbox': {'x': 10.5, 'y': 3, 'w': 20, 'h': 5}, 'viewport': {'w': 2000, 'h': 1125}}}}
        s = fx_draw.from_recording_slide(step, 2, (1600, 900), captions_from_narration=False)
        self.assertEqual(s['target'], {'x': 8, 'y': 2, 'width': 16, 'height': 4})
        self.assertEqual(s['viewport'], {'width': 1600, 'height': 900})
        self.assertEqual((s['slide'], s['file'], s['src'], s['caption']), (2, 'slide_02.png', 'a.png', 'c'))

    def test_fit_slide_pads_and_shifts_like_assemble(self):
        from PIL import Image
        d = fx_draw.load(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)
        (self.tmp / 'o' / 'slides').mkdir(parents=True)
        Image.new('RGB', (1400, 900), (200, 10, 10)).save(self.tmp / 'o' / 'slides' / 'slide_01.png')
        s = {'file': 'slide_01.png', 'target': {'x': 10, 'y': 10, 'width': 5, 'height': 5}, 'viewport': {'width': 1400, 'height': 900}}
        d.ns['fit_slide_to_frame'](s)
        self.assertEqual(s['viewport'], {'width': 1600, 'height': 900})
        self.assertEqual(s['target']['x'], 110)
        self.assertEqual(Image.open(self.tmp / 'o' / 'slides' / 'slide_01.png').size, (1600, 900))


def _capture(shade=245, box=None):
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (1600, 900), (shade, shade, 250))
    d = ImageDraw.Draw(im)
    for r in range(8):
        d.rectangle([100, 120 + r * 90, 1500, 180 + r * 90], fill=(220, 222, 230))
    if box:
        d.rectangle(box, fill=(196, 30, 58))
    return im


def _report_slides(tmp, targets, routes, sdurs, shades=None):
    (tmp / 'o' / 'slides').mkdir(parents=True, exist_ok=True)
    slides = []
    for i, (t, r, sd) in enumerate(zip(targets, routes, sdurs)):
        _capture((shades or [245] * len(targets))[i]).save(tmp / 'o' / 'slides' / f'slide_{i + 1:02d}.png')
        slides.append({'slide': i + 1, 'file': f'slide_{i + 1:02d}.png', 'narration': f'line {i}', 'caption': f'line {i}',
                       'target': t, 'viewport': {'width': 1600, 'height': 900}, 'route': r, 'action': 'click', 'sdur': sd})
    return slides


class Planner(unittest.TestCase):
    """fx_draw.load_planner: assemble's camera/FX planning (cam_views, fx_plan, cam_caption_top + the pinned
    module-level orchestration) extracted via ast with an explicit frozen report/args."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='fxplan-', dir=os.environ.get('TMPDIR')))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, text):
        p = self.tmp / 'assemble.py'
        p.write_text(text)
        return p

    def _load(self, **kw):
        return fx_draw.load_planner(out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True, **kw)

    def test_planner_namespace_is_frozen(self):
        p = self._load()
        for name in fx_draw.PLAN_FUNCTIONS:
            self.assertEqual(p.ns[name].__module__, fx_draw.NAMESPACE_MODULE)
        self.assertEqual(p.ns['args'], ())
        for forbidden in ('narration', 'narrator', 'SEG_CACHE', 'segment_key', 'build_segment'):
            self.assertNotIn(forbidden, p.ns)
        with self.assertRaisesRegex(ValueError, 'unprovided_report_field:title'):
            p.ns['rep'].get('title')
        with self.assertRaisesRegex(ValueError, 'unsupported_report_field'):
            self._load(report={'title': 'x'})

    def test_replan_is_deterministic_and_groups_screens(self):
        p = self._load()
        t = [None, {'x': 300, 'y': 260, 'width': 320, 'height': 110}, {'x': 900, 'y': 600, 'width': 200, 'height': 80}]
        slides = _report_slides(self.tmp, t, ['/a', '/a', '/b'], [2.0, 1.9, 2.0])
        a, screens = p.replan(slides)
        b, _ = self._load().replan(slides)
        self.assertEqual([fx_draw.plan_view(s) for s in a], [fx_draw.plan_view(s) for s in b])
        self.assertEqual([sc['slides'] for sc in screens], [[1, 2], [3]])
        self.assertEqual([s['_fx']['first'] for s in a], [True, False, True])
        self.assertNotIn('_fx', slides[0], 'input slides must not be mutated')
        moved = json.loads(json.dumps(slides))
        moved[1]['target'] = {'x': 300, 'y': 560, 'width': 320, 'height': 110}
        c, _ = self._load().replan(moved)
        self.assertNotEqual(fx_draw.plan_view(c[1])['_fx'], fx_draw.plan_view(a[1])['_fx'])
        self.assertNotEqual(fx_draw.plan_view(c[0])['_fx'], fx_draw.plan_view(a[0])['_fx'], 'same screen shares one camera path')
        self.assertEqual(fx_draw.render_view(c[2]), fx_draw.render_view(a[2]), 'other screen: nothing the FX drawing reads')
        # identical consecutive captures chain cam_views' start view across the screen boundary (unused by FX drawing)
        self.assertNotEqual(fx_draw.plan_view(c[2])['_cam'][0], fx_draw.plan_view(a[2])['_cam'][0])

    def test_unprovided_report_field_fails_closed_at_plan_time(self):
        src = fx_draw.ASSEMBLE.read_text().replace("    off, frames = 0.0, []\n", "    off, frames = 0.0, []\n    rep.get('zoom_hint')\n", 1)
        p = fx_draw.load_planner(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)
        slides = _report_slides(self.tmp, [None], ['/a'], [2.0])
        with self.assertRaisesRegex(ValueError, 'unprovided_report_field:zoom_hint'):
            p.replan(slides)

    def test_unknown_global_in_plan_function_fails_closed(self):
        src = fx_draw.ASSEMBLE.read_text().replace("    off, frames = 0.0, []\n", "    off, frames = 0.0, []\n    narrator.describe()\n", 1)
        with self.assertRaisesRegex(ValueError, 'unresolved_global:fx_plan:narrator'):
            fx_draw.load_planner(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)

    def test_orchestration_is_pinned(self):
        src = fx_draw.ASSEMBLE.read_text().replace("    cam_views(slides)  # after padding", "    cam_views(slides[::-1])  # after padding", 1)
        with self.assertRaisesRegex(ValueError, 'unexpected_orchestration'):
            fx_draw.load_planner(source=self._write(src), out_dir=self.tmp / 'o', tmp_dir=self.tmp / 'b', needs_drawn_highlight=True)


@unittest.skipUnless((PILOT / '_build' / 'seg02.mp4').is_file() and (PILOT / 'assembly.json').is_file(),
                     'real pilot _build artifacts absent')
class RealPilotReplanGolden(unittest.TestCase):
    """READ-ONLY: re-planning the pilot from its ORIGINAL captures + script must reproduce the persisted plan."""

    def test_replan_reproduces_persisted_plan_and_segments(self):
        out = Path(tempfile.mkdtemp(prefix='fxplan-golden-', dir=os.environ.get('TMPDIR')))
        try:
            r = fx_draw.replan_golden(ROOT, PILOT.name, out / 'g', render_segments=True)
            self.assertTrue(r['source_unchanged'])
            self.assertTrue(r['plan_equal'], r['plan_diff'])
            for k, seg in r['segments'].items():
                self.assertTrue(seg['decoded_frames_equal'] and seg['bitstream_sha256_equal'], (k, seg))
        finally:
            shutil.rmtree(out, ignore_errors=True)


@unittest.skipUnless((PILOT / '_build' / 'seg02.mp4').is_file() and (PILOT / 'assembly.json').is_file(),
                     'real pilot _build artifacts absent')
class RealPilotGolden(unittest.TestCase):
    """READ-ONLY: re-render the pilot's segments from slides/ + persisted assembly plan into TMPDIR."""

    def test_segments_and_content_dissolves_match_golden(self):
        out = Path(tempfile.mkdtemp(prefix='fxdraw-golden-', dir=os.environ.get('TMPDIR')))
        try:
            snap = fx_draw.snapshot([PILOT / 'assembly.json', PILOT / 'report.json', *sorted((PILOT / 'slides').iterdir()),
                                     *sorted((PILOT / '_build').iterdir()), PILOT / f'{PILOT.name}.mp4'])
            r = fx_draw.golden_fidelity(PILOT, out / 'g')
            self.assertEqual(snap, fx_draw.snapshot(list(map(Path, snap))))
            for k, seg in r['segments'].items():
                self.assertTrue(seg['frame_count_equal'], k)
                self.assertTrue(seg['decoded_frames_equal'], (k, seg))
            self.assertTrue(r['overlays']['captions_byte_equal'])
            self.assertTrue(r['content_video']['decoded_frames_equal'], r['content_video'])
            self.assertGreater(r['final_window']['psnr_min'], 35.0)
        finally:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
