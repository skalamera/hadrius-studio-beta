// Cost controls for weekly model reviews: a durable, input-validated answer cache and a per-run call budget.
// A cached answer is reused only when every input that could change it is identical (the key); deterministic
// verification still runs on today's evidence. Budget overflow never becomes "unchanged": callers mark the work
// pending. No network; the cache lives in the gitignored .drift-cache/ next to the frontend mirror.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, bytesDigest } from './contracts.mjs';

export const CACHE_SCHEMA = 1;
export const BUDGET_EXHAUSTED = 'review_budget_exhausted';
export const DEFAULT_REVIEW_CACHE = process.env.HADRIUS_DRIFT_REVIEW_CACHE
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.drift-cache', 'reviews');
const KEY_RE = /^[0-9a-f]{64}$/;

/** SHA-256 of a file's bytes; null when absent (an absent input never matches a cached one). */
export const fileDigest = (p) => (p && existsSync(p) ? bytesDigest(readFileSync(p)) : null);
/** Version of a reviewer = its prompt/parser source plus the model: editing either invalidates old answers. */
export const reviewerVersion = (model, ...fns) => digest({ model: model ?? null, source: fns.map((f) => String(f)) });

export function createReviewStore({ root = DEFAULT_REVIEW_CACHE } = {}) {
  const pathOf = (kind, key) => join(root, kind, `${key}.json`);
  return {
    root,
    /** A record is returned only if schema, kind and key match and `validate(answer)` does not throw. */
    get(kind, key, validate = () => {}) {
      if (!KEY_RE.test(key)) return null;
      try {
        const r = JSON.parse(readFileSync(pathOf(kind, key), 'utf8'));
        if (r?.schema !== CACHE_SCHEMA || r.kind !== kind || r.key !== key || !r.answer) return null;
        validate(r.answer);
        return r;
      } catch { return null; }
    },
    put(kind, key, record) {
      if (!KEY_RE.test(key)) throw new Error('invalid_cache_key');
      mkdirSync(join(root, kind), { recursive: true, mode: 0o700 });
      const p = pathOf(kind, key), tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ schema: CACHE_SCHEMA, kind, key, createdAt: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
      renameSync(tmp, p); // atomic: a reader sees the old file or the complete new one
    },
    /** Keep a copy of an input file (e.g. the screenshot an answer was given for) next to the record. */
    putFile(kind, key, src, ext = '.png') {
      if (!KEY_RE.test(key) || !src || !existsSync(src)) return null;
      mkdirSync(join(root, kind), { recursive: true, mode: 0o700 });
      const p = join(root, kind, `${key}${ext}`), tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      copyFileSync(src, tmp); renameSync(tmp, p);
      return p;
    },
  };
}

/** Per-run model-call allowance shared by every reviewer. maxCalls null = no cap (manual runs). */
export function createReviewBudget({ maxCalls = null } = {}) {
  if (maxCalls != null && !(Number.isInteger(maxCalls) && maxCalls >= 0)) throw new Error('invalid_max_model_calls');
  const usage = { maxCalls, calls: 0, cacheHits: 0, budgetSkipped: 0, errors: 0, costUsd: 0, byKind: {} };
  const of = (kind) => (usage.byKind[kind] ??= { calls: 0, cacheHits: 0, budgetSkipped: 0, errors: 0, costUsd: 0 });
  const bump = (kind, field, n = 1) => { usage[field] += n; of(kind)[field] += n; };
  return {
    usage,
    hit: (kind) => bump(kind, 'cacheHits'),
    take(kind) { if (maxCalls != null && usage.calls >= maxCalls) { bump(kind, 'budgetSkipped'); return false; } bump(kind, 'calls'); return true; },
    error: (kind) => bump(kind, 'errors'),
    cost(kind, usd) { if (typeof usd === 'number' && Number.isFinite(usd)) { bump(kind, 'costUsd', usd); usage.costUsd = Math.round(usage.costUsd * 1e4) / 1e4; } },
  };
}

/**
 * Wrap a model judge. Order: validated cache hit (no call, no budget) -> budget -> model -> store the answer.
 * keyOf(input) returns the 64-hex key or null (uncacheable, still budgeted). A stored record is reused only when
 * `reusable(record, input)` agrees (e.g. today's screen still looks the same); otherwise it is re-asked and replaced.
 * extra(input, key, store) adds evidence to the record. Errors and null answers are never cached.
 * onExhausted() decides what a skipped review looks like to the caller (a pending marker or a thrown error).
 */
export function cachedJudge({ kind, judge, store = null, budget = null, version, keyOf = () => null, validate = () => {}, reusable = () => true, extra = () => ({}), onExhausted }) {
  if (!version) throw new Error('reviewer_version_required');
  return async (input) => {
    const inputKey = keyOf(input);
    const key = inputKey ? digest({ kind, version, inputKey }) : null;
    if (key && store) {
      const hit = store.get(kind, key, validate);
      let ok = false; try { ok = !!hit && reusable(hit, input); } catch { ok = false; }
      if (ok) { budget?.hit(kind); return { ...hit.answer, cached: true }; }
    }
    if (budget && !budget.take(kind)) return onExhausted();
    let answer;
    try { answer = await judge(input); } catch (e) { budget?.error(kind); throw e; }
    if (answer == null) return answer;
    budget?.cost(kind, answer.costUsd);
    if (key && store) store.put(kind, key, { version, inputKey, answer, ...extra(input, key, store) });
    return answer;
  };
}
