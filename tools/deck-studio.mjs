// Hadrius Studio — Create ✨: AI-built slide decks from the screenshots already captured by every
// recorded walkthrough (out/_recordings/<recording>/step_<id>.png, mirrored in the Drive
// "_recordings" folder) and the step data in the shared script library.
//
// Flow, all driven from the side panel's Create tab:
//   1. POST /decks/plan      describe a workflow or module -> Claude picks the recordings that cover
//                            it and drafts an outline (sections -> slides -> recorded steps).
//   2. the user reviews the outline (accept / revise with feedback / remove slides)
//   3. POST /decks/:id/build Claude writes the slide copy per section, reading the real
//                            hadrius_frontend components through the hadrius-codebase MCP so every
//                            button name, menu item and behavior is checked against the code; every
//                            **bold** UI label is then audited (recorded label or cited source file,
//                            else a second targeted code check that confirms, corrects, or unbolds it)
//   4. renderer/deck.py      marks up the screenshots from recorded DOM boxes (OCR fallback), builds
//                            the editable .pptx, exports the PDF, renders page thumbnails.
//
// Nothing here writes to the library, Drive, or Pylon: decks live in out/_decks/<id>/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

const CODEBASE_TOOLS = [
  'mcp__hadrius-codebase__search_code',
  'mcp__hadrius-codebase__read_file',
  'mcp__hadrius-codebase__file_tree',
  'mcp__hadrius-codebase__list_directory',
  'mcp__hadrius-codebase__list_repos',
].join(',');

const STYLES = {
  standard: 'Standard: balanced. One screenshot per slide with numbered red boxes; a short numbered step list beside it; an optional one-line tip.',
  detailed: 'Detailed: text-rich. Each slide explains the purpose, every step in one or two full sentences including what happens next, plus context (permissions, rules, gotchas). Screenshots carry light outline markup only.',
  visual: 'Visual: screenshots only, maximum markup. Full-width screenshot, spotlighted red boxes, numbered badges and short callout labels drawn on the image. No paragraphs, no step lists, no concept slides.',
};
const AUDIENCES = {
  admin: 'Admins: compliance team members who configure Hadrius and review/approve employee activity. Include setup and configuration, review queues and settings.',
  employee: 'Employees: end users who submit, attest and respond (disclosures, certifications, marketing submissions, onboarding tasks). Leave out admin-only configuration, settings and review/approval screens; if a request is admin-only, say so in "gaps".',
  both: 'Both admins and employees: a generalized guide. Where a section is role-specific, say who it is for in the section title (for example "For admins: ...").',
};
const LENGTHS = {
  auto: 'Pick the size the request implies: a single workflow is 3-6 content slides; a feature area is 8-20; a whole-module "getting started" guide is 30-60.',
  quick: '3-5 content slides, one section.',
  standard: '10-20 content slides in 2-5 sections.',
  complete: '35-60 content slides covering the whole area end to end, in 4-8 sections.',
};

// Curated starters. Only the ones whose keywords match a recorded walkthrough are offered.
const CURATED = [
  { label: 'Getting started with People Oversight', module: 'People oversight', audience: 'admin', kw: ['people directory', 'disclosure', 'certification'] },
  { label: 'Getting started with Marketing Review', module: 'Marketing', audience: 'both', kw: ['marketing project', 'marketing document'] },
  { label: 'Getting started with the Testing Program', module: 'Testing program', audience: 'admin', kw: ['test', 'calendar', 'control'] },
  { label: 'Getting started with Branches', module: 'Branches', audience: 'admin', kw: ['branch'] },
  { label: 'Getting started with Communications', module: 'Communications', audience: 'admin', kw: ['email', 'case'] },
  { label: 'Getting started with Account Surveillance', module: 'Account surveillance', audience: 'admin', kw: ['surveillance', 'exception'] },
  { label: 'How to import employees', module: 'People oversight', audience: 'admin', kw: ['import employees'] },
  { label: 'How to configure trade restrictions', module: 'People oversight', audience: 'admin', kw: ['restricted list', 'trade monitoring', 'trading rule'] },
  { label: 'How to launch a certification campaign', module: 'People oversight', audience: 'admin', kw: ['certification campaign'] },
  { label: 'How to submit a disclosure', module: 'People oversight', audience: 'employee', kw: ['submit a disclosure', 'submitting disclosures'] },
  { label: 'How to complete and sign a certification', module: 'People oversight', audience: 'employee', kw: ['completes and signs a certification'] },
  { label: 'How to submit marketing material for review', module: 'Marketing', audience: 'employee', kw: ['submitting a marketing project', 'new marketing project'] },
  { label: 'How to review and approve marketing documents', module: 'Marketing', audience: 'admin', kw: ['approve a marketing document', 'bulk approve'] },
  { label: 'How to build a disclosure template', module: 'People oversight', audience: 'admin', kw: ['disclosure template'] },
  { label: 'How to schedule and run a branch exam', module: 'Branches', audience: 'admin', kw: ['branch exam'] },
  { label: 'How to review flagged trades', module: 'People oversight', audience: 'admin', kw: ['flagged trades', 'compliant vs'] },
  { label: 'How to set up surveillance rules', module: 'Account surveillance', audience: 'admin', kw: ['surveillance rule', 'sandbox rules'] },
  { label: 'How to create a case in Communications', module: 'Communications', audience: 'admin', kw: ['new case', 'to a case'] },
  { label: 'How to set up groups and permissions', module: 'People oversight', audience: 'admin', kw: ['groups and custom permissions', 'roles vs. groups'] },
  { label: 'How to manage policies, risks and controls', module: 'Testing program', audience: 'admin', kw: ['policy', 'control'] },
  { label: 'How to connect brokerage accounts', module: 'People oversight', audience: 'employee', kw: ['connect brokerage'] },
  { label: 'Platform tour: finding your way around Hadrius', module: 'Platform', audience: 'both', kw: ['platform tour', 'navigation'] },
];

const MODULE_ALIASES = { 'people oversight': 'People oversight', 'testing program': 'Testing program', 'account surveillance': 'Account surveillance', marketing: 'Marketing', branches: 'Branches', communications: 'Communications', platform: 'Platform' };
const JUNK_TITLE = /^(test|untitled walkthrough|new voice test)$/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const now = () => new Date().toISOString();

