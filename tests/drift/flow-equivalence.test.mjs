import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { bytesDigest, digest } from '../../tools/drift/contracts.mjs';
import { FLOW_EQUIVALENCE_SOURCE as PIN, verifyPinnedFlowSource, verifySavedFlowEquivalence } from '../../tools/drift/flow-equivalence.mjs';

// Complete real blobs from the reviewed commit, compressed only to keep offline unit fixtures
// small. Tests neither need a mirror nor fetch/execute frontend code. The checker hashes every
// full blob, so excerpts or invented hashes cannot make the positive source test pass.
const SOURCE_SNAPSHOTS = JSON.parse(inflateSync(Buffer.from('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', 'base64')).toString());
const OLD = 'https://app.hadrius.com/account', CURRENT = 'https://app.hadrius.com/settings/account';
function handle(path, bytes) { bytes = Buffer.from(bytes); return { path, bytes, sha256: bytesDigest(bytes) }; }
function jsonHandle(path, value) { return handle(path, JSON.stringify(value)); }
// Small valid PNG fixtures with independently generated CRCs, not fake image headers.
function png(shade) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let n = 0; n < 8; n++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    const size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(data.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, check]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, ...Array(6).fill(shade), 0, ...Array(6).fill(shade)]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const target = { i: 30, name: 'Use as admin', role: 'button', tag: 'button', visible: true,
    recordHint: null, inForm: false, inDialog: false, submits: false, fileInput: false, href: null,
    bbox: { x: 0, y: 0, w: 1, h: 1 } };
  const script = { name: 'Switching', recording: { id: 'recording-id' }, steps: [
    { index: 6, action: 'click', capture: true, target: { name: 'Use as admin', role: 'button', tag: 'a', text: 'Use as admin' },
      url: OLD, route: '/account', media: { pre: 'recorded-6.png' }, narration: 'Use as admin.' },
    { index: 7, action: 'navigate', capture: true, value: OLD, url: OLD, route: '/account', media: { pre: 'recorded-7.png' } },
  ] };
  const run = { script: script.name, recordingId: script.recording.id, scriptPath: '/scripts/switching.json',
    status: 'captured', signedIn: true, tenantVerified: true, viewport: { width: 2, height: 2 },
    findings: [{ step: 6, kind: 'click_navigated_unexpectedly', expected: OLD, actual: CURRENT }], steps: [
      { index: 6, action: 'click', url: OLD, route: '/account', recordedMedia: 'recorded-6.png', screenshot: 'step-06-today.png',
        todayUrl: CURRENT, mutation: { mutating: false }, visibleText: 'Account\nUse as admin\nSign out',
        target: { status: 'resolved', method: 'name_any_role', recordedName: 'Use as admin', matches: [target], resolved: target, rect: target.bbox },
        clicked: true, performed: 'click', afterClickUrl: CURRENT },
      { index: 7, action: 'navigate', url: OLD, route: '/account', recordedMedia: 'recorded-7.png', screenshot: 'step-07-today.png',
        todayUrl: CURRENT, mutation: { mutating: false }, visibleText: 'People directory\nAccount\nUse as employee\nSign out' },
    ] };
  const release = { currentSha: PIN.commit, routePath: '/settings/account', routeEntryFile: 'apps/hadrius-app/pages/settings/account.tsx', capturedAt: 'saved-run' };
  const job = { name: script.name, recordingId: script.recording.id, scriptPath: run.scriptPath, scriptHash: digest(script),
    captureStatus: 'captured', startedAt: 'saved-run', errors: [], evidence: { runDir: '/capture' }, steps: [
      { index: 6, action: 'click', target: { status: 'resolved', method: 'name_any_role', recordedName: 'Use as admin', todayName: 'Use as admin' },
        reasons: [{ code: 'flow_changed' }, { code: 'page_redesigned' }], evidence: { today: '/capture/step-06-today.png' }, uiReleaseEvidence: release },
      { index: 7, action: 'navigate', evidence: { today: '/capture/step-07-today.png' }, uiReleaseEvidence: release },
    ] };
  const data = { script, run, job };
  return { data, pack() { return {
    stepIndex: 6, scriptFile: jsonHandle(run.scriptPath, script), runFile: jsonHandle('/capture/run.json', run), jobFile: jsonHandle('/job/job.json', job),
    preScreenshot: handle('/capture/step-06-today.png', png(240)), postScreenshot: handle('/capture/step-07-today.png', png(32)),
    source: { commit: PIN.commit, files: PIN.files.map(pin => ({ ...pin, bytes: SOURCE_SNAPSHOTS[pin.path] })) },
  }; } };
}
function reject(mutate, expected) {
  const f = fixture(); mutate(f.data); const result = verifySavedFlowEquivalence(f.pack());
  assert.equal(result.verified, false); assert.equal(result.binding, null);
  if (expected) assert.ok(result.reasons.includes(expected), JSON.stringify(result.reasons));
}

