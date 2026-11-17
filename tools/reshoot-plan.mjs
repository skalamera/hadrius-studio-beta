// Re-shoot plan: turn a saved recording's own steps into the path the AI recorder follows, so a lesson can be
// captured again on today's interface with the same steps in the same order, and put its narration back on the
// new slides. Pure functions, no I/O: the bridge's AI re-record (POST /drift/repair {reshoot:true}) and the
// recorder's turn loop use them.

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const said = (s) => clean(s?.narration);

const KIND = { button: 'button', a: 'link', link: 'link', tab: 'tab', menuitem: 'menu item', option: 'option', checkbox: 'checkbox',
  radio: 'option', switch: 'switch', row: 'row', combobox: 'dropdown', textbox: 'field', input: 'field', textarea: 'field', select: 'dropdown' };
// The recorder cuts names at 80 characters, so a name that long is everything written in a card, a row or a
// panel, not a control's label.
const MAX_LABEL = 79;
// Words too ordinary to say anything about a label when they turn up in a narration line.
const EVERYDAY = new Set(['about', 'after', 'again', 'before', 'between', 'every', 'other', 'their', 'there', 'these', 'those', 'under', 'using', 'where', 'which', 'while']);
// A date picker's buttons for going to another month.
const MONTH_PAGING = /^(go to )?(the )?(previous|next) month$/i;
// Whether a recorded control sat in the app's left sidebar (the recorder keeps where it was on the page).
const inSidebar = (step) => {
  const b = step?.target?.bbox || step?.target?.hint?.bbox, v = step?.target?.viewport || step?.target?.hint?.viewport;
  return !!b && !!v && v.w >= 900 && b.w > 0 && b.x >= 0 && b.x + b.w <= 300;
};
const named = (label) => !!label && label.length <= MAX_LABEL;
const squash = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
const kindOf = (step) => KIND[clean(step?.target?.role).toLowerCase()] || KIND[clean(step?.target?.tag).toLowerCase()] || 'control';
const pagePath = (step) => { try { return new URL(String((step?.action === 'navigate' && step.value) || step?.url || ''), 'https://app.hadrius.com').pathname.replace(/\/$/, ''); } catch { return ''; } };

/**
 * What a recorded control is called.
 *  - Its own text, when it has some.
 *  - A card or a row's "name" is everything written in it: its title names it, when the recorder kept one.
 *  - A field with no text of its own is known by its label or placeholder.
 *  - A click on a control with no text has no name: the recorder's `label` there is whatever text sat near
 *    it (a toolbar's, a whole form's), which names nothing.
 */
export function labelOf(target, action = 'click') {
  const own = clean(target?.name || target?.text);
  const near = clean(target?.label);
  if (named(own)) return own;
  if (own) return named(near) && own.toLowerCase().startsWith(near.toLowerCase()) ? near : own;
  return action === 'click' || action === 'hover' ? '' : clean(near || target?.placeholder);
}

// Where an unlabeled control was, in words a person would use.
function whereabouts(target) {
  const css = clean(target?.css);
  const bits = [];
  const b = target?.hint?.bbox, v = target?.hint?.viewport;
  if (b && Math.max(b.w, b.h) <= 40) bits.push('icon-sized');
  if (/(^|[ >])(thead|th)\b/.test(css)) bits.push("in a table's header row");
  else if (/(^|[ >])(tbody|tr|td)\b/.test(css)) bits.push('in a table row');
  if (target?.inDialog) bits.push('in the open dialog');
  if (b && v?.w && v?.h) {
    const x = (b.x + b.w / 2) / v.w, y = (b.y + b.h / 2) / v.h;
    bits.push(`at the ${y < 0.34 ? 'upper' : y < 0.67 ? 'middle' : 'lower'} ${x < 0.34 ? 'left' : x < 0.67 ? 'centre' : 'right'} of the page when recorded`);
  }
  const near = clean(target?.cardText || target?.heading);
  if (near && near.length <= 60) bits.push(`near "${near}"`);
  return bits.join(', ');
}

