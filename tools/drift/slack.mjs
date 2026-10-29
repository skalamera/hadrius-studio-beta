// Slack side of drift jobs: a pure Block Kit builder for the approval message, a tiny Slack Web API
// client (fetch, injected token getter) and postDriftJob(), which posts the message to the drift
// channel, records its ts on the job via the service, and uploads before/after screenshots into
// the message thread. Import-safe: no side effects, no .env reads, no network until called.
import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { DRIFT_CHANNEL } from './jobs.mjs';

export { DRIFT_CHANNEL };
export const LIMITS = Object.freeze({ blocks: 50, reserve: 2, sectionText: 2900, header: 150, contextText: 1900, fallbackText: 3000, stepBlocks: 30 });

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quote = (s) => '>' + esc(s).replace(/\n/g, '\n>');
const mmss = (sec) => (sec == null ? '?' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const httpUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u) ? u : null;
const link = (u, label) => (httpUrl(u) ? `<${u}|${esc(label)}>` : null);
const section = (text, block_id) => ({ type: 'section', ...(block_id ? { block_id } : {}), text: { type: 'mrkdwn', text: trunc(text, LIMITS.sectionText) } });
const context = (text, block_id) => ({ type: 'context', ...(block_id ? { block_id } : {}), elements: [{ type: 'mrkdwn', text: trunc(text, LIMITS.contextText) }] });
const TYPE_LABEL = { screenshot: '🖼️ screenshot', highlight: '🔲 highlight', narration: '🗣️ narration' };

/** Text for one changed step (shared by the main message and overflow thread replies). */
export function stepText(c, { images = true } = {}) {
  const lines = [`*Step ${c.step}* · ${c.changeTypes.map((t) => TYPE_LABEL[t] || t).join(' + ')}${c.action ? ` · _${esc(c.action)}_` : ''}`];
  for (const w of (c.why || []).slice(0, 4)) lines.push(`• ${esc(w)}`);
  if (c.changeTypes.includes('narration')) {
    lines.push('*Narration — old:*', quote(trunc(c.oldNarration || '(none)', 900)), '*Narration — new:*', quote(trunc(c.newNarration || '(none)', 900)));
  } else if (c.narrationFlagged) {
    lines.push('*Narration (flagged, no replacement proposed):*', quote(trunc(c.oldNarration || '(none)', 900)));
  } else if (c.oldNarration) {
    lines.push(`_Narration unchanged:_ “${esc(trunc(c.oldNarration, 300))}”`);
  }
  if (images && (c.before || c.after)) lines.push('_Before/after screenshots: in the thread_ 🧵');
  return lines.join('\n');
}

/**
 * Pure Block Kit builder. job = service job ({id, kind, video_name, video_title, details}).
 * Returns {text, blocks, overflow: [thread texts], images: [{step, files:[{path, title}], comment}]}.
 */
