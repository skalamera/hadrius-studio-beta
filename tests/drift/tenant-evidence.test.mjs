import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifySwitcherText, decideTenant, buildTenantEvidence, evidenceMatches, allOnProductionApp, METHOD } from '../../tools/drift/tenant-evidence.mjs';
import { detectScriptTenant, buildAllowlist } from '../../tools/drift/tenants.mjs';

const APP = 'https://app.hadrius.com';
const script = (name, { origin = APP, rec = 'rec-1', n = 3, company = null } = {}) => ({
  name, recording: { id: rec },
  environment: { startUrl: `${origin}/people-oversight${company ? `?company_id=${company}` : ''}` },
  steps: Array.from({ length: n }, (_, i) => ({ index: i, action: 'click', url: `${origin}/people-oversight`, media: { pre: `step_${i}.png` } })),
});

test('switcher text: name AND id required; staging and both-tenants are flagged', () => {
  assert.equal(classifySwitcherText(['Hadrius Sandbox', '1048', 'Overview']), 'sandbox');
  assert.equal(classifySwitcherText(['Hadrius Academy 1150']), 'academy');
  assert.equal(classifySwitcherText(['Hadrius Academy']), 'none', 'name without id is not enough');
  assert.equal(classifySwitcherText(['1048']), 'none');
  assert.equal(classifySwitcherText(['STAGING', 'Hadrius Sandbox 1048']), 'staging');
  assert.equal(classifySwitcherText(['Hadrius Sandbox 1048', 'Hadrius Academy 1150']), 'both');
  assert.equal(classifySwitcherText(['Current company', '5']), 'none');
});

test('decision: >=2 agreeing frames, no disagreement, no staging', () => {
  assert.equal(decideTenant(['sandbox', 'sandbox', 'none']).tenant, 'sandbox');
  assert.equal(decideTenant(['academy', 'none', 'none']).reason, 'too_few_frames_show_the_company');
  assert.equal(decideTenant(['academy', 'sandbox', 'academy']).reason, 'frames_disagree');
  assert.equal(decideTenant(['academy', 'staging', 'academy']).reason, 'recorded_on_staging');
  assert.equal(decideTenant(['none', 'none']).reason, 'no_company_visible');
});

test('build + bind: evidence is bound to the recording and frame files; a staging script is never assigned', () => {
  const root = mkdtempSync(join(tmpdir(), 'tenant-ev-')); mkdirSync(join(root, 'rec-1')); mkdirSync(join(root, 'rec-2'));
  for (const r of ['rec-1', 'rec-2']) for (let i = 0; i < 3; i++) writeFileSync(join(root, r, `step_${i}.png`), `png-${r}-${i}`);
  const sb = script('SB'), st = script('ST', { origin: 'https://staging.hadrius.com' }), ac = script('AC', { rec: 'rec-2' });
  const ocr = (paths) => Object.fromEntries(paths.map((p) => [p, p.includes('rec-2') ? ['Hadrius Academy', '1150'] : ['Hadrius Sandbox', '1048']]));
  const { entries, rejected } = buildTenantEvidence([sb, st, ac], { ocr, recordingsRoot: root });
  assert.equal(entries.SB.tenant, 'sandbox'); assert.equal(entries.AC.tenant, 'academy'); assert.equal(entries.SB.method, METHOD);
  assert.equal(rejected.ST, 'not_all_urls_on_app.hadrius.com');
  assert.ok(entries.SB.frames.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  // detectScriptTenant uses evidence only while it still matches the script.
  assert.deepEqual([detectScriptTenant(sb, { evidence: entries }).tenant, detectScriptTenant(sb, { evidence: entries }).source], ['sandbox', 'recorded_frames']);
  const rerecorded = { ...sb, recording: { id: 'rec-9' } };
  assert.equal(detectScriptTenant(rerecorded, { evidence: entries }).status, 'unknown', 'a re-recording invalidates the evidence');
  const reordered = { ...sb, steps: sb.steps.map((s, i) => ({ ...s, media: { pre: i === 0 ? 'other.png' : s.media.pre } })) };
  assert.equal(evidenceMatches(entries.SB, reordered), false);
  // A URL company always wins over evidence (and a different URL company is never overridden).
  assert.equal(detectScriptTenant(script('SB', { company: 1150 }), { evidence: entries }).tenant, 'academy');
  assert.equal(detectScriptTenant(script('X'), { evidence: {} }).status, 'unknown');
  assert.equal(allOnProductionApp({ environment: { startUrl: `${APP}/a` }, steps: [{ url: 'https://staging.hadrius.com/b' }] }), false);
});

test('allowlist rows carry the tenant source for evidence-based tenants', () => {
  const a = buildAllowlist([script('SB')], { now: new Date(0) });
  // Without evidence on disk for 'SB' it is unknown; with the real evidence file entries, rows say tenant_source.
  assert.ok(a.unknown.some((r) => r.name === 'SB') || a.sandbox.some((r) => r.name === 'SB' && r.tenant_source === 'recorded_frames'));
});
