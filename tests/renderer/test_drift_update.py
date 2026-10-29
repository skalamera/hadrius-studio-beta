"""renderer.drift_update: ONE candidate for ANY number of approved step changes (screenshot / target geometry /
narration+caption, in any combination), composed from fx_draw (planner + drawing), fx_scope (cells), retime (cell map,
protected camera views), audio_rebuild (one soundtrack re-mix) and rebaseline/preservation (splice + verification).

Synthetic fixture: 4 narrated slides planned by assemble's own planner and built by assemble's own chain WITH audio
(screens [slide-01, slide-02] [slide-03] [slide-04]), so every golden gate is meaningful. The real pilot is opt-in
(HADRIUS_REAL_PILOT_DRIFT_UPDATE=1; it spends a few ElevenLabs characters unless the lines are already cached)."""
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from renderer import audio_rebuild as ar, drift_render, drift_update as du, fx_draw, rebaseline, take_provider as tp
from tests.renderer.test_audio_rebuild import music_bed, noise_take
from tests.renderer.test_drift_render import chain_capture

REPO = Path(__file__).resolve().parents[2]
NAME = 'Synthetic-Combined'
ROUTES = ['/a', '/a', '/b', '/c']
TARGETS = [None, {'x': 300, 'y': 260, 'width': 320, 'height': 110}, None, None]
TAKE_SECONDS = (0.4, 0.5, 0.35, 0.3)


