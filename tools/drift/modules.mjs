// Shared module resolution for a recorded script (single source of truth for the bridge and the drift job).
// The bridge's resolveScriptModule (tools/ai-bridge.mjs) = explicitModule(script.module) -> the coverage table's
// module -> inferModuleFromScript (route votes, tools/coverage-scan.mjs) -> raw script.module. The coverage lookup
// needs the library service (bridge credentials), so it stays in the bridge and is passed in here as
// `coverageModule` when known; drift runs (scrubbed env, no service access) resolve without it.
// Import-safe: coverage-scan.mjs only defines functions/constants at import time.
import { canonicalModule, inferModuleFromScript } from '../coverage-scan.mjs';

// Render-bar picks beyond the coverage modules: Academy curriculum tabs with no app module of their own, plus
// "Other". They're always explicit (never inferred). Platform and Employee Training have their own Drive folders
// (gdrive.mjs) and Pylon collections (pylon.mjs).
export const EXTRA_RENDER_MODULES = Object.freeze(['Platform', 'Employee Training', 'Other']);

/** Canonical module for an explicit label (coverage module or render-bar pick), else null. */
export function explicitModule(raw) {
  const v = String(raw || '').trim();
  return canonicalModule(v) || EXTRA_RENDER_MODULES.find((m) => m.toLowerCase() === v.toLowerCase()) || null;
}

/**
 * Synchronous part of the bridge's resolveScriptModule. `coverageModule` undefined = not looked up.
 * @returns {{module: string|null, inferred: boolean, source: 'script'|'coverage'|'inferred'|'raw'|null}}
 */
export function resolveModuleSync(scriptObj, coverageModule = undefined) {
  const own = explicitModule(scriptObj?.module);
  if (own) return { module: own, inferred: false, source: 'script' };
  const cov = canonicalModule(coverageModule);
  if (cov) return { module: cov, inferred: false, source: 'coverage' };
  const guess = inferModuleFromScript(scriptObj);
  if (guess) return { module: guess, inferred: true, source: 'inferred' };
  const raw = scriptObj?.module || coverageModule || null;
  return { module: raw, inferred: false, source: raw ? 'raw' : null };
}
