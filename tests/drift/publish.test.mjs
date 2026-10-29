import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planVideoReplacement, applyVideoReplacement, diffSummary, articleState, openJournal, publishCandidate, rollbackPublish, PublishError, md5File,
} from '../../tools/drift/publish.mjs';
import { fakeDrive, fakePylon, fakeLibrary, scripts, ARTICLE_BODY } from './publish-fakes.mjs';

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'drift-publish-'));

function setup(over = {}) {
  const dir = tmp();
  const candidatePath = path.join(dir, 'candidate.mp4');
  fs.writeFileSync(candidatePath, 'candidate-video-bytes');
  const recDir = path.join(dir, 'rec'); fs.mkdirSync(recDir);
  const { base, cand } = scripts();
  const drive = fakeDrive(over.drive);
  const pylon = fakePylon(over.pylon);
  const lib = fakeLibrary({ [base.name]: over.libraryScript || base }, over.library);
  const ctx = { jobId: '11111111-1111-4111-8111-111111111111', name: base.name, title: base.title, driveFileId: 'FILE1', pylonArticleId: over.noArticle ? null : 'ART1',
    candidatePath, candidateSha256: 'x', candidateScript: cand, identifiedBase: base, candidateRecordingsDir: recDir, baselineMd5: drive.md5(Buffer.from('baseline-video')), ...over.ctx };
  const deps = { drive, pylon, library: lib.library, local: lib.local, recordings: lib.recordings };
  const journal = openJournal(path.join(dir, 'journal.json'));
  return { dir, ctx, deps, drive, pylon, lib, journal, base, cand };
}

// ------------------------------------------------------------------ body edit
test('video replacement changes only the src bytes; diff summary shows nothing else', () => {
  const plan = planVideoReplacement(ARTICLE_BODY, { driveFileId: 'FILE1' });
  assert.equal(plan.mode, 'video_src');
  assert.equal(plan.oldSrc, 'https://assets.usepylon.com/old%20video.mp4');
  const out = applyVideoReplacement(ARTICLE_BODY, plan, 'https://assets.usepylon.com/new.mp4?a=1&b=2');
  const d = diffSummary(ARTICLE_BODY, out);
  assert.equal(d.removed, 'old%20video.mp4'); assert.equal(d.added, 'new.mp4?a=1&b=2');
  assert.equal(out.split('https://assets.usepylon.com/new.mp4?a=1&b=2').join(plan.oldSrc), ARTICLE_BODY);
  const amp = '<video src="https://a/x.mp4?p=1&amp;q=2"></video>';
  assert.match(applyVideoReplacement(amp, planVideoReplacement(amp), 'https://a/y.mp4?p=3&q=4'), /y\.mp4\?p=3&amp;q=4/);
});
test('video replacement follows the article\'s raw-& convention (Pylon signed CDN URLs) and never breaks the attribute', () => {
  const body = '<video src="https://assets.usepylon.com/a.mp4?Expires=1&Signature=x~y&Key-Pair-Id=K" class="kb-video"></video><p>x &amp; y</p>';
  const plan = planVideoReplacement(body);
  const out = applyVideoReplacement(body, plan, 'https://assets.usepylon.com/b.mp4?Expires=2&Signature="z"');
  assert.equal(diffSummary(body, out).added.includes('&amp;'), false);
  assert.match(out, /src="https:\/\/assets\.usepylon\.com\/b\.mp4\?Expires=2&Signature=%22z%22"/);
  assert.ok(out.endsWith('<p>x &amp; y</p>'));
});
test('video replacement: drive-link-only articles need no edit; 0 or 2+ videos block', () => {
  assert.equal(planVideoReplacement('<p><a href="https://drive.google.com/file/d/FILE1/view">v</a></p>', { driveFileId: 'FILE1' }).mode, 'drive_link');
  assert.throws(() => planVideoReplacement('<p>text only</p>', { driveFileId: 'FILE1' }), (e) => e.code === 'no_video_embed');
  assert.throws(() => planVideoReplacement('<video src="a"></video><video src="b"></video>'), (e) => e.code === 'ambiguous_video_embed');
  assert.throws(() => planVideoReplacement('<video controls><source src="a"></video>'), (e) => e.code === 'unsupported_video_markup');
  assert.equal(planVideoReplacement("<video class='x' src='https://a/b.mp4'></video>").oldSrc, 'https://a/b.mp4');
});
test('article state: pending draft only when a published article has a different draft', () => {
  assert.equal(articleState({ is_published: true, current_published_content_html: 'a', current_draft_content_html: 'a' }).pendingDraft, false);
  assert.equal(articleState({ is_published: true, current_published_content_html: 'a', current_draft_content_html: 'b' }).pendingDraft, true);
  assert.equal(articleState({ is_published: false, current_published_content_html: '', current_draft_content_html: 'b' }).body, 'b');
  assert.equal(articleState({ is_published: true, current_published_content_html: 'a', current_draft_content_html: 'a', approval_info: { status: 'needs_review' } }).pendingReview, true);
});