def build_fixture(root):
    """Captures -> planner -> segments -> assemble's stitch + content audio graph + card crossfades (with audio)."""
    root = Path(root)
    media = root / 'media'
    media.mkdir()
    takes = [noise_take(media / f'take-{i}.mp3', 11 + i, d) for i, d in enumerate(TAKE_SECONDS)]
    adurs = [ar.ffprobe_duration(t) for t in takes]
    sdurs = [round(max(1.9, a + 1.1 + 0.8), 3) for a in adurs]
    music = music_bed(media / 'music.wav')
    rec = root / 'src' / '_recordings' / 'rec-combined'
    rec.mkdir(parents=True)
    steps = []
    for i in range(4):
        name = f'step_{i:012x}.png'
        chain_capture(i).save(rec / name)
        st = {'id': f'step-{i}', 'index': i, 'media': {'pre': name}, 'route': ROUTES[i], 'action': 'click' if i == 1 else 'navigate',
              'capture': True, 'narration': f'line {i}', 'caption': f'line {i}'}
        t = TARGETS[i]
        if t:
            st['target'] = {'css': 'a', 'hint': {'bbox': {'x': t['x'], 'y': t['y'], 'w': t['width'], 'h': t['height']},
                                                 'viewport': {'w': 1600, 'h': 900}}}
        steps.append(st)
    script = {'id': 'combined-script', 'name': NAME, 'fx': True, 'voice': 'el:ZoiZ8fuDWInAcwPXaVeq', 'recording': {'id': 'rec-combined'},
              'steps': steps, 'captionsFromNarration': False}
    (root / 'src' / 'base.script.json').write_text(json.dumps(script, indent=2))
    pilot = root / 'repo' / 'out' / NAME
    build = pilot / '_build'
    (pilot / 'slides').mkdir(parents=True)
    pre = [fx_draw.from_recording_slide(st, i + 1, (1600, 900), False) for i, st in enumerate(steps)]
    for s, sd in zip(pre, sdurs):
        s['sdur'] = sd
        shutil.copyfile(rec / s['src'], pilot / 'slides' / s['file'])
    planner = fx_draw.load_planner(out_dir=pilot, tmp_dir=build, needs_drawn_highlight=True)
    planned, _ = planner.replan(pre)
    d = fx_draw.load(out_dir=pilot, tmp_dir=build, needs_drawn_highlight=True)
    for s in planned:
        fx_draw.render_segment(d, fx_draw.frozen_slide(s), build / f"seg{s['slide']:02d}.mp4")
    sh = fx_draw.sh
    segs = [build / f'seg{i:02d}.mp4' for i in range(1, 5)]
    sh(*fx_draw.xfade_command(segs, sdurs, build / 'video.mp4', 0.8, 30, d.ns['INTERMEDIATE_ENCODE']))
    sched = ar.voice_schedule(sdurs, [True] * 4)
    total = sched['total']
    voices = [(i + 1, sched['slides'][i]['delay_ms'], '') for i in range(4)]
    ins = ['-i', build / 'video.mp4']
    for t in takes:
        ins += ['-i', t]
    ins += ['-stream_loop', '-1', '-i', music]
    sh('ffmpeg', '-y', '-v', 'error', *ins, '-filter_complex', ar.content_filter(voices, total, 5), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy',
       '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', f'{total:.3f}', build / 'content.mp4')

    def card(name, color, seconds, audio):
        sh('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f'color={color}:s=1920x1080:r=30:d={seconds}', '-f', 'lavfi', '-i', audio,
           '-map', '0:v', '-map', '1:a', '-t', str(seconds), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
           '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', build / name)
    card('intro_title_crossfaded.mp4', '0x203060', 1.7, 'sine=frequency=330:sample_rate=48000')
    card('support_card.mp4', '0x305020', 2.0, 'sine=frequency=550:sample_rate=48000')
    card('logo_card.mp4', 'white', 1.5, 'anullsrc=r=48000:cl=stereo')
    dur = drift_render.media_duration

    def xf(c1, c2, outp, x, inter):
        enc = d.ns['INTERMEDIATE_ENCODE'] if inter else drift_render.CROSSFADE_FINAL_ENCODE
        sh(*drift_render.crossfade_command(c1, c2, outp, x, max(0.05, dur(c1) - x), enc, audio=True))
    xf(build / 'intro_title_crossfaded.mp4', build / 'content.mp4', build / 'body_crossfaded.mp4', 0.65, True)
    xf(build / 'body_crossfaded.mp4', build / 'support_card.mp4', build / 'body_with_support.mp4', 0.65, True)
    xf(build / 'body_with_support.mp4', build / 'logo_card.mp4', pilot / f'{NAME}.mp4', 0.8, False)
    for i, s in enumerate(planned):
        s.update({'step': i, 'src': steps[i]['media']['pre'], 'start': sched['slides'][i]['start'], 'audio': str(takes[i]),
                  'audio_filter': '', 'adur': adurs[i]})
    a = {'video': f'out/{NAME}/{NAME}.mp4', 'duration': round(dur(pilot / f'{NAME}.mp4'), 2),
         'content_offset': round(max(0.0, dur(build / 'intro_title_crossfaded.mp4') - 0.65), 3), 'slides': planned,
         'intro': True, 'title_card': True, 'support_card': True, 'outro': True, 'fx': True}
    (pilot / 'assembly.json').write_text(json.dumps(a, indent=1))
    rb = rebaseline.run_rebaseline(root / 'repo', NAME, root / 'rebaseline')
    assert rb['ok'], json.dumps(rb['checks'], default=str)[:3000]
    return {'assembly': a, 'build': build, 'rebaseline': root / 'rebaseline', 'script': root / 'src' / 'base.script.json', 'rec': rec,
            'music': music, 'takes': takes, 'media': media}


_SHARED = {}


def setUpModule():
    pass


