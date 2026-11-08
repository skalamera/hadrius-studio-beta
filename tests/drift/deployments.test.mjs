import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeploymentRows, liveAt, bracket, fetchProductionDeployments } from '../../tools/drift/deployments.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const tsv = [
  `${C}\t2026-10-30T12:10:00Z\t2026-10-30T12:11:15Z`,
  `${B}\t2026-10-01T17:40:00Z\t2026-10-01T17:44:22Z`,
  `${'d'.repeat(40)}\t2026-10-02T00:00:00Z\t`,
  `${A}\t2026-09-18T22:00:00Z\t2026-09-18T22:10:33Z`,
  'garbage',
].join('\n');

test('parseDeploymentRows keeps successful deploys sorted by the time they went live', () => {
  assert.deepEqual(parseDeploymentRows(tsv).map((d) => d.sha), [A, B, C]);
});

test('liveAt: last deploy that succeeded at or before the moment', () => {
  const d = parseDeploymentRows(tsv);
  assert.equal(liveAt(d, '2026-09-18T22:10:33Z').sha, A);
  assert.equal(liveAt(d, '2026-10-01T18:43:23Z').sha, B);
  assert.equal(liveAt(d, '2026-09-01T00:00:00Z'), null);
  assert.equal(liveAt(d, 'not a date'), null);
});

test('bracket: baseline live at recording, current live at capture; same SHA = no release; bad input fails', () => {
  const d = parseDeploymentRows(tsv);
  const b = bracket(d, { recordedAt: '2026-10-01T18:43:23Z', capturedAt: '2026-10-30T16:36:39Z' });
  assert.deepEqual([b.baseline.sha, b.current.sha, b.changed], [B, C, true]);
  assert.equal(bracket(d, { recordedAt: '2026-10-02T00:00:00Z', capturedAt: '2026-10-03T00:00:00Z' }).changed, false);
  assert.equal(bracket(d, { recordedAt: '2026-01-01T00:00:00Z', capturedAt: '2026-10-03T00:00:00Z' }).error, 'no_deploy_before_recording');
  assert.equal(bracket(d, { recordedAt: '2026-10-03T00:00:00Z', capturedAt: '2026-10-02T00:00:00Z' }).error, 'capture_before_recording');
  assert.equal(bracket(d, { recordedAt: undefined, capturedAt: '2026-10-02T00:00:00Z' }).error, 'missing_timestamps');
});

test('fetchProductionDeployments fails closed on an empty answer', async () => {
  await assert.rejects(fetchProductionDeployments({ run: async () => '' }), /no successful production deployments/);
});
