import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFileForRoute, isPageFile } from '../../tools/drift/next-routes.mjs';

const P = 'apps/hadrius-app/pages/';
const paths = ['index.tsx', '_app.tsx', 'api/company/[company_id]/x.ts', 'testing-program/policies/index.tsx', 'testing-program/policies/[manual_id].tsx',
  'marketing/projects/index.tsx', 'marketing/project/[id]/index.tsx', 'marketing/project/[id]/documents/index.tsx',
  'marketing/project/[id]/documents/[[...doc_id]].tsx', 'sources/[slug].tsx', 'sources/new.tsx', 'foo/bar.test.tsx'].map((p) => P + p)
  .concat(['apps/hadrius-app/src/features/x.tsx']);

test('pageFileForRoute: static beats dynamic beats catch-all; query, host and trailing slash ignored', () => {
  assert.equal(pageFileForRoute(paths, '/testing-program/policies?company_id=1048'), `${P}testing-program/policies/index.tsx`);
  assert.equal(pageFileForRoute(paths, '/testing-program/policies/12/'), `${P}testing-program/policies/[manual_id].tsx`);
  assert.equal(pageFileForRoute(paths, 'https://app.hadrius.com/marketing/project/41113'), `${P}marketing/project/[id]/index.tsx`);
  assert.equal(pageFileForRoute(paths, '/marketing/project/1/documents'), `${P}marketing/project/[id]/documents/index.tsx`);
  assert.equal(pageFileForRoute(paths, '/marketing/project/1/documents/9/x'), `${P}marketing/project/[id]/documents/[[...doc_id]].tsx`);
  assert.equal(pageFileForRoute(paths, '/sources/new'), `${P}sources/new.tsx`);
  assert.equal(pageFileForRoute(paths, '/sources/abc'), `${P}sources/[slug].tsx`);
  assert.equal(pageFileForRoute(paths, '/'), `${P}index.tsx`);
});

test('pageFileForRoute: API routes, special files, tests and unknown routes resolve to null', () => {
  assert.equal(pageFileForRoute(paths, '/api/company/1/x'), null);
  assert.equal(pageFileForRoute(paths, '/nope'), null);
  assert.equal(pageFileForRoute(paths, '/foo/bar.test'), null);
  assert.equal(isPageFile(`${P}_app.tsx`), false);
  assert.equal(isPageFile(`${P}foo/bar.test.tsx`), false);
  assert.equal(isPageFile(`${P}sources/new.tsx`), true);
});
