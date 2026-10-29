// In-memory Drive / Pylon / library fakes for tests/drift/{publish,executor}.test.mjs (no network).
import fs from 'node:fs';
import crypto from 'node:crypto';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

export function fakeDrive({ fileId = 'FILE1', content = Buffer.from('baseline-video'), perms = [{ id: 'owner1', type: 'user', role: 'owner', emailAddress: 'o@x.com' }], fail = {} } = {}) {
  let rev = 1;
  const f = { id: fileId, name: 'Video.mp4', parents: ['FOLDER'], trashed: false, perms: perms.map((p) => ({ ...p })), revisions: [{ id: `r${rev}`, content, keepForever: false }] };
  const calls = [];
  const head = () => f.revisions.at(-1);
  const meta = () => ({ id: f.id, name: f.name, parents: [...f.parents], md5Checksum: md5(head().content), size: String(head().content.length), headRevisionId: head().id, trashed: f.trashed });
  const hit = async (name) => { calls.push(name); const h = fail[name]; if (typeof h === 'function') return h(calls.filter((c) => c === name).length); if (h) throw new Error(`fake ${name} failure`); };
  return {
    file: f, calls, head, md5,
    async getFile(id) { await hit('getFile'); if (id !== f.id) throw new Error('404'); return meta(); },
    async listPermissions() { await hit('listPermissions'); return f.perms.map((p) => ({ ...p })); },
    async getRevision(id, r) { await hit('getRevision'); const x = f.revisions.find((v) => v.id === r); return x ? { id: x.id, keepForever: x.keepForever, md5Checksum: md5(x.content) } : null; },
    async setKeepForever(id, r, keep) { await hit('setKeepForever'); const x = f.revisions.find((v) => v.id === r); x.keepForever = keep; return { id: r, keepForever: keep }; },
    async uploadContent(id, filePath) {
      const pre = await hit('uploadContent');
      const content = fs.readFileSync(filePath);
      f.revisions.push({ id: `r${++rev}`, content, keepForever: false });
      if (pre === 'hang') return new Promise(() => {}); // server applied it, the process "dies" before the response
      return { id, md5Checksum: md5(content), headRevisionId: `r${rev}` };
    },
    async downloadRevision(id, r, dest) { await hit('downloadRevision'); fs.writeFileSync(dest, f.revisions.find((v) => v.id === r).content); return dest; },
    viewUrl: (id) => `https://drive.google.com/file/d/${id}/view?usp=sharing`,
  };
}

export const ARTICLE_BODY = '<p>Intro &amp; context</p>\n<video src="https://assets.usepylon.com/old%20video.mp4" data-width="100%" alt="Video.mp4" title="Video.mp4" class="kb-video" controls="true" preload="metadata"></video>\n<h2>Steps</h2><p>Open <a href="https://drive.google.com/file/d/FILE1/view">the video</a>.</p>';

export function fakePylon({ id = 'ART1', body = ARTICLE_BODY, published = true, draft = null, review = null, fail = {} } = {}) {
  const a = { id, is_published: published, current_published_content_html: published ? body : '', current_draft_content_html: draft ?? body, approval_info: review ? { status: review } : null };
  const calls = [];
  let n = 0;
  const hit = async (name) => { calls.push(name); const h = fail[name]; if (typeof h === 'function') return h(calls.filter((c) => c === name).length); if (h) throw new Error(`fake ${name} failure`); };
  return {
    article: a, calls, patches: [],
    async getArticle(x) { await hit('getArticle'); if (x !== a.id) return null; return { ...a }; },
    async uploadAttachment() { const pre = await hit('uploadAttachment'); if (pre === 'hang') return new Promise(() => {}); return { url: `https://assets.usepylon.com/new-${++n}.mp4?a=1&b=2` }; },
    async updateBody(x, { bodyHtml, publish }) {
      await hit('updateBody');
      this.patches.push({ bodyHtml, publish });
      a.current_draft_content_html = bodyHtml;
      if (publish) { a.current_published_content_html = bodyHtml; }
      return { ...a };
    },
    articleUrl: (art) => `https://app.usepylon.com/kb/KB/articles/${art.id}`,
  };
}

export function fakeLibrary(initial = {}, { fail = {} } = {}) {
  const lib = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const local = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const calls = [];
  return {
    lib, localMap: local, calls,
    library: {
      async get(name) { calls.push('get'); return lib.has(name) ? JSON.parse(JSON.stringify(lib.get(name))) : null; },
      async put(script) { calls.push('put'); if (fail.put) throw new Error('fake library put failure'); lib.set(script.name, JSON.parse(JSON.stringify(script))); return { ok: true }; },
    },
    local: { read: (name) => (local.has(name) ? JSON.parse(JSON.stringify(local.get(name))) : null), write: (name, s) => { calls.push('localWrite'); local.set(name, JSON.parse(JSON.stringify(s))); } },
    recordings: { published: [], async publish(id, dir) { calls.push('recordings'); this.published.push({ id, dir }); } },
  };
}

/** Base script (stable IDs) + candidate script (step 2 new screenshot, step 3 new narration). */
export function scripts(name = 'Demo-Video') {
  const base = { name, title: 'Demo video', module: 'Platform', voice: 'el:VOICE', driveVideoId: 'FILE1', pylonArticleId: 'ART1', recording: { id: 'rec-1' },
    steps: [1, 2, 3].map((i) => ({ id: `step-${i}`, action: 'click', narration: `Line ${i}.`, media: { pre: `step_${i}.png` }, captureId: `c${i}` })) };
  const cand = JSON.parse(JSON.stringify(base));
  cand.recording = { id: 'drift-rec-2' };
  cand.steps[1].media = { pre: 'step_new.png' }; cand.steps[1].captureId = 'cnew';
  cand.steps[2].narration = 'A new line 3.';
  return { base, cand };
}
