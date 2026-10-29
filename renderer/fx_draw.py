"""Import-safe access to assemble.py's Extra FX drawing code, for LOCAL single-slide donor renders.

renderer/assemble.py stays the single source of truth but is never imported or executed: its import
parses argv, prunes/touches out/_cache, plans narration (paid TTS/network) and writes out/<name>.
Instead this module parses its source with `ast`, takes ONLY the drawing functions below and the
literal constants they read, compiles them into a fresh controlled namespace with explicitly frozen
switches (FX/CAMERA on, NEEDS_DRAWN_HIGHLIGHT from the report's source) and explicit `out`/`tmp`
directories (scratch only). It fails closed when:
  - a function or constant is missing or defined more than once at module level,
  - a constant is not a pure literal (ast.literal_eval),
  - the few non-literal statements we reproduce (font, FX/CAMERA/NEEDS_DRAWN_HIGHLIGHT) changed shape,
  - any extracted function reads a global that the frozen namespace does not provide (symtable).
No I/O happens at import time.
"""
import ast
import builtins
import copy
import hashlib
import json
import math
import subprocess
import symtable
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSEMBLE = ROOT / 'renderer' / 'assemble.py'
NAMESPACE_MODULE = 'renderer.fx_draw.frozen_assemble'

FUNCTIONS = ('caption_png', 'highlight_png', 'fx_big', 'cam_clamp', 'fx_spotlight_png', 'fx_ripple', 'fx_view_at',
             'cam_view_at', 'render_camera_segment', 'fit_slide_to_frame')
CONSTANTS = ('W', 'H', 'FPS', 'XF', 'FONT', 'HOLD_NO_NARR', 'PAD_AFTER', 'CAM_MOVE', 'CAM_DRIFT', 'CAM_ZMAX', 'CAM_SS',
             'CAPTION_SAFE', 'FX_MOVE', 'FX_DIM', 'FX_BLUR', 'FX_MAX_UPSCALE', 'FX_SCREEN_MAD', 'FX_AREA_MIN_Z', 'FX_PAN',
             'FX_SCREEN_DRIFT', 'CAP_CLEAR', 'SEG_ENCODE', 'INTERMEDIATE_ENCODE')
# Non-literal module statements whose exact shape is pinned; their value is supplied explicitly.
PINNED = {
    'font': 'font = ImageFont.truetype(FONT, 40)',
    'FX': "FX = bool(rep.get('fx')) or '--fx' in args",
    'CAMERA': "CAMERA = FX or bool(rep.get('camera')) or '--camera' in args",
    'NEEDS_DRAWN_HIGHLIGHT': "NEEDS_DRAWN_HIGHLIGHT = rep.get('source') == 'recording'",
}
MODULES = ('math', 'subprocess', 'textwrap')
PIL_NAMES = ('Image', 'ImageChops', 'ImageDraw', 'ImageFilter', 'ImageFont', 'ImageStat')


def _names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        return [n for e in target.elts for n in _names(e)]
    return []


def _assignments(tree):
    """name -> list of (Assign node, value node) for every module-level binding."""
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    found.setdefault(t.id, []).append((node, node.value))
                elif isinstance(t, (ast.Tuple, ast.List)):
                    if isinstance(node.value, (ast.Tuple, ast.List)) and len(node.value.elts) == len(t.elts):
                        for e, v in zip(t.elts, node.value.elts):
                            for n in _names(e):
                                found.setdefault(n, []).append((node, v if isinstance(e, ast.Name) else None))
                    else:
                        for n in _names(t):
                            found.setdefault(n, []).append((node, None))
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            for n in _names(node.target):
                found.setdefault(n, []).append((node, None))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.setdefault(node.name, []).append((node, None))
        elif isinstance(node, (ast.For, ast.With, ast.If, ast.While, ast.Try)):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                    found.setdefault(sub.id, []).append((node, None))
    return found


