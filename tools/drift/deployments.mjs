// Successful "Production – hadrius-frontend" deployments of hadrius_frontend (GitHub deployments through the gh CLI,
// one paginated GraphQL query) and which deploy was live at a given moment. Import-safe; the gh call is injectable
// so tests never touch the network.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PRODUCTION_FRONTEND_ENVIRONMENT } from './release-evidence.mjs';

const pexec = promisify(execFile);
const SHA40 = /^[0-9a-f]{40}$/i;
const QUERY = 'query($endCursor:String){repository(owner:"1Quantbase",name:"hadrius_frontend"){deployments(environments:["'
  + PRODUCTION_FRONTEND_ENVIRONMENT
  + '"],first:100,after:$endCursor,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{commitOid createdAt statuses(first:10){nodes{state createdAt}}}}}}';
const JQ = '.data.repository.deployments.nodes[] | [.commitOid, .createdAt, ([.statuses.nodes[] | select(.state=="SUCCESS") | .createdAt] | first // "")] | @tsv';

/** Raw TSV (sha, createdAt, first SUCCESS time or "") for every production deployment, newest first. */
export async function ghDeploymentRows() {
  const { stdout } = await pexec('gh', ['api', 'graphql', '--paginate', '-f', `query=${QUERY}`, '--jq', JQ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  return stdout;
}

/** Successful deploys only, sorted by the time they went live (oldest first). */
export function parseDeploymentRows(tsv) {
  const out = [];
  for (const line of String(tsv ?? '').split('\n')) {
    const [sha, createdAt, successAt] = line.trim().split('\t');
    if (!SHA40.test(sha || '') || !successAt || !Number.isFinite(Date.parse(successAt))) continue;
    out.push({ sha: sha.toLowerCase(), createdAt, successAt });
  }
  return out.sort((a, b) => Date.parse(a.successAt) - Date.parse(b.successAt));
}

export async function fetchProductionDeployments({ run = ghDeploymentRows } = {}) {
  const deploys = parseDeploymentRows(await run());
  if (!deploys.length) throw new Error('no successful production deployments returned by GitHub');
  return deploys;
}

/** The deploy that was live at `iso`: the last one that succeeded at or before it (null before the first). */
export function liveAt(deploys, iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  let live = null;
  for (const d of deploys) { if (Date.parse(d.successAt) <= t) live = d; else break; }
  return live;
}

/** Deploys live at recording and at capture time. changed=false means no frontend release in between. */
export function bracket(deploys, { recordedAt, capturedAt }) {
  if (!Number.isFinite(Date.parse(recordedAt)) || !Number.isFinite(Date.parse(capturedAt))) return { error: 'missing_timestamps' };
  if (Date.parse(capturedAt) < Date.parse(recordedAt)) return { error: 'capture_before_recording' };
  const baseline = liveAt(deploys, recordedAt), current = liveAt(deploys, capturedAt);
  if (!baseline) return { error: 'no_deploy_before_recording' };
  if (!current) return { error: 'no_deploy_before_capture' };
  return { baseline, current, changed: baseline.sha !== current.sha };
}