// ------------------------------------------------------------------ happy path + rollback
test('publish: same Drive id (prev revision kept, perms untouched), same Pylon article published (video only), library after both; rollback restores all', async () => {
  const s = setup();
  const res = await publishCandidate(s.ctx, s.deps, s.journal);
  assert.equal(s.drive.file.id, 'FILE1');
  assert.equal(s.drive.head().content.toString(), 'candidate-video-bytes');
  assert.equal(s.drive.file.revisions[0].keepForever, true);
  assert.ok(!s.drive.calls.some((c) => /perm/i.test(c) && c !== 'listPermissions'), 'no permission writes');
  assert.equal(s.pylon.patches.length, 1); assert.equal(s.pylon.patches[0].publish, true);
  const d = diffSummary(ARTICLE_BODY, s.pylon.article.current_published_content_html);
  assert.equal(d.removed, 'old%20video.mp4'); assert.match(d.added, /^new-1\.mp4/);
  assert.equal(s.pylon.article.current_draft_content_html, s.pylon.article.current_published_content_html, 'no pending draft left');
  const lib = s.lib.lib.get(s.base.name);
  assert.equal(lib.driftUpdate.jobId, s.ctx.jobId); assert.equal(lib.steps[2].narration, 'A new line 3.');
  assert.equal(lib.driveVideoId, 'FILE1'); assert.equal(lib.pylonArticleId, 'ART1'); assert.equal(lib.recording.id, 'drift-rec-2');
  assert.deepEqual(s.lib.recordings.published.map((r) => r.id), ['drift-rec-2']);
  const order = [...s.drive.calls.map((c) => `d:${c}`)];
  assert.ok(order.includes('d:uploadContent'));
  assert.ok(fs.existsSync(res.rollbackFile));
  assert.deepEqual(Object.keys(res.links), ['drive', 'pylon']);

  const rb = await rollbackPublish(s.journal, s.deps, { reason: 'manual test' });
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
  assert.equal(s.drive.file.id, 'FILE1');
  assert.equal(s.pylon.article.current_published_content_html, ARTICLE_BODY);
  assert.deepEqual(s.lib.lib.get(s.base.name), s.base);
  assert.deepEqual(s.lib.localMap.get(s.base.name), s.base);
});
test('publish: draft-only article stays a draft (no publish flag, never is_published:false)', async () => {
  const s = setup({ pylon: { published: false } });
  await publishCandidate(s.ctx, s.deps, s.journal);
  assert.equal(s.pylon.patches[0].publish, false);
  assert.equal(s.pylon.article.is_published, false);
  assert.match(s.pylon.article.current_draft_content_html, /new-1\.mp4/);
});

// ------------------------------------------------------------------ failure points
test('blocks on a pending draft before ANY write', async () => {
  const s = setup({ pylon: { draft: ARTICLE_BODY + '<p>someone else is editing</p>' } });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.code === 'pylon_pending_draft' && e.stage === 'preflight' && e.applied.length === 0);
  assert.equal(s.drive.file.revisions.length, 1); assert.ok(!s.drive.calls.includes('setKeepForever'));
  assert.equal(s.pylon.patches.length, 0); assert.ok(!s.lib.calls.includes('put'));
});
test('blocks when Drive no longer holds the baseline (someone re-rendered)', async () => {
  const s = setup({ ctx: { baselineMd5: 'something-else' } });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.code === 'drive_content_changed_since_baseline');
  assert.equal(s.drive.file.revisions.length, 1);
});
test('blocks when the shared script changed after detection', async () => {
  const { base } = scripts();
  const changed = JSON.parse(JSON.stringify(base)); changed.steps[0].narration = 'edited by a teammate';
  const s = setup({ libraryScript: changed });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.code === 'script_changed_since_detection');
  assert.equal(s.drive.file.revisions.length, 1);
});
test('Drive upload fails -> nothing else touched, Drive left as it was', async () => {
  const s = setup({ drive: { fail: { uploadContent: true } } });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.stage === 'drive' && e.rollback?.ok === true);
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
  assert.equal(s.pylon.patches.length, 0); assert.ok(!s.lib.calls.includes('put'));
});
test('Drive read-back failure (permissions changed by the upload) -> Drive restored', async () => {
  const s = setup();
  const orig = s.drive.uploadContent.bind(s.drive);
  s.drive.uploadContent = async (...a) => { const r = await orig(...a); s.drive.file.perms.push({ id: 'anyone', type: 'anyone', role: 'reader' }); return r; };
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.code === 'drive_readback_failed' && /permissions_changed/.test(e.message));
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
});
test('Pylon fails after Drive succeeded -> Drive rolled back to the kept revision, library untouched', async () => {
  const s = setup({ pylon: { fail: { updateBody: true } } });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.stage === 'pylon' && e.applied.includes('drive') && e.rollback.ok === true && e.rollback.steps.drive.ok);
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
  assert.equal(s.drive.file.id, 'FILE1');
  assert.equal(s.pylon.article.current_published_content_html, ARTICLE_BODY);
  assert.ok(!s.lib.calls.includes('put'));
});
test('Pylon read-back mismatch (published copy unchanged) -> both rolled back', async () => {
  const s = setup();
  s.pylon.updateBody = async function (id, { bodyHtml }) { this.patches.push({ bodyHtml }); this.article.current_draft_content_html = bodyHtml; return {}; }; // "forgot" to publish
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.code === 'pylon_readback_failed');
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
});
test('library put fails after both providers -> Pylon and Drive rolled back', async () => {
  const s = setup({ library: { fail: { put: true } } });
  await assert.rejects(publishCandidate(s.ctx, s.deps, s.journal), (e) => e.stage === 'library' && e.rollback.ok === true);
  assert.equal(s.drive.head().content.toString(), 'baseline-video');
  assert.equal(s.pylon.article.current_published_content_html, ARTICLE_BODY);
  assert.deepEqual(s.lib.lib.get(s.base.name), s.base);
});

