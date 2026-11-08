import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRedesignPrompt, parseRedesignJudge, verifyRedesign, makeRedesignJudge, reviewRedesign, rankCommits, isLabelLine, labelsInDiffLine } from '../../tools/drift/redesign-judge.mjs';
import { candidateRelease } from './release-fixture.mjs';

test('parseRedesignJudge: strict shape; unknown kinds count as styling; "null" strings become null', () => {
  assert.throws(() => parseRedesignJudge(null), /not_object/);
  assert.throws(() => parseRedesignJudge({ changes: [], reason: 'x' }), /missing_redesigned/);
  assert.throws(() => parseRedesignJudge({ redesigned: true, reason: 'x' }), /missing_changes/);
  assert.throws(() => parseRedesignJudge({ redesigned: true, changes: [] }), /missing_reason/);
  const p = parseRedesignJudge({ redesigned: true, reason: 'r', changes: [{ element: 'e', kind: 'teleported', before: 'null', after: 'New rule', commit: null }] });
  assert.deepEqual(p.changes, [{ element: 'e', kind: 'restyled', before: null, after: 'New rule', commit: null }]);
});

test('verifyRedesign keeps only changes backed by a release commit, today\'s DOM and label strings in code', () => {
  const commits = [{ sha: 'c'.repeat(40), pr: 2, subject: 'Rules toolbar redesign (#2)', files: ['apps/hadrius-app/src/features/rules/view_rules.tsx'] }];
  const todayText = 'Trading Rules\nNew rule\nImport rules\nHadrius Sandbox LLC\n3 rules';
  const currentStrings = new Set(['trading rules', 'new rule', 'import rules']);
  const baselineStrings = new Set(['trading rules', 'create rule']);
  const diffLabelsOf = (sha) => (sha === 'c'.repeat(40) ? { added: ['new rule', 'import rules'], removed: ['create rule'] } : { added: [], removed: [] });
  const judge = parseRedesignJudge({ redesigned: true, reason: 'toolbar changed', changes: [
    { element: 'primary button', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: 'cccccccccccc' },
    { element: 'import button', kind: 'added', before: null, after: 'Import rules', commit: 'cccccccccccc' },
    { element: 'company name', kind: 'renamed', before: 'Acme LLC', after: 'Hadrius Sandbox LLC', commit: 'cccccccccccc' },
    { element: 'button colour', kind: 'restyled', before: null, after: 'New rule', commit: 'cccccccccccc' },
    { element: 'swapped', kind: 'renamed', before: 'New rule', after: 'Create rule', commit: 'cccccccccccc' },
    { element: 'phantom', kind: 'added', before: null, after: 'Import rules', commit: 'deadbeefdead' }] });
  const v = verifyRedesign({ judge, commits, todayText, currentStrings, baselineStrings, diffLabelsOf });
  assert.equal(v.confirmed, true);
  assert.deepEqual(v.changes.map((c) => [c.element, c.commit, c.verified]), [['primary button', 'c'.repeat(40), true], ['import button', 'c'.repeat(40), true]]);
  assert.deepEqual(Object.fromEntries(v.rejected.map((r) => [r.element, r.why])), {
    'company name': ['after_not_a_label_in_code', 'before_not_a_label_in_code', 'not_in_commit_diff'],
    'button colour': ['styling_only'],
    swapped: ['after_not_on_screen_today', 'after_not_a_label_in_code', 'before_still_on_screen_today', 'before_not_a_label_in_code', 'not_in_commit_diff'],
    phantom: ['no_matching_release_commit'],
  });
  assert.equal(verifyRedesign({ judge: { ...judge, redesigned: false }, commits, todayText, currentStrings, baselineStrings, diffLabelsOf }).confirmed, false);
  // Without the commit diffs nothing can be tied to a release: fail closed.
  assert.equal(verifyRedesign({ judge, commits, todayText, currentStrings, baselineStrings }).confirmed, false);
});

