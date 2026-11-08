// Orchestration contracts use injected stages; these fixtures do not claim to decode/render real media.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {runWeekly} from '../../tools/drift/weekly.mjs';
import {runRepairAutomation,loadAutomaticResult,automationInputKey,parseAutomationArgs,automationExecutionVersion,defaultAutomationDeps} from '../../tools/drift/automation.mjs';
import {selectWeeklyJobs,selectionMarker} from '../../tools/drift/ui-selection.mjs';
import {prepareSubmissions} from '../../tools/drift/weekly-submit.mjs';
import {sha256File} from '../../tools/drift/publish.mjs';
import {digest} from '../../tools/drift/contracts.mjs';
import {confirmedRelease} from './release-fixture.mjs';
const write=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v));};
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
test('automation CLI never substitutes the first flag for absent optional arguments',()=>{
  const parsed=parseAutomationArgs(['--run','/saved/run','--out','/new/output']);
  assert.equal(parsed.runDir,'/saved/run');assert.equal(parsed.outDir,'/new/output');
  assert.equal(parsed.settings.binary,undefined);assert.equal(parsed.settings.maxModelCalls,undefined);
  const capped=parseAutomationArgs(['--run','/saved/run','--max-model-calls','0','--codex-bin','/installed/codex']);
  assert.equal(capped.settings.maxModelCalls,0);assert.equal(capped.settings.binary,'/installed/codex');
  for(const args of [['--run'],['--run','--out','x'],['--run','x','--max-model-calls','-1'],['--run','x','--codex-bin'],['--run','x','--run','y'],['--run','x','--unknown','y']])assert.throws(()=>parseAutomationArgs(args));
});
function fixture(t){
  const root=fs.mkdtempSync(join(homedir(),'.hermes/cache/scratch/automation-wiring-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const jobs=[],scripts={},names=['Simple-video','Data-only-video'];
  for(const [index,name]of names.entries()){
    const script={name,recording:{id:'fixture-'+index},steps:[{index:0,action:'navigate',url:'https://app.hadrius.com/rules?company_id=1150',narration:'Open the Rules page.',media:{pre:'s.png'}}]};
    const scriptPath=join(root,'scripts',name+'.script.json');write(scriptPath,script);scripts[name]=script;
    const job={name,status:'ok',scriptPath,scriptHash:digest(script),verdict:index?'unchanged_with_data_drift':'slide_update',complete:true,steps:[{index:0,action:'navigate',verdict:index?'unchanged_with_data_drift':'slide_update',reasons:index?[]:[{code:'ui_changed',verdict:'slide_update'}],
      uiContext:{route:script.steps[0].url,slideText:script.steps[0].narration},uiReleaseEvidence:index?null:confirmedRelease(),evidence:{recorded:join(root,name+'-old.png'),today:join(root,name+'-new.png')}}]};
    fs.writeFileSync(job.steps[0].evidence.recorded,'fixture recorded');fs.writeFileSync(job.steps[0].evidence.today,'fixture current');jobs.push(job);
  }
  const selection=selectWeeklyJobs(jobs,{readScript:n=>scripts[n]}),out=join(root,'weekly');fs.mkdirSync(out);
  const summary={names,videos:names.map(name=>({name})),finishedAt:'2026-11-02T00:00:00Z',uiSelection:selectionMarker(selection)};
  return {root,jobs,scripts,selection,summary,out,settings:{stateRoot:join(root,'state'),binary:'/injected/model'}};
}
function stages(f){
  const calls={archive:0,review:0,render:0,qa:0};
  const deps={
    archive:async({outDir})=>{calls.archive++;for(const j of f.jobs){write(join(outDir,j.name,'job.json'),j);write(join(outDir,'scripts',j.name+'.script.json'),f.scripts[j.name]);}write(join(outDir,'summary.json'),f.summary);write(join(outDir,'selection-parity.json'),{acceptedPairs:['Simple-video#0'],selectedClaims:f.selection.review.flagged.map(v=>({name:v.name,slides:v.slides.map(s=>({index:s.index,changes:s.changes}))}))});write(join(outDir,'automation-inputs.json'),{ready:true});},
    verifyArchive:async()=>true,
    flow:()=>{throw new Error('not needed');},
    review:async({outDir,priorReports})=>{calls.review++;const report={rows:[],counts:{ready:1},budget:{requestedCalls:priorReports.length?0:2}};write(join(outDir,'report.json'),report);return report;},
    prepare:async({outDir})=>{for(const j of f.jobs)write(join(outDir,j.name,'job.json'),j);return {approvedPairs:['Simple-video#0'],videos:[{name:'Simple-video',candidatePath:outDir,repair:{decision:'auto',actions:[{index:0}],blockers:[]}}]};},
    route:({selection,renderError,baselineError})=>({status:renderError||baselineError?'setup_required':selection?.status==='selected'?'automatic_repair':'no_change'}),
    baseline:async()=>{const directory=join(f.root,'baseline');write(join(directory,'baseline-manifest.json'),{testFixture:true});return {directory,sourceSnapshot:{buildDir:join(directory,'source/_build')}};},
    render:async({outDir,baselineInputs})=>{assert.equal(baselineInputs.buildDir,join(f.root,'baseline/source/_build'));calls.render++;fs.mkdirSync(join(outDir,'repair'),{recursive:true});const candidate=join(outDir,'repair/candidate.mp4');fs.writeFileSync(candidate,'injected unit fixture, not actual media');write(join(outDir,'repair/verification.json'),{injected:true,candidate,candidate_sha256:sha256File(candidate)});return {candidate,sha256:sha256File(candidate),verification:join(outDir,'repair/verification.json')};},
    certify:async()=>{calls.qa++;return {ok:true,kind:'injected-unit-test-certificate'};},
  };
  return {calls,deps};
}

test('one weekly stage prepares/renders/QA/retains simple changes and reuses the verified artifact on resume',async t=>{
  const f=fixture(t),{calls,deps}=stages(f),options={jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,selection:f.selection,settings:f.settings,deps};
  const first=await runRepairAutomation(options);assert.equal(first.rows[0].status,'automatically_repaired');assert.equal(first.rows[1].status,'no_change');
  assert.deepEqual(first.counts,{automatically_repaired:1,no_change:1});assert.equal(first.posts,0);assert.equal(first.uploads,0);assert.equal(first.humanQueue.length,0);
  assert.ok(fs.existsSync(first.rows[0].result.candidate));
  const second=await runRepairAutomation(options);assert.equal(second.rows[0].reused,true);assert.equal(calls.archive,1);assert.equal(calls.render,1);assert.equal(calls.qa,1);
  fs.writeFileSync(second.rows[0].result.candidate,'tampered');
  assert.equal(loadAutomaticResult(join(dirname(second.rows[0].result.candidate),'result.json'),{inputKey:first.inputKey,baselineManifestHash:sha256File(join(f.root,'baseline/baseline-manifest.json'))}),null);
  const retry=await runRepairAutomation(options);assert.equal(retry.rows[0].reused,false);assert.equal(calls.render,2);
  const afterRetry=await runRepairAutomation(options);assert.equal(afterRetry.rows[0].reused,true);assert.equal(calls.render,2);
});

test('a QA upgrade recertifies intact same-plan visual artifacts instead of rendering them again',async t=>{
  const f=fixture(t),s=stages(f),options={jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,settings:f.settings,deps:s.deps};
  await runRepairAutomation(options);fs.mkdirSync(join(f.root,'renderer'));fs.writeFileSync(join(f.root,'renderer/drift_update.py'),'# reviewed renderer upgrade');
  const second=await runRepairAutomation(options);assert.equal(second.rows[0].status,'automatically_repaired');
  assert.equal(second.rows[0].recertified,true);assert.equal(s.calls.render,1);assert.equal(s.calls.qa,2);
});

test('changed approved narration plan cannot reuse an older candidate under identical capture inputs',async t=>{
  const f=fixture(t),s=stages(f),options={jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,settings:f.settings,deps:s.deps};
  const first=await runRepairAutomation(options);assert.equal(first.rows[0].reused,false);
  const prepare=s.deps.prepare;s.deps.prepare=async o=>{const result=await prepare(o);result.videos[0].repair.actions[0].newNarration='Open the renamed Rules tab.';return result;};
  const second=await runRepairAutomation(options);assert.equal(second.rows[0].reused,false);assert.equal(s.calls.render,2);
});

test('model/provider failure remains an operational hold and never creates a human re-record job',async t=>{
  const f=fixture(t),s=stages(f);s.deps.review=async()=>{throw new Error('provider_unavailable');};
  const report=await runRepairAutomation({jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,settings:f.settings,deps:s.deps});
  assert.equal(report.stageError,'provider_unavailable');assert.equal(report.humanQueue.length,0);assert.equal(s.calls.render,0);
});

test('stale full-batch selection and changed evidence invalidate reuse',async t=>{
  const f=fixture(t),{deps}=stages(f),before=automationInputKey({jobs:f.jobs,selection:f.selection,repo:f.root});
  fs.writeFileSync(f.jobs[0].steps[0].evidence.today,'changed current evidence');
  assert.notEqual(automationInputKey({jobs:f.jobs,selection:f.selection,repo:f.root}),before);
  await assert.rejects(()=>runRepairAutomation({jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,settings:f.settings,deps,selection:{...f.selection,inputHash:'stale'}}),/stale_selection/);
});

test('renderer upgrades invalidate certificates without discarding the bound evidence key',t=>{
  const f=fixture(t),before=automationInputKey({jobs:f.jobs,selection:f.selection,repo:f.root}),execution=automationExecutionVersion({repo:f.root});
  fs.mkdirSync(join(f.root,'renderer'),{recursive:true});fs.writeFileSync(join(f.root,'renderer/drift_update.py'),'# upgraded renderer');
  assert.equal(automationInputKey({jobs:f.jobs,selection:f.selection,repo:f.root}),before);
  assert.notEqual(automationExecutionVersion({repo:f.root}),execution);
});

test('weekly submission sends only human-required rows, never automatic repairs or missing-evidence holds',t=>{
  const f=fixture(t);for(const j of f.jobs)write(join(f.out,j.name,'job.json'),j);
  const reportPath=join(f.out,'automation-report.json');
  f.summary.automation={status:'finished',report:reportPath};
  const report={schema:1,finishedAt:'2026-11-02T00:00:00Z',sourceSelectionInputHash:f.selection.inputHash,names:f.summary.names,selectedPairs:['Simple-video#0'],rows:f.summary.names.map(name=>({name,status:name==='Simple-video'?'evidence_pending':'no_change'}))};
  const io={readJson:p=>{try{return read(p);}catch{return null;}},readScript:n=>f.scripts[n],readAssembly:()=>null};
  write(reportPath,report);let rows=prepareSubmissions({summary:f.summary,runDir:f.out,io});
  assert.equal(rows[0].decision,'skip');assert.equal(rows[0].reason,'evidence_pending');
  report.rows[0].status='automatically_repaired';write(reportPath,report);rows=prepareSubmissions({summary:f.summary,runDir:f.out,io});assert.equal(rows[0].decision,'skip');
  report.rows[0].status='human_required';write(reportPath,report);rows=prepareSubmissions({summary:f.summary,runDir:f.out,io});assert.equal(rows[0].decision,'post');
  // A change the automation can't make is posted as a re-record for a person, never as an approvable auto_update.
  assert.equal(rows[0].kind,'manual_rerecord');assert.equal(rows[0].payload.details.execution,undefined);assert.ok(rows[0].payload.details.rerecordReason.some(r=>/re-record/.test(r)));
  report.sourceSelectionInputHash='wrong source';write(reportPath,report);rows=prepareSubmissions({summary:f.summary,runDir:f.out,io});assert.equal(rows[0].reason,'automation_report_unverified');
});

test('source-flow replay binds the exact capture directory and byte-identical original script',async t=>{
  const f=fixture(t),s=stages(f);f.jobs[0].steps[0].reasons.push({code:'flow_changed',verdict:'unverified'});
  write(join(f.root,'run.json'),{scriptPath:f.jobs[0].scriptPath});
  const archive=s.deps.archive;s.deps.archive=async o=>{await archive(o);const path=join(o.outDir,f.jobs[0].name,'job.json'),job=read(path);job.scriptPath=join(o.outDir,'scripts',job.name+'.script.json');write(path,job);};
  let checked=0;s.deps.flow=({jobPath})=>{const job=read(jobPath);
    assert.equal(job.scriptPath,f.jobs[0].scriptPath);assert.equal(job.evidence.runDir,f.root);
    assert.equal(sha256File(job.steps[0].evidence.recorded),sha256File(f.jobs[0].steps[0].evidence.recorded));checked++;return {verified:false,reasons:['unsupported_flow']};};
  await runRepairAutomation({jobs:f.jobs,summary:f.summary,outDir:f.out,repo:f.root,settings:f.settings,deps:s.deps});
  assert.equal(checked,1);
});

test('normal pipeline dispatches changed narration to the strict narration certifier',async()=>{
  const result=await defaultAutomationDeps().certify({result:{narrationChanged:true}});
  assert.equal(result.policy,'automatic-narration-qa-v1');assert.equal(result.ok,false);
});

test('runWeekly invokes automation once after full-batch finalization and passes the shared budget',async t=>{
  const f=fixture(t),name='Data-only-video',recordingsRoot=join(f.root,'recordings');fs.mkdirSync(join(recordingsRoot,f.scripts[name].recording.id),{recursive:true});
  let seen=0,captureLimits;const budget={usage:{calls:0,cacheHits:0,budgetSkipped:0,maxCalls:3}};
  const deps={recordingsRoot,readScript:n=>({path:join(f.root,'scripts',n+'.script.json'),script:f.scripts[n]}),bridgeStatus:async()=>null,
    capture:async o=>{captureLimits=o.limits;write(join(o.outDir,'run.json'),{steps:[]});return {status:'captured',steps:[]};},compare:async()=>({}),
    classify:async()=>({verdict:'unchanged',complete:true,steps:[],reasons:[]}),reviewBudget:budget,
    repairAutomation:async o=>{seen++;assert.equal(o.selection.names.length,1);assert.ok(o.summary.finishedAt);assert.equal(o.budget,budget);return {policy:'test',counts:{no_change:1}};}};
  const summary=await runWeekly({names:[name],outDir:join(f.root,'normal-weekly'),deps,log:()=>{},timeoutMs:15*60_000});
  assert.equal(seen,1);assert.equal(summary.automation.status,'finished');assert.equal(captureLimits.totalMs,14*60_000);
  await runWeekly({names:[name],outDir:join(f.root,'disabled-weekly'),deps,log:()=>{},autoRepair:false});assert.equal(seen,1);
});
