import copy
import json
import math
import subprocess
import unittest
from pathlib import Path

from renderer import fx_scope
from renderer.fx_scope import closure, timeline

FPS, XF = 30, 0.8
REPO = Path(__file__).resolve().parents[2]
PILOT = REPO / 'out' / 'How-to-Find-a-Project-ID'


def synthetic_assembly(sdurs, screens, content_offset=1.017, title=True, support=True, outro=True, captions=None):
    """An assembly.json-like dict whose persisted _fx follows fx_plan's rules."""
    starts, t = [], 0.0
    for i, d in enumerate(sdurs):
        starts.append(round(t, 3))
        t += d - (XF if i < len(sdurs) - 1 else 0)
    frames = [math.ceil(round(s, 3) * FPS - 1e-6) for s in starts]
    slides = []
    for i, d in enumerate(sdurs):
        cap = (captions or [f'caption {i}' for i in range(len(sdurs))])[i]
        slides.append({'slide': i + 1, 'step': i, 'src': f'step_{i:012x}.png', 'file': f'slide_{i + 1:02d}.png',
                       'sdur': d, 'start': starts[i], 'caption': cap, '_cap_text': cap, '_cap_top': False,
                       'target': {'x': 10 * i, 'y': 10, 'width': 50, 'height': 20}, 'viewport': {'width': 1600, 'height': 900},
                       '_cam': [[800.0, 450.0, 1.0], [800.0, 450.0, 1.0], [1600, 900]]})
    i = 0
    for size in screens:
        sc = list(range(i, i + size))
        f0 = frames[sc[0]]
        span = round((frames[sc[-1]] - f0) / FPS + sdurs[sc[-1]], 4)
        keys = [[0.0, [800.0, 450.0, 1.0]], [1.0, [600.0, 400.0, 1.3]]]
        for k in sc:
            slides[k]['_fx'] = {'off': frames[k] - f0, 'first': k == sc[0], 'move': None, 'push': False,
                                'blur_in': k == sc[0] and k != 0, 'blur_out': k == sc[-1] and k != len(sdurs) - 1,
                                'keys': keys, 'span': span}
        i += size
    assert i == len(sdurs)
    return {'duration': 0, 'content_offset': content_offset if title else 0.0, 'slides': slides, 'intro': title,
            'title_card': title, 'support_card': support, 'outro': outro, 'fx': True}


def total_for(a, tail_frames=60):
    tl = timeline(a, total_frames=10 ** 6, check_duration=False)
    end = max(c['endFrame'] for c in tl['cells'] if c['kind'] != 'bookend')
    return end + tail_frames