test('verifyRedesign: the change must be in its own commit\'s diff; an "added" label that already existed is an account/visibility difference', () => {
  const C = 'c'.repeat(40), D = 'd'.repeat(40);
  const commits = [{ sha: C, pr: 2, subject: 'Rules toolbar redesign (#2)', files: ['view_rules.tsx'] }, { sha: D, pr: 3, subject: 'Add accessible sidebar account menu (#3)', files: ['sidebar.tsx'] }];
  const diffs = { [C]: { added: ['new rule', 'import rules'], removed: ['create rule'] }, [D]: { added: ['account menu'], removed: [] } };
  const todayText = 'User counts\nTrading Rules\nNew rule\nImport rules';
  const currentStrings = new Set(['user counts', 'trading rules', 'new rule', 'import rules', 'account menu']);
  const judge = parseRedesignJudge({ redesigned: true, reason: 'x', changes: [
    { element: 'primary button', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: 'cccccccccccc' },
    { element: 'sidebar item', kind: 'added', before: null, after: 'User counts', commit: 'dddddddddddd' },
    { element: 'import button', kind: 'added', before: null, after: 'Import rules', commit: 'dddddddddddd' }] });
  const v = verifyRedesign({ judge, commits, todayText, currentStrings, baselineStrings: new Set(['create rule']),
    baselineScreenStrings: new Set(['create rule', 'user counts', 'trading rules']), diffLabelsOf: (sha) => diffs[sha] });
  assert.deepEqual(v.changes.map((c) => c.element), ['primary button']);
  assert.deepEqual(Object.fromEntries(v.rejected.map((r) => [r.element, r.why])), {
    'sidebar item': ['not_in_commit_diff', 'after_already_in_old_code'],
    'import button': ['not_in_commit_diff'],
  });
});

test('verifyRedesign: a sidebar/app-shell change counts only when the slide uses it (narration, caption or click target)', () => {
  const S = 's'.repeat(40), P = 'p'.repeat(40);
  const commits = [{ sha: S, pr: 4997, subject: 'Add accessible sidebar account menu (#4997)', files: ['apps/hadrius-app/src/app_shell/sidebar.tsx'] },
    { sha: P, pr: 4977, subject: 'Exceptions table (#4977)', files: ['apps/hadrius-app/src/features/exceptions/table.tsx'] }];
  const diffs = { [S]: { added: ['ask hadrius'], removed: ['ask hadrius', 'announcements'] }, [P]: { added: ['risk level'], removed: [] } };
  const strings = new Set(['ask hadrius', 'announcements', 'exceptions']);
  const judge = parseRedesignJudge({ redesigned: true, reason: 'x', changes: [
    { element: 'sidebar entry', kind: 'moved', before: 'Ask Hadrius', after: 'Ask Hadrius', commit: S.slice(0, 12) },
    { element: 'sidebar item', kind: 'removed', before: 'Announcements', after: null, commit: S.slice(0, 12) },
    { element: 'table column', kind: 'added', before: null, after: 'Risk level', commit: P.slice(0, 12) }] });
  const base = { judge, commits, todayText: 'Ask Hadrius\nExceptions\nRisk level', currentStrings: new Set(['ask hadrius', 'exceptions', 'risk level']),
    baselineStrings: strings, baselineScreenStrings: strings, diffLabelsOf: (sha) => diffs[sha],
    isShellChange: (ch) => /ask hadrius|announcements/i.test(ch.after ?? ch.before) };
  const v = verifyRedesign({ ...base, slideText: 'Click Add firm to add an affiliated firm.' });
  assert.deepEqual(v.changes.map((c) => c.element), ['table column']);
  assert.deepEqual(Object.fromEntries(v.rejected.map((r) => [r.element, r.why])), {
    'sidebar entry': ['shell_change_not_used_on_slide'], 'sidebar item': ['shell_change_not_used_on_slide'] });
  const used = verifyRedesign({ ...base, slideText: 'Open Announcements from the sidebar.' });
  assert.deepEqual(used.changes.map((c) => c.element), ['sidebar item', 'table column']);
});

test('labelsInDiffLine: quoted literals, JSX text and bare JSX text lines; never code', () => {
  assert.deepEqual(labelsInDiffLine('+  <Button>New rule</Button>'), ['new rule']);
  assert.deepEqual(labelsInDiffLine('-  title="Create rule"'), ['create rule']);
  assert.deepEqual(labelsInDiffLine('+          Account reporting questions'), ['account reporting questions']);
  assert.deepEqual(labelsInDiffLine('+  const { data } = useRules(projectId);'), []);
  assert.deepEqual(labelsInDiffLine('+  export default RulesPage'), []);
  assert.deepEqual(labelsInDiffLine('+  return'), []);
  assert.deepEqual(labelsInDiffLine('+  className="flex items-center gap-2"'), []);
});

