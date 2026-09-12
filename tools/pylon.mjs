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
};
/** The right sub-collection for a workflow's module, or the "Hadrius Studio" parent if unknown. */
export function pylonCollectionForModule(module) {
  return PYLON_MODULE_COLLECTIONS[String(module || '').trim().toLowerCase()] || PYLON_COLLECTION_ID;
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

export async function pylonCreateArticle({ title, bodyHtml, isPublished = false, collectionId = PYLON_COLLECTION_ID, authorUserId = PYLON_AUTHOR_USER_ID }) {
  const out = await pylonFetch(`/knowledge-bases/${PYLON_KNOWLEDGE_BASE_ID}/articles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body_html: bodyHtml, collection_id: collectionId, author_user_id: authorUserId, is_published: isPublished }),
  });
  return out.data; // article object, includes id/slug
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
  'Account Surveillance': '973aa1d0-4caf-4893-b822-d92d3995eb71'
});

export function pylonArticleUrl(article) {
  return article.url || (article.id ? `https://app.usepylon.com/kb/${PYLON_KNOWLEDGE_BASE_ID}/articles/${article.id}` : '');
}
