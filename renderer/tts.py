"""Narration text -> speech audio, with a persistent content-addressed cache.

Shared by renderer/assemble.py (full renders) and the bridge's per-step preview, so a line
previewed in the panel is the exact file the next render reuses.

The cache lives in out/_cache/tts/, outside out/<name>/ — render.sh wipes that folder on every
render. Keys hash the provider, voice settings and text, so an edited line misses the cache and
an unchanged one never calls the TTS provider again.

CLI (used by the bridge):  python renderer/tts.py "<text>"  ->  prints {"path": ..., "provider": ...}
"""
from __future__ import annotations
import asyncio, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request
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
MAC_VOICE = env_from_dotenv('MAC_TTS_VOICE') or 'Samantha'

# NARRATION_VOICE=<provider>:<voice> is the render bar's voice pick (the bridge sets it per render):
# el:<ElevenLabs voice id>, vs:<VoiceStudio profile>, mac:<macOS say voice>, edge:<edge-tts voice>.
# It puts that provider first with that voice; the usual providers stay behind it as fallbacks.
PICKED_PROVIDER = ''
_pick = env_from_dotenv('NARRATION_VOICE')
if ':' in _pick:
    PICKED_PROVIDER, _pv = [x.strip() for x in _pick.split(':', 1)]
    if _pv:
        if PICKED_PROVIDER == 'el': ELEVEN_VOICE = _pv
        elif PICKED_PROVIDER == 'vs': VOICESTUDIO_VOICE = _pv
        elif PICKED_PROVIDER == 'mac': MAC_VOICE = _pv
ELEVEN_MODEL = env_from_dotenv('ELEVENLABS_MODEL_ID') or 'eleven_multilingual_v2'

# Treble lift (dB, high shelf at 3.5 kHz) applied when a line is mixed, per ElevenLabs voice, so a
# dull-sounding voice matches the brightness of the others. Measured against CvD6hF1BJzAFN428j1cO:
# IDHS58OMlK9jZvRdhEVy has ~6 dB less energy above 4 kHz; +7 dB closes the gap. Applied at mix time
# (not baked into the cache) so tuning it never re-spends credits. ELEVENLABS_TREBLE_DB overrides.
ELEVEN_TREBLE_DB = {'IDHS58OMlK9jZvRdhEVy': 7}


def voice_filter(tag):
    """Extra ffmpeg audio filter for a line voiced by provider `tag`, or '' for none."""
    if tag != 'el': return ''
    override = env_from_dotenv('ELEVENLABS_TREBLE_DB')
    try: g = float(override) if override else ELEVEN_TREBLE_DB.get(ELEVEN_VOICE, 0)
    except ValueError: g = 0
    return f'treble=g={g:g}:f=3500:t=s:w=0.7' if g else ''


def voicestudio_alive():
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{VOICESTUDIO_URL}/health"), timeout=0.8) as resp:
            return resp.status == 200
    except Exception:
        return False


def elevenlabs_credits_left():
    """Characters left on the ElevenLabs plan this billing period, or None if it can't be read
    (no key, key without user_read permission, network). None means "unknown", not "empty"."""
    if not ELEVEN_KEY: return 0
    try:
        req = urllib.request.Request('https://api.elevenlabs.io/v1/user/subscription', headers={'xi-api-key': ELEVEN_KEY})
        with urllib.request.urlopen(req, timeout=5) as resp:
            d = json.loads(resp.read())
        return max(0, int(d.get('character_limit') or 0) - int(d.get('character_count') or 0))
    except Exception:
        return None


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


def mac_say_available():
    return sys.platform == 'darwin' and shutil.which('say') is not None


def _mac_say(text, path, voice):
    """macOS built-in speech (`say`), converted to mp3 so it mixes like the other providers."""
    aiff = Path(str(path) + '.aiff')
    try:
        subprocess.run(['say', '-v', voice, '-o', str(aiff), text], check=True, capture_output=True, timeout=120)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(aiff), '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame',
                        '-b:a', '128k', '-f', 'mp3', str(path)], check=True, capture_output=True, timeout=120)
    finally:
        aiff.unlink(missing_ok=True)


def _key(provider, text, extra=''):
    return hashlib.sha256(f'{provider}\x00{extra}\x00{text}'.encode()).hexdigest()[:32]