def tearDownModule():
    if 'temp' in _SHARED:
        _SHARED.pop('temp').cleanup()


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if 'fx' not in _SHARED:  # built once per module run, shared read-only by every class
            _SHARED['temp'] = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
            _SHARED['root'] = Path(_SHARED['temp'].name)
            _SHARED['fx'] = build_fixture(_SHARED['root'])
        cls.root = _SHARED['root']
        cls.fx = _SHARED['fx']
        cls.mhash = ar.sha256_file(cls.fx['rebaseline'] / 'baseline-manifest.json')
        cls.base = json.loads(cls.fx['script'].read_text())

    @classmethod
    def manifest(cls, changes, mhash=None):
        p = cls.root / f'changes-{uuid.uuid4().hex}.json'
        p.write_text(json.dumps({'baselineManifestHash': mhash or cls.mhash, 'changes': changes}, indent=2))
        return p

    @classmethod
    def shot(cls, i, banner=True, tag=None):
        p = cls.root / f'shot-{i}-{tag or uuid.uuid4().hex}.png'
        chain_capture(i, banner=banner).save(p)
        return {'path': str(p), 'sha256': ar.sha256_file(p)}

    @classmethod
    def take(cls, seconds, seed):
        p = noise_take(cls.root / f'new-take-{uuid.uuid4().hex}.mp3', seed, seconds)
        return {'path': str(p), 'sha256': ar.sha256_file(p), 'source': 'synthetic noise stand-in (test only)'}

    @classmethod
    def narration(cls, i, new, seconds=None, seed=40, **kw):
        n = {'oldText': f'line {i}', 'newText': new, **kw}
        if seconds is not None:
            n['take'] = cls.take(seconds, seed)
        return n

    @classmethod
    def run_update(cls, tag, changes, **kw):
        return du.run(cls.fx['rebaseline'], cls.fx['script'], cls.fx['rec'], cls.manifest(changes), cls.fx['build'], cls.root / f'out-{tag}',
                      music=cls.fx['music'], **kw)


class Planning(Fixture):
    """Scope union, multi-run, same-step combo and edge narration, planned (dry run: nothing rendered)."""

    def _plan(self, tag, changes):
        r = self.run_update(tag, changes, dry_run=True)
        self.assertTrue(r['dry_run'])
        self.assertEqual(list((self.root / f'out-{tag}').rglob('*.mp4')), [], 'dry run renders nothing')
        return r['plan']

    def test_multi_run_visual_plus_last_slide_narration(self):
        p = self._plan('p-multi', [{'stepId': 'step-0', 'screenshot': self.shot(0)},
                                   {'stepId': 'step-3', 'narration': self.narration(3, 'a much longer last line', 1.4)}])
        self.assertEqual(p['dirty_slides'], ['slide-01', 'slide-04'])
        self.assertEqual(p['dirty_runs'], [['slide-01'], ['slide-04']])
        self.assertEqual(p['rendered_cells'], ['lead-dissolve', 'hold-01', 'dissolve-01-02', 'dissolve-03-04', 'hold-04', 'tail-dissolve'])
        self.assertEqual(p['reused_cells'], ['lead-card', 'hold-02', 'dissolve-02-03', 'hold-03', 'tail-card'])
        self.assertGreater(p['shift_frames'], 0)
        self.assertEqual(p['edges'], {'lead': True, 'tail': True})

    def test_same_step_visual_and_shorter_narration_replans_screen(self):
        p = self._plan('p-same', [{'stepId': 'step-1', 'screenshot': self.shot(1), 'narration': self.narration(1, 'short', 0.12)}])
        self.assertEqual(p['dirty_slides'], ['slide-01', 'slide-02'])
        self.assertIn('_fx', p['reasons']['slide-01'])
        self.assertEqual(set(p['reasons']['slide-02'][:1]), {'changed_step'})
        self.assertLess(p['shift_frames'], 0)
        self.assertEqual(p['reused_cells'], ['lead-card', 'hold-03', 'dissolve-03-04', 'hold-04', 'tail-dissolve', 'tail-card'])

    def test_first_slide_narration_with_same_screen_follower(self):
        p = self._plan('p-first', [{'stepId': 'step-0', 'narration': self.narration(0, 'a much longer first line', 1.2)}])
        self.assertEqual(p['dirty_slides'], ['slide-01', 'slide-02'])
        self.assertIn('_fx', p['reasons']['slide-02'])
        self.assertTrue(p['edges']['lead'])
        self.assertGreater(p['shift_frames'], 0)

    def test_two_narration_changes_shift_accumulates(self):
        p = self._plan('p-two', [{'stepId': 'step-2', 'narration': self.narration(2, 'longer middle line', 1.0, seed=41)},
                                 {'stepId': 'step-3', 'narration': self.narration(3, 'longer last line', 0.9, seed=42)}])
        self.assertEqual(p['dirty_runs'], [['slide-03', 'slide-04']])
        self.assertEqual(p['shift_frames'], sum(q['shift_frames'] for q in p['quantize'].values()))
        self.assertTrue(p['card_phase']['ok'], p['card_phase'])

    def test_card_phase_rule_and_padding(self):
        """assemble's '%.3f' crossfade offsets: some whole-frame shifts move a card start by one EXTRA frame; the planner
        must pad the re-timed slide until every chain boundary shifts by exactly the same amount."""
        build = drift_render.load_build(self.fx['build'], self.fx['assembly'])
        base = [s['sdur'] for s in self.fx['assembly']['slides']]

        def trial(k):
            s = list(base)
            s[-1] = round(base[-1] + k / 30, 3)
            return s
        oks = {k: du.card_phase(build, base, trial(k), k)['ok'] for k in range(0, 7)}
        self.assertTrue(oks[0])
        self.assertIn(False, oks.values(), oks)
        # exact-length WAV takes: quantized shift k = j for j = 1..6, so every residue is hit; bad ones must be padded
        old_adur = self.fx['assembly']['slides'][3]['adur']
        pads = []
        for j in range(1, 7):
            seconds = old_adur + j / 30 - 0.01
            wav = self.root / f'phase-take-{j}-{uuid.uuid4().hex[:6]}.wav'
            fx_draw.sh('ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', f'anoisesrc=c=pink:seed=5:a=0.3:r=48000', '-t', f'{seconds:.6f}',
                       '-ac', '1', '-c:a', 'pcm_s16le', wav)
            take = {'path': str(wav), 'sha256': ar.sha256_file(wav), 'source': 'exact-length wav (test only)'}
            p = self._plan(f'p-phase-{j}', [{'stepId': 'step-3', 'narration': {'oldText': 'line 3', 'newText': f'phase {j}', 'take': take}}])
            self.assertTrue(p['card_phase']['ok'], p['card_phase'])
            q = p['quantize']['slide-04']
            self.assertIn(q['card_phase_padding_frames'], (0, 1, 2))
            self.assertEqual(q['shift_frames'] - q['card_phase_padding_frames'], j)
            self.assertEqual(q['card_phase_padding_frames'] == 0, oks[j], (j, q, oks))
            self.assertLessEqual(q['extra_pause_s'], 3 / 30 + 1e-6)
            pads.append(q['card_phase_padding_frames'])
        self.assertTrue(any(pads), pads)