def ranges_cover(ranges, n):
    cursor = 0
    for a, b in ranges:
        if a != cursor or b <= a:
            return False
        cursor = b
    return cursor == n


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self.a = synthetic_assembly([2.0, 1.9, 2.4, 2.0, 2.2], screens=[2, 3])
        self.n = total_for(self.a)
        self.a['duration'] = round(self.n / FPS, 2)

    def test_constants_match_assemble_source(self):
        src = (REPO / 'renderer' / 'assemble.py').read_text()
        self.assertIn('W, H, FPS = 1920, 1080, 30', src)
        self.assertIn('XF = 0.8 ', src)
        self.assertEqual(src.count('xf_dur=0.65'), 3)  # lead, body and support crossfades
        self.assertIn('crossfade_pair(active_body, OUTRO, outro_path, xf_dur=0.80)', src)
        self.assertIn('math.ceil(round(off, 3) * FPS - 1e-6)', src)
        self.assertEqual((fx_scope.FPS, fx_scope.XF, fx_scope.CARD_XF, fx_scope.OUTRO_XF), (30, 0.8, 0.65, 0.8))

    def test_gap_free_integer_partition(self):
        tl = timeline(self.a, total_frames=self.n)
        cells = tl['cells']
        self.assertTrue(ranges_cover([(c['startFrame'], c['endFrame']) for c in cells], self.n))
        self.assertTrue(all(type(c['startFrame']) is int and type(c['endFrame']) is int for c in cells))
        self.assertEqual([c['kind'] for c in cells], ['bookend', 'dissolve'] + ['hold', 'dissolve'] * 5 + ['bookend'])
        self.assertEqual(tl['screens'], [['slide-01', 'slide-02'], ['slide-03', 'slide-04', 'slide-05']])
        c0 = math.ceil(round(1.017, 3) * FPS - 1e-6)  # 31: content frame 0 in the final video
        self.assertEqual(cells[1], {'id': 'lead-dissolve', 'kind': 'dissolve', 'dependsOn': ['card:lead', 'slide-01'],
                                    'startFrame': c0 - 1, 'endFrame': c0 + 20 + 1})
        s2 = c0 + math.ceil(round(1.2, 3) * FPS - 1e-6)
        d = next(c for c in cells if c['id'] == 'dissolve-01-02')
        self.assertEqual((d['startFrame'], d['endFrame'], d['dependsOn']), (s2 - 1, s2 + 24 + 1, ['slide-01', 'slide-02']))

    def test_no_cards(self):
        a = synthetic_assembly([2.0, 2.0], screens=[2], title=False, support=False, outro=False)
        n = 96  # (2.0 + 2.0 - 0.8) s at 30 fps, no cards
        tl = timeline(a, total_frames=n, check_duration=False)
        self.assertEqual(tl['content_end_frame'], n)
        self.assertEqual([c['id'] for c in tl['cells']], ['hold-01', 'dissolve-01-02', 'hold-02'])
        self.assertTrue(ranges_cover([(c['startFrame'], c['endFrame']) for c in tl['cells']], n))
        with self.assertRaisesRegex(ValueError, 'inconsistent_timeline'):
            timeline(a, total_frames=n + 5, check_duration=False)

    def test_rejections(self):
        cases = {}
        b = copy.deepcopy(self.a); b['slides'][2]['start'] += 0.1; cases['inconsistent_timeline'] = b
        b = copy.deepcopy(self.a); b['slides'][1]['start'] = 0.5; b['slides'][1]['sdur'] = 1.0; cases['inconsistent_timeline|overlapping_transitions'] = b
        b = copy.deepcopy(self.a); del b['slides'][3]['_fx']; cases['missing_fx_data'] = b
        b = copy.deepcopy(self.a); b['slides'][3]['_fx']['off'] += 1; cases['inconsistent_fx_plan'] = b
        b = copy.deepcopy(self.a); b['slides'][3]['_fx']['span'] = 1; cases['inconsistent_fx_plan '] = b
        b = copy.deepcopy(self.a); b['fx'] = False; cases['unsupported_non_fx_render'] = b
        b = copy.deepcopy(self.a); b['slides'][1]['slide'] = 1; cases['duplicate_slide'] = b
        for err, a in cases.items():
            with self.subTest(err=err), self.assertRaisesRegex(ValueError, err.strip()):
                timeline(a, total_frames=self.n)
        # A slide too short for its two dissolves must be refused, not silently merged.
        short = synthetic_assembly([2.0, 1.6, 2.0], screens=[3])
        with self.assertRaisesRegex(ValueError, 'overlapping_transitions'):
            timeline(short, total_frames=total_for(short), check_duration=False)
        with self.assertRaisesRegex(ValueError, 'duration_mismatch'):
            timeline(self.a, total_frames=self.n + 30)
        with self.assertRaisesRegex(ValueError, 'inconsistent_timeline'):
            timeline(self.a, total_frames=40, check_duration=False)