test('positive exact saved click across reviewed alias binds source, run, script, job and both images', () => {
  const f = fixture(), input = f.pack(), before = digest(JSON.parse(JSON.stringify(input))), result = verifySavedFlowEquivalence(input);
  assert.equal(result.verified, true, result.reasons.join(','));
  assert.equal(result.scope, 'single_mode_switch_route_alias_only');
  assert.equal(result.binding.source.commit, PIN.commit);
  assert.equal(result.binding.source.files.length, 6);
  assert.equal(result.binding.postcondition.visibleOppositeControl, 'Use as employee');
  assert.equal(result.binding.postcondition.resultingMode, 'ADMIN');
  assert.equal(result.binding.files.preScreenshot.sha256, input.preScreenshot.sha256);
  assert.equal(result.binding.files.postScreenshot.sha256, input.postScreenshot.sha256);
  assert.equal(result.binding.files.run.sha256, input.runFile.sha256);
  assert.equal(result.binding.scriptStepDigest, digest(f.data.script.steps[0]));
  assert.equal(result.binding.nextRunStepDigest, digest(f.data.run.steps[1]));
  assert.equal(result.bindingDigest, digest(result.binding));
  assert.equal(digest(JSON.parse(JSON.stringify(input))), before, 'pure check must not mutate source evidence');
  assert.ok(f.data.job.steps[0].reasons.some(x => x.code === 'page_redesigned'), 'no raw diagnostic is removed');
});

test('source review requires full pinned immutable bytes, not a caller alias or confirmed flag', () => {
  const input = fixture().pack(); assert.equal(verifyPinnedFlowSource(input.source).verified, true);
  for (const change of [
    x => { x.source = { commit: PIN.commit, confirmed: true, aliases: { '/account': '/settings/account' } }; },
    x => { x.source.commit = '0'.repeat(40); },
    x => { x.source.files.pop(); },
    x => { x.source.files[0] = x.source.files[1]; },
    x => { x.source.files[0].bytes += '\n'; },
    x => { x.source.files[0].sha256 = '0'.repeat(64); },
    x => { x.source.files[0].blobSha = '0'.repeat(40); },
    x => { x.source.files[0].bytes = 'source: "/account", destination: "/settings/account"'; x.source.files[0].sha256 = bytesDigest(x.source.files[0].bytes); },
  ]) { const x = fixture().pack(); change(x); assert.equal(verifySavedFlowEquivalence(x).verified, false); }
});

test('same complete reviewed blobs may bind a later exact capture commit, never a mismatched deployment', () => {
  const actual = 'a'.repeat(40), f = fixture();
  for (const step of f.data.job.steps) step.uiReleaseEvidence.currentSha = actual;
  f.data.run.currentSha = actual;
  f.data.job.releaseEvidence = { currentSha: actual };
  const input = f.pack(); input.source.commit = actual;
  const proof = verifySavedFlowEquivalence(input);
  assert.equal(proof.verified, true, JSON.stringify(proof.reasons));
  assert.equal(proof.binding.source.commit, actual);
  assert.equal(proof.binding.source.captureCommit, actual);
  assert.equal(proof.binding.source.reviewedAtCommit, PIN.commit);
  assert.equal(proof.binding.routeAlias.sourceCommit, PIN.commit);
  assert.ok(proof.binding.source.files.every(x => x.gitObject === `${actual}:${x.path}`));
  for (const mutate of [
    x => { x.source.commit = PIN.commit; },
    x => { x.source.commit = 'HEAD'; },
    x => { x.source.captureCommit = PIN.commit; },
    x => { x.source.reviewedAtCommit = actual; },
    x => { x.source.files[2].bytes += '\n'; },
    x => { const value = JSON.parse(Buffer.from(x.runFile.bytes)); value.currentSha = PIN.commit; x.runFile = jsonHandle(x.runFile.path, value); },
    x => { const value = JSON.parse(Buffer.from(x.jobFile.bytes)); value.releaseEvidence.currentSha = PIN.commit; x.jobFile = jsonHandle(x.jobFile.path, value); },
  ]) { const changed = structuredClone(input); mutate(changed); assert.equal(verifySavedFlowEquivalence(changed).verified, false); }
});

test('no generic flow_changed waiver for a genuinely changed workflow, URL, form or row action', () => {
  for (const change of [
    d => { d.run.steps[0].afterClickUrl = 'https://app.hadrius.com/new-template-chooser'; },
    d => { d.run.findings[0].kind = 'click_destination_differs'; },
    d => { d.run.findings.push({ step: 7, kind: 'target_missing' }); },
    d => { d.job.steps[0].reasons.push({ code: 'flow_changed', detail: 'another workflow failure' }); },
    d => { d.job.steps[1].reasons = [{ code: 'flow_changed' }]; },
    d => { d.run.findings[0].actual += '?new=true'; },
    d => { d.run.steps[1].todayUrl = 'https://app.hadrius.com/employees'; },
    d => { d.script.steps[0].target.name = 'Create group'; d.job.scriptHash = digest(d.script); },
    d => { d.script.steps[1].value = 'https://app.hadrius.com/new-template-chooser'; d.job.scriptHash = digest(d.script); },
    d => { d.run.steps[0].target.resolved.recordHint = 'FLAG-123 Resolved'; },
    d => { d.run.steps[0].target.resolved.inForm = true; },
    d => { d.run.steps[0].target.resolved.submits = true; },
    d => { d.run.steps[0].mutation.mutating = true; },
  ]) reject(change);
});

