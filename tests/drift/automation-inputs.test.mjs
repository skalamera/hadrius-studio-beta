import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {digest, bytesDigest} from '../../tools/drift/contracts.mjs';
import {selectWeeklyJobs, selectionMarker} from '../../tools/drift/ui-selection.mjs';
import {confirmedRelease} from './release-fixture.mjs';
import {archiveAutomationInputs, verifyAutomationInputs} from '../../tools/drift/automation-inputs.mjs';
import {collectRepairReviewTasks} from '../../tools/drift/review-repairs.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const put = (p, value) => { mkdirSync(dirname(p), {recursive:true}); writeFileSync(p, JSON.stringify(value, null, 2)+'\n'); };
const change = (kind, before, after) => ({element:'control',kind,before,after,verified:true,commit:'c'.repeat(40)});
const rename = change('renamed','Create rule','New rule'), added = change('added',null,'Risk level'), frame = change('moved','Ask Hadrius','Ask Hadrius');
const step = (index, route, changes) => ({index,verdict:'slide_update',reasons:[{code:'ui_changed',verdict:'slide_update'}],
  uiContext:{route,slideText:''},uiReleaseEvidence:confirmedRelease({routePath:route,redesign:{confirmed:true,changes,rejected:[],raw:{diagnostic:'retain me'}}})});
function cleanup(path) {
  if (!existsSync(path)) return;
  chmodSync(path,0o700);
  for (const entry of readdirSync(path,{withFileTypes:true})) if(entry.isDirectory()) cleanup(join(path,entry.name));
  rmSync(path,{recursive:true,force:true});
}
function fixture(t) {
  // Deliberately outside ephemeral scratch: production archives must survive scratch pruning.
  const base=join(homedir(),'.hermes','state'); mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'automation-input-test-')); t.after(()=>cleanup(root));
  const repo=join(root,'repo'), source=join(root,'source'), outDir=join(root,'archive'); mkdirSync(repo);
  const jobs=[
    {name:'Mixed',steps:[step(0,'/rules',[rename,added,frame]),step(1,'/rules',[added]),{index:7,verdict:'unverified',reasons:[{code:'not_captured',verdict:'unverified'}],uiContext:{route:'/rules',slideText:''}}]},
    {name:'FrameA',steps:[step(0,'/policies',[frame])]},
    {name:'FrameB',steps:[step(0,'/exams',[frame])]},
    {name:'UsedFrame',steps:[{...step(0,'/people',[frame]),uiContext:{route:'/people',slideText:'Click Ask Hadrius.'}}]},
    {name:'Added',steps:[step(0,'/exceptions',[added])]},
  ].map(j=>({...j,status:'ok',verdict:'slide_update',reasons:[]}));
  const scripts=new Map();
  for(const j of jobs){
    const script={name:j.name,recording:{id:'recording-'+j.name},steps:j.steps.map(s=>({index:s.index,narration:'Open this page.',url:s.uiContext.route,media:{pre:`old-${s.index}.png`}}))};
    scripts.set(j.name,script); j.scriptPath=join(repo,'scripts',j.name+'.script.json'); j.scriptHash=digest(script); put(j.scriptPath,script);
    const cap=join(source,j.name,'capture'); j.evidence={runDir:cap};
    for(const s of j.steps){
      s.evidence={today:join(cap,`current-${s.index}.png`),recorded:join(repo,'out','_recordings',script.recording.id,`old-${s.index}.png`)};
      for(const p of Object.values(s.evidence)){mkdirSync(dirname(p),{recursive:true});writeFileSync(p,Buffer.from('real fixture bytes '+p));}
    }
    put(join(cap,'run.json'),{signedIn:true,tenantVerified:true,steps:j.steps.map(s=>({index:s.index,screenshot:`current-${s.index}.png`,target:{rect:{x:s.index,y:3,w:10,h:10}},visibleText:'Loaded',todayUrl:'https://app.hadrius.com'+s.uiContext.route}))});
    put(join(source,j.name,'job.json'),j);
  }
  const summary={schema:1,outDir:source,names:jobs.map(j=>j.name),videos:jobs.map(j=>({name:j.name,status:j.status,job:join(source,j.name,'job.json')}))}; put(join(source,'summary.json'),summary);
  const selection=selectWeeklyJobs(jobs,{readScript:n=>scripts.get(n)});
  const save=()=>{for(const j of jobs)put(join(source,j.name,'job.json'),j);put(join(source,'summary.json'),summary);};
  return {root,repo,source,outDir,jobs,summary,selection,scripts,save};
}

