import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from renderer.incremental import demo, concat, mux
from renderer.preservation import verify_visual_update, frames, file_hash, run


class PreservationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name) / 'fixture'
        cls.report = demo(cls.root)
        cls.manifest = cls.root / 'baseline-manifest.json'
        cls.approval = json.loads((cls.root / 'local-approval.json').read_text())
        cls.before = cls.root / 'baseline.mp4'

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def verify(self, after, approval=None, manifest=None):
        return verify_visual_update(self.before, after, manifest or self.manifest, approval or self.approval)

    def test_imports_have_no_media_or_environment_side_effects(self):
        import subprocess
        import sys
        code = "import subprocess; subprocess.check_output=lambda *a,**k: (_ for _ in ()).throw(AssertionError('side effect')); import renderer.preservation; import renderer.incremental; import renderer.transitions"
        subprocess.run([sys.executable, '-c', code], check=True)

    def test_noop_remux_is_not_original_reuse(self):
        output = self.root / 'noop-remux.mp4'
        run('ffmpeg', '-v', 'error', '-i', self.before, '-map', '0', '-c', 'copy', '-metadata', 'comment=not-original', output)
        with self.assertRaisesRegex(ValueError, 'no_op_must_reuse_original_file'):
            self.verify(output, {**self.approval, 'changedStepIds': []})

    def test_middle_replacement_and_exact_complete_audio(self):
        self.assertEqual(self.report['protected_frame_count'], 24)
        self.assertTrue(self.report['audio_packets_and_timing_equal'])
        self.assertEqual(self.report['pcm']['bytes'], 144000 * 4)
        a = frames(self.before)[1]; b = frames(self.root / 'repair/candidate.mp4')[1]
        self.assertTrue(all(x != y for x, y in zip(a[12:24], b[12:24])))

    def test_altered_protected_frame_rejected(self):
        video = self.root / 'bad-protected-video.mp4'
        concat([self.root / 'replacement.mp4', self.root / 'replacement.mp4', self.root / 'cell-2.mp4'], video)
        output = self.root / 'bad-protected.mp4'
        mux(video, self.before, output)
        with self.assertRaisesRegex(ValueError, 'protected_frame_changed'):
            self.verify(output)

    def test_altered_audio_rejected(self):
        tone = self.root / 'bad-tone.m4a'
        run('ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3', '-c:a', 'aac', tone)
        output = self.root / 'bad-audio.mp4'
        mux(self.root / 'baseline-video.mp4', tone, output)
        with self.assertRaisesRegex(ValueError, 'audio_packet_or_priming_changed'):
            self.verify(output)

    def test_audio_offset_rejected(self):
        output = self.root / 'offset.mp4'
        run('ffmpeg', '-v', 'error', '-i', self.root / 'baseline-video.mp4', '-itsoffset', '0.1', '-i', self.before, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', output)
        with self.assertRaisesRegex(ValueError, 'timing_changed|priming_changed'):
            self.verify(output)

    def test_video_timing_rejected(self):
        output = self.root / 'slow.mp4'
        run('ffmpeg', '-v', 'error', '-itsscale', '2', '-i', self.before, '-map', '0', '-c', 'copy', output)
        with self.assertRaisesRegex(ValueError, 'timing_changed'):
            self.verify(output)

    def test_forged_scope_unknown_id_and_profile_rejected(self):
        for patch in ({'dirty_frames': [[0, 36]]}, {'changedStepIds': ['unknown']}, {'changedStepIds': ['synthetic-step-1'] * 2}, {'renderProfileHash': '0' * 64}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.verify(self.before, {**self.approval, **patch})

    def test_manifest_tamper_and_reapproved_gap_rejected(self):
        bad = self.root / 'bad-manifest.json'
        m = json.loads(self.manifest.read_text()); m['cells'][1]['startFrame'] += 1
        bad.write_text(json.dumps(m))
        with self.assertRaisesRegex(ValueError, 'manifest_conflict'):
            self.verify(self.before, manifest=bad)
        with self.assertRaisesRegex(ValueError, 'invalid_cell_partition'):
            self.verify(self.before, {**self.approval, 'baselineManifestHash': file_hash(bad)}, bad)


if __name__ == '__main__':
    unittest.main()
