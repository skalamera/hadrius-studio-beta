// Hadrius Studio — thin client for Pylon's REST API (https://docs.usepylon.com), used to publish a
// rendered walkthrough as a knowledge base article: upload the video + a few slide screenshots as
// attachments (POST /attachments returns a hosted url), then create the article referencing those
// urls in its body_html (POST /knowledge-bases/{id}/articles). Bearer-token auth, same .env pattern
// as GEMINI_API_KEY/STUDIO_SHARED_SECRET — see tools/ai-bridge.mjs's loadDotEnv().
import fs from 'node:fs';
import path from 'node:path';

const PYLON_BASE = 'https://api.usepylon.com';

// "Hadrius Studio" collection inside the "Hadrius Help Center" knowledge base — created for exactly
// this purpose ("Videos and knowledge articles generated from the Hadrius Studio Chrome Extension"),
// internal_only visibility so nothing reaches customers without a human reviewing and publishing it
// first. Override via env if these ever change or a second destination is needed.
export const PYLON_KNOWLEDGE_BASE_ID = process.env.PYLON_KB_ID || '01dbe3ef-3f4e-46d5-ba0f-0cde759181ec';
export const PYLON_COLLECTION_ID = process.env.PYLON_COLLECTION_ID || '27c811bc-d80c-4cea-a093-99a497541a89';
export const PYLON_OTHER_COLLECTION_ID = '4bb77da6-c839-49b6-917a-85714c1f2446';
// stephen@hadrius.com — the only real operator of Studio today; override via env if that changes.
export const PYLON_AUTHOR_USER_ID = process.env.PYLON_AUTHOR_USER_ID || '43712c62-4d4c-4869-9fc2-cfec07320d9d';

// One sub-collection per coverage module (tools/coverage-scan.mjs's ALLOWED_MODULES), all children
// of PYLON_COLLECTION_ID — created by hand in Pylon to keep "Hadrius Studio" from becoming one flat
// list. Keyed lowercase; pylonCollectionForModule() below does the case-insensitive lookup.
const PYLON_MODULE_COLLECTIONS = {
  'testing program': 'a3e2b13e-ed88-47dd-8bb5-f11bfd763f35',
  'people oversight': '861d2937-a685-4200-881f-b9985012f7d1',
  'branches': 'ffcfda19-1492-4824-8c18-9ab130392418',
  'communications': '1ce37e6f-f0aa-407a-abca-d01d1acb752c',
  'marketing': '2fc02445-6485-4a26-8367-70cbfe9649b5',
  'account surveillance': '973aa1d0-4caf-4893-b822-d92d3995eb71',
  'other': PYLON_OTHER_COLLECTION_ID,
};
/** The right sub-collection for a workflow's module, or the "Other" collection if unknown. */
export function pylonCollectionForModule(module) {
  const m = String(module || '').trim().toLowerCase();
  return PYLON_MODULE_COLLECTIONS[m] || PYLON_OTHER_COLLECTION_ID;
}

let pylonState = { connected: null, checkedAt: 0, detail: null };
export async function checkPylon({ maxAgeMs = 60000 } = {}) {
  if (Date.now() - pylonState.checkedAt < maxAgeMs && pylonState.connected !== null) return pylonState;
  const t = (process.env.PYLON_API_TOKEN || '').trim();
  if (!t) {
    pylonState = { connected: false, checkedAt: Date.now(), detail: 'PYLON_API_TOKEN is not set in .env' };
    return pylonState;
  }
  const kbId = process.env.PYLON_KB_ID || '01dbe3ef-3f4e-46d5-ba0f-0cde759181ec';
  try {
    const res = await fetch(`${PYLON_BASE}/knowledge-bases/${kbId}`, {
      headers: { Authorization: `Bearer ${t}` }
    });
    if (res.ok) {
      pylonState = { connected: true, checkedAt: Date.now(), detail: null };
    } else {
      pylonState = { connected: false, checkedAt: Date.now(), detail: `Pylon API returned HTTP ${res.status}` };
    }
  } catch (e) {
    pylonState = { connected: false, checkedAt: Date.now(), detail: `Pylon connection failed: ${e.message}` };
  }
  return pylonState;
}

