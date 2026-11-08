import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmsProductionUiCodeChange, releaseGate, isUiSourcePath, describeRelease } from '../../tools/drift/release-evidence.mjs';
import { confirmedRelease, candidateRelease } from './release-fixture.mjs';

test('a verified change from a release commit that touched this screen confirms a production UI redesign', () => {
  assert.equal(confirmsProductionUiCodeChange(confirmedRelease()), true);
  assert.match(describeRelease(confirmedRelease()), /renamed "New rule" \(#2\)/);
});

test('release evidence fails closed on anything missing, out of order or unverified', () => {
  const ok = confirmedRelease();
  for (const patch of [
    { status: 'no_release' }, { environment: 'Preview – hadrius-frontend' }, { baselineSha: 'short' }, { currentSha: ok.baselineSha },
    { baselineDeployedAt: '2026-10-06T00:00:00Z' }, { currentDeployedAt: '2026-10-04T00:00:00Z' }, { currentDeployedAt: '2026-10-31T00:00:00Z' },
    { routeEntryFile: 'apps/hadrius-app/src/features/rules/view_rules.tsx' }, { screenFiles: [] }, { screenFiles: ['apps/hadrius-app/src/api/rules.ts'] },
    { commits: [] }, { commits: [{ ...ok.commits[0], files: ['apps/hadrius-app/src/features/other/view_other.tsx'] }] },
    { redesign: undefined }, { redesign: { ...ok.redesign, confirmed: false } },
    { redesign: { ...ok.redesign, changes: [{ ...ok.redesign.changes[0], verified: false }] } },
    { redesign: { ...ok.redesign, changes: [{ ...ok.redesign.changes[0], kind: 'restyled' }] } },
    { redesign: { ...ok.redesign, changes: [{ ...ok.redesign.changes[0], commit: 'f'.repeat(40) }] } },
  ]) assert.equal(confirmsProductionUiCodeChange({ ...ok, ...patch }), false, JSON.stringify(patch));
  assert.equal(confirmsProductionUiCodeChange(null), false);
});

test('chrome redesigns need the verified change to come from a commit that touched an app-shell file', () => {
  assert.equal(confirmsProductionUiCodeChange(confirmedRelease(), { chrome: true }), false);
  assert.equal(confirmsProductionUiCodeChange(confirmedRelease({ chrome: true }), { chrome: true }), true);
});

test('releaseGate explains every non-confirmed state and asks for a review only for candidates', () => {
  const c = candidateRelease();
  const states = [null, { ...c, status: 'no_release' }, { ...c, status: 'no_release_touched_screen', commits: [] }, { ...c, status: 'route_unmapped' }, c,
    { ...c, redesign: { confirmed: false, changes: [], rejected: [], reason: 'only data differs' } }];
  assert.deepEqual(states.map((ev) => [releaseGate(ev).code, !!releaseGate(ev).needsRedesignJudge]), [
    ['redesign_release_unconfirmed', false], ['no_frontend_release', false], ['no_release_touched_screen', false],
    ['redesign_release_unconfirmed', false], ['redesign_unreviewed', true], ['redesign_not_confirmed', false]]);
  assert.equal(releaseGate(null, { chrome: true }).code, 'chrome_release_unconfirmed');
  assert.equal(releaseGate(confirmedRelease()).ok, true);
});

test('only source files capable of rendering UI qualify', () => {
  assert.equal(isUiSourcePath('apps/hadrius-app/pages/people-oversight/index.tsx'), true);
  assert.equal(isUiSourcePath('apps/hadrius-app/src/lib/routes/route_prefixes.ts'), true);
  assert.equal(isUiSourcePath('packages/pantheon/src/components/button.tsx'), true);
  for (const p of ['apps/hadrius-app/generated/api/certifications.ts', 'apps/hadrius-app/pages/api/certifications.ts',
    'apps/hadrius-app/src/features/policies/page_policy.test.tsx', 'apps/hadrius-app/src/api/certifications/api.ts', 'apps/hadrius-app/src/features/../.env', '/abs.tsx'])
    assert.equal(isUiSourcePath(p), false, p);
});
