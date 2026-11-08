"""Offline-ASR orchestration contracts; fixture bytes and injected transcripts, no TTS or models."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from renderer.drift_qa import certify_transcript
from renderer.preservation import file_hash


class AutomaticNarrationTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='drift-asr-test-', dir=os.environ['TMPDIR'])
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.baseline = self.root / 'baseline'
        self.baseline.mkdir()
        self.candidate = self.write('candidate.mp4', b'explicit synthetic unit fixture, not a media verification')
        self.old = {'slides': [{'slide': 1, 'narration': 'Open Audiences', 'adur': 0.5},
                               {'slide': 2, 'narration': 'Review the settings', 'adur': 0.8}]}
        self.new = json.loads(json.dumps(self.old))
        self.new['slides'][0]['narration'] = 'Open Groups'
        self.assembly = self.write('baseline/assembly.json', self.old)
        self.baseline_media = self.write('baseline/baseline.mp4', b'explicit synthetic baseline, not media')
        self.manifest = self.write('baseline/baseline-manifest.json', {'assembly': {'file': 'assembly.json', 'sha256': file_hash(self.assembly)},
                                                    'final': {'file': 'baseline.mp4', 'sha256': file_hash(self.baseline_media)}})
        self.new_path = self.write('candidate-assembly.json', self.new)
        self.v = {'ok': True, 'source_unchanged': True, 'candidate': str(self.candidate), 'candidate_sha256': file_hash(self.candidate),
                  'candidate_assembly': str(self.new_path), 'baseline_sha256': file_hash(self.baseline_media),
                  'audio': {'ok': True, 'takes': [{'slide': 1, 'position_s': 0}, {'slide': 2, 'position_s': 2}]}}
        sources = {str(p): {'sha256': file_hash(p)} for p in (self.assembly, self.manifest)}
        self.v['source_snapshot'] = {'before': sources, 'after': json.loads(json.dumps(sources)), 'files': len(sources)}
        self.verification = self.write('verification.json', self.v)
        self.segments = [{'text': 'Open Groups. Review the settings.', 'words': [
            {'w': 'Open', 's': 0.1}, {'w': 'Groups', 's': 0.5}, {'w': 'Review', 's': 2.1},
            {'w': 'the', 's': 2.3}, {'w': 'settings', 's': 2.5}]}]
        for segment in self.segments:
            for word in segment['words']:
                word['e'] = word['s'] + 0.1

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else (json.dumps(data) + '\n').encode())
        return path

    def certify(self, **kwargs):
        self.write('verification.json', self.v)
        return certify_transcript(self.verification, self.baseline, self.root / 'asr',
                                  transcriber=kwargs.get('transcriber', lambda *_: self.segments))

    def test_exact_candidate_and_every_line_are_certified(self):
        report = self.certify()
        self.assertTrue(report['ok'])
        self.assertEqual(report['candidate_sha256'], file_hash(self.candidate))
        self.assertEqual(len(report['transcript']['lines']), 2)
        self.assertEqual(report['transcript']['replaced_lines']['OLD slide-01']['distinguishing_words'], ['audiences'])
        self.assertTrue((self.root / 'asr/transcript-report.json').is_file())

    def test_stale_old_label_does_not_pass(self):
        self.segments[0]['words'][1]['w'] = 'Audiences'
        report = self.certify()
        self.assertFalse(report['ok'])
        self.assertEqual(report['transcript']['replaced_lines']['OLD slide-01']['distinguishing_words_heard'], ['audiences'])

    def test_missing_unchanged_line_does_not_pass(self):
        self.segments[0]['words'] = self.segments[0]['words'][:2]
        self.assertFalse(self.certify()['ok'])

    def test_stale_candidate_rejected_before_transcribing(self):
        self.candidate.write_bytes(b'altered')
        with self.assertRaisesRegex(ValueError, 'source_hash_conflict'):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_partial_take_mapping_is_rejected(self):
        self.v['audio']['takes'].pop()
        with self.assertRaisesRegex(ValueError, 'complete_take_mapping_required'):
            self.certify()

    def test_duplicate_take_mapping_is_rejected(self):
        self.v['audio']['takes'][1]['slide'] = 1
        with self.assertRaisesRegex(ValueError, 'complete_take_mapping_required'):
            self.certify()

    def test_asr_cannot_mutate_the_candidate(self):
        def mutate(*_):
            self.candidate.write_bytes(b'mutated during transcription')
            return self.segments
        with self.assertRaisesRegex(ValueError, 'transcript_sources_changed'):
            self.certify(transcriber=mutate)


    def test_report_binds_verification_and_all_actual_inputs(self):
        report = self.certify()
        self.assertEqual(report['verification_sha256'], file_hash(self.verification))
        for path in (self.verification, self.candidate, self.new_path, self.assembly, self.manifest, self.baseline_media):
            self.assertEqual(report['source_snapshot'][str(path)], file_hash(path))

    def test_changed_verification_during_asr_is_rejected(self):
        def mutate(*_):
            self.verification.write_text('{}')
            return self.segments
        with self.assertRaisesRegex(ValueError, 'transcript_sources_changed'):
            self.certify(transcriber=mutate)

    def test_candidate_assembly_mutation_during_asr_is_rejected(self):
        def mutate(*_):
            self.new_path.write_text('{}')
            return self.segments
        with self.assertRaisesRegex(ValueError, 'transcript_sources_changed'):
            self.certify(transcriber=mutate)

    def test_missing_baseline_is_not_substituted(self):
        self.assembly.unlink()
        with self.assertRaises(FileNotFoundError):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_unrelated_baseline_manifest_is_rejected(self):
        data = json.loads(self.manifest.read_text())
        data['unrelated'] = True
        self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'baseline_snapshot_conflict'):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_hash_identical_relocated_baseline_is_accepted(self):
        import shutil
        relocated = self.root / 'relocated'
        shutil.copytree(self.baseline, relocated)
        shutil.rmtree(self.baseline)
        report = certify_transcript(self.verification, relocated, self.root / 'asr', transcriber=lambda *_: self.segments)
        self.assertTrue(report['ok'])
        self.assertIn(str(relocated / 'assembly.json'), report['source_snapshot'])

    def test_baseline_media_hash_is_verified(self):
        self.baseline_media.write_bytes(b'altered baseline')
        with self.assertRaisesRegex(ValueError, 'baseline_conflict'):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_no_rewrite_does_not_transcribe(self):
        self.new_path.write_text(json.dumps(self.old))
        with self.assertRaisesRegex(ValueError, 'changed_narration_required'):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_incomplete_or_failed_render_does_not_transcribe(self):
        for field in ('dry_run', 'noop', 'audio', 'source_unchanged'):
            with self.subTest(field=field):
                original = self.v.get(field)
                self.v[field] = {'ok': False} if field == 'audio' else field in ('dry_run', 'noop')
                with self.assertRaisesRegex(ValueError, 'completed_narration_repair_required'):
                    self.certify(transcriber=lambda *_: self.fail('ASR must not run'))
                self.v[field] = original

    def test_invalid_take_positions_are_rejected(self):
        for value in (float('nan'), float('inf'), -1, True, None):
            with self.subTest(value=value):
                self.v['audio']['takes'][0]['position_s'] = value
                with self.assertRaisesRegex(ValueError, 'verified_take_positions_required'):
                    self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_invalid_duration_is_rejected(self):
        self.new['slides'][0]['adur'] = float('nan')
        self.new_path.write_text(json.dumps(self.new))
        with self.assertRaisesRegex(ValueError, 'verified_narration_durations_required'):
            self.certify(transcriber=lambda *_: self.fail('ASR must not run'))

    def test_invalid_word_timestamps_are_rejected(self):
        self.segments[0]['words'][0]['e'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'invalid_asr_word_timestamps'):
            self.certify()

    def test_empty_asr_does_not_pass(self):
        self.assertFalse(self.certify(transcriber=lambda *_: [])['ok'])

    def test_old_label_in_asr_text_is_rejected_even_if_words_disagree(self):
        self.segments[0]['text'] += ' Audiences'
        self.assertFalse(self.certify()['ok'])


if __name__ == '__main__':
    unittest.main()