function token() {
  const t = (process.env.PYLON_API_TOKEN || '').trim();
  if (!t) throw new Error('PYLON_API_TOKEN is not set (add it to .env)');
  return t;
}

async function pylonFetch(pathname, opts = {}) {
  const resp = await fetch(`${PYLON_BASE}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token()}`, ...(opts.headers || {}) },
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error(data?.error || data?.message || `Pylon ${pathname} -> HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return data;
}

/** Upload a local file (video or image) and get back a hosted url usable in article body_html. */
export async function pylonUploadAttachment(filePath, description) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(filePath));
  if (description) form.append('description', description);
  const out = await pylonFetch('/attachments', { method: 'POST', body: form });
  return out.data; // { id, url, name, description }
}

// The "hadriusacademy" article tag (created in the Pylon UI — the API cannot create tags, only
// assign existing ones by id, and only via PATCH after the article exists).
const PYLON_ACADEMY_TAG_ID = 'ffc4a94e-6bf0-489b-85b5-33214bd65944';

/** Replace an article's tags. Pylon has no tag_ids on create, so this is a separate PATCH. */
export async function pylonSetArticleTags(articleId, tagIds) {
  const out = await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_ids: tagIds }),
  });
  return out.data;
}

/** Permanently delete an article — e.g. an older duplicate superseded by a re-recording. */
export async function pylonDeleteArticle(articleId) {
  await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles/${articleId}`, { method: 'DELETE' });
}

/** Rename an existing article (e.g. to strip a "-ai" collision suffix that leaked into the title). */
export async function pylonUpdateArticleTitle(articleId, title) {
  const out = await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return out.data;
}

export async function pylonCreateArticle({ title, bodyHtml, isPublished = false, collectionId = PYLON_COLLECTION_ID, authorUserId = PYLON_AUTHOR_USER_ID }) {
  const out = await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body_html: bodyHtml, collection_id: collectionId, author_user_id: authorUserId, is_published: isPublished }),
  });
  const article = out.data; // article object, includes id/slug
  // Every Studio-published article is Hadrius Academy content. Best-effort: a tagging hiccup
  // should never fail the publish itself.
  try {
    if (article?.id) await pylonSetArticleTags(article.id, [PYLON_ACADEMY_TAG_ID]);
  } catch (e) {
    console.warn(`[pylon] created "${title}" but could not apply the hadriusacademy tag: ${String(e?.message || e).slice(0, 160)}`);
  }
  return article;
}


/** List every article in the knowledge base, including drafts, and preserve collection membership. */
export async function pylonListArticles() {
  const articles = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '500', media: 'none' });
    if (cursor) query.set('cursor', cursor);
    const out = await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles?${query}`);
    articles.push(...(out?.data || []));
    cursor = out?.pagination?.has_next_page ? out.pagination.cursor : null;
  } while (cursor);
  return articles;
}

export const PYLON_MODULE_COLLECTION_MAP = Object.freeze({
  'Testing Program': 'a3e2b13e-ed88-47dd-8bb5-f11bfd763f35',
  'People Oversight': '861d2937-a685-4200-881f-b9985012f7d1',
  'Branches': 'ffcfda19-1492-4824-8c18-9ab130392418',
  'Communications': '1ce37e6f-f0aa-407a-abca-d01d1acb752c',
  'Marketing': '2fc02445-6485-4a26-8367-70cbfe9649b5',
  'Account Surveillance': '973aa1d0-4caf-4893-b822-d92d3995eb71',
  'Other': PYLON_OTHER_COLLECTION_ID
});

export function pylonArticleUrl(article) {
  return article.url || (article.id ? `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/articles/${article.id}` : '');
}