class Rejections(Fixture):
    def _rejected(self, tag, changes, mhash=None, **kw):
        out = self.root / f'rej-{tag}'
        with self.assertRaises(du.UpdateRejected) as cm:
            du.run(self.fx['rebaseline'], self.fx['script'], self.fx['rec'], self.manifest(changes, mhash), self.fx['build'], out,
                   music=self.fx['music'], **kw)
        self.assertEqual(list(out.rglob('*.mp4')) if out.exists() else [], [], 'nothing may be rendered before a rejection')
        return cm.exception.code

    def test_reason_codes(self):
        n1 = self.narration(1, 'new words', 0.6)
        self.assertEqual(self._rejected('bind', [{'stepId': 'step-1', 'narration': n1}], mhash='f' * 64), 'baseline_manifest_conflict')
        self.assertEqual(self._rejected('unknown', [{'stepId': 'step-9', 'narration': n1}]), 'unknown_step')
        self.assertEqual(self._rejected('dup', [{'stepId': 'step-1', 'narration': n1}, {'stepId': 'step-1', 'screenshot': self.shot(1)}]),
                         'duplicate_change')
        self.assertEqual(self._rejected('empty', [{'stepId': 'step-1'}]), 'empty_change')
        self.assertEqual(self._rejected('field', [{'stepId': 'step-1', 'route': '/x'}]), 'invalid_change_manifest')
        self.assertEqual(self._rejected('old', [{'stepId': 'step-1', 'narration': {**n1, 'oldText': 'not said'}}]), 'old_text_mismatch')
        self.assertEqual(self._rejected('shot', [{'stepId': 'step-1', 'screenshot': {**self.shot(1), 'sha256': '0' * 64}}]),
                         'screenshot_hash_mismatch')
        self.assertEqual(self._rejected('take', [{'stepId': 'step-1', 'narration': {**n1, 'take': {**n1['take'], 'sha256': '0' * 64}}}]),
                         'take_hash_mismatch')
        self.assertEqual(self._rejected('caponly', [{'stepId': 'step-1', 'narration': {'oldText': 'line 1', 'newText': 'line 1',
                                                                                         'newCaption': 'other caption'}}]),
                         'unsupported_caption_only_change')
        self.assertEqual(self._rejected('removal', [{'stepId': 'step-1', 'narration': {'oldText': 'line 1', 'newText': '  '}}]),
                         'unsupported_narration_removal')
        self.assertEqual(self._rejected('needtake', [{'stepId': 'step-1', 'narration': {'oldText': 'line 1', 'newText': 'x y z'}}]),
                         'take_required')
        sem = json.loads(json.dumps(self.base['steps'][1]['target']))
        sem['css'] = 'button.other'
        self.assertEqual(self._rejected('semantics', [{'stepId': 'step-1', 'target': sem}]), 'unsupported_target_semantics_change')

    def test_provider_voice_unavailable_fails_closed(self):
        def provider(text, voice, dest, tag):
            raise tp.TakeRejected('voice_unavailable', {'reason': 'provider_not_elevenlabs', 'provider': 'edge'})
        self.assertEqual(self._rejected('voice', [{'stepId': 'step-2', 'narration': {'oldText': 'line 2', 'newText': 'new line'}}],
                                        take_provider=provider), 'voice_unavailable')

    def test_never_imports_assemble_or_tts(self):
        self.assertNotIn('renderer.assemble', sys.modules)
        self.assertNotIn('renderer.tts', sys.modules)


