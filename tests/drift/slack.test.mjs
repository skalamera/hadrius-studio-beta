import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobDetails } from '../../tools/drift/jobs.mjs';
import { buildDriftMessage, createSlackClient, postDriftJob, submitDriftJob, LIMITS, DRIFT_CHANNEL } from '../../tools/drift/slack.mjs';

// Same sample weekly result as jobs.test.mjs (copied so this file doesn't re-run those tests).
const SCRIPT = {
  name: 'Approving-Marketing-Reviews', title: 'Approving Marketing Reviews', module: 'Marketing',
  steps: [
    { narration: 'Open Marketing from the sidebar.' },
    { narration: 'Click the review you want to approve.' },
    { narration: 'Press Approve to sign off on the review.' },
    { narration: 'The status changes to Approved.' },
  ],
};
const WEEKLY_JOB = {
  schema: 1, name: 'Approving-Marketing-Reviews', status: 'ok', verdict: 'narration_review', complete: false,
  summary: 'Screenshot changed and narration may be inaccurate: human narration review. slide 3: narration_inaccurate (button now says Sign off).',
  startedAt: '2026-10-26T08:00:00.000Z', finishedAt: '2026-10-26T08:04:00.000Z', reasons: [],
  evidence: { contactSheet: '/scratch/weekly/Approving/capture/contact.png' },
  steps: [
    { index: 0, action: 'click', verdict: 'unchanged', reasons: [] },
    { index: 1, action: 'click', verdict: 'moved_highlight', reasons: [{ verdict: 'moved_highlight', code: 'target_moved', detail: 'target moved/resized by up to 38px' }],
      metrics: { diff: 0.004, ssimMasked: 0.97 }, evidence: { recorded: '/rec/step_b.png', today: '/run/today_1.png', diff: '/run/diff_1.png' } },
    { index: 2, action: 'click', verdict: 'narration_review', reasons: [
      { verdict: 'slide_update', code: 'screenshot_changed', detail: 'diff 2.10% non-dynamic, SSIM 0.93' },
      { verdict: 'narration_review', code: 'narration_inaccurate', detail: 'the button now says "Sign off", not "Approve"' }],
      metrics: { diff: 0.021, ssimMasked: 0.93 }, evidence: { recorded: '/rec/step_c.png', today: '/run/today_2.png' } },
    { index: 3, action: 'click', verdict: 'unverified', reasons: [{ verdict: 'unverified', code: 'needs_fixture', detail: 'replay stopped before a data-changing step' }] },
  ],
};


const ID = '11111111-2222-4333-8444-555555555555';
const autoJob = () => ({ id: ID, ...buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT, proposedNarration: { 2: 'Press Sign off to approve the review.' },
  links: { drive: 'https://drive.google.com/file/d/abc/view', pylon: 'https://help.example/a/1', studio: 'http://127.0.0.1:8787/drift/review?id=' + ID },
  prs: [{ number: 812, title: 'Rename Approve to Sign off', url: 'https://github.com/x/y/pull/812' }], slideDurations: [4, 5, 6, 5], oldDurationSec: 30 }) });
const manualJob = () => ({ id: ID, ...buildJobDetails({ weeklyJob: WEEKLY_JOB, script: SCRIPT }) });

/** Compact, reviewable snapshot: block type/id + first line of text. */
const shape = (blocks) => blocks.map((b) => `${b.type}:${b.block_id || ''}:${(b.text?.text || b.elements?.map((e) => e.text?.text ?? e.text).join('|') || '').split('\n')[0]}`);

