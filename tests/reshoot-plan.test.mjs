// Re-shoot plan and merge: a saved lesson's own steps become the recorder's path, and its narration is put back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reshootPlan, reshootStepKey, reshootMerge, reshootPairs, reshootGate, reshootProgress, reshootNote, reshootExact, labelOf } from '../tools/reshoot-plan.mjs';

const APP = 'https://app.hadrius.com';
const D = '/people-oversight/disclosures';
const nav = (path, narration = '') => ({ action: 'navigate', value: APP + path, url: APP + path, narration });
const click = (name, narration = '', extra = {}, path = `${D}?company_id=1150`) => ({ action: 'click', target: { name, role: 'button', ...extra }, narration, url: APP + path });
const type = (label, value, narration = '') => ({ action: 'type', value, target: { name: '', label, tag: 'input' }, narration, url: APP + D });
const shot = (s, file) => ({ ...s, media: { pre: file }, captureId: file.replace('.png', '') });
const PANEL = 'Home Hadrius Academy 1150 Overview People directory Templates Vendors People ove'; // 80 chars: a container
const PAGE = { role: '', tag: 'html' }; // a click that landed on the page itself
const show = (m) => m.steps.map((s) => `${s.action}:${s.media.pre}:${s.narration}`);
// LCS pairing by key, as the bridge's alignSteps does.
function pairs(a, b) {
  const ka = a.map(reshootStepKey), kb = b.map(reshootStepKey), same = (i, j) => ka[i] === kb[j] && !ka[i].endsWith('|');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = same(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) { if (same(i, j)) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}

const SAVED = [
  nav(D, 'Opening line.'),
  nav(D),
  click('Disclosures', 'The queue.', { role: 'link' }),
  click('Resolved', 'A resolved one.'),
  nav(`${D}?status=approved`),
  click('View disclosure', 'Opening a record.'),
  nav(`${D}?status=approved`, 'The audit trail is on the right.'),
  click('More actions', 'Export lives here.', { inDialog: true }),
  click(PANEL, 'Every event is captured.', PAGE),
  nav(`${D}?status=approved`, 'Closing line.'),
];
const SAVED_LINES = SAVED.map((s) => s.narration).filter(Boolean);
// What the recorder returns for a faithful take: the opening slide, one slide before each action, page changes
// noted the instant the address changes, and (kept apart) a slide of the finished state.
const TAKE = () => [
  shot(nav(`${D}?company_id=1150`, 'AI opening.'), 'f0.png'),
  shot(click('Disclosures', 'AI a.', { role: 'link' }), 'f1.png'),
  shot(click('Resolved', 'AI b.'), 'f2.png'),
  shot(nav(`${D}?company_id=1150&status=approved`, 'AI nav.'), 'f3.png'),
  shot(click('View disclosure', 'AI c.'), 'f4.png'),
  shot(click('More actions', 'AI d.'), 'f5.png'),
];
const END = { action: 'view', target: null, endFrame: true, media: { pre: 'end.png' }, url: `${APP}${D}?company_id=1150`, route: D };

test('the plan repeats the saved actions in order and leaves out page changes and container clicks', () => {
  assert.equal(PANEL.length, 80);
  const plan = reshootPlan({ steps: SAVED });
  assert.deepEqual(plan.steps.map((s) => s.from), [2, 3, 5, 7]);
  assert.equal(plan.steps[0].instruction, 'Click the link "Disclosures". (Narration over this step, for context only: "The queue.")');
  assert.match(plan.steps[3].instruction, /^Click the button "More actions" in the open dialog\./);
  assert.equal(plan.exists, true);
  assert.match(plan.summary, /RE-SHOOT/);
  assert.match(plan.notes, /Perform ONLY the numbered steps/);
  assert.ok(plan.steps.every((s) => s.label === ''), 'the label is inside the instruction, not repeated after it');
});

test('typing, key presses, uploads and hovers become plan steps; a click on the page itself and an unnamed hover do not', () => {
  const plan = reshootPlan({ steps: [type('Template name', 'Annual  Attestation'), { action: 'press', key: 'Escape' }, { action: 'upload', value: 'pdf', target: { name: 'Choose document' } },
    { action: 'hover', target: null }, { action: 'hover', target: { name: 'Why disabled' } }, click(PANEL, 'x', PAGE), { action: 'custom', value: null }, type('', '')] });
  assert.deepEqual(plan.steps.map((s) => s.instruction), [
    'Type "Annual Attestation" into the field "Template name".', 'Press Escape.', 'Attach a sample pdf file with "Choose document".',
    'Hover over "Why disabled" to show its tooltip.', 'Type a suitable value into the field in focus.']);
  assert.deepEqual(plan.steps.map((s) => s.act), ['type', 'press', 'upload', 'hover', 'type']);
  assert.deepEqual(reshootPlan({ steps: [] }).steps, []);
  assert.deepEqual(reshootPlan(null).steps, []);
});

test('what a control is called: its own text, a card by its title, a field by its label, and nothing for a bare icon', () => {
  assert.equal(labelOf({ name: 'Add branch', label: 'Branches toolbar' }), 'Add branch');
  const card = { tag: 'span', name: 'Sync an existing branchPull official Form BR data straight from FINRA for a branch that exists', label: 'Sync an existing branch' };
  assert.equal(labelOf(card), 'Sync an existing branch');
  assert.equal(labelOf({ tag: 'button', role: 'button', label: 'October 2026All statuses' }), '', 'text near an icon button does not name it');
  assert.equal(labelOf({ tag: 'input', label: 'Branch name', placeholder: 'Enter branch name' }, 'type'), 'Branch name');
  assert.equal(labelOf({ tag: 'input', placeholder: 'Add a ticker' }, 'type'), 'Add a ticker');
});

test('controls with no label of their own, rows, cards and dates are described so a person could find them', () => {
  const row = 'Boston Branch - Three-Year Cycle Inspection Boston Branch Scheduled Nov 3, 2026 Logan Roy 0 findings';
  const plan = reshootPlan({ steps: [
    click('', 'Selecting everything sets us up.', { role: 'checkbox', tag: 'button', css: 'div > table > thead > tr > th:nth-of-type(1) > button', hint: { bbox: { x: 302, y: 268, w: 24, h: 24 }, viewport: { w: 1600, h: 900 } } }),
    click('', '', { tag: 'div', role: '' }),
    click(row, 'Opening the exam.', { tag: 'tr', role: 'row' }),
    click('Day trading Flags a buy and sell of the same security on the same day by the same person in an account', 'Day trading rules.', { tag: 'div', role: '' }),
    click('Sync an existing branchPull official Form BR data straight from FINRA for a branch that exists', 'Syncing.', { tag: 'span', role: '', label: 'Sync an existing branch', inDialog: true }),
    click('Oct 2, 2026', 'Open the picker.', { datePicker: true }),
    click('Thursday, October 22nd, 2026', 'A few weeks out.', { date: { day: 22 }, inDialog: true }),
  ] });
  const [icon, silent, exam, plainCard, titled, field, day] = plan.steps;
  assert.match(icon.instruction, /^Click the unlabeled checkbox the lesson uses at this point \(icon-sized, in a table's header row, at the upper left of the page when recorded\)\./);
  assert.ok(!icon.optional, 'the lesson talks over it, so it has to be repeated');
  assert.equal(silent.optional, true);
  assert.match(silent.instruction, /This step is optional/);
  assert.match(exam.instruction, /^Click the row whose text begins "Boston Branch - Three-Year Cycle Inspection Boston Branch Sc" \(the closest match/);
  assert.ok(!exam.optional);
  assert.equal(plainCard.optional, true, 'a plain block may have been a panel, not a control');
  assert.match(titled.instruction, /^Click the control "Sync an existing branch" in the open dialog\./);
  assert.match(field.instruction, /^Open the date field "Oct 2, 2026"/);
  // The lesson moved the date from Oct 2 to Oct 22: the re-shoot, made on Nov 16, moves it as far, to Dec 6.
  const on = { today: new Date(2026, 10, 16, 9, 30) };
  const steps = [click('Oct 2, 2026', 'Open the picker.', { datePicker: true }), click('Thursday, October 22nd, 2026', 'A few weeks out.', { date: { day: 22 }, inDialog: true })];
  assert.equal(reshootPlan({ steps }, on).steps[1].instruction.replace(/ \(Narration.*$/, ''),
    'Pick Sunday, December 6, 2026 in the open date picker (20 days after today: the lesson\'s date, "Thursday, October 22nd, 2026", was that far from where it started). Page the picker to another month when that day is not in the month it opens on.');
  // With no date field before it, the distance is measured from the day the lesson was recorded; a date behind it stays behind.
  const dated = (recordedAt, target) => reshootPlan({ recording: { recordedAt }, steps: [click(target.name, '', target)] }, on).steps[0].instruction;
  assert.match(dated('2026-10-14T19:22:27.086Z', { name: 'Thursday, October 22nd, 2026', date: { day: 22 } }), /^Pick Tuesday, November 24, 2026 in the open date picker \(8 days after today:/);
  assert.match(dated('2026-10-14T19:22:27.086Z', { name: 'Thursday, October 1st, 2026', date: { day: 1 } }), /^Pick Tuesday, November 3, 2026 in the open date picker \(13 days before today:/);
  assert.match(dated('2026-10-14T19:22:27.086Z', { name: 'Wednesday, October 14th, 2026', date: { day: 14 } }), /^Pick Monday, November 16, 2026 in the open date picker \(today:/);
  // A second picker is measured from its own field, and a date with nothing to read keeps its day of the month.
  const two = reshootPlan({ steps: [...steps, click('Thursday, October 29th, 2026', '', { date: { day: 29 } })] }, on).steps[2].instruction;
  assert.match(two, /^Pick day 29 in the open date picker \(the lesson picked "Thursday, October 29th, 2026"\), in the month the picker opens on\./);
  assert.match(dated('', { name: '22', date: {} }), /^Pick day 22 in the open date picker \(the lesson picked "22"\), in the month the picker opens on\./);
  assert.match(dated('', { name: 'Pick', date: {} }), /^Pick a day in the open date picker \(the lesson picked "Pick"\): one in the month the picker opens on\./);
  // Optional steps are not counted as left out when a take does not repeat them.
  const saved = [nav('/a', 'Welcome.'), click('', '', { tag: 'div', role: '' }, '/a'), click('Go', 'Press go.', {}, '/a')];
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), shot(click('Go', 'y', {}, '/a'), 'f1.png')];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual([m.missed, m.planned], [[], 1]);
  assert.equal(reshootExact(m), true);
});

test('pairing keys: a page change pairs by path whatever its query; a container click and an unnamed click never pair', () => {
  assert.equal(reshootStepKey(nav(D)), reshootStepKey(nav(`${D}?company_id=1150&status=x`)));
  assert.equal(reshootStepKey(nav(`${D}/`)), reshootStepKey(nav(D)));
  assert.notEqual(reshootStepKey(nav(D)), reshootStepKey(nav('/people-oversight/certifications')));
  assert.equal(reshootStepKey(click('Resolved')), 'click|resolved');
  assert.ok(reshootStepKey(click(PANEL)).endsWith('|'));
  assert.ok(reshootStepKey(click('')).endsWith('|'));
  assert.ok(reshootStepKey({ action: 'click', value: 'x', target: { name: '' } }).endsWith('|'), 'a click is never keyed by a value');
  assert.equal(reshootStepKey(type('Template name', 'Annual')), 'type|template name');
  assert.equal(labelOf({ name: '  two   words ' }), 'two words');
});

test('a faithful re-shoot reads as the lesson did: every saved line, in order, each on the slide of its moment', () => {
  const fresh = TAKE();
  const m = reshootMerge(SAVED, fresh, pairs(SAVED, fresh), END);
  assert.deepEqual([m.missed, m.lost, m.extra], [[], [], []]);
  assert.equal(m.planned, 4);
  assert.deepEqual(show(m), [
    'navigate:f1.png:Opening line.',                // the opening page, settled (the slide before the first action)
    'click:f1.png:The queue.',
    'click:f2.png:A resolved one.',
    'click:f4.png:Opening a record.',               // the silent page change before it is gone
    'view:f5.png:The audit trail is on the right.', // the page as "View disclosure" left it
    'click:f5.png:Export lives here.',
    'view:end.png:Every event is captured.',        // after the last action: the finished state
    'view:end.png:Closing line.',
  ]);
  assert.equal(m.usedEndFrame, true);
  assert.equal(m.dropped, 1);
  assert.equal(m.kept, 5);
  assert.equal(m.beats, 3);
  assert.deepEqual(m.steps.map((s) => s.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(m.steps.filter((s) => s.action === 'view').every((s) => s.target === null));
  assert.ok(!('captureId' in m.steps[0]), 'a slide pointed at another frame no longer claims its own capture');
  assert.equal(m.steps[1].captureId, 'f1');
  assert.deepEqual(fresh, TAKE(), 'the fresh steps passed in are not modified');
  assert.deepEqual(m.steps.map((s) => s.narration), SAVED_LINES, 'exactly the saved lines, in the saved order, and nothing new');
});

test('a take that ran on past the lesson\'s last action is cut there, and the closing lines show that moment', () => {
  const fresh = [...TAKE(), shot(click('Download submission', 'AI overrun.'), 'f6.png'), shot(nav(`${D}?company_id=1150&status=approved&export=1`, 'AI nav 2.'), 'f7.png')];
  const m = reshootMerge(SAVED, fresh, pairs(SAVED, fresh), END);
  assert.deepEqual(m.steps.map((s) => s.narration), SAVED_LINES);
  assert.deepEqual(show(m).slice(-3), ['click:f5.png:Export lives here.', 'view:f6.png:Every event is captured.', 'view:f6.png:Closing line.']);
  assert.equal(m.usedEndFrame, false, 'the finished-state slide came after the overrun, so it is not used');
  assert.deepEqual(m.extra, []);
  assert.equal(m.dropped, 3);
});

test('a re-shoot that skipped a saved action or added one says so, and a line with no slide is reported, not invented', () => {
  const fresh = [
    shot(nav(`${D}?company_id=1150`, 'AI opening.'), 'f0.png'),
    shot(click('Disclosures', 'AI a.', { role: 'link' }), 'f1.png'),
    shot(click('Filters', 'AI extra.'), 'f2.png'),
    shot(click('View disclosure', 'AI c.'), 'f3.png'),
  ];
  // "Filters" is a link here and "Resolved" was a button: not the same control under a new name.
  fresh[2].target.role = 'link';
  const m = reshootMerge(SAVED, fresh, pairs(SAVED, fresh), null);
  assert.deepEqual(m.missed, [3, 7], 'Resolved and More actions were not repeated');
  assert.deepEqual(m.extra, [2]);
  assert.deepEqual(m.approx, []);
  // "A resolved one." is seated on the page as "Disclosures" left it; the lines after the last action have no slide.
  assert.deepEqual(show(m), ['navigate:f1.png:Opening line.', 'click:f1.png:The queue.', 'view:f2.png:A resolved one.', 'click:f2.png:AI extra.', 'click:f3.png:Opening a record.']);
  assert.deepEqual(m.lost, [6, 7, 8, 9]);
  assert.equal(m.usedEndFrame, false);
});

test('a control whose label changed is still the same step: its saved line goes on the new control, flagged when it is a guess', () => {
  const saved = [nav('/a', 'Welcome.'), click('File actions', 'Open the actions.', {}, '/a'), click('Inherit', 'Access is inherited.', {}, '/a'), click('Read', 'Read access.', {}, '/a'), click('Save', 'Saving applies it.', {}, '/a')];
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), shot(click('File actions', 'y', {}, '/a'), 'f1.png'), shot(click('Custom access', 'AI custom.', {}, '/a'), 'f2.png'),
    shot(click('Read', 'z', {}, '/a'), 'f3.png'), shot(click('Save changes', 'AI save.', {}, '/a'), 'f4.png')];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual(show(m), ['navigate:f1.png:Welcome.', 'click:f1.png:Open the actions.', 'click:f2.png:Access is inherited.', 'click:f3.png:Read access.', 'click:f4.png:Saving applies it.']);
  assert.deepEqual([m.missed, m.extra, m.lost], [[], [], []]);
  assert.deepEqual(m.approx, [[2, 2]], '"Inherit" -> "Custom access" shares no word: a guess, reported with its slide; "Save" -> "Save changes" is not');
  assert.equal(m.steps[4].target.name, 'Save changes', 'the highlight stays on the control that is on screen now');
  // Two leftovers on one side and one on the other: no guess is made.
  const fresh2 = [fresh[0], fresh[1], fresh[2], shot(click('Another', 'AI other.', {}, '/a'), 'f2b.png'), fresh[3], fresh[4]];
  const m2 = reshootMerge(saved, fresh2, pairs(saved, fresh2), null);
  assert.deepEqual(m2.approx, []);
  assert.deepEqual(m2.missed, [2]);
  assert.deepEqual(m2.extra, [2, 3]);
  // Labels sharing two words and half of the longer one pair, as a guess.
  const saved3 = [nav('/a', 'Welcome.'), click('Add custom task', 'Add it.', {}, '/a')];
  const fresh3 = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), shot(click('Close', 'AI close.', { role: 'link' }, '/a'), 'f1.png'), shot(click('Add a custom task', 'AI add.', {}, '/a'), 'f2.png')];
  const m3 = reshootMerge(saved3, fresh3, pairs(saved3, fresh3), null);
  assert.deepEqual(show(m3), ['navigate:f1.png:Welcome.', 'click:f1.png:AI close.', 'click:f2.png:Add it.']);
  assert.deepEqual(m3.approx, [[1, 2]]);
});

test('a step the lesson passed over in silence stays silent, and keeps no caption it did not have', () => {
  const saved = [nav('/a', 'Welcome.'), click('Select a module', '', {}, '/a'), { ...click('Certification', 'Pick the module.', {}, '/a'), caption: 'Pick it' }];
  const fresh = [shot(nav('/a?company_id=1150', 'AI opening.'), 'f0.png'), { ...shot(click('Select a module', 'AI wrote this.', {}, '/a'), 'f1.png'), caption: 'AI caption' }, shot(click('Certification', 'AI wrote that.', {}, '/a'), 'f2.png')];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual(show(m), ['navigate:f1.png:Welcome.', 'click:f1.png:', 'click:f2.png:Pick the module.']);
  assert.ok(!('caption' in m.steps[1]));
  assert.equal(m.steps[2].caption, 'Pick it');
});

test('opening lines: an unpaired opening takes the opening slide; lines before a paired first step go in front of it', () => {
  const saved = [nav('/a', 'Welcome.'), click(PANEL, 'Look around.'), click('Go', 'Press go.')];
  const fresh = [shot(nav('/b?company_id=1150', 'AI opening.'), 'f0.png'), shot(click('Go', 'AI go.', {}, '/b'), 'f1.png')];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual(show(m), ['navigate:f1.png:Welcome.', 'view:f1.png:Look around.', 'click:f1.png:Press go.']);
  const fresh2 = [shot(click('Go', 'AI go.', {}, '/b'), 'g0.png')];
  const m2 = reshootMerge(saved, fresh2, pairs(saved, fresh2), null);
  assert.deepEqual(show(m2), ['view:g0.png:Welcome.', 'view:g0.png:Look around.', 'click:g0.png:Press go.']);
});

test('a page change keeps its own slide when the next slide is another page, and uses the finished-state slide when it is last', () => {
  const saved = [nav('/a', 'First page.'), click('Next', 'Go on.', {}, '/a'), nav('/b', 'Second page.')];
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), shot(click('Next', 'y', {}, '/a'), 'f1.png'), shot(nav('/b?company_id=1150', 'z'), 'f2.png')];
  const end = { action: 'view', target: null, endFrame: true, media: { pre: 'end.png' }, url: `${APP}/b?company_id=1150` };
  assert.deepEqual(show(reshootMerge(saved, fresh, pairs(saved, fresh), end)), ['navigate:f1.png:First page.', 'click:f1.png:Go on.', 'navigate:end.png:Second page.']);
  assert.deepEqual(show(reshootMerge(saved, fresh, pairs(saved, fresh), null)), ['navigate:f1.png:First page.', 'click:f1.png:Go on.', 'navigate:f2.png:Second page.']);
  const elsewhere = { ...end, url: `${APP}/c` };
  assert.deepEqual(show(reshootMerge(saved, fresh, pairs(saved, fresh), elsewhere)).at(-1), 'navigate:f2.png:Second page.');
});

// ---- following the plan turn by turn ----
const LESSON = [nav('/a', 'Welcome.'), click('Disclosures', 'The queue.', { role: 'link' }, '/a'), click('Next', 'On we go.', {}, '/a'), type('Rule name', 'Ad Hoc', 'Name it.'), click('Next', 'And again.', {}, '/a'), click('Publish', 'Publishing.', {}, '/a')];

test('the recorder may not finish, or jump ahead, while a numbered step is still to do; asked twice, it is let through', () => {
  const plan = reshootPlan({ steps: LESSON });
  assert.deepEqual(plan.steps.map((s) => [s.from, s.act, s.control]), [[1, 'click', 'disclosures'], [2, 'click', 'next'], [3, 'type', 'rule name'], [4, 'click', 'next'], [5, 'click', 'publish']]);
  const p = reshootProgress();
  assert.match(reshootNote(plan, p), /performed so far: none \(of 5\)\. Next: step 1\./);
  // Skipping the "redundant" first click is refused once, naming the step.
  const skip = reshootGate(plan, p, { action: 'click', step: 2, name: 'Next' });
  assert.match(skip.refuse, /^refused — step 1 comes before step 2 and has not been performed \(Click the link "Disclosures"/);
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 1, name: 'Disclosures' }), { ok: true, step: 1, from: 1 });
  p.done.add(1);
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 2, name: 'Next' }), { ok: true, step: 2, from: 2 });
  p.done.add(2);
  // A click that puts the cursor in the field is not the typing step; an action with no step is a helper.
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 3, name: 'Rule name' }), { ok: true, step: 0 });
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Close banner' }), { ok: true, step: 0 });
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 0, name: 'Close banner' }), { ok: true, step: 0 });
  // No step given, but it acts on the next step's own control: counted as that step.
  assert.deepEqual(reshootGate(plan, p, { action: 'type', name: 'Rule name', text: 'Ad Hoc' }), { ok: true, step: 3, from: 3 });
  p.done.add(3);
  assert.match(reshootNote(plan, p), /performed so far: 1, 2, 3 \(of 5\)\. Next: step 4\./);
  // "done" with steps left is refused once, then accepted.
  assert.match(reshootGate(plan, p, { action: 'done' }).refuse, /numbered step\(s\) 4, 5 are not marked as performed/);
  assert.deepEqual(reshootGate(plan, p, { action: 'done' }), { ok: true, step: 0 });
  // Jumping over step 4: refused once, then let through, and the note says what was left out.
  assert.match(reshootGate(plan, p, { action: 'click', step: 5, name: 'Publish' }).refuse, /step 4 comes before step 5/);
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 5, name: 'Publish' }), { ok: true, step: 5, from: 5 });
  p.done.add(5);
  assert.match(reshootNote(plan, p), /Every numbered step is performed: reply "done"\. Left out so far: 4\./);
  // An optional step never holds the take up.
  const plan2 = reshootPlan({ steps: [nav('/a'), click('', '', { tag: 'div', role: '' }, '/a'), click('Go', 'Go.', {}, '/a')] });
  const p2 = reshootProgress();
  assert.deepEqual(reshootGate(plan2, p2, { action: 'click', step: 2, name: 'Go' }), { ok: true, step: 2, from: 2 });
  p2.done.add(2);
  assert.deepEqual(reshootGate(plan2, p2, { action: 'done' }), { ok: true, step: 0 });
});

