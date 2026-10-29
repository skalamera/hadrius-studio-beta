"""renderer.narration_update: approved narration change on one interior slide -> new take, re-timed cells,
re-mixed soundtrack, verified candidate. Synthetic fixture always (noise-burst 'takes', testsrc2 baseline);
the real pilot is opt-in (HADRIUS_REAL_PILOT_NARRATION=1, read-only on the repo, a few minutes per case)."""
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from renderer import audio_rebuild as ar, fx_scope, narration_update as nu, rebaseline
from tests.renderer.test_audio_rebuild import card, music_bed, noise_take
from tests.renderer.test_drift_render import ROUTES, TARGETS, capture
from tests.renderer.test_fx_scope import synthetic_assembly

REPO = Path(__file__).resolve().parents[2]
NAME = 'Synthetic-Narration'
WIDE = [800.0, 450.0, 1.0]


def chain_frames(lead, content, support, outro):
    """assemble's card crossfades in frames (xfade offset = d1 - xf; second clip starts at ceil(offset*30))."""
    b = math.ceil((lead / 30 - 0.65) * 30 - 1e-6) + content
    s = math.ceil((b / 30 - 0.65) * 30 - 1e-6) + support
    return math.ceil((s / 30 - 0.8) * 30 - 1e-6) + outro


def build_fixture(root):
    root = Path(root)
    media = root / 'media'
    media.mkdir()
    takes = [noise_take(media / f't{i}.mp3', i + 1, d) for i, d in enumerate((0.5, 0.4, 0.6))]
    adurs = [ar.ffprobe_duration(t) for t in takes]
    sdurs = [round(max(1.9, a + 1.1 + 0.8), 3) for a in adurs]
    a = synthetic_assembly(sdurs, screens=[2, 1])
    frames = [math.ceil(round(s['start'], 3) * 30 - 1e-6) for s in a['slides']]
    t0 = frames[1] / 30
    dur = round(min(1.5, max(0.8, sdurs[1] * 0.4)), 4)
    keys = [[0.0, WIDE], [t0, WIDE], [t0 + dur, [700.0, 400.0, 1.25]]]
    for i, s in enumerate(a['slides']):
        s.update({'narration': f'line {i}', 'caption': f'line {i}', '_cap_text': f'line {i}', 'route': ROUTES[i],
                  'action': 'click' if i == 1 else 'navigate', 'target': TARGETS[i], '_cap_edges': [i > 0, i < 2],
                  'audio': str(takes[i]), 'audio_filter': '', 'adur': adurs[i]})
        if i < 2:
            s['_fx']['keys'] = keys
    a['slides'][1]['_fx'].update(move=[0.0, dur], push=True)
    a['slides'][2]['_fx']['keys'] = [[0.0, WIDE]]
    content = frames[-1] + int(round(sdurs[-1] * 30))
    n = chain_frames(50, content, 60, 30)
    a['duration'] = round(n / 30, 2)
    d = root / 'repo' / 'out' / NAME
    (d / '_build').mkdir(parents=True)
    cards = {'lead': card(d / '_build' / 'intro_title_crossfaded.mp4', 1.6, freq=330),
             'support': card(d / '_build' / 'support_card.mp4', 2.0, freq=550),
             'outro': card(d / '_build' / 'logo_card.mp4', 1.0, silent=True)}
    music = music_bed(media / 'music.wav')
    snd = ar.rebuild_soundtrack(takes, sdurs, music, cards, root / 'baseline-audio')
    (d / 'assembly.json').write_text(json.dumps(a, indent=1))
    subprocess.check_call(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-i', str(snd['final']),
                           '-frames:v', str(n), '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
                           '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', str(d / f'{NAME}.mp4')])
    rb = rebaseline.run_rebaseline(root / 'repo', NAME, root / 'rebaseline')
    assert rb['ok'], json.dumps(rb['checks'], default=str)[:3000]
    rec = root / 'src' / '_recordings' / 'rec-synth'
    rec.mkdir(parents=True)
    steps = []
    for i, s in enumerate(a['slides']):
        capture(i).save(rec / s['src'])
        t = TARGETS[i]
        st = {'id': f'step-{i}', 'index': i, 'media': {'pre': s['src']}, 'route': ROUTES[i], 'action': s['action'], 'capture': True,
              'narration': f'line {i}', 'caption': f'line {i}'}
        if t:
            st['target'] = {'css': 'a', 'hint': {'bbox': {'x': t['x'], 'y': t['y'], 'w': t['width'], 'h': t['height']},
                                                 'viewport': {'w': 1600, 'h': 900}}}
        steps.append(st)
    script = {'id': 'synthetic-script', 'name': NAME, 'fx': True, 'recording': {'id': 'rec-synth'}, 'steps': steps, 'captionsFromNarration': False}
    (root / 'src' / 'base.script.json').write_text(json.dumps(script, indent=2))
    return {'assembly': a, 'n': n, 'music': music, 'build': d / '_build', 'rec': rec, 'script': root / 'src' / 'base.script.json',
            'rebaseline': root / 'rebaseline', 'media': media}


def write_manifest(root, fx, step='step-1', old='line 1', new='a much longer synthetic narration line', take=None, sha=None, mhash=None):
    take = take or noise_take(Path(root) / f'new-{uuid.uuid4().hex}.mp3', 9, 1.4)
    m = {'baselineManifestHash': mhash or ar.sha256_file(fx['rebaseline'] / 'baseline-manifest.json'),
         'changes': [{'stepId': step, 'oldText': old, 'newText': new, 'newTakePath': str(take),
                      'newTakeSha256': sha or ar.sha256_file(take), 'takeSource': 'synthetic noise stand-in'}]}
    p = Path(root) / f'manifest-{uuid.uuid4().hex}.json'
    p.write_text(json.dumps(m, indent=2))
    return p


