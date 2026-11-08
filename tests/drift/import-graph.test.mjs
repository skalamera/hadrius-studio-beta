import test from 'node:test';
import assert from 'node:assert/strict';
import { importClosure, resolveImport } from '../../tools/drift/import-graph.mjs';
import { createFrontendGit } from '../../tools/drift/frontend-git.mjs';
import { makeFrontendRepo, VIEW_RULES, NAV_BAR } from './frontend-fixture.mjs';

test('importClosure follows tsconfig aliases at one commit and never reaches unrelated screens', () => {
  const fx = makeFrontendRepo(); const g = createFrontendGit(fx.gitDir); const tree = g.tree(fx.B);
  assert.deepEqual([...importClosure({ tree, readBlob: g.blob, entries: ['apps/hadrius-app/pages/rules/index.tsx'] })].sort(),
    ['apps/hadrius-app/pages/rules/index.tsx', VIEW_RULES, 'packages/pantheon/src/button.tsx'].sort());
  assert.deepEqual([...importClosure({ tree, readBlob: g.blob, entries: ['apps/hadrius-app/pages/_app.tsx'] })].sort(),
    ['apps/hadrius-app/pages/_app.tsx', NAV_BAR].sort());
});

test('resolveImport: relative paths, aliases, package roots, extensions and index files; npm packages stay outside', () => {
  const files = new Set(['apps/hadrius-app/src/a/index.ts', 'apps/hadrius-app/src/a/b.tsx', 'packages/ui/src/index.ts', 'apps/hadrius-app/styles/index.css']);
  const has = (p) => files.has(p);
  assert.equal(resolveImport('./b', 'apps/hadrius-app/src/a/index.ts', has), 'apps/hadrius-app/src/a/b.tsx');
  assert.equal(resolveImport('../a', 'apps/hadrius-app/src/a/b.tsx', has), 'apps/hadrius-app/src/a/index.ts');
  assert.equal(resolveImport('src/a', 'x.tsx', has), 'apps/hadrius-app/src/a/index.ts');
  assert.equal(resolveImport('@1quantbase/ui', 'x.tsx', has), 'packages/ui/src/index.ts');
  assert.equal(resolveImport('styles/index.css', 'x.tsx', has), 'apps/hadrius-app/styles/index.css');
  assert.equal(resolveImport('react', 'x.tsx', has), null);
});