def normalize_pronunciation(text: str) -> str:
    """Normalize text for natural TTS pronunciation without affecting on-screen captions.

    - Brand name: "Hadrius" -> "Heydrius"
    - Homograph "lives": verbs ("where ... lives", "record lives") -> "livs" (/lɪvz/, short "i")
      while protecting explicit plural nouns ("their lives", "daily lives", "saving lives").
      Note: we use "livs" instead of "livz" because VoiceStudio/OmniVoice decomposes trailing "-z"
      into an extra possessive/contraction token ("lives is" / "lives's").
    """
    if not text:
        return ""
    text = re.sub(r'\bHadrius\b', 'Heydrius', text)
    noun_modifiers = r'(their|our|your|my|his|her|its|personal|private|daily|saving|save|saved|lost|human|nine)'
    def replace_lives(m):
        prefix = m.group(1)
        word = m.group(2)
        if re.search(r'\b' + noun_modifiers + r'\s*$', prefix, re.IGNORECASE):
            return m.group(0)
        return prefix + ('Livs' if word[0].isupper() else 'livs')
    text = re.sub(r'(\b\w+\s+)(lives\b)', replace_lives, text, flags=re.IGNORECASE)
    text = re.sub(r'^(lives\b)', lambda m: 'Livs' if m.group(1)[0].isupper() else 'livs', text, flags=re.IGNORECASE)
    return text


class Narrator:
    """One per render. Provider order: ElevenLabs, then VoiceStudio, then edge-tts.

    ElevenLabs is used only while the plan has credits left; VoiceStudio only when its local
    server answers /health. The choice is made once per render (see plan()) so a video never
    switches voice halfway because credits ran out mid-render."""

    EL_TAG_EXTRA = f'{ELEVEN_VOICE}|{ELEVEN_MODEL}'

    def __init__(self, vs_voice=None, edge_voice=EDGE_VOICE, edge_rate=EDGE_RATE, edge_pitch=EDGE_PITCH):
        CACHE.mkdir(parents=True, exist_ok=True)
        self.vs_active = voicestudio_alive()
        self.vs_voice = vs_voice or VOICESTUDIO_VOICE
        self.edge = (edge_voice, edge_rate, edge_pitch)
        self.el_credits = elevenlabs_credits_left() if ELEVEN_KEY else 0
        # Without a plan() call (single-line previews) any credit at all is enough.
        self.el_active = bool(ELEVEN_KEY) and (self.el_credits is None or self.el_credits > 0)
        self.used_fallback = False
        self.cache_hits = 0
        self.generated = 0
        # Providers that failed in a way that won't fix itself mid-render (quota, bad key) — skipped
        # for every later line instead of each one paying for its own failed round-trip.
        self.dead = set()

    def plan(self, texts):
        """Decide up front whether ElevenLabs can voice every line of this render. Lines it has
        already cached are free; if the rest need more characters than the plan has left, the
        whole render goes to the next provider instead of mixing two voices."""
        if not self.el_active or self.el_credits is None: return
        need = 0
        for t in texts:
            if not t: continue
            t = normalize_pronunciation(t)
            hit = CACHE / f"el-{_key('el', t, self.EL_TAG_EXTRA)}.mp3"
            if not (hit.exists() and hit.stat().st_size > 0): need += len(t)
        if need > self.el_credits:
            self.el_active = False
            print(f'  ⚠ ElevenLabs has {self.el_credits} characters left, this render needs {need}; using the next provider', file=sys.stderr)

    def providers(self):
        """Provider chain in preference order, each as (tag, cache key extra, synth fn)."""
        chain = []
        if self.el_active:
            chain.append(('el', self.EL_TAG_EXTRA, _elevenlabs))
        if self.vs_active:
            chain.append(('vs', self.vs_voice, lambda t, p: _voicestudio(t, p, self.vs_voice)))
        if PICKED_PROVIDER == 'mac' and mac_say_available():
            chain.append(('mac', MAC_VOICE, lambda t, p: _mac_say(t, p, MAC_VOICE)))
        chain.append(('edge', '|'.join(self.edge), lambda t, p: _edge(t, p, *self.edge)))
        # NARRATION_PROVIDER=voicestudio|elevenlabs|edge moves that provider to the front (when it's
        # available); the rest stay as fallbacks in their usual order.
        prefer = PICKED_PROVIDER or {'voicestudio': 'vs', 'vs': 'vs', 'elevenlabs': 'el', 'el': 'el', 'edge': 'edge'}.get(
            env_from_dotenv('NARRATION_PROVIDER').lower())
        if prefer: chain.sort(key=lambda c: c[0] != prefer)
        live = [c for c in chain if c[0] not in self.dead]
        return live or chain[-1:]

    def speak(self, text):
        """Path to an mp3 of `text`, generating it only if this provider has never said it before."""
        text = normalize_pronunciation(text)
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
        provider = {'el': f'ElevenLabs (voice {ELEVEN_VOICE}, {ELEVEN_MODEL})', 'vs': f'VoiceStudio ({self.vs_voice})',
                    'mac': f'macOS say ({MAC_VOICE})', 'edge': f'edge-tts ({self.edge[0]})'}[self.providers()[0][0]]
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