test('archives full batch, exact claims/exclusions, all flagged steps and exact source bytes without candidates',async t=>{
  const f=fixture(t), before=structuredClone(f.jobs), sourceBytes=readFileSync(join(f.source,'Mixed','job.json'));
  const result=await archiveAutomationInputs(f);
  assert.equal(result.sourceDir,f.outDir); assert.equal(result.manifestPath,join(f.outDir,'automation-inputs.json'));
  assert.deepEqual(result.selection.review.flagged.map(v=>[v.name,v.slides.map(s=>s.index)]),[['Mixed',[0]],['UsedFrame',[0]]]);
  assert.deepEqual(f.jobs,before); assert.deepEqual(readFileSync(join(f.source,'Mixed','job.json')),sourceBytes);
  assert.deepEqual(readFileSync(join(f.outDir,'Mixed','originaljob.json')),sourceBytes);
  assert.deepEqual(read(join(f.outDir,'summary.json')).uiSelection,selectionMarker(result.selection));
  const parity=read(join(f.outDir,'selection-parity.json'));
  assert.deepEqual(parity.acceptedPairs,['Mixed#0','UsedFrame#0']); assert.equal(parity.claimsUnchanged,true);assert.equal(parity.exclusionsUnchanged,true);
  assert.equal(read(join(f.outDir,'review.json')).origin,'weekly_release_verified_no_per_run_human_approval');
  const clone=read(join(f.outDir,'Mixed','job.json'));
  assert.deepEqual(clone.steps.map(s=>s.index),[0,1,7]);
  for(const s of clone.steps){
    for(const key of ['today','recorded']){assert.ok(s.evidence[key].startsWith(f.outDir));assert.deepEqual(readFileSync(s.evidence[key]),readFileSync(before[0].steps.find(x=>x.index===s.index).evidence[key]));}
    const run=read(join(dirname(s.evidence.today),'run.json')), cap=run.steps.find(x=>x.index===s.index);
    assert.equal(resolve(dirname(s.evidence.today),cap.screenshot),s.evidence.today);
    assert.deepEqual(s.uiReleaseEvidence,before[0].steps.find(x=>x.index===s.index).uiReleaseEvidence);
  }
  assert.equal(clone.scriptHash,digest(read(clone.scriptPath)));assert.equal(read(clone.scriptPath).name,clone.name);
  assert.deepEqual(readFileSync(clone.scriptPath),readFileSync(before[0].scriptPath));
  assert.ok(!existsSync(join(f.outDir,'Mixed','candidate-manifest.json')));
  const inventory=collectRepairReviewTasks({sourceDir:result.sourceDir,reviewPath:result.reviewPath,repo:f.repo});
  assert.deepEqual(inventory.tasks.filter(task=>task.name==='Mixed').map(task=>task.index),[0,1,7],'linked and blocker review survives archiving');
  assert.ok(inventory.tasks.every(task=>!task.error),'pinned scripts are usable by the actual semantic review collector');
  const manifest=await verifyAutomationInputs(result.manifestPath);
  assert.equal(manifest.ready,true);assert.equal(manifest.inputsUnchanged,true);
  assert.ok(manifest.files.some(x=>x.archiveFrom?.path===before[0].steps[0].evidence.today&&x.archiveFrom.sha256===bytesDigest(readFileSync(before[0].steps[0].evidence.today))));
  const excluded=read(join(f.outDir,'FrameA','job.json'));
  assert.equal(excluded.steps[0].evidence.today,before[1].steps[0].evidence.today,'nonflagged context remains intact without copying images');
  assert.ok(existsSync(join(f.outDir,'FrameA','capture','run.json')));
  assert.ok(!manifest.files.some(x=>x.archiveFrom?.path===before[1].steps[0].evidence.today));
});

test('mixed actual capture runs follow bound current paths and preserve sparse indices/target rects',async t=>{
  const f=fixture(t),j=f.jobs[0],s=j.steps[1],extra=join(f.root,'other-capture');
  s.evidence.today=join(extra,'current.png');mkdirSync(extra);writeFileSync(s.evidence.today,'new actual current');
  put(join(extra,'run.json'),{signedIn:true,tenantVerified:true,steps:[{index:1,screenshot:'current.png',target:{rect:{x:99,y:2,w:3,h:4}}}]});f.save();
  const result=await archiveAutomationInputs(f),clone=read(join(result.sourceDir,j.name,'job.json'));
  assert.notEqual(dirname(clone.steps[0].evidence.today),dirname(clone.steps[1].evidence.today));
  assert.equal(readFileSync(clone.steps[1].evidence.today,'utf8'),'new actual current');
  const run=read(join(f.outDir,j.name,'capture','run.json'));
  assert.deepEqual(run.steps.map(s=>s.index),[0,1,7]);assert.equal(run.steps.find(s=>s.index===1).target.rect.x,99);
  assert.equal(run.steps.find(s=>s.index===7).target.rect.x,7);
});