export function buildDriftMessage(job, { channel = DRIFT_CHANNEL, studioUrl = null } = {}) {
  const d = job.details || {};
  const v = d.video || {};
  const title = v.title || job.video_title || job.video_name;
  const changes = Array.isArray(d.changes) ? d.changes : [];
  const manual = job.kind === 'manual_rerecord';
  const u = d.untouched || {};
  const det = d.detection || {};
  const blocks = [];

  blocks.push({ type: 'header', block_id: 'drift_header', text: { type: 'plain_text', text: trunc(`${manual ? '🎬 Needs a re-record' : '🛠️ Update proposed'}: ${title}`, LIMITS.header), emoji: true } });
  const meta = [v.module ? `*Module:* ${esc(v.module)}` : null, v.stepCount ? `*Steps:* ${v.stepCount}` : null, `*Video:* \`${esc(job.video_name)}\``].filter(Boolean);
  const studio = httpUrl(d.links?.studio) || httpUrl(studioUrl);
  const links = [link(d.links?.drive, 'Current video (Drive)'), link(d.links?.pylon, 'Pylon article'), link(studio, 'Open in Studio')].filter(Boolean);
  blocks.push(section([meta.join('  ·  '), links.length ? links.join('  ·  ') : '_No Drive/Pylon links recorded for this video._'].join('\n'), 'drift_head'));

  // Why
  const why = [];
  const prs = (det.prs || []).filter((p) => p && (p.url || p.number));
  if (prs.length) why.push('*Triggered by merged PR(s):* ' + prs.map((p) => link(p.url, `#${p.number ?? '?'}${p.title ? ` ${trunc(p.title, 80)}` : ''}`) || `#${p.number}`).join(', '));
  why.push(`*Evidence:* the weekly check replayed this walkthrough against the live Academy UI${det.runAt ? ` on ${det.runAt.slice(0, 10)}` : ''} and compared every screenshot with the recording.`);
  if (det.summary) why.push(`*Classifier:* ${esc(trunc(det.summary, 700))}`);
  if (d.reasons?.length) why.push(d.reasons.slice(0, 8).map((r) => `• ${esc(r)}`).join('\n'));
  blocks.push(section(`*Why it needs updating*\n${why.join('\n')}`, 'drift_why'));
  if (manual && d.rerecordReason?.length) blocks.push(section(`*Why it can't be updated automatically*\n${d.rerecordReason.slice(0, 8).map((r) => `• ${esc(r)}`).join('\n')}\nA person needs to re-record this video. Nothing will change until someone does.`, 'drift_rerecord'));

  blocks.push({ type: 'divider' });
  blocks.push(section(manual ? `*Steps with evidence (${changes.length})*` : `*Exactly what will change (${changes.length} step${changes.length === 1 ? '' : 's'})*`, 'drift_changes_head'));

  // Fixed tail: untouched + cost + actions (+ status line the service adds later).
  const tail = [];
  if (!manual) {
    const keep = [];
    if (u.steps?.length) keep.push(`*Unchanged steps:* ${u.steps.join(', ')} (screenshots, highlights and narration takes reused as-is)`);
    else keep.push('*Unchanged steps:* none');
    if (u.narrationUnchangedSteps) keep.push(`*Narration unchanged on:* ${u.narrationUnchangedSteps.length === (v.stepCount || 0) ? 'every step' : u.narrationUnchangedSteps.join(', ') || 'no steps'}`);
    if (u.framesPreservedPct != null) keep.push(`*≈${u.framesPreservedPct}% of the video's frames preserved*`);
    if (u.oldDurationSec != null) keep.push(`*Duration:* ${mmss(u.oldDurationSec)} → ${mmss(u.newDurationSec)}`);
    if (u.unverified?.length) keep.push(`*Not verified (left as-is):* ${u.unverified.map((x) => `step ${x.step}${x.why?.[0] ? ` — ${esc(trunc(x.why[0], 120))}` : ''}`).join('; ')}`);
    tail.push(section(`*What stays untouched*\n${keep.join('\n')}`, 'drift_untouched'));
    tail.push(context(`ElevenLabs: ≈${(d.elevenLabsChars || 0).toLocaleString('en-US')} characters to re-voice · Nothing is published until a human approves here or in the Studio extension.`, 'drift_cost'));
  } else {
    tail.push(context('Anyone in this channel can claim it. Claiming just records who is re-recording; nothing changes automatically.', 'drift_cost'));
  }
  const btn = (action_id, text, style) => ({ type: 'button', action_id, value: job.id, text: { type: 'plain_text', text, emoji: true }, ...(style ? { style } : {}) });
  const elements = manual
    ? [btn('drift_claim', "🙋 I'll re-record it", 'primary'), btn('drift_rerecorded', '✅ Mark re-recorded'), btn('drift_dismiss', 'Dismiss')]
    : [btn('drift_approve', '✅ Approve', 'primary'), { ...btn('drift_deny', '🚫 Deny', 'danger') }];
  if (studio) elements.push({ type: 'button', action_id: 'drift_open', url: studio, text: { type: 'plain_text', text: 'Open in Studio' } });
  tail.push({ type: 'actions', block_id: 'drift_actions', elements });

  const room = LIMITS.blocks - LIMITS.reserve - blocks.length - tail.length;
  const inline = changes.slice(0, Math.max(0, Math.min(room, LIMITS.stepBlocks)));
  const rest = changes.slice(inline.length);
  for (const c of inline) blocks.push(section(stepText(c), `drift_step_${c.step}`));
  if (rest.length) blocks.push(context(`…and ${rest.length} more step(s): ${rest.map((c) => c.step).join(', ')} — full details in the thread.`, 'drift_more'));
  blocks.push(...tail);

  const overflow = [];
  let buf = '';
  for (const c of rest) { const t = stepText(c); if (buf && buf.length + t.length > LIMITS.fallbackText) { overflow.push(buf); buf = ''; } buf += (buf ? '\n\n' : '') + t; }
  if (buf) overflow.push(buf);

  const images = changes.filter((c) => c.before?.path || c.after?.path).map((c) => ({
    step: c.step,
    comment: `*Step ${c.step}* — ${c.changeTypes.join(' + ')}: *before* (current video) and *after* (live UI today).`,
    files: [c.before?.path && { path: c.before.path, title: `Step ${c.step} — before (current video)` }, c.after?.path && { path: c.after.path, title: `Step ${c.step} — after (live UI today)` }].filter(Boolean),
  }));
  const text = trunc(`${manual ? 'Needs a re-record' : 'Update proposed'}: ${title} — ${changes.length} step(s). ${manual ? '' : 'Approve or deny in Slack or the Studio extension.'}`, LIMITS.fallbackText);
  return { channel, text, blocks: blocks.slice(0, LIMITS.blocks), overflow, images };
}