class Drawer:
    def __init__(self, ns, sources, constants, font_layout):
        self.ns, self.sources, self.constants, self.font_layout = ns, sources, constants, font_layout
        self.source_hashes = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in sources.items()}

    def fingerprint(self):
        return hashlib.sha256(json.dumps({'sources': self.source_hashes, 'constants': self.constants, 'font_layout': self.font_layout}, sort_keys=True).encode()).hexdigest()


FONT_LAYOUTS = ('basic', 'raqm')


def load(*, out_dir, tmp_dir, needs_drawn_highlight, font_layout='basic', source=ASSEMBLE):
    """Build a frozen namespace with assemble.py's drawing functions. `out_dir`/`tmp_dir` become the
    functions' `out`/`tmp` globals (render_camera_segment reads out/slides/<file>, writes tmp/hl*.png,
    tmp/spot*.png and out/annotated/<file>).

    font_layout pins Pillow's text layout engine. assemble.py's `ImageFont.truetype(FONT, 40)` picks RAQM
    whenever libraqm+libfribidi load at runtime, else BASIC, so the SAME code renders different caption
    glyph positions depending on whether Homebrew's fribidi is installed. The pilot (Oct 20) was rendered
    with BASIC (fribidi was installed later); the donor must use the baseline's engine, never the
    machine's current default."""
    ns, sources, constants, _ = _extract(source, FUNCTIONS, out_dir=out_dir, tmp_dir=tmp_dir,
                                         needs_drawn_highlight=needs_drawn_highlight, font_layout=font_layout)
    return Drawer(ns, sources, constants, font_layout)


def _extract(source, functions, *, out_dir, tmp_dir, needs_drawn_highlight, font_layout, extra=None, orchestration=False):
    """Shared fail-closed extraction: literal constants + named function defs (+ optionally the pinned module-level
    planning statements) compiled into one fresh namespace. `extra` adds explicitly frozen globals."""
    if type(needs_drawn_highlight) is not bool:
        raise ValueError('needs_drawn_highlight_must_be_bool')
    if font_layout not in FONT_LAYOUTS:
        raise ValueError('unsupported_font_layout')
    text = Path(source).read_text()
    tree = ast.parse(text, filename=str(source))
    found = _assignments(tree)
    constants = {}
    for name in CONSTANTS:
        hits = found.get(name, [])
        if not hits:
            raise ValueError(f'missing_constant:{name}')
        if len(hits) != 1:
            raise ValueError(f'ambiguous_constant:{name}')
        node, value = hits[0]
        if value is None:
            raise ValueError(f'non_literal_constant:{name}')
        try:
            constants[name] = ast.literal_eval(value)
        except ValueError:
            raise ValueError(f'non_literal_constant:{name}') from None
    for name, expected in PINNED.items():
        hits = found.get(name, [])
        if len(hits) != 1 or ast.dump(hits[0][0]) != ast.dump(ast.parse(expected).body[0]):
            raise ValueError(f'unexpected_statement:{name}')
    defs, sources = [], {}
    for name in functions:
        hits = [n for n, _ in found.get(name, []) if isinstance(n, ast.FunctionDef)]
        if not hits:
            raise ValueError(f'missing_function:{name}')
        if len(found[name]) != 1:
            raise ValueError(f'ambiguous_function:{name}')
        fn = hits[0]
        if fn.decorator_list:
            raise ValueError(f'decorated_function:{name}')
        defs.append(fn)
        sources[name] = ast.get_source_segment(text, fn)
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat
    pil = dict(Image=Image, ImageChops=ImageChops, ImageDraw=ImageDraw, ImageFilter=ImageFilter, ImageFont=ImageFont, ImageStat=ImageStat)
    out, tmp = Path(out_dir), Path(tmp_dir)
    ns = {'__name__': NAMESPACE_MODULE, '__builtins__': builtins, 'math': math, 'subprocess': subprocess, 'textwrap': textwrap,
          **pil, **copy.deepcopy(constants), 'FX': True, 'CAMERA': True, 'NEEDS_DRAWN_HIGHLIGHT': needs_drawn_highlight,
          'out': out, 'tmp': tmp, **(extra or {})}
    engine = ImageFont.Layout.BASIC if font_layout == 'basic' else ImageFont.Layout.RAQM
    ns['font'] = ImageFont.truetype(constants['FONT'], 40, layout_engine=engine)
    provided = set(ns) | set(functions) | set(dir(builtins))
    for name, src in sources.items():
        for g in _function_globals(src):
            if g not in provided:
                raise ValueError(f'unresolved_global:{name}:{g}')
    code = compile(ast.Module(body=defs, type_ignores=[]), f'<{Path(source).name}:fx_draw>', 'exec')
    exec(code, ns)
    orch = None
    if orchestration:
        stmts = _orchestration(tree)
        sources['<orchestration>'] = '\n'.join(ast.get_source_segment(text, n) for n in stmts)
        stored = {n.id for st in stmts for n in ast.walk(st) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
        for n in (n for st in stmts for n in ast.walk(st) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)):
            if n.id not in stored and n.id not in provided | {'slides'}:
                raise ValueError(f'unresolved_global:<orchestration>:{n.id}')
        orch = compile(ast.Module(body=stmts, type_ignores=[]), f'<{Path(source).name}:fx_plan_orchestration>', 'exec')
    out.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)
    return ns, sources, constants, orch