// A calendar day as a count of days in local time, so two of them differ by a whole number of days.
const dayNumber = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };
const readDate = (text) => Date.parse(clean(text).replace(/(\d+)(st|nd|rd|th)\b/i, '$1'));

// A day in a date picker. The lesson's own date is long gone by the time it is re-shot. What the lesson shows
// is how far that date is from where it started (the date the field held, else the day the lesson was
// recorded), so the step is the day that far from today, named outright. With no date to read, it is the same
// day of the month. `when`: {shown: the date the field held (ms), recordedAt, today}.
function dayPick(target, label, when) {
  const picked = readDate(label);
  const from = Number.isFinite(when.shown) ? when.shown : Date.parse(when.recordedAt || '');
  if (Number.isFinite(picked) && Number.isFinite(from)) {
    const gap = dayNumber(picked) - dayNumber(from);
    const day = new Date(when.today); day.setHours(12, 0, 0, 0); day.setDate(day.getDate() + gap);
    const name = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const far = gap > 0 ? `${gap} day${gap === 1 ? '' : 's'} after today` : gap < 0 ? `${-gap} day${gap === -1 ? '' : 's'} before today` : 'today';
    return `Pick ${name} in the open date picker (${far}: the lesson's date, "${label}", was that far from where it started). Page the picker to another month when that day is not in the month it opens on.`;
  }
  const cell = [clean(target?.text), label].find((v) => /^\d{1,2}$/.test(v)); // a day cell reads just "22"
  const day = Number.isInteger(target?.date?.day) ? target.date.day : cell ? Number(cell) : null;
  const lesson = label ? ` (the lesson picked "${label}")` : '';
  return day ? `Pick day ${day} in the open date picker${lesson}, in the month the picker opens on.` : `Pick a day in the open date picker${lesson}: one in the month the picker opens on.`;
}

// One saved step as an instruction: {text, control, optional?}, or null when it is not something to repeat.
function describe(s, when) {
  const t = s.target || {};
  const label = labelOf(t, s.action);
  const dlg = t.inDialog ? ' in the open dialog' : '';
  if (s.action === 'click') {
    // The company switcher (its button reads "<company name> <company number>"): the lesson's recorder picked
    // its company there. A re-shoot stays in the company it starts in, so this is never a step to repeat.
    if (when.companyId && ['combobox', 'button'].includes(clean(t.role || t.tag).toLowerCase()) && new RegExp(`(^|\\s)${when.companyId}(\\s|$)`).test(label)) return null;
    if (t.date) return { text: dayPick(t, label, when), control: label };
    if (t.datePicker) return { text: `Open the date field "${label}"${dlg} (if it showed a date when the lesson was recorded, it shows a different one today).`, control: label };
    if (named(label)) return { text: `Click the ${kindOf(s)} "${label}"${dlg}.`, control: label };
    if (label) {
      // A name this long is everything written in a row, a card or a panel. The page itself is never a
      // control; a plain block with no role may be a selectable card or just a panel that was clicked.
      const tag = clean(t.tag).toLowerCase();
      if (['html', 'body', 'main'].includes(tag)) return null;
      const plain = !clean(t.role) && ['div', 'span', 'section', 'p', 'li', ''].includes(tag);
      return { text: `Click the ${kindOf(s) === 'control' ? 'row or card' : kindOf(s)} whose text begins "${label.slice(0, 60)}"${dlg} (the closest match, if its details read differently today).${plain ? ' This step is optional: it may have been a click on a plain panel, so leave it out unless today\'s page has a selectable item like it.' : ''}`, control: label, optional: plain };
    }
    const at = whereabouts(t);
    const optional = !said(s);
    return { text: `Click the unlabeled ${kindOf(s)} the lesson uses at this point${at ? ` (${at})` : ''}. It has no text of its own: work out which control it is from the narration and from what the next step needs.${optional ? ' This step is optional: leave it out when nothing on today\'s page corresponds to it.' : ''}`, control: '', optional };
  }
  if (s.action === 'type') {
    const value = clean(s.value);
    // The whole value, however long: a take that types only its beginning shows another text than the lesson.
    return { text: `Type ${value ? `"${value.slice(0, 4000)}"` : 'a suitable value'} into ${named(label) ? `the field "${label}"` : 'the field in focus'}${dlg}.`, control: label };
  }
  if (s.action === 'press') return { text: `Press ${clean(s.key || s.value) || 'Enter'}.`, control: '' };
  if (s.action === 'upload') return { text: `Attach a sample ${clean(s.value) || 'pdf'} file with ${named(label) ? `"${label}"` : 'the upload control'}.`, control: label };
  if (s.action === 'hover') return named(label) ? { text: `Hover over "${label}"${dlg} to show its tooltip.`, control: label } : null;
  return null;
}

