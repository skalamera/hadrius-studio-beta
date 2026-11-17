// Never manufacture missing capture pixels: the target belongs to its own screenshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function routeKey(value) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://recording.invalid');
    url.searchParams.sort();
    return url.origin + url.pathname + '?' + url.searchParams.toString() + url.hash;
  } catch { return value; }
}

export function assertRecordingIntegrity(script, recordingDir) {
  const steps = (script.steps || []).filter(s => s.capture !== false);
  if (!steps.length) throw new Error('The recording has no captured slides.');
  const seen = new Map(), hashes = [];
  for (const [i, step] of steps.entries()) {
    const label = `step ${Number.isInteger(step.index) ? step.index + 1 : i + 1}`;
    const file = step.media?.pre;
    const fail = reason => { throw new Error(`Recording capture invalid: ${label} ${reason}. Re-record the affected steps; no substitute screenshot will be rendered.`); };
    if (!file || path.basename(file) !== file) fail('has a missing or invalid screenshot reference');
    const full = path.join(recordingDir, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || !fs.statSync(full).size) fail('has a missing or empty screenshot');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    hashes.push([file, hash]);
    // Same pixels may legitimately support several highlights. But different capture files
    // showing identical pixels cannot prove a route change or a newly opened dialog.
    const state = { file, route: routeKey(step.url || step.route), dialog: typeof step.target?.inDialog === 'boolean' ? step.target.inDialog : null };
    for (const prior of seen.get(hash) || []) {
      if (prior.file !== file && ((prior.route && state.route && prior.route !== state.route) || (prior.dialog !== null && state.dialog !== null && prior.dialog !== state.dialog))) {
        fail('has identical screenshot bytes for a different page or dialog');
      }
    }
    seen.set(hash, [...(seen.get(hash) || []), state]);
  }
  return crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const script = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const id = script.recording?.id;
  if (!id || path.basename(id) !== id) throw new Error('Missing or invalid recording id');
  assertRecordingIntegrity(script, path.join(repo, 'out', '_recordings', id));
}