# ---------- camera / FX planning (re-plan a changed screen through assemble's own planner) ----------

PLAN_FUNCTIONS = ('cam_fit', 'cam_views', 'fx_union', 'fx_area_zoom', 'fx_area_view', 'fx_plan', 'cam_caption_top')
# The only report fields the planning code may read; anything else raises at plan time (fail closed).
REPORT_FIELDS = ('no_captions', 'caption_pos')
# assemble.py's module-level planning sequence (after narration timing, before segments). Executed verbatim from the
# parsed source; its exact shape is pinned so any change to the orchestration fails closed.
ORCHESTRATION = """
for s in slides:
    fit_slide_to_frame(s)
if CAMERA:
    cam_views(slides)
if FX:
    fx_camera_plan = fx_plan(slides)
if CAMERA:
    for s in slides:
        s['_cap_top'] = cam_caption_top(s)
    i = 0
    while i < len(slides):
        j = i
        while j + 1 < len(slides) and slides[i]['_cap_text'] and slides[j + 1]['_cap_text'] == slides[i]['_cap_text']:
            j += 1
        if any(slides[k]['_cap_top'] for k in range(i, j + 1)):
            for k in range(i, j + 1):
                slides[k]['_cap_top'] = True
        i = j + 1
"""
PLAN_FIELDS = ('target', 'viewport', '_target_shifted', '_cam', '_fx', '_cap_edges', '_cap_text', '_cap_top')


def _orchestration(tree):
    want = [ast.dump(n) for n in ast.parse(ORCHESTRATION).body]
    body = list(tree.body)
    hits = [i for i in range(len(body) - len(want) + 1) if [ast.dump(n) for n in body[i:i + len(want)]] == want]
    if len(hits) != 1:
        raise ValueError('unexpected_orchestration')
    return body[hits[0]:hits[0] + len(want)]


class FrozenReport:
    """Stands in for assemble's `rep` inside the planner: only REPORT_FIELDS are readable."""

    def __init__(self, fields):
        bad = set(fields) - set(REPORT_FIELDS)
        if bad:
            raise ValueError(f'unsupported_report_field:{sorted(bad)}')
        self._fields = dict(fields)

    def get(self, key, default=None):
        if key not in REPORT_FIELDS:
            raise ValueError(f'unprovided_report_field:{key}')
        return self._fields.get(key, default)

    def __getitem__(self, key):
        raise ValueError(f'unprovided_report_field:{key}')

    def as_dict(self):
        return dict(self._fields)


