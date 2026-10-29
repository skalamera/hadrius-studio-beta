import json
import os
from pathlib import Path
import tempfile
import unittest
from renderer.incremental import demo, assemble
from renderer.preservation import file_hash, run


class IncrementalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name) / 'fixture'
        cls.report = demo(cls.root)
        cls.manifest = cls.root / 'baseline-manifest.json'
        cls.approval = json.loads((cls.root / 'local-approval.json').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_reuses_encoded_cells_and_original_noop(self):
        self.assertEqual(self.report['reused_cells'], ['hold-0', 'hold-2'])
        for i in (0, 2):
            self.assertEqual(file_hash(self.root / f'cell-{i}.mp4'), file_hash(self.root / 'repair' / f'cell-{i}.mp4'))
        report = json.loads((self.root / 'noop/verification.json').read_text())
        self.assertEqual(Path(report['artifact']).resolve(), (self.root / 'baseline.mp4').resolve())
        self.assertEqual(report['baseline_sha256'], report['candidate_sha256'])

    def test_missing_or_extra_replacement_fails_before_output(self):
        for replacements in ({}, {'hold-0': self.root / 'replacement.mp4'}):
            with self.assertRaisesRegex(ValueError, 'replacement_scope_mismatch'):
                assemble(self.manifest, self.approval, replacements, self.root / 'must-not-exist')
        self.assertFalse((self.root / 'must-not-exist').exists())

    def test_corrupt_cell_rejected(self):
        cell = self.root / 'cell-0.mp4'; original = cell.read_bytes()
        try:
            cell.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'corrupt_cell'):
                assemble(self.manifest, self.approval, {'hold-1': self.root / 'replacement.mp4'}, self.root / 'corrupt-output')
        finally:
            cell.write_bytes(original)
        self.assertFalse((self.root / 'corrupt-output').exists())

    def test_incompatible_timing_replacement_rejected(self):
        bad = self.root / 'bad-cell.mp4'
        run('ffmpeg', '-v', 'error', '-itsscale', '2', '-i', self.root / 'replacement.mp4', '-c', 'copy', bad)
        with self.assertRaisesRegex(ValueError, 'unsupported_cell_profile|invalid_cell_timing'):
            assemble(self.manifest, self.approval, {'hold-1': bad}, self.root / 'bad-output')

    def test_existing_output_not_overwritten(self):
        with self.assertRaises(FileExistsError):
            assemble(self.manifest, self.approval, {'hold-1': self.root / 'replacement.mp4'}, self.root / 'repair')


if __name__ == '__main__':
    unittest.main()
