"""Narration voice consistency: a passing network blip must not change the narrator mid-video, and a render
that has to be in one voice (NARRATION_STRICT=1, the published-video path) fails instead of mixing voices."""
import io, os, sys, tempfile, unittest, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'renderer'))
import tts  # noqa: E402


def provider(tag, failures=()):
    """A fake provider that raises each of `failures` in turn, then writes audio."""
    pending = list(failures)
    def synth(text, path):
        synth.calls += 1
        if pending: raise pending.pop(0)
        Path(path).write_bytes(b'ID3 fake audio')
    synth.calls = 0
    return (tag, f'{tag}-voice', synth)


def http_error(code):
    return urllib.error.HTTPError('https://api.example/tts', code, 'error', {}, io.BytesIO(b'{"detail":"x"}'))


class SpeakTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        for name, value in (('CACHE', Path(tmp.name)), ('PICKED_PROVIDER', 'el')):
            self.addCleanup(setattr, tts, name, getattr(tts, name)); setattr(tts, name, value)
        self.addCleanup(setattr, tts.time, 'sleep', tts.time.sleep); tts.time.sleep = lambda s: None
        self.addCleanup(os.environ.pop, 'NARRATION_STRICT', None); os.environ.pop('NARRATION_STRICT', None)

    def narrator(self, chain):
        n = tts.Narrator.__new__(tts.Narrator)  # skip __init__'s network probes
        n.used_fallback, n.cache_hits, n.generated, n.dead, n.skipped = False, 0, 0, set(), {}
        n.providers = lambda: chain
        return n

    def test_a_timeout_is_retried_on_the_same_voice(self):
        el, edge = provider('el', [urllib.error.URLError(TimeoutError('Operation timed out'))]), provider('edge')
        n = self.narrator([el, edge])
        _, tag = n.speak('Saving locks in the new procedures.')
        self.assertEqual(tag, 'el')
        self.assertEqual((el[2].calls, edge[2].calls), (2, 0))
        self.assertFalse(n.used_fallback)

    def test_busy_and_server_errors_are_retried_too(self):
        el = provider('el', [http_error(429), http_error(503)])
        n = self.narrator([el, provider('edge')])
        self.assertEqual(n.speak('A line.')[1], 'el')
        self.assertEqual(el[2].calls, 3)

    def test_without_strict_a_lasting_failure_still_falls_back(self):
        el, edge = provider('el', [http_error(401)]), provider('edge')
        n = self.narrator([el, edge])
        self.assertEqual(n.speak('A line.')[1], 'edge')
        self.assertTrue(n.used_fallback)

    def test_strict_fails_instead_of_using_another_voice(self):
        os.environ['NARRATION_STRICT'] = '1'
        el, edge = provider('el', [http_error(401)]), provider('edge')
        with self.assertRaisesRegex(RuntimeError, 'el'):
            self.narrator([el, edge]).speak('A line.')
        self.assertEqual(edge[2].calls, 0)

    def test_strict_does_not_reuse_another_voice_from_the_cache(self):
        os.environ['NARRATION_STRICT'] = '1'
        edge = provider('edge')
        cached = tts.CACHE / f"edge-{tts._key('edge', tts.normalize_pronunciation('A line.'), 'edge-voice')}.mp3"
        cached.write_bytes(b'ID3 other voice')
        with self.assertRaises(RuntimeError):
            self.narrator([provider('el', [http_error(401)]), edge]).speak('A line.')

    def test_strict_fails_when_the_picked_voice_is_not_first(self):
        os.environ['NARRATION_STRICT'] = '1'
        edge = provider('edge')
        with self.assertRaisesRegex(RuntimeError, 'strict'):
            self.narrator([edge]).speak('A line.')
        self.assertEqual(edge[2].calls, 0)


if __name__ == '__main__':
    unittest.main()
