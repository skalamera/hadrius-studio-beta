// Publish a verified drift-update candidate to the SAME destinations, with rollback.
//
// Rules (see tools/drift/README.md "Executing approved jobs"):
//  - Drive: replace the content of the SAME file id (files.update media upload). Never create a file,
//    never look files up by name. Mark the previous head revision keepForever BEFORE the upload so it
//    can be restored. Never add/alter permissions (read-back asserts they are unchanged).
//  - Pylon: PATCH the SAME article id. Published article -> publish_updated_body_html:true; draft-only
//    article -> body only (stays a draft). Never send is_published:false. A published article with an
//    unrelated pending draft (or a pending review) BLOCKS. Only the video embed's src changes; every
//    other byte of the body is kept. The previous body is saved for rollback.
//  - Shared library script: updated only after both providers are verified by read-back; previous
//    revision kept (prev-library-script.json + prev-local-script.json).
//  - Order: preflight (all read-only) -> Drive -> Pylon -> library. Any failure after a write rolls
//    back the steps already applied and reports exactly what was / wasn't changed.
//
// Import-safe: no side effects, no .env reads. Every provider is injected (createDriveClient /
// createPylonClient / createLibraryClient build the real ones from injected fetchers).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class PublishError extends Error {
  constructor(code, detail = null, extra = {}) {
    super(`${code}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    this.code = code; this.detail = detail; Object.assign(this, extra);
  }
}
const fail = (code, detail) => { throw new PublishError(code, detail); };

export const md5File = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
export const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));

// ------------------------------------------------------------------ journal (crash-safe state)
/** A tiny JSON journal: every mutation is written BEFORE (intent) and AFTER (done) the remote call. */
export function openJournal(file) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(`${file}.tmp`, file); };
  return {
    file,
    get state() { return state; },
    get: (k) => state[k],
    set(k, v) { state[k] = v; state.updatedAt = new Date().toISOString(); save(); return v; },
    merge(k, v) { state[k] = { ...(state[k] || {}), ...v }; state.updatedAt = new Date().toISOString(); save(); return state[k]; },
  };
}

// ------------------------------------------------------------------ Pylon body: video-only replacement
// Attribute value for the new URL, following the article's own convention for '&' (Pylon stores its signed
// CDN URLs with a raw '&'); quotes are always percent-encoded so the attribute can't break.
const escAttr = (s, likeSrc = null) => {
  const v = String(s).replace(/"/g, '%22').replace(/'/g, '%27');
  return likeSrc != null && !/&amp;/.test(likeSrc) ? v : v.replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
};
const unAmp = (s) => String(s ?? '').replace(/&amp;/g, '&');

/**
 * Plan the body edit. Returns {mode, oldSrc?, start?, end?, driveRefs}.
 *  mode 'video_src'  : exactly one <video> with a src attribute -> swap only that attribute value
 *  mode 'drive_link' : no <video>, but the body links the script's Drive file id (same id after the
 *                      Drive replace, so the body needs no change)
 * Blocks: no_video_embed, ambiguous_video_embed, unsupported_video_markup.
 */
export function planVideoReplacement(body, { driveFileId = null } = {}) {
  const html = String(body ?? '');
  const tags = [...html.matchAll(/<video\b[^>]*>/gi)];
  const driveRefs = driveFileId ? html.split(driveFileId).length - 1 : 0;
  if (tags.length > 1) fail('ambiguous_video_embed', `${tags.length} <video> tags`);
  if (tags.length === 0) {
    if (driveRefs > 0) return { mode: 'drive_link', driveRefs };
    fail('no_video_embed', 'the article has no <video> and no link to the script\'s Drive file');
  }
  const tag = tags[0];
  const m = tag[0].match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (!m) fail('unsupported_video_markup', 'the <video> tag has no src attribute');
  const valueStart = tag.index + m.index + m[0].indexOf(m[1]) + 1;
  const oldSrc = m[2] ?? m[3];
  return { mode: 'video_src', oldSrc, start: valueStart, end: valueStart + oldSrc.length, driveRefs };
}

/** Apply a plan: only the bytes of the src value change. Asserts prefix/suffix byte-identity. */
export function applyVideoReplacement(body, plan, newUrl) {
  if (plan.mode !== 'video_src') return body;
  const newSrc = escAttr(newUrl, plan.oldSrc);
  const out = body.slice(0, plan.start) + newSrc + body.slice(plan.end);
  if (out.slice(0, plan.start) !== body.slice(0, plan.start) || out.slice(plan.start + newSrc.length) !== body.slice(plan.end)) fail('body_edit_not_isolated');
  return out;
}

/** Summary of what differs between two bodies (for dry runs / reports). */
export function diffSummary(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { equal: a === b, lengthBefore: a.length, lengthAfter: b.length, changedAt: p, removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s), prefixBytesKept: p, suffixBytesKept: s };
}

/** Which body is live, and is there an unrelated pending change? */
export function articleState(article) {
  const pub = article?.current_published_content_html ?? '';
  const draft = article?.current_draft_content_html ?? '';
  const published = !!article?.is_published;
  const review = article?.approval_info?.status;
  const pendingDraft = published && !!draft && draft !== pub;
  const pendingReview = review === 'needs_review' || review === 'changes_requested';
  return { published, body: published ? pub : draft, pendingDraft, pendingReview, reviewStatus: review || null };
}

// ------------------------------------------------------------------ real clients (injected fetchers)
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3';
/** fetchAuthorized(url, init) adds the Drive OAuth bearer (tools/gdrive.mjs googleDriveAuthorizedFetch). */
export function createDriveClient({ fetchAuthorized }) {
  const json = async (url, init, what) => {
    const r = await fetchAuthorized(url, init);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new PublishError('drive_http_error', `${what}: HTTP ${r.status} ${d.error?.message || ''}`.trim());
    return d;
  };
  const id = (x) => encodeURIComponent(x);
  return {
    getFile: (fileId) => json(`${DRIVE}/files/${id(fileId)}?supportsAllDrives=true&fields=id,name,parents,mimeType,md5Checksum,size,headRevisionId,trashed,modifiedTime,webViewLink`, {}, 'file get'),
    async listPermissions(fileId) {
      const d = await json(`${DRIVE}/files/${id(fileId)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,domain,allowFileDiscovery,deleted)`, {}, 'permissions list');
      return d.permissions || [];
    },
    getRevision: (fileId, revId) => json(`${DRIVE}/files/${id(fileId)}/revisions/${id(revId)}?fields=id,keepForever,md5Checksum,size,modifiedTime`, {}, 'revision get'),
    setKeepForever: (fileId, revId, keep = true) => json(`${DRIVE}/files/${id(fileId)}/revisions/${id(revId)}?fields=id,keepForever`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepForever: keep }) }, 'revision keepForever'),
    /** files.update media upload: content only, no metadata, no permission calls. */
    uploadContent: (fileId, filePath, mime = 'video/mp4') => json(`${DRIVE_UP}/files/${id(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,md5Checksum,headRevisionId,size`, { method: 'PATCH', headers: { 'Content-Type': mime }, body: fs.readFileSync(filePath) }, 'content upload'),
    async downloadRevision(fileId, revId, dest) {
      const r = await fetchAuthorized(`${DRIVE}/files/${id(fileId)}/revisions/${id(revId)}?alt=media`, {});
      if (!r.ok) throw new PublishError('drive_http_error', `revision download: HTTP ${r.status}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(`${dest}.part`, Buffer.from(await r.arrayBuffer())); fs.renameSync(`${dest}.part`, dest);
      return dest;
    },
    viewUrl: (fileId) => `https://drive.google.com/file/d/${fileId}/view?usp=sharing`,
  };
}

/** pylon = {getArticle(id), uploadAttachment(path, description) -> {url}, updateBody(id, {bodyHtml, publish}), articleUrl(article)} */
export function createPylonClient({ getArticle, uploadAttachment, updateBody, articleUrl }) {
  return { getArticle, uploadAttachment, updateBody, articleUrl };
}

/** library = {get(name) -> script|null, put(script) -> any}; local = {read(name) -> script|null, write(name, script)} */
export function createLibraryClient({ get, put }) { return { get, put }; }

// ------------------------------------------------------------------ helpers
const permKey = (perms) => canon((perms || []).filter((p) => !p.deleted).map((p) => ({ id: p.id, type: p.type, role: p.role, email: p.emailAddress || null, domain: p.domain || null, discover: p.allowFileDiscovery ?? null })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
const stepsWithoutIds = (steps) => (steps || []).map(({ id, ...rest }) => rest);
const sameBody = (readBack, expected, prev, oldSrc, newSrc) => {
  if (readBack === expected) return true;
  // Pylon may re-serialise '&' in attributes; accept only if swapping the src back gives the previous body.
  const [r, o, n, p] = [readBack, oldSrc, newSrc, prev].map(unAmp);
  if (r === unAmp(expected)) return true;
  return !!o && !!n && r.includes(n) && !r.includes(o) && r.split(n).join(o) === p;
};

/**
 * Read-only preflight for every destination. Throws PublishError (nothing written) on any block.
 * ctx: {name, driveFileId, pylonArticleId, candidatePath, candidateScript, identifiedBase, baselineMd5?}
 */
export async function preflight(ctx, { drive, pylon, library, local }, journal = null) {
  const out = {};
  if (!ctx.driveFileId) fail('missing_drive_file_id', 'the script has no driveVideoId; drift updates never create a new Drive file');
  if (!fs.existsSync(ctx.candidatePath)) fail('missing_candidate', ctx.candidatePath);
  const candidateMd5 = md5File(ctx.candidatePath);
  const f = await drive.getFile(ctx.driveFileId);
  if (!f || f.id !== ctx.driveFileId) fail('drive_file_not_found', ctx.driveFileId);
  if (f.trashed) fail('drive_file_trashed', ctx.driveFileId);
  const done = journal?.get('drive')?.done && f.md5Checksum === candidateMd5;
  if (!done && ctx.baselineMd5 && f.md5Checksum !== ctx.baselineMd5 && f.md5Checksum !== candidateMd5) {
    fail('drive_content_changed_since_baseline', { drive: f.md5Checksum, baseline: ctx.baselineMd5 });
  }
  out.drive = { file: f, permissions: await drive.listPermissions(ctx.driveFileId), candidateMd5, alreadyApplied: !!done };

  if (ctx.pylonArticleId) {
    const a = await pylon.getArticle(ctx.pylonArticleId);
    if (!a || a.id !== ctx.pylonArticleId) fail('pylon_article_not_found', ctx.pylonArticleId);
    const st = articleState(a);
    const j = journal?.get('pylon');
    const already = !!(j?.newBody && sameBody(st.body, j.newBody, j.prevBody, j.oldSrc, j.newSrc));
    if (!already) {
      if (st.pendingDraft) fail('pylon_pending_draft', 'the published article has an unpublished draft with other edits; publish or discard it first');
      if (st.pendingReview) fail('pylon_pending_review', `the article is in review (${st.reviewStatus})`);
    }
    const plan = already ? null : planVideoReplacement(st.body, { driveFileId: ctx.driveFileId });
    out.pylon = { article: a, state: st, plan, alreadyApplied: already };
  } else out.pylon = { skipped: 'no_pylon_article' };

  const lib = await library.get(ctx.name);
  const appliedHere = lib?.driftUpdate?.jobId && lib.driftUpdate.jobId === ctx.jobId;
  if (lib && !appliedHere && canon(stepsWithoutIds(lib.steps)) !== canon(stepsWithoutIds(ctx.identifiedBase.steps))) {
    fail('script_changed_since_detection', 'the shared script\'s steps changed after the drift check; re-run the check');
  }
  for (const k of new Set([...Object.keys(ctx.identifiedBase), ...Object.keys(ctx.candidateScript)])) {
    if (k === 'steps' || k === 'recording') continue;
    if (canon(ctx.identifiedBase[k]) !== canon(ctx.candidateScript[k])) fail('candidate_changes_unexpected_fields', k);
  }
  out.library = { script: lib, local: local?.read ? local.read(ctx.name) : null, alreadyApplied: !!appliedHere };
  return out;
}

// ------------------------------------------------------------------ steps
async function driveReplace(ctx, pf, { drive }, journal) {
  const fileId = ctx.driveFileId;
  const { file: before, permissions: permsBefore, candidateMd5 } = pf.drive;
  let j = journal.get('drive') || {};
  if (before.md5Checksum === candidateMd5) {
    // Crash after the upload: the read-back below (against the journal's before-state) decides.
    if (!j.prevRevisionId || !j.intent) fail('drive_already_has_candidate_without_journal', 'cannot record a previous revision for rollback');
    journal.merge('drive', { uploaded: true, resumed: true });
  } else {
    j = journal.merge('drive', { fileId, prevRevisionId: before.headRevisionId, prevMd5: before.md5Checksum, prevSize: before.size, name: before.name, parents: before.parents, permissions: permKey(permsBefore), newMd5: candidateMd5, intent: 'upload', done: false });
    await drive.setKeepForever(fileId, before.headRevisionId, true);
    const rev = await drive.getRevision(fileId, before.headRevisionId);
    if (!rev?.keepForever) fail('drive_keep_forever_not_set', before.headRevisionId);
    journal.merge('drive', { keptForever: true });
    const up = await drive.uploadContent(fileId, ctx.candidatePath, 'video/mp4');
    j = journal.merge('drive', { uploaded: true, uploadedRevisionId: up?.headRevisionId || null });
  }
  const after = await drive.getFile(fileId);
  const permsAfter = await drive.listPermissions(fileId);
  const problems = [];
  if (after.id !== fileId) problems.push('id_changed');
  if (after.name !== j.name) problems.push('name_changed');
  if (canon(after.parents) !== canon(j.parents)) problems.push('parents_changed');
  if (after.md5Checksum !== candidateMd5) problems.push(`md5 ${after.md5Checksum} != candidate ${candidateMd5}`);
  if (after.headRevisionId === j.prevRevisionId) problems.push('head_revision_unchanged');
  if (permKey(permsAfter) !== j.permissions) problems.push('permissions_changed');
  const prev = await drive.getRevision(fileId, j.prevRevisionId);
  if (!prev?.keepForever) problems.push('previous_revision_not_kept');
  if (problems.length) fail('drive_readback_failed', problems.join(', '));
  return journal.merge('drive', { done: true, newRevisionId: after.headRevisionId, verifiedAt: new Date().toISOString(), url: drive.viewUrl(fileId) });
}

async function pylonReplace(ctx, pf, { pylon }, journal) {
  if (pf.pylon.skipped) return journal.set('pylon', { skipped: pf.pylon.skipped, done: true });
  if (pf.pylon.alreadyApplied) return journal.merge('pylon', { done: true, resumed: true });
  const { article, state, plan } = pf.pylon;
  if (plan.mode === 'drive_link') {
    // Same Drive id after the replace: the article's link already shows the new video. Nothing to PATCH.
    return journal.set('pylon', { articleId: article.id, mode: 'drive_link', done: true, changed: false, url: pylon.articleUrl(article) });
  }
  let j = journal.get('pylon') || {};
  let newUrl = j.attachmentUrl;
  if (!newUrl) {
    const att = await pylon.uploadAttachment(ctx.candidatePath, ctx.title || ctx.name);
    if (!att?.url) fail('pylon_attachment_failed', 'no url returned');
    newUrl = journal.merge('pylon', { attachmentUrl: att.url }).attachmentUrl;
  }
  const newBody = applyVideoReplacement(state.body, plan, newUrl);
  const newSrc = escAttr(newUrl, plan.oldSrc);
  if (newBody.split(newSrc).join(plan.oldSrc) !== state.body || newBody === state.body) fail('body_edit_not_isolated');
  journal.merge('pylon', { articleId: article.id, wasPublished: state.published, prevBody: state.body, newBody, oldSrc: plan.oldSrc, newSrc, mode: 'video_src', intent: 'patch', done: false });
  await pylon.updateBody(article.id, { bodyHtml: newBody, publish: state.published });
  journal.merge('pylon', { patched: true });
  const rb = articleState(await pylon.getArticle(article.id));
  const problems = [];
  if (rb.published !== state.published) problems.push(`published flag changed (${state.published} -> ${rb.published})`);
  if (!sameBody(rb.body, newBody, state.body, plan.oldSrc, newSrc)) problems.push('body read-back differs from the expected video-only edit');
  if (state.published && rb.pendingDraft) problems.push('edit left a pending draft instead of publishing');
  if (problems.length) fail('pylon_readback_failed', problems.join(', '));
  return journal.merge('pylon', { done: true, changed: true, verifiedAt: new Date().toISOString(), url: pylon.articleUrl(article) });
}

async function libraryUpdate(ctx, pf, { library, local, recordings }, journal) {
  if (pf.library.alreadyApplied) return journal.merge('library', { done: true, resumed: true });
  const prev = await library.get(ctx.name);
  if (canon(prev) !== canon(pf.library.script)) fail('script_changed_during_publish', 'the shared script changed while publishing');
  const dir = path.dirname(journal.file);
  const prevLibFile = path.join(dir, 'prev-library-script.json');
  const prevLocalFile = path.join(dir, 'prev-local-script.json');
  if (!fs.existsSync(prevLibFile)) fs.writeFileSync(prevLibFile, JSON.stringify(prev, null, 2) + '\n', { mode: 0o600 });
  if (pf.library.local && !fs.existsSync(prevLocalFile)) fs.writeFileSync(prevLocalFile, JSON.stringify(pf.library.local, null, 2) + '\n', { mode: 0o600 });
  const base = prev || pf.library.local || ctx.identifiedBase;
  const next = { ...base, steps: ctx.candidateScript.steps, recording: ctx.candidateScript.recording,
    driftUpdate: { jobId: ctx.jobId, publishedAt: new Date().toISOString(), previousRecordingId: base?.recording?.id ?? null, candidateSha256: ctx.candidateSha256 || null } };
  journal.merge('library', { name: ctx.name, prevLibFile, prevLocalFile: pf.library.local ? prevLocalFile : null, hadLibrary: !!prev, intent: 'put', done: false });
  // New captures first (additive): the shared script must never reference screenshots nobody can fetch.
  if (recordings && ctx.candidateRecordingsDir && next.recording?.id && next.recording.id !== base?.recording?.id) {
    await recordings.publish(next.recording.id, ctx.candidateRecordingsDir);
    journal.merge('library', { recordingsPublished: next.recording.id });
  }
  if (prev) {
    await library.put(next);
    const rb = await library.get(ctx.name);
    if (canon(rb?.steps) !== canon(next.steps) || rb?.driftUpdate?.jobId !== ctx.jobId) fail('library_readback_failed');
  }
  if (local?.write && pf.library.local) local.write(ctx.name, { ...pf.library.local, steps: next.steps, recording: next.recording, driftUpdate: next.driftUpdate });
  return journal.merge('library', { done: true, libraryUpdated: !!prev, localUpdated: !!pf.library.local, verifiedAt: new Date().toISOString() });
}

/**
 * Publish. ctx: {jobId, name, title, driveFileId, pylonArticleId, candidatePath, candidateSha256,
 *   candidateScript, identifiedBase, candidateRecordingsDir, baselineMd5}
 * deps: {drive, pylon, library, local?, recordings?, log?}
 * Returns {drive, pylon, library, links, rollbackFile}. Throws PublishError with {stage, applied, rollback}.
 */
export async function publishCandidate(ctx, deps, journal) {
  const log = deps.log || (() => {});
  if (journal.get('jobId') !== ctx.jobId) journal.set('jobId', ctx.jobId);
  let pf;
  try { pf = await preflight(ctx, deps, journal); }
  catch (e) { throw Object.assign(e instanceof PublishError ? e : new PublishError('preflight_failed', String(e?.message || e)), { stage: 'preflight', applied: [], rollback: null }); }
  journal.set('preflight', { at: new Date().toISOString(), driveMd5: pf.drive.file.md5Checksum, pylon: pf.pylon.skipped ? 'skipped' : { published: pf.pylon.state.published, mode: pf.pylon.plan?.mode || 'already' } });
  const stages = [['drive', driveReplace], ['pylon', pylonReplace], ['library', libraryUpdate]];
  for (const [stage, fn] of stages) {
    try { log(`[drift-publish] ${ctx.name}: ${stage}`); await fn(ctx, pf, deps, journal); }
    catch (e) {
      const err = e instanceof PublishError ? e : new PublishError(`${stage}_failed`, String(e?.message || e));
      const applied = appliedSteps(journal);
      log(`[drift-publish] ${ctx.name}: ${stage} failed (${err.message}); rolling back ${applied.join(', ') || 'nothing'}`);
      const rollback = applied.length ? await rollbackPublish(journal, deps, { reason: `auto: ${stage} failed` }) : null;
      throw Object.assign(err, { stage, applied, rollback });
    }
  }
  const rollbackFile = path.join(path.dirname(journal.file), 'rollback.json');
  fs.writeFileSync(rollbackFile, JSON.stringify(rollbackInstructions(journal.state), null, 2) + '\n');
  journal.set('published', { at: new Date().toISOString(), rollbackFile });
  const s = journal.state;
  return { drive: s.drive, pylon: s.pylon, library: s.library, rollbackFile, links: { drive: s.drive?.url || null, pylon: s.pylon?.url || null } };
}

/** Steps whose remote write may have happened (intent recorded; rollback re-checks the real state). */
export function appliedSteps(journal) {
  const s = journal.state;
  return [s.drive?.intent && !s.drive.rolledBack && 'drive',
    s.pylon?.intent && s.pylon.mode === 'video_src' && !s.pylon.rolledBack && 'pylon',
    s.library?.intent && !s.library.rolledBack && 'library'].filter(Boolean);
}

export function rollbackInstructions(s) {
  const lines = [];
  if (s.library?.intent) lines.push(`Shared script "${s.library.name}": restore ${s.library.prevLibFile}${s.library.prevLocalFile ? ` (+ local copy ${s.library.prevLocalFile})` : ''}.`);
  if (s.pylon?.mode === 'video_src') lines.push(`Pylon article ${s.pylon.articleId}: PATCH body_html back to the saved previous body${s.pylon.wasPublished ? ' with publish_updated_body_html:true' : ' (draft)'} (old video src ${s.pylon.oldSrc}).`);
  if (s.drive?.prevRevisionId) lines.push(`Drive file ${s.drive.fileId}: re-upload kept-forever revision ${s.drive.prevRevisionId} (md5 ${s.drive.prevMd5}) as the file's content (same id).`);
  return { oneClick: 'Studio → Updates → Undo update (bridge POST http://127.0.0.1:8787/drift/jobs/<job id>/rollback on the machine that published)', steps: lines, drive: s.drive || null, pylon: s.pylon ? { ...s.pylon, prevBody: undefined, newBody: undefined } : null, library: s.library || null };
}

/**
 * Restore everything this job changed: library, then Pylon, then Drive. Each step first checks that
 * the destination still holds what we published; if someone changed it since, that step is skipped as
 * a conflict (never clobbered). Returns {ok, steps:{drive,pylon,library}}.
 */
export async function rollbackPublish(journal, { drive, pylon, library, local, log = () => {} }, { reason = 'manual' } = {}) {
  const s = journal.state;
  const res = {};
  if (s.library?.intent && !s.library.rolledBack) {
    try {
      const prevLib = s.library.hadLibrary ? JSON.parse(fs.readFileSync(s.library.prevLibFile, 'utf8')) : null;
      const cur = s.library.hadLibrary ? await library.get(s.library.name) : null;
      if (prevLib && cur && cur.driftUpdate?.jobId !== s.jobId && canon(cur) !== canon(prevLib)) res.library = { ok: false, conflict: 'shared script changed after the update; not overwritten' };
      else {
        if (prevLib && canon(cur) !== canon(prevLib)) {
          await library.put(prevLib);
          const rb = await library.get(s.library.name);
          if (canon(rb?.steps) !== canon(prevLib.steps)) throw new Error('library read-back differs from the previous revision');
        }
        if (s.library.prevLocalFile && local?.write) local.write(s.library.name, JSON.parse(fs.readFileSync(s.library.prevLocalFile, 'utf8')));
        res.library = { ok: true };
        journal.merge('library', { rolledBack: new Date().toISOString() });
      }
    } catch (e) { res.library = { ok: false, error: String(e?.message || e) }; }
  }
  if (s.pylon?.intent && s.pylon.mode === 'video_src' && !s.pylon.rolledBack) {
    try {
      const st = articleState(await pylon.getArticle(s.pylon.articleId));
      if (sameBody(st.body, s.pylon.prevBody, s.pylon.newBody, s.pylon.newSrc, s.pylon.oldSrc)) res.pylon = { ok: true, note: 'already the previous body' };
      else if (!sameBody(st.body, s.pylon.newBody, s.pylon.prevBody, s.pylon.oldSrc, s.pylon.newSrc)) res.pylon = { ok: false, conflict: 'article body changed after the update; not overwritten' };
      else if (s.pylon.wasPublished && st.pendingDraft) res.pylon = { ok: false, conflict: 'article has a pending draft now; not overwritten' };
      else {
        await pylon.updateBody(s.pylon.articleId, { bodyHtml: s.pylon.prevBody, publish: s.pylon.wasPublished });
        const rb = articleState(await pylon.getArticle(s.pylon.articleId));
        if (!sameBody(rb.body, s.pylon.prevBody, s.pylon.newBody, s.pylon.newSrc, s.pylon.oldSrc)) throw new Error('article read-back differs from the previous body');
        res.pylon = { ok: true };
      }
      if (res.pylon.ok) journal.merge('pylon', { rolledBack: new Date().toISOString() });
    } catch (e) { res.pylon = { ok: false, error: String(e?.message || e) }; }
  }
  if (s.drive?.intent && s.drive.prevRevisionId && !s.drive.rolledBack) {
    try {
      const f = await drive.getFile(s.drive.fileId);
      if (f.md5Checksum === s.drive.prevMd5) res.drive = { ok: true, note: 'already the previous content' };
      else if (f.md5Checksum !== s.drive.newMd5) res.drive = { ok: false, conflict: `Drive file content changed after the update (md5 ${f.md5Checksum}); not overwritten` };
      else {
        const tmp = path.join(path.dirname(journal.file), `restore-${s.drive.prevRevisionId}.mp4`);
        await drive.downloadRevision(s.drive.fileId, s.drive.prevRevisionId, tmp);
        if (md5File(tmp) !== s.drive.prevMd5) throw new Error('downloaded previous revision md5 mismatch');
        await drive.uploadContent(s.drive.fileId, tmp, 'video/mp4');
        const rb = await drive.getFile(s.drive.fileId);
        const perms = permKey(await drive.listPermissions(s.drive.fileId));
        if (rb.md5Checksum !== s.drive.prevMd5) throw new Error(`read-back md5 ${rb.md5Checksum} != previous ${s.drive.prevMd5}`);
        if (rb.id !== s.drive.fileId || rb.name !== s.drive.name) throw new Error('file id/name changed');
        if (perms !== s.drive.permissions) throw new Error('permissions differ from before the update');
        fs.rmSync(tmp, { force: true });
        res.drive = { ok: true, restoredRevisionId: s.drive.prevRevisionId };
      }
      if (res.drive.ok) journal.merge('drive', { rolledBack: new Date().toISOString() });
    } catch (e) { res.drive = { ok: false, error: String(e?.message || e) }; }
  }
  const ok = Object.values(res).every((r) => r.ok);
  journal.set('rollback', { at: new Date().toISOString(), reason, ok, steps: res });
  log(`[drift-publish] rollback (${reason}): ${JSON.stringify(res)}`);
  return { ok, steps: res };
}
