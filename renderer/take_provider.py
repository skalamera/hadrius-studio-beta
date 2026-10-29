"""REAL narration takes for an approved line, through the production TTS path, without importing renderer/tts.py.

    take = provide_take(line, script['voice'], job_dir, tag='slide-03')

Runs `.venv/bin/python renderer/tts.py "<line>"` as a SUBPROCESS with env NARRATION_VOICE=<script voice>, cwd=repo,
exactly like tools/ai-bridge.mjs POST /preview/narration (execFile(python, [renderer/tts.py, line], {cwd: REPO_ROOT,
env: narrationEnv(voice)}); the LAST stdout line is JSON {path, provider, cached}). tts.py may touch/create files in
out/_cache/tts (the same thing every bridge preview does); nothing else is written under out/ here.

Fail closed (`voice_unavailable`, with a precise `reason`) unless:
  - the script voice is ElevenLabs (`el:<20-char id>`),
  - tts.py reports provider `el` (no silent fallback to VoiceStudio/edge/say),
  - the returned file is `out/_cache/tts/el-<key>.mp3` with key = tts._key('el', normalize_pronunciation(line),
    '<voice id>|<model>') for the script's voice id and the model tts.py defaults to (both functions and the default
    model literal are AST-extracted from tts.py's source and pinned; never imported/executed),
  - the file decodes as audio.
The take is then COPIED into the job dir (sha256 pinned). Characters spent = len(normalized line) when not cached.

The macOS `say` stand-in (renderer.narration_update.make_standin_take) stays available for tests only, behind an
explicit allow_standin=True.
"""
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TTS = ROOT / 'renderer' / 'tts.py'
VOICE_RE = re.compile(r'^el:([A-Za-z0-9]{20})$')
PINNED = (
    "print(json.dumps({'path': str(path), 'provider': tag, 'cached': n.cache_hits > 0}))",
    "path, tag = n.speak(sys.argv[1].strip())",
    "_pick = env_from_dotenv('NARRATION_VOICE')",
    "if PICKED_PROVIDER == 'el': ELEVEN_VOICE = _pv",
    "EL_TAG_EXTRA = f'{ELEVEN_VOICE}|{ELEVEN_MODEL}'",
    "hit = CACHE / f'{tag}-{_key(tag, text, extra)}.mp3'",
    "text = normalize_pronunciation(text)",
    "CACHE = ROOT / 'out' / '_cache' / 'tts'",
)
MODEL_STATEMENT = "ELEVEN_MODEL = env_from_dotenv('ELEVENLABS_MODEL_ID') or 'eleven_multilingual_v2'"


class TakeRejected(ValueError):
    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


_PORT = {}


def tts_port(source=TTS):
    """normalize_pronunciation + _key + the default ElevenLabs model, AST-extracted from tts.py (fail closed)."""
    key = (str(source), Path(source).stat().st_mtime_ns)
    if key in _PORT:
        return _PORT[key]
    text = Path(source).read_text()
    missing = [p for p in PINNED if p not in text]
    if missing:
        raise TakeRejected('tts_cli_contract_changed', missing[0])
    tree = ast.parse(text)
    defs, model = {}, None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in ('normalize_pronunciation', '_key'):
            if node.name in defs or node.decorator_list:
                raise TakeRejected('tts_cli_contract_changed', node.name)
            defs[node.name] = node
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ELEVEN_MODEL' for t in node.targets):
            if model is not None or ast.dump(node) != ast.dump(ast.parse(MODEL_STATEMENT).body[0]):
                raise TakeRejected('tts_cli_contract_changed', 'ELEVEN_MODEL')
            model = node.value.values[-1].value
    if set(defs) != {'normalize_pronunciation', '_key'} or model is None:
        raise TakeRejected('tts_cli_contract_changed', sorted(defs))
    from .fx_draw import _function_globals
    import builtins
    ns = {'__builtins__': builtins, 're': re, 'hashlib': hashlib, '__name__': 'renderer.take_provider.tts_port'}
    for name, node in defs.items():
        for g in _function_globals(ast.get_source_segment(text, node)):
            if g not in ns and g not in defs and not hasattr(builtins, g):
                raise TakeRejected('tts_cli_contract_changed', f'{name}:{g}')
    exec(compile(ast.Module(body=list(defs.values()), type_ignores=[]), '<tts.py:take_provider>', 'exec'), ns)
    port = {'normalize': ns['normalize_pronunciation'], 'key': ns['_key'], 'default_model': model,
            'sources_sha256': {k: hashlib.sha256(ast.get_source_segment(text, v).encode()).hexdigest() for k, v in defs.items()},
            'tts_sha256': sha256_file(source)}
    _PORT[key] = port
    return port


def default_model():
    return tts_port()['default_model']


def cache_name(text, voice_id, model):
    p = tts_port()
    return f"el-{p['key']('el', p['normalize'](text.strip()), f'{voice_id}|{model}')}.mp3"


def voice_id(voice):
    m = VOICE_RE.match(str(voice or ''))
    if not m:
        raise TakeRejected('voice_unavailable', {'reason': 'script_voice_not_elevenlabs', 'voice': voice})
    return m.group(1)


def verify_baseline_takes(assembly, voice, models=None):
    """Every narrated baseline slide's take file name must be the cache name of ITS narration in `voice`: proves the
    baseline was voiced by that ElevenLabs voice (and which model), so new takes in the same voice match it."""
    vid = voice_id(voice)
    models = list(models or [default_model()])
    rows, ok = [], True
    for s in assembly['slides']:
        if not s.get('audio'):
            continue
        got = Path(s['audio']).name
        hit = next((mo for mo in models if cache_name(s.get('narration') or '', vid, mo) == got), None)
        rows.append({'slide': s['slide'], 'take': got, 'model': hit})
        ok &= hit is not None
    return {'ok': bool(ok and rows), 'voice': voice, 'models': models, 'slides': rows}


