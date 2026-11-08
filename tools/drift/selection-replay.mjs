// Replay a reviewed cached sweep through weekly candidate/submission selection without browser/model/network calls.
// Git reads pinned commits in the existing bare mirror. Deployment timestamps and model answers come only from the
// supplied reports; recomputed source provenance is checked against those reports. Original evidence is read-only.
// CLI: node tools/drift/selection-replay.mjs --reports A.json,B.json --review review.json --allowlist FILE --out NEW_DIR
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mergeReports, sortVideos, routeFrom, slideTextFrom } from './flagged-review.mjs';
import { createFrontendGit } from './frontend-git.mjs';
import { createReleaseProvider } from './release-provider.mjs';
import { parseNames, finalizeWeeklySelection } from './weekly.mjs';
import { createCandidate } from './candidate.mjs';
import { prepareSubmissions, humanSummary } from './weekly-submit.mjs';
import { digest } from './contracts.mjs';
import { selectionMarker } from './ui-selection.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const pairsOf = (videos) => videos.flatMap(v => v.slides.map(s => `${v.name}#${s.index}`)).sort();

export function reconcileInventory(merged, allowedNames) {
  const allowed = new Set(allowedNames);
  return {
    allowlisted: allowed.size, reportEntries: merged.size,
    capturedAllowlisted: [...allowed].filter(n => merged.has(n) && !merged.get(n).skipped).length,
    missingAllowlisted: [...allowed].filter(n => !merged.has(n) || merged.get(n).skipped).sort(),
    outsideAllowlist: [...merged.keys()].filter(n => !allowed.has(n)).sort(),
  };
}

/** Preserve checks from the reclassification that supplied the verdict, not stale raw-job checks.
 * Legacy reports carry only codes, so retain their old check fields until they are explicitly re-reviewed. */
export function replayChecks(original, reviewed) {
  const out = { ...original };
  for (const key of ['judge', 'target', 'guard', 'pageState', 'emptyState', 'errorState', 'prerequisiteUnverified']) {
    if (Object.hasOwn(reviewed, key)) out[key] = reviewed[key];
  }
  out.reasons = Array.isArray(reviewed.reasons) ? reviewed.reasons : reviewed.codes.map(code => {
    const at = code.indexOf(':');
    return { verdict: code.slice(0, at), code: code.slice(at + 1), detail: 'Cached classifier finding (no new model review)' };
  });
  return out;
}

