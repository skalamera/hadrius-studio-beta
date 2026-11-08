// Read-only queries against a dedicated bare clone of hadrius_frontend (never the developer's checkout): file trees
// and blobs at a commit, release commits that touched given files, short diff excerpts. The clone lives in the
// gitignored .drift-cache/ (override DRIFT_FRONTEND_GIT_DIR) and is created once with --init, borrowing objects from
// a local checkout when one exists so ~600 MB is not downloaded again.
//
// CLI: node tools/drift/frontend-git.mjs --init | --fetch
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FRONTEND_REMOTE = 'https://github.com/1Quantbase/hadrius_frontend.git';
export const DEFAULT_MIRROR = process.env.DRIFT_FRONTEND_GIT_DIR || join(REPO, '.drift-cache', 'frontend.git');
export const DEFAULT_REFERENCE = process.env.DRIFT_FRONTEND_REFERENCE || join(homedir(), 'Documents', 'Projects', 'hadrius_frontend');
const SHA40 = /^[0-9a-f]{40}$/;

export function createFrontendGit(gitDir = DEFAULT_MIRROR, { exec = execFileSync } = {}) {
  // --literal-pathspecs: page files like pages/rules/[ruleId].tsx must not be read as glob character classes.
  const git = (args, opts = {}) => exec('git', ['--literal-pathspecs', '--git-dir', gitDir, ...args],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const trees = new Map(), blobs = new Map(), touched = new Map();
  const hasCommit = (sha) => { try { git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
  return {
    gitDir,
    exists: () => existsSync(gitDir),
    /** Fetch all branches. Returns null, or the error text (callers carry on with the commits already local). */
    fetchHeads() {
      try { git(['fetch', '--prune', '--quiet', 'origin', '+refs/heads/*:refs/heads/*'], { timeout: 900_000 }); return null; }
      catch (e) { return String(e.stderr || e.message).trim().slice(0, 300); }
    },
    hasCommit,
    /** A deployed commit must be local; fetch it by SHA once (covers promoted builds of deleted branches). */
    ensureCommit(sha) {
      if (!SHA40.test(String(sha))) throw new Error(`bad_sha:${sha}`);
      if (hasCommit(sha)) return;
      try { git(['fetch', '--quiet', 'origin', sha], { timeout: 300_000 }); } catch { /* reported below */ }
      if (!hasCommit(sha)) throw new Error(`sha_missing:${sha}`);
    },
    /** Map path -> blob SHA under apps/ and packages/ at a commit. */
    tree(sha) {
      if (!trees.has(sha)) {
        const map = new Map();
        for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', sha, '--', 'apps', 'packages']).split('\0')) {
          const tab = entry.indexOf('\t');
          if (tab < 0) continue;
          const [, type, blob] = entry.slice(0, tab).split(' ');
          if (type === 'blob') map.set(entry.slice(tab + 1), blob);
        }
        trees.set(sha, map);
      }
      return trees.get(sha);
    },
    blob(blobSha) {
      if (!blobs.has(blobSha)) blobs.set(blobSha, git(['cat-file', 'blob', blobSha]));
      return blobs.get(blobSha);
    },
    /** Commits reachable from `current` but not `baseline` that changed any of `files`, newest first. */
    commitsTouching({ baseline, current, files }) {
      if (!files.length) return [];
      const wanted = new Set(files);
      const out = git(['log', '--format=%x1e%H%x1f%cI%x1f%s', '--name-only', `${baseline}..${current}`, '--', ...files]);
      return out.split('\x1e').filter((r) => r.trim()).map((rec) => {
        const [head, ...names] = rec.split('\n');
        const [sha, date, subject = ''] = head.split('\x1f');
        const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
        return { sha, date, subject, pr: pr ? Number(pr) : null, files: [...new Set(names.map((n) => n.trim()).filter((n) => wanted.has(n)))] };
      }).filter((c) => SHA40.test(c.sha) && c.files.length);
    },
    /** Every file a commit changed (finds labels that left the screen with a replaced component). */
    filesTouched(sha) {
      if (!touched.has(sha)) touched.set(sha, git(['show', '--name-only', '--format=', sha]).split('\n').map((l) => l.trim()).filter(Boolean));
      return touched.get(sha);
    },
    /** Added/removed lines that contain words, for one commit limited to `files`. */
    diffExcerpt(sha, files, maxLines = 40) {
      return git(['show', '--format=', '--unified=0', '--no-color', sha, '--', ...files]).split('\n')
        .filter((l) => /^[+-](?![+-])/.test(l) && /[A-Za-z]{3}/.test(l)).slice(0, maxLines).map((l) => l.slice(0, 160)).join('\n');
    },
    /** Every added and removed line of one commit, limited to `files` (no headers, no truncation). */
    diffLines(sha, files) {
      const out = { added: [], removed: [] };
      if (!files.length) return out;
      for (const l of git(['show', '--format=', '--unified=0', '--no-color', sha, '--', ...files]).split('\n')) {
        if (/^\+(?!\+\+ )/.test(l)) out.added.push(l); else if (/^-(?!-- )/.test(l)) out.removed.push(l);
      }
      return out;
    },
  };
}

/** One-time bare clone. Borrows objects from a local checkout when present (--reference-if-able + --dissociate). */
export function initMirror({ dir = DEFAULT_MIRROR, remote = FRONTEND_REMOTE, reference = DEFAULT_REFERENCE, exec = execFileSync } = {}) {
  if (existsSync(dir)) return { status: 'exists', dir };
  const args = ['clone', '--bare', '--quiet'];
  if (reference && existsSync(join(reference, '.git'))) args.push('--reference-if-able', reference, '--dissociate');
  exec('git', [...args, remote, dir], { stdio: 'inherit', timeout: 3_600_000 });
  return { status: 'created', dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2);
  if (a.includes('--init')) console.log(JSON.stringify(initMirror()));
  else if (a.includes('--fetch')) {
    const g = createFrontendGit();
    if (!g.exists()) { console.error('mirror missing: run with --init first'); process.exitCode = 2; }
    else console.log(JSON.stringify({ dir: g.gitDir, fetchError: g.fetchHeads() }));
  } else { console.error('usage: node tools/drift/frontend-git.mjs --init | --fetch'); process.exitCode = 2; }
}