// The company a saved lesson was recorded in, from the company its addresses name ('' when none does).
function companyOf(script) {
  const urls = [script?.environment?.startUrl, ...(script?.steps || []).flatMap((s) => [s?.url, s?.action === 'navigate' ? s?.value : null])];
  for (const u of urls) { try { const id = new URL(String(u)).searchParams.get('company_id'); if (/^\d+$/.test(id || '')) return id; } catch { /* not an address */ } }
  return '';
}

/** `today`: the day the re-shoot is made (dates in the lesson are moved to it).
 *  -> {exists:true, reshoot:true, summary, prerequisites:[], steps:[{instruction,label,action,route,from,act,control,optional?}], completion, notes}
 *  `from` is the index of the saved step each plan step repeats, `act` its action, `control` its label in lower
 *  case. An `optional` step (a silent click on a control with no text) may be left out. Page changes are not
 *  plan steps: the recorder notes them itself. */
export function reshootPlan(script, { today = new Date() } = {}) {
  const steps = [];
  const when = { recordedAt: script?.recording?.recordedAt || script?.createdAt || '', today, shown: NaN, companyId: companyOf(script) };
  let lastClick = null; // the control clicked by the step before, to spot a silent second click on it
  (script?.steps || []).forEach((s, from) => {
    if (s.action === 'navigate') { lastClick = null; return; }
    const d = describe(s, when);
    // A date field's own text is the date it held before the lesson changed it: what the next day picked is measured from.
    if (s.action === 'click') when.shown = s.target?.datePicker ? readDate(labelOf(s.target)) : s.target?.date ? NaN : when.shown;
    if (!d) { lastClick = null; return; }
    const line = said(s);
    // The same control clicked twice in a row with nothing said the second time is usually a double click the
    // recorder kept; on today's page the second click may do nothing at all.
    const again = s.action === 'click' && !line && !!d.control && lastClick === d.control.toLowerCase();
    lastClick = s.action === 'click' ? d.control.toLowerCase() : null;
    const optional = !!d.optional || again;
    steps.push({ instruction: d.text + (again ? ' This step is optional: it repeats the click before it, so leave it out when that click has already done the job.' : '')
      + (line ? ` (Narration over this step, for context only: "${line.slice(0, 200)}")` : ''), label: '', action: ['click', 'type'].includes(s.action) ? s.action : 'other', route: '', from,
      act: s.action, control: d.control.toLowerCase(), ...(optional ? { optional: true } : {}) });
  });
  return {
    exists: true,
    reshoot: true,
    summary: 'This is a RE-SHOOT of an existing lesson, not a new recording. The numbered steps are the lesson\'s own recorded actions. Repeat them one for one, in this order, on today\'s interface, so the lesson\'s existing narration still fits. Do not shorten the path, skip a step or take a more direct route, even when one exists.',
    prerequisites: [],
    steps,
    completion: 'the last numbered step has been performed and succeeded. Reply "done" straight after it',
    notes: 'Perform ONLY the numbered steps, then stop: the narration quoted beside a step is what the lesson says while that step is on screen, never an extra instruction, so do not act on anything it mentions. Perform a step even when it looks redundant (for example clicking the sidebar item of the page you are already on). A label may have changed since the lesson was recorded: when a named control is not on the page, use the control that does the same job (consult the source if unsure) and carry on with the next step. When a step names a specific record that is not listed, use the closest record of the same kind. If the app says a typed name already exists, add a short suffix such as " 2". Otherwise type exactly the values given. The lesson may have been recorded in another company: never open the company switcher at the top of the sidebar and never choose another company. Where a step names an item after the company the lesson was recorded in (for example a policy or entity called "Hadrius Sandbox LLC"), click the item on this page that carries today\'s company\'s name instead.',
  };
}

