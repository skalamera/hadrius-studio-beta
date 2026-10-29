"""renderer.drift_render: single-slide FX donor through assemble's frozen drawing code, spliced into a
rebaseline and verified by renderer.preservation. Synthetic fixture always; the real pilot is opt-in
(HADRIUS_REAL_PILOT_DRIFT_RENDER=1, read-only on the repo, about 3-4 minutes)."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from renderer import drift_render, fx_draw, rebaseline
from tests.renderer.test_fx_scope import synthetic_assembly

REPO = Path(__file__).resolve().parents[2]
NAME = 'Synthetic-Drift'
ROUTES = ['/a', '/a', '/b']
TARGETS = [{'x': 200, 'y': 200, 'width': 300, 'height': 120}, {'x': 300, 'y': 260, 'width': 320, 'height': 110}, None]


def capture(i, banner=False, size=(1600, 900), invert=False):
    im = Image.new('RGB', size, (245, 246, 250) if i < 2 else (230, 240, 255))
    d = ImageDraw.Draw(im)
    for r in range(8):
        d.rectangle([100, 120 + r * 90, 1500, 180 + r * 90], fill=(220, 222, 230), outline=(180, 180, 190))
        d.text((120, 140 + r * 90), f'row {r} screen {"A" if i < 2 else "B"}', fill=(40, 40, 60))
    if banner:
        d.rectangle([900, 560, 1300, 630], fill=(196, 30, 58))
        d.text((920, 585), 'NEW synthetic label', fill='white')
    if invert:
        from PIL import ImageOps
        im = ImageOps.invert(im)
    return im


def build_fixture(root):
    """Synthetic repo-like layout: FX assembly + baseline MP4 -> rebaseline; stable-ID script + captures."""
    a = synthetic_assembly([2.0, 1.9, 2.0], screens=[2, 1])
    n = 210
    a['duration'] = round(n / 30, 2)
    for i, s in enumerate(a['slides']):
        s.update({'narration': f'line {i}', 'caption': f'line {i}', '_cap_text': f'line {i}', 'route': ROUTES[i],
                  'action': 'click' if i == 1 else 'navigate', 'target': TARGETS[i], '_cap_edges': [i > 0, i < 2],
                  'src': f'step_{i:012x}.png'})
    a['slides'][0]['_fx']['move'] = [0.2, 1.0]
    d = root / 'repo' / 'out' / NAME
    d.mkdir(parents=True)
    (d / 'assembly.json').write_text(json.dumps(a, indent=1))
    subprocess.check_call(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
                           '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=6.5', '-frames:v', str(n),
                           '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
                           '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', str(d / f'{NAME}.mp4')])
    rb = rebaseline.run_rebaseline(root / 'repo', NAME, root / 'rebaseline')
    assert rb['ok'], rb
    rec = root / 'src' / '_recordings' / 'rec-synth'
    rec.mkdir(parents=True)
    steps = []
    for i, s in enumerate(a['slides']):
        capture(i).save(rec / s['src'])
        t = TARGETS[i]
        st = {'id': f'step-{i}', 'index': i, 'media': {'pre': s['src']}, 'route': ROUTES[i], 'action': s['action'], 'capture': True,
              'narration': f'line {i}', 'caption': f'line {i}'}
        if t:
            st['target'] = {'css': 'a', 'hint': {'bbox': {'x': t['x'], 'y': t['y'], 'w': t['width'], 'h': t['height']},
                                                 'viewport': {'w': 1600, 'h': 900}}}
        steps.append(st)
    script = {'id': 'synthetic-script', 'name': NAME, 'fx': True, 'recording': {'id': 'rec-synth'}, 'steps': steps,
              'captionsFromNarration': False}
    (root / 'src' / 'base.script.json').write_text(json.dumps(script, indent=2))
    return a, n


class SyntheticDriftRender(unittest.TestCase):
    """Frozen-plan path without build sources (lossless sub-chain): interior screenshot-only changes; replan/edge
    requests that need what is not provided are rejected before rendering."""
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.assembly, cls.n = build_fixture(cls.root)
        cls.base = cls.root / 'src' / 'base.script.json'
        cls.rec_root = cls.root / 'src' / '_recordings'
        cls.rdir = cls.root / 'rebaseline'
        new = cls.root / 'src' / 'new.png'
        capture(1, banner=True).save(new)
        cls.cand = drift_render.make_candidate(cls.base, cls.rec_root, 'step-1', new, cls.root / 'candidate')
        cls.report = drift_render.run(cls.rdir, cls.cand, 'step-1', cls.root / 'drift')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_end_to_end_preserves_protected_media(self):
        r = self.report
        self.assertTrue(r['ok'], json.dumps(r['checks'], default=str)[:2000])
        p = r['checks']['preservation']
        self.assertTrue(p['protected_frames_equal'] and p['complete_audio_equal'] and p['audio_packets_and_timing_equal'])
        self.assertEqual(r['checks']['replaced_cells'], ['dissolve-01-02', 'dissolve-02-03', 'hold-02'])
        self.assertEqual(sorted(r['checks']['reused_cells']), ['hold-01', 'hold-03', 'lead-card', 'lead-dissolve', 'tail-card', 'tail-dissolve'])
        self.assertTrue(r['checks']['all_reused_byte_identical'])
        self.assertTrue(r['checks']['changed_frames_inside_dirty'])
        self.assertGreater(r['checks']['frames_changed'], 0)
        self.assertEqual(r['checks']['step_mapping'], {'step-1': 'slide-02'})
        self.assertEqual(r['donor']['mode'], 'lossless_subchain')

    def test_donor_records_frozen_source(self):
        d = self.report['donor']
        self.assertEqual(d['assemble_sha256'], fx_draw.sha256_file(fx_draw.ASSEMBLE))
        self.assertEqual(set(d['assemble_source_hashes']), set(fx_draw.FUNCTIONS))
        self.assertEqual(d['font_layout'], 'basic')
        self.assertTrue(Path(d['kb_still']).is_file())

    def _rejected(self, tag, image, target=None, **kw):
        cand = drift_render.make_candidate(self.base, self.rec_root, 'step-1', image, self.root / f'cand-{tag}', target=target)
        with self.assertRaises(drift_render.DonorRejected) as cm:
            drift_render.run(self.rdir, cand, 'step-1', self.root / f'out-{tag}', **kw)
        self.assertEqual(list((self.root / f'out-{tag}').rglob('*.mp4')), [], 'nothing may be rendered before rejection')
        return cm.exception

    def test_replan_disabled_keeps_explicit_rejections(self):
        base = json.loads(self.base.read_text())
        t = json.loads(json.dumps(base['steps'][1]['target']))
        t['hint']['bbox']['x'] += 150
        img = self.root / 'src' / 'moved.png'
        capture(1, banner=True).save(img)
        self.assertEqual(self._rejected('moved', img, t, allow_replan=False).code, 'scope_expansion_required:target_geometry_changed')
        small = self.root / 'src' / 'small.png'
        capture(1).resize((1440, 900)).save(small)
        self.assertEqual(self._rejected('small', small, allow_replan=False).code, 'scope_expansion_required:screenshot_size_changed')
        inv = self.root / 'src' / 'inverted.png'
        capture(1, invert=True).save(inv)
        self.assertEqual(self._rejected('inverted', inv, allow_replan=False).code, 'scope_expansion_required:screen_grouping_changed')

    def test_replan_against_a_non_planner_baseline_fails_closed(self):
        # this fixture's persisted _fx is hand-written, so re-planning the UNCHANGED script cannot reproduce it
        base = json.loads(self.base.read_text())
        t = json.loads(json.dumps(base['steps'][1]['target']))
        t['hint']['bbox']['y'] += 120
        img = self.root / 'src' / 'moved2.png'
        capture(1).save(img)
        e = self._rejected('golden', img, t)
        self.assertEqual(e.code, 'replan_golden_mismatch')

    def test_edge_slide_needs_card_sources(self):
        img = self.root / 'src' / 'edge.png'
        capture(0, banner=True).save(img)
        cand = drift_render.make_candidate(self.base, self.rec_root, 'step-0', img, self.root / 'cand-edge')
        with self.assertRaises(drift_render.DonorRejected) as cm:
            drift_render.run(self.rdir, cand, 'step-0', self.root / 'out-edge')
        self.assertEqual(cm.exception.code, 'unsupported_edge_slide')
        self.assertEqual(list((self.root / 'out-edge').rglob('*.mp4')), [])

    def test_cli_rejects_wrong_step(self):
        code = drift_render.main(['--rebaseline-dir', str(self.rdir), '--candidate-dir', str(self.cand), '--slide-step-id', 'step-2',
                                  '--output', str(self.root / 'cli-wrong')])
        self.assertNotEqual(code, 0)


# ---------- self-consistent fixture: planned by assemble's planner, built by assemble's own chain ----------

CHAIN_TARGETS = [None, {'x': 300, 'y': 260, 'width': 320, 'height': 110}, None]
CHAIN_SDURS = [2.0, 1.9, 2.0]


def chain_capture(i, banner=False, size=(1600, 900), invert=False):
    im = capture(i, banner=banner, size=size, invert=invert)
    ImageDraw.Draw(im).text((40, 40 + 30 * i), f'capture {i}', fill=(10, 10, 10))  # consecutive captures never byte-identical
    return im


def build_chain_fixture(root):
    """Captures -> fx_draw planner -> fx_draw segments -> assemble's xfade stitch + card crossfades (the exact commands
    drift_render's chain uses, here WITH audio) -> final MP4 + assembly.json -> rebaseline. A control re-render is
    therefore decode-identical by construction, so the chain golden is meaningful."""
    rec = root / 'src' / '_recordings' / 'rec-chain'
    rec.mkdir(parents=True)
    steps, srcs = [], []
    for i in range(3):
        name = f'step_{i:012x}.png'
        chain_capture(i).save(rec / name)
        srcs.append(name)
        t = CHAIN_TARGETS[i]
        st = {'id': f'step-{i}', 'index': i, 'media': {'pre': name}, 'route': ROUTES[i], 'action': 'click' if i == 1 else 'navigate',
              'capture': True, 'narration': f'line {i}', 'caption': f'line {i}'}
        if t:
            st['target'] = {'css': 'a', 'hint': {'bbox': {'x': t['x'], 'y': t['y'], 'w': t['width'], 'h': t['height']},
                                                 'viewport': {'w': 1600, 'h': 900}}}
        steps.append(st)
    script = {'id': 'chain-script', 'name': NAME, 'fx': True, 'recording': {'id': 'rec-chain'}, 'steps': steps, 'captionsFromNarration': False}
    (root / 'src' / 'base.script.json').write_text(json.dumps(script, indent=2))
    pilot = root / 'repo' / 'out' / NAME
    build = pilot / '_build'
    (pilot / 'slides').mkdir(parents=True)
    pre = [fx_draw.from_recording_slide(st, i + 1, (1600, 900), False) for i, st in enumerate(steps)]
    for s, sd in zip(pre, CHAIN_SDURS):
        s['sdur'] = sd
        shutil.copyfile(rec / s['src'], pilot / 'slides' / s['file'])
    planner = fx_draw.load_planner(out_dir=pilot, tmp_dir=build, needs_drawn_highlight=True)
    planned, _ = planner.replan(pre)
    t = 0.0
    for k, s in enumerate(planned):
        s['start'] = round(t, 3)
        t += s['sdur'] - (0.8 if k < 2 else 0)
    total = t
    d = fx_draw.load(out_dir=pilot, tmp_dir=build, needs_drawn_highlight=True)
    for s in planned:
        fx_draw.render_segment(d, fx_draw.frozen_slide(s), build / f"seg{s['slide']:02d}.mp4")
    sh = fx_draw.sh
    sh(*fx_draw.xfade_command([build / f'seg0{i}.mp4' for i in (1, 2, 3)], CHAIN_SDURS, build / 'video.mp4', 0.8, 30, d.ns['INTERMEDIATE_ENCODE']))
    sh('ffmpeg', '-y', '-v', 'error', '-i', build / 'video.mp4', '-f', 'lavfi', '-i', f'sine=frequency=330:sample_rate=48000:duration={total:.3f}',
       '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', f'{total:.3f}', build / 'content.mp4')
    def card(name, color, seconds):
        sh('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f'color={color}:s=1920x1080:r=30:d={seconds}', '-f', 'lavfi', '-i',
           'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-t', str(seconds), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
           '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', build / name)
    card('intro_title_crossfaded.mp4', '0x203060', 1.7)
    card('support_card.mp4', '0x305020', 2.0)
    card('logo_card.mp4', 'white', 1.5)
    dur = drift_render.media_duration
    def xf(c1, c2, outp, x, inter):
        enc = d.ns['INTERMEDIATE_ENCODE'] if inter else drift_render.CROSSFADE_FINAL_ENCODE
        sh(*drift_render.crossfade_command(c1, c2, outp, x, max(0.05, dur(c1) - x), enc, audio=True))
    xf(build / 'intro_title_crossfaded.mp4', build / 'content.mp4', build / 'body_crossfaded.mp4', 0.65, True)
    xf(build / 'body_crossfaded.mp4', build / 'support_card.mp4', build / 'body_with_support.mp4', 0.65, True)
    xf(build / 'body_with_support.mp4', build / 'logo_card.mp4', pilot / f'{NAME}.mp4', 0.8, False)
    for s, src in zip(planned, srcs):
        s.update({'step': srcs.index(src), 'src': src})
    a = {'video': f'out/{NAME}/{NAME}.mp4', 'duration': round(dur(pilot / f'{NAME}.mp4'), 2),
         'content_offset': round(max(0.0, dur(build / 'intro_title_crossfaded.mp4') - 0.65), 3), 'slides': planned,
         'intro': True, 'title_card': True, 'support_card': True, 'outro': True, 'fx': True}
    (pilot / 'assembly.json').write_text(json.dumps(a, indent=1))
    rb = rebaseline.run_rebaseline(root / 'repo', NAME, root / 'rebaseline')
    assert rb['ok'], json.dumps(rb['checks'], default=str)[:3000]
    return a, build


class SyntheticChainDriftRender(unittest.TestCase):
    """Re-plan (moved highlight, other size, regrouped screen) and first/last slides through assemble's own chain."""
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        cls.root = Path(cls.temp.name)
        cls.assembly, cls.build = build_chain_fixture(cls.root)
        cls.base = cls.root / 'src' / 'base.script.json'
        cls.rec_root = cls.root / 'src' / '_recordings'
        cls.rdir = cls.root / 'rebaseline'

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def _run(self, tag, step, image, target=None, **kw):
        cand = drift_render.make_candidate(self.base, self.rec_root, step, image, self.root / f'cand-{tag}', target=target)
        return drift_render.run(self.rdir, cand, step, self.root / f'out-{tag}', build_dir=self.build, **kw)

    def _ok(self, r, replaced, reused):
        self.assertTrue(r['ok'], json.dumps({k: v for k, v in r['checks'].items() if k != 'preservation'}, default=str)[:3000])
        p = r['checks']['preservation']
        self.assertTrue(p['protected_frames_equal'] and p['complete_audio_equal'] and p['audio_packets_and_timing_equal'])
        self.assertEqual(r['checks']['replaced_cells'], sorted(replaced))
        self.assertEqual(sorted(r['checks']['reused_cells']), sorted(reused))
        self.assertTrue(r['checks']['all_reused_byte_identical'] and r['checks']['changed_frames_inside_dirty'])
        self.assertGreater(r['checks']['frames_changed'], 0)
        self.assertEqual(r['donor']['mode'], 'assemble_chain')
        self.assertTrue(r['donor']['chain_golden']['decoded_frames_equal'])
        return r

    def test_moved_highlight_replans_screen_including_first_slide(self):
        base = json.loads(self.base.read_text())
        t = json.loads(json.dumps(base['steps'][1]['target']))
        t['hint']['bbox']['y'] += 330
        img = self.root / 'src' / 'moved.png'
        shutil.copyfile(self.rec_root / 'rec-chain' / base['steps'][1]['media']['pre'], img)
        r = self._ok(self._run('moved', 'step-1', img, t),
                     ['lead-dissolve', 'hold-01', 'dissolve-01-02', 'hold-02', 'dissolve-02-03'], ['lead-card', 'hold-03', 'tail-dissolve', 'tail-card'])
        rp = r['donor']['replan']
        self.assertTrue(rp['golden_equal'])
        self.assertEqual(rp['dirty_slides'], ['slide-01', 'slide-02'])
        self.assertIn('_fx', rp['reasons']['slide-01'])
        self.assertFalse(rp['screen_grouping_changed'])

    def test_first_slide_screenshot(self):
        img = self.root / 'src' / 'first.png'
        chain_capture(0, banner=True).save(img)
        self._ok(self._run('first', 'step-0', img), ['lead-dissolve', 'hold-01', 'dissolve-01-02'],
                 ['lead-card', 'hold-02', 'dissolve-02-03', 'hold-03', 'tail-dissolve', 'tail-card'])

    def test_last_slide_screenshot(self):
        img = self.root / 'src' / 'last.png'
        chain_capture(2, banner=True).save(img)
        r = self._ok(self._run('last', 'step-2', img), ['dissolve-02-03', 'hold-03', 'tail-dissolve'],
                     ['lead-card', 'lead-dissolve', 'hold-01', 'dissolve-01-02', 'hold-02', 'tail-card'])
        self.assertTrue(all(v for v in r['donor']['control_cells_byte_identical_to_rebaseline'].values()), r['donor']['control_cells_byte_identical_to_rebaseline'])

    def test_regrouped_screen_expands_scope(self):
        img = self.root / 'src' / 'inverted.png'
        chain_capture(1, invert=True).save(img)
        r = self._run('regroup', 'step-1', img)
        self.assertTrue(r['donor']['replan']['screen_grouping_changed'])
        self.assertIn('slide-01', r['donor']['replan']['dirty_slides'])
        self.assertTrue(r['ok'] and r['checks']['preservation']['protected_frames_equal'])

    def test_other_size_screenshot_replans_within_screen(self):
        img = self.root / 'src' / 'small.png'
        chain_capture(1).resize((1440, 900)).save(img)
        r = self._run('small', 'step-1', img)
        self.assertTrue(r['ok'] and r['checks']['preservation']['protected_frames_equal'])
        self.assertEqual(r['donor']['replan']['changed_slide_png_size'], [1440, 900])
        self.assertEqual(r['donor']['replan']['changed_slide_viewport'], {'width': 1600, 'height': 900})

    def test_build_dir_must_be_the_baselines_source(self):
        other = self.root / 'other-build'
        shutil.copytree(self.build, other)
        (other.parent / f'{NAME}.mp4').write_bytes(b'not the baseline')
        img = self.root / 'src' / 'first2.png'
        chain_capture(0, banner=True).save(img)
        cand = drift_render.make_candidate(self.base, self.rec_root, 'step-0', img, self.root / 'cand-bind')
        with self.assertRaises(drift_render.DonorRejected) as cm:
            drift_render.run(self.rdir, cand, 'step-0', self.root / 'out-bind', build_dir=other)
        self.assertEqual(cm.exception.code, 'build_dir_not_baseline_source')