test('what the recorder said each action was decides the pairing: two controls with one label, a renamed one, a helper', () => {
  // The take needed a helper click before the first "Next", and "Publish" reads "Publish rule" today.
  const mark = (s, of) => ({ ...s, reshootOf: of });
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot(click('Disclosures', 'a', { role: 'link' }, '/a'), 'f1.png'), 1), mark(shot(click('People oversight', 'AI helper.', {}, '/a'), 'f2.png'), -1),
    mark(shot(click('Next', 'b', {}, '/a'), 'f3.png'), 2), mark(shot({ ...type('Rule name', 'Ad Hoc'), url: APP + '/a' }, 'f4.png'), 3), mark(shot(click('Next', 'c', {}, '/a'), 'f5.png'), 4), mark(shot(click('Publish rule', 'd', {}, '/a'), 'f6.png'), 5)];
  const { pairs: got, approx, declared } = reshootPairs(LESSON, fresh, pairs(LESSON, fresh));
  assert.deepEqual(got, [[0, 0], [1, 1], [2, 3], [3, 4], [4, 5], [5, 6]]);
  assert.deepEqual([approx, declared], [[], 5]);
  const m = reshootMerge(LESSON, fresh, pairs(LESSON, fresh), null);
  assert.deepEqual(show(m), ['navigate:f1.png:Welcome.', 'click:f1.png:The queue.', 'click:f2.png:AI helper.', 'click:f3.png:On we go.', 'type:f4.png:Name it.', 'click:f5.png:And again.', 'click:f6.png:Publishing.']);
  assert.deepEqual([m.missed, m.extra, m.declared], [[], [2], 5]);
  assert.ok(m.steps.every((s) => !('reshootOf' in s)), 'the marks stay out of the saved lesson');
  assert.equal(reshootExact(m), false, 'an added action is for a person to look at');
  // A helper the recorder named as one is never taken for a step that was left out.
  const fresh2 = [fresh[0], fresh[1], mark(shot(click('Something else', 'AI.', {}, '/a'), 'g2.png'), -1), fresh[4], fresh[5], fresh[6]];
  const m2 = reshootMerge(LESSON, fresh2, pairs(LESSON, fresh2), null);
  assert.deepEqual([m2.missed, m2.extra, m2.approx], [[2], [2], []]);
  // A wrong declaration (a click called the typing step) is ignored; one that breaks the lesson's order loses to the rest.
  const fresh3 = [fresh[0], mark(fresh[1], 3), mark(fresh[3], 2), mark(fresh[4], 3), mark(fresh[5], 1), mark(fresh[6], 5)];
  assert.deepEqual(reshootPairs(LESSON, fresh3, pairs(LESSON, fresh3)).pairs, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  // The step done twice (a wrong control first, then the right one): the later one is the step.
  const fresh4 = [fresh[0], fresh[1], mark(shot(click('Nxt', 'AI wrong.', {}, '/a'), 'h2.png'), 2), fresh[3], fresh[4], fresh[5], fresh[6]];
  const m4 = reshootMerge(LESSON, fresh4, pairs(LESSON, fresh4), null);
  assert.equal(m4.steps[3].narration, 'On we go.');
  assert.deepEqual(m4.extra, [2]);
});

