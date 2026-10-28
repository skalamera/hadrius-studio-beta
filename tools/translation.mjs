// Hadrius Studio — translated (Spanish) renders. Pure, import-safe helpers shared by the bridge
// (tools/ai-bridge.mjs) and the unit tests (tests/spanish/). No I/O, no network, no side effects.
//
// Data model: the translation lives on the SAME script as the English, which is never overwritten:
//   script.translations.es = {
//     title, titleSourceHash,                      // Spanish title + hash of the English title it came from
//     steps: { <stepKey>: { narration, caption, sourceHash } },
//     driveVideoId, driveVideoUrl,                 // the Spanish Drive file (English keeps script.driveVideoId)
//     updatedAt,
//   }
// stepKey is the step's screenshot file (media.pre, e.g. "step_81895ed0d2e7.png"): unique per capture
// and stable across reorders/deletes, unlike the step index. sourceHash is a hash of the English
// narration (+ caption when it differs) at translation time, so an English edit marks the line stale.
//
// The side panel keeps a copy of stepKey/sourceHash/hashText (extension/sidepanel.js, "keep in sync
// with tools/translation.mjs"); tests/spanish/translation.test.mjs checks the two agree.

export const LANGUAGES = {
  es: { code: 'es', label: 'Spanish', driveSuffix: ' (Spanish)', outSuffix: '__es' },
};

/** 'es' for a supported translation language, else 'en' (English is the default and the source). */
export function normalizeLanguage(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGUAGES, l) ? l : 'en';
}

/** Small deterministic string hash (two FNV-1a 32-bit passes over UTF-16 code units), hex. Sync and
 * dependency-free so the side panel computes the identical value without SubtleCrypto. */
