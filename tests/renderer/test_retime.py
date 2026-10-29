"""renderer.retime: new timeline when one interior slide's narration take changes duration. Pure planning
on a pilot-shaped assembly fixture (no media)."""
import copy
import json
import unittest

from renderer import fx_scope, retime

WIDE = [800.0, 450.0, 1.0]
V = [600.0, 388.25, 1.3333333333333333]
CAPS = ["Let's start on the Projects list.", 'Opening up this project.', 'And here we are.']


def pilot_like_assembly():
    """Same timing/FX shape as the real pilot How-to-Find-a-Project-ID (810 frames, 3 slides, screens [1,2],[3])."""
    sd = [5.801, 4.872, 5.801]
    st = [0.0, 5.001, 9.073]
    keys = [[0.0, WIDE], [151 / 30, WIDE], [151 / 30 + 1.5, V]]
    fx = [{'off': 0, 'first': True, 'move': None, 'push': False, 'blur_in': False, 'blur_out': False, 'keys': keys, 'span': 9.9053},
          {'off': 151, 'first': False, 'move': [0.0, 1.5], 'push': True, 'blur_in': False, 'blur_out': True, 'keys': keys, 'span': 9.9053},
          {'off': 0, 'first': True, 'move': None, 'push': False, 'blur_in': True, 'blur_out': False, 'keys': [[0.0, WIDE]], 'span': 5.801}]
    edges = [[False, True], [True, True], [True, False]]
    slides = []
    for i in range(3):
        slides.append({'slide': i + 1, 'step': i, 'src': f'step_{i}.png', 'file': f'slide_{i + 1:02d}.png', 'adur': sd[i] - 1.9,
                       'sdur': sd[i], 'start': st[i], 'narration': CAPS[i], 'caption': CAPS[i], '_cap_text': CAPS[i], '_cap_top': False,
                       '_cap_edges': edges[i], 'action': 'click' if i == 1 else 'navigate', 'audio': f'/takes/{i}.mp3', 'audio_filter': '',
                       'target': {'x': 289, 'y': 227, 'width': 415, 'height': 147} if i == 1 else None,
                       'viewport': {'width': 1600, 'height': 900}, '_cam': [WIDE, V if i == 1 else WIDE, [1600, 900]], '_fx': copy.deepcopy(fx[i])})
    return {'video': 'x.mp4', 'duration': 27.0, 'content_offset': 5.417, 'slides': slides, 'intro': True, 'title_card': True,
            'support_card': True, 'outro': True, 'fx': True}


class Quantize(unittest.TestCase):
    def test_longer_whole_frame_shift(self):
        q = retime.quantize_sdur(4.872, 4.3)
        self.assertEqual(q['assemble_sdur'], 6.2)
        self.assertEqual(q['shift_frames'], 40)
        self.assertEqual(q['sdur'], 6.205)
        self.assertAlmostEqual(q['extra_pause_s'], 0.005, places=6)

    def test_shorter_whole_frame_shift(self):
        q = retime.quantize_sdur(4.872, 1.0)
        self.assertEqual(q['assemble_sdur'], 2.9)
        self.assertEqual(q['shift_frames'], -59)
        self.assertEqual(q['sdur'], 2.905)
        self.assertGreaterEqual(q['sdur'], q['assemble_sdur'])

    def test_same_duration_no_shift(self):
        q = retime.quantize_sdur(4.872, 2.972154)
        self.assertEqual(q['shift_frames'], 0)
        self.assertEqual(q['sdur'], 4.872)


class KeysPort(unittest.TestCase):
    def test_port_reproduces_persisted_plan(self):
        a = pilot_like_assembly()
        g = retime.check_fx_timing_port(a)
        self.assertTrue(g['ok'], g)

    def test_port_detects_foreign_plan(self):
        a = pilot_like_assembly()
        a['slides'][1]['_fx']['move'] = [0.0, 1.2]
        self.assertFalse(retime.check_fx_timing_port(a)['ok'])