class EndToEnd(Fixture):
    """Full renders: multi-run (first-slide screenshot + last-slide longer narration), same-step combo, golden re-apply, no-op."""

    def test_noop_returns_baseline_artifact(self):
        r = self.run_update('noop', [])
        m = json.loads((self.fx['rebaseline'] / 'baseline-manifest.json').read_text())
        self.assertTrue(r['ok'] and r['noop'])
        self.assertEqual(r['candidate_sha256'], m['final']['sha256'])
        self.assertEqual(Path(r['candidate']).resolve(), (self.fx['rebaseline'] / m['final']['file']).resolve())
        self.assertEqual(list((self.root / 'out-noop').rglob('*.mp4')), [])

    def _common(self, r):
        c = r['checks']
        self.assertTrue(r['ok'], json.dumps({k: r.get(k) for k in ('checks', 'audio', 'golden')}, default=str)[:5000])
        self.assertTrue(r['source_unchanged'])
        self.assertTrue(c['reused_cells_byte_identical'] and c['reused_frames_equal_at_shifted_positions'])
        self.assertTrue(c['timestamps_contiguous'] and c['keyframes_at_cell_starts'] and c['decodable'])
        self.assertTrue(r['golden']['replan']['equal'] and r['golden']['chain']['decoded_frames_equal'])
        self.assertTrue(all(r['golden']['control_cells_byte_identical_to_rebaseline'].values()), r['golden'])
        self.assertTrue(Path(r['contact_sheet']).is_file())

    def test_multi_run_screenshot_and_last_slide_narration(self):
        r = self.run_update('multi', [{'stepId': 'step-0', 'screenshot': self.shot(0)},
                                      {'stepId': 'step-3', 'narration': self.narration(3, 'a much longer last line', 1.4, seed=51)}])
        self._common(r)
        self.assertEqual(r['plan']['dirty_runs'], [['slide-01'], ['slide-04']])
        a = r['audio']
        self.assertTrue(a['golden']['packets_equal'] and a['chain_audio_equals_soundtrack'] and a['candidate_audio_stream_copied'])
        self.assertTrue(a['takes_at_expected_offsets'] and a['av_sync_preserved'] and a['unchanged_takes_reused_byte_for_byte'], a['takes'])
        self.assertEqual(r['checks']['frames_total'], r['checks']['expected_frames'])
        self.assertTrue(r['checks']['captions']['changed_caption_pngs_match_new_text'])

    def test_same_step_banner_and_shorter_narration(self):
        r = self.run_update('same', [{'stepId': 'step-1', 'screenshot': self.shot(1), 'narration': self.narration(1, 'short', 0.12, seed=52)}])
        self._common(r)
        self.assertLess(r['plan']['shift_frames'], 0)
        self.assertEqual(r['plan']['dirty_slides'], ['slide-01', 'slide-02'])
        self.assertTrue(r['audio']['takes_at_expected_offsets'] and r['audio']['av_sync_preserved'], r['audio']['takes'])

    def test_visual_only_two_runs_keeps_audio_bit_identical(self):
        r = self.run_update('visual', [{'stepId': 'step-0', 'screenshot': self.shot(0)}, {'stepId': 'step-3', 'screenshot': self.shot(3)}])
        self._common(r)
        p = r['checks']['preservation']
        self.assertTrue(p['protected_frames_equal'] and p['complete_audio_equal'] and p['audio_packets_and_timing_equal'])
        self.assertTrue(r['checks']['changed_frames_inside_dirty'])
        self.assertEqual(r['plan']['dirty_runs'], [['slide-01'], ['slide-04']])

    def test_golden_reapply_is_identical(self):
        rec = self.fx['rec']
        orig0 = rec / self.base['steps'][0]['media']['pre']
        t2 = Path(self.fx['assembly']['slides'][2]['audio'])
        r = self.run_update('reapply', [
            {'stepId': 'step-0', 'screenshot': {'path': str(orig0), 'sha256': ar.sha256_file(orig0)}},
            {'stepId': 'step-1', 'target': self.base['steps'][1]['target']},
            {'stepId': 'step-2', 'narration': {'oldText': 'line 2', 'newText': 'line 2', 'take': {'path': str(t2), 'sha256': ar.sha256_file(t2)}}}])
        self._common(r)
        g = r['golden_reapply']
        self.assertTrue(g['is_reapply'])
        self.assertEqual(r['plan']['shift_frames'], 0)
        self.assertTrue(g['within_tolerance'], g)
        self.assertTrue(g['audio_packets_equal_baseline'], g)
        self.assertEqual(g['frames_differing_from_baseline'], 0, g)


