import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRecordingIntegrity } from '../tools/recording-integrity.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const step = (index, file, extra = {}) => ({ index, action: 'click', url: 'https://example.test/policies', media: { pre: file }, ...extra });
  const put = (name, value) => fs.writeFileSync(path.join(dir, name), value);
  return { dir, step, put };
}

test('missing captures fail instead of copying the preceding screenshot', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'list');
  assert.throws(() => assertRecordingIntegrity({ steps: [step(0, 'a.png'), step(1, 'b.png')] }, dir), /step 2.*missing/i);
  assert.equal(fs.existsSync(path.join(dir, 'b.png')), false);
});
test('captured steps without a media reference fail; explicitly excluded steps do not', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'list');
  assert.throws(() => assertRecordingIntegrity({ steps: [step(0, 'a.png'), { index: 1 }] }, dir), /step 2.*missing/i);
  assert.doesNotThrow(() => assertRecordingIntegrity({ steps: [step(0, 'a.png'), { index: 1, capture: false }] }, dir));
});
test('legacy copied list pixels cannot stand in for a document route or dialog', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'list'); put('b.png', 'list');
  for (const extra of [{ url: 'https://example.test/policies/1177' }, { target: { inDialog: true } }]) {
    assert.throws(() => assertRecordingIntegrity({ steps: [step(0, 'a.png', { target: { inDialog: false } }), step(1, 'b.png', extra)] }, dir), /identical.*different page or dialog/i);
  }
});
test('same-screen highlights and deliberately reused source frames are allowed', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'list'); put('b.png', 'list');
  assert.doesNotThrow(() => assertRecordingIntegrity({ steps: [step(0, 'a.png'), step(1, 'b.png')] }, dir));
  assert.doesNotThrow(() => assertRecordingIntegrity({ steps: [step(0, 'a.png'), step(1, 'a.png', { url: 'https://example.test/other' })] }, dir));
});
test('real different screenshots pass and changing image bytes changes the digest', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'list'); put('b.png', 'dialog');
  const script = { steps: [step(0, 'a.png'), step(1, 'b.png', { target: { inDialog: true } })] };
  const a = assertRecordingIntegrity(script, dir); put('b.png', 'corrected dialog');
  assert.notEqual(assertRecordingIntegrity(script, dir), a);
});

test('equivalent query encoding and navigation without a target do not imply another screen', t => {
  const { dir, step, put } = fixture(t); put('a.png', 'same screen'); put('b.png', 'same screen');
  assert.doesNotThrow(() => assertRecordingIntegrity({ steps: [
    step(0, 'a.png', { url: 'https://example.test/view?name=A+B&tab=1' }),
    step(1, 'b.png', { url: 'https://example.test/view?tab=1&name=A%20B', target: { inDialog: true } }),
  ] }, dir));
});