export function hashText(s) {
  const str = String(s ?? '');
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c; b = Math.imul(b, 0x01000193) >>> 0; b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Stable per-step key: the step's screenshot name, else its index. Works for saved scripts
 * (media.pre) and the panel's live steps (captureId -> step_<id>.png, same as toScript()). */
export function stepKey(step) {
  if (step?.captureId) return `step_${step.captureId}.png`;
  const pre = step?.media?.pre;
  if (pre) return String(pre).split('/').pop();
  return `i${step?.index ?? 0}`;
}

/** The English text a translation was made from: narration, plus the caption only when it differs. */
export function stepSource(step) {
  const narration = String(step?.narration || '').trim();
  const cap = String(step?.caption || '').trim();
  return { narration, caption: cap && cap !== narration ? cap : '' };
}

export function sourceHash(step) {
  const { narration, caption } = stepSource(step);
  return hashText(`${narration}\u241e${caption}`);
}

export function titleSource(script) {
  return String(script?.title || script?.name || '').trim();
}

/** Hash of a title for staleness. Case, hyphens and punctuation are ignored, so the slug the panel
 * shows for a loaded script ("How-to-Find-a-Project-ID") and the title the bridge saves ("How to
 * Find a Project ID") count as the same English title. */
export function titleHash(title) {
  return hashText(String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
}

/** Steps that end up in the video (same filter as the bridge / from-recording.mjs). */
export function renderableSteps(script) {
  return (script?.steps || []).filter((s) => s && s.capture !== false && (s.media?.pre || s.captureId));
}

/**
 * Where a translation stands. Per renderable step: 'ok', 'empty' (no English text to translate),
 * 'missing' (never translated) or 'stale' (English changed since). ok === nothing would render in
 * English or out of date.
 */
export function translationStatus(script, lang = 'es') {
  const tr = script?.translations?.[lang] || {};
  const tSrc = titleSource(script);
  const title = !String(tr.title || '').trim() ? 'missing' : tr.titleSourceHash !== titleHash(tSrc) ? 'stale' : 'ok';
  const steps = renderableSteps(script).map((s, n) => {
    const key = stepKey(s);
    const src = stepSource(s);
    let status;
    if (!src.narration && !src.caption) status = 'empty';
    else {
      const e = tr.steps?.[key];
      const has = e && (src.narration ? String(e.narration || '').trim() : String(e.caption || e.narration || '').trim());
      status = !has ? 'missing' : e.sourceHash !== sourceHash(s) ? 'stale' : 'ok';
    }
    return { key, index: s.index ?? n, number: n + 1, status };
  });
  const missing = steps.filter((x) => x.status === 'missing');
  const stale = steps.filter((x) => x.status === 'stale');
  return { lang, title, steps, missing, stale, ok: title === 'ok' && !missing.length && !stale.length };
}

/** Human summary of what blocks a translated render, or '' when nothing does. */
export function translationProblems(status) {
  const parts = [];
  const label = LANGUAGES[status.lang]?.label || status.lang;
  if (status.title === 'missing') parts.push('title not translated');
  if (status.title === 'stale') parts.push('title changed since translation');
  if (status.missing.length) parts.push(`step${status.missing.length > 1 ? 's' : ''} ${status.missing.map((x) => x.number).join(', ')} not translated`);
  if (status.stale.length) parts.push(`step${status.stale.length > 1 ? 's' : ''} ${status.stale.map((x) => x.number).join(', ')} changed in English since translation`);
  return parts.length ? `${label} version isn't ready: ${parts.join('; ')}. Translate or review them first.` : '';
}

/** out/<name>__es — never the English out/<name> that render.sh wipes. */
export function localizedName(name, lang) {
  const l = normalizeLanguage(lang);
  return l === 'en' ? name : `${name}${LANGUAGES[l].outSuffix}`;
}

/** Drive file title: "How to Find a Project ID (Spanish)". */
export function driveTitleFor(title, lang) {
  const l = normalizeLanguage(lang);
  return l === 'en' ? title : `${title}${LANGUAGES[l].driveSuffix}`;
}

/** Translated renders never touch Pylon (the article keeps the English video): anything but a local
 * preview becomes a plain video render. */
export function renderModeFor(mode, lang) {
  if (normalizeLanguage(lang) === 'en') return mode;
  return mode === 'preview' ? 'preview' : 'video';
}

export function allowsPylon(lang) { return normalizeLanguage(lang) === 'en'; }

/**
 * The script render.sh actually renders for a translated video: a copy with the translated
 * narration/caption/title, a language tag and its own name (so its own out/ dir, render key and
 * cache entries). Throws (with the problem list) when any line is missing or stale, so nothing is
 * ever silently rendered in English. Publish links are dropped: they belong to the English video.
 */
export function buildLocalizedScript(script, lang) {
  const l = normalizeLanguage(lang);
  if (l === 'en') return script;
  const status = translationStatus(script, l);
  if (!status.ok) throw new Error(translationProblems(status));
  const tr = script.translations[l];
  const { translations, driveVideoId, driveVideoUrl, pylonArticleId, pylonArticleUrl, ...rest } = script;
  const renderable = new Set(renderableSteps(script));
  return {
    ...rest,
    name: localizedName(script.name, l),
    title: String(tr.title).trim(),
    language: l,
    captionsFromNarration: false,
    steps: (script.steps || []).map((s) => {
      if (!renderable.has(s)) return s;
      const e = tr.steps?.[stepKey(s)] || {};
      const narration = String(e.narration || '').trim();
      return { ...s, narration, caption: String(e.caption || '').trim() || narration };
    }),
  };
}

/** What still needs the translator: { title: bool, items: [{ key, number, narration, caption }] }.
 * only = 'missing' (missing + stale, the default) or 'all'; keys narrows it to specific steps. */
export function translationRequest(script, lang = 'es', { only = 'missing', keys = null, title = undefined } = {}) {
  const st = translationStatus(script, lang);
  const want = (x) => (keys ? keys.includes(x.key) : only === 'all' ? x.status !== 'empty' : x.status === 'missing' || x.status === 'stale');
  const byKey = new Map(renderableSteps(script).map((s) => [stepKey(s), s]));
  const items = st.steps.filter(want).filter((x) => x.status !== 'empty').map((x) => ({ key: x.key, number: x.number, ...stepSource(byKey.get(x.key)) }));
  const needTitle = title !== undefined ? !!title : (only === 'all' && !keys) || (!keys && st.title !== 'ok');
  return { title: needTitle, items };
}

export function buildTranslationPrompt(script, req, lang = 'es') {
  const label = LANGUAGES[normalizeLanguage(lang)]?.label || 'Spanish';
  const t = titleSource(script);
  const input = {
    // Loaded library scripts can carry the slug as their title ("How-to-Find-a-Project-ID").
    ...(req.title ? { title: /\s/.test(t) ? t : t.replace(/[-_]+/g, ' ') } : {}),
    lines: req.items.map((x) => ({ key: x.key, narration: x.narration, ...(x.caption ? { caption: x.caption } : {}) })),
  };
  return `You are translating the voiceover and on-screen captions of a screen-recorded training video for the Hadrius compliance platform from English into ${label}.

Write natural, neutral Latin American ${label} suitable for professional training videos: friendly, clear, informal "tú" form, as a native speaker would say it aloud. Translate the meaning, not word for word, and keep each line about as long as the English (it is timed to the same screen).

The Hadrius app itself stays in English, so viewers see English on screen:
- Keep every product name, page, tab, menu, field, column, status and button label EXACTLY as written in English, and put on-screen labels in curly quotes, e.g. "Click Save" -> haz clic en “Save”; "the Projects list" -> la lista de “Projects”.
- Keep "Hadrius", acronyms (ID, CRD, FINRA, SEC, U4) and any quoted English text unchanged.
- Don't add or drop information. No em dashes. Don't wrap lines in quotes.
- Captions are short on-screen text in the same style.
${req.title ? '- The title is a video title: translate it in sentence case (e.g. "How to Find a Project ID" -> "Cómo encontrar el ID de un proyecto").\n' : ''}
Input (JSON):
${JSON.stringify(input, null, 2)}

Respond with exactly ONE JSON object and nothing else, using the same keys:
{${req.title ? '"title": "...", ' : ''}"lines": {"<key>": {"narration": "..."${req.items.some((x) => x.caption) ? ', "caption": "..." (only for lines that had a caption)' : ''}}}}`;
}

/** Pull the JSON object out of a model reply (tolerates code fences / prose around it). */
export function parseTranslationReply(raw) {
  const s = String(raw ?? '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('the model did not return a translation');
  const obj = JSON.parse(s.slice(a, b + 1));
  if (!obj || typeof obj !== 'object' || typeof obj.lines !== 'object' || !obj.lines) throw new Error('the translation reply had no lines');
  return obj;
}

/**
 * Merge a model reply into the script's existing translation (never touching English). Each entry is
 * stamped with the hash of the English it was made FROM (the request), so English edited while the
 * model was working shows up as stale rather than silently "translated".
 */
export function applyTranslation(script, lang, req, reply, now = new Date().toISOString()) {
  const l = normalizeLanguage(lang);
  const prev = script?.translations?.[l] || {};
  const next = { ...prev, steps: { ...(prev.steps || {}) } };
  const clean = (t) => String(t ?? '').replace(/\s*\u2014\s*/g, ', ').trim();
  for (const item of req.items) {
    const got = reply.lines?.[item.key];
    const narration = clean(typeof got === 'string' ? got : got?.narration);
    if (!narration && item.narration) continue; // not translated: stays missing/stale, so it's flagged
    const caption = item.caption ? clean(got?.caption) : '';
    next.steps[item.key] = { narration, ...(caption ? { caption } : {}), sourceHash: hashText(`${item.narration}\u241e${item.caption || ''}`) };
  }
  if (req.title && clean(reply.title)) {
    next.title = clean(reply.title);
    next.titleSourceHash = titleHash(titleSource(script));
  }
  next.updatedAt = now;
  return next;
}

/** Saving a script must never drop its translation or the Spanish Drive link: keep whatever the
 * saved copy has unless the incoming script carries its own (mirrors carryOverPublishLinks). */
export function carryOverTranslations(script, existing) {
  if (!existing?.translations) return script;
  if (!script.translations) { script.translations = existing.translations; return script; }
  for (const [l, prev] of Object.entries(existing.translations)) {
    const cur = script.translations[l];
    if (!cur) { script.translations[l] = prev; continue; }
    for (const f of ['driveVideoId', 'driveVideoUrl']) if (cur[f] === undefined && prev?.[f] !== undefined) cur[f] = prev[f];
  }
  return script;
}
