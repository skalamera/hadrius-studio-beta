// Production release attribution for one weekly capture. Per slide: the production deploys live at recording and at
// capture time, the page file that renders the slide's URL, the source files that render the text on today's screen
// (import closure of the page + the app shell, anchored by label strings that appear in only a few files), and the
// release commits that changed those files in between. Evidence only; classify.mjs + redesign-judge.mjs decide.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCTION_FRONTEND_ENVIRONMENT } from './release-evidence.mjs';
import { bracket, fetchProductionDeployments } from './deployments.mjs';
import { createFrontendGit } from './frontend-git.mjs';
import { pageFileForRoute, isPageFile, APP_SHELL_ENTRY } from './next-routes.mjs';
import { importClosure } from './import-graph.mjs';
import { uiStrings, visibleLines, labelsInDiffLine, normalizeText, containsPhrase } from './ui-strings.mjs';

export const MAX_FILES_PER_LABEL = 3; // a label found in more files than this is too generic to locate a screen
const SOURCE = /\.(tsx|ts|jsx|js)$/;
const NOT_UI = /(^|\/)(api|generated|__tests__|tests|mocks)\/|\.(test|spec|stories)\.[^.]+$|\.d\.ts$/;
const EMPTY = new Set();
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return null; } };

export function createReleaseProvider({ git = createFrontendGit(), loadDeployments = fetchProductionDeployments, log = () => {} } = {}) {
  let ready = null;
  const init = () => (ready ??= (async () => {
    if (!git.exists()) throw new Error('frontend_mirror_missing: run `node tools/drift/frontend-git.mjs --init` once');
    const fetchError = git.fetchHeads();
    if (fetchError) log(`frontend fetch failed; using commits already in the mirror: ${fetchError}`);
    return loadDeployments();
  })());
  const stringsByBlob = new Map(), appClosures = new Map(), screens = new Map(), commitCache = new Map(), excerpts = new Map(), diffLabelCache = new Map();
  const stringsOf = (tree, file) => {
    const blob = tree.get(file);
    if (!blob || !SOURCE.test(file) || NOT_UI.test(file)) return EMPTY;
    if (!stringsByBlob.has(blob)) stringsByBlob.set(blob, uiStrings(git.blob(blob), file));
    return stringsByBlob.get(blob);
  };
  const screenIndex = (sha, entry) => {
    const key = `${sha}|${entry}`;
    if (screens.has(key)) return screens.get(key);
    const tree = git.tree(sha);
    if (!appClosures.has(sha)) appClosures.set(sha, importClosure({ tree, readBlob: git.blob, entries: [APP_SHELL_ENTRY] }));
    const app = appClosures.get(sha);
    const page = importClosure({ tree, readBlob: git.blob, entries: [entry] });
    const index = new Map(); // label -> Set(files)
    for (const f of new Set([...page, ...app])) for (const s of stringsOf(tree, f)) { let set = index.get(s); if (!set) index.set(s, (set = new Set())); set.add(f); }
    const value = { index, shellFiles: new Set([...app].filter((f) => !page.has(f))) };
    screens.set(key, value);
    return value;
  };
  const commitsFor = (baseline, current, files) => {
    const key = `${baseline}|${current}|${files.join('\n')}`;
    if (!commitCache.has(key)) commitCache.set(key, git.commitsTouching({ baseline, current, files }));
    return commitCache.get(key);
  };
  // Non-serialisable helpers for classify.mjs / redesign-judge.mjs (diff excerpts, label strings at a commit).
  const helpers = {
    excerpt: (sha, files) => { const key = `${sha}|${files.join('\n')}`; if (!excerpts.has(key)) excerpts.set(key, git.diffExcerpt(sha, files, 400)); return excerpts.get(key); },
    filesTouched: (sha) => git.filesTouched(sha),
    /** Label texts the commit added (+) and removed (-) in UI source files; ties a claimed change to that commit. */
    diffLabels: (sha) => {
      if (!diffLabelCache.has(sha)) {
        const files = git.filesTouched(sha).filter((f) => SOURCE.test(f) && !NOT_UI.test(f));
        const { added, removed } = git.diffLines(sha, files);
        diffLabelCache.set(sha, { added: [...new Set(added.flatMap(labelsInDiffLine))], removed: [...new Set(removed.flatMap(labelsInDiffLine))] });
      }
      return diffLabelCache.get(sha);
    },
    /** True when, at `sha`, the label is rendered only by the app shell (sidebar, nav bars, account menu: files imported
     *  through pages/_app.tsx and not by the slide's page `entry`). Such labels are on every screen. */
    shellOnlyLabel: (sha, entry, phrase) => {
      const want = normalizeText(phrase);
      if (!want || !entry) return false;
      const { index, shellFiles } = screenIndex(sha, entry);
      const files = index.get(want) ?? new Set([...index].filter(([label]) => containsPhrase(label, want)).flatMap(([, fs]) => [...fs]));
      return files.size > 0 && [...files].every((f) => shellFiles.has(f));
    },
    uiStringsAt: (sha, files) => { const tree = git.tree(sha); const out = new Set(); for (const f of files) for (const s of stringsOf(tree, f)) out.add(s); return out; },
  };

  return async function provide({ script, runDir, capturedAt }) {
    const deploys = await init();
    const recordedAt = script?.recording?.recordedAt ?? null;
    const b = bracket(deploys, { recordedAt, capturedAt });
    if (b.error) throw new Error(`release_bracket:${b.error}`);
    const base = { environment: PRODUCTION_FRONTEND_ENVIRONMENT, recordedAt, capturedAt, baselineSha: b.baseline.sha, currentSha: b.current.sha,
      baselineDeployedAt: b.baseline.successAt, currentDeployedAt: b.current.successAt };
    const summary = { ...base, status: b.changed ? 'ok' : 'no_release', stepsWithCandidates: 0,
      compareUrl: `https://github.com/1Quantbase/hadrius_frontend/compare/${b.baseline.sha}...${b.current.sha}` };
    const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
    const byStep = {};
    if (!b.changed) {
      for (const st of run.steps || []) byStep[st.index] = { ...base, status: 'no_release' };
      return { summary, byStep, ...helpers };
    }
    git.ensureCommit(b.baseline.sha);
    git.ensureCommit(b.current.sha);
    const pages = [...git.tree(b.current.sha).keys()].filter(isPageFile);
    for (const st of run.steps || []) {
      const route = pathOf(st.todayUrl) ?? (String(st.route || '').split('?')[0] || null);
      const entry = route ? pageFileForRoute(pages, route) : null;
      if (!entry) { byStep[st.index] = { ...base, status: 'route_unmapped', routePath: route }; continue; }
      const { index, shellFiles } = screenIndex(b.current.sha, entry);
      const anchored = new Set();
      for (const line of visibleLines(st.visibleText)) {
        const files = index.get(line);
        if (files && files.size <= MAX_FILES_PER_LABEL) for (const f of files) anchored.add(f);
      }
      const screenFiles = [...anchored].sort();
      const ev = { ...base, routePath: route, routeEntryFile: entry, screenFiles, shellFiles: screenFiles.filter((f) => shellFiles.has(f)) };
      if (!screenFiles.length) { byStep[st.index] = { ...ev, status: 'no_screen_files', commits: [] }; continue; }
      const commits = commitsFor(b.baseline.sha, b.current.sha, screenFiles);
      byStep[st.index] = { ...ev, status: commits.length ? 'candidates' : 'no_release_touched_screen', commits };
      if (commits.length) summary.stepsWithCandidates++;
    }
    return { summary, byStep, ...helpers };
  };
}
