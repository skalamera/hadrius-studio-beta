"""LOCAL deterministic re-mix of an assemble.py soundtrack (narration takes + music bed + card clips).

renderer/assemble.py is never imported or executed (its import prunes/touches the shared TTS/segment caches and
plans paid TTS). Its audio graph is restated here verbatim and PINNED against the source text: every fragment
below must still appear in assemble.py, else `assemble_audio_source_changed:<fragment>` (fail closed).

assemble's audio chain (step 4 + step 5), reproduced exactly:
  content audio  = per take: aresample 48k -> [audio_filter] -> loudnorm I=-16:TP=-1.5:LRA=11 (single pass) ->
                   aresample 48k -> adelay(int((t + (XF if k else 0.15)) * 1000) ms) -> aresample async first_pts=0;
                   amix(longest, normalize=0) = vox; music (-stream_loop -1) atrim 0:total, fade in 2 s / out 3 s,
                   -5 dB, sidechain-ducked by vox; amix + atrim + alimiter 0.95; AAC 192k 48 kHz, -t total   [gen 1]
  body           = acrossfade(lead card audio, content, 0.65)  AAC 192k                                   [gen 2]
  with support   = acrossfade(body, support card audio, 0.65)  AAC 192k                                   [gen 3]
  final          = acrossfade(that, outro card audio, 0.80)    AAC 192k                                   [gen 4]
The music bed is a static file (assets/music_upbeat.wav, generated once by make_music.py); nothing is random at
render time. With unchanged takes this reproduces the real pilot's final audio packet-for-packet (see
golden_from_pilot). Policy for a narration change: the whole track is re-mixed and re-encoded through the same
chain (unavoidable: narration and music are mixed into one stream), but every unchanged take file is fed in
byte-for-byte (sha256 checked) and its placement is verified by cross-correlation at its expected offset.
"""
import ast
import hashlib
import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSEMBLE = ROOT / 'renderer' / 'assemble.py'
SR = 48000
VOICE_LUFS = -16
XF = 0.8
CARD_XF = 0.65
OUTRO_XF = 0.8
AAC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']

PINNED_FRAGMENTS = (
    "VOICE_LUFS = -16",
    "s['sdur'] = round(max(HOLD_NO_NARR, s['adur'] + PAD_AFTER + XF), 3) if s['audio'] else HOLD_NO_NARR",
    "total = sum(s['sdur'] for s in slides) - XF * (len(slides) - 1)",
    "d = int((t + (XF if k else 0.15)) * 1000)",
    "eq = (s.get('audio_filter') or '') and s['audio_filter'] + ','",
    "aresample=48000,{eq}loudnorm=I={VOICE_LUFS}:TP=-1.5:LRA=11,aresample=48000,adelay={d}|{d},aresample=async=1:first_pts=0[a{idx}]",
    "t += s['sdur'] - (XF if k < len(slides) - 1 else 0)",
    "amix=inputs={len(voice_in)}:duration=longest:normalize=0[vox]",
    "MUSIC = Path(args[args.index('--music') + 1]) if '--music' in args else Path('assets/music_upbeat.wav')",
    "inputs += ['-stream_loop', '-1', '-i', str(MUSIC)]",
    "aresample=48000,atrim=0:{total:.3f},afade=t=in:d=2,afade=t=out:st={max(total-3,0):.3f}:d=3,volume=-5dB[mus]",
    "[vox]asplit=2[voxm][voxsc]",
    "[mus][voxsc]sidechaincompress=threshold=0.05:ratio=2:attack=40:release=600:makeup=1[musd]",
    "amix=inputs={len(mix_in)}:duration=longest:normalize=0,atrim=0:{total:.3f},alimiter=limit=0.95[aout]",
    "'-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', f'{total:.3f}', str(content_video)]",
    "[0:a][1:a]acrossfade=d={xf_dur}[a]",
    "'-c:a', 'aac', '-b:a', '192k', '-ar', '48000',\n            str(out_path)",
    "crossfade_pair(INTRO, title_clip, intro_title_path, xf_dur=0.65, intermediate=True)",
    "crossfade_pair(lead_clip, content_video, body_path, xf_dur=0.65,",
    "crossfade_pair(active_body, support_clip, support_path, xf_dur=0.65,",
    "crossfade_pair(active_body, OUTRO, outro_path, xf_dur=0.80)",
)


