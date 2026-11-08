import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseProvider } from '../../tools/drift/release-provider.mjs';
import { createFrontendGit } from '../../tools/drift/frontend-git.mjs';
import { makeFrontendRepo, VIEW_RULES, NAV_BAR } from './frontend-fixture.mjs';

const runDir = (steps) => { const d = mkdtempSync(join(tmpdir(), 'rp-')); writeFileSync(join(d, 'run.json'), JSON.stringify({ status: 'captured', steps })); return d; };
const deploysOf = (fx) => async () => [
  { sha: fx.A, successAt: '2026-10-01T00:00:00Z' }, { sha: fx.B, successAt: '2026-10-10T00:00:00Z' },
  { sha: fx.C, successAt: '2026-10-20T00:00:00Z' }, { sha: fx.D, successAt: '2026-10-25T00:00:00Z' }];
const script = { name: 'Vid', recording: { recordedAt: '2026-10-05T00:00:00Z' }, steps: [] };
const provider = (fx) => createReleaseProvider({ git: createFrontendGit(fx.gitDir), loadDeployments: deploysOf(fx) });

test('provider: deploy bracket, page file, screen files anchored by on-screen labels, and the release commits that changed them', async () => {
  const fx = makeFrontendRepo();
  const dir = runDir([
    { index: 0, route: '/rules?company_id=1150', todayUrl: 'https://app.hadrius.com/rules?company_id=1150', visibleText: 'People Oversight\nMarketing Review\nTrading Rules\nNew rule\nImport rules\nRules apply to every account' },
    { index: 1, route: '/nope', todayUrl: 'https://app.hadrius.com/nope', visibleText: 'Trading Rules' },
    { index: 2, route: '/rules', todayUrl: 'https://app.hadrius.com/rules', visibleText: 'Hadrius Sandbox LLC\n0 of 0 results' },
  ]);
  const r = await provider(fx)({ script, runDir: dir, capturedAt: '2026-10-21T00:00:00Z' });
  assert.deepEqual([r.summary.status, r.summary.baselineSha, r.summary.currentSha, r.summary.stepsWithCandidates], ['ok', fx.A, fx.C, 1]);
  const s0 = r.byStep[0];
  assert.equal(s0.status, 'candidates'); assert.equal(s0.routeEntryFile, 'apps/hadrius-app/pages/rules/index.tsx');
  assert.deepEqual(s0.screenFiles, [NAV_BAR, VIEW_RULES]); assert.deepEqual(s0.shellFiles, [NAV_BAR]);
  assert.deepEqual(s0.commits.map((c) => [c.sha, c.pr, c.files]), [[fx.B, 2, [VIEW_RULES]]]);
  assert.equal(r.byStep[1].status, 'route_unmapped');
  assert.equal(r.byStep[2].status, 'no_screen_files');
  assert.ok(r.uiStringsAt(fx.A, [VIEW_RULES]).has('create rule'));
  assert.match(r.excerpt(fx.B, [VIEW_RULES]), /New rule/);
  assert.deepEqual(r.diffLabels(fx.B), { added: ['rule overview', 'trading rules', 'new rule', 'import rules', 'rules apply to every account'], removed: ['rule details', 'trading rules', 'create rule', 'rules apply to every account'] });
  assert.deepEqual(r.diffLabels(fx.D), { added: ['people', 'marketing review'], removed: ['people oversight', 'marketing review'] });
  // App-shell labels: rendered only through pages/_app.tsx (sidebar/nav), never by the slide's page.
  const rulesPage = 'apps/hadrius-app/pages/rules/index.tsx';
  assert.equal(r.shellOnlyLabel(fx.A, rulesPage, 'People Oversight'), true);
  assert.equal(r.shellOnlyLabel(fx.D, rulesPage, 'People'), true);
  assert.equal(r.shellOnlyLabel(fx.A, rulesPage, 'Trading Rules'), false);
  assert.equal(r.shellOnlyLabel(fx.A, rulesPage, 'Not a label anywhere'), false);
  assert.deepEqual([...r.filesTouched(fx.B)].sort(), ['apps/hadrius-app/pages/rules/[ruleId].tsx', VIEW_RULES].sort());
});

test('provider: the same live build at recording and capture = no frontend release on every slide', async () => {
  const fx = makeFrontendRepo();
  const r = await provider(fx)({ script, runDir: runDir([{ index: 0, route: '/rules', todayUrl: 'https://app.hadrius.com/rules', visibleText: 'Trading Rules' }]), capturedAt: '2026-10-06T00:00:00Z' });
  assert.equal(r.summary.status, 'no_release'); assert.equal(r.byStep[0].status, 'no_release');
});

test('provider: releases that never touched the screen files are reported as such, not guessed', async () => {
  const fx = makeFrontendRepo();
  const r = await provider(fx)({ script: { ...script, recording: { recordedAt: '2026-10-12T00:00:00Z' } },
    runDir: runDir([{ index: 0, route: '/rules', todayUrl: 'https://app.hadrius.com/rules', visibleText: 'Trading Rules\nNew rule' }]), capturedAt: '2026-10-21T00:00:00Z' });
  assert.equal(r.byStep[0].status, 'no_release_touched_screen'); assert.deepEqual(r.byStep[0].commits, []);
});

test('provider fails closed: no mirror, or a recording older than every deploy', async () => {
  const missing = createReleaseProvider({ git: createFrontendGit('/nonexistent/frontend.git'), loadDeployments: async () => [] });
  await assert.rejects(missing({ script, runDir: '/x', capturedAt: '2026-10-21T00:00:00Z' }), /frontend_mirror_missing/);
  const fx = makeFrontendRepo();
  await assert.rejects(provider(fx)({ script: { ...script, recording: { recordedAt: '2026-09-01T00:00:00Z' } }, runDir: '/x', capturedAt: '2026-10-21T00:00:00Z' }), /release_bracket:no_deploy_before_recording/);
});