class Planner:
    def __init__(self, ns, sources, constants, font_layout, orchestration, report, args):
        self.ns, self.sources, self.constants, self.font_layout = ns, sources, constants, font_layout
        self._orch, self.report, self.args = orchestration, report, args
        self.source_hashes = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in sources.items()}

    def fingerprint(self):
        return hashlib.sha256(json.dumps({'sources': self.source_hashes, 'constants': self.constants, 'font_layout': self.font_layout,
                                          'report': self.report, 'args': list(self.args)}, sort_keys=True).encode()).hexdigest()

    def replan(self, slides):
        """Run assemble's planning sequence on a COPY of report-style slides whose PNGs are in out/slides (padded in
        place by fit_slide_to_frame, exactly like assemble). Returns (planned slides, fx_plan screens)."""
        work = json.loads(json.dumps(slides))
        self.ns['slides'] = work
        try:
            exec(self._orch, self.ns)
            screens = self.ns['fx_camera_plan']
        finally:
            for k in ('slides', 'fx_camera_plan', 's', 'i', 'j', 'k'):
                self.ns.pop(k, None)
        return work, screens


def load_planner(*, out_dir, tmp_dir, needs_drawn_highlight, report=None, args=(), font_layout='basic', source=ASSEMBLE):
    """assemble's camera/FX planner (cam_views, fx_plan, cam_caption_top, fit_slide_to_frame and the module-level
    sequence that calls them), ast-extracted like load(). `rep` is a FrozenReport (REPORT_FIELDS only) and `args` an
    explicit tuple (render.sh passes none). Fails closed like load() and on a changed orchestration."""
    rep = FrozenReport(report or {})
    args = tuple(args)
    ns, sources, constants, orch = _extract(source, FUNCTIONS + PLAN_FUNCTIONS, out_dir=out_dir, tmp_dir=tmp_dir,
                                            needs_drawn_highlight=needs_drawn_highlight, font_layout=font_layout,
                                            extra={'rep': rep, 'args': args}, orchestration=True)
    return Planner(ns, sources, constants, font_layout, orch, rep.as_dict(), args)


def plan_view(s):
    """The persisted plan fields of one slide, JSON-normalised (tuples -> lists) for exact comparison."""
    return json.loads(json.dumps({k: s[k] for k in PLAN_FIELDS if k in s}))


def render_view(s):
    """plan_view minus what the Extra FX drawing never reads: with FX on, cam_view_at/render_camera_segment/
    cam_caption_top take only the slide size from `_cam` (the start/end views feed the non-FX camera). `_cam`'s start
    view chains across screens when two consecutive captures are byte-identical (cam_views' `same`), so a re-plan can
    change it on a slide whose pixels cannot change; that is reported, not rendered."""
    v = plan_view(s)
    if '_cam' in v:
        v['_cam'] = v['_cam'][2]
    return v


def _function_globals(src):
    names, stack = set(), list(symtable.symtable(src, '<fn>', 'exec').get_children())
    while stack:
        t = stack.pop()
        for sym in t.get_symbols():
            if sym.is_global() or (sym.is_referenced() and not (sym.is_local() or sym.is_free() or sym.is_parameter())):
                names.add(sym.get_name())
        stack.extend(t.get_children())
    return names


# ---------- pure ports (tested against real report.json) ----------

def js_round(x):
    return math.floor(x + 0.5)


def from_recording_slide(step, slide_no, png_size, captions_from_narration):
    """Port of renderer/from-recording.mjs's per-step report slide (geometry in PNG pixels)."""
    pw, ph = png_size
    geom = step['target']['hint'] if (step.get('target') or {}).get('hint', {}).get('bbox') else (step.get('target') or {})
    bbox, vp = geom.get('bbox'), geom.get('viewport')
    sx = pw / vp['w'] if vp and vp.get('w') else (step.get('dpr') or 1)
    sy = ph / vp['h'] if vp and vp.get('h') else (step.get('dpr') or 1)
    target = ({'x': js_round(bbox['x'] * sx), 'y': js_round(bbox['y'] * sy), 'width': js_round(bbox['w'] * sx),
               'height': js_round(bbox['h'] * sy)} if bbox else None)
    return {'slide': slide_no, 'step': step['index'], 'phase': 'pre', 'file': f'slide_{slide_no:02d}.png', 'src': step['media']['pre'],
            'narration': step.get('narration') or '',
            'caption': (step.get('narration') if captions_from_narration else step.get('caption')) or step.get('narration') or '',
            'target': target, 'viewport': {'width': pw, 'height': ph}, 'route': step.get('route'), 'action': step.get('action') or None}


