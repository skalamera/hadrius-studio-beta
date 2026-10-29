import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from renderer.transitions import demo
from renderer.incremental import assemble
from renderer.preservation import file_hash, load_scope, frames


class TransitionTests(unittest.TestCase):
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

    def test_dependency_closure_and_byte_copies(self):
        self.assertEqual(self.report['dirty_frames'], [(24, 36), (36, 48), (48, 60)])
        self.assertEqual(self.report['protected_frame_count'], 48)
        self.assertEqual(self.report['reused_cells'], ['intro', 'hold-0', 'hold-2', 'outro'])
        for name in self.report['reused_cells']:
            self.assertEqual(file_hash(self.root / f'{name}.mp4'), file_hash(self.root / 'repair' / f'{name}.mp4'))
        self.assertTrue(self.report['complete_audio_equal'])
        self.assertTrue(self.report['no_op_original_hash_reused'])

    def test_actual_dissolve_and_dirty_change(self):
        original = frames(self.root / 'dissolve-0.mp4')[1]
        self.assertGreater(len({r[-1] for r in original}), 8)
        a = frames(self.root / 'baseline.mp4')[1]
        b = frames(self.root / 'repair/candidate.mp4')[1]
        self.assertTrue(all(x != y for x, y in zip(a[24:60], b[24:60])))

    def test_wrong_dependency_missing_transition_profile_and_timing(self):
        source = json.loads(self.manifest.read_text())
        for kind in ('dependency', 'missing', 'profile', 'timing'):
            m = copy.deepcopy(source)
            if kind == 'dependency': m['cells'][2]['dependsOn'].reverse()
            if kind == 'missing': m['cells'].pop(2)
            if kind == 'profile': m['profileHash'] = 'bad'
            if kind == 'timing': m['cells'][2]['endFrame'] += 1
            path = self.root / f'bad-{kind}.json'
            path.write_text(json.dumps(m))
            approval = {**self.approval, 'baselineManifestHash': file_hash(path), 'renderProfileHash': m['profileHash']}
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                load_scope(path, approval)

    def test_missing_transition_replacement_and_arbitrary_scope(self):
        with self.assertRaisesRegex(ValueError, 'replacement_scope_mismatch'):
            assemble(self.manifest, self.approval, {'hold-1': self.root / 'replacement-hold-1.mp4'}, self.root / 'bad-output')
        with self.assertRaisesRegex(ValueError, 'invalid_approval_fields'):
            load_scope(self.manifest, {**self.approval, 'dirty_frames': [[0, 84]]})

    def test_candidate_script_preserves_narration_and_silent_caption(self):
        base = json.loads((self.root / 'base.script.json').read_text())
        candidate = json.loads((self.root / 'local-candidate/candidate.script.json').read_text())
        for a, b in zip(base['steps'], candidate['steps']):
            self.assertEqual(a['id'], b['id'])
            self.assertEqual(a['narration'], b['narration'])
            self.assertEqual(a['caption'], b['caption'])
        self.assertEqual(candidate['steps'][1]['caption'], '')
        self.assertNotEqual(base['steps'][1]['media'], candidate['steps'][1]['media'])

    def test_corrupt_transition_cell(self):
        path = self.root / 'dissolve-0.mp4'
        original = path.read_bytes()
        replacements = {name: self.root / f'replacement-{name}.mp4' for name in ('dissolve-0', 'hold-1', 'dissolve-1')}
        try:
            path.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'corrupt_cell'):
                assemble(self.manifest, self.approval, replacements, self.root / 'corrupt-output')
        finally:
            path.write_bytes(original)