test('auto_update message snapshot', () => {
  const m = buildDriftMessage(autoJob());
  assert.deepEqual(shape(m.blocks), [
    'header:drift_header:🛠️ Update proposed: Approving Marketing Reviews',
    'section:drift_head:*Module:* Marketing  ·  *Steps:* 4  ·  *Video:* `Approving-Marketing-Reviews`',
    'section:drift_why:*Why it needs updating*',
    'divider::',
    'section:drift_changes_head:*Exactly what will change (2 steps)*',
    'section:drift_step_2:*Step 2* · 🔲 highlight · _click_',
    'section:drift_step_3:*Step 3* · 🖼️ screenshot + 🗣️ narration · _click_',
    'section:drift_untouched:*What stays untouched*',
    'context:drift_cost:ElevenLabs: ≈37 characters to re-voice · Nothing is published until a human approves here or in the Studio extension.',
    'actions:drift_actions:✅ Approve|🚫 Deny|Open in Studio',
  ]);
  const all = JSON.stringify(m.blocks);
  for (const needle of ['<https://drive.google.com/file/d/abc/view|Current video (Drive)>', '<https://help.example/a/1|Pylon article>', '<https://github.com/x/y/pull/812|#812 Rename Approve to Sign off>',
    'live Academy UI on 2026-10-26', '*Narration — old:*', '>Press Approve to sign off on the review.', '>Press Sign off to approve the review.', '_Narration unchanged:_ “Click the review you want to approve.”',
    '*Unchanged steps:* 1, 4', '*Narration unchanged on:* 1, 2, 4', '≈45% of the video', '*Duration:* 0:30 → 0:30', 'step 4 — ', 'Before/after screenshots: in the thread']) assert.ok(all.includes(needle), `missing ${needle}`);
  const actions = m.blocks.at(-1);
  assert.deepEqual(actions.elements.map((e) => [e.action_id, e.value ?? e.url]), [['drift_approve', ID], ['drift_deny', ID], ['drift_open', 'http://127.0.0.1:8787/drift/review?id=' + ID]]);
  assert.deepEqual(m.images.map((i) => [i.step, i.files.map((f) => f.path)]), [[2, ['/rec/step_b.png', '/run/today_1.png']], [3, ['/rec/step_c.png', '/run/today_2.png']]]);
  assert.equal(m.overflow.length, 0);
});

test('manual_rerecord message snapshot: why + evidence + claim/re-recorded/dismiss', () => {
  const m = buildDriftMessage(manualJob());
  assert.deepEqual(shape(m.blocks), [
    'header:drift_header:🎬 Needs a re-record: Approving Marketing Reviews',
    'section:drift_head:*Module:* Marketing  ·  *Steps:* 4  ·  *Video:* `Approving-Marketing-Reviews`',
    'section:drift_why:*Why it needs updating*',
    "section:drift_rerecord:*Why it can't be updated automatically*",
    'divider::',
    'section:drift_changes_head:*Steps with evidence (2)*',
    'section:drift_step_2:*Step 2* · 🔲 highlight · _click_',
    'section:drift_step_3:*Step 3* · 🖼️ screenshot · _click_',
    'context:drift_cost:Anyone in this channel can claim it. Claiming just records who is re-recording; nothing changes automatically.',
    "actions:drift_actions:🙋 I'll re-record it|✅ Mark re-recorded|Dismiss",
  ]);
  assert.ok(JSON.stringify(m.blocks).includes('*Narration (flagged, no replacement proposed):*'));
});

test('stays within Slack limits: 60 changed steps → ≤ 48 blocks, the rest in thread replies, text ≤ 3000', () => {
  const j = autoJob();
  const base = j.details.changes[1];
  j.details.changes = Array.from({ length: 60 }, (_, i) => ({ ...base, step: i + 1, index: i, oldNarration: 'o'.repeat(1500), newNarration: 'n'.repeat(1500) }));
  const m = buildDriftMessage(j);
  assert.ok(m.blocks.length <= LIMITS.blocks - LIMITS.reserve, `${m.blocks.length} blocks`);
  for (const b of m.blocks) if (b.text?.text) assert.ok(b.text.text.length <= 3000);
  const inline = m.blocks.filter((b) => /^drift_step_/.test(b.block_id || '')).length;
  const threaded = m.overflow.join('\n').match(/\*Step \d+\*/g).length;
  assert.equal(inline + threaded, 60);
  for (const t of m.overflow) assert.ok(t.length <= 4000);
  assert.equal(m.blocks.at(-1).type, 'actions');
});

function fakeSlack({ failFirstBlocks = false } = {}) {
  const calls = []; let first = true;
  const fetchImpl = async (url, init) => {
    const method = url.replace('https://slack.com/api/', '');
    const body = init.headers['Content-Type']?.startsWith('application/json') ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, body, headers: init.headers });
    const ok = (o) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...o }) });
    if (url.startsWith('https://files.example/')) return { ok: true, status: 200, json: async () => ({}) };
    if (method === 'chat.postMessage') {
      if (failFirstBlocks && first && !body.thread_ts) { first = false; return { ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_blocks' }) }; }
      return ok({ ts: body.thread_ts ? '1761900000.000300' : '1761900000.000100' });
    }
    if (method === 'files.getUploadURLExternal') { const p = new URLSearchParams(body); return ok({ upload_url: `https://files.example/${p.get('filename')}`, file_id: 'F' + calls.length }); }
    if (method === 'files.completeUploadExternal') { const files = JSON.parse(new URLSearchParams(body).get('files')); return ok({ files: files.map((f) => ({ ...f, permalink: `https://slack/f/${f.id}` })) }); }
    return ok({});
  };
  return { calls, client: createSlackClient({ getToken: () => 'xoxb-test', fetchImpl }) };
}