def sh(*args, timeout=600, cwd=None):
    return subprocess.check_output([str(x) for x in args], stderr=subprocess.PIPE, timeout=timeout, cwd=cwd)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def assemble_audio_pins(source=ASSEMBLE):
    """Fail closed unless assemble.py still contains the exact audio graph restated here."""
    text = Path(source).read_text()
    frags = {f: f in text for f in PINNED_FRAGMENTS}
    missing = [f for f, ok in frags.items() if not ok]
    if missing:
        raise ValueError('assemble_audio_source_changed:' + missing[0][:80])
    consts = {}
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id in ('VOICE_LUFS', 'XF', 'HOLD_NO_NARR', 'PAD_AFTER'):
                consts.setdefault(node.targets[0].id, []).append(ast.literal_eval(node.value))
    if any(len(v) != 1 for v in consts.values()) or len(consts) != 4:
        raise ValueError('assemble_audio_source_changed:constants')
    c = {k: v[0] for k, v in consts.items()}
    if (c['VOICE_LUFS'], c['XF']) != (VOICE_LUFS, XF):
        raise ValueError('assemble_audio_source_changed:constants')
    return {**c, 'fragments': frags, 'assemble_sha256': sha256_file(source)}


def ffprobe_duration(path):
    """assemble.dur(): container (format) duration."""
    return float(sh('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path).decode())


def voice_schedule(sdurs, narrated, xf=XF):
    """assemble's step-4 loop: slide start (rounded) and each take's adelay in ms, same float arithmetic."""
    t, out = 0.0, []
    n = len(sdurs)
    for k, sd in enumerate(sdurs):
        out.append({'start': round(t, 3), 'delay_ms': int((t + (xf if k else 0.15)) * 1000) if narrated[k] else None})
        t += sd - (xf if k < n - 1 else 0)
    total = sum(sdurs) - xf * (n - 1)
    return {'slides': out, 'total': total}


def content_filter(voices, total, music_index=None):
    """voices: [(input_index, delay_ms, audio_filter)]. Same filter graph text as assemble step 4."""
    filt, voice_in = [], []
    for i, d, af in voices:
        eq = (af or '') and af + ','
        filt.append(f"[{i}:a]aresample=48000,{eq}loudnorm=I={VOICE_LUFS}:TP=-1.5:LRA=11,aresample=48000,adelay={d}|{d},"
                    f"aresample=async=1:first_pts=0[a{i}]")
        voice_in.append(f'[a{i}]')
    mix_in = []
    if voice_in:
        filt.append(''.join(voice_in) + f"amix=inputs={len(voice_in)}:duration=longest:normalize=0[vox]")
    if music_index is not None:
        filt.append(f"[{music_index}:a]aresample=48000,atrim=0:{total:.3f},afade=t=in:d=2,afade=t=out:st={max(total-3,0):.3f}:d=3,volume=-5dB[mus]")
        if voice_in:
            filt.append("[vox]asplit=2[voxm][voxsc]")
            filt.append("[mus][voxsc]sidechaincompress=threshold=0.05:ratio=2:attack=40:release=600:makeup=1[musd]")
            mix_in += ['[voxm]', '[musd]']
        else:
            mix_in.append('[mus]')
    elif voice_in:
        mix_in.append('[vox]')
    if not mix_in:
        raise ValueError('no_audio_sources')
    filt.append(''.join(mix_in) + f"amix=inputs={len(mix_in)}:duration=longest:normalize=0,atrim=0:{total:.3f},alimiter=limit=0.95[aout]")
    return ';'.join(filt)


def build_content_audio(takes, sdurs, music, output, audio_filters=None):
    audio_filters = audio_filters or [''] * len(takes)
    sched = voice_schedule(sdurs, [t is not None for t in takes])
    inputs, voices = [], []
    for k, t in enumerate(takes):
        if t is not None:
            voices.append((len(voices), sched['slides'][k]['delay_ms'], audio_filters[k]))
            inputs += ['-i', str(t)]
    mi = None
    if music is not None:
        mi = len(voices)
        inputs += ['-stream_loop', '-1', '-i', str(music)]
    fc = content_filter(voices, sched['total'], mi)
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', *inputs, '-filter_complex', fc, '-map', '[aout]', *AAC, '-movflags', '+faststart',
           '-t', f"{sched['total']:.3f}", str(output)]
    sh(*cmd)
    return {'schedule': sched, 'filter': fc, 'cmd': cmd}


def crossfade(c1, c2, d, output):
    """crossfade_pair's audio half: [0:a][1:a]acrossfade=d=<d>, AAC 192k 48 kHz."""
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-i', str(c1), '-i', str(c2), '-filter_complex', f'[0:a][1:a]acrossfade=d={d}[a]',
           '-map', '[a]', *AAC, str(output)]
    sh(*cmd)
    return cmd


