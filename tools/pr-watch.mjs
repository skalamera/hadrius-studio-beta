// Hadrius Studio — watches the frontend repo for merged PRs that change something a recorded
// walkthrough depends on (a button/link label, a heading, a placeholder, a page route) and flags the
// affected scripts for everyone.
//
// Runs inside the bridge on ONE machine only (PR_WATCH_USER=<github login> in .env) — every coworker
// runs a bridge, and without that switch each would flag the same PR. Auth reuses that account's
// GitHub CLI login (`gh auth token -u <user>`), so there's no token to store.
//
// Signal: a label a step targets is an entire string literal or JSX text node on a REMOVED line of the
// PR's diff, on no ADDED line of the same PR, and nowhere in the frontend's current main branch — i.e.
// the string left the codebase (renamed or deleted), rather than moving or just being dropped from
// one of several places that show it. Same for a step's route, matched as a whole path. Each of those
// three conditions cut the noise sharply on a real week of PRs: substring matching flagged "More
// actions" inside "More actions for conversation 88", and without the whole-repo check every PR that
// touched one "People directory" breadcrumb flagged every People oversight video.
//
// This is an early warning from source, before the change is even deployed; it can't see behaviour
// changes that don't touch strings.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FRONTEND_REPO = '1Quantbase/hadrius_frontend';
const SOURCE_EXT = /\.(tsx?|jsx?|json|vue|html)$/i;
const NOT_UI = /(\.(test|spec|stories)\.|__tests__|__mocks__|\/tests?\/|\/e2e\/|\/cypress\/|\/playwright\/)/i;
const FIRST_RUN_LOOKBACK_DAYS = 7;
// Labels on nearly every page — a PR touching one of these says nothing about a specific recording.
const GENERIC_LABELS = new Set(['save', 'cancel', 'close', 'next', 'back', 'submit', 'edit', 'delete', 'done',
  'continue', 'ok', 'yes', 'no', 'confirm', 'add', 'remove', 'search', 'filter', 'filters', 'apply', 'reset',
  'more', 'menu', 'view', 'open', 'create', 'update', 'name', 'status', 'type', 'date', 'all', 'actions']);

function ghToken(user) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token', '-u', user], { env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } },
      (err, out) => (err ? reject(new Error(`gh auth token -u ${user} failed — is the GitHub CLI logged in as ${user}? (${String(err.message).split('\n')[0]})`)) : resolve(out.trim())));
  });
}