test('makeRedesignJudge: Claude gets both screenshot paths and the release list; the reply is parsed strictly', async () => {
  let seen;
  const judge = makeRedesignJudge({
    cs: { decisionModel: () => 'test-model', extractJson: (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) },
    runModel: async (prompt, opts) => { seen = { prompt, opts }; opts.onMeta({ model: 'test-model', costUsd: 0.01 }); return 'Here:\n{"redesigned":false,"changes":[],"data_differences":["different rows"],"reason":"only data differs"}'; },
  });
  const out = await judge({ title: 'Vid', stepNumber: 2, stepCount: 5, recordedPath: '/rec/r1.png', todayPath: '/run/t1.png', todayText: 'Trading Rules',
    commits: [{ sha: 'c'.repeat(40), pr: 2, date: '2026-10-20T00:00:00Z', subject: 'Rules toolbar redesign (#2)', files: ['a.tsx'], excerpt: '+ New rule' }] });
  assert.match(seen.prompt, /RECORDED \(old, from the video\): \/rec\/r1\.png/);
  assert.match(seen.prompt, /TODAY \(live product now\): \/run\/t1\.png/);
  assert.match(seen.prompt, /commit cccccccccccc \(PR #2\) 2026-10-20: Rules toolbar redesign/);
  assert.equal(seen.opts.allowedTools, 'Read'); assert.equal(seen.opts.model, 'test-model');
  assert.deepEqual(out, { redesigned: false, changes: [], data_differences: ['different rows'], reason: 'only data differs', model: 'test-model', costUsd: 0.01 });
  assert.match(buildRedesignPrompt({ title: 'T', stepNumber: 1, stepCount: 1, recordedPath: 'r', todayPath: 't', todayText: '', commits: [] }), /\(none\)/);
});

test('rankCommits: commits that add/remove label text go first; excerpts lead with label lines', () => {
  assert.equal(isLabelLine(`+  <Button>New rule</Button>`), true);
  assert.equal(isLabelLine(`-  title="Create rule"`), true);
  assert.equal(isLabelLine(`+  const { data } = useRules(projectId);`), false);
  assert.equal(isLabelLine(`+  className="flex items-center gap-2"`), false);
  const commits = [{ sha: 'a'.repeat(40), files: ['x.ts'] }, { sha: 'b'.repeat(40), files: ['y.tsx'] }, { sha: 'c'.repeat(40), files: ['z.tsx'] }];
  const excerpts = { ['a'.repeat(40)]: '+  const { data } = useRules(projectId);', ['b'.repeat(40)]: '+  import x from "y";\n-  <Button>Create rule</Button>\n+  <Button>New rule</Button>', ['c'.repeat(40)]: '+  className="flex gap-2"' };
  const ranked = rankCommits(commits, (sha) => excerpts[sha], { max: 2 });
  assert.deepEqual(ranked.map((c) => c.sha[0]), ['b', 'a']);
  assert.match(ranked[0].excerpt, /^-  <Button>Create rule<\/Button>\n\+  <Button>New rule<\/Button>\n\+  import/);
});

test('reviewRedesign: verified review attached; a null judge leaves the slide unreviewed; errors fail closed', async () => {
  const ev = candidateRelease();
  const seen = [];
  const helpers = { excerpt: () => '+ <Button>New rule</Button>', filesTouched: () => ['apps/hadrius-app/src/features/rules/view_rules.tsx'],
    diffLabels: () => ({ added: ['new rule'], removed: ['create rule'] }),
    uiStringsAt: (sha) => (sha === ev.currentSha ? new Set(['new rule']) : new Set(['create rule'])) };
  const base = { releaseEvidence: helpers, evidence: ev, script: { name: 'Vid', steps: [{}, {}] }, step: { index: 1 }, paths: { recorded: '/r.png', today: '/t.png' }, todayText: 'New rule' };
  const judge = async (input) => { seen.push(input); return parseRedesignJudge({ redesigned: true, reason: 'renamed', changes: [{ element: 'button', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: 'c'.repeat(12) }] }); };
  const out = await reviewRedesign({ ...base, redesignJudge: judge });
  assert.equal(out.redesign.confirmed, true); assert.equal(seen[0].recordedPath, '/r.png'); assert.match(seen[0].commits[0].excerpt, /New rule/);
  assert.equal(await reviewRedesign({ ...base, redesignJudge: async () => null }), ev);
  const failed = await reviewRedesign({ ...base, redesignJudge: async () => { throw new Error('cli down'); } });
  assert.equal(failed.redesign.confirmed, false); assert.match(failed.redesign.error, /cli down/);
});
