"""renderer.take_provider: a NEW narration take through the production TTS CLI (`renderer/tts.py "<line>"`, run as a
subprocess exactly like the bridge's /preview/narration), pinned into the job dir. Synthetic: a FAKE tts.py in a fake
repo (no network, no credits). The pilot golden (cache-name port vs the real baseline take names) is read-only."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from renderer import take_provider as tp

REPO = Path(__file__).resolve().parents[2]
VOICE_ID = 'ZoiZ8fuDWInAcwPXaVeq'
OTHER_ID = 'CvD6hF1BJzAFN428j1cO'

FAKE_TTS = r'''
import json, os, shutil, sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
with open(root / 'calls.jsonl', 'a') as f:
    f.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'voice': os.environ.get('NARRATION_VOICE')}) + '\n')
mode = os.environ.get('FAKE_TTS_MODE', 'ok')
if mode == 'fail':
    sys.exit('every TTS provider failed: synthetic')
if mode == 'garbage':
    print('not json'); sys.exit(0)
d = root / 'out' / '_cache' / 'tts'
d.mkdir(parents=True, exist_ok=True)
p = d / os.environ['FAKE_TTS_NAME'] if mode != 'outside' else root / 'elsewhere.mp3'
if not p.exists():
    shutil.copyfile(os.environ['FAKE_TTS_AUDIO'], p)
print('  some provider log line')
print(json.dumps({'path': str(p), 'provider': os.environ.get('FAKE_TTS_PROVIDER', 'el'), 'cached': mode == 'cached'}))
'''


def tone(path, seconds=0.8):
    subprocess.check_call(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', f'sine=frequency=300:duration={seconds}:sample_rate=44100',
                           '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', str(path)])
    return Path(path)


class FakeTts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.audio = tone(cls.root / 'fake.mp3')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def _repo(self, tag):
        repo = self.root / f'repo-{tag}'
        (repo / 'renderer').mkdir(parents=True)
        (repo / 'renderer' / 'tts.py').write_text(FAKE_TTS)
        return repo

    def _call(self, tag, text='Open the project page.', voice=f'el:{VOICE_ID}', name_voice=VOICE_ID, **env):
        repo = self._repo(tag)
        name = tp.cache_name(text, name_voice, tp.default_model())
        e = {'FAKE_TTS_NAME': name, 'FAKE_TTS_AUDIO': str(self.audio), **env}
        job = self.root / f'job-{tag}'
        old = {k: os.environ.get(k) for k in e}
        os.environ.update(e)
        try:
            return repo, job, tp.provide_take(text, voice, job, tag='slide-02', repo=repo, python=sys.executable)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_contract_and_pinned_copy(self):
        repo, job, info = self._call('ok')
        call = json.loads((repo / 'calls.jsonl').read_text().splitlines()[0])
        self.assertEqual(call['argv'], ['Open the project page.'])
        self.assertEqual(Path(call['cwd']).resolve(), repo.resolve())
        self.assertEqual(call['voice'], f'el:{VOICE_ID}')
        self.assertEqual(info['provider'], 'el')
        self.assertEqual(info['voice'], f'el:{VOICE_ID}')
        self.assertFalse(info['cached'])
        self.assertEqual(info['characters'], len('Open the project page.'))
        p = Path(info['path'])
        self.assertTrue(p.is_file() and p.resolve().is_relative_to(job.resolve()))
        self.assertEqual(tp.sha256_file(p), info['sha256'])
        self.assertEqual(info['sha256'], tp.sha256_file(info['provider_path']))
        self.assertGreater(info['duration'], 0.5)

    def test_cached_costs_nothing(self):
        _, _, info = self._call('cached', FAKE_TTS_MODE='cached')
        self.assertTrue(info['cached'])
        self.assertEqual(info['characters'], 0)

    def _rejected(self, tag, **kw):
        with self.assertRaises(tp.TakeRejected) as cm:
            self._call(tag, **kw)
        self.assertEqual(cm.exception.code, 'voice_unavailable')
        self.assertFalse((self.root / f'job-{tag}' / 'takes').exists() and any((self.root / f'job-{tag}' / 'takes').iterdir()))
        return cm.exception.detail

    def test_fallback_provider_rejected(self):
        self.assertEqual(self._rejected('edge', FAKE_TTS_PROVIDER='edge')['reason'], 'provider_not_elevenlabs')

    def test_other_voice_rejected(self):
        self.assertEqual(self._rejected('voice', name_voice=OTHER_ID)['reason'], 'voice_id_mismatch')

    def test_non_elevenlabs_script_voice_rejected(self):
        self.assertEqual(self._rejected('vs', voice='vs:abcd1234')['reason'], 'script_voice_not_elevenlabs')
        self.assertEqual(self._rejected('none', voice='')['reason'], 'script_voice_not_elevenlabs')

    def test_failure_and_bad_output_rejected(self):
        self.assertEqual(self._rejected('fail', FAKE_TTS_MODE='fail')['reason'], 'tts_failed')
        self.assertEqual(self._rejected('garbage', FAKE_TTS_MODE='garbage')['reason'], 'tts_output_unparsable')
        self.assertEqual(self._rejected('outside', FAKE_TTS_MODE='outside')['reason'], 'take_outside_tts_cache')

    def test_never_imports_tts(self):
        tp.tts_port()
        self.assertNotIn('renderer.tts', sys.modules)
        self.assertNotIn('tts', sys.modules)

    def test_standin_needs_explicit_flag(self):
        with self.assertRaises(tp.TakeRejected) as cm:
            tp.standin_take('x', self.root / 'job-standin', tag='slide-01')
        self.assertEqual(cm.exception.code, 'standin_not_allowed')


class PortGolden(unittest.TestCase):
    def test_normalize_port_matches_tts_examples(self):
        n = tp.tts_port()['normalize']
        self.assertEqual(n('the group \u2014 the people'), 'the group, the people')
        self.assertEqual(n('Hadrius lives here'), 'Heydrius livs here')

    @unittest.skipUnless((REPO / 'out' / 'How-to-Find-a-Project-ID' / 'assembly.json').is_file(), 'pilot not present')
    def test_cache_names_reproduce_pilot_takes(self):
        """READ-ONLY: the pilot's baseline takes were voiced by el:<script voice> with the default model."""
        a = json.loads((REPO / 'out' / 'How-to-Find-a-Project-ID' / 'assembly.json').read_bytes())
        s = json.loads((REPO / 'scripts' / 'How-to-Find-a-Project-ID.script.json').read_bytes())
        check = tp.verify_baseline_takes(a, s['voice'])
        self.assertTrue(check['ok'], check)
        self.assertEqual(s['voice'], f'el:{VOICE_ID}')


if __name__ == '__main__':
    unittest.main()
