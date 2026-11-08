import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendGit } from '../../tools/drift/frontend-git.mjs';
import { makeFrontendRepo, VIEW_RULES, RULE_PAGE } from './frontend-fixture.mjs';

test('tree, blob, commitsTouching (literal [param] paths), filesTouched and diffExcerpt', () => {
  const fx = makeFrontendRepo(); const g = createFrontendGit(fx.gitDir);
  const tree = g.tree(fx.B);
  assert.ok(tree.has(VIEW_RULES) && tree.has(RULE_PAGE));
  assert.match(g.blob(tree.get(VIEW_RULES)), /New rule/);
  assert.deepEqual(g.commitsTouching({ baseline: fx.A, current: fx.D, files: [VIEW_RULES, RULE_PAGE] }).map((c) => [c.sha, c.pr, [...c.files].sort()]),
    [[fx.B, 2, [RULE_PAGE, VIEW_RULES].sort()]]);
  assert.deepEqual(g.commitsTouching({ baseline: fx.B, current: fx.D, files: [VIEW_RULES] }), []);
  assert.deepEqual([...g.filesTouched(fx.B)].sort(), [RULE_PAGE, VIEW_RULES].sort());
  assert.match(g.diffExcerpt(fx.B, [VIEW_RULES]), /^\+.*New rule/m);
});

test('ensureCommit: local commit passes; unknown or malformed SHAs fail closed; fetch errors are returned', () => {
  const fx = makeFrontendRepo(); const g = createFrontendGit(fx.gitDir);
  g.ensureCommit(fx.A);
  assert.throws(() => g.ensureCommit('f'.repeat(40)), /sha_missing/);
  assert.throws(() => g.ensureCommit('nope'), /bad_sha/);
  assert.equal(typeof g.fetchHeads(), 'string', 'no origin remote: error text, not a throw');
  assert.equal(g.exists(), true);
});