test('postDriftJob: posts to the drift channel, records ts on the job, uploads before/after into the thread', async () => {
  const { calls, client } = fakeSlack();
  const attached = [];
  const jobs = { attachSlack: async (a) => { attached.push(a); return { status: 'ok' }; } };
  const files = { '/rec/step_b.png': 'B', '/run/today_1.png': 'T1', '/rec/step_c.png': 'C' }; // today_2 missing on disk
  const r = await postDriftJob({ job: autoJob(), slack: client, jobs, readFile: async (p) => { if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return Buffer.from(files[p]); } });
  assert.equal(r.ts, '1761900000.000100');
  const post = calls.find((c) => c.method === 'chat.postMessage');
  assert.equal(post.body.channel, DRIFT_CHANNEL); assert.equal(post.headers.Authorization, 'Bearer xoxb-test');
  assert.deepEqual(attached.map((a) => [a.id, a.channel, a.ts, a.blocks.length]), [[ID, DRIFT_CHANNEL, r.ts, post.body.blocks.length]]);
  const completes = calls.filter((c) => c.method === 'files.completeUploadExternal').map((c) => new URLSearchParams(c.body));
  assert.equal(completes.length, 2);
  assert.equal(completes[0].get('channel_id'), DRIFT_CHANNEL); assert.equal(completes[0].get('thread_ts'), r.ts);
  assert.equal(JSON.parse(completes[0].get('files')).length, 2);
  assert.equal(JSON.parse(completes[1].get('files')).length, 1);
  assert.deepEqual(r.errors.map((e) => [e.stage, e.step]), [['read', 3]]);
  assert.equal(r.files[0].files[0].permalink.startsWith('https://slack/f/'), true);
});

test('postDriftJob: a rejected URL button is dropped and the message is re-posted', async () => {
  const { calls, client } = fakeSlack({ failFirstBlocks: true });
  const r = await postDriftJob({ job: { ...autoJob(), details: { ...autoJob().details, changes: [] } }, slack: client, jobs: { attachSlack: async () => ({}) } });
  const posts = calls.filter((c) => c.method === 'chat.postMessage');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.blocks.at(-1).elements.map((e) => e.action_id), ['drift_approve', 'drift_deny']);
  assert.equal(r.ts, '1761900000.000100');
});

test('slack client refuses to run without a token (no network)', async () => {
  const c = createSlackClient({ getToken: () => '', fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(c.call('chat.postMessage', {}), (e) => e.code === 'not_configured' && /SLACK_STUDIO_BOT_TOKEN/.test(e.message));
});

test('submitDriftJob: posts once; a re-submitted (duplicate) job is not re-posted; no token → job only', async () => {
  const store = new Map();
  const jobs = {
    create: async (p) => { const hit = [...store.values()].find((j) => j.fingerprint === p.fingerprint); if (hit) return { job: { ...hit }, created: false };
      const job = { id: ID, ...p, status: 'pending_approval', slack_ts: null }; store.set(job.id, job); return { job: { ...job }, created: true }; },
    attachSlack: async ({ id, channel, ts }) => { Object.assign(store.get(id), { slack_channel: channel, slack_ts: ts }); return {}; },
  };
  const payload = (({ id, ...rest }) => rest)(autoJob());
  payload.details = { ...payload.details, changes: [] };
  const { calls, client } = fakeSlack();
  const a = await submitDriftJob({ payload, jobs, slack: client, studioUrl: (j) => `http://127.0.0.1:8787/drift/review?id=${j.id}` });
  assert.equal(a.created, true); assert.equal(a.slack.ts, '1761900000.000100');
  const b = await submitDriftJob({ payload, jobs, slack: client });
  assert.equal(b.duplicate, true); assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 1);
  const none = await submitDriftJob({ payload: { ...payload, fingerprint: 'fp1-other' }, jobs, slack: null });
  assert.equal(none.slack.skipped, 'not_configured'); assert.equal(none.created, true);
});