@unittest.skipUnless(os.environ.get('HADRIUS_REAL_PILOT_DRIFT_RENDER') == '1', 'opt-in: HADRIUS_REAL_PILOT_DRIFT_RENDER=1')
class RealPilotDriftRender(unittest.TestCase):
    def test_real_pilot_end_to_end(self):
        rb = os.environ.get('HADRIUS_PILOT_REBASELINE_DIR')
        temp = Path(tempfile.mkdtemp(prefix='drift-real-', dir=os.environ['TMPDIR']))
        if not rb:
            rb = temp / 'rebaseline'
            self.assertTrue(rebaseline.run_rebaseline(REPO, 'How-to-Find-a-Project-ID', rb)['ok'])
        r = drift_render.real_pilot_end_to_end(rb, temp / 'e2e')
        self.assertTrue(r['source_unchanged'])
        self.assertEqual(r['protected_frame_count'], 662)
        self.assertEqual(r['dirty_frames'], [[313, 461]])
        self.assertTrue(r['protected_frames_equal'] and r['complete_audio_equal'] and r['changed_frames_inside_dirty'])
        self.assertTrue(r['label_visible_only_in_banner'], r['label'])
        self.assertTrue(r['negatives_ok'], r['negatives'])
        self.assertTrue(r['ok'])

    def test_real_pilot_moved_highlight_and_edge_slides(self):
        rb = os.environ.get('HADRIUS_PILOT_REBASELINE_DIR')
        temp = Path(tempfile.mkdtemp(prefix='drift-real-edge-', dir=os.environ['TMPDIR']))
        if not rb:
            rb = temp / 'rebaseline'
            self.assertTrue(rebaseline.run_rebaseline(REPO, 'How-to-Find-a-Project-ID', rb)['ok'])
        r = drift_render.real_pilot_replan_and_edges(rb, temp / 'e2e')
        self.assertTrue(r['source_unchanged'])
        self.assertTrue(r['card_chain_golden']['final_sha256_equal'], r['card_chain_golden'])
        expect = {'moved_highlight': [[162, 461]], 'first_slide': [[162, 339]], 'last_slide': [[435, 611]]}
        for tag, dirty in expect.items():
            c = r['cases'][tag]
            self.assertTrue(c['ok'], (tag, c))
            self.assertEqual(c['dirty_frames'], dirty, tag)
            self.assertTrue(c['protected_frames_equal'] and c['complete_audio_equal'] and c['changed_frames_inside_dirty'], tag)
            self.assertTrue(c['control_cells_byte_identical_to_rebaseline'], (tag, c['control_cells']))
        self.assertTrue(r['cases']['moved_highlight']['highlight_moved']['ok'], r['cases']['moved_highlight']['highlight_moved'])
        self.assertTrue(r['ok'])


if __name__ == '__main__':
    unittest.main()
