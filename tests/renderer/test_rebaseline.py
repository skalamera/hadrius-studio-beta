import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from renderer import rebaseline
from renderer.fx_scope import closure, sha256_file
from renderer.preservation import load_scope, verify_visual_update, file_hash
from tests.renderer.test_fx_scope import synthetic_assembly

REPO = Path(__file__).resolve().parents[2]
PILOT_NAME = 'How-to-Find-a-Project-ID'
PILOT = REPO / 'out' / PILOT_NAME


def make_fake_repo(root, name='Synthetic-FX'):
    """Scratch-only repo layout: out/<name>/{assembly.json,<name>.mp4}. 3 slides on 2 screens + 4 cards."""
    a = synthetic_assembly([2.0, 1.9, 2.0], screens=[2, 1])
    n = 210
    a['duration'] = round(n / 30, 2)
    d = root / 'out' / name
    d.mkdir(parents=True)
    (d / 'assembly.json').write_text(json.dumps(a, indent=1))
    # FX-like source: moving 1080p30 picture, x264 WITH B-frames (like assemble's final), AAC stereo with priming,
    # audio shorter than video (like the real pilot).
    subprocess.check_call(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
                           '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6.5', '-frames:v', str(n),
                           '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
                           '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', str(d / f'{name}.mp4')])
    return a, n


class SyntheticRebaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.repo = cls.root / 'fake-repo'
        cls.assembly, cls.n = make_fake_repo(cls.repo)
        cls.src = cls.repo / 'out' / 'Synthetic-FX' / 'Synthetic-FX.mp4'
        cls.src_hash = sha256_file(cls.src)
        cls.out = cls.root / 'rebaseline'
        cls.code = rebaseline.main(['--repo', str(cls.repo), '--name', 'Synthetic-FX', '--output', str(cls.out)])
        cls.v = json.loads((cls.out / 'verification.json').read_text())
        cls.manifest = cls.out / 'baseline-manifest.json'
        cls.m = json.loads(cls.manifest.read_text())

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def approval(self, step_ids):
        return {'baselineManifestHash': file_hash(self.manifest), 'renderProfileHash': self.m['profileHash'], 'changedStepIds': step_ids}

    def test_cli_succeeds_and_source_untouched(self):
        self.assertEqual(self.code, 0)
        self.assertTrue(self.v['ok'], json.dumps(self.v, indent=1)[:3000])
        self.assertEqual(sha256_file(self.src), self.src_hash)
        self.assertTrue(self.v['source_unchanged'])
        for f in ('baseline-rebuilt.mp4', 'baseline-manifest.json', 'baseline-assembly.json', 'contact-sheet.jpg'):
            self.assertTrue((self.out / f).is_file(), f)

    def test_frames_timestamps_and_audio_equal_original(self):
        v = self.v['checks']
        self.assertEqual(v['frame_count'], {'original': self.n, 'rebuilt': self.n, 'equal': True})
        self.assertTrue(v['presentation_timestamps_equal'])
        self.assertTrue(v['audio']['packets_timing_priming_equal'])
        self.assertTrue(v['audio']['decoded_pcm_equal'])
        self.assertEqual(v['audio']['original_sha256_stream_copy'], True)

    def test_cells_partition_keyframes_and_independent_decode(self):
        cells = self.m['cells']
        self.assertEqual([c['id'] for c in cells], ['lead-card', 'lead-dissolve', 'hold-01', 'dissolve-01-02', 'hold-02',
                                                    'dissolve-02-03', 'hold-03', 'tail-dissolve', 'tail-card'])
        self.assertEqual(cells[0]['startFrame'], 0)
        self.assertEqual(cells[-1]['endFrame'], self.n)
        self.assertTrue(all(a['endFrame'] == b['startFrame'] for a, b in zip(cells, cells[1:])))
        c = self.v['checks']['cells']
        self.assertTrue(c['each_cell_starts_with_keyframe'])
        self.assertTrue(c['each_cell_decodes_alone'])
        self.assertTrue(c['no_b_frames'])
        self.assertEqual(c['rebuilt_keyframes'], [x['startFrame'] for x in cells])
        for x in cells:
            self.assertEqual(sha256_file(self.out / x['file']), x['sha256'])

    def test_fidelity_reported(self):
        f = self.v['checks']['fidelity']
        self.assertEqual(f['frames_compared'], self.n)
        self.assertGreater(f['psnr_min'], 35)
        self.assertGreater(f['ssim_min'], 0.95)
        self.assertFalse(f['bit_identical'])  # disclosed re-encode

    def test_noop_returns_original_new_baseline(self):
        r = self.v['checks']['noop']
        self.assertTrue(r['ok'])
        self.assertEqual(r['candidate_sha256'], self.m['final']['sha256'])
        r = verify_visual_update(self.out / 'baseline-rebuilt.mp4', self.out / 'baseline-rebuilt.mp4', self.manifest, self.approval([]))
        self.assertEqual(r['candidate_sha256'], self.m['final']['sha256'])

    def test_single_slide_replacement_and_out_of_scope_rejection(self):
        r = self.v['checks']['single_slide_replacement']
        self.assertTrue(r['ok'])
        self.assertEqual(r['approval_step_ids'], ['slide-02'])
        self.assertEqual(r['dirty_frames'], r['fx_scope_dirty_frames'])
        self.assertTrue(r['protected_frames_equal'] and r['complete_audio_equal'])
        self.assertGreater(r['dirty_frames_changed'], 0)
        o = self.v['checks']['out_of_scope']
        self.assertEqual(o['assemble_rejected'], 'replacement_scope_mismatch')
        self.assertEqual(o['verifier_rejected'], 'protected_frame_changed')

    def test_preservation_scope_matches_fx_scope(self):
        for sid in ('slide-01', 'slide-02', 'slide-03'):
            _, dirty = load_scope(self.manifest, self.approval([sid]))
            want = closure(self.assembly, {sid: {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
            merged = []
            for a, b in dirty:
                if merged and merged[-1][1] == a:
                    merged[-1][1] = b
                else:
                    merged.append([a, b])
            self.assertEqual(merged, want['dirty_frames'], sid)

    def test_tampered_manifest_or_assembly_rejected(self):
        base = json.loads(self.manifest.read_text())
        for kind in ('frames', 'deps', 'profile', 'assembly'):
            m = copy.deepcopy(base)
            if kind == 'frames':
                m['cells'][2]['endFrame'] += 1; m['cells'][3]['startFrame'] += 1
            if kind == 'deps':
                m['cells'][3]['dependsOn'] = ['slide-02']
            if kind == 'profile':
                m['profileHash'] = 'bad'
            if kind == 'assembly':
                m['assembly']['sha256'] = '0' * 64
            path = self.out / f'tampered-{kind}.json'
            path.write_text(json.dumps(m))
            approval = {'baselineManifestHash': file_hash(path), 'renderProfileHash': m['profileHash'], 'changedStepIds': []}
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                load_scope(path, approval)

    def test_output_rules(self):
        with self.assertRaises((ValueError, FileExistsError)):
            rebaseline.run(self.repo, 'Synthetic-FX', self.out)  # exists
        with self.assertRaisesRegex(ValueError, 'output_must_be_under_TMPDIR'):
            rebaseline.run(self.repo, 'Synthetic-FX', REPO / 'out' / 'should-never-exist')
        self.assertFalse((REPO / 'out' / 'should-never-exist').exists())
        with self.assertRaisesRegex(ValueError, 'output_inside_repo'):
            rebaseline.run(self.repo, 'Synthetic-FX', self.repo / 'x')
        with self.assertRaisesRegex(ValueError, 'unsafe_name'):
            rebaseline.run(self.repo, '../etc', self.root / 'y')

    def test_inconsistent_assembly_refused(self):
        repo = self.root / 'bad-repo'
        shutil.copytree(self.repo, repo)
        p = repo / 'out' / 'Synthetic-FX' / 'assembly.json'
        a = json.loads(p.read_text()); a['duration'] = 9.0; p.write_text(json.dumps(a))
        with self.assertRaisesRegex(ValueError, 'duration_mismatch'):
            rebaseline.run(repo, 'Synthetic-FX', self.root / 'bad-out')
        self.assertFalse((self.root / 'bad-out').exists())


@unittest.skipUnless((PILOT / 'assembly.json').is_file() and (PILOT / f'{PILOT_NAME}.mp4').is_file()
                     and os.environ.get('HADRIUS_REAL_PILOT_REBASELINE') == '1',
                     'real pilot absent or HADRIUS_REAL_PILOT_REBASELINE!=1')
class RealPilotRebaselineTests(unittest.TestCase):
    """Reads the real pilot READ-ONLY; writes only into a TMPDIR temporary directory."""

    def test_real_pilot(self):
        files = [PILOT / 'assembly.json', PILOT / f'{PILOT_NAME}.mp4']
        before = [(p.stat().st_size, p.stat().st_mtime_ns, sha256_file(p)) for p in files]
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as t:
            out = Path(t) / 'pilot'
            self.assertEqual(rebaseline.main(['--repo', str(REPO), '--name', PILOT_NAME, '--output', str(out)]), 0)
            v = json.loads((out / 'verification.json').read_text())
            self.assertTrue(v['ok'])
            self.assertEqual(v['checks']['frame_count']['rebuilt'], 810)
        self.assertEqual([(p.stat().st_size, p.stat().st_mtime_ns, sha256_file(p)) for p in files], before)


if __name__ == '__main__':
    unittest.main()