def thumb(path):
    from PIL import Image
    return Image.open(path).convert('L').resize((160, 90), Image.Resampling.BILINEAR)


def starts_new_screen(prev, prev_png, cur, cur_png, mad_limit):
    """fx_plan's screen rule (assemble.py, re-stated; FX_SCREEN_MAD comes from the parsed source)."""
    from PIL import ImageChops, ImageStat
    if prev is None:
        return True
    if cur.get('viewport') != prev.get('viewport'):
        return True
    r0, r1 = prev.get('route'), cur.get('route')
    mad = ImageStat.Stat(ImageChops.difference(thumb(prev_png), thumb(cur_png))).mean[0]
    return bool(r0 and r1 and r0 != r1) or mad > mad_limit


# ---------- rendering through the frozen namespace ----------

def frozen_slide(entry):
    """Only the persisted plan fields assemble's segment drawing reads; JSON round-trip (lists for tuples)."""
    keep = ('slide', 'file', 'narration', 'caption', 'caption_pos', 'target', 'viewport', 'route', 'action', 'sdur',
            '_cam', '_fx', '_cap_edges', '_cap_text', '_cap_top')
    for k in ('slide', 'file', 'sdur', '_cam', '_fx', '_cap_edges', '_cap_text', '_cap_top'):
        if k not in entry:
            raise ValueError(f'missing_frozen_field:{k}')
    return json.loads(json.dumps({k: entry[k] for k in keep if k in entry}))


def render_segment(drawer, s, seg, caption_pos=None, no_captions=False):
    """assemble._render_segment's CAMERA branch for a PNG slide: caption card, then render_camera_segment."""
    ns = drawer.ns
    if str(s['file']).endswith('.mp4'):
        raise ValueError('unsupported_clip_slide')
    cap = s.get('caption') or s.get('narration')
    cp = None
    if cap and not no_captions:
        pos = s.get('caption_pos') or caption_pos or 'center'
        cp = ns['tmp'] / f"cap{s['slide']:02d}.png"
        ns['caption_png'](cap, cp, pos=pos)
    return ns['render_camera_segment'](s, Path(seg), cp)


def xfade_command(segs, sdurs, output, xf, fps, encode):
    """assemble.py's content stitch (step 3 tail), verbatim filter graph."""
    ins = []
    for p in segs:
        ins += ['-i', str(p)]
    chain, prev, offset = [], '[0:v]', 0.0
    for i in range(1, len(segs)):
        offset += sdurs[i - 1] - xf
        lbl = f'[x{i}]' if i < len(segs) - 1 else '[v]'
        chain.append(f"{prev}[{i}:v]xfade=transition=fade:duration={xf}:offset={offset:.3f}{lbl}")
        prev = lbl
    return ['ffmpeg', '-y', *ins, '-filter_complex', ';'.join(chain), '-map', '[v]', '-r', str(fps), *encode, '-pix_fmt', 'yuv420p', str(output)]


# ---------- evidence helpers ----------

def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def snapshot(paths):
    return {str(p): {'sha256': sha256_file(p), 'size': Path(p).stat().st_size, 'mtime_ns': Path(p).stat().st_mtime_ns} for p in paths}


def sh(*args, timeout=900, cwd=None):
    return subprocess.check_output([str(x) for x in args], stderr=subprocess.PIPE, timeout=timeout, cwd=cwd)


def framehashes(path):
    from .preservation import frames
    return [r[-1] for r in frames(path)[1]]