export function createDeckStudio(deps) {
  const { REPO_ROOT, libraryFetch, hasLibrary, safeName, formatHumanTitle, googleDriveDownloadRecording, googleDriveConfigured, inferModuleFromScript, claudeEnv, extractJson, runGeminiPrompt, WHOAMI = 'unknown', drive } = deps;
  const DECKS_DIR = path.join(REPO_ROOT, 'out', '_decks');
  const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
  const RECORDINGS_DIR = path.join(REPO_ROOT, 'out', '_recordings');
  const jobs = new Map(); // id -> { state, children:Set, cancelled }

  // ------------------------------------------------------------------ persistence
  const deckDir = (id) => path.join(DECKS_DIR, id);
  function readState(id) { try { return JSON.parse(fs.readFileSync(path.join(deckDir(id), 'state.json'), 'utf8')); } catch { return null; } }
  function writeState(st) {
    fs.mkdirSync(deckDir(st.id), { recursive: true });
    st.updatedAt = now();
    const p = path.join(deckDir(st.id), 'state.json');
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(st, null, 2));
    fs.renameSync(`${p}.tmp`, p);
  }
  function getJob(id) {
    if (!jobs.has(id)) { const st = readState(id); if (!st) return null; jobs.set(id, { state: st, children: new Set(), cancelled: false }); }
    return jobs.get(id);
  }
  function progress(job, patch, line) {
    Object.assign(job.state, patch || {});
    if (line) { job.state.log = [...(job.state.log || []), `${new Date().toLocaleTimeString()}  ${line}`].slice(-80); console.log(`[decks ${job.state.id}] ${line}`); }
    writeState(job.state);
  }

  // ------------------------------------------------------------------ Claude
  let active = 0; const waiters = [];
  async function slot() { if (active < 3) { active++; return; } await new Promise((r) => waiters.push(r)); active++; }
  function release() { active--; const w = waiters.shift(); if (w) w(); }

  /** Claude CLI with the prompt on stdin (decks need prompts far past ARG_MAX), JSON reply parsed. */
  async function claudeJson(job, prompt, { tools = true, maxTurns = 60, timeoutMs = 15 * 60000, cwd } = {}) {
    if (job?.cancelled) throw new Error('cancelled');
    await slot();
    try {
      const text = await new Promise((resolve, reject) => {
        const args = ['-p', '--output-format', 'json', '--max-turns', String(maxTurns)];
        if (tools) args.push('--allowedTools', CODEBASE_TOOLS);
        const child = spawn('claude', args, { env: claudeEnv(), cwd: cwd || DECKS_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
        job?.children.add(child);
        let out = '', err = '';
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude took too long (timed out)')); }, timeoutMs);
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer); job?.children.delete(child);
          if (job?.cancelled) return reject(new Error('cancelled'));
          let parsed = null; try { parsed = JSON.parse(out); } catch { /* raw text */ }
          const result = parsed ? parsed.result : out;
          if (!result) return reject(new Error(`claude exited ${code}: ${clip(err || out, 300)}`));
          if (parsed?.is_error && !/[{[]/.test(String(result))) return reject(new Error(`claude: ${clip(result, 300)}`));
          resolve(String(result));
        });
        child.stdin.end(prompt);
      });
      return extractJson(text);
    } finally { release(); }
  }

  // ------------------------------------------------------------------ catalog
  // Teammates' scripts that this machine has never opened. Kept in a deck-only cache so the
  // working copies in scripts/ (the editor's files) are never touched.
  const LIB_CACHE = path.join(DECKS_DIR, '_library');
  let lastSync = 0;
  async function syncLibrary(log = () => {}) {
    if (!hasLibrary() || Date.now() - lastSync < 10 * 60000) return;
    lastSync = Date.now();
    let items = [];
    try { items = (await libraryFetch('GET'))?.items || []; } catch (e) { log(`library list failed: ${e.message}`); return; }
    const cached = (it) => path.join(LIB_CACHE, `${safeName(it.name)}.script.json`);
    const todo = items.filter((it) => {
      if (fs.existsSync(path.join(SCRIPTS_DIR, `${safeName(it.name)}.script.json`))) return false;
      if (!fs.existsSync(cached(it))) return true;
      try { const sc = JSON.parse(fs.readFileSync(cached(it), 'utf8')); return it.updated_at && sc.updatedAt && new Date(it.updated_at) - new Date(sc.updatedAt) > 60000 && (sc._fetchedAt || '') < it.updated_at; } catch { return true; }
    });
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (it) => {
        try {
          const sc = (await libraryFetch('GET', { name: it.name }))?.item?.script;
          if (sc?.steps) { fs.mkdirSync(LIB_CACHE, { recursive: true }); fs.writeFileSync(cached(it), JSON.stringify({ ...sc, _fetchedAt: now() }, null, 2)); }
        } catch (_) {}
      }));
    }
    if (todo.length) { catalogCache.at = 0; log(`pulled ${todo.length} teammate script(s) from the shared library`); }
  }

  function stepLabel(t) {
    t = t || {};
    return clip(t.name || t.text || t.label || t.placeholder || t.heading || t.testid || '', 80);
  }
  function moduleOf(sc) {
    const m = MODULE_ALIASES[String(sc.module || '').trim().toLowerCase()];
    if (m) return m;
    try { const inf = inferModuleFromScript(sc); if (inf) return inf; } catch (_) {}
    return 'Other';
  }

  let catalogCache = { at: 0, entries: [] };
  function loadCatalog() {
    if (Date.now() - catalogCache.at < 30000) return catalogCache.entries;
    const byTitle = new Map();
    const files = [];
    const seenFiles = new Set();
    for (const dir of [SCRIPTS_DIR, LIB_CACHE]) {
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.script.json') && !seenFiles.has(f)) { seenFiles.add(f); files.push([dir, f]); }
    }
    for (const [dir, f] of files) {
      let sc; try { sc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const recordingId = sc.recording?.id;
      const steps = (sc.steps || []).map((s, i) => ({
        i, action: s.action || '', label: stepLabel(s.target), role: s.target?.role || '', route: s.route || '',
        narration: clip(s.narration || s.caption || '', 200), pre: s.media?.pre || null,
        bbox: s.target?.hint?.bbox || null, viewport: s.target?.hint?.viewport || null, inDialog: !!s.target?.inDialog,
      }));
      const title = formatHumanTitle(sc.title || sc.name || f.replace('.script.json', ''));
      if (!recordingId || steps.length < 2 || JUNK_TITLE.test(title.trim()) || !steps.some((s) => s.pre)) continue;
      const entry = { name: sc.name || f.replace('.script.json', ''), title, module: moduleOf(sc), recordingId, updatedAt: sc.updatedAt || sc.createdAt || null, steps, boxed: steps.filter((s) => s.bbox).length };
      const key = norm(title);
      const prev = byTitle.get(key);
      if (!prev || entry.boxed > prev.boxed || (entry.boxed === prev.boxed && String(entry.updatedAt) > String(prev.updatedAt))) byTitle.set(key, entry);
    }
    catalogCache = { at: Date.now(), entries: [...byTitle.values()].sort((a, b) => a.module.localeCompare(b.module) || a.title.localeCompare(b.title)) };
    return catalogCache.entries;
  }
  const byName = (name) => loadCatalog().find((e) => e.name === name);

  function suggestions() {
    const cat = loadCatalog();
    const titles = cat.map((e) => norm(e.title));
    const out = CURATED.filter((c) => c.kw.some((k) => titles.some((t) => t.includes(norm(k)))))
      .map((c) => ({ label: c.label, prompt: c.label, module: c.module, audience: c.audience, kind: c.label.startsWith('Getting started') || c.label.startsWith('Platform') ? 'module' : 'workflow' }));
    const seen = new Set(out.map((o) => norm(o.label)));
    for (const e of cat) {
      if (!/^how /i.test(e.title) || e.steps.length < 4 || seen.has(norm(e.title))) continue;
      const audience = /employee (completes|submits)|submit a disclosure|submitting/i.test(e.title) ? 'employee' : 'admin';
      out.push({ label: e.title.replace(/\s+/g, ' '), prompt: e.title, module: e.module, audience, kind: 'workflow' });
      seen.add(norm(e.title));
    }
    return out;
  }

  // ------------------------------------------------------------------ planning
  const HOUSE_RULES = `House style for all slide copy:
- Plain, direct, second person ("Open", "Click", "Choose"). Short sentences. No marketing adjectives (seamless, powerful, robust, effortless, streamlined), no "navigate", "delve", "leverage".
- Never use em dashes or en dashes; use commas, colons or periods.
- Write UI labels exactly as they appear in the product and wrap them in **double asterisks**: buttons, tabs, menu items, field labels, dialog titles, statuses.
- Never invent a label, route, permission or behavior. If you can't confirm it in the code or in the recorded step data, leave it out.
- No sample person names, emails or company names from the screenshots in the copy.
- Refer to the product as Hadrius.`;

  function catalogLines() {
    return loadCatalog().map((e) => `${e.name} | ${e.title} | ${e.module} | ${e.steps.length} steps`).join('\n');
  }
  function scriptDetail(e) {
    const lines = e.steps.map((s) => `  ${s.i}: ${s.action}${s.label ? ` "${s.label}"` : ''}${s.role ? ` [${s.role}]` : ''}${s.route ? ` @${s.route}` : ''}${s.pre ? '' : ' (no screenshot)'}${s.bbox ? '' : ' (no box)'} :: ${s.narration}`);
    return `### ${e.name}\nTitle: ${e.title}\nModule: ${e.module}\nSteps:\n${lines.join('\n')}`;
  }

  async function plan(job) {
    const st = job.state;
    const { request, audience, style, length, feedback, previousOutline } = st.input;
    progress(job, { status: 'planning', phase: 'Finding recordings that cover it' }, 'Syncing the script library…');
    await syncLibrary((l) => progress(job, null, l));
    const cat = loadCatalog();
    if (!cat.length) throw new Error('No recorded walkthroughs with screenshots were found. Check the shared library connection.');
    progress(job, null, `Searching ${cat.length} recorded walkthroughs`);

    const pickPrompt = `You are choosing source recordings for a Hadrius training slide deck.
Request: "${request}"${feedback ? `\nRevision feedback from the user: "${feedback}"` : ''}
Audience: ${AUDIENCES[audience]}
Length: ${LENGTHS[length]}

Below is every recorded Hadrius walkthrough: name | title | module | step count. Each recording has a screenshot of every step.
Pick the recordings the deck should be built from, in the order a learner should meet them (setup before use, create before edit). Prefer one recording per workflow when several are near duplicates. For a single-workflow request pick 1-3; for a module getting-started guide pick every recording that belongs in it (up to 30).
${previousOutline ? `The previous outline used: ${[...new Set((previousOutline.sections || []).flatMap((s) => s.slides.map((x) => x.source?.script).filter(Boolean)))].join(', ')}` : ''}

Recordings:
${catalogLines()}

Reply with ONLY JSON: {"module": "<main module or null>", "scripts": ["<name>", ...], "missing": ["<requested topic with no recording>", ...]}`;
    let pick;
    try { pick = await claudeJson(job, pickPrompt, { tools: false, maxTurns: 2, timeoutMs: 4 * 60000 }); }
    catch (e) {
      if (job.cancelled) throw e;
      progress(job, null, `Claude unavailable for recording search (${clip(e.message, 80)}); trying Gemini`);
      pick = extractJson(await runGeminiPrompt(pickPrompt));
    }
    const chosen = [...new Set((pick.scripts || []).map(String))].map(byName).filter(Boolean).slice(0, 30);
    if (!chosen.length) throw new Error(`None of the recorded walkthroughs cover "${request}" yet. Record it first, or try a broader request.`);
    progress(job, { phase: 'Reading the product code and drafting the outline', sources: chosen.map((e) => ({ name: e.name, title: e.title, module: e.module })) },
      `Using ${chosen.length} recording(s): ${chosen.map((e) => e.title).join('; ').slice(0, 300)}`);

    const outlinePrompt = `You are designing a Hadrius training slide deck built ONLY from recorded walkthrough screenshots. Each slide shows the screenshot of one or more recorded steps.
Request: "${request}"${feedback ? `\nThe user reviewed an earlier outline and asked for: "${feedback}"\nEarlier outline: ${JSON.stringify(previousOutline).slice(0, 12000)}` : ''}
Audience: ${AUDIENCES[audience]}
Style: ${STYLES[style]}
Length: ${LENGTHS[length]}

You can read the real Hadrius frontend (repo "hadrius_frontend", app code under apps/hadrius-app/src/) with the hadrius-codebase MCP tools. Use them where the audience matters (is this screen admin-only? which role sees it?) and to confirm workflow order. Keep it focused: the detailed code check happens later, slide by slide.

Rules for the outline:
- Every "steps" slide uses steps from ONE recording, consecutive indices, in order. Group steps that happen on the same screen (same page, same open dialog or menu) into one slide; start a new slide when the screen changes (a dialog opens or closes, a new page loads). ${style === 'visual' ? 'Visual style: 1-3 steps per slide, only steps that have a box.' : 'At most 6 steps per slide.'}
- Skip steps that add nothing for a learner (stray clicks, dismissing pop-ups, re-opening the same thing, steps with "(no screenshot)").
- ${style === 'visual' ? 'Do not use concept slides.' : 'You may add "concept" slides (no steps) to explain what an area is for or how a process flows, at most one per section; give a concept slide an "image" (a recording step whose screenshot shows the page being described) when one fits.'}
- Order sections the way a new user learns: find your way around, set up, do the work, review, manage/export.
- Only include what the audience can do. Put anything the request asked for that no recording covers into "gaps" (for example "Editing a branch exam template: no recording").
- Title: short and specific (for example "People Oversight: Getting Started Guide" or "How to Import Employees"). Subtitle: one sentence on what the reader will be able to do.
${HOUSE_RULES}

Recordings available (index: action "label" [role] @route :: narration):
${chosen.map(scriptDetail).join('\n\n')}

Reply with ONLY JSON:
{"title": "...", "subtitle": "...", "module": "...", "summary": "2 sentences describing the deck",
 "sections": [{"title": "...", "summary": "one sentence", "slides": [
   {"title": "...", "kind": "steps", "purpose": "one line", "source": {"script": "<recording name>", "steps": [3,4,5]}},
   {"title": "...", "kind": "concept", "purpose": "one line", "image": {"script": "<recording name>", "step": 0}}
 ]}],
 "gaps": ["..."]}`;
    const outline = await claudeJson(job, outlinePrompt, { tools: true, maxTurns: 40, timeoutMs: 12 * 60000 });
    const clean = sanitizeOutline(outline, style);
    if (!clean.sections.length) throw new Error('The outline came back empty. Try rephrasing the request.');
    const missing = (pick.missing || []).filter(Boolean);
    clean.gaps = [...new Set([...(clean.gaps || []), ...missing])].slice(0, 12);
    progress(job, { status: 'outline', phase: 'Outline ready for review', outline: clean, estimate: estimatePages(clean, style) },
      `Outline ready: ${clean.sections.length} section(s), ${clean.sections.reduce((n, s) => n + s.slides.length, 0)} slide(s)`);
  }

  function sanitizeOutline(o, style) {
    const out = { title: clip(o.title || 'Hadrius Guide', 90), subtitle: clip(o.subtitle || '', 200), module: o.module || null, summary: clip(o.summary || '', 400), sections: [], gaps: Array.isArray(o.gaps) ? o.gaps.map((g) => clip(g, 160)) : [] };
    let sid = 0;
    for (const sec of o.sections || []) {
      const slides = [];
      for (const sl of sec.slides || []) {
        const kind = sl.kind === 'concept' ? 'concept' : 'steps';
        if (kind === 'steps') {
          const e = byName(sl.source?.script);
          if (!e) continue;
          const idx = [...new Set((sl.source.steps || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < e.steps.length && e.steps[n].pre))].sort((a, b) => a - b);
          if (!idx.length) continue;
          slides.push({ id: `s${++sid}`, title: clip(sl.title || e.title, 90), kind, purpose: clip(sl.purpose || '', 200), source: { script: e.name, steps: idx }, recording: e.title, module: e.module });
        } else if (style !== 'visual') {
          const e = byName(sl.image?.script);
          const img = e && Number.isInteger(+sl.image.step) && e.steps[+sl.image.step]?.pre ? { script: e.name, step: +sl.image.step } : null;
          slides.push({ id: `s${++sid}`, title: clip(sl.title || 'Overview', 90), kind, purpose: clip(sl.purpose || '', 200), image: img });
        }
      }
      if (slides.length) out.sections.push({ title: clip(sec.title || 'Section', 80), summary: clip(sec.summary || '', 200), slides });
    }
    return out;
  }
  function estimatePages(o, style) {
    const n = o.sections.reduce((k, s) => k + s.slides.length, 0);
    const multi = o.sections.length >= 2;
    return 1 + (multi && style !== 'visual' ? 1 : 0) + (multi && n >= 6 ? o.sections.length : 0) + n + (style !== 'visual' && n >= 8 ? 1 : 0) + 1;
  }

  // ------------------------------------------------------------------ building
  async function ensureScreenshots(job, outline) {
    const need = new Map(); // recordingId -> Set(file)
    for (const sec of outline.sections) for (const sl of sec.slides) {
      const e = byName(sl.source?.script || sl.image?.script); if (!e) continue;
      const idx = sl.kind === 'steps' ? sl.source.steps : [sl.image?.step];
      for (const i of idx) { const f = e.steps[i]?.pre; if (f) { if (!need.has(e.recordingId)) need.set(e.recordingId, new Set()); need.get(e.recordingId).add(f); } }
    }
    let got = 0, missing = 0;
    for (const [rid, files] of need) {
      if (job.cancelled) throw new Error('cancelled');
      const dir = path.join(RECORDINGS_DIR, rid);
      const absent = [...files].filter((f) => !fs.existsSync(path.join(dir, f)));
      if (absent.length && googleDriveConfigured()) {
        try { got += await googleDriveDownloadRecording(rid, dir, absent); } catch (e) { progress(job, null, `Drive download failed for ${rid}: ${clip(e.message, 120)}`); }
      }
      missing += [...files].filter((f) => !fs.existsSync(path.join(dir, f))).length;
    }
    progress(job, null, `Screenshots ready${got ? ` (${got} pulled from Drive)` : ''}${missing ? `, ${missing} missing` : ''}`);
  }

  function slideForPrompt(sl) {
    if (sl.kind === 'concept') {
      let img = '';
      if (sl.image) { const e = byName(sl.image.script); const s = e?.steps[sl.image.step]; if (s) img = `\n   screenshot shows: ${s.route || ''} :: ${s.narration}`; }
      return `- ${sl.id} [concept] "${sl.title}": ${sl.purpose}${img}`;
    }
    const e = byName(sl.source.script);
    const steps = sl.source.steps.map((i, k) => { const s = e.steps[i]; return `   ${sl.id}.${k + 1}: ${s.action}${s.label ? ` "${s.label}"` : ''}${s.role ? ` [${s.role}]` : ''} @${s.route} :: ${s.narration}`; });
    return `- ${sl.id} [steps] "${sl.title}" (recording "${e.title}"): ${sl.purpose}\n${steps.join('\n')}`;
  }

  const WRITE_RULES = {
    standard: `Per slide: "lead" (optional, one short sentence), "steps" (one entry per listed step ref: "text" = one imperative sentence, max 22 words, naming the control exactly), optional "tip" (max 25 words, only when it adds something a user needs: a prerequisite, a gotcha, where the result appears). Concept slides: "lead" + "bullets" (3-5, max 18 words each).`,
    detailed: `Per slide: "lead" (1-2 sentences: what this screen is for and when you'd use it), "steps" (one entry per listed step ref: "text" = 1-2 sentences, the action plus what happens next or what to enter), "body" (1-2 short paragraphs of context the code confirms: who can do this, required fields, validation, what statuses change, where results show), optional "tip". Concept slides: "lead", "body" (2-3 paragraphs), "bullets" (3-6).`,
    visual: `Per slide: a short "title" (max 6 words) and, for each listed step ref, a "callout" of 2-4 words naming the action and control (for example "Click Save", "Choose a template"). No lead, body, bullets or tips.`,
  };

  async function writeChunk(job, outline, sec, slides, chunkNo) {
    const { audience, style } = job.state.input;
    const prompt = `You are writing slide copy for a Hadrius training deck and verifying it against the real product code.
Deck: "${outline.title}" (${outline.subtitle})
Audience: ${AUDIENCES[audience]}
Style: ${STYLES[style]}
Section: "${sec.title}" (${sec.summary})

Each slide below lists recorded steps: the action, the label the recorder captured from the live page (this text is real UI), the route, and the recording's narration (written by AI, may be wrong).

VERIFY AGAINST THE CODE FIRST (hadrius-codebase MCP tools, repo "hadrius_frontend", app code under apps/hadrius-app/src/; routes are thin files under apps/hadrius-app/pages/**, the UI lives under apps/hadrius-app/src/**; search for labels and route strings rather than guessing folders):
- For every screen in this section, find and read the component that renders it (search_code a recorded label, then read_file), plus any dialog, menu, drawer or form the steps touch.
- Confirm each button, tab, menu item, field label, dialog title and status you will mention, copying its exact text from the code. If the recorded label and the code differ, use the code's current text and add a "corrections" entry.
- Confirm behavior before describing it: what a button does, what is required vs optional, who can see it, what happens after. If you can't confirm a claim, don't make it.
- For each UI label you bold, add an "evidence" entry with the file you saw it in. Labels taken verbatim from the recorded step data need no file (use "recorded").

${WRITE_RULES[style]}
${HOUSE_RULES}
${style !== 'visual' ? 'Also return "quickref": 1-3 rows for the main tasks in these slides, {"task": "Start a new project", "where": "Marketing > Projects > + New"}.' : ''}

Slides:
${slides.map(slideForPrompt).join('\n')}

Reply with ONLY JSON:
{"slides": [{"id": "s1", "title": "...", "lead": "...", "steps": [{"ref": "s1.1", "text": "...", "callout": "..."}], "body": ["..."], "bullets": ["..."], "tip": "..."}],
 "sectionSummary": "one sentence", "quickref": [{"task": "...", "where": "..."}],
 "evidence": [{"label": "...", "file": "apps/hadrius-app/src/...tsx"}], "corrections": [{"was": "...", "now": "...", "file": "..."}]}`;
    const r = await claudeJson(job, prompt, { tools: true, maxTurns: 80, timeoutMs: 20 * 60000 });
    progress(job, null, `Section "${sec.title}"${chunkNo ? ` (part ${chunkNo})` : ''}: copy written and checked against the code`);
    return r;
  }

  const boldLabels = (s) => [...String(s || '').matchAll(/\*\*([^*]{1,80})\*\*/g)].map((m) => m[1].trim());

  async function auditLabels(job, written, outline) {
    // Labels already proven: captured from the live page by the recorder, or cited from a code file.
    const recorded = new Set();
    for (const sec of outline.sections) for (const sl of sec.slides) {
      const e = byName(sl.source?.script || sl.image?.script); if (!e) continue;
      for (const s of e.steps) if (s.label) recorded.add(norm(s.label));
    }
    const cited = new Set();
    for (const w of written) for (const ev of w.evidence || []) if (ev?.label && ev.file && ev.file !== 'recorded' && /\.(tsx?|jsx?|json)$/.test(ev.file)) cited.add(norm(ev.label));
    const all = new Map(); // norm -> original
    const texts = [];
    for (const w of written) for (const s of w.slides || []) {
      texts.push(s.lead, s.tip, ...(s.body || []), ...(s.bullets || []), ...(s.steps || []).flatMap((x) => [x.text, x.callout]));
    }
    for (const w of written) for (const q of w.quickref || []) texts.push(q.where);
    for (const t of texts) for (const l of boldLabels(t)) all.set(norm(l), l);
    // "Marketing > Projects" style paths: check each segment.
    const stats = { labels: all.size, recorded: 0, cited: 0, confirmed: 0, corrected: 0, unverified: [] };
    const todo = [];
    for (const [k, l] of all) {
      if (recorded.has(k) || [...recorded].some((r) => r.length > 3 && (r === k || r.startsWith(`${k} `) || r.endsWith(` ${k}`)))) { stats.recorded++; continue; }
      if (cited.has(k)) { stats.cited++; continue; }
      todo.push(l);
    }
    const fixes = new Map(); // original label -> {now|null}
    if (todo.length) {
      progress(job, { phase: `Double-checking ${todo.length} UI label(s) in the code` }, `Auditing ${todo.length} label(s) with no recorded or cited source`);
      const prompt = `Check each UI label below against the real Hadrius frontend code (hadrius-codebase MCP tools, repo "hadrius_frontend", app code under apps/hadrius-app/src/). These labels appear in a training deck about: "${outline.title}".
For each one, search_code for it (exact text, then close variants) and read the component when needed. Decide:
- "confirmed": this exact text is rendered in the UI (button, tab, menu item, field label, dialog title, status, sidebar item, page title). Give the file.
- "corrected": the UI shows a slightly different text for the same control; give the exact current text and file.
- "not_found": you can't find it rendered in the app.
Labels:
${todo.map((l) => `- ${l}`).join('\n')}

Reply with ONLY JSON: {"results": [{"label": "...", "status": "confirmed|corrected|not_found", "now": "...", "file": "..."}]}`;
      let res = { results: [] };
      try { res = await claudeJson(job, prompt, { tools: true, maxTurns: 80, timeoutMs: 15 * 60000 }); }
      catch (e) { if (job.cancelled) throw e; progress(job, null, `Label audit failed: ${clip(e.message, 120)}`); }
      const byLabel = new Map((res.results || []).map((r) => [norm(r.label), r]));
      for (const l of todo) {
        const r = byLabel.get(norm(l));
        if (r?.status === 'confirmed') stats.confirmed++;
        else if (r?.status === 'corrected' && r.now && norm(r.now) !== norm(l)) { stats.corrected++; fixes.set(l, r.now); }
        else { stats.unverified.push(l); fixes.set(l, null); }
      }
    }
    return { stats, fixes };
  }

  function applyFixes(s, fixes) {
    if (!s) return s;
    return String(s).replace(/\*\*([^*]{1,80})\*\*/g, (m, l) => {
      const key = l.trim();
      if (!fixes.has(key)) return m;
      const now = fixes.get(key);
      return now ? `**${now}**` : key; // unconfirmed: keep the words, drop the "this is a UI label" bold
    });
  }
  const scrub = (s) => (s == null ? s : String(s).replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ','));

  async function build(job) {
    const st = job.state;
    const { style, audience } = st.input;
    const outline = st.outline;
    progress(job, { status: 'building', phase: 'Collecting screenshots', builtAt: null }, 'Build started');
    await ensureScreenshots(job, outline);

    progress(job, { phase: 'Verifying against the product code and writing slides' });
    const chunks = [];
    for (const sec of outline.sections) {
      for (let i = 0; i < sec.slides.length; i += 8) chunks.push({ sec, slides: sec.slides.slice(i, i + 8), part: sec.slides.length > 8 ? i / 8 + 1 : 0 });
    }
    let done = 0;
    progress(job, { progress: { done, total: chunks.length } }, `Writing ${chunks.length} part(s), up to 3 at a time`);
    const written = await Promise.all(chunks.map(async (c) => {
      const r = await writeChunk(job, outline, c.sec, c.slides, c.part);
      done++; progress(job, { progress: { done, total: chunks.length } });
      return { ...r, sec: c.sec };
    }));

    const { stats: labelStats, fixes } = await auditLabels(job, written, outline);
    progress(job, { phase: 'Marking up screenshots and building the PowerPoint' }, `Labels: ${labelStats.labels} total, ${labelStats.recorded} from recordings, ${labelStats.cited + labelStats.confirmed} confirmed in code, ${labelStats.corrected} corrected, ${labelStats.unverified.length} unverified`);

    // Assemble the renderer spec.
    const copy = new Map();
    const quickref = [];
    const corrections = [];
    for (const w of written) {
      for (const s of w.slides || []) copy.set(s.id, s);
      if (w.sectionSummary && !w.sec._summaryLocked) { w.sec.writtenSummary = w.sectionSummary; w.sec._summaryLocked = true; }
      for (const q of w.quickref || []) if (q?.task && q?.where) quickref.push({ task: scrub(q.task), where: applyFixes(scrub(q.where), fixes) });
      for (const c of w.corrections || []) if (c?.was && c?.now) corrections.push(c);
    }
    const fx = (s) => applyFixes(scrub(s), fixes);
    const imgPath = (e, i) => (e && e.steps[i]?.pre ? path.join(RECORDINGS_DIR, e.recordingId, e.steps[i].pre) : null);
    const sections = outline.sections.map((sec) => ({
      title: sec.title, summary: scrub(sec.writtenSummary || sec.summary),
      slides: sec.slides.map((sl) => {
        const c = copy.get(sl.id) || {};
        if (sl.kind === 'concept') {
          const e = sl.image ? byName(sl.image.script) : null;
          return { kind: 'concept', title: scrub(c.title || sl.title), lead: fx(c.lead), body: (c.body || []).map(fx), bullets: (c.bullets || []).map(fx), image: e ? imgPath(e, sl.image.step) : null };
        }
        const e = byName(sl.source.script);
        const stepsCopy = new Map((c.steps || []).map((x) => [String(x.ref), x]));
        return {
          kind: 'steps', title: scrub(c.title || sl.title), lead: fx(c.lead), body: (c.body || []).map(fx), tip: fx(c.tip), bullets: (c.bullets || []).map(fx),
          steps: sl.source.steps.map((i, k) => {
            const s = e.steps[i]; const w = stepsCopy.get(`${sl.id}.${k + 1}`) || {};
            return { image: imgPath(e, i), bbox: s.bbox, viewport: s.viewport, label: s.label, role: s.role, action: s.action,
              text: fx(w.text || (s.label ? `${s.action === 'type' ? 'Fill in' : 'Click'} **${s.label}**.` : s.narration)),
              callout: fx(w.callout || (s.label ? `${s.action === 'type' ? 'Fill in' : 'Click'} **${s.label}**` : '')) };
          }),
        };
      }),
    }));
    const spec = { out_dir: deckDir(st.id), title: scrub(outline.title), subtitle: scrub(outline.subtitle), module: outline.module, audience, style, sections, quickref: dedupeQuickref(quickref) };
    fs.writeFileSync(path.join(deckDir(st.id), 'spec.json'), JSON.stringify(spec, null, 2));

    const venvPython = path.join(REPO_ROOT, '.venv', 'bin', 'python');
    const python = fs.existsSync(venvPython) ? venvPython : 'python3';
    const result = await new Promise((resolve, reject) => {
      const child = execFile(python, [path.join(REPO_ROOT, 'renderer', 'deck.py'), path.join(deckDir(st.id), 'spec.json')], { cwd: REPO_ROOT, timeout: 15 * 60000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        job.children.delete(child);
        if (job.cancelled) return reject(new Error('cancelled'));
        const last = String(stdout || '').trim().split('\n').pop();
        try { const j = JSON.parse(last); if (j.ok) return resolve(j); } catch (_) {}
        const why = String(stderr || err?.message || '').trim().split('\n').filter((l) => !/Warning/.test(l)).pop();
        reject(new Error(/No module named '(pptx|pymupdf|ocrmac)'/.test(String(stderr)) ? 'Missing Python packages for decks. Run: bash setup.sh (or .venv/bin/pip install -r requirements.txt)' : `deck renderer failed: ${clip(why, 300)}`));
      });
      job.children.add(child);
    });
    progress(job, {
      status: 'done', phase: 'Ready', builtAt: now(),
      files: { pptx: path.basename(result.pptx), pdf: result.pdf ? path.basename(result.pdf) : null },
      pdfError: result.pdfError || null, pages: result.pages, thumbs: result.thumbs,
      verification: { ...labelStats, corrections: corrections.slice(0, 30), markup: result.stats },
    }, `Done: ${result.pages} pages${result.pdf ? ', PPTX + PDF' : ', PPTX only'}`);
    await publish(job);
  }

  // ------------------------------------------------------------------ shared library (Drive "Slide Decks")
  function deckMeta(st) {
    const o = st.outline || {};
    return {
      v: 1, deckId: st.id, title: o.title, subtitle: o.subtitle, summary: o.summary, request: st.input?.request,
      module: o.module, audience: st.input?.audience, style: st.input?.style, pages: st.pages,
      sections: (o.sections || []).map((s) => s.title),
      slides: (o.sections || []).flatMap((s) => s.slides.map((x) => x.title)).slice(0, 80),
      createdBy: WHOAMI, createdAt: st.builtAt || now(),
    };
  }
  async function publish(job) {
    const st = job.state;
    if (!drive?.configured()) { progress(job, { drive: null, driveError: 'Google Drive isn\'t connected on this machine, so the deck was not added to the shared library.' }); return; }
    progress(job, { publishing: true }, 'Saving to the shared Slide Decks folder in Drive…');
    try {
      const dir = deckDir(st.id);
      const files = [
        { kind: 'pptx', path: path.join(dir, st.files.pptx) },
        st.files.pdf ? { kind: 'pdf', path: path.join(dir, st.files.pdf) } : null,
        st.thumbs?.[0] ? { kind: 'cover', path: path.join(dir, 'thumbs', st.thumbs[0]) } : null,
      ].filter(Boolean);
      const out = await drive.uploadDeck(st.id, files, deckMeta(st));
      libraryCache.at = 0;
      progress(job, { publishing: false, drive: out, driveError: null }, 'Saved to the shared library');
    } catch (e) {
      progress(job, { publishing: false, driveError: `Couldn't save to the shared library: ${clip(e.message, 200)}` }, `✗ Drive upload failed: ${clip(e.message, 160)}`);
    }
  }

  let libraryCache = { at: 0, items: [], byFile: new Map() };
  async function libraryList(fresh = false) {
    if (!fresh && Date.now() - libraryCache.at < 60000) return libraryCache.items;
    const files = await drive.listDeckFiles();
    const decks = new Map(); const byFile = new Map();
    for (const f of files) {
      const id = f.appProperties?.deckId; const kind = f.appProperties?.kind;
      if (!id || !kind) continue;
      if (!decks.has(id)) decks.set(id, { deckId: id, files: {} });
      const d = decks.get(id);
      d.files[kind] = { id: f.id, name: f.name, size: +f.size || null, url: f.webViewLink };
      byFile.set(f.id, { name: f.name, mime: f.mimeType, kind });
      if (kind === 'pptx') {
        let meta = {}; try { meta = JSON.parse(f.description || '{}'); } catch (_) {}
        Object.assign(d, meta, { deckId: id, files: d.files, uploadedAt: f.createdTime, owner: f.owners?.[0]?.displayName || meta.createdBy });
      }
    }
    const items = [...decks.values()].filter((d) => d.files.pptx || d.files.pdf).map((d) => ({ ...d, title: d.title || (d.files.pptx || d.files.pdf).name.replace(/\.(pptx|pdf)$/i, '') }))
      .sort((a, b) => String(b.createdAt || b.uploadedAt).localeCompare(String(a.createdAt || a.uploadedAt)));
    libraryCache = { at: Date.now(), items, byFile };
    return items;
  }
  async function pipeDriveFile(res, fileId, { download, cacheTo } = {}) {
    const info = libraryCache.byFile.get(fileId);
    if (!info) return send(res, 404, { ok: false, error: 'not a Slide Decks file' });
    if (cacheTo && fs.existsSync(cacheTo)) { res.writeHead(200, { 'Content-Type': info.mime, 'Cache-Control': 'public, max-age=3600' }); return fs.createReadStream(cacheTo).pipe(res); }
    const r = await drive.fetchFile(fileId);
    const buf = Buffer.from(await r.arrayBuffer());
    if (cacheTo) { fs.mkdirSync(path.dirname(cacheTo), { recursive: true }); fs.writeFileSync(cacheTo, buf); }
    res.writeHead(200, {
      'Content-Type': info.mime, 'Content-Length': buf.length,
      ...(download ? { 'Content-Disposition': `attachment; filename="${info.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(info.name)}` } : { 'Cache-Control': 'public, max-age=3600' }),
    });
    res.end(buf);
  }
  function dedupeQuickref(rows) {
    const seen = new Set(); const out = [];
    for (const r of rows) { const k = norm(r.task); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out.slice(0, 14);
  }

  function run(job, fn) {
    job.cancelled = false;
    fn(job).catch((e) => {
      const msg = String(e?.message || e);
      progress(job, { status: msg === 'cancelled' ? 'cancelled' : 'failed', phase: msg === 'cancelled' ? 'Cancelled' : 'Something went wrong', error: msg === 'cancelled' ? null : msg }, msg === 'cancelled' ? 'Cancelled' : `✗ ${msg}`);
    });
  }

  // ------------------------------------------------------------------ HTTP
  const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON body')); } }); });
  const publicState = (s) => { const { input, ...rest } = s; return { ...rest, input }; };

  async function handle(req, res, u) {
    const p = u.pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'GET' && p === '/decks/suggestions') {
        return send(res, 200, { ok: true, items: suggestions(), recordings: loadCatalog().length });
      }
      if (req.method === 'GET' && p === '/decks') {
        const items = (fs.existsSync(DECKS_DIR) ? fs.readdirSync(DECKS_DIR) : []).map(readState).filter(Boolean)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 40)
          .map((s) => ({ id: s.id, title: s.outline?.title || s.input?.request, request: s.input?.request, status: s.status, style: s.input?.style, audience: s.input?.audience, createdAt: s.createdAt, pages: s.pages || s.estimate || null, files: s.files || null }));
        return send(res, 200, { ok: true, items });
      }
      if (req.method === 'POST' && p === '/decks/plan') {
        const b = await body(req);
        const request = String(b.request || '').trim();
        if (request.length < 4) return send(res, 400, { ok: false, error: 'Describe what the deck should cover.' });
        const input = {
          request: request.slice(0, 1200),
          audience: AUDIENCES[b.audience] ? b.audience : 'admin',
          style: STYLES[b.style] ? b.style : 'standard',
          length: LENGTHS[b.length] ? b.length : 'auto',
          feedback: b.feedback ? String(b.feedback).slice(0, 1200) : null,
        };
        let previousOutline = null;
        if (b.fromId) { const prev = readState(String(b.fromId).replace(/[^\w-]/g, '')); previousOutline = b.outline || prev?.outline || null; }
        input.previousOutline = previousOutline;
        const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
        const job = { state: { id, createdAt: now(), status: 'planning', phase: 'Starting', input, log: [] }, children: new Set(), cancelled: false };
        jobs.set(id, job); writeState(job.state);
        run(job, plan);
        return send(res, 200, { ok: true, id });
      }
      if (p === '/decks/library' || p.startsWith('/decks/library/')) {
        if (!drive?.configured()) return send(res, 200, { ok: true, connected: false, items: [] });
        if (req.method === 'GET' && p === '/decks/library') {
          const items = await libraryList(u.searchParams.get('fresh') === '1');
          return send(res, 200, { ok: true, connected: true, me: WHOAMI, folderUrl: `https://drive.google.com/drive/folders/${drive.folderId}`, items });
        }
        const lm = p.match(/^\/decks\/library\/(file|cover)\/([\w-]+)$/);
        if (req.method === 'GET' && lm) {
          if (!libraryCache.byFile.has(lm[2])) await libraryList(true);
          return pipeDriveFile(res, lm[2], lm[1] === 'file' ? { download: true } : { cacheTo: path.join(DECKS_DIR, '_covers', `${lm[2]}.png`) });
        }
        const dm = p.match(/^\/decks\/library\/([\w-]+)$/);
        if (req.method === 'DELETE' && dm) {
          const n = await drive.deleteDeck(dm[1]);
          libraryCache.at = 0;
          const local = getJob(dm[1]); if (local) progress(local, { drive: null }, 'Removed from the shared library');
          return send(res, 200, { ok: true, deleted: n });
        }
        return send(res, 404, { ok: false, error: 'unknown library route' });
      }
      const m = p.match(/^\/decks\/([\w-]+)(?:\/(build|cancel|download|thumb|publish)(?:\/([\w.-]+))?)?$/);
      if (!m) return send(res, 404, { ok: false, error: 'unknown decks route' });
      const [, id, action, arg] = m;
      const job = getJob(id);
      if (!job) return send(res, 404, { ok: false, error: 'deck not found' });
      if (req.method === 'GET' && !action) return send(res, 200, { ok: true, deck: publicState(job.state) });
      if (req.method === 'DELETE' && !action) {
        job.cancelled = true; for (const c of job.children) { try { c.kill('SIGTERM'); } catch (_) {} }
        jobs.delete(id); fs.rmSync(deckDir(id), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'cancel') {
        job.cancelled = true; for (const c of job.children) { try { c.kill('SIGTERM'); } catch (_) {} }
        progress(job, { status: 'cancelled', phase: 'Cancelled' }, 'Cancelled by user');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'build') {
        if (['planning', 'building'].includes(job.state.status)) return send(res, 409, { ok: false, error: 'This deck is still being worked on.' });
        const b = await body(req);
        const edited = b.outline ? sanitizeOutline(b.outline, job.state.input.style) : job.state.outline;
        if (!edited?.sections?.length) return send(res, 400, { ok: false, error: 'The outline has no slides left. Add some back or start over.' });
        edited.gaps = job.state.outline?.gaps || [];
        job.state.outline = edited; job.state.estimate = estimatePages(edited, job.state.input.style);
        job.state.error = null; job.state.files = null; job.state.thumbs = null; job.state.verification = null;
        run(job, build);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && action === 'download') {
        const f = job.state.files?.[arg];
        if (!f) return send(res, 404, { ok: false, error: `no ${arg} for this deck` });
        const fp = path.join(deckDir(id), f);
        if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: 'file missing' });
        const type = arg === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(fp).size, 'Content-Disposition': `attachment; filename="${f.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f)}` });
        return fs.createReadStream(fp).pipe(res);
      }
      if (req.method === 'POST' && action === 'publish') {
        if (job.state.status !== 'done') return send(res, 409, { ok: false, error: 'The deck is not finished yet.' });
        publish(job);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && action === 'thumb') {
        const fp = path.join(deckDir(id), 'thumbs', path.basename(arg || ''));
        if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: 'no thumbnail' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' });
        return fs.createReadStream(fp).pipe(res);
      }
      return send(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  // Jobs interrupted by a bridge restart can't resume mid-call; mark them so the panel says so.
  try {
    for (const id of fs.existsSync(DECKS_DIR) ? fs.readdirSync(DECKS_DIR) : []) {
      const s = readState(id);
      if (s && ['planning', 'building'].includes(s.status)) { s.status = 'failed'; s.error = 'The bridge restarted while this deck was in progress. Start it again.'; writeState(s); }
    }
  } catch (_) {}

  return { handle, suggestions, loadCatalog };
}