test('a line that says a label or a value the new slide no longer shows is reported as stale', () => {
  const saved = [nav('/a', 'Welcome.'), click('Dashboard', 'The Dashboard is the employee home.', { role: 'link' }, '/a'), click('Settings', 'Back to the gear.', { role: 'link' }, '/a'),
    type('Title', 'Ad Hoc Trade Review', 'We name it Ad Hoc Trade Review.'), type('Notes', 'First pass', 'A short note.'), click('Save', 'Click Save to finish.', {}, '/a')];
  const mark = (s, of) => ({ ...s, reshootOf: of });
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot(click('Overview', 'a', { role: 'link' }, '/a'), 'f1.png'), 1), mark(shot(click('Preferences', 'b', { role: 'link' }, '/a'), 'f2.png'), 2),
    mark(shot({ ...type('Title', 'Quarterly Check'), url: APP + '/a' }, 'f3.png'), 3), mark(shot({ ...type('Notes', 'First pass 2'), url: APP + '/a' }, 'f4.png'), 4), mark(shot(click('Save changes', 'c', {}, '/a'), 'f5.png'), 5)];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual([m.missed, m.extra, m.lost, m.approx], [[], [], [], []]);
  assert.deepEqual(m.relabeled, [{ saved: 1, slide: 1, was: 'Dashboard', now: 'Overview', spoken: true }, { saved: 2, slide: 2, was: 'Settings', now: 'Preferences', spoken: false }]);
  assert.deepEqual(m.retyped, [{ saved: 3, slide: 3, was: 'Ad Hoc Trade Review', now: 'Quarterly Check', spoken: true, changed: true }, { saved: 4, slide: 4, was: 'First pass', now: 'First pass 2', spoken: false, changed: false }]);
  assert.deepEqual(m.stale, [1, 3], '"Save" -> "Save changes" still reads right, and so does a value with a suffix');
  // Another value is another text on screen even when no line says it; the whole value is asked for, however long.
  const long = 'This control ensures third-party vendors and service providers undergo appropriate due diligence before onboarding, and that the review is repeated every year.';
  const sv2 = [nav('/a', 'Welcome.'), type('Description', long, 'Describe it.')];
  const fr2 = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot({ ...type('Description', long.slice(0, 120)), url: APP + '/a' }, 'f1.png'), 1)];
  assert.deepEqual(reshootMerge(sv2, fr2, pairs(sv2, fr2), null).stale, [1]);
  assert.ok(reshootPlan({ steps: sv2 }).steps[0].instruction.includes(`Type "${long}" into the field "Description".`));
  assert.equal(reshootExact(m), false);
  assert.equal(reshootExact({ ...m, stale: [] }), true);
  // A label is also spoken when a telling word of it turns up in another form; a word the new label keeps, or a short or everyday one, is not telling.
  const one = (was, now, line) => { const sv = [nav('/a', 'Welcome.'), click(was, line, {}, '/a')]; const fr = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot(click(now, 'a', {}, '/a'), 'f1.png'), 1)]; return reshootMerge(sv, fr, pairs(sv, fr), null).relabeled.map((r) => r.spoken); };
  assert.deepEqual(one('Inherit', 'Only people added', 'By default, access is inherited from the folder.'), [true]);
  assert.deepEqual(one('Logan Roy', 'Atticus Finch', 'We\'ll make a team member responsible for completing it.'), [false]);
  assert.deepEqual(one('Archive policy', 'Retire policy', 'This policy is no longer needed.'), [false], '"policy" is still in the label');
  assert.deepEqual(one('Archive policy', 'Retire policy', 'Archiving keeps the record.'), [true]);
  assert.deepEqual(one('Read', 'View only', 'Readers can open it.'), [false], 'a four-letter word is too short to go on');
  assert.deepEqual(one('Other', 'Something else', 'Any other location goes here.'), [true], 'the label itself, said outright, always counts');
  assert.deepEqual(one('Every other week', 'Fortnightly', 'Every team has its own.'), [false]);
  assert.deepEqual(one('This was flagged because "no" was selected.', 'During the prior quarter, did you trade?', 'The flagged answer is selected here.'), [false], 'a sentence is not combed for words');
  // Not a different label at all: the same words run together or punctuated another way, and a field known by its placeholder then and by its label now.
  assert.deepEqual(one('Boston Branch CRD# 412048 Non-supervisory Branch Every 3 years', 'Boston BranchCRD# 412048Non-supervisory BranchEvery 3 years', 'Pick the Boston branch.'), []);
  assert.deepEqual(one('e.g. Front Running — Equity Desk', 'e.g. Front Running: Equity Desk', 'Name the rule.'), []);
  const sv = [nav('/a', 'Welcome.'), { action: 'type', value: '180 Maiden Lane', target: { name: '180 Maiden Lane', tag: 'input', placeholder: '180 Maiden Lane', label: 'Address line 1' }, narration: 'The address.', url: APP + '/a' }];
  const fr = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot({ action: 'type', value: '180 Maiden Lane', target: { name: 'Address line 1', tag: 'input', placeholder: '180 Maiden Lane' }, narration: 'a', url: APP + '/a' }, 'f1.png'), 1)];
  assert.deepEqual(reshootMerge(sv, fr, pairs(sv, fr), null).relabeled, []);
});