def window_quality(a, a0, b, b0, n, workdir, tag='w'):
    """PSNR/SSIM of a[a0:a0+n] vs b[b0:b0+n] (frame indices), per frame."""
    import re
    wd, a, b = Path(workdir), Path(a).resolve(), Path(b).resolve()
    pl, sl = f'{tag}-psnr.log', f'{tag}-ssim.log'
    sh('ffmpeg', '-nostdin', '-v', 'error', '-i', a, '-i', b, '-lavfi',
       f'[0:v]trim=start_frame={a0}:end_frame={a0 + n},setpts=PTS-STARTPTS,split[a0][a1];'
       f'[1:v]trim=start_frame={b0}:end_frame={b0 + n},setpts=PTS-STARTPTS,split[b0][b1];'
       f'[a0][b0]psnr=stats_file={pl};[a1][b1]ssim=stats_file={sl}', '-f', 'null', '-', cwd=wd)
    psnr = [float(re.search(r'psnr_avg:(\S+)', l).group(1)) for l in (wd / pl).read_text().splitlines() if l.strip()]
    ssim = [float(re.search(r'All:(\S+)', l).group(1)) for l in (wd / sl).read_text().splitlines() if l.strip()]
    fin = [p for p in psnr if p != float('inf')]
    return {'frames': len(psnr), 'psnr_min': round(min(fin), 3) if fin else 'inf', 'psnr_mean': round(sum(fin) / len(fin), 3) if fin else 'inf',
            'psnr_infinite_frames': len(psnr) - len(fin), 'ssim_min': round(min(ssim), 6) if ssim else None,
            'ssim_mean': round(sum(ssim) / len(ssim), 6) if ssim else None, 'psnr_per_frame': [None if p == float('inf') else round(p, 2) for p in psnr]}


# ---------- golden fidelity on a real (read-only) render ----------

