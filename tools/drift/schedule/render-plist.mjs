// Renders the weekly drift launchd plist from com.kbstudio.drift-weekly.plist.template.
// Import-safe. CLI (used by install.sh):
//   node tools/drift/schedule/render-plist.mjs [--live] [--weekday 1] [--hour 6] [--minute 0] [--port 8787] [--log PATH]
// Prints the plist to stdout. Without --live the scheduled run submits as a DRY RUN (report only).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export const LABEL = 'com.kbstudio.drift-weekly';
export const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), `${LABEL}.plist.template`);
export const ALLOWLIST = 'tools/drift/allowlist.json';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist({ template = readFileSync(TEMPLATE, 'utf8'), live = false, weekday = 1, hour = 6, minute = 0, port = 8787, log = join(homedir(), 'Library', 'Logs', 'kbstudio-drift-weekly.log') } = {}) {
  for (const [k, v, lo, hi] of [['weekday', weekday, 0, 7], ['hour', hour, 0, 23], ['minute', minute, 0, 59], ['port', port, 1, 65535]]) {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`invalid_${k}:${v}`);
  }
  if (!String(log).startsWith('/')) throw new Error('log_must_be_absolute');
  const body = JSON.stringify({ allowlist: ALLOWLIST, source: 'schedule', dryRun: !live });
  const vals = { LABEL, BODY: body, URL: `http://127.0.0.1:${port}/drift/weekly/run`, WEEKDAY: weekday, HOUR: hour, MINUTE: minute, LOG: log };
  const out = template.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => { if (!(k in vals)) throw new Error(`unknown_placeholder:${k}`); return xml(vals[k]); });
  return out;
}

const arg = (a, n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2);
  const num = (n, d) => (arg(a, n) != null ? Number(arg(a, n)) : d);
  try { process.stdout.write(renderPlist({ live: a.includes('--live'), weekday: num('--weekday', 1), hour: num('--hour', 6), minute: num('--minute', 0), port: num('--port', 8787), ...(arg(a, '--log') ? { log: arg(a, '--log') } : {}) })); }
  catch (e) { console.error(e.message); process.exitCode = 64; }
}