// ---- following the plan, turn by turn (the recorder's loop) ----

/** A take's progress through the plan: numbered steps performed, steps it was already told it skipped. */
export const reshootProgress = () => ({ done: new Set(), warned: new Set(), doneRefused: false });

const mustDo = (plan) => plan.steps.map((s, i) => (s.optional ? 0 : i + 1)).filter(Boolean);
const frontier = (progress) => Math.max(0, ...progress.done) + 1;

/** The progress line the recorder's model reads every turn. */
export function reshootNote(plan, progress) {
  const n = plan.steps.length;
  const done = [...progress.done].sort((a, b) => a - b);
  const next = frontier(progress);
  const behind = mustDo(plan).filter((k) => k < next && !progress.done.has(k));
  return `RE-SHOOT PROGRESS: numbered steps performed so far: ${done.join(', ') || 'none'} (of ${n}).`
    + (next <= n ? ` Next: step ${next}.` : ' Every numbered step is performed: reply "done".')
    + (behind.length ? ` Left out so far: ${behind.join(', ')}.` : '');
}

/**
 * Checks one decision of the recorder's model against the plan.
 *  - "done" while numbered steps are still to do is refused once; asked for again, it is accepted (a step can
 *    be impossible on today's interface, and the take then reports it as not repeated).
 *  - An action declared as step k while an earlier step has not been performed is refused once for that step.
 *  - An action with no declared step counts as the next step when it acts on that step's own control, and as
 *    a helper action otherwise.
 * `decision`: the model's JSON plus `name`, the label of the element it chose.
 * -> {refuse: message} | {ok:true, step: k (0: a helper action), from: saved step index}
 * The caller adds k to progress.done once the action has succeeded.
 */
export function reshootGate(plan, progress, decision) {
  const n = plan.steps.length;
  const undone = mustDo(plan).filter((k) => !progress.done.has(k));
  if (decision?.action === 'done') {
    if (undone.length && !progress.doneRefused) {
      progress.doneRefused = true;
      return { refuse: `refused — the re-shoot is not finished: numbered step(s) ${undone.join(', ')} are not marked as performed. Perform the ones still to do, in order, even where one looks redundant. If each of them has in fact been performed already, or cannot be performed on today's interface, reply "done" again and say which.` };
    }
    return { ok: true, step: 0 };
  }
  // The step the action says it performs: the "step" field, or else a reason that opens with "Step 4: ...".
  let k = Number(decision?.step ?? NaN);
  if (!Number.isInteger(k)) { const m = /^\s*step\s+(\d+)\b/i.exec(String(decision?.reason || '')); k = m ? Number(m[1]) : NaN; }
  if (!Number.isInteger(k) || k < 0 || k > n) {
    // Said nothing usable: taken as one of the next three steps when it acts on that step's own control,
    // and as a helper action otherwise.
    const name = clean(decision?.name).toLowerCase();
    const next = frontier(progress);
    k = 0;
    for (let c = next; name && c <= Math.min(n, next + 2); c++) if (!progress.done.has(c) && plan.steps[c - 1].control === name && plan.steps[c - 1].act === decision?.action) { k = c; break; }
  }
  // A click to put the cursor in a field before typing into it is not the "type" step itself.
  if (!k || plan.steps[k - 1].act !== decision?.action) return { ok: true, step: 0 };
  const skipped = undone.filter((s) => s < k && !progress.warned.has(s));
  if (skipped.length) {
    for (const s of skipped) progress.warned.add(s);
    return { refuse: `refused — step ${skipped[0]} comes before step ${k} and has not been performed (${plan.steps[skipped[0] - 1].instruction.slice(0, 140)}). Perform it now, even if it looks redundant. If it cannot be performed on today's interface, ask for step ${k} again.` };
  }
  return { ok: true, step: k, from: plan.steps[k - 1].from };
}

