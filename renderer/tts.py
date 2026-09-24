"""Narration text -> speech audio, with a persistent content-addressed cache.

Shared by renderer/assemble.py (full renders) and the bridge's per-step preview, so a line
previewed in the panel is the exact file the next render reuses.

The cache lives in out/_cache/tts/, outside out/<name>/ — render.sh wipes that folder on every
render. Keys hash the provider, voice settings and text, so an edited line misses the cache and
an unchanged one never calls the TTS provider again.

CLI (used by the bridge):  python renderer/tts.py "<text>"  ->  prints {"path": ..., "provider": ...}
"""
from __future__ import annotations
import asyncio, hashlib, json, os, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'out' / '_cache' / 'tts'
MAX_AGE_DAYS = 60

EDGE_VOICE, EDGE_RATE, EDGE_PITCH = 'en-US-EmmaNeural', '+0%', '+3Hz'


def env_from_dotenv(name):
    # The bridge loads .env into its own environment before spawning render.sh, but a render
    # started from a terminal has none of it — so read .env directly for anything the env lacks.
    if os.environ.get(name): return os.environ[name].strip()
    try:
        for line in (ROOT / '.env').read_text().splitlines():
            line = line.strip()
            if line.startswith(f'{name}='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


VOICESTUDIO_URL = env_from_dotenv('VOICESTUDIO_URL') or 'http://127.0.0.1:3900'
VOICESTUDIO_VOICE = env_from_dotenv('VOICESTUDIO_VOICE_ID') or '4bfebca6'
ELEVEN_KEY = env_from_dotenv('ELEVENLABS_API_KEY')
ELEVEN_VOICE = env_from_dotenv('ELEVENLABS_VOICE_ID') or 'XrExE9yKIg1WjnnlVkGX'  # "Matilda"
ELEVEN_MODEL = env_from_dotenv('ELEVENLABS_MODEL_ID') or 'eleven_multilingual_v2'


def voicestudio_alive():
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{VOICESTUDIO_URL}/health"), timeout=0.8) as resp:
            return resp.status == 200
    except Exception:
        return False


def _voicestudio(text, path, voice):
    body = json.dumps({'input': text, 'voice': voice, 'response_format': 'mp3', 'speed': 1.0}).encode()
    req = urllib.request.Request(f'{VOICESTUDIO_URL}/v1/audio/speech', data=body, method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as resp:
        path.write_bytes(resp.read())


def _elevenlabs(text, path):
    body = json.dumps({
        'text': text,
        'model_id': ELEVEN_MODEL,
        'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75, 'style': 0.0, 'use_speaker_boost': True},
    }).encode()
    req = urllib.request.Request(
        f'https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}?output_format=mp3_44100_128',
        data=body, method='POST',
        headers={'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'})
    with urllib.request.urlopen(req, timeout=120) as resp:
        path.write_bytes(resp.read())


def _edge(text, path, voice, rate, pitch):
    import edge_tts
    coro = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(str(path))
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro)
        return
    # Called from inside a running loop (not the case today) — run it on a private one.
    loop = asyncio.new_event_loop()
    try: loop.run_until_complete(coro)
    finally: loop.close()


def _key(provider, text, extra=''):
    return hashlib.sha256(f'{provider}\x00{extra}\x00{text}'.encode()).hexdigest()[:32]


class Narrator:
    """One per render — probes VoiceStudio once, then synthesizes (or reuses) each line."""

    def __init__(self, vs_voice=None, edge_voice=EDGE_VOICE, edge_rate=EDGE_RATE, edge_pitch=EDGE_PITCH):
        CACHE.mkdir(parents=True, exist_ok=True)
        self.vs_active = voicestudio_alive()
        self.vs_voice = vs_voice or VOICESTUDIO_VOICE
        self.edge = (edge_voice, edge_rate, edge_pitch)
        self.used_fallback = False
        self.cache_hits = 0
        self.generated = 0
        # Providers that failed in a way that won't fix itself mid-render (quota, bad key) — skipped
        # for every later line instead of each one paying for its own failed round-trip.
        self.dead = set()

    def providers(self):
        """Provider chain in preference order, each as (tag, cache key extra, synth fn)."""
        chain = []
        if self.vs_active:
            chain.append(('vs', self.vs_voice, lambda t, p: _voicestudio(t, p, self.vs_voice)))
        if ELEVEN_KEY:
            chain.append(('el', f'{ELEVEN_VOICE}|{ELEVEN_MODEL}', _elevenlabs))
        chain.append(('edge', '|'.join(self.edge), lambda t, p: _edge(t, p, *self.edge)))
        live = [c for c in chain if c[0] not in self.dead]
        return live or chain[-1:]

    def speak(self, text):
        """Path to an mp3 of `text`, generating it only if this provider has never said it before."""
        chain = self.providers()
        # A cached line from the preferred provider always wins. A fallback provider's cached copy is
        # deliberately NOT reused here — otherwise one quota blip would lock a line into the fallback
        # voice forever even after the preferred provider is back.
        tag, extra, _ = chain[0]
        hit = CACHE / f'{tag}-{_key(tag, text, extra)}.mp3'
        if hit.exists() and hit.stat().st_size > 0:
            os.utime(hit)
            self.cache_hits += 1
            return hit, tag
        last_err = None
        for i, (tag, extra, synth) in enumerate(chain):
            dest = CACHE / f'{tag}-{_key(tag, text, extra)}.mp3'
            if i > 0 and dest.exists() and dest.stat().st_size > 0:
                self.used_fallback = True
                os.utime(dest)
                self.cache_hits += 1
                return dest, tag
            part = dest.with_suffix('.part')
            try:
                synth(text, part)
                if not part.exists() or part.stat().st_size == 0:
                    raise RuntimeError('provider returned no audio')
                part.replace(dest)  # atomic — an interrupted render never leaves a half-written hit
                self.generated += 1
                if i > 0: self.used_fallback = True
                return dest, tag
            except Exception as e:
                detail = getattr(e, 'read', lambda: b'')()
                detail = (': ' + detail[:160].decode(errors='replace')) if detail else ''
                permanent = getattr(e, 'code', None) in (401, 402, 403, 429)
                if permanent: self.dead.add(tag)
                print(f"  ⚠ {tag} TTS failed ({e}{detail}){' — skipping it for the rest of this render' if permanent else ''}, trying next provider", file=sys.stderr)
                last_err = e
                part.unlink(missing_ok=True)
        raise RuntimeError(f'every TTS provider failed: {last_err}')

    def describe(self):
        if self.vs_active: provider = f'VoiceStudio ({self.vs_voice})'
        elif ELEVEN_KEY: provider = f'ElevenLabs (voice {ELEVEN_VOICE}, {ELEVEN_MODEL})'
        else: provider = f'edge-tts ({self.edge[0]})'
        return (f"narration: {provider}{' — some lines fell back' if self.used_fallback or self.dead else ''}"
                f" · {self.cache_hits} cached, {self.generated} generated")


def prune(max_age_days=MAX_AGE_DAYS):
    """Drop cached lines nobody has used in a while — hits touch mtime, so this is LRU-ish."""
    if not CACHE.exists(): return
    cutoff = time.time() - max_age_days * 86400
    for f in CACHE.iterdir():
        try:
            if f.stat().st_mtime < cutoff: f.unlink()
        except OSError:
            pass


if __name__ == '__main__':
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        sys.exit('usage: tts.py "<text>"')
    n = Narrator()
    path, tag = n.speak(sys.argv[1].strip())
    print(json.dumps({'path': str(path), 'provider': tag, 'cached': n.cache_hits > 0}))