test('missing images and capture runs remain missing, never substituted with another run',async t=>{
  const f=fixture(t),j=f.jobs[0];rmSync(j.steps[2].evidence.today);rmSync(j.steps[2].evidence.recorded);
  const expected=j.steps[2].evidence.today;
  j.evidence.runDir=join(f.root,'absent-run');f.save();
  const r=await archiveAutomationInputs(f),clone=read(join(f.outDir,j.name,'job.json'));
  assert.equal(existsSync(clone.steps[2].evidence.today),false);assert.equal(existsSync(clone.steps[2].evidence.recorded),false);
  assert.equal(existsSync(join(f.outDir,j.name,'capture','run.json')),false,'do not invent canonical candidate run');
  assert.ok(read(r.manifestPath).missing.some(x=>x.path===expected));
  assert.equal(clone.steps[2].verdict,'unverified');
});

test('retires only extra step proofs; raw findings and original proofs remain separately archived',async t=>{
  const f=fixture(t),s=f.jobs[0].steps[0];s.semanticRepair={positive:true};s.flowEquivalence={positive:true};s.customFinding={retain:true};f.save();
  f.selection=selectWeeklyJobs(f.jobs,{readScript:n=>f.scripts.get(n)});
  await archiveAutomationInputs(f);const clone=read(join(f.outDir,'Mixed','job.json')),original=read(join(f.outDir,'Mixed','originaljob.json'));
  assert.equal(Object.hasOwn(clone.steps[0],'semanticRepair'),false);assert.equal(Object.hasOwn(clone.steps[0],'flowEquivalence'),false);
  assert.deepEqual(original.steps[0].semanticRepair,{positive:true});assert.deepEqual(clone.steps[0].customFinding,{retain:true});
  assert.deepEqual(clone.steps[0].reasons,s.reasons);
});

test('rejects forged selected changes, not merely equal video/index pairs',async t=>{
  const f=fixture(t);f.selection.review.flagged[0].slides[0].changes[0].after='INVENTED';
  await assert.rejects(archiveAutomationInputs(f),/selection_claims_changed/);assert.equal(existsSync(f.outDir),false);
});

test('changed frame/addition exclusions are rejected even with unchanged selected pairs',async t=>{
  for(const group of ['frameChanges','newControlsOnly','frameOnly'])await t.test(group,async t=>{
    const f=fixture(t);f.selection.review[group]=[];
    await assert.rejects(archiveAutomationInputs(f),/selection_claims_changed/);assert.equal(existsSync(f.outDir),false);
  });
});

test('after source pruning, archived scripts/images/captures still feed the real review inventory',async t=>{
  const f=fixture(t),r=await archiveAutomationInputs(f);rmSync(f.source,{recursive:true});rmSync(f.repo,{recursive:true});
  assert.equal((await verifyAutomationInputs(r.manifestPath,{verifySources:false})).ready,true);
  const inventory=collectRepairReviewTasks({sourceDir:r.sourceDir,reviewPath:r.reviewPath,repo:f.repo});
  assert.ok(inventory.tasks.every(task=>!task.error));
  for(const task of inventory.tasks){
    assert.ok(existsSync(task.scriptPath));assert.ok(existsSync(task.raw.evidence.today));assert.ok(existsSync(task.raw.evidence.recorded));
    const run=read(join(dirname(task.raw.evidence.today),'run.json'));
    assert.equal(resolve(dirname(task.raw.evidence.today),run.steps.find(s=>s.index===task.index).screenshot),task.raw.evidence.today);
  }
});

test('rejects contradictory current screenshot source rather than inventing capture evidence',async t=>{
  const f=fixture(t),p=join(f.source,'Mixed','capture','run.json'),run=read(p);run.steps[0].screenshot='other.png';put(p,run);
  await assert.rejects(archiveAutomationInputs(f),/capture_image_path_mismatch/);assert.equal(existsSync(f.outDir),false);
});

test('rejects duplicate capture indices and script digest mismatches',async t=>{
  const f=fixture(t),p=join(f.source,'Mixed','capture','run.json'),run=read(p);run.steps.push(run.steps[0]);put(p,run);
  await assert.rejects(archiveAutomationInputs(f),/capture_invalid_index/);
  run.steps.pop();put(p,run);f.jobs[0].scriptHash='bad';f.save();
  await assert.rejects(archiveAutomationInputs(f),/script_changed_since_capture/);
});