test('the step an action performs is read from its "step" field, else from a reason that opens with it, else from the control', () => {
  const plan = reshootPlan({ steps: LESSON });
  const p = reshootProgress();
  // The recorder's model writes "Step 1: ..." far more reliably than it fills the field in.
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Queue', reason: 'Step 1: click the Disclosures link, now called Queue' }), { ok: true, step: 1, from: 1 });
  p.done.add(1);
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Continue', reason: 'step 2 - Next is labelled Continue today' }), { ok: true, step: 2, from: 2 });
  p.done.add(2);
  // The field wins over the reason; 0 is a helper whatever the reason says; a step number in mid-sentence is not a declaration.
  assert.deepEqual(reshootGate(plan, p, { action: 'click', step: 0, name: 'Close', reason: 'Step 3: close the banner first' }), { ok: true, step: 0 });
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Close', reason: 'Close the banner so step 3 can be done' }), { ok: true, step: 0 });
  assert.deepEqual(reshootGate(plan, p, { action: 'type', step: '3', name: 'Name', reason: 'x' }), { ok: true, step: 3, from: 3 });
  p.done.add(3);
  // No number anywhere: one of the next three steps when it is that step's own control (here step 5, with 4 still to do: refused once).
  assert.match(reshootGate(plan, p, { action: 'click', name: 'Publish', reason: 'publish it' }).refuse, /step 4 comes before step 5/);
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Next', reason: 'on we go' }), { ok: true, step: 4, from: 4 });
  // A number past the end of the plan is nothing to go on.
  assert.deepEqual(reshootGate(plan, p, { action: 'click', name: 'Whatever', reason: 'Step 12: tidy up' }), { ok: true, step: 0 });
});

