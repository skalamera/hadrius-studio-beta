// Static import closure of frontend source at one commit, resolved with hadrius-app's tsconfig path aliases
// (apps/hadrius-app/tsconfig.json). Parses imports with ts.preProcessFile (static, dynamic and type imports; no type
// checking). Pure apart from the injected tree/blob readers.
import ts from 'typescript';
import { APP_DIR } from './next-routes.mjs';

export const ALIASES = Object.freeze([
  ['src/', `${APP_DIR}src/`], ['generated/', `${APP_DIR}generated/`], ['pages/', `${APP_DIR}pages/`], ['styles/', `${APP_DIR}styles/`],
  ['@1quantbase/pantheon/', 'packages/pantheon/src/'], ['@1quantbase/ui/', 'packages/ui/src/'],
]);
const EXACT = Object.freeze({ '@1quantbase/pantheon': 'packages/pantheon/src/index.ts', '@1quantbase/ui': 'packages/ui/src/index.ts' });
const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
const CODE = /\.(tsx|ts|jsx|js)$/;

export function resolveImport(spec, from, has) {
  let base = null;
  if (spec.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const p of spec.split('/')) { if (p === '.' || p === '') continue; if (p === '..') parts.pop(); else parts.push(p); }
    base = parts.join('/');
  } else if (EXACT[spec]) {
    return has(EXACT[spec]) ? EXACT[spec] : null;
  } else {
    for (const [prefix, target] of ALIASES) if (spec.startsWith(prefix)) { base = target + spec.slice(prefix.length); break; }
  }
  if (base == null) return null; // npm package: outside the repo
  for (const ext of EXTENSIONS) if (has(base + ext)) return base + ext;
  return null;
}

const importCache = new Map(); // blob SHA -> specifiers (same content = same imports)
export function defaultImportsOf(blobSha, read) {
  if (!importCache.has(blobSha)) importCache.set(blobSha, ts.preProcessFile(read(), true, true).importedFiles.map((f) => f.fileName));
  return importCache.get(blobSha);
}

/** Every repo file reachable from `entries` through imports at one commit (tree: Map path -> blob SHA). */
export function importClosure({ tree, readBlob, entries, importsOf = defaultImportsOf }) {
  const seen = new Set();
  const queue = entries.filter((e) => tree.has(e));
  const has = (p) => tree.has(p);
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!CODE.test(file) || file.endsWith('.d.ts')) continue;
    const blob = tree.get(file);
    for (const spec of importsOf(blob, () => readBlob(blob))) {
      const target = resolveImport(spec, file, has);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}
