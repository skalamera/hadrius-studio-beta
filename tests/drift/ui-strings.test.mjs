import test from 'node:test';
import assert from 'node:assert/strict';
import { uiStrings, labelText, normalizeText, visibleLines, containsPhrase } from '../../tools/drift/ui-strings.mjs';

const src = `import { Button } from "src/x";
export function View({ n }: { n: number }) {
  return <div className="flex gap-2 text-sm"><h1>Trade Monitoring</h1>
    <Button variant="primary" onClick={() => console.log("Clicked save")}>Create rule</Button>
    <p title="Rules that apply to every account">{n} selected</p>
    <span className={cn("px-2", "font-medium")}>Needs attention</span>
    <input placeholder="Search rules" data-testid="rule-search" /></div>;
}
const STATUS = { needs_review: "Needs review", key: "rule_id" };`;

test('uiStrings keeps visible labels and drops class lists, identifiers, imports, logs and test ids', () => {
  const s = uiStrings(src, 'view.tsx');
  for (const t of ['trade monitoring', 'create rule', 'rules that apply to every account', 'needs attention', 'search rules', 'needs review']) assert.ok(s.has(t), t);
  for (const t of ['flex gap-2 text-sm', 'primary', 'clicked save', 'px-2', 'font-medium', 'rule-search', 'rule_id', 'src/x', 'selected']) assert.ok(!s.has(t), t);
});

test('normalisation, visible lines (with and without trailing counts) and whole-phrase containment', () => {
  assert.equal(normalizeText('  Create   Rule…: '), 'create rule');
  assert.equal(labelText('flex flex-col'), null); assert.equal(labelText('archived'), null); assert.equal(labelText('Archived'), 'archived');
  const v = visibleLines('Trade Monitoring\nNeeds attention 3\n\n  Create rule  \nSubmitter review0');
  for (const t of ['trade monitoring', 'needs attention 3', 'needs attention', 'create rule', 'submitter review']) assert.ok(v.has(t), t);
  assert.ok(containsPhrase('Showing 0 of 0 results', '0 of 0'));
  assert.ok(!containsPhrase('Create rules', 'create rule'));
});

test('table-cell labels are separate labels, without promoting words inside a label', () => {
  const labels = visibleLines('Employee name\tStatus\tPermissions\tGroups\tOpen items\nPermissions & groups');
  for (const label of ['employee name', 'status', 'permissions', 'groups', 'open items']) assert.ok(labels.has(label), label);
  assert.ok(visibleLines('Permissions & groups').has('permissions & groups'));
  assert.equal(visibleLines('Permissions & groups').has('groups'), false);
});