async function gh(token, pathAndQuery) {
  const resp = await fetch(`https://api.github.com/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`GitHub ${pathAndQuery.split('?')[0]} failed: ${data.message || resp.status}`);
  return data;
}

/** PRs merged into the default branch after `since` (ISO), oldest first. */
async function mergedPrsSince(token, since) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const prs = await gh(token, `repos/${FRONTEND_REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`);
    for (const pr of prs) if (pr.merged_at && pr.merged_at > since) out.push(pr);
    // Sorted by last update, so once a whole page is older than `since` nothing further back merged later.
    if (prs.length < 100 || prs.every((pr) => pr.updated_at <= since)) break;
  }
  return out.sort((a, b) => a.merged_at.localeCompare(b.merged_at));
}

async function prDiffLines(token, number) {
  const removed = [], added = [];
  for (let page = 1; page <= 10; page++) {
    const files = await gh(token, `repos/${FRONTEND_REPO}/pulls/${number}/files?per_page=100&page=${page}`);
    for (const f of files) {
      if (!SOURCE_EXT.test(f.filename) || NOT_UI.test(f.filename) || !f.patch) continue;
      for (const line of f.patch.split('\n')) {
        if (line.startsWith('-') && !line.startsWith('---')) removed.push({ file: f.filename, text: line.slice(1) });
        else if (line.startsWith('+') && !line.startsWith('+++')) added.push({ file: f.filename, text: line.slice(1) });
      }
    }
    if (files.length < 100) break;
  }
  return { removed, added };
}

/** Every whole string a line shows or routes to: quoted literals (no interpolation) and JSX text. */
function lineStrings(text) {
  const out = new Set();
  if (/^\s*(\/\/|\*|\/\*)/.test(text)) return out; // comment lines
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$]*)`/g)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v) out.add(v);
  }
  for (const m of text.matchAll(/>([^<>{}]+)</g)) { const v = m[1].trim(); if (v) out.add(v); }
  const bare = text.trim();
  if (/^[A-Za-z][^<>{}=;()"'`]*$/.test(bare)) out.add(bare); // a JSX text line on its own
  return out;
}

/** What each step depends on: its visible labels and its route with ids stripped out. */
function stepDependencies(step) {
  const t = step?.target || {};
  const labels = [...new Set([t.name, t.text, t.label, t.placeholder, t.heading]
    .map((v) => String(v || '').trim())
    .filter((v) => v.length >= 3 && v.length <= 60 && !GENERIC_LABELS.has(v.toLowerCase()) && /[a-z]/i.test(v)))];
  const route = String(step?.route || '').split('?')[0];
  // The static prefix up to the first id: "/branches/3234/exams/655" -> "/branches". Only prefixes
  // with at least two segments — a bare module root like "/settings" is on every page of it.
  const segs = [];
  for (const seg of route.split('/').filter(Boolean)) { if (/\d/.test(seg)) break; segs.push(seg); }
  const routes = segs.length >= 2 ? [`/${segs.join('/')}`] : [];
  return { labels, routes };
}

/** Flags for one PR against every script: [{ name, title, items: [...] }]. */
function matchPr(diff, scripts) {
  const hits = [];
  const removed = diff.removed.map((l) => ({ ...l, strings: lineStrings(l.text) }));
  const addedStrings = new Set(diff.added.flatMap((l) => [...lineStrings(l.text)]));
  for (const script of scripts) {
    const items = [];
    (script.steps || []).forEach((step, i) => {
      const { labels, routes } = stepDependencies(step);
      for (const [kind, values] of [['label', labels], ['route', routes]]) {
        for (const value of values) {
          const gone = removed.find((l) => l.strings.has(value));
          if (!gone || addedStrings.has(value)) continue;
          if (items.some((it) => it.kind === kind && it.value === value)) continue;
          items.push({ step: i + 1, kind, value, file: gone.file, removedLine: gone.text.trim().slice(0, 200) });
        }
      }
    });
    if (items.length) hits.push({ name: script.name, title: script.title || script.name, items });
  }
  return hits;
}

// ---- local mirror of the frontend's main branch, for the "still anywhere in the app?" check ----
// A shallow clone, refreshed each pass. The token goes in a per-command header, never into
// .git/config, so the mirror doesn't hold a credential at rest.
function git(args, { cwd, token } = {}) {
  const auth = token ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
  return new Promise((resolve, reject) => {
    execFile('git', [...auth, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // git grep exits 1 for "no match" — an answer, not a failure.
      if (err && !(args[0] === 'grep' && err.code === 1)) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).split('\n')[0]}`));
      else resolve(stdout);
    });
  });
}

async function refreshMirror(dir, token) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['clone', '--depth', '1', '--single-branch', '--branch', 'main', `https://github.com/${FRONTEND_REPO}.git`, dir], { token });
    return;
  }
  await git(['fetch', '--depth', '1', 'origin', 'main'], { cwd: dir, token });
  await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: dir });
}

/** Does `value` still appear in any UI source file on main? */
async function stillInCodebase(dir, value) {
  const files = (await git(['grep', '-F', '-l', '-e', value], { cwd: dir })).split('\n').filter(Boolean);
  return files.some((f) => SOURCE_EXT.test(f) && !NOT_UI.test(f));
}

/**
 * One polling pass. `loadScripts()` -> [script] (full scripts with steps); `loadFlags()` / `saveFlags(doc)`
 * read and write the shared flag document. Returns { prs, flagged }.
 */
export async function runPrWatch({ user, statePath, mirrorDir, loadScripts, loadFlags, saveFlags, log = console.log }) {
  const token = await ghToken(user);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
  const since = state.lastMergedAt || new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86400000).toISOString();
  const prs = await mergedPrsSince(token, since);
  if (!prs.length) return { prs: 0, flagged: 0 };

  await refreshMirror(mirrorDir, token);
  const scripts = await loadScripts();
  const doc = await loadFlags();
  const presence = new Map(); // value -> still in the codebase?
  let flagged = 0;
  for (const pr of prs) {
    const diff = await prDiffLines(token, pr.number);
    for (const hit of matchPr(diff, scripts)) {
      for (const it of hit.items) {
        if (!presence.has(it.value)) presence.set(it.value, await stillInCodebase(mirrorDir, it.value));
      }
      hit.items = hit.items.filter((it) => !presence.get(it.value));
      if (!hit.items.length) continue;
      const entry = (doc.scripts[hit.name] ||= { title: hit.title, flags: [] });
      if (entry.flags.some((f) => f.pr === pr.number)) continue;
      entry.flags.push({
        pr: pr.number, prTitle: pr.title, prUrl: pr.html_url, author: pr.user?.login || null,
        mergedAt: pr.merged_at, detectedAt: new Date().toISOString(), items: hit.items,
      });
      flagged++;
      log(`[pr-watch] #${pr.number} "${pr.title}" may affect "${hit.title}": ${hit.items.map((it) => `step ${it.step} ${it.kind} "${it.value}"`).join(', ')}`);
    }
    state.lastMergedAt = pr.merged_at;
  }
  if (flagged) await saveFlags(doc);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { prs: prs.length, flagged };
}