class PlanRetime(unittest.TestCase):
    def setUp(self):
        self.a = pilot_like_assembly()

    def test_longer(self):
        p = retime.plan_retime(self.a, 1, new_adur=4.3, narration='A much longer line.', caption='A much longer line.')
        n = p['assembly']
        self.assertEqual(p['shift_frames'], 40)
        self.assertEqual([s['sdur'] for s in n['slides']], [5.801, 6.205, 5.801])
        self.assertEqual(n['slides'][2]['start'], round(5.001 + 6.205 - 0.8, 3))
        self.assertEqual(retime.frame_of(n['slides'][2]['start']), 273 + 40)
        self.assertEqual(p['dirty_slides'], ['slide-02'])
        self.assertEqual(n['slides'][0]['_fx'], self.a['slides'][0]['_fx'])
        self.assertEqual(n['slides'][2]['_fx'], self.a['slides'][2]['_fx'])
        self.assertEqual(n['slides'][1]['_fx']['move'], [0.0, 1.5])
        self.assertEqual(n['slides'][1]['_fx']['span'], 9.9053)  # frozen span policy
        self.assertEqual(p['span_policy'], 'frozen')
        self.assertGreater(p['replan_span'], 9.9053)
        self.assertEqual(n['slides'][1]['_cap_text'], 'A much longer line.')
        self.assertEqual(n['duration'], round((810 + 40) / 30, 2))
        self.assertEqual(p['total_frames'], 850)
        self.assertEqual(self.a['slides'][1]['sdur'], 4.872, 'input must not be mutated')

    def test_shorter_retimes_camera_move(self):
        p = retime.plan_retime(self.a, 1, new_adur=1.0, narration='Open it.', caption='Open it.')
        n = p['assembly']
        self.assertEqual(p['shift_frames'], -59)
        mv = n['slides'][1]['_fx']['move']
        self.assertEqual(mv, [0.0, round(min(1.5, max(0.8, 2.905 * 0.4)), 4)])
        self.assertEqual(n['slides'][0]['_fx']['keys'], n['slides'][1]['_fx']['keys'])
        self.assertNotEqual(n['slides'][0]['_fx']['keys'], self.a['slides'][0]['_fx']['keys'])
        self.assertEqual(p['dirty_slides'], ['slide-02'])

    def test_edge_slides_rejected(self):
        for k in (0, 2):
            with self.assertRaises(retime.RetimeRejected) as cm:
                retime.plan_retime(self.a, k, new_adur=3.0, narration='x', caption='x')
            self.assertEqual(cm.exception.code, 'unsupported_edge_slide')

    def test_caption_equal_to_neighbour_rejected(self):
        with self.assertRaises(retime.RetimeRejected) as cm:
            retime.plan_retime(self.a, 1, new_adur=3.0, narration=CAPS[0], caption=CAPS[0])
        self.assertEqual(cm.exception.code, 'scope_expansion_required:caption_handover_changed')

    def test_timeline_and_cell_map(self):
        base_tl = fx_scope.timeline(self.a, 810)
        p = retime.plan_retime(self.a, 1, new_adur=4.3, narration='A much longer line.', caption='A much longer line.')
        tl = retime.timeline_for(p['assembly'], p['total_frames'], p)
        m = retime.map_cells(base_tl['cells'], tl['cells'], p['dirty_slides'])
        by = {c['id']: c for c in m}
        self.assertEqual(sorted(c['id'] for c in m if c['action'] == 'render'), ['dissolve-01-02', 'dissolve-02-03', 'hold-02'])
        for cid in ('lead-card', 'lead-dissolve', 'hold-01'):
            self.assertEqual(by[cid]['new'], by[cid]['base'])
        for cid in ('hold-03', 'tail-dissolve', 'tail-card'):
            self.assertEqual([x + 40 for x in by[cid]['base']], by[cid]['new'])
        self.assertEqual(by['hold-02']['new'][1] - by['hold-02']['new'][0], by['hold-02']['base'][1] - by['hold-02']['base'][0] + 40)
        self.assertEqual(tl['cells'][-1]['endFrame'], 850)

    def test_zero_shift_timeline_identical(self):
        p = retime.plan_retime(self.a, 1, new_adur=2.972154, narration='Different words, same length.', caption='Different words, same length.')
        self.assertEqual(p['shift_frames'], 0)
        tl = retime.timeline_for(p['assembly'], p['total_frames'], p)
        self.assertEqual(json.dumps(tl['cells']), json.dumps(fx_scope.timeline(self.a, 810)['cells']))

    def test_protected_views_unchanged(self):
        from renderer import fx_draw
        import os, tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            dr = fx_draw.load(out_dir=Path(d) / 'out', tmp_dir=Path(d) / 'out' / '_build', needs_drawn_highlight=True)
            for adur in (4.3, 1.0):
                p = retime.plan_retime(self.a, 1, new_adur=adur, narration='Open it now.', caption='Open it now.')
                tl = retime.timeline_for(p['assembly'], p['total_frames'], p)
                m = retime.map_cells(fx_scope.timeline(self.a, 810)['cells'], tl['cells'], p['dirty_slides'])
                v = retime.protected_views_equal(dr, self.a, p['assembly'], m)
                self.assertTrue(v['ok'], v)
                self.assertGreater(v['frames_checked'], 100)


if __name__ == '__main__':
    unittest.main()