// ---- lining a take up against the saved lesson ----

/** Pairing key for lining a re-shoot up against the saved steps: action + control, and for a page change the
 *  page's path (the saved URL may lack the company or carry another query). '' after the bar never matches. */
export function reshootStepKey(step) {
  if (step?.action === 'navigate') return `navigate|${pagePath(step)}`;
  const label = labelOf(step?.target, step?.action);
  return `${step?.action || ''}|${(named(label) ? label : '').toLowerCase() || (['click', 'hover'].includes(step?.action) ? '' : clean(step?.value || step?.key).toLowerCase())}`;
}

// The longest run of pairs (given in the take's order) whose saved steps come in the lesson's order.
function inLessonOrder(pairs) {
  const len = pairs.map(() => 1), prev = pairs.map(() => -1);
  let best = -1;
  for (let b = 0; b < pairs.length; b++) {
    for (let a = 0; a < b; a++) if (pairs[a][0] < pairs[b][0] && len[a] + 1 > len[b]) { len[b] = len[a] + 1; prev[b] = a; }
    if (best < 0 || len[b] > len[best]) best = b;
  }
  const out = [];
  for (let k = best; k >= 0; k = prev[k]) out.unshift(pairs[k]);
  return out;
}

/**
 * Which action of the take repeats which saved step.
 *  1. What the recorder declared while it worked (`reshootOf` on a fresh step: the saved step's index, or -1
 *     for a helper action): the last action declared for a saved step, kept in the lesson's order.
 *  2. `exactPairs` (same action, same label) wherever they fit between those.
 *  3. What is still unpaired between two pairs: a saved action and a fresh one of the same action are the same
 *     step when their labels overlap ("Save" -> "Save changes"), or when they are the only leftovers of that
 *     stretch on each side, the same kind of control, and the recorder did not call the fresh one a helper.
 *     Anything short of one label containing the other is a guess, returned in `approx` for review.
 * -> {pairs: [[savedIdx, freshIdx]] increasing, approx: [[savedIdx, freshIdx]], declared: count from 1.}
 */
