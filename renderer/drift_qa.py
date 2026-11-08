"""Candidate-bound offline ASR for automatic narration repairs. No TTS, app calls, or source edits."""
import argparse
import json
import math
from pathlib import Path

from .drift_update import transcribe, transcript_check, _tokens
from .preservation import file_hash


def certify_transcript(verification_path, baseline_dir, output, *, transcriber=transcribe):
    verification_path, baseline_dir, output = map(Path, (verification_path, baseline_dir, output))
    if output.exists():
        raise ValueError('transcript_output_exists')
    verification_hash = file_hash(verification_path)
    verification = json.loads(verification_path.read_bytes())
    manifest_path = baseline_dir / 'baseline-manifest.json'
    manifest_hash = file_hash(manifest_path)
    manifest = json.loads(manifest_path.read_bytes())
    assembly_path = baseline_dir / manifest['assembly']['file']
    baseline_media = baseline_dir / manifest['final']['file']
    candidate = Path(verification['candidate'])
    next_path = Path(verification['candidate_assembly'])
    paths = [verification_path, manifest_path, assembly_path, baseline_media, candidate, next_path]
    before = {str(path): file_hash(path) for path in paths}
    if before[str(verification_path)] != verification_hash or before[str(manifest_path)] != manifest_hash:
        raise ValueError('transcript_sources_changed')
    original = json.loads(assembly_path.read_bytes())
    newer = json.loads(next_path.read_bytes())
    if (verification.get('ok') is not True or verification.get('dry_run') or verification.get('noop')
            or verification.get('source_unchanged') is not True or verification.get('audio', {}).get('ok') is not True):
        raise ValueError('completed_narration_repair_required')
    if before[str(candidate)] != verification['candidate_sha256'] or before[str(assembly_path)] != manifest['assembly']['sha256']:
        raise ValueError('transcript_source_hash_conflict')
    if verification['baseline_sha256'] != manifest['final']['sha256'] or before[str(baseline_media)] != manifest['final']['sha256']:
        raise ValueError('transcript_baseline_conflict')
    snapshot = verification.get('source_snapshot', {})
    rendered_sources = snapshot.get('before', {})
    # Equivalent relocated baseline bytes are accepted only by their original renderer-snapshotted hashes.
    # Never rewrite the old verification or claim that missing original paths have been restored.
    if (not rendered_sources or rendered_sources != snapshot.get('after') or snapshot.get('files') != len(rendered_sources)
            or not any(Path(p).name == manifest_path.name and entry.get('sha256') == manifest_hash for p, entry in rendered_sources.items())
            or not any(entry.get('sha256') == manifest['assembly']['sha256'] for entry in rendered_sources.values())):
        raise ValueError('transcript_baseline_snapshot_conflict')
    slides, takes = newer['slides'], verification['audio']['takes']
    if not slides or len(original['slides']) != len(slides) or len(takes) != len(slides):
        raise ValueError('complete_take_mapping_required')
    if (any(type(x.get('slide')) is not int for x in takes)
            or sorted(x['slide'] for x in takes) != list(range(1, len(slides) + 1))
            or any(s.get('slide') != i for i, s in enumerate(slides, 1))
            or any(s.get('slide') != i for i, s in enumerate(original['slides'], 1))):
        raise ValueError('complete_take_mapping_required')
    if any(type(x.get('position_s')) not in (float, int) or not math.isfinite(x['position_s']) or x['position_s'] < 0 for x in takes):
        raise ValueError('verified_take_positions_required')
    if any(type(s.get('adur')) not in (float, int) or not math.isfinite(s['adur']) or s['adur'] <= 0
           or not isinstance(s.get('narration'), str) or not _tokens(s['narration']) for s in slides):
        raise ValueError('verified_narration_durations_required')
    if all(old.get('narration') == new.get('narration') for old, new in zip(original['slides'], slides)):
        raise ValueError('changed_narration_required')
    output.mkdir(parents=True)
    segments = transcriber(candidate, output / 'segments')
    if not isinstance(segments, list) or any(not isinstance(s.get('text'), str) or not isinstance(s.get('words'), list) for s in segments):
        raise ValueError('invalid_asr_segments')
    for segment in segments:
        for word in segment['words']:
            if (not isinstance(word.get('w'), str) or any(type(word.get(k)) not in (int, float) or not math.isfinite(word[k]) for k in ('s', 'e'))
                    or word['s'] < 0 or word['e'] < word['s']):
                raise ValueError('invalid_asr_word_timestamps')
    lines = [(f"slide-{take['slide']:02d}", slides[take['slide'] - 1]['narration'],
              take['position_s'] - 0.3, take['position_s'] + slides[take['slide'] - 1]['adur'] + 0.6) for take in takes]
    heard = {token for segment in segments for word in segment['words'] for token in _tokens(word['w'])}
    heard.update(token for segment in segments for token in _tokens(segment['text']))
    current = {token for slide in slides for token in _tokens(slide.get('narration') or '')}
    replaced = {}
    for old, new in zip(original['slides'], slides):
        if old.get('narration') == new.get('narration'):
            continue
        distinguishing = set(_tokens(old['narration'])) - current
        replaced[f"OLD slide-{old['slide']:02d}"] = {'old': old['narration'], 'distinguishing_words': sorted(distinguishing),
            'distinguishing_words_heard': sorted(distinguishing & heard)}
    transcript = {'model': 'faster-whisper small.en (int8, cpu, offline)', 'lines': transcript_check(segments, lines),
        'text': ' '.join(segment['text'].strip() for segment in segments), 'replaced_lines': replaced}
    transcript['ok'] = bool(replaced and all(line['recall'] >= 0.8 for line in transcript['lines'].values())
                            and not any(line['distinguishing_words_heard'] for line in replaced.values()))
    after = {str(path): file_hash(path) for path in paths}
    if before != after:
        raise ValueError('transcript_sources_changed')
    report = {'schema': 1, 'kind': 'automatic-narration-transcript', 'ok': transcript['ok'],
        'candidate': str(candidate), 'candidate_sha256': verification['candidate_sha256'], 'verification': str(verification_path),
        'verification_sha256': before[str(verification_path)], 'transcript': transcript,
        'source_snapshot': before, 'source_unchanged': True}
    (output / 'transcript-report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verification', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(argv)
    report = certify_transcript(args.verification, args.baseline, args.output)
    print(json.dumps({'ok': report['ok'], 'report': str(Path(args.output) / 'transcript-report.json'),
                     'candidate_sha256': report['candidate_sha256']}))
    return 0 if report['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
