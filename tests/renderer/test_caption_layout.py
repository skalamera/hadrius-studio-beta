import json
import os
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from renderer import caption_layout, fx_draw


TEXT = 'Stepping back into admin returns full oversight, so you can support your team with confidence.'


class CaptionLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='caption-layout-test-', dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.build = self.root / 'build'
        self.build.mkdir()
        self.assembly = self.root / 'assembly.json'
        self.assembly.write_text(json.dumps({'slides': [{'slide': 1, 'file': 'slide_01.png', '_cap_text': TEXT, 'caption': TEXT}]}))

    def saved_caption(self, layout):
        drawer = fx_draw.load(out_dir=self.root, tmp_dir=self.build, needs_drawn_highlight=True, font_layout=layout)
        drawer.ns['caption_png'](TEXT, self.build / 'cap01.png')

    def detect(self, **flags):
        return caption_layout.detect_caption_layout(self.assembly, self.build, self.root / 'probe', {'source': 'recording', **flags})

    def test_basic_is_selected_by_exact_pixels_not_machine_default(self):
        self.saved_caption('basic')
        before = fx_draw.sha256_file(self.build / 'cap01.png')
        result = self.detect()
        self.assertTrue(result['ok'])
        self.assertEqual(result['font_layout'], 'basic')
        self.assertEqual(before, fx_draw.sha256_file(self.build / 'cap01.png'))
        self.assertTrue(result['matches']['basic']['all_pixels_equal'])

    def test_raqm_baseline_is_not_forced_to_basic(self):
        self.saved_caption('raqm')
        result = self.detect()
        self.assertTrue(result['ok'])
        self.assertEqual(result['font_layout'], 'raqm')
        self.assertFalse(result['matches']['basic']['all_pixels_equal'])
        self.assertTrue(result['matches']['raqm']['all_pixels_equal'])

    def test_neither_layout_matching_is_a_block_not_a_guess_or_tolerance(self):
        Image.new('RGBA', (1920, 156), (255, 0, 0, 255)).save(self.build / 'cap01.png')
        result = self.detect()
        self.assertFalse(result['ok'])
        self.assertIsNone(result['font_layout'])
        self.assertEqual(result['equivalent_layouts'], [])

    def test_missing_expected_caption_fails_before_output_creation(self):
        with self.assertRaisesRegex(ValueError, 'baseline_caption_missing:1'):
            self.detect()
        self.assertFalse((self.root / 'probe').exists())

    def test_no_caption_render_does_not_invent_required_evidence(self):
        result = self.detect(no_captions=True)
        self.assertTrue(result['ok'])
        self.assertEqual(result['captions'], 0)
        self.assertEqual(result['reason'], 'no_caption_pixels_used')

    def test_missing_one_cached_png_is_disclosed_and_does_not_claim_its_pixels_were_checked(self):
        self.saved_caption('basic')
        (self.build / 'cap01.png').rename(self.build / 'cap02.png')
        self.assembly.write_text(json.dumps({'slides': [
            {'slide': 1, 'file': 'slide_01.png', '_cap_text': TEXT},
            {'slide': 2, 'file': 'slide_02.png', '_cap_text': TEXT}]}))
        result = self.detect()
        self.assertTrue(result['ok'])
        self.assertEqual(result['captions'], 1)
        self.assertEqual(result['missing_caption_slides'], [1])
        self.assertIn('full original-image control remains mandatory', result['limitation'])


if __name__ == '__main__':
    unittest.main()