export function reshootPairs(oldSteps, freshSteps, exactPairs) {
  const planned = new Set(reshootPlan({ steps: oldSteps }).steps.map((s) => s.from));
  const act = (s) => s?.action !== 'navigate' && s?.action !== 'view';
  const lab = (s) => labelOf(s?.target, s?.action).toLowerCase();
  // 2: one label contains the other ("Save" / "Save changes"). 1: they share at least two words and half of
  // the longer one ("Add custom task" / "Add a custom task"). 0: no overlap worth trusting.
  const similar = (a, b) => {
    const x = lab(a), y = lab(b);
    if (!x || !y) return 0;
    if (x.includes(y) || y.includes(x)) return 2;
    const tx = new Set(x.split(' ')), ty = new Set(y.split(' '));
    const shared = [...tx].filter((t) => ty.has(t)).length;
    return shared >= 2 && shared / Math.max(tx.size, ty.size) >= 0.5 ? 1 : 0;
  };

  const lastFor = new Map();
  freshSteps.forEach((s, j) => { const i = s?.reshootOf; if (Number.isInteger(i) && i >= 0 && oldSteps[i] && oldSteps[i].action === s.action) lastFor.set(i, j); });
  const out = inLessonOrder([...lastFor].sort((a, b) => a[1] - b[1]));
  const declared = out.length;
  for (const [i, j] of exactPairs) if (out.every(([a, b]) => a !== i && b !== j && (a < i) === (b < j))) out.push([i, j]);
  out.sort((a, b) => a[0] - b[0]);

  const approx = [];
  const bounds = [[-1, -1], ...out, [oldSteps.length, freshSteps.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [o0, f0] = bounds[g], [o1, f1] = bounds[g + 1];
    const A = [], B = [];
    for (let i = o0 + 1; i < o1; i++) if (planned.has(i)) A.push(i);
    for (let j = f0 + 1; j < f1; j++) if (act(freshSteps[j])) B.push(j);
    let k = 0;
    const left = [];
    for (const i of A) {
      let hit = -1;
      for (let m = k; m < B.length; m++) if (oldSteps[i].action === freshSteps[B[m]].action && similar(oldSteps[i], freshSteps[B[m]])) { hit = m; break; }
      if (hit >= 0) { out.push([i, B[hit]]); if (similar(oldSteps[i], freshSteps[B[hit]]) < 2) approx.push([i, B[hit]]); k = hit + 1; } else left.push(i);
    }
    const taken = new Set(out.map(([, j]) => j));
    const spare = B.filter((j) => !taken.has(j));
    if (left.length === 1 && spare.length === 1 && oldSteps[left[0]].action === freshSteps[spare[0]].action
      && freshSteps[spare[0]].reshootOf === undefined
      && kindOf(oldSteps[left[0]]) === kindOf(freshSteps[spare[0]])
      && !!oldSteps[left[0]].target?.inDialog === !!freshSteps[spare[0]].target?.inDialog) {
      // In order with the pairs already made in this stretch? Only then is it the same step.
      const inOrder = out.every(([i, j]) => (i < left[0]) === (j < spare[0]));
      if (inOrder) { out.push([left[0], spare[0]]); approx.push([left[0], spare[0]]); }
    }
  }
  return { pairs: out.sort((a, b) => a[0] - b[0]), approx, declared };
}

/**
 * The re-shot lesson's steps, built so the lesson reads as it did before on the new slides.
 *  - A fresh step that repeats a saved step (`pairs`: [[savedIdx, freshIdx]], increasing) takes that step's
 *    narration and caption, and is silent where the saved step was silent.
 *  - A saved step that was narrated but has no action of its own in the re-shoot (a page that had just loaded, a
 *    click on a panel, the closing line, an action the take skipped) becomes a "view" step on the slide showing
 *    that moment: the page as the step before it left it.
 *  - A page-change slide is taken the instant the address changes, often half loaded: it is kept only when it
 *    carries a saved line, and then shows the settled page (the slide taken before the next action there).
 *  - Actions the take performed after the lesson's own last action are left out (the lesson ends where it did).
 *  - An action the take needed in between that the lesson did not have is kept with its freshly written line.
 * `endStep` is the recorder's slide of the finished state: a slide for closing lines, not a step.
 * `exactPairs` are the pairs by identical action and label; the rest of the pairing is done here (reshootPairs).
 * -> {steps, kept, beats, lost:[savedIdx whose line found no slide], usedEndFrame, missed:[savedIdx of actions
 *     not repeated], extra:[freshIdx of added actions kept], helpers: count of date-picker month changes kept
 *     silent and not counted as added, dropped, planned, declared,
 *     approx:[[savedIdx, slideIdx]] pairs made on a guess,
 *     relabeled:[{saved, slide, was, now, spoken}] controls that read differently today,
 *     retyped:[{saved, slide, was, now, spoken, changed}] fields given another value than the lesson's
 *     (`changed`: not just the lesson's value with something added after it),
 *     stale:[savedIdx] steps whose line talks about a label the slide no longer shows, or whose typed value changed}
 */
export function reshootMerge(oldSteps, freshSteps, exactPairs, endStep = null) {
  const isNav = (s) => s?.action === 'navigate';
  const planned = reshootPlan({ steps: oldSteps }).steps.filter((s) => !s.optional).map((s) => s.from);
  const { pairs, approx, declared } = reshootPairs(oldSteps, freshSteps, exactPairs);
  const allFreshOf = new Map(pairs);
  // Where the lesson's own actions end in the take: the first unpaired action after the last repeated one,
  // provided the lesson's final action was repeated. Everything from there on is the take overrunning.
  const pairedAll = new Set(pairs.map(([, j]) => j));
  const lastAction = Math.max(-1, ...pairs.filter(([, j]) => !isNav(freshSteps[j])).map(([, j]) => j));
  const finished = planned.length > 0 && allFreshOf.has(planned[planned.length - 1]);
  let cut = freshSteps.length;
  if (finished) for (let j = lastAction + 1; j < freshSteps.length; j++) if (!isNav(freshSteps[j]) && !pairedAll.has(j)) { cut = j; break; }
  const F = freshSteps.slice(0, cut).map((s) => { const { reshootOf, ...rest } = s; return rest; });
  const P = pairs.filter(([, j]) => j < cut);
  const freshOf = new Map(P), pairedFresh = new Set(P.map(([, j]) => j));
  const tail = cut < freshSteps.length ? freshSteps[cut] : endStep; // the slide of the state after the last kept step
  const tailFrame = tail?.media?.pre || null;

  // The settled slide for position j: an action's own slide; for a page change, the slide taken before the next
  // action on that page.
  const frameAt = (j) => {
    if (j >= F.length) return tailFrame;
    const s = F[j];
    if (!isNav(s)) return s.media?.pre || null;
    const path = pagePath(s);
    for (let k = j + 1; k <= F.length; k++) {
      const n = k < F.length ? F[k] : tail;
      if (!n?.media?.pre || pagePath(n) !== path) break;
      if (!isNav(n)) return n.media.pre;
    }
    return s.media?.pre || null;
  };

  let kept = 0;
  const carries = new Set(); // fresh indexes that carry a saved line
  for (const [i, j] of P) {
    F[j].narration = oldSteps[i].narration || '';
    if (oldSteps[i].caption) F[j].caption = oldSteps[i].caption; else delete F[j].caption;
    if (said(oldSteps[i])) { kept++; carries.add(j); }
  }
  // Narrated saved steps with no fresh counterpart, each tagged with the fresh step it follows (-1: none yet).
  const beats = [];
  let last = -1;
  oldSteps.forEach((o, i) => { if (freshOf.has(i)) last = freshOf.get(i); else if (said(o)) beats.push({ after: last, i }); });

  const after = new Map(); // fresh index -> view steps placed right after it (key -1: before everything)
  const lost = [];
  let usedEndFrame = false, placed = 0, opening = false;
  for (const { after: a, i } of beats) {
    const o = oldSteps[i];
    if (a === -1 && F.length && !pairedFresh.has(0) && !opening) {
      // The lesson's opening line belongs on the opening slide, in place of a freshly written one.
      F[0].narration = o.narration; if (o.caption) F[0].caption = o.caption; else delete F[0].caption;
      opening = true; kept++; carries.add(0);
      continue;
    }
    const at = a === -1 ? 0 : a + 1;
    const frame = frameAt(at);
    if (!frame) { lost.push(i); continue; }
    if (at >= F.length && tail === endStep) usedEndFrame = true;
    const src = F[at] || tail || F[a] || {};
    const slot = a === -1 && pairedFresh.has(0) ? -1 : Math.max(a, 0);
    if (!after.has(slot)) after.set(slot, []);
    after.get(slot).push({ action: 'view', target: null, url: src.url ?? '', route: src.route ?? '', title: '', capture: true, media: { pre: frame }, narration: o.narration, ...(o.caption ? { caption: o.caption } : {}) });
    placed++;
  }

  const steps = [...(after.get(-1) || [])];
  let dropped = freshSteps.length - cut;
  F.forEach((s, j) => {
    if (isNav(s) && !carries.has(j)) dropped++;
    else {
      if (isNav(s)) { const frame = frameAt(j); if (frame && frame !== s.media?.pre) { s.media = { ...s.media, pre: frame }; delete s.captureId; } }
      steps.push(s);
    }
    steps.push(...(after.get(j) || []));
  });
  steps.forEach((s, k) => { s.index = k; });
  const missed = planned.filter((i) => !freshOf.has(i));
  // Actions the take needed that the lesson did not have. Two kinds are only how today's interface or today's
  // date differs from the lesson's, and are not counted as added:
  //  - paging a date picker to another month: it stays on screen with nothing said over it;
  //  - opening a group in the sidebar to reach the item the lesson clicks there: the lesson's line for that
  //    item starts over the group, so the two clicks play as the one move they are.
  const added = F.map((s, j) => j).filter((j) => !pairedFresh.has(j) && !isNav(F[j]));
  const paging = added.filter((j) => F[j].action === 'click' && MONTH_PAGING.test(labelOf(F[j].target, 'click')));
  for (const j of paging) { F[j].narration = ''; delete F[j].caption; }
  const groups = added.filter((j) => F[j].action === 'click' && freshSteps[j].reshootOf !== undefined && inSidebar(F[j])
    && j + 1 < F.length && pairedFresh.has(j + 1) && F[j + 1].action === 'click' && inSidebar(F[j + 1]));
  for (const j of groups) {
    F[j].narration = F[j + 1].narration || '';
    if (F[j + 1].caption) F[j].caption = F[j + 1].caption; else delete F[j].caption;
    F[j + 1].narration = ''; delete F[j + 1].caption;
  }
  const helpers = [...paging, ...groups];
  const extra = added.filter((j) => !helpers.includes(j));
  // Pairs made on a guess, as [savedIdx, index of the slide in `steps`], so a reviewer can look at exactly those.
  const approxSlides = approx.filter(([, j]) => j < cut).map(([i, j]) => [i, steps.indexOf(F[j])]);

  // What reads differently on the new slides. A line is stale when it says the old label or the old value: the
  // phrase itself or, for a label, a telling word of it in any form ("Inherit" in "access is inherited") that
  // the new label no longer has.
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const says = (o, phrase, nowLabel = null) => {
    const p = clean(phrase).toLowerCase();
    if (p.length < 3 || p.length > MAX_LABEL) return false;
    const line = `${said(o)} ${clean(o.caption)}`.toLowerCase();
    if (new RegExp(`(^|[^a-z0-9])${esc(p)}([^a-z0-9]|$)`).test(line)) return true;
    // Only a label of a few words is combed for its words: a sentence shares words with any line.
    if (nowLabel === null || p.split(' ').length > 4) return false;
    const still = new Set(clean(nowLabel).toLowerCase().split(/[^a-z0-9]+/));
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 5 && !still.has(w) && !EVERYDAY.has(w) && new RegExp(`(^|[^a-z0-9])${esc(w.slice(0, Math.max(5, w.length - 2)))}`).test(line));
  };
  const relabeled = [], retyped = [];
  for (const [i, j] of P) {
    const o = oldSteps[i], f = F[j];
    if (isNav(o)) continue;
    const was = labelOf(o.target, o.action), now = labelOf(f.target, f.action);
    // The same words run together or punctuated another way are the same label, and a field is the same field
    // when any of its names (label, placeholder, own text) is one of the other's.
    const x = squash(was), y = squash(now);
    const names = (t) => [t?.name, t?.text, t?.label, t?.placeholder].map(squash).filter(Boolean);
    const sameField = ['type', 'upload'].includes(o.action) && names(o.target).some((a) => names(f.target).includes(a));
    if (x && y && !sameField && !o.target?.date && !o.target?.datePicker && !x.includes(y) && !y.includes(x)) {
      relabeled.push({ saved: i, slide: steps.indexOf(f), was: was.slice(0, 80), now: now.slice(0, 80), spoken: says(o, was, now) });
    }
    if (o.action === 'type') {
      const a = clean(o.value), b = clean(f.value);
      // The lesson's value with something after it (a name that was taken, so " 2" was added) still shows the
      // lesson's text; any other value is another text on screen, whether or not the line says it.
      if (a && a !== b) retyped.push({ saved: i, slide: steps.indexOf(f), was: a.slice(0, 80), now: b.slice(0, 80), spoken: says(o, a), changed: !b.toLowerCase().startsWith(a.toLowerCase()) });
    }
  }
  const stale = [...new Set([...relabeled.filter((r) => r.spoken), ...retyped.filter((r) => r.changed)].map((r) => r.saved))].sort((a, b) => a - b);
  return { steps, kept, beats: placed, lost, usedEndFrame, missed, extra, helpers: helpers.length, dropped, planned: planned.length, declared, approx: approxSlides, relabeled, retyped, stale };
}

/** Whether a merged take is the saved lesson again, one for one, with nothing for a person to settle. */
export const reshootExact = (m) => !m.missed.length && !m.lost.length && !m.extra.length && !m.approx.length && !m.stale.length;
