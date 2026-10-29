import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

from renderer import baseline_inventory as bi

REPO = Path(__file__).resolve().parents[2]


def png_bytes(w=4, h=3):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x10\x20\x30' * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class Fixture:
    """A synthetic repo: scripts/, out/_recordings/<rid>/, out/<name>/, out/_cache/tts/."""

    def __init__(self, root):
        self.root = Path(root)
        for d in ('scripts', 'out/_recordings', 'out/_cache/tts'):
            (self.root / d).mkdir(parents=True, exist_ok=True)

    def add(self, name, steps=3, fx=False, ids=True, assembly=True, mp4=True, audio=True, narrated=True):
        rid = f'rec-{name}'
        rec = self.root / 'out/_recordings' / rid
        rec.mkdir(parents=True, exist_ok=True)
        script_steps, slides = [], []
        t = 0.0
        for i in range(steps):
            cid = f'{name.lower()}{i:04d}'
            (rec / f'step_{cid}.png').write_bytes(png_bytes())
            narration = f'Narration {i}' if narrated else ''
            script_steps.append({'index': i, 'url': 'https://app.example/x', 'route': '/x', 'action': 'click',
                                 'capture': True, 'captureId': cid, 'media': {'pre': f'step_{cid}.png'},
                                 'narration': narration, 'caption': narration})
            a = self.root / 'out/_cache/tts' / f'{name}-{i}.mp3'
            if audio and narrated:
                a.write_bytes(b'ID3fake')
            slides.append({'slide': i + 1, 'step': i, 'phase': 'pre', 'file': f'slide_{i + 1:02d}.png',
                           'src': f'step_{cid}.png', 'narration': narration, 'caption': narration,
                           'audio': str(a) if narrated else None, 'adur': 1.0 if narrated else 0.0,
                           'sdur': 1.5, 'start': t})
            t += 1.0
        script = {'name': name, 'title': name.replace('-', ' '), 'module': 'Mod', 'fx': fx,
                  'recording': {'id': rid, 'recordedAt': '2026-01-01T00:00:00Z'}, 'steps': script_steps}
        if ids:
            script.update({'driveVideoId': f'drive-{name}', 'driveVideoUrl': f'https://drive.example/SECRET-{name}',
                           'pylonArticleId': f'pylon-{name}', 'pylonArticleUrl': f'https://pylon.example/SECRET-{name}'})
        self.write_script(name, script)
        out = self.root / 'out' / name
        out.mkdir(parents=True, exist_ok=True)
        (out / 'report.json').write_text(json.dumps({'name': name, 'slides': slides}))
        (out / 'render-key.json').write_text(json.dumps({'key': 'k', 'mode': 'video'}))
        if assembly:
            (out / 'assembly.json').write_text(json.dumps({
                'video': f'out/{name}/{name}.mp4', 'duration': round(t + 0.5, 2), 'content_offset': 2.0,
                'slides': slides, 'intro': True, 'title_card': True, 'support_card': False, 'outro': True, 'fx': fx}))
        if mp4:
            (out / f'{name}.mp4').write_bytes(b'\x00\x00\x00\x18ftypmp42fake')
        return script

    def script(self, name):
        return json.loads((self.root / 'scripts' / f'{name}.script.json').read_text())

    def write_script(self, name, script):
        (self.root / 'scripts' / f'{name}.script.json').write_text(json.dumps(script))

    def assembly(self, name):
        return json.loads((self.root / 'out' / name / 'assembly.json').read_text())

    def write_assembly(self, name, a):
        (self.root / 'out' / name / 'assembly.json').write_text(json.dumps(a))


def tree_state(root):
    state = {}
    for p in sorted(Path(root).rglob('*')):
        if p.is_symlink():
            state[str(p)] = ('link', os.readlink(p))
        elif p.is_file():
            st = p.stat()
            state[str(p)] = (bi.sha256_file(p), st.st_mtime_ns, st.st_size, st.st_mode)
    return state


class BaselineInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.base = Path(self.tmp.name)
        self.fx = Fixture(self.base / 'repo')

    def tearDown(self):
        self.tmp.cleanup()

    def inventory(self, **kw):
        return bi.build_inventory(self.fx.root, **kw)

    def item(self, inv, name):
        return next(x for x in inv['items'] if x['name'] == name)

    def test_good_script_reaches_every_tier_and_is_pilot(self):
        self.fx.add('Good')
        inv = self.inventory()
        it = self.item(inv, 'Good')
        self.assertTrue(it['tiers']['candidate_ready']['value'], it)
        self.assertTrue(it['tiers']['visual_render_evidence']['value'], it)
        self.assertTrue(it['tiers']['audio_takes_recoverable']['value'], it)
        self.assertFalse(it['strict_exact_preservation_ready']['value'])
        self.assertIn('legacy final MP4 is not segmented into independently decodable cells; requires approved one-time rebaseline',
                      it['strict_exact_preservation_ready']['reasons'])
        self.assertEqual(it['blockers'], [])
        self.assertEqual(it['counts']['steps'], 3)
        self.assertEqual(it['counts']['captures_valid'], 3)
        self.assertFalse(it['stable_ids']['all_steps_have_id'])
        self.assertEqual([p['name'] for p in inv['pilot_candidates']], ['Good'])

    def test_missing_capture_blocks_candidate(self):
        self.fx.add('Miss')
        (self.fx.root / 'out/_recordings/rec-Miss/step_miss0001.png').unlink()
        it = self.item(self.inventory(), 'Miss')
        self.assertFalse(it['tiers']['candidate_ready']['value'])
        self.assertFalse(it['tiers']['visual_render_evidence']['value'])
        self.assertIn('missing_capture', it['blockers'])
        self.assertEqual(it['captures']['missing'], ['step_miss0001.png'])

    def test_step_without_media_ref_blocks_candidate(self):
        self.fx.add('NoRef')
        s = self.fx.script('NoRef'); del s['steps'][1]['media']; self.fx.write_script('NoRef', s)
        it = self.item(self.inventory(), 'NoRef')
        self.assertIn('missing_capture_ref', it['blockers'])
        self.assertFalse(it['tiers']['candidate_ready']['value'])

    def test_corrupt_png_is_invalid(self):
        self.fx.add('Corrupt')
        p = self.fx.root / 'out/_recordings/rec-Corrupt/step_corrupt0002.png'
        data = bytearray(p.read_bytes()); data[20] ^= 0xff; p.write_bytes(bytes(data))  # breaks IHDR CRC
        (self.fx.root / 'out/_recordings/rec-Corrupt/step_corrupt0000.png').write_bytes(b'not a png at all')
        it = self.item(self.inventory(), 'Corrupt')
        self.assertIn('invalid_capture', it['blockers'])
        bad = {x['file']: x['reason'] for x in it['captures']['invalid']}
        self.assertEqual(set(bad), {'step_corrupt0000.png', 'step_corrupt0002.png'})
        self.assertFalse(it['tiers']['candidate_ready']['value'])

    def test_truncated_png_is_invalid(self):
        self.fx.add('Trunc')
        p = self.fx.root / 'out/_recordings/rec-Trunc/step_trunc0001.png'
        p.write_bytes(p.read_bytes()[:-12])
        it = self.item(self.inventory(), 'Trunc')
        self.assertIn('invalid_capture', it['blockers'])

    def test_capture_id_mismatch_and_duplicate_refs_are_ambiguous(self):
        self.fx.add('Amb')
        s = self.fx.script('Amb')
        s['steps'][0]['captureId'] = 'somethingelse'
        s['steps'][2]['media']['pre'] = s['steps'][1]['media']['pre']
        s['steps'][2]['captureId'] = s['steps'][1]['captureId']
        self.fx.write_script('Amb', s)
        it = self.item(self.inventory(), 'Amb')
        self.assertIn('ambiguous_capture_ref', it['blockers'])
        self.assertEqual(it['captures']['capture_id_mismatch'], [0])
        self.assertEqual(it['captures']['duplicate_refs'], {'step_amb0001.png': [1, 2]})
        self.assertFalse(it['tiers']['candidate_ready']['value'])

    def test_pruned_audio_only_blocks_audio_tier(self):
        self.fx.add('Pruned')
        (self.fx.root / 'out/_cache/tts/Pruned-1.mp3').unlink()
        it = self.item(self.inventory(), 'Pruned')
        self.assertTrue(it['tiers']['candidate_ready']['value'])
        self.assertTrue(it['tiers']['visual_render_evidence']['value'])
        self.assertFalse(it['tiers']['audio_takes_recoverable']['value'])
        self.assertIn('narration_audio_pruned', it['blockers'])
        self.assertEqual(it['audio']['narrated_slides'], 3)
        self.assertEqual(it['audio']['present'], 2)
        self.assertEqual(it['audio']['missing_slides'], [2])

    def test_missing_assembly_blocks_visual_and_audio(self):
        self.fx.add('NoAsm', assembly=False)
        it = self.item(self.inventory(), 'NoAsm')
        self.assertTrue(it['tiers']['candidate_ready']['value'])
        self.assertFalse(it['tiers']['visual_render_evidence']['value'])
        self.assertFalse(it['tiers']['audio_takes_recoverable']['value'])
        self.assertIn('missing_assembly', it['blockers'])
        self.assertFalse(it['local_out']['assembly'])
        self.assertFalse(it['timing']['available'])

    def test_missing_final_mp4_blocks_visual(self):
        self.fx.add('NoMp4', mp4=False)
        it = self.item(self.inventory(), 'NoMp4')
        self.assertIn('missing_final_mp4', it['blockers'])
        self.assertFalse(it['tiers']['visual_render_evidence']['value'])
        self.assertTrue(it['ids']['driveVideoId'])

    def test_assembly_src_or_count_mismatch_blocks_visual(self):
        self.fx.add('Drift')
        a = self.fx.assembly('Drift'); a['slides'][1]['src'] = 'step_other.png'; self.fx.write_assembly('Drift', a)
        self.fx.add('Short')
        a = self.fx.assembly('Short'); a['slides'].pop(); self.fx.write_assembly('Short', a)
        self.fx.add('Said')
        a = self.fx.assembly('Said'); a['slides'][0]['narration'] = 'Old words'; self.fx.write_assembly('Said', a)
        inv = self.inventory()
        for name, blocker in (('Drift', 'assembly_script_mismatch'), ('Short', 'assembly_script_mismatch'),
                              ('Said', 'narration_changed_since_render')):
            it = self.item(inv, name)
            self.assertTrue(it['tiers']['candidate_ready']['value'], name)
            self.assertFalse(it['tiers']['visual_render_evidence']['value'], name)
            self.assertIn(blocker, it['blockers'], name)

    def test_legacy_assembly_without_src_is_named_not_guessed(self):
        self.fx.add('Legacy')
        a = self.fx.assembly('Legacy')
        del a['content_offset']
        for s in a['slides']:
            s['src'] = None
        a['slides'][0]['audio'] = 'out/Legacy/_build/n01-vs.mp3'
        (self.fx.root / 'out/Legacy/_build').mkdir()
        (self.fx.root / 'out/Legacy/_build/n01-vs.mp3').write_bytes(b'ID3')
        self.fx.write_assembly('Legacy', a)
        it = self.item(self.inventory(), 'Legacy')
        self.assertIn('assembly_legacy_no_src', it['blockers'])
        self.assertNotIn('assembly_script_mismatch', it['blockers'])
        self.assertIn('timing_unavailable', it['blockers'])
        self.assertFalse(it['tiers']['visual_render_evidence']['value'])
        self.assertTrue(it['tiers']['audio_takes_recoverable']['value'])
        self.assertEqual(it['audio']['outside_tts_cache'], 1)

    def test_internal_studio_records_excluded_and_counts_declared(self):
        self.fx.add('Good')
        self.fx.write_script('_studio-drift-flags', {'name': '_studio-drift-flags', 'steps': []})
        inv = self.inventory()
        self.assertEqual([x['name'] for x in inv['items']], ['Good'])
        s = inv['summary']
        self.assertEqual(s['counts']['script_files_found'], 2)
        self.assertEqual(s['counts']['excluded_internal'], ['_studio-drift-flags'])
        self.assertEqual(s['counts']['walkthroughs_enumerated'], 1)
        self.assertEqual(s['counts']['items_in_inventory'], 1)
        self.assertEqual(s['tiers']['candidate_ready'], 1)
        self.assertEqual(s['strict_exact_preservation_ready'], 0)

    def test_only_filter(self):
        self.fx.add('A'); self.fx.add('B')
        inv = self.inventory(only='B')
        self.assertEqual([x['name'] for x in inv['items']], ['B'])
        with self.assertRaises(ValueError):
            self.inventory(only='../scripts/B')

    def test_symlink_escape_refused(self):
        outside = self.base / 'outside.png'; outside.write_bytes(png_bytes())
        self.fx.add('Esc')
        p = self.fx.root / 'out/_recordings/rec-Esc/step_esc0000.png'
        p.unlink(); p.symlink_to(outside)
        self.fx.add('EscOut')
        elsewhere = self.base / 'elsewhere'; shutil.move(str(self.fx.root / 'out/EscOut'), elsewhere)
        (self.fx.root / 'out/EscOut').symlink_to(elsewhere, target_is_directory=True)
        self.fx.add('EscAudio')
        outside_mp3 = self.base / 'x.mp3'; outside_mp3.write_bytes(b'x')
        link = self.fx.root / 'out/_cache/tts/EscAudio-0.mp3'; link.unlink(); link.symlink_to(outside_mp3)
        self.fx.add('ElsewhereAudio')
        a = self.fx.assembly('ElsewhereAudio')
        a['slides'][0]['audio'] = str(outside_mp3); self.fx.write_assembly('ElsewhereAudio', a)
        self.fx.add('EscRec')
        s = self.fx.script('EscRec'); s['recording']['id'] = '../../..'; self.fx.write_script('EscRec', s)
        inv = self.inventory()
        it = self.item(inv, 'Esc')
        self.assertIn('path_escape', it['blockers'])
        self.assertEqual([x['reason'] for x in it['captures']['invalid']], ['path_escape'])
        self.assertFalse(it['tiers']['candidate_ready']['value'])
        it = self.item(inv, 'EscOut')
        self.assertIn('path_escape', it['blockers'])
        self.assertFalse(it['local_out']['dir'])
        it = self.item(inv, 'EscAudio')
        self.assertFalse(it['tiers']['audio_takes_recoverable']['value'])
        self.assertIn('path_escape', it['blockers'])
        self.assertEqual(it['audio']['escaped_slides'], [1])
        it = self.item(inv, 'ElsewhereAudio')
        self.assertFalse(it['tiers']['audio_takes_recoverable']['value'])
        self.assertIn('narration_audio_outside_repo', it['blockers'])
        self.assertNotIn('path_escape', it['blockers'])
        self.assertEqual(it['audio']['outside_repo_slides'], [1])
        it = self.item(inv, 'EscRec')
        self.assertIn('path_escape', it['blockers'])
        self.assertFalse(it['recording']['dir_present'])

    def test_cli_writes_outputs_without_changing_sources_or_leaking_urls(self):
        self.fx.add('Good'); self.fx.add('Pruned'); (self.fx.root / 'out/_cache/tts/Pruned-0.mp3').unlink()
        self.fx.add('NoAsm', assembly=False)
        self.fx.write_script('_studio-drift-flags', {'name': '_studio-drift-flags', 'steps': []})
        before = tree_state(self.fx.root)
        out = self.base / 'report'
        rc = bi.main(['--repo', str(self.fx.root), '--output', str(out)])
        self.assertEqual(rc, 0)
        self.assertEqual(tree_state(self.fx.root), before)
        for f in ('inventory.json', 'summary.json', 'pilot_candidates.json', 'source_check.json'):
            self.assertTrue((out / f).is_file(), f)
        text = ''.join((out / f).read_text() for f in os.listdir(out))
        self.assertNotIn('SECRET', text)
        self.assertNotIn('https://', text)
        check = json.loads((out / 'source_check.json').read_text())
        self.assertTrue(check['unchanged'])
        self.assertGreater(check['files_checked'], 0)
        summary = json.loads((out / 'summary.json').read_text())
        self.assertEqual(summary['counts']['items_in_inventory'], 3)

    def test_cli_refuses_existing_or_in_repo_output(self):
        self.fx.add('Good')
        existing = self.base / 'exists'; existing.mkdir()
        with self.assertRaises(SystemExit):
            bi.main(['--repo', str(self.fx.root), '--output', str(existing)])
        with self.assertRaises(SystemExit):
            bi.main(['--repo', str(self.fx.root), '--output', str(self.fx.root / 'out' / 'inv')])
        self.assertFalse((self.fx.root / 'out' / 'inv').exists())

    def test_snapshot_detects_change(self):
        self.fx.add('Good')
        files = [self.fx.root / 'scripts/Good.script.json']
        a = bi.snapshot(files)
        files[0].write_text(files[0].read_text() + ' ')
        self.assertNotEqual(a, bi.snapshot(files))

    def test_pilot_ranking_prefers_ids_no_fx_and_fewer_steps(self):
        self.fx.add('Big', steps=5); self.fx.add('Small', steps=2); self.fx.add('Fx', steps=1, fx=True)
        self.fx.add('NoIds', steps=1, ids=False)
        inv = self.inventory()
        self.assertEqual([p['name'] for p in inv['pilot_candidates']], ['Small', 'Big', 'Fx'])
        self.assertTrue(all(p['reasons'] for p in inv['pilot_candidates']))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg required')
    def test_probe_media_reads_real_mp4(self):
        self.fx.add('Probe')
        mp4 = self.fx.root / 'out/Probe/Probe.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=30:d=3.5',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.5',
                        '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(mp4)], check=True, timeout=60)
        it = self.item(self.inventory(probe_media=True), 'Probe')
        m = it['final_mp4']['probe']
        self.assertTrue(m['ok'], m)
        self.assertAlmostEqual(m['duration'], 3.5, delta=0.2)
        self.assertEqual(m['fps'], 30.0)
        self.assertGreater(m['frame_count'], 90)
        self.assertTrue(m['has_audio'])
        self.assertTrue(it['tiers']['visual_render_evidence']['value'], it)
        self.fx.add('Bogus')  # fake bytes -> probe fails -> blocker
        it = self.item(self.inventory(probe_media=True, only='Bogus'), 'Bogus')
        self.assertIn('final_mp4_probe_failed', it['blockers'])
        self.assertFalse(it['tiers']['visual_render_evidence']['value'])

    def test_import_is_side_effect_free(self):
        code = ("import subprocess, os, builtins\n"
                "def boom(*a, **k): raise AssertionError('side effect')\n"
                "subprocess.run = subprocess.check_output = subprocess.Popen = boom\n"
                "os.utime = os.unlink = os.remove = os.rename = os.chmod = os.mkdir = os.makedirs = boom\n"
                "import renderer.baseline_inventory\n")
        subprocess.run([sys.executable, '-c', code], check=True, cwd=REPO)


if __name__ == '__main__':
    unittest.main()