def rebuild_soundtrack(takes, sdurs, music, cards, workdir, audio_filters=None):
    """takes: per slide path or None (silent). cards: {'lead','support','outro'} audio-bearing clips (or None)."""
    wd = Path(workdir)
    wd.mkdir(parents=True)
    content = wd / 'content-audio.mp4'
    c = build_content_audio(takes, sdurs, music, content, audio_filters)
    cmds, cur, stages = [c['cmd']], content, {'content': content}
    origin = 0
    if cards.get('lead'):
        body = wd / 'body-audio.mp4'
        cmds.append(crossfade(cards['lead'], cur, CARD_XF, body))
        origin = decoded_samples(cards['lead']) - int(round(CARD_XF * SR))
        cur = stages['body'] = body
    if cards.get('support'):
        sup = wd / 'support-audio.mp4'
        cmds.append(crossfade(cur, cards['support'], CARD_XF, sup))
        cur = stages['support'] = sup
    if cards.get('outro'):
        fin = wd / 'final-audio.mp4'
        cmds.append(crossfade(cur, cards['outro'], OUTRO_XF, fin))
        cur = fin
    return {**stages, 'final': cur, 'schedule': c['schedule'], 'content_origin': origin, 'filter': c['filter'],
            'commands': [[str(x) for x in cmd] for cmd in cmds], 'generations': 1 + sum(bool(cards.get(k)) for k in ('lead', 'support', 'outro'))}


# ---------- evidence ----------

def packets(path):
    rows = json.loads(sh('ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', path))['packets']
    keys = ('pts', 'dts', 'duration', 'size', 'flags', 'data_hash')
    return [{**{k: p.get(k) for k in keys}, 'side_data_list': p.get('side_data_list', [])} for p in rows]


def stream_info(path):
    s = json.loads(sh('ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', path))['streams'][0]
    return {k: s.get(k) for k in ('codec_name', 'profile', 'sample_rate', 'channels', 'initial_padding', 'time_base', 'start_pts', 'duration_ts')}


