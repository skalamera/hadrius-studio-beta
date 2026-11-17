// Claude first, Codex as the fallback: the operator's standing choice for every model call the Studio makes.
// A Claude call that fails for any reason but a cancel is answered by Codex. After a usage limit, a rate limit or a
// lost sign-in that Codex then covered, Claude is skipped for a cool-down, so the turns of a take don't each wait on
// a call that cannot succeed. `KBS_AI_FALLBACK_PROVIDER=none` turns the fallback off, and a Mac without the Codex CLI
// gets Claude's own error back.

/** Claude failures that will keep failing for a while: worth skipping Claude until they clear. */
export const CLAUDE_OUTAGE = /spend limit|usage limit|weekly limit|[0-9]+-hour limit|limit resets|usage-credits|rate.?limit|insufficient_quota|quota exceeded|too many requests|overloaded|credit balance|not logged in|authenticat|oauth|session expired|isn't connected|invalid api key/i;

export const fallbackEnabled = (env = process.env) => String(env.KBS_AI_FALLBACK_PROVIDER || 'codex').toLowerCase() !== 'none';

const message = (e) => String(e?.message || e);
const isCancel = (e, signal) => !!signal?.aborted || /^(error: )?cancelled\b/i.test(message(e).trim());
const notInstalled = (e) => e?.code === 'ENOENT' || /\bENOENT\b/.test(message(e));

export function createFallback({ cooldownMs = 10 * 60e3, now = () => Date.now() } = {}) {
  let skipClaudeUntil = 0;
  return {
    async run(claude, codex, { signal, onFallback = () => {}, enabled = fallbackEnabled(), third = null, onThirdFallback = () => {} } = {}) {
      if (!enabled) return claude();
      if (now() < skipClaudeUntil) {
        try { return await codex(); } catch (e) {
          if (isCancel(e, signal)) throw e;
          skipClaudeUntil = 0; // Codex is failing too: Claude may have recovered
          try { return await claude(); } catch (e2) {
            if (isCancel(e2, signal) || !third) throw e2;
            onThirdFallback(message(e2));
            return await third();
          }
        }
      }
      let first;
      try { return await claude(); } catch (e) {
        if (isCancel(e, signal)) throw e;
        first = e;
      }
      onFallback(message(first));
      try {
        const answer = await codex();
        if (CLAUDE_OUTAGE.test(message(first))) skipClaudeUntil = now() + cooldownMs;
        return answer;
      } catch (e) {
        if (isCancel(e, signal)) throw e;
        if (third) {
          onThirdFallback(message(e));
          try {
            const answer = await third();
            if (CLAUDE_OUTAGE.test(message(first))) skipClaudeUntil = now() + cooldownMs;
            return answer;
          } catch (e3) {
            if (isCancel(e3, signal)) throw e3;
            if (notInstalled(e3) && notInstalled(e)) throw first;
            throw Object.assign(new Error(`${message(first)} (Codex fallback failed: ${message(e).slice(0, 200)}; Agy fallback also failed: ${message(e3).slice(0, 200)})`), { cause: first });
          }
        }
        if (notInstalled(e)) throw first;
        throw Object.assign(new Error(`${message(first)} (Codex fallback also failed: ${message(e).slice(0, 300)})`), { cause: first });
      }
    },
  };
}

/** One per process, so the bridge's narration and the recorder's turns share the cool-down. */
export const claudeThenCodex = createFallback();
