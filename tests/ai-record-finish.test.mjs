// The recorder's "done": a take ends on its finished state, not on a dialog whose final button was never pressed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDialogDoneReason } from '../tools/ai-record.mjs';

test('done goes through when no dialog is open', () => {
  assert.equal(openDialogDoneReason([{ id: 1, role: 'button', name: 'New policy', inDialog: false }, { id: 2, role: 'link', name: 'Policies' }]), null);
  assert.equal(openDialogDoneReason([]), null);
  assert.equal(openDialogDoneReason(undefined), null);
});

test('done is refused while a dialog is still open, naming only its own controls', () => {
  const why = openDialogDoneReason([
    { id: 1, role: 'link', name: 'Policies', inDialog: false },
    { id: 2, role: 'button', name: 'Cancel', inDialog: true },
    { id: 3, role: 'button', name: 'Upload', inDialog: true },
    { id: 4, role: 'button', name: 'Upload', inDialog: true },
  ]);
  assert.match(why, /dialog is still open/i);
  assert.match(why, /"Cancel", "Upload"\)/, 'each control once, in page order');
  assert.doesNotMatch(why, /Policies/);
  assert.match(why, /reply "done"/i);
});

test('a dialog whose controls have no names is still an open dialog', () => {
  assert.match(openDialogDoneReason([{ id: 1, role: 'button', name: '', inDialog: true }]), /dialog is still open\. /);
});