test('a silent second click on the control just clicked is optional, and paging a date picker is not an added action', () => {
  const saved = [nav('/a', 'Welcome.'), click('Ad Hoc Trade Review', 'Open it.', {}, '/a'), click('Ad Hoc Trade Review', '', {}, '/a'), click('Next', 'On.', {}, '/a'), click('Next', 'And on.', {}, '/a'),
    click('Thursday, October 22nd, 2026', 'A few weeks out.', { date: { day: 22 } }, '/a'), click('Save', 'Done.', {}, '/a')];
  const plan = reshootPlan({ steps: saved });
  assert.deepEqual(plan.steps.map((s) => !!s.optional), [false, true, false, false, false, false]);
  assert.match(plan.steps[1].instruction, /This step is optional: it repeats the click before it/);
  const mark = (s, of) => ({ ...s, reshootOf: of });
  const fresh = [shot(nav('/a?company_id=1150', 'x'), 'f0.png'), mark(shot(click('Ad Hoc Trade Review - Pending', 'a', {}, '/a'), 'f1.png'), 1), mark(shot(click('Next', 'b', {}, '/a'), 'f2.png'), 3), mark(shot(click('Next', 'c', {}, '/a'), 'f3.png'), 4),
    mark({ ...shot(click('Go to the Next Month', 'AI paging.', { inDialog: true }, '/a'), 'f4.png'), caption: 'AI caption' }, 5), mark(shot(click('Tuesday, December 22nd, 2026', 'd', { date: { day: 22 } }, '/a'), 'f5.png'), 5), mark(shot(click('Save', 'e', {}, '/a'), 'f6.png'), 6)];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual([m.missed, m.extra, m.helpers, m.stale], [[], [], 1, []]);
  assert.deepEqual(show(m), ['navigate:f1.png:Welcome.', 'click:f1.png:Open it.', 'click:f2.png:On.', 'click:f3.png:And on.', 'click:f4.png:', 'click:f5.png:A few weeks out.', 'click:f6.png:Done.']);
  assert.ok(!('caption' in m.steps[4]), 'the month change shows with nothing said or captioned over it');
  assert.deepEqual(m.relabeled, [], 'a date is expected to differ, and "Ad Hoc Trade Review - Pending" still contains its old label');
  assert.equal(reshootExact(m), true);
});