// ---------------------------------------------------------------- Slack Web API client
export class SlackError extends Error { constructor(method, error) { super(`Slack ${method} failed: ${error}`); this.method = method; this.slackError = error; } }

export function createSlackClient({ getToken, fetchImpl = globalThis.fetch } = {}) {
  const token = () => {
    const t = String(getToken?.() || '').trim();
    if (!t) throw Object.assign(new Error('Slack is not configured on this machine: add SLACK_STUDIO_BOT_TOKEN to the hadrius-studio .env (see tools/drift/SLACK_SETUP.md).'), { code: 'not_configured' });
    return t;
  };
  async function call(method, body, { form = false } = {}) {
    const headers = { Authorization: `Bearer ${token()}` };
    let payload;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(Object.entries(body).filter(([, v]) => v != null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString(); }
    else { headers['Content-Type'] = 'application/json; charset=utf-8'; payload = JSON.stringify(body); }
    const r = await fetchImpl(`https://slack.com/api/${method}`, { method: 'POST', headers, body: payload });
    let json; try { json = await r.json(); } catch { json = { ok: false, error: `http_${r.status}` }; }
    if (!json?.ok) throw new SlackError(method, json?.error || `http_${r.status}`);
    return json;
  }
  /** files.getUploadURLExternal → PUT bytes → files.completeUploadExternal (shared into channel/thread). */
  async function uploadFiles({ channel, threadTs = null, initialComment = null, files }) {
    const done = [];
    for (const f of files) {
      const bytes = f.bytes;
      const g = await call('files.getUploadURLExternal', { filename: f.filename, length: String(bytes.length) }, { form: true });
      const up = await fetchImpl(g.upload_url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (!up.ok) throw new SlackError('upload', `http_${up.status}`);
      done.push({ id: g.file_id, title: f.title || f.filename });
    }
    const c = await call('files.completeUploadExternal', { files: done, channel_id: channel, thread_ts: threadTs, initial_comment: initialComment }, { form: true });
    return (c.files || done).map((x) => ({ id: x.id, title: x.title, permalink: x.permalink || null }));
  }
  return { call, uploadFiles };
}

/**
 * Post a job's approval message, record it on the job, then add overflow details and before/after
 * screenshots as thread replies. Image/overflow failures are collected, not thrown: the decision
 * message is what matters.
 */
export async function postDriftJob({ job, slack, jobs, channel = DRIFT_CHANNEL, readFile = fsReadFile, evidencePaths = null, studioUrl = null, log = () => {} }) {
  if (!job?.id) throw new Error('job.id required (create the job on the service first)');
  const msg = buildDriftMessage(applyEvidence(job, evidencePaths), { channel, studioUrl: typeof studioUrl === 'function' ? studioUrl(job) : studioUrl });
  let blocks = msg.blocks, posted;
  try { posted = await slack.call('chat.postMessage', { channel, text: msg.text, blocks, unfurl_links: false, unfurl_media: false }); }
  catch (e) {
    if (e?.slackError !== 'invalid_blocks') throw e;
    // A URL Slack refuses (e.g. a local Studio link) must not block the approval message.
    blocks = blocks.map((b) => (b.type === 'actions' ? { ...b, elements: b.elements.filter((x) => !x.url) } : b));
    posted = await slack.call('chat.postMessage', { channel, text: msg.text, blocks, unfurl_links: false, unfurl_media: false });
  }
  const ts = posted.ts;
  const errors = [];
  try { await jobs.attachSlack({ id: job.id, channel, ts, blocks }); }
  catch (e) { errors.push({ stage: 'attach', error: String(e?.message || e) }); log(`[drift-slack] could not record ts on job ${job.id}: ${e?.message || e}`); }
  for (const text of msg.overflow) {
    try { await slack.call('chat.postMessage', { channel, thread_ts: ts, text, unfurl_links: false }); }
    catch (e) { errors.push({ stage: 'overflow', error: String(e?.message || e) }); }
  }
  const files = [];
  for (const img of msg.images) {
    try {
      const payload = [];
      for (const f of img.files) {
        try { payload.push({ filename: `step-${img.step}-${basename(f.path)}`, title: f.title, bytes: await readFile(f.path) }); }
        catch (e) { errors.push({ stage: 'read', step: img.step, error: `${basename(f.path)}: ${e?.code || e?.message || e}` }); }
      }
      if (!payload.length) continue;
      const up = await slack.uploadFiles({ channel, threadTs: ts, initialComment: img.comment, files: payload });
      files.push({ step: img.step, files: up });
    } catch (e) { errors.push({ stage: 'upload', step: img.step, error: String(e?.message || e) }); }
  }
  return { channel, ts, files, errors };
}

/** Optional per-step evidence override: {stepNumber: {before, after}} (paths). */
export function applyEvidence(job, evidencePaths) {
  if (!evidencePaths) return job;
  const changes = (job.details?.changes || []).map((c) => {
    const e = evidencePaths[c.step] || evidencePaths[String(c.step)];
    return e ? { ...c, before: e.before ? { path: e.before } : c.before, after: e.after ? { path: e.after } : c.after } : c;
  });
  return { ...job, details: { ...job.details, changes } };
}

/**
 * Create (idempotently) the job on the service, then post it to Slack unless it was already posted.
 * `slack` may be null (token not configured): the job still exists and shows up in the extension.
 * @returns {{job, created, duplicate?:boolean, slack:{ts?,channel?,files?,errors?,skipped?,error?}}}
 */
export async function submitDriftJob({ payload, evidencePaths = null, jobs, slack, channel = DRIFT_CHANNEL, studioUrl = null, readFile = fsReadFile, log = () => {} }) {
  const { job, created } = await jobs.create(payload);
  if (job.slack_ts) return { job, created, duplicate: true, slack: { channel: job.slack_channel, ts: job.slack_ts } };
  if (!slack) return { job, created, slack: { skipped: 'not_configured', error: 'SLACK_STUDIO_BOT_TOKEN is not set in the hadrius-studio .env, so no Slack message was posted (the job is still reviewable in the extension).' } };
  try {
    const posted = await postDriftJob({ job, slack, jobs, channel, evidencePaths, studioUrl, readFile, log });
    return { job: { ...job, slack_channel: posted.channel, slack_ts: posted.ts }, created, slack: posted };
  } catch (e) {
    return { job, created, slack: { error: String(e?.message || e), code: e?.code || e?.slackError || null } };
  }
}