REAL_REBASELINE = os.environ.get('HADRIUS_PILOT_REBASELINE_DIR',
                                 '/Users/stephenskalamera/.hermes/cache/scratch/fx-rebaseline-20261028-112610/pilot-rebaseline')


@unittest.skipUnless(os.environ.get('HADRIUS_REAL_PILOT_DRIFT_UPDATE') == '1', 'opt-in real pilot (read-only; ElevenLabs takes)')
class RealPilotDriftUpdate(unittest.TestCase):
    def _case(self, case):
        out = Path(os.environ['TMPDIR']) / f'drift-update-real-test-{case}-{os.getpid()}'
        r = du.real_pilot(REAL_REBASELINE, out, case=case)
        self.assertTrue(r['source_unchanged'])
        self.assertTrue(r['ok'], json.dumps(r, default=str)[:4000])
        return r

    def test_a_two_changes_real_take(self):
        r = self._case('a')
        self.assertEqual(r['plan']['dirty_runs'], [['slide-01'], ['slide-03']])
        self.assertGreater(r['plan']['shift_frames'], 0)

    def test_b_same_step_visual_and_narration(self):
        r = self._case('b')
        self.assertLess(r['plan']['shift_frames'], 0)

    def test_golden_reapply(self):
        r = self._case('golden')
        self.assertTrue(r['golden_reapply']['within_tolerance'])


if __name__ == '__main__':
    unittest.main()