test('opening a sidebar group to reach the item the lesson clicks is part of that click, not an added action', () => {
  const at = (x, y, w = 239) => ({ bbox: { x, y, w, h: 32 }, viewport: { w: 1600, h: 900 } });
  const saved = [click('Calendar', 'Let\'s head to the calendar.', { role: 'link' }, '/overview'), nav('/testing-program/calendar', 'It shows every test.'), click('New Task', 'Add one.', {}, '/testing-program/calendar')];
  const mark = (s, of) => ({ ...s, reshootOf: of });
  const group = mark({ ...shot(click('Testing program', 'AI group.', { role: 'link', ...at(17, 101) }, '/overview'), 'f1.png'), caption: 'AI caption' }, -1);
  const fresh = [shot(nav('/overview?company_id=1150', 'x'), 'f0.png'), group, mark(shot(click('Calendar', 'a', { role: 'link', ...at(42, 392, 190) }, '/overview'), 'f2.png'), 0),
    shot(nav('/testing-program/calendar?company_id=1150', 'y'), 'f3.png'), mark(shot(click('New Task', 'b', at(1400, 140, 90), '/testing-program/calendar'), 'f4.png'), 2)];
  const m = reshootMerge(saved, fresh, pairs(saved, fresh), null);
  assert.deepEqual(show(m), ['click:f1.png:Let\'s head to the calendar.', 'click:f2.png:', 'navigate:f4.png:It shows every test.', 'click:f4.png:Add one.']);
  assert.ok(!('caption' in m.steps[0]) && !('caption' in m.steps[1]));
  assert.deepEqual([m.missed, m.extra, m.helpers, m.lost], [[], [], 1, []]);
  assert.equal(reshootExact(m), true);
  // The same click anywhere else on the page, or one not followed by the lesson's own sidebar click, is an added action.
  const elsewhere = fresh.map((s) => (s === group ? mark({ ...shot(click('Testing program', 'AI group.', { role: 'link', ...at(600, 101) }, '/overview'), 'f1.png') }, -1) : s));
  assert.deepEqual(reshootMerge(saved, elsewhere, pairs(saved, elsewhere), null).extra, [1]);
  const notBefore = [fresh[0], fresh[2], mark({ ...shot(click('Marketing', 'AI group.', { role: 'link', ...at(17, 300) }, '/overview'), 'g.png') }, -1), fresh[3], fresh[4]];
  assert.deepEqual(reshootMerge(saved, notBefore, pairs(saved, notBefore), null).extra, [2]);
});