class SyntheticNarrationUpdate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.fx = build_fixture(cls.root)
        cls.manifest = write_manifest(cls.root, cls.fx)
        cls.report = nu.run(cls.fx['rebaseline'], cls.fx['script'], cls.fx['rec'], cls.manifest, cls.fx['build'], cls.fx['music'],
                            cls.root / 'update')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_ok_and_scope(self):
        r = self.report
        self.assertTrue(r['ok'], json.dumps(r.get('checks'), default=str)[:3000])
        self.assertEqual(r['step_mapping'], {'step-1': 'slide-02'})
        self.assertEqual(sorted(r['checks']['rendered_cells']), ['dissolve-01-02', 'dissolve-02-03', 'hold-02'])
        self.assertEqual(sorted(r['checks']['reused_cells']), ['hold-01', 'hold-03', 'lead-card', 'lead-dissolve', 'tail-card', 'tail-dissolve'])
        self.assertGreater(r['timing']['shift_frames'], 0)
        self.assertEqual(r['checks']['frames_total'], self.fx['n'] + r['timing']['shift_frames'])

    def test_protected_frames_at_shifted_positions(self):
        c = self.report['checks']
        self.assertTrue(c['reused_cells_byte_identical'])
        self.assertTrue(c['reused_frames_equal_at_shifted_positions'])
        self.assertTrue(c['timestamps_contiguous'])
        self.assertTrue(c['decodable'])

    def test_audio(self):
        au = self.report['audio']
        self.assertTrue(au['golden']['final']['packets_equal'])
        self.assertTrue(au['candidate_audio_stream_copied'])
        self.assertTrue(au['unchanged_takes_reused_byte_for_byte'])
        self.assertTrue(au['takes_at_expected_offsets'], json.dumps(au['takes'], default=str))
        self.assertTrue(au['av_sync_preserved'], json.dumps(au['takes'], default=str))

    def test_captions(self):
        a = json.loads(Path(self.report['candidate_assembly']).read_text())
        self.assertEqual([s['_cap_text'] for s in a['slides']], ['line 0', 'a much longer synthetic narration line', 'line 2'])
        self.assertTrue(self.report['checks']['captions']['changed_caption_png_matches_new_text'])
        self.assertTrue(self.report['checks']['captions']['changed_slide_caption_band_differs'])

    def test_source_unchanged(self):
        self.assertTrue(self.report['source_unchanged'])

    def _rejected(self, tag, **kw):
        m = write_manifest(self.root, self.fx, **kw)
        out = self.root / f'rej-{tag}'
        with self.assertRaises(nu.NarrationRejected) as cm:
            nu.run(self.fx['rebaseline'], self.fx['script'], self.fx['rec'], m, self.fx['build'], self.fx['music'], out)
        self.assertEqual(list(out.rglob('*.mp4')) if out.exists() else [], [])
        return cm.exception.code

    def test_old_text_mismatch_rejected(self):
        self.assertEqual(self._rejected('old', old='not what was said'), 'old_text_mismatch')

    def test_unknown_step_rejected(self):
        self.assertEqual(self._rejected('unknown', step='step-9'), 'unknown_step')

    def test_noop_rejected(self):
        self.assertEqual(self._rejected('noop', new='line 1'), 'no_narration_change')

    def test_take_hash_rejected(self):
        self.assertEqual(self._rejected('sha', sha='0' * 64), 'take_hash_mismatch')

    def test_manifest_binding_rejected(self):
        self.assertEqual(self._rejected('bind', mhash='f' * 64), 'baseline_manifest_conflict')

    def test_edge_slide_rejected(self):
        self.assertEqual(self._rejected('edge', step='step-0', old='line 0'), 'unsupported_edge_slide')


@unittest.skipUnless(shutil.which('say'), 'macOS say not available')
class StandInTake(unittest.TestCase):
    def test_standin_profile(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            info = nu.make_standin_take('A local stand-in line.', Path(d) / 'take.mp3')
            self.assertEqual(info['label'], nu.STANDIN_LABEL)
            p = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(Path(d) / 'take.mp3')]))['streams'][0]
            self.assertEqual((p['codec_name'], p['sample_rate'], p['channels']), ('mp3', '44100', 1))
            self.assertGreater(info['duration'], 0.5)


REAL_REBASELINE = os.environ.get('HADRIUS_PILOT_REBASELINE_DIR',
                                 '/Users/stephenskalamera/.hermes/cache/scratch/fx-rebaseline-20261028-112610/pilot-rebaseline')


@unittest.skipUnless(os.environ.get('HADRIUS_REAL_PILOT_NARRATION') == '1', 'opt-in real pilot (read-only)')
class RealPilotNarration(unittest.TestCase):
    def _case(self, case):
        out = Path(os.environ['TMPDIR']) / f'narr-real-test-{case}-{os.getpid()}'
        r = nu.real_pilot_end_to_end(REAL_REBASELINE, out, case=case)
        self.assertTrue(r['ok'], json.dumps(r, default=str)[:4000])
        self.assertTrue(r['source_unchanged'])
        return r

    def test_longer(self):
        r = self._case('longer')
        self.assertGreater(r['timing']['shift_frames'], 0)

    def test_shorter(self):
        r = self._case('shorter')
        self.assertLess(r['timing']['shift_frames'], 0)


if __name__ == '__main__':
    unittest.main()