test('only unique exact accessible label resolved semantically to the actual performed control is accepted', () => {
  for (const change of [
    d => { d.run.steps[0].target = null; },
    d => { d.run.steps[0].target.status = 'missing'; },
    d => { d.run.steps[0].target.method = 'css'; },
    d => { d.run.steps[0].target.matches.push(structuredClone(d.run.steps[0].target.resolved)); },
    d => { d.run.steps[0].target.matches = []; },
    d => { d.run.steps[0].target.resolved = { ...d.run.steps[0].target.resolved, name: 'Different control' }; },
    d => { d.run.steps[0].target.resolved.name = 'Use as Admin'; },
    d => { d.run.steps[0].target.resolved.visible = false; },
    d => { d.run.steps[0].target.resolved.disabled = true; },
    d => { d.run.steps[0].target.resolved.bbox.w = 0; },
    d => { delete d.run.steps[0].clicked; },
    d => { d.run.steps[0].clicked = false; },
    d => { d.run.steps[0].performed = 'hover'; },
    d => { delete d.run.steps[0].afterClickUrl; },
    d => { d.job.steps[0].target.todayName = 'Wrong'; },
  ]) reject(change);
});

test('wrong, absent, duplicated, suggested-only or failed opposite-mode state is not a postcondition', () => {
  for (const visibleText of ['', 'Account\nUse as admin\nSign out', 'Account\nHow do I Use as employee?',
    'Use as employee\nUse as employee', 'Use as employee\nUse as admin',
    'Use as employee\nUnable to switch view', 'Use as employee\nPlease try switching views again.']) {
    reject(d => { d.run.steps[1].visibleText = visibleText; }, 'mode_postcondition_unverified');
  }
  for (const change of [
    d => { d.run.steps[1].prerequisiteUnverified = true; },
    d => { d.run.steps[1].performed = 'click'; d.run.steps[1].clicked = true; },
    d => { d.run.steps[1].visibleText += '\nUse as admin'; },
    d => { d.run.steps[0].visibleText += '\nUse as employee\nUse as employee'; },
    d => { d.run.steps[1].mutationGuard = { status: 'captured_by_direct_navigation' }; },
    d => { d.run.steps[0].error = 'click failed'; },
    d => { d.run.steps[1].errorState = { message: 'Failed to load' }; },
    d => { d.run.steps[1].status = 'uncaptured'; },
    d => { delete d.run.steps[1].screenshot; },
    d => { d.run.steps[1].index = 8; },
    d => { d.run.steps.push(structuredClone(d.run.steps[1])); },
  ]) reject(change);
});

test('stale input hashes, missing bytes, wrong screenshot handles and detached claims fail closed', () => {
  for (const name of ['scriptFile', 'runFile', 'jobFile', 'preScreenshot', 'postScreenshot']) {
    for (const change of [x => { x[name].sha256 = '0'.repeat(64); }, x => { delete x[name].bytes; },
      x => { x[name].bytes = Buffer.concat([Buffer.from(x[name].bytes), Buffer.from('stale')]); }]) {
      const x = fixture().pack(); change(x); assert.equal(verifySavedFlowEquivalence(x).verified, false);
    }
  }
  const imageWrong = fixture().pack(); imageWrong.postScreenshot.path = '/capture/other.png';
  assert.equal(verifySavedFlowEquivalence(imageWrong).verified, false);
  const sameImage = fixture().pack(); sameImage.postScreenshot = { ...sameImage.preScreenshot, path: sameImage.postScreenshot.path };
  assert.equal(verifySavedFlowEquivalence(sameImage).verified, false);
  const notPng = fixture().pack(); notPng.postScreenshot = handle(notPng.postScreenshot.path, 'Use as employee');
  assert.equal(verifySavedFlowEquivalence(notPng).verified, false);
  const detached = fixture().pack(); detached.post = { visibleText: 'Use as employee', clicked: true };
  delete detached.runFile.bytes; assert.equal(verifySavedFlowEquivalence(detached).verified, false);
});

test('identity, release and guard failures cannot be repaired by source metadata', () => {
  for (const change of [
    d => { d.run.script = 'Different video'; },
    d => { d.run.recordingId = 'Different recording'; },
    d => { d.script.steps[0].narration = 'Stale script'; },
    d => { d.run.status = 'failed'; },
    d => { d.run.aborted = 'stopped'; },
    d => { d.run.mutationStop = { index: 5 }; },
    d => { d.run.tenantVerified = false; },
    d => { d.job.errors.push('failed'); },
    d => { d.job.steps[0].uiReleaseEvidence.currentSha = '0'.repeat(40); },
    d => { d.job.steps[0].uiReleaseEvidence.capturedAt = 'another run'; },
    d => { d.job.steps[1].evidence.today = '/capture/wrong-image.png'; },
  ]) reject(change);
  assert.equal(verifySavedFlowEquivalence().verified, false);
  assert.equal(verifySavedFlowEquivalence(null).verified, false);
});