class ClosureTests(unittest.TestCase):
    def setUp(self):
        self.a = synthetic_assembly([2.0, 1.9, 2.4, 2.0, 2.2], screens=[2, 3])
        self.n = total_for(self.a)
        self.a['duration'] = round(self.n / FPS, 2)
        self.cells = {c['id']: c for c in timeline(self.a, total_frames=self.n)['cells']}

    def span(self, *ids):
        return [[self.cells[ids[0]]['startFrame'], self.cells[ids[-1]]['endFrame']]]

    def test_screenshot_only_is_slide_plus_adjacent_dissolves(self):
        r = closure(self.a, {'slide-04': {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
        self.assertFalse(r['scope_expansion_required'])
        self.assertEqual(r['approval_scope']['stepIds'], ['slide-04'])
        self.assertEqual(r['dirty_cells'], ['dissolve-03-04', 'hold-04', 'dissolve-04-05'])
        self.assertEqual(r['dirty_frames'], self.span('dissolve-03-04', 'dissolve-04-05'))
        self.assertTrue(ranges_cover(sorted([tuple(x) for x in r['dirty_frames'] + r['protected_frames']]), self.n))
        self.assertEqual(r['dirty_frame_count'] + r['protected_frame_count'], self.n)

    def test_first_and_last_slide_use_card_dissolves(self):
        r = closure(self.a, {1: {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
        self.assertEqual(r['dirty_cells'], ['lead-dissolve', 'hold-01', 'dissolve-01-02'])
        r = closure(self.a, {'step_000000000004.png': {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
        self.assertEqual(r['dirty_cells'], ['dissolve-04-05', 'hold-05', 'tail-dissolve'])

    def test_target_change_expands_to_whole_screen_and_boundaries(self):
        r = closure(self.a, {'slide-04': {'screenshot_changed': False, 'target_changed': True}}, total_frames=self.n)
        self.assertTrue(r['scope_expansion_required'])
        self.assertEqual(r['approval_scope']['stepIds'], ['slide-03', 'slide-04', 'slide-05'])
        self.assertEqual(sorted(e['slide'] for e in r['expansion']), ['slide-03', 'slide-05'])
        self.assertTrue(all(e['reason'] == 'same_fx_screen' for e in r['expansion']))
        self.assertEqual(r['dirty_frames'], self.span('dissolve-02-03', 'tail-dissolve'))
        self.assertIn('dissolve-02-03', r['dirty_cells'])  # screen boundary transition
        self.assertNotIn('hold-02', r['dirty_cells'])

    def test_caption_position_run_crosses_screens(self):
        caps = ['a', 'shared', 'shared', 'c', 'd']  # slides 2 and 3 share one caption position across screens
        a = synthetic_assembly([2.0, 1.9, 2.4, 2.0, 2.2], screens=[2, 3], captions=caps)
        r = closure(a, {'slide-01': {'screenshot_changed': False, 'target_changed': True}}, total_frames=total_for(a), check_duration=False)
        self.assertEqual(r['approval_scope']['stepIds'], ['slide-01', 'slide-02', 'slide-03'])
        self.assertIn({'slide': 'slide-03', 'reason': 'shared_caption_position'}, r['expansion'])

    def test_noop_and_union(self):
        r = closure(self.a, {'slide-02': {'screenshot_changed': False, 'target_changed': False}}, total_frames=self.n)
        self.assertEqual((r['dirty_frames'], r['dirty_cells'], r['approval_scope']['stepIds']), ([], [], []))
        self.assertEqual(r['protected_frames'], [[0, self.n]])
        r = closure(self.a, {'slide-02': {'screenshot_changed': True, 'target_changed': False},
                             'slide-03': {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
        self.assertEqual(r['dirty_frames'], self.span('dissolve-01-02', 'dissolve-03-04'))

    def test_change_set_rejections(self):
        ok = {'screenshot_changed': True, 'target_changed': False}
        for change, err in [({'slide-09': ok}, 'unknown_slide'), ({'nope.png': ok}, 'unknown_slide'),
                            ({'slide-02': {'screenshot_changed': True}}, 'invalid_change'),
                            ({'slide-02': {**ok, 'narration_changed': True}}, 'invalid_change'),
                            ({'slide-02': {'screenshot_changed': 1, 'target_changed': False}}, 'invalid_change'),
                            ({'slide-02': ok, 2: ok}, 'duplicate_change')]:
            with self.subTest(err=err), self.assertRaisesRegex(ValueError, err):
                closure(self.a, change, total_frames=self.n)


class ExplicitScopeTests(unittest.TestCase):
    """explicit_scope: the dirty set comes from an exact re-plan diff (not the conservative closure)."""

    def setUp(self):
        self.a = synthetic_assembly([2.0, 1.9, 2.4, 2.0, 2.2], screens=[2, 3])
        self.n = total_for(self.a)
        self.a['duration'] = round(self.n / FPS, 2)

    def test_matches_closure_for_single_slides_including_edges(self):
        for sid in ('slide-01', 'slide-03', 'slide-05'):
            c = closure(self.a, {sid: {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
            e = fx_scope.explicit_scope(self.a, [sid], self.n)
            for k in ('dirty_cells', 'dirty_frames', 'protected_frames', 'approval_scope', 'dirty_frame_count'):
                self.assertEqual(e[k], c[k], (sid, k))
        e = fx_scope.explicit_scope(self.a, ['slide-01'], self.n)
        self.assertEqual(e['dirty_cells'], ['lead-dissolve', 'hold-01', 'dissolve-01-02'])
        self.assertEqual(e['edges'], {'lead': True, 'tail': False})
        self.assertEqual(fx_scope.explicit_scope(self.a, ['slide-05'], self.n)['edges'], {'lead': False, 'tail': True})

    def test_replanned_screen_and_reasons(self):
        e = fx_scope.explicit_scope(self.a, ['slide-02', 'slide-01'], self.n,
                                    reasons={'slide-01': ['replan:_fx'], 'slide-02': ['changed_step']})
        self.assertEqual(e['approval_scope']['stepIds'], ['slide-01', 'slide-02'])
        self.assertEqual(e['dirty_cells'], ['lead-dissolve', 'hold-01', 'dissolve-01-02', 'hold-02', 'dissolve-02-03'])
        cells = {c['id']: c for c in e['timeline']['cells']}
        self.assertEqual(e['dirty_frames'], [[cells['lead-dissolve']['startFrame'], cells['dissolve-02-03']['endFrame']]])
        self.assertEqual(e['reasons']['slide-01'], ['replan:_fx'])

    def test_rejections(self):
        for ids, err in ((['slide-09'], 'unknown_slide'), (['slide-01', 'slide-01'], 'duplicate_change'), ([], 'empty_scope'),
                         (['slide-01', 'slide-03'], 'noncontiguous_scope')):
            with self.subTest(err=err), self.assertRaisesRegex(ValueError, err):
                fx_scope.explicit_scope(self.a, ids, self.n)


@unittest.skipUnless((PILOT / 'assembly.json').is_file() and (PILOT / 'How-to-Find-a-Project-ID.mp4').is_file(), 'pilot absent')
class RealPilotScopeTests(unittest.TestCase):
    """READ-ONLY: parses the pilot's assembly.json and ffprobes its MP4. Writes nothing."""

    @classmethod
    def setUpClass(cls):
        cls.mp4 = PILOT / 'How-to-Find-a-Project-ID.mp4'
        cls.before = [(p.stat().st_size, p.stat().st_mtime_ns, fx_scope.sha256_file(p)) for p in (PILOT / 'assembly.json', cls.mp4)]
        cls.a = json.loads((PILOT / 'assembly.json').read_bytes())
        out = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_packets',
                                       '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', str(cls.mp4)], timeout=60)
        cls.n = int(out.decode().strip().rstrip(','))

    @classmethod
    def tearDownClass(cls):
        after = [(p.stat().st_size, p.stat().st_mtime_ns, fx_scope.sha256_file(p)) for p in (PILOT / 'assembly.json', cls.mp4)]
        assert after == cls.before, 'pilot files changed'

    def test_pilot_scope(self):
        self.assertEqual(self.n, 810)
        tl = timeline(self.a, total_frames=self.n)
        self.assertEqual(tl['screens'], [['slide-01', 'slide-02'], ['slide-03']])
        self.assertEqual(tl['content_start_frame'], 163)
        self.assertEqual([(c['id'], c['startFrame'], c['endFrame']) for c in tl['cells']], [
            ('lead-card', 0, 162), ('lead-dissolve', 162, 184), ('hold-01', 184, 313), ('dissolve-01-02', 313, 339),
            ('hold-02', 339, 435), ('dissolve-02-03', 435, 461), ('hold-03', 461, 589), ('tail-dissolve', 589, 611),
            ('tail-card', 611, 810)])
        shot = closure(self.a, {'slide-02': {'screenshot_changed': True, 'target_changed': False}}, total_frames=self.n)
        self.assertEqual(shot['dirty_frames'], [[313, 461]])
        self.assertEqual(shot['protected_frames'], [[0, 313], [461, 810]])
        self.assertFalse(shot['scope_expansion_required'])
        geo = closure(self.a, {'slide-02': {'screenshot_changed': False, 'target_changed': True}}, total_frames=self.n)
        self.assertEqual(geo['dirty_frames'], [[162, 461]])
        self.assertTrue(geo['scope_expansion_required'])
        self.assertEqual(geo['approval_scope']['stepIds'], ['slide-01', 'slide-02'])

    def test_observed_dissolves_lie_inside_dissolve_cells(self):
        obs = fx_scope.observed_transitions(self.mp4)
        cells = {c['id']: c for c in timeline(self.a, total_frames=self.n)['cells']}
        # The 2->3 dissolve is between different screens (defocus + new page): every changing frame of it
        # must be inside the computed window. Card dissolves likewise.
        for cid, (lo, hi) in {'lead-dissolve': (150, 200), 'dissolve-02-03': (425, 470), 'tail-dissolve': (580, 620)}.items():
            changed = [i for i in obs if lo <= i < hi]
            self.assertGreater(len(changed), 15, cid)
            self.assertTrue(all(cells[cid]['startFrame'] <= i < cells[cid]['endFrame'] for i in changed), (cid, changed))


if __name__ == '__main__':
    unittest.main()