// ------------------------------------------------------------------ crash + re-run
test('crash after the Drive upload landed (no response) -> re-run reconciles by read-back, no second upload', async () => {
  const s = setup({ drive: { fail: { uploadContent: () => 'hang' } } });
  const first = publishCandidate(s.ctx, s.deps, s.journal); first.catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.drive.calls.filter((c) => c === 'uploadContent').length, 1);
  // "process restarted": fresh journal object from disk, working deps
  delete s.drive.uploadContent; s.drive.uploadContent = async () => { throw new Error('must not upload again'); };
  const j2 = openJournal(s.journal.file);
  const res = await publishCandidate(s.ctx, s.deps, j2);
  assert.equal(j2.state.drive.resumed, true);
  assert.equal(s.drive.file.revisions.length, 2);
  assert.match(s.pylon.article.current_published_content_html, /new-1\.mp4/);
  assert.equal(res.library.done, true);
});
test('crash after Pylon PATCH before journaling done -> re-run sees it applied and finishes', async () => {
  const s = setup();
  const orig = s.pylon.getArticle.bind(s.pylon);
  let patched = false;
  const origUpd = s.pylon.updateBody.bind(s.pylon);
  s.pylon.updateBody = async (...a) => { await origUpd(...a); patched = true; return new Promise(() => {}); };
  const first = publishCandidate(s.ctx, s.deps, s.journal); first.catch(() => {});
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(patched);
  s.pylon.updateBody = async () => { throw new Error('must not patch again'); };
  s.pylon.getArticle = orig;
  const j2 = openJournal(s.journal.file);
  await publishCandidate(s.ctx, s.deps, j2);
  assert.equal(j2.state.pylon.resumed, true);
  assert.equal(s.drive.calls.filter((c) => c === 'uploadContent').length, 1);
  assert.equal(s.lib.lib.get(s.base.name).driftUpdate.jobId, s.ctx.jobId);
});

// ------------------------------------------------------------------ rollback conflicts
test('rollback never clobbers later edits: article edited after publish -> conflict, others restored', async () => {
  const s = setup();
  await publishCandidate(s.ctx, s.deps, s.journal);
  s.pylon.article.current_published_content_html += '<p>later edit</p>';
  s.pylon.article.current_draft_content_html = s.pylon.article.current_published_content_html;
  const rb = await rollbackPublish(s.journal, s.deps, { reason: 'manual' });
  assert.equal(rb.ok, false); assert.match(rb.steps.pylon.conflict, /changed after the update/);
  assert.equal(rb.steps.drive.ok, true); assert.equal(rb.steps.library.ok, true);
  assert.match(s.pylon.article.current_published_content_html, /later edit/);
});
test('rollback: Drive replaced by someone else since -> conflict, not overwritten', async () => {
  const s = setup({ noArticle: true });
  await publishCandidate(s.ctx, s.deps, s.journal);
  s.drive.file.revisions.push({ id: 'r9', content: Buffer.from('someone else'), keepForever: false });
  const rb = await rollbackPublish(s.journal, s.deps, { reason: 'manual' });
  assert.equal(rb.steps.drive.ok, false); assert.equal(s.drive.head().content.toString(), 'someone else');
});
test('no Pylon article linked: Pylon skipped, Drive + library still published', async () => {
  const s = setup({ noArticle: true });
  const res = await publishCandidate(s.ctx, s.deps, s.journal);
  assert.equal(res.pylon.skipped, 'no_pylon_article'); assert.equal(res.links.pylon, null);
  assert.equal(s.drive.head().content.toString(), 'candidate-video-bytes');
});
test('PublishError carries a code', () => { assert.equal(new PublishError('x', 'y').code, 'x'); assert.ok(md5File); });