def _probe_audio(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels',
                                   '-show_entries', 'format=duration', '-of', 'json', str(path)], timeout=60)
    j = json.loads(out)
    s = j['streams'][0]
    return {'codec_name': s.get('codec_name'), 'sample_rate': s.get('sample_rate'), 'channels': s.get('channels'),
            'duration': float(j['format']['duration'])}


def provide_take(text, voice, job_dir, *, tag, repo=ROOT, python=None, timeout=150, models=None):
    """One real take for `text` in `voice` (script.voice). Returns pinned take info; raises TakeRejected."""
    line = str(text or '').strip()
    if not line:
        raise TakeRejected('voice_unavailable', {'reason': 'empty_line'})
    vid = voice_id(voice)
    repo = Path(repo).resolve()
    py = python or (str(repo / '.venv' / 'bin' / 'python') if (repo / '.venv' / 'bin' / 'python').exists() else 'python3')
    cmd = [str(py), str(repo / 'renderer' / 'tts.py'), line]
    env = {**os.environ, 'NARRATION_VOICE': voice}
    try:
        res = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TakeRejected('voice_unavailable', {'reason': 'tts_timeout', 'timeout_s': timeout}) from None
    if res.returncode != 0:
        tail = (res.stderr or '').strip().splitlines()[-1:] or ['']
        raise TakeRejected('voice_unavailable', {'reason': 'tts_failed', 'returncode': res.returncode, 'stderr_tail': tail[0][:300]})
    try:
        out = json.loads((res.stdout or '').strip().splitlines()[-1])
        path, provider, cached = Path(out['path']), out['provider'], bool(out['cached'])
    except (ValueError, KeyError, IndexError, TypeError):
        raise TakeRejected('voice_unavailable', {'reason': 'tts_output_unparsable'}) from None
    warnings = [x for x in (res.stderr or '').splitlines() if x.strip()]
    if provider != 'el':
        raise TakeRejected('voice_unavailable', {'reason': 'provider_not_elevenlabs', 'provider': provider, 'path': str(path),
                                                 'stderr': warnings[-3:]})
    cache = (repo / 'out' / '_cache' / 'tts').resolve()
    rp = path.resolve()
    if not rp.is_relative_to(cache) or rp.parent != cache or not rp.is_file() or path.is_symlink():
        raise TakeRejected('voice_unavailable', {'reason': 'take_outside_tts_cache', 'path': str(path)})
    models = list(models or [default_model()])
    normalized = tts_port()['normalize'](line)
    model = next((mo for mo in models if cache_name(line, vid, mo) == rp.name), None)
    if model is None:
        raise TakeRejected('voice_unavailable', {'reason': 'voice_id_mismatch', 'path': rp.name, 'expected_voice': voice,
                                                 'expected_names': {mo: cache_name(line, vid, mo) for mo in models}})
    try:
        info = _probe_audio(rp)
    except (subprocess.CalledProcessError, KeyError, IndexError, ValueError):
        raise TakeRejected('voice_unavailable', {'reason': 'take_not_audio', 'path': str(rp)}) from None
    dest_dir = Path(job_dir) / 'takes'
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f'{tag}-{rp.name}'
    src_sha = sha256_file(rp)
    shutil.copyfile(rp, dest)
    sha = sha256_file(dest)
    if sha != src_sha:
        raise TakeRejected('voice_unavailable', {'reason': 'take_changed_while_copying'})
    rec = {'path': str(dest), 'sha256': sha, 'provider': 'el', 'provider_label': f'ElevenLabs (voice {vid}, {model})', 'voice': voice,
           'voice_id': vid, 'model': model, 'cached': cached, 'characters': 0 if cached else len(normalized), 'text': line,
           'normalized_text': normalized, 'provider_path': str(rp), 'source': 'ElevenLabs via renderer/tts.py subprocess (production TTS path)',
           'command': [cmd[0], cmd[1], '<line>'], 'env': {'NARRATION_VOICE': voice}, 'stderr': warnings[-5:], **info}
    (dest_dir / f'{tag}.take.json').write_text(json.dumps(rec, indent=2) + '\n')
    return rec


def standin_take(text, job_dir, *, tag, allow_standin=False):
    """macOS `say` STAND-IN (tests only). Never the provider voice; requires an explicit flag."""
    if not allow_standin:
        raise TakeRejected('standin_not_allowed')
    from .narration_update import make_standin_take, STANDIN_LABEL
    d = Path(job_dir) / 'takes'
    d.mkdir(parents=True, exist_ok=True)
    info = make_standin_take(text, d / f'{tag}-standin.mp3')
    return {**info, 'provider': 'standin', 'voice': None, 'cached': False, 'characters': 0, 'source': STANDIN_LABEL}


def provider(mode='elevenlabs', *, repo=ROOT, python=None, allow_standin=False):
    """A take_provider callable for renderer.drift_update.run: (text, voice, dest_dir, tag) -> take info."""
    if mode == 'elevenlabs':
        return lambda text, voice, dest, tag: provide_take(text, voice, dest, tag=tag, repo=repo, python=python)
    if mode == 'standin':
        if not allow_standin:
            raise TakeRejected('standin_not_allowed')
        return lambda text, voice, dest, tag: standin_take(text, dest, tag=tag, allow_standin=True)
    raise TakeRejected('unknown_take_mode', mode)


if __name__ == '__main__':  # pragma: no cover - manual probe of the port only (no TTS call)
    print(json.dumps({k: v for k, v in tts_port().items() if k not in ('normalize', 'key')}, indent=2))
    sys.exit(0)