def golden_fidelity(pilot_dir, output, font_layout='basic'):
    """Re-render every slide segment of out/<name> from its slides/ PNGs + persisted assembly plan into a
    NEW scratch directory and compare with the real _build artifacts. Reads the pilot read-only."""
    from concurrent.futures import ThreadPoolExecutor
    from . import fx_scope
    pilot, out = Path(pilot_dir), Path(output)
    out.mkdir()  # exclusive
    assembly = json.loads((pilot / 'assembly.json').read_bytes())
    report = json.loads((pilot / 'report.json').read_bytes())
    if assembly.get('fx') is not True:
        raise ValueError('unsupported_non_fx_render')
    work = out / 'out'
    (work / 'slides').mkdir(parents=True)
    for s in assembly['slides']:
        (work / 'slides' / s['file']).write_bytes((pilot / 'slides' / s['file']).read_bytes())
    d = load(out_dir=work, tmp_dir=work / '_build', needs_drawn_highlight=report.get('source') == 'recording', font_layout=font_layout)
    slides = [frozen_slide(s) for s in assembly['slides']]
    segs = [work / '_build' / f"seg{s['slide']:02d}.mp4" for s in slides]
    with ThreadPoolExecutor(max_workers=len(slides)) as pool:
        list(pool.map(lambda a: render_segment(d, *a, caption_pos=report.get('caption_pos'), no_captions=bool(report.get('no_captions'))),
                      zip(slides, segs)))
    res = {'drawer_fingerprint': d.fingerprint(), 'font_layout': font_layout, 'source_hashes': d.source_hashes, 'segments': {}}
    for s, seg in zip(slides, segs):
        gold = pilot / '_build' / seg.name
        a, b = framehashes(seg), framehashes(gold)
        r = {'frames': len(a), 'golden_frames': len(b), 'frame_count_equal': len(a) == len(b),
             'expected_frames': int(round(s['sdur'] * 30)), 'equal_frames': sum(x == y for x, y in zip(a, b)),
             'decoded_frames_equal': a == b, 'bitstream_sha256_equal': sha256_file(seg) == sha256_file(gold)}
        if a != b:
            r['quality'] = {k: v for k, v in window_quality(seg, 0, gold, 0, min(len(a), len(b)), out, f'seg{s["slide"]:02d}').items() if k != 'psnr_per_frame'}
        res['segments'][f"slide-{s['slide']:02d}"] = r
    ov = {}
    for p in sorted((pilot / '_build').glob('*.png')):
        mine = work / '_build' / p.name
        ov[p.name] = mine.is_file() and mine.read_bytes() == p.read_bytes()
    ann = {}
    if (pilot / 'annotated').is_dir():
        for p in sorted((pilot / 'annotated').iterdir()):
            mine = work / 'annotated' / p.name
            ann[p.name] = mine.is_file() and mine.read_bytes() == p.read_bytes()
    res['overlays'] = {'files': ov, 'annotated': ann, 'captions_byte_equal': all(v for k, v in ov.items() if k.startswith('cap')),
                       'all_byte_equal': all(ov.values()) and all(ann.values())}
    # content dissolves, exactly as assemble stitches them
    video = work / '_build' / 'video.mp4'
    ns = d.ns
    sh(*xfade_command(segs, [s['sdur'] for s in slides], video, ns['XF'], ns['FPS'], ns['INTERMEDIATE_ENCODE']))
    a, b = framehashes(video), framehashes(pilot / '_build' / 'video.mp4')
    res['content_video'] = {'frames': len(a), 'golden_frames': len(b), 'decoded_frames_equal': a == b,
                            'equal_frames': sum(x == y for x, y in zip(a, b))}
    # the dirty window of a slide-02 screenshot-only change, mapped into the final MP4
    final = pilot / f'{pilot.name}.mp4'
    n = len(framehashes(final))
    mid = assembly['slides'][len(assembly['slides']) // 2]
    sc = fx_scope.closure(assembly, {fx_scope.slide_id(mid): {'screenshot_changed': True, 'target_changed': False}}, n)
    (lo, hi), c0 = sc['dirty_frames'][0], sc['timeline']['content_start_frame']
    q = window_quality(video, lo - c0, final, lo, hi - lo, out, 'final')
    ref = window_quality(pilot / '_build' / 'video.mp4', lo - c0, final, lo, hi - lo, out, 'ref')
    res['final_window'] = {'final_frames': n, 'content_start_frame': c0, 'window': [lo, hi], 'content_window': [lo - c0, hi - c0],
                           **{k: v for k, v in q.items() if k != 'psnr_per_frame'}, 'psnr_per_frame': q['psnr_per_frame'],
                           'reference_real_video_mp4_vs_final': {k: v for k, v in ref.items() if k != 'psnr_per_frame'},
                           'note': 'final passed through 3 more crossfade encodes (2x ultrafast crf12 + fast crf18), so not bit-identical'}
    res['ok'] = (all(r['decoded_frames_equal'] for r in res['segments'].values()) and res['overlays']['captions_byte_equal']
                 and res['content_video']['decoded_frames_equal'])
    (out / 'golden-fidelity.json').write_text(json.dumps(res, indent=2) + '\n')
    return res


# ---------- re-plan golden on a real (read-only) render ----------

def captured_steps(script):
    return [st for st in script['steps'] if st.get('capture') is not False and (st.get('media') or {}).get('pre')]


def report_slides(assembly, script, png_sizes):
    """from-recording.mjs report slides (pre-fit) for every assembly slide, with the assembly's FROZEN timing (sdur) and
    any per-slide caption_pos/camera override it carried. `png_sizes`: slide number -> (w, h) of the capture used."""
    caps = captured_steps(script)
    slides = assembly['slides']
    if len(caps) != len(slides):
        raise ValueError('assembly_script_mismatch')
    out = []
    cfn = bool(script.get('captionsFromNarration'))
    for st, a in zip(caps, slides):
        if a.get('step') != st['index']:
            raise ValueError('assembly_script_mismatch')
        rs = from_recording_slide(st, a['slide'], png_sizes[a['slide']], cfn)
        rs['sdur'] = a['sdur']
        for k in ('caption_pos', 'camera'):
            if k in a:
                rs[k] = a[k]
        out.append(rs)
    return out


def plan_diff(planned, persisted):
    """[{slide, field, replanned, persisted}] for every persisted plan field that differs."""
    diff = []
    for p, a in zip(planned, persisted):
        x, y = plan_view(p), plan_view(a)
        for k in sorted(set(x) | set(y)):
            if x.get(k) != y.get(k):
                diff.append({'slide': a['slide'], 'field': k, 'replanned': x.get(k), 'persisted': y.get(k)})
    return diff


def replan_golden(repo, name, output, render_segments=True, font_layout='basic'):
    """Re-plan out/<name> from its ORIGINAL recording captures + script through assemble's own planner and compare
    every persisted _cam/_fx/_cap_*/target/viewport; optionally re-render each segment from the RE-PLANNED entries and
    compare with _build/segNN.mp4. Everything real is read-only (snapshotted); output is a NEW scratch directory."""
    from concurrent.futures import ThreadPoolExecutor
    repo = Path(repo)
    pilot = repo / 'out' / name
    script_path = repo / 'scripts' / f'{name}.script.json'
    script = json.loads(script_path.read_bytes())
    rec = repo / 'out' / '_recordings' / script['recording']['id']
    assembly = json.loads((pilot / 'assembly.json').read_bytes())
    report = json.loads((pilot / 'report.json').read_bytes())
    real = [script_path, pilot / 'assembly.json', pilot / 'report.json', ASSEMBLE,
            *sorted(p for p in rec.iterdir() if p.is_file()), *sorted((pilot / 'slides').iterdir()),
            *sorted(p for p in (pilot / '_build').iterdir() if p.name.startswith('seg'))]
    before = snapshot(real)
    out = Path(output)
    out.mkdir()  # exclusive
    work = out / 'out'
    (work / 'slides').mkdir(parents=True)
    from PIL import Image
    import numpy as np
    sizes, slide_pixels_equal = {}, {}
    for st, a in zip(captured_steps(script), assembly['slides']):
        src = rec / st['media']['pre']
        (work / 'slides' / a['file']).write_bytes(src.read_bytes())
        with Image.open(src) as im:
            sizes[a['slide']] = im.size
    fields = {k: report[k] for k in REPORT_FIELDS if k in report}
    planner = load_planner(out_dir=work, tmp_dir=work / '_build', needs_drawn_highlight=report.get('source') == 'recording',
                           report=fields, font_layout=font_layout)
    planned, screens = planner.replan(report_slides(assembly, script, sizes))
    for a in assembly['slides']:  # the padded slide the segments read vs the real out/<name>/slides/<file>
        x = np.asarray(Image.open(work / 'slides' / a['file']).convert('RGB'))
        y = np.asarray(Image.open(pilot / 'slides' / a['file']).convert('RGB'))
        slide_pixels_equal[a['file']] = x.shape == y.shape and bool((x == y).all())
    diff = plan_diff(planned, assembly['slides'])
    res = {'name': name, 'planner_fingerprint': planner.fingerprint(), 'report_fields': fields, 'args': list(planner.args),
           'font_layout': font_layout, 'plan_equal': not diff, 'plan_diff': diff, 'slides_compared': len(planned),
           'fields_compared': list(PLAN_FIELDS), 'screens': screens, 'slide_pixels_equal': slide_pixels_equal, 'segments': {}}
    if render_segments:
        d = load(out_dir=work, tmp_dir=work / '_build', needs_drawn_highlight=report.get('source') == 'recording', font_layout=font_layout)
        entries = [frozen_slide(s) for s in planned]
        segs = [work / '_build' / f"seg{s['slide']:02d}.mp4" for s in entries]
        with ThreadPoolExecutor(max_workers=len(entries)) as pool:
            list(pool.map(lambda x: render_segment(d, *x, caption_pos=report.get('caption_pos'), no_captions=bool(report.get('no_captions'))),
                          zip(entries, segs)))
        for s, seg in zip(entries, segs):
            gold = pilot / '_build' / seg.name
            a, b = framehashes(seg), framehashes(gold)
            res['segments'][f"slide-{s['slide']:02d}"] = {'frames': len(a), 'decoded_frames_equal': a == b,
                                                          'bitstream_sha256_equal': sha256_file(seg) == sha256_file(gold)}
    after = snapshot(real)
    res['source_unchanged'] = before == after
    res['ok'] = bool(res['plan_equal'] and res['source_unchanged'] and all(v['decoded_frames_equal'] for v in res['segments'].values()))
    (out / 'replan-golden.json').write_text(json.dumps(res, indent=2, default=str) + '\n')
    return res
