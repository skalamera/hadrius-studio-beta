"""renderer.audio_rebuild: deterministic re-mix of an assemble.py soundtrack from per-slide takes + music bed
+ card clips, with assemble's exact filter graph and AAC chain. Synthetic fixtures always; the real pilot
golden is opt-in (HADRIUS_REAL_PILOT_NARRATION=1, read-only on the repo, ~10 s)."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from renderer import audio_rebuild as ar

REPO = Path(__file__).resolve().parents[2]
PILOT = 'How-to-Find-a-Project-ID'


def sh(*a):
    subprocess.check_call([str(x) for x in a])


def noise_take(path, seed, dur):
    """Aperiodic stand-in 'voice' (pink noise burst) in the cached-take profile: mp3 44.1 kHz mono 128k."""
    sh('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', f'anoisesrc=d={dur}:c=pink:seed={seed}:a=0.4:r=44100',
       '-af', 'lowpass=f=4000', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', path)
    return Path(path)


def music_bed(path, dur=40):
    sh('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', f'anoisesrc=d={dur}:c=brown:seed=7:a=0.2:r=48000',
       '-ac', '1', '-c:a', 'pcm_s16le', path)
    return Path(path)


def card(path, dur, silent=False, freq=440):
    src = 'anullsrc=r=48000:cl=stereo' if silent else f'sine=frequency={freq}:sample_rate=48000'
    sh('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', src, '-t', str(dur), '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
       '-ar', '48000', path)
    return Path(path)


def synthetic_audio_fixture(root):
    root = Path(root)
    takes = [noise_take(root / 't1.mp3', 1, 0.6), noise_take(root / 't2.mp3', 2, 0.5), noise_take(root / 't3.mp3', 3, 0.7)]
    adurs = [ar.ffprobe_duration(t) for t in takes]
    sdurs = [round(max(1.9, a + 1.1 + 0.8), 3) for a in adurs]
    cards = {'lead': card(root / 'lead.mp4', 1.6, freq=330), 'support': card(root / 'support.mp4', 2.0, freq=550),
             'outro': card(root / 'outro.mp4', 1.0, silent=True)}
    return takes, sdurs, music_bed(root / 'music.wav'), cards


class SourcePins(unittest.TestCase):
    def test_assemble_audio_graph_is_pinned(self):
        pins = ar.assemble_audio_pins()
        self.assertEqual(pins['VOICE_LUFS'], -16)
        self.assertEqual(pins['XF'], 0.8)
        self.assertTrue(all(pins['fragments'].values()))

    def test_changed_source_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            p = Path(d) / 'assemble.py'
            p.write_text(Path(ar.ASSEMBLE).read_text().replace('ratio=2:attack=40', 'ratio=3:attack=40'))
            with self.assertRaises(ValueError) as cm:
                ar.assemble_audio_pins(p)
            self.assertTrue(str(cm.exception).startswith('assemble_audio_source_changed'))


class Schedule(unittest.TestCase):
    def test_pilot_schedule_matches_assemble_loop(self):
        s = ar.voice_schedule([5.801, 4.872, 5.801], [True, True, True])
        self.assertEqual([x['start'] for x in s['slides']], [0.0, 5.001, 9.073])
        self.assertEqual([x['delay_ms'] for x in s['slides']], [150, 5801, 9873])
        self.assertAlmostEqual(s['total'], 14.874, places=9)

    def test_silent_slide_has_no_delay(self):
        s = ar.voice_schedule([1.9, 3.0], [False, True])
        self.assertIsNone(s['slides'][0]['delay_ms'])
        self.assertEqual(s['slides'][1]['delay_ms'], 1900)

    def test_filter_graph_text(self):
        f = ar.content_filter([(0, 150, ''), (1, 5801, '')], 14.874, music_index=2)
        self.assertIn('[0:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,adelay=150|150,aresample=async=1:first_pts=0[a0]', f)
        self.assertIn('[2:a]aresample=48000,atrim=0:14.874,afade=t=in:d=2,afade=t=out:st=11.874:d=3,volume=-5dB[mus]', f)
        self.assertTrue(f.endswith('amix=inputs=2:duration=longest:normalize=0,atrim=0:14.874,alimiter=limit=0.95[aout]'))


class SyntheticRebuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.takes, cls.sdurs, cls.music, cls.cards = synthetic_audio_fixture(cls.root)
        cls.a = ar.rebuild_soundtrack(cls.takes, cls.sdurs, cls.music, cls.cards, cls.root / 'a')
        cls.b = ar.rebuild_soundtrack(cls.takes, cls.sdurs, cls.music, cls.cards, cls.root / 'b')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_deterministic(self):
        ea, eb = ar.audio_evidence(self.a['final']), ar.audio_evidence(self.b['final'])
        self.assertEqual(ea['packets_sha256'], eb['packets_sha256'])
        self.assertEqual(ea['pcm_sha256'], eb['pcm_sha256'])
        self.assertEqual(ea['channels'], 2)

    def test_compare_pcm_identical(self):
        c = ar.compare_pcm(self.a['final'], self.b['final'])
        self.assertEqual(c['max_abs_diff'], 0.0)
        self.assertTrue(c['identical'])
        self.assertEqual(c['samples_a'], c['samples_b'])

    def test_takes_located_at_schedule(self):
        loc = ar.locate_takes(self.a['final'], self.takes, [''] * 3, self.a['schedule'], self.a['content_origin'], self.root / 'loc')
        lags = [x['lag_samples'] for x in loc]
        self.assertTrue(all(x['peak'] > 0.5 for x in loc), loc)
        self.assertLessEqual(max(lags) - min(lags), 2, loc)  # one constant decode offset for every take

    def test_shifted_take_detected(self):
        sd = list(self.sdurs)
        sd[1] = round(sd[1] + 0.4, 3)
        c = ar.rebuild_soundtrack(self.takes, sd, self.music, self.cards, self.root / 'c')
        loc_a = ar.locate_takes(self.a['final'], self.takes, [''] * 3, self.a['schedule'], self.a['content_origin'], self.root / 'la')
        loc_c = ar.locate_takes(c['final'], self.takes, [''] * 3, c['schedule'], c['content_origin'], self.root / 'lc')
        self.assertEqual(c['schedule']['slides'][2]['delay_ms'] - self.a['schedule']['slides'][2]['delay_ms'], 400)
        for x, y in zip(loc_a, loc_c):
            self.assertLessEqual(abs(x['lag_samples'] - y['lag_samples']), 2)
        # leading audio before the moved line is untouched in the mix
        p = ar.common_prefix(self.a['final'], c['final'])
        self.assertGreater(p['identical_leading_packets'], 0)


@unittest.skipUnless(os.environ.get('HADRIUS_REAL_PILOT_NARRATION') == '1', 'opt-in real pilot (read-only)')
class RealPilotGolden(unittest.TestCase):
    def test_golden_bit_exact(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            g = ar.golden_from_pilot(REPO / 'out' / PILOT, REPO / 'assets' / 'music_upbeat.wav', Path(d) / 'golden')
            self.assertTrue(g['source_unchanged'])
            self.assertTrue(g['final']['packets_equal'], json.dumps(g, default=str)[:2000])
            self.assertTrue(g['final']['pcm']['identical'])
            for k in ('content', 'body', 'support'):
                self.assertTrue(g['intermediates'][k]['packets_equal'], k)


if __name__ == '__main__':
    unittest.main()