def _pcm(path):
    return sh('ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'f32le', '-')


def decode(path, mono=False):
    import numpy as np
    ch = int(stream_info(path)['channels'])
    a = np.frombuffer(_pcm(path), dtype='<f4').reshape(-1, ch)
    return a.mean(axis=1) if mono else a


def decoded_samples(path):
    return len(decode(path))


def audio_evidence(path):
    p, pcm, info = packets(path), _pcm(path), stream_info(path)
    ch = int(info['channels'])
    return {'packet_count': len(p), 'packets_sha256': hashlib.sha256(json.dumps(p, sort_keys=True).encode()).hexdigest(),
            'pcm_sha256': hashlib.sha256(pcm).hexdigest(), 'samples': len(pcm) // 4 // ch, 'channels': ch,
            'sample_rate': int(info['sample_rate']), 'duration_s': round(len(pcm) // 4 // ch / int(info['sample_rate']), 6),
            'stream': info}


def _xcorr_lag(a, b, max_lag):
    """Lag of b relative to a (b[n] ~ a[n - lag]) by FFT cross-correlation, |lag| <= max_lag."""
    import numpy as np
    n = 1 << int(math.ceil(math.log2(len(a) + len(b))))
    c = np.fft.irfft(np.fft.rfft(b, n) * np.conj(np.fft.rfft(a, n)), n)
    lags = np.concatenate([c[:max_lag + 1], c[-max_lag:]])
    idx = int(np.argmax(lags))
    return idx if idx <= max_lag else idx - len(lags)


def compare_pcm(a_path, b_path):
    import numpy as np
    a, b = decode(a_path), decode(b_path)
    n = min(len(a), len(b))
    ch = min(a.shape[1], b.shape[1])
    x, y = a[:n, :ch].astype(np.float64), b[:n, :ch].astype(np.float64)
    err = float(np.sum((x - y) ** 2))
    sig = float(np.sum(x ** 2))
    corr = float(np.corrcoef(x.ravel(), y.ravel())[0, 1]) if n and np.std(x) > 0 and np.std(y) > 0 else None
    win = min(n, 10 * SR)
    lag = _xcorr_lag(x[:win].mean(axis=1), y[:win].mean(axis=1), 2000) if win > 4000 else 0
    return {'samples_a': len(a), 'samples_b': len(b), 'channels_a': a.shape[1], 'channels_b': b.shape[1],
            'max_abs_diff': float(np.max(np.abs(x - y))) if n else None, 'snr_db': (float('inf') if err == 0 else round(10 * math.log10(sig / err), 3)),
            'correlation': corr, 'best_lag_samples': lag, 'identical': a.shape == b.shape and err == 0.0}


def processed_take(take, audio_filter, workdir, tag):
    """The take exactly as assemble feeds it to the voice bus (before adelay): mono float32 at 48 kHz."""
    import numpy as np
    eq = (audio_filter or '') and audio_filter + ','
    raw = sh('ffmpeg', '-nostdin', '-v', 'error', '-i', take, '-af', f'aresample=48000,{eq}loudnorm=I={VOICE_LUFS}:TP=-1.5:LRA=11,aresample=48000',
             '-ac', '1', '-f', 'f32le', '-')
    return np.frombuffer(raw, dtype='<f4')


def locate_takes(final, takes, audio_filters, schedule, content_origin, workdir, search_ms=250, ref_s=2.0):
    """Normalized cross-correlation of each processed take (first ref_s) against the final mix around its expected
    sample = content_origin + delay_ms * 48. Returns the measured lag (samples) and peak correlation per take."""
    import numpy as np
    mix = decode(final, mono=True).astype(np.float64)
    S = int(search_ms * SR / 1000)
    out = []
    for k, t in enumerate(takes):
        d = schedule['slides'][k]['delay_ms']
        if t is None or d is None:
            continue
        ref = processed_take(t, audio_filters[k] if audio_filters else '', workdir, k)[: int(ref_s * SR)].astype(np.float64)
        exp = content_origin + d * SR // 1000
        lo = max(0, exp - S)
        seg = mix[lo: exp + S + len(ref)]
        L = len(ref)
        if len(seg) < L:
            out.append({'slide': k + 1, 'expected_sample': exp, 'error': 'outside_mix'})
            continue
        n = 1 << int(math.ceil(math.log2(len(seg) + L)))
        num = np.fft.irfft(np.fft.rfft(seg, n) * np.conj(np.fft.rfft(ref, n)), n)[: len(seg) - L + 1]
        c2 = np.concatenate([[0.0], np.cumsum(seg ** 2)])
        energy = np.sqrt(np.maximum(c2[L:] - c2[:-L], 1e-12)) * np.sqrt(np.sum(ref ** 2))
        ncc = num / energy
        i = int(np.argmax(ncc))
        pos = lo + i
        out.append({'slide': k + 1, 'take': str(t), 'take_sha256': sha256_file(t), 'expected_sample': exp, 'expected_s': round(exp / SR, 6),
                    'position_sample': pos, 'position_s': round(pos / SR, 6), 'lag_samples': pos - exp, 'peak': round(float(ncc[i]), 4)})
    return out


def common_prefix(a, b):
    """How much of b's audio is identical to a's from the start (packets and decoded samples)."""
    import numpy as np
    pa, pb = packets(a), packets(b)
    k = 0
    while k < min(len(pa), len(pb)) and pa[k] == pb[k]:
        k += 1
    x, y = decode(a), decode(b)
    n = min(len(x), len(y))
    neq = np.nonzero(np.any(x[:n] != y[:n], axis=1))[0]
    m = int(neq[0]) if len(neq) else n
    return {'identical_leading_packets': k, 'packets_a': len(pa), 'packets_b': len(pb), 'identical_leading_samples': m,
            'identical_leading_s': round(m / SR, 4)}


# ---------- golden on a real (read-only) render ----------

def card_clips(build_dir, assembly):
    """assemble step 5's clip choice for the standard topology (logo intro+outro, title card, support card)."""
    b = Path(build_dir)
    if not (assembly.get('intro') and assembly.get('title_card') and assembly.get('support_card') and assembly.get('outro')):
        raise ValueError('unsupported_card_topology')
    cards = {'lead': b / 'intro_title_crossfaded.mp4', 'support': b / 'support_card.mp4', 'outro': b / 'logo_card.mp4'}
    for p in cards.values():
        if not p.is_file() or p.is_symlink():
            raise ValueError('missing_card_clip')
    return cards


def golden_from_pilot(pilot_dir, music, output):
    """Rebuild the pilot's soundtrack from its UNCHANGED takes + music + card clips and compare every stage with
    the real _build intermediates and the final MP4 audio. Everything real is read-only (snapshot asserted)."""
    from .fx_draw import snapshot
    pilot, out = Path(pilot_dir), Path(output)
    out.mkdir()
    name = pilot.name
    assembly = json.loads((pilot / 'assembly.json').read_bytes())
    slides = assembly['slides']
    takes = [Path(s['audio']) if s.get('audio') else None for s in slides]
    cards = card_clips(pilot / '_build', assembly)
    final = pilot / f'{name}.mp4'
    stages = {'content': pilot / '_build' / 'content.mp4', 'body': pilot / '_build' / 'body_crossfaded.mp4',
              'support': pilot / '_build' / 'body_with_support.mp4'}
    real = [pilot / 'assembly.json', final, Path(music), ASSEMBLE, *[t for t in takes if t], *cards.values(), *stages.values()]
    before = snapshot(real)
    pins = assemble_audio_pins()
    sd = [s['sdur'] for s in slides]
    sdur_rule = [round(max(1.9, s['adur'] + 1.1 + 0.8), 3) if s.get('audio') else 1.9 for s in slides]
    adur_now = [ffprobe_duration(t) if t else 0.0 for t in takes]
    r = rebuild_soundtrack(takes, sd, music, cards, out / 'rebuilt', [s.get('audio_filter') or '' for s in slides])
    inter = {}
    for k, p in stages.items():
        inter[k] = {'packets_equal': packets(r[k]) == packets(p), 'pcm_equal': audio_evidence(r[k])['pcm_sha256'] == audio_evidence(p)['pcm_sha256']}
    fin = {'packets_equal': packets(r['final']) == packets(final), 'original': audio_evidence(final), 'rebuilt': audio_evidence(r['final']),
           'pcm': compare_pcm(final, r['final'])}
    cal = locate_takes(final, takes, [s.get('audio_filter') or '' for s in slides], r['schedule'], r['content_origin'], out)
    after = snapshot(real)
    res = {'ok': bool(fin['packets_equal'] and fin['pcm']['identical'] and all(v['packets_equal'] for v in inter.values()) and before == after),
           'name': name, 'pins': pins, 'schedule': r['schedule'], 'sdur_equals_assemble_rule': sd == sdur_rule,
           'adur_recorded_equals_ffprobe_now': [round(a, 6) == round(s['adur'], 6) for a, s in zip(adur_now, slides)],
           'starts_equal_assembly': [x['start'] for x in r['schedule']['slides']] == [s['start'] for s in slides],
           'intermediates': inter, 'final': fin, 'content_origin_sample': r['content_origin'], 'take_calibration': cal,
           'generations': r['generations'], 'music': {'path': str(music), 'sha256': before[str(Path(music))]['sha256']},
           'commands': r['commands'], 'source_unchanged': before == after, 'source_snapshot': {'before': before, 'after': after}}
    (out / 'audio-golden.json').write_text(json.dumps(res, indent=2, default=str) + '\n')
    return res
