// tests/drift/release-fixture.mjs — release-evidence shapes produced by release-provider.mjs and confirmed by
// redesign-judge.mjs. Not a test file (node --test only runs *.test.mjs).
import { PRODUCTION_FRONTEND_ENVIRONMENT } from '../../tools/drift/release-evidence.mjs';

export const VIEW = 'apps/hadrius-app/src/features/rules/view_rules.tsx';
export const NAV = 'apps/hadrius-app/src/app_shell/nav_bar.tsx';

export function confirmedRelease({ chrome = false, ...over } = {}) {
  const commit = { sha: 'c'.repeat(40), date: '2026-10-20T00:00:00Z', subject: 'Rules toolbar redesign (#2)', pr: 2, files: [chrome ? NAV : VIEW] };
  return {
    environment: PRODUCTION_FRONTEND_ENVIRONMENT, status: 'candidates',
    baselineSha: 'a'.repeat(40), currentSha: 'b'.repeat(40),
    recordedAt: '2026-10-05T00:00:00Z', capturedAt: '2026-10-30T16:00:00Z',
    baselineDeployedAt: '2026-10-01T00:00:00Z', currentDeployedAt: '2026-10-29T00:00:00Z',
    routePath: '/rules', routeEntryFile: 'apps/hadrius-app/pages/rules/index.tsx',
    screenFiles: [NAV, VIEW], shellFiles: [NAV], commits: [commit],
    redesign: { confirmed: true, reason: 'toolbar button renamed', rejected: [], changes: [chrome
      ? { element: 'sidebar item', kind: 'renamed', before: 'People Oversight', after: 'People', commit: commit.sha, verified: true }
      : { element: 'toolbar button', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: commit.sha, verified: true }] },
    ...over,
  };
}

/** The same evidence before the redesign review ran (status 'candidates', no `redesign`). */
export function candidateRelease(over = {}) {
  const { redesign, ...rest } = confirmedRelease(over);
  return rest;
}