test('readback verifier rejects mutated original sources and altered archived files',async t=>{
  const f=fixture(t),r=await archiveAutomationInputs(f),path=f.jobs[0].steps[0].evidence.today,bytes=readFileSync(path);
  writeFileSync(path,'mutated');await assert.rejects(verifyAutomationInputs(r.manifestPath),/automation_input_source_changed/);
  assert.equal((await verifyAutomationInputs(r.manifestPath,{verifySources:false})).ready,true,'source pruning does not make durable evidence unreadable');
  writeFileSync(path,bytes);const jobPath=join(f.outDir,'Mixed','job.json');chmodSync(jobPath,0o600);writeFileSync(jobPath,'{}');
  await assert.rejects(verifyAutomationInputs(r.manifestPath),/automation_input_archive_changed/);
});

test('rejects preexisting output and changed persisted input job; does not overwrite',async t=>{
  const f=fixture(t);mkdirSync(f.outDir);writeFileSync(join(f.outDir,'sentinel'),'unchanged');
  await assert.rejects(archiveAutomationInputs(f),/output_exists/);assert.equal(readFileSync(join(f.outDir,'sentinel'),'utf8'),'unchanged');
  rmSync(f.outDir,{recursive:true});put(join(f.source,'Mixed','job.json'),{...f.jobs[0],status:'changed'});
  await assert.rejects(archiveAutomationInputs(f),/source_job_changed/);assert.equal(existsSync(f.outDir),false);
});

test('mutation during copying rejects the archive and never publishes a ready destination',async t=>{
  const f=fixture(t),original=f.jobs[0].steps[0].evidence.today;
  const rel=join('Mixed','captures',bytesDigest(Buffer.from(dirname(original))),bytesDigest(Buffer.from(original)).slice(0,16)+'-'+original.split('/').at(-1));
  let finished=false;
  const archive=archiveAutomationInputs(f).finally(()=>{finished=true;});
  const rejection=assert.rejects(archive,/automation_input_source_changed/);
  let mutated=false;
  for(let attempt=0;attempt<10000&&!finished;attempt++){
    const stage=readdirSync(f.root).find(n=>n.startsWith('.archive.staging-'));
    if(stage&&existsSync(join(f.root,stage,rel))){writeFileSync(original,'mutation after this source was copied');mutated=true;break;}
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(mutated,true,'the test actually changed an already-copied source');
  await rejection;assert.equal(existsSync(f.outDir),false);assert.ok(!readdirSync(f.root).some(n=>n.startsWith('.archive.staging-')));
});

test('no flagged claims archives the full context without copying any image bytes',async t=>{
  const f=fixture(t);for(const j of f.jobs)for(const s of j.steps)s.uiReleaseEvidence=null;f.save();
  f.selection=selectWeeklyJobs(f.jobs,{readScript:n=>f.scripts.get(n)});
  const r=await archiveAutomationInputs(f);
  assert.deepEqual(r.selection.review.flagged,[]);assert.deepEqual(read(r.parityPath).acceptedPairs,[]);
  assert.equal(r.manifest.files.some(file=>['current_image','recorded_image'].includes(file.kind)),false);
  assert.equal(r.jobs.length,f.jobs.length);
});

test('missing job origins are explicitly in-memory provenance; never presented as disk copies',async t=>{
  const f=fixture(t);delete f.summary.outDir;for(const row of f.summary.videos)delete row.job;
  for(const j of f.jobs)delete j.evidence.runDir;
  const r=await archiveAutomationInputs(f),entry=r.manifest.files.find(x=>x.relativePath==='Mixed/originaljob.json');
  assert.equal(entry.kind,'in_memory_original_job');assert.equal(entry.archiveFrom,undefined);
  assert.equal(read(join(f.outDir,'Mixed','job.json')).archiveFrom.origin,'caller_supplied_job_snapshot');
});

test('full batch names are mandatory and archives cannot target pruned scratch or original repo',async t=>{
  const f=fixture(t);f.summary.names.pop();await assert.rejects(archiveAutomationInputs(f),/batch_names_mismatch/);
  f.summary.names=f.jobs.map(j=>j.name);
  await assert.rejects(archiveAutomationInputs({...f,outDir:join(f.repo,'archive')}),/output_inside_repo/);
  await assert.rejects(archiveAutomationInputs({...f,outDir:join(homedir(),'.hermes','cache','scratch','not-durable-archive')}),/output_not_durable/);
});