export async function replaySelection({ reportPaths, reviewPath, allowlistPath, outDir, log = console.error }) {
  const out = resolve(outDir);
  if (existsSync(out)) throw new Error('output_exists');
  const reports = reportPaths.map(p => readJson(resolve(p))), accepted = readJson(reviewPath);
  const merged = mergeReports(reports);
  const names = parseNames({ allowlistText: readFileSync(allowlistPath, 'utf8') });
  const inventory = reconcileInventory(merged, names);
  const acceptedPairs = pairsOf(accepted.flagged);
  // Also exercise the refactored offline tool, not just the downstream projection.
  const offline = sortVideos(merged, { routeOf: routeFrom, slideTextOf: slideTextFrom() });
  assert.deepEqual(pairsOf(offline.flagged), acceptedPairs, 'offline refactor changed the accepted list');
  const watched = new Map([...reportPaths, reviewPath, allowlistPath].map(p => [resolve(p), hash(p)]));
  const scripts = new Map(names.map(n => {
    const path = join(REPO, 'scripts', `${n}.script.json`);
    if (!existsSync(path)) return [n, null];
    watched.set(path, hash(path));return [n, readJson(path)];
  }));
  // Pinned successful-deployment observations already present in the saved provider summaries. No gh/API query.
  const deployments = new Map();
  for (const v of merged.values()) if (v.release?.baselineSha && v.release?.currentSha) {
    deployments.set(`${v.release.baselineDeployedAt}|${v.release.baselineSha}`, { sha: v.release.baselineSha, successAt: v.release.baselineDeployedAt });
    deployments.set(`${v.release.currentDeployedAt}|${v.release.currentSha}`, { sha: v.release.currentSha, successAt: v.release.currentDeployedAt });
  }
  const git = createFrontendGit();
  git.fetchHeads = () => null;
  git.ensureCommit = (sha) => { if (!git.hasCommit(sha)) throw new Error(`offline_sha_missing:${sha}`); };
  const provide = createReleaseProvider({ git, loadDeployments: async () => [...deployments.values()].sort((a,b) => Date.parse(a.successAt)-Date.parse(b.successAt)) });
  const jobs = [];
  for (const name of names) {
    const v = merged.get(name), script = scripts.get(name);
    if (!v || v.skipped || !script) { jobs.push({ name, status: v?.status ?? 'missing_evidence', skipped: v?.skipped ?? 'missing_evidence', steps: [] });continue; }
    const cap = join(v.runDir, name, 'capture'), rawPath = join(v.runDir, name, 'job.json');
    for (const path of [rawPath, join(cap,'run.json'), join(cap,'compare.json'), join(cap,'classify.json')]) if (existsSync(path)) watched.set(path,hash(path));
    const raw = readJson(rawPath), run = readJson(join(cap,'run.json')), cmp = readJson(join(cap,'compare.json'));
    for(const s of cmp.steps||[])if(s.todayScreenshot){const p=join(cap,s.todayScreenshot);if(existsSync(p))watched.set(p,hash(p));}
    const evidence = await provide({ script, runDir: cap, capturedAt: v.release?.capturedAt ?? raw.startedAt });
    assert.equal(evidence.summary.baselineSha, v.release?.baselineSha, `${name}: recorded deploy changed`);
    assert.equal(evidence.summary.currentSha, v.release?.currentSha, `${name}: capture deploy changed`);
    const steps = v.steps.map(s => {
      const ev = evidence.byStep[s.index], st = script.steps.find((x,i) => (x.index ?? i) === s.index);
      assert.equal(ev?.status, s.release, `${name}#${s.index}: release status changed`);
      assert.deepEqual((ev?.commits || []).map(({sha,pr,subject,files}) => ({sha,pr,subject,files})), s.commits, `${name}#${s.index}: source provenance changed`);
      const c = cmp.steps.find(x => x.index === s.index), r = run.steps.find(x => x.index === s.index);
      const original = raw.steps?.find(x => x.index === s.index);
      return { ...replayChecks(original, s), index:s.index, action:st?.action, verdict:s.verdict,
        uiContext:{ route:c?.todayUrl ?? r?.todayUrl ?? ev?.routePath, slideText:[st?.narration,st?.caption,st?.target?.name,st?.target?.text,st?.target?.label].filter(Boolean).join('\n'), visibleText:r?.visibleText ?? null },
        uiReleaseEvidence:ev ? {...ev,redesign:s.redesign} : null,
        evidence:{ recorded:st?.media?.pre ? join(REPO,'out','_recordings',script.recording.id,st.media.pre) : null,
          today:c?.todayScreenshot ? join(cap,c.todayScreenshot) : null },
      };
    });
    jobs.push({...raw,name,status:'ok',verdict:v.after,steps,scriptHash:digest(script),candidatePath:null,candidate:null,
      reasons:(raw.reasons || []).filter(r => r.code === 'mixed_old_new_ui'),summary:v.summary});
    log(`[selection-replay] ${jobs.length}/${names.length} ${name}`);
  }
  mkdirSync(out,{recursive:true});
  // Make a separate replay workspace. Never replace the original job/classify/summary files.
  for (const job of jobs) {
    const dir=join(out,job.name);mkdirSync(join(dir,'capture'),{recursive:true});
    const source=merged.get(job.name);
    if(source&&!source.skipped&&scripts.get(job.name))writeFileSync(join(dir,'capture','run.json'),JSON.stringify(readJson(join(source.runDir,job.name,'capture','run.json')),null,2)+'\n');
    writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');
  }
  const deps={readScript:name=>({script:scripts.get(name)}),recordingsRoot:join(REPO,'out','_recordings'),candidate:createCandidate};
  for(const job of jobs)if(['slide_update','moved_highlight','narration_review'].includes(job.verdict)){
    const script=scripts.get(job.name);
    for(const step of script?.steps||[])for(const media of Object.values(step.media||{}))if(typeof media==='string'){
      const p=join(deps.recordingsRoot,script.recording.id,media);if(existsSync(p))watched.set(p,hash(p));
    }
  }
  const selection=await finalizeWeeklySelection({jobs,outDir:out,deps,log});
  const weeklyPairs=pairsOf(selection.review.flagged);
  assert.deepEqual(weeklyPairs,acceptedPairs,'weekly selection differs from accepted slide pairs');
  const summary={schema:1,names,finishedAt:new Date().toISOString(),uiSelection:selectionMarker(selection),videos:jobs.map(j=>({name:j.name,status:j.status}))};
  const rows=prepareSubmissions({summary,runDir:out,requireCertifiedPreview:false,io:{readJson,readScript:name=>scripts.get(name),readAssembly:()=>null}}); // offline parity, not posting
  const payloadPairs=rows.filter(r=>r.decision==='post').flatMap(r=>r.payload.details.changes.map(c=>`${r.name}#${c.index}`)).sort();
  // Repairability v2 adds kept slides that show the same verified change; the payload must be exactly the accepted
  // slides plus those extensions, and an extension must never appear without its accepted source slide.
  const extendedPairs=selection.review.flagged.flatMap(v=>{const r=selection.byName.get(v.name)?.repair;return r?.decision==='auto'?(r.extended??[]).map(i=>`${v.name}#${i}`):[];}).sort();
  for(const p of extendedPairs)assert.ok(acceptedPairs.some(a=>a.split('#')[0]===p.split('#')[0]),`${p}: extension without an accepted slide`);
  assert.deepEqual(payloadPairs,[...new Set([...acceptedPairs,...extendedPairs])].sort(),'notification payload scope differs from accepted slide pairs plus repair extensions');
  const manifestPairs=[],manual=[];
  for(const job of jobs){
    const active=join(out,job.name,'candidate-manifest.json');
    if(job.candidateError)throw new Error(`${job.name}: candidate failed: ${job.candidateError}`);
    if(existsSync(active)){
      assert.ok(job.candidatePath,`${job.name}: manifest without a local candidate`);
      const manifest=readJson(active),base=readJson(join(job.candidatePath,'identified-base.script.json'));
      const indices=manifest.changes.map(c=>base.steps.find(s=>s.id===c.stepId).index);
      const row=rows.find(r=>r.name===job.name);
      assert.equal(row?.payload?.kind,'auto_update',`${job.name}: manual job must not have a candidate`);
      assert.deepEqual(row.payload.details.execution,job.candidateInputs,`${job.name}: executor inputs lost at submission`);
      assert.equal(readJson(row.payload.details.execution.identifiedScript).recording.id,base.recording.id);
      assert.equal(row.payload.details.execution.candidateManifest,active);
      assert.deepEqual(indices,[...row.assessment.uiEvidenceSteps],`${job.name}: candidate and payload disagree`);
      manifestPairs.push(...indices.map(i=>`${job.name}#${i}`));
    }else if(job.candidateSkip==='manual_rerecord')manual.push(job.name);
  }
  for(const pair of manifestPairs)assert.ok(acceptedPairs.includes(pair)||extendedPairs.includes(pair),`out-of-scope render candidate ${pair}`);
  const autoPairs=rows.filter(r=>r.decision==='post'&&r.payload.kind==='auto_update').flatMap(r=>r.payload.details.changes.map(c=>`${r.name}#${c.index}`)).sort();
  assert.deepEqual(manifestPairs.sort(),autoPairs,'an automatic notification is missing its scoped candidate');
  for(const [path,before] of watched)assert.equal(hash(path),before,`input changed: ${path}`);
  const repair=Object.fromEntries(selection.review.flagged.map(v=>[v.name,selection.byName.get(v.name).repair]));
  for(const [name,r] of Object.entries(repair)){
    const kind=rows.find(x=>x.name===name)?.payload?.kind;
    assert.equal(kind,r.decision==='auto'?'auto_update':'manual_rerecord',`${name}: payload kind disagrees with the repair decision`);
    if(r.decision==='manual')for(const b of r.blockers)assert.ok(rows.find(x=>x.name===name).payload.details.rerecordReason.some(t=>t.includes(`Slide ${b.slides[0]+1}:`)),`${name}: ${b.code} missing from the notification`);
  }
  const report={schema:1,finishedAt:new Date().toISOString(),dryRun:true,networkCalls:0,modelCalls:0,posts:0,
    inventory,acceptedPairs,weeklyPairs,payloadPairs,extendedPairs,manifestPairs,manualRerecords:manual,repair,
    flaggedVideos:selection.review.flagged.map(v=>v.name),inputsUnchanged:true,inputs:[...watched].map(([path,sha256])=>({path,sha256})),rows};
  writeFileSync(join(out,'selection-parity.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  writeFileSync(join(out,'selection-parity.md'),`# Weekly selection parity\n\nPASS: ${report.flaggedVideos.length} videos / ${weeklyPairs.length} slides, exact video-and-index match.\n\nLocal candidates: ${manifestPairs.length} slides. Manual re-record jobs (no automatic candidate): ${manual.length}.\n\nModel calls: 0. Network calls: 0. Posts: 0. Original inputs unchanged.\n\nAllowlist reconciliation:\n${JSON.stringify(inventory,null,2)}\n\n`+humanSummary(rows,{runDir:out,dryRun:true}));
  return report;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
  for(const flag of ['--reports','--review','--allowlist','--out'])if(!args.includes(flag))throw new Error(`missing ${flag}`);
  replaySelection({reportPaths:arg('--reports').split(','),reviewPath:resolve(arg('--review')),allowlistPath:resolve(arg('--allowlist')),outDir:arg('--out')})
    .then(r=>console.log(JSON.stringify({flaggedVideos:r.flaggedVideos.length,selectedSlides:r.weeklyPairs.length,localCandidateSlides:r.manifestPairs.length,manualJobs:r.manualRerecords.length,
      modelCalls:r.modelCalls,posts:r.posts,inputsUnchanged:r.inputsUnchanged,report:join(resolve(arg('--out')),'selection-parity.json')},null,2)))
    .catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
}