test('the company switcher is never a step to repeat, and the plan says to stay in today\'s company', () => {
  const sandbox = 'https://app.hadrius.com/people-oversight/certifications?company_id=1048';
  const steps = [{ action: 'navigate', value: sandbox, url: sandbox, narration: 'Welcome.' },
    click('Hadrius Sandbox 1048 Hadrius Sandbox 1048', '', { role: 'combobox', tag: 'button' }), click('Hadrius Sandbox 1048', '', { role: 'button' }),
    click('Hadrius Sandbox LLC Hadrius Sandbox LLC', 'Pick the entity.', { role: 'combobox' }), click('Open 1048 items', '', { role: 'link', tag: 'a' }), click('Certifications', 'The queue.', { role: 'link' })];
  const plan = reshootPlan({ environment: { startUrl: sandbox }, steps });
  assert.deepEqual(plan.steps.map((s) => s.from), [3, 4, 5], 'the two clicks on the switcher are left out; an entity named after the company and a link with the number in it are not the switcher');
  assert.match(plan.notes, /never open the company switcher at the top of the sidebar and never choose another company/);
  // With no company in the lesson's addresses there is nothing to tell the switcher by: the recorder's own guard refuses it at the click.
  assert.deepEqual(reshootPlan({ steps: steps.slice(1) }).steps.map((s) => s.from), [0, 1, 2, 3, 4]);
});
