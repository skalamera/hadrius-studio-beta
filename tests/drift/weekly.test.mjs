// Weekly orchestration (tools/drift/weekly.mjs) with injected fake capture/compare/classify/candidate:
// no browser, no network, no claude. Synthetic scripts and PNGs under TMPDIR only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {runWeekly,runVideo,parseNames,stableId,identifiedCopy,buildManifest,defaultDeps,detectionReviewSettings,main} from '../../tools/drift/weekly.mjs';
import {createCandidate} from '../../tools/drift/candidate.mjs';
import {digest} from '../../tools/drift/contracts.mjs';
import {confirmedRelease,candidateRelease} from './release-fixture.mjs';
import {runCodexReview} from '../../tools/drift/codex-review.mjs';
import {prepareSubmissions} from '../../tools/drift/weekly-submit.mjs';
import {resolveInputs,buildChangeManifest} from '../../tools/drift/executor.mjs';

function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(t,d){const n=Buffer.from(t),l=Buffer.alloc(4),s=Buffer.alloc(4);l.writeUInt32BE(d.length);s.writeUInt32BE(crc(Buffer.concat([n,d])));return Buffer.concat([l,n,d,s]);}
function png(v){const w=4,h=4,rows=[];for(let y=0;y<h;y++){const r=Buffer.alloc(1+w*3,v);r[0]=0;rows.push(r);}const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);}

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'drift-weekly-'));const rec=join(root,'_recordings');
  const scripts={};
  for(const [name,rid] of [['Vid-A','rec-a'],['Vid-B','rec-b'],['Vid-Archive','rec-c'],['Vid-Crash','rec-d']]){
    mkdirSync(join(rec,rid),{recursive:true});
    const steps=[0,1].map(i=>{writeFileSync(join(rec,rid,`s${i}.png`),png(10+i));return {index:i,action:i?'click':'navigate',url:'https://app.hadrius.com/a?company_id=1150',media:{pre:`s${i}.png`},narration:`n${i}`,
      ...(i?{target:{role:name==='Vid-Archive'?'menuitem':'button',tag:'button',name:name==='Vid-Archive'?'Archive':'Open',hint:{bbox:{x:1,y:1,w:5,h:5}}}}:{})};});
    scripts[name]={name,title:name,recording:{id:rid},environment:{startUrl:'https://app.hadrius.com/a?company_id=1150'},steps};
  }
  return {root,rec,scripts};
}
function fakeDeps(fx,{verdicts={},calls=[]}={}){
  const release=confirmedRelease();
  return {
    recordingsRoot:fx.rec,judge:null,bridgeStatus:async()=>({running:false}),
    readScript:(n)=>fx.scripts[n]?{path:join(fx.root,`${n}.script.json`),script:fx.scripts[n]}:null,
    capture:async({scriptPath,outDir,profileDir,tenant})=>{calls.push(['capture',scriptPath,tenant,profileDir]);const name=scriptPath.split('/').pop().replace('.script.json','');
      if(name==='Vid-Crash')throw new Error('browser exploded');
      mkdirSync(outDir);const stop=name==='Vid-Archive';
      writeFileSync(join(outDir,'step-00-today.png'),png(99));if(!stop)writeFileSync(join(outDir,'step-01-today.png'),png(98));
      const run={status:stop?'captured_partial_mutation_guard':'captured',mutationStop:stop?{index:1,reason:'name_matches:archive'}:null,
        steps:[{index:0,screenshot:'step-00-today.png',visibleText:'Open\nNew rule'},{index:1,screenshot:stop?undefined:'step-01-today.png',visibleText:stop?undefined:'Open\nRisk level',target:{rect:{x:9,y:9,w:5,h:5}},mutationGuard:stop?{status:'needs_fixture'}:null}]};
      writeFileSync(join(outDir,'run.json'),JSON.stringify(run));
      writeFileSync(join(outDir,'requests.json'),JSON.stringify({nonGet:[{method:'POST',url:'https://hadriusapi.com/api/users/analytics/1/track-event/',decision:'block',reason:'unclassified_post'}]}));return run;},
    compare:async({runDir})=>{calls.push(['compare',runDir]);writeFileSync(join(runDir,'compare.json'),'{}');return {contactSheet:'contact-sheet.png'};},
    releaseEvidence:async()=>({summary:{status:'confirmed'},byStep:{0:release}}),
    // Only slides with release evidence change; the rest are pixel-unchanged (a clean selective-repair case).
    classify:async({runDir,script,releaseEvidence})=>{calls.push(['classify',script.name]);const v0=verdicts[script.name]??'unchanged';
      const steps=script.steps.map(s=>{const v=!releaseEvidence||releaseEvidence?.byStep?.[s.index]?v0:'unchanged';return {index:s.index,action:s.action,verdict:s.index===1&&script.name==='Vid-Archive'?'unverified':v,
        reasons:v==='slide_update'?[{verdict:'slide_update',code:'ui_changed',detail:'fake UI release'}]:v==='full_rerecord'?[{verdict:'full_rerecord',code:'page_redesigned',detail:'fake UI release'}]:[],
        uiReleaseEvidence:releaseEvidence?.byStep?.[s.index]??null,chromeChanged:false,evidence:{today:existsSync(join(runDir,`step-0${s.index}-today.png`))?join(runDir,`step-0${s.index}-today.png`):null}};});
      const v=steps.some(s=>s.verdict===v0)?v0:'unchanged';
      return {verdict:v,complete:script.name!=='Vid-Archive',summary:`fake ${v}`,reasons:[],steps};},
    candidate:createCandidate,
  };
}

test('parseNames: --names and allowlist (lines/JSON), dedupe, rejects internal and unsafe names', () => {
  assert.deepEqual(parseNames({names:'A, B,A'}),['A','B']);
  assert.deepEqual(parseNames({allowlistText:'# weekly\nA\nB # comment\n'}),['A','B']);
  assert.deepEqual(parseNames({allowlistText:'["A",{"name":"C"}]'}),['A','C']);
  assert.throws(()=>parseNames({names:'_studio-coverage'}),/internal_record/);
  assert.throws(()=>parseNames({names:'../etc'}),/invalid_name/);
});
test('stableId/identifiedCopy are deterministic and keep existing IDs', () => {
  assert.equal(stableId('a','b'),stableId('a','b'));assert.notEqual(stableId('a','b'),stableId('a','c'));
  assert.match(stableId('x'),/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const s={name:'N',recording:{id:'r'},steps:[{index:0},{index:1,id:'keep'}]};
  const a=identifiedCopy(s),b=identifiedCopy(s);assert.deepEqual(a,b);assert.equal(a.steps[1].id,'keep');assert.equal(s.steps[0].id,undefined,'source untouched');
});
test('buildManifest: only candidate verdicts with a today screenshot; moved_highlight changes geometry only', () => {
  const fx=fixture();const base=identifiedCopy(fx.scripts['Vid-A']);const p=join(fx.root,'t.png');writeFileSync(p,png(5));
  const {manifest,skipped}=buildManifest({base,classification:{steps:[{index:0,verdict:'unchanged',evidence:{today:p}},{index:1,verdict:'moved_highlight',todayRect:{x:9,y:9,w:5,h:5},evidence:{today:p}}]}});
  assert.equal(manifest.baseHash,digest(base));assert.equal(manifest.changes.length,1);assert.deepEqual(manifest.changes[0].target.hint.bbox,{x:9,y:9,w:5,h:5});
  assert.equal(manifest.changes[0].target.name,'Open');assert.deepEqual(skipped,[]);
});
test('runWeekly: concurrency 1, one failure does not stop the run, job records + summary, candidates only in scratch', async () => {
  const fx=fixture();const calls=[];const out=join(fx.root,'weekly-out');
  const s=await runWeekly({names:['Vid-A','Vid-Crash','Vid-B','Vid-Archive','Missing'],outDir:out,deps:fakeDeps(fx,{verdicts:{'Vid-A':'slide_update','Vid-B':'full_rerecord'},calls}),log:()=>{}});
  assert.deepEqual(calls.filter(c=>c[0]==='capture').map(c=>c[1].split('/').pop()),['Vid-A.script.json','Vid-Crash.script.json','Vid-B.script.json','Vid-Archive.script.json']);
  const by=Object.fromEntries(s.videos.map(v=>[v.name,v]));
  assert.equal(by['Vid-A'].status,'ok');assert.equal(by['Vid-A'].verdict,'slide_update');assert.ok(by['Vid-A'].candidatePath.startsWith(out));
  assert.ok(existsSync(join(by['Vid-A'].candidatePath,'candidate.script.json')));
  assert.equal(by['Vid-Crash'].status,'error');
  assert.equal(by['Vid-B'].verdict,'full_rerecord');assert.equal(by['Vid-B'].candidatePath,null,'no candidate for a re-record');
  assert.equal(by['Vid-Archive'].mutationStop.index,1);assert.equal(by['Vid-Archive'].verdict,'unchanged');
  assert.equal(by.Missing.status,'script_not_found');
  for (const n of ['Vid-A','Vid-Crash','Vid-B','Vid-Archive','Missing'])assert.ok(existsSync(join(out,n,'job.json')),n);
  const jobA=JSON.parse(readFileSync(join(out,'Vid-A','job.json'),'utf8'));
  assert.equal(jobA.nonGetRequests.length,1);assert.ok(jobA.timings.capture>=0&&jobA.timings.total>=0);assert.equal(jobA.candidate.renderReady,false);
  const sum=JSON.parse(readFileSync(join(out,'summary.json'),'utf8'));assert.equal(sum.videos.length,5);assert.ok(sum.finishedAt);
  const io={readJson:p=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null,readScript:n=>fx.scripts[n],readAssembly:()=>null};
  // Posting path: no certified preview video yet, so nothing is offered for approval.
  const posted=prepareSubmissions({summary:sum,runDir:out,io}).find(r=>r.name==='Vid-A');
  assert.equal(posted.decision,'skip');assert.equal(posted.reason,'no_certified_preview');
  // Eligibility path (what the automatic repair renders): the same row is an auto_update candidate.
  const rows=prepareSubmissions({summary:sum,runDir:out,io,requireCertifiedPreview:false});
  const row=rows.find(r=>r.name==='Vid-A');assert.equal(row.decision,'post');assert.equal(row.payload.kind,'auto_update');
  mkdirSync(join(fx.root,'out','Vid-A','_build'),{recursive:true});
  const inputs=resolveInputs(row.payload,{repo:fx.root});
  assert.equal(inputs.identifiedScript,jobA.candidateInputs.identifiedScript);
  const executable=buildChangeManifest(row.payload,inputs,'b'.repeat(64));
  assert.deepEqual(executable.changes.map(c=>c.stepId),[identifiedCopy(fx.scripts['Vid-A']).steps[0].id]);
  assert.equal(rows.find(r=>r.name==='Vid-B').payload.kind,'manual_rerecord');
  assert.equal(rows.find(r=>r.name==='Vid-B').payload.details.execution,undefined);
  // the candidate's base is the stable-ID LOCAL copy, never the fixture script
  assert.equal(fx.scripts['Vid-A'].steps[0].id,undefined);
});
test('runWeekly: missing production release provider fails closed and creates no UI candidate', async () => {
  const fx=fixture();const deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}});delete deps.releaseEvidence;
  const out=join(fx.root,'weekly-no-release');
  const s=await runWeekly({names:['Vid-A'],outDir:out,deps,log:()=>{}});
  const j=JSON.parse(readFileSync(join(out,'Vid-A','job.json'),'utf8'));
  assert.equal(s.videos[0].verdict,'slide_update');assert.equal(s.videos[0].candidatePath,null);
  assert.deepEqual(j.releaseEvidence,{status:'unavailable'});
});
test('runWeekly: a mutating-looking request that got through discards the video', async () => {
  const fx=fixture();const deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}});const cap=deps.capture;
  deps.capture=async(a)=>{const r=await cap(a);writeFileSync(join(a.outDir,'requests.json'),JSON.stringify({nonGet:[{method:'POST',url:'https://hadriusapi.com/api/policies/1/archive/',decision:'allow_logged'}]}));return r;};
  const s=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'o2'),deps,log:()=>{}});
  assert.equal(s.videos[0].status,'aborted_mutating_request');assert.equal(s.videos[0].candidatePath,null);
});
test('runWeekly (rehearsal default): capture gets rehearse:true; a write blocked during rehearsal does not discard the video', async () => {
  const fx=fixture();const deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}});const cap=deps.capture;const seen=[];
  deps.capture=async(a)=>{seen.push(a.rehearse);const r=await cap(a);
    writeFileSync(join(a.outDir,'requests.json'),JSON.stringify({nonGet:[{method:'PATCH',url:'https://hadriusapi.com/api/im/providers/draft/1/',decision:'abort',reason:'app_write_method',tolerated:true}]}));return r;};
  const s=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'o-rh'),deps,log:()=>{}});
  assert.deepEqual(seen,[true]);assert.notEqual(s.videos[0].status,'aborted_mutating_request');
  const job=JSON.parse(readFileSync(join(fx.root,'o-rh','Vid-A','job.json'),'utf8'));assert.equal(job.rehearsalBlockedWrites.length,1);assert.equal(job.mutatingRequests,undefined);
  // The same abort without the rehearsal marker still discards the video.
  const deps2=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}});const cap2=deps2.capture;
  deps2.capture=async(a)=>{const r=await cap2(a);writeFileSync(join(a.outDir,'requests.json'),JSON.stringify({nonGet:[{method:'PATCH',url:'https://hadriusapi.com/api/x/1/',decision:'abort'}]}));return r;};
  const s2=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'o-rh2'),deps:deps2,log:()=>{}});
  assert.equal(s2.videos[0].status,'aborted_mutating_request');
});
test('runWeekly: per-video timeout is recorded and the run continues', async () => {
  const fx=fixture();const deps=fakeDeps(fx);const cap=deps.capture;
  deps.capture=async(a)=>a.scriptPath.includes('Vid-A')?new Promise(()=>{}):cap(a);
  const s=await runWeekly({names:['Vid-A','Vid-B'],outDir:join(fx.root,'o3'),deps,timeoutMs:200,log:()=>{}});
  assert.equal(s.videos[0].status,'timeout');assert.equal(s.videos[1].status,'ok');
});
test('runWeekly: dry run touches no browser and reports the static guard plan; refuses existing/in-repo output', async () => {
  const fx=fixture();const calls=[];
  const s=await runWeekly({names:['Vid-Archive'],outDir:join(fx.root,'o4'),dryRun:true,deps:fakeDeps(fx,{calls}),log:()=>{}});
  assert.equal(calls.length,0);assert.equal(s.videos[0].status,'dry_run');assert.match(s.videos[0].summary,/stop at step 1 \(name_matches:archive\)/);
  await assert.rejects(runWeekly({names:['Vid-A'],outDir:join(fx.root,'o4'),deps:fakeDeps(fx),log:()=>{}}),/output_exists/);
  await assert.rejects(runWeekly({names:['Vid-A'],outDir:new URL('../../out/weekly-test-should-not-exist',import.meta.url).pathname,deps:fakeDeps(fx),log:()=>{}}),/output_inside_repo/);
});

test('parseNames: per-tenant allowlist object runs academy + sandbox, never unknown/conflict', () => {
  const o=JSON.stringify({schema:2,academy:[{name:'A1'}],sandbox:[{name:'S1'},'S2'],unknown:[{name:'U1'}],conflict:[{name:'C1'}]});
  assert.deepEqual(parseNames({allowlistText:o}),['A1','S1','S2']);
  assert.deepEqual(parseNames({allowlistText:o,tenants:['sandbox']}),['S1','S2']);
  assert.throws(()=>parseNames({allowlistText:o,tenants:['nope']}),/unknown_tenant/);
});
test('runWeekly: tenant per video from the script; Sandbox uses its own profile; unknown/conflict skipped, never captured', async () => {
  const fx=fixture();const calls=[];
  const mk=(name,url)=>{const s=structuredClone(fx.scripts['Vid-B']);s.name=name;s.environment.startUrl=url;s.steps.forEach(st=>{st.url=url;});return s;};
  fx.scripts['Sbx']=mk('Sbx','https://app.hadrius.com/marketing/export?company_id=1048');
  fx.scripts['NoCo']=mk('NoCo','https://app.hadrius.com/marketing/export');
  fx.scripts['Both']=mk('Both','https://app.hadrius.com/a?company_id=1150');fx.scripts['Both'].steps[1].url='https://app.hadrius.com/a?company_id=1048';
  fx.scripts['Other']=mk('Other','https://app.hadrius.com/a?company_id=777');
  const s=await runWeekly({names:['Vid-B','Sbx','NoCo','Both','Other'],outDir:join(fx.root,'o5'),deps:fakeDeps(fx,{calls}),log:()=>{}});
  const by=Object.fromEntries(s.videos.map(v=>[v.name,v]));
  const caps=calls.filter(c=>c[0]==='capture');
  assert.deepEqual(caps.map(c=>[c[1].split('/').pop(),c[2],c[3].split('/').pop()]),[['Vid-B.script.json','academy','.browser-profile-drift'],['Sbx.script.json','sandbox','.browser-profile-drift-sandbox']]);
  assert.equal(by.Sbx.tenant,'sandbox');assert.equal(by['Vid-B'].tenant,'academy');
  assert.equal(by.NoCo.status,'tenant_unknown');assert.equal(by.Both.status,'tenant_conflict');assert.equal(by.Other.status,'tenant_unregistered');
  assert.deepEqual(s.tenantSkipped.map(x=>x.name),['NoCo','Both','Other']);
  const job=JSON.parse(readFileSync(join(fx.root,'o5','Both','job.json'),'utf8'));assert.deepEqual(job.tenant.companyIds,['1048','1150']);
});

test('runWeekly: release provider gets the capture time; classify gets the redesign judge', async () => {
  const fx = fixture(); const deps = fakeDeps(fx, { verdicts: { 'Vid-A': 'slide_update' } }); const seen = {};
  deps.releaseEvidence = async (a) => { seen.capturedAt = a.capturedAt; return { summary: { status: 'ok' }, byStep: {} }; };
  deps.redesignJudge = async () => null;
  const classify = deps.classify; deps.classify = async (a) => { seen.redesignJudge = a.redesignJudge; return classify(a); };
  await runWeekly({ names: ['Vid-A'], outDir: join(fx.root, 'weekly-captured-at'), deps, log: () => {} });
  assert.match(seen.capturedAt, /^\d{4}-\d{2}-\d{2}T/); assert.equal(seen.redesignJudge, deps.redesignJudge);
});

test('weekly selection: defer candidates until all pages are known; no additions or unused sidebar changes leak', async () => {
  const fx=fixture(), calls=[], deps=fakeDeps(fx,{calls}), names=['Page','FrameA','FrameB','Added','UsedFrame'];
  for(const name of names){
    const script=structuredClone(fx.scripts['Vid-A']);script.name=name;
    script.steps.forEach(s=>{s.url=`https://app.hadrius.com/${name}?company_id=1150`;s.narration=name==='UsedFrame'&&s.index===0?'Click Ask Hadrius':'Open the page';});
    fx.scripts[name]=script;
  }
  const moved={element:'sidebar',kind:'moved',before:'Ask Hadrius',after:'Ask Hadrius',commit:'c'.repeat(40),verified:true};
  const added={...moved,kind:'added',before:null,after:'Risk level'};
  const renamed=confirmedRelease().redesign.changes[0];
  let classified=0,candidates=0;
  deps.classify=async({script,runDir})=>{
    classified++;
    const changes=script.name==='Page'?[renamed,moved]:script.name==='Added'?[added]:[moved];
    return {verdict:'slide_update',complete:true,reasons:[],steps:script.steps.map(s=>({index:s.index,verdict:'slide_update',
      reasons:[{verdict:'slide_update',code:'ui_changed',detail:'raw diagnostics'}],
      uiReleaseEvidence:confirmedRelease({routePath:`/${script.name}`,redesign:{confirmed:true,changes:s.index===0?changes:[added],rejected:[]}}),
      evidence:{today:join(runDir,`step-0${s.index}-today.png`)}}))};
  };
  deps.candidate=async(args)=>{assert.equal(classified,names.length,'selection needs the whole run');candidates++;return createCandidate(args);};
  const out=join(fx.root,'batch-selection'), result=await runWeekly({names,outDir:out,deps,log:()=>{}});
  const jobs=result.videos.map(v=>JSON.parse(readFileSync(v.job,'utf8')));
  assert.deepEqual(jobs.filter(j=>j.candidatePath).map(j=>j.name),['Page','UsedFrame']);
  assert.equal(candidates,2);
  for(const j of jobs){
    assert.notEqual(j.uiSelection.status,'pending');
    if(j.candidatePath){
      const manifest=JSON.parse(readFileSync(join(out,j.name,'candidate-manifest.json'),'utf8'));
      assert.deepEqual(manifest.changes.map(c=>c.stepId),[identifiedCopy(fx.scripts[j.name]).steps[0].id]);
      assert.ok(existsSync(j.candidateInputs.identifiedScript));
      assert.equal(j.candidateInputs.candidateManifest,join(out,j.name,'candidate-manifest.json'));
    }
  }
  assert.equal(jobs[0].steps[0].uiReleaseEvidence.redesign.changes.length,2,'raw evidence retained');
  assert.deepEqual(jobs[0].uiSelection.slides.map(s=>s.index),[0]);
  const resumed=await runWeekly({names,outDir:out,deps,resume:true,log:()=>{}});
  assert.equal(classified,names.length,'resume did not recapture');assert.equal(candidates,2,'same scoped candidates reused');
  assert.deepEqual(resumed.videos.map(v=>v.candidatePath),result.videos.map(v=>v.candidatePath));
});

test('runVideo alone leaves selection pending and never creates a premature candidate', async () => {
  const fx=fixture(), deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}}), out=join(fx.root,'single');mkdirSync(out);
  deps.candidate=async()=>{throw new Error('premature candidate');};
  const j=await runVideo('Vid-A',{outDir:out,deps});
  assert.equal(j.candidatePath,null);assert.equal(j.uiSelection.status,'pending');
  assert.equal(j.candidateError,undefined);
});

test('a late capture completion cannot overwrite a timed-out job or enter finalized selection', async () => {
  const fx=fixture(),deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}}),cap=deps.capture,out=join(fx.root,'late-capture');
  deps.capture=async(a)=>{await new Promise(r=>setTimeout(r,50));return cap(a);};
  const result=await runWeekly({names:['Vid-A'],outDir:out,deps,timeoutMs:10,log:()=>{}});
  assert.equal(result.videos[0].status,'timeout');
  await new Promise(r=>setTimeout(r,100));
  const saved=JSON.parse(readFileSync(join(out,'Vid-A','job.json'),'utf8'));
  assert.equal(saved.status,'timeout');assert.equal(saved.candidatePath,null);
});

test('resume re-finalizes the whole batch and retires candidates made obsolete by third-page frame evidence', async () => {
  const fx=fixture(),names=['Vid-A','Vid-B','Vid-Archive'],routes=['/rules','/people','/policies'],calls=[];
  names.forEach((name,i)=>fx.scripts[name].steps.forEach(s=>s.url=`https://app.hadrius.com${routes[i]}?company_id=1150`));
  const deps=fakeDeps(fx,{verdicts:Object.fromEntries(names.map(n=>[n,'slide_update'])),calls});
  const change={kind:'moved',before:'Ask Hadrius',after:'Ask Hadrius',element:'sidebar item',commit:'c'.repeat(40),verified:true};
  deps.releaseEvidence=async({script})=>({summary:{status:'confirmed'},byStep:{0:confirmedRelease({routePath:new URL(script.steps[0].url).pathname,redesign:{confirmed:true,changes:[change],rejected:[]}})}});
  const out=join(fx.root,'resume-frame');
  const first=await runWeekly({names:names.slice(0,2),outDir:out,deps,log:()=>{}});
  assert.ok(first.videos.every(v=>v.candidatePath));calls.length=0;
  const resumed=await runWeekly({names,outDir:out,deps,resume:true,log:()=>{}});
  assert.equal(calls.filter(c=>c[0]==='capture').length,1,'only the new page is captured');
  assert.notEqual(resumed.uiSelection.inputHash,first.uiSelection.inputHash);
  for(const name of names){
    const j=JSON.parse(readFileSync(join(out,name,'job.json'),'utf8'));
    assert.equal(j.uiSelection.status,'skip');assert.equal(j.candidatePath,null);assert.equal(j.candidateInputs,undefined);
    assert.equal(existsSync(join(out,name,'candidate-manifest.json')),false,'no active stale manifest');
  }
  assert.ok(existsSync(join(out,names[0],'candidate-manifest.json.superseded-1')));
});

test('detection provider config defaults to Codex, isolates Claude settings, and allows explicit Claude opt-in', async () => {
  assert.deepEqual(detectionReviewSettings({},{}),{provider:'codex',model:'gpt-6.1-sol',effort:'medium'});
  const env={KBS_DECISION_MODEL:'claude-opus-5-5',KBS_DECISION_EFFORT:'max',KBS_CODEX_BIN:'/offline/codex'};
  assert.equal(detectionReviewSettings({},env).model,'gpt-6.1-sol');
  assert.equal(detectionReviewSettings({},env).effort,'medium');
  assert.deepEqual(detectionReviewSettings({provider:'claude'},env),{provider:'claude',model:'claude-opus-5-5',effort:'max',binary:'/offline/codex'});
  const configured=detectionReviewSettings({model:'gpt-6.1',effort:'high'}, {...env,KBS_DRIFT_REVIEW_PROVIDER:'codex',KBS_DRIFT_REVIEW_MODEL:'gpt-env',KBS_DRIFT_REVIEW_EFFORT:'low'});
  assert.equal(configured.model,'gpt-6.1');assert.equal(configured.effort,'high');
  assert.throws(()=>detectionReviewSettings({provider:'unknown'},{}),/invalid_review_provider/);
  assert.throws(()=>detectionReviewSettings({provider:'claude',model:'gpt-6.1'},{}),/invalid_review_claude_model/);
  assert.throws(()=>detectionReviewSettings({provider:'claude',effort:'high'},{}),/requires_KBS_DECISION_EFFORT/);
  for(const args of [['--review-provider','other'],['--review-model','claude-sonnet-5'],['--review-effort','max'],['--review-provider'],['--review-model','--dry-run']]){
    await assert.rejects(main(['--once','--names','A',...args]),/review_|requires a value/);
  }
  const claude=await defaultDeps({autoRepair:false,reviewSettings:{provider:'claude'}});
  assert.equal(claude.reviewProvider.status().provider,'claude-cli');assert.equal(typeof claude.judge,'function');
  const disabled=await defaultDeps({judge:false,reviewSettings:{provider:'invalid',resolveBinary:()=>{throw Error('discovery must remain lazy');}}});
  assert.equal(disabled.judge,null);assert.equal(disabled.redesignJudge,null);assert.equal(disabled.repairAutomation,null);
});

const narrationAnswer={accurate:true,claim_missing:false,data_missing:false,reason:'The New rule control is visible.',evidence:'New rule',suggested_rewrite:null};
const redesignAnswer={redesigned:true,reason:'The toolbar control was renamed.',changes:[{element:'toolbar button',kind:'renamed',before:'Create rule',after:'New rule',commit:'c'.repeat(12)}],data_differences:[]};
// Exercise defaultDeps + actual hardened adapter/checkpoints + real classify/release verification/selection.
// Only capture, release retrieval and the model subprocess are fake; no live model or browser is launched.
async function detectionFixture(t,{maxModelCalls=null,reviewCache=true,run=null,model='gpt-6.1-sol',effort='medium',shared=null}={}){
  const fx=shared??fixture();if(!shared)t.after(()=>rmSync(fx.root,{recursive:true,force:true}));
  const script=fx.scripts['Vid-A'];script.steps=script.steps.slice(0,1);script.steps[0].narration='Open New rule.';
  const calls=fx.modelCalls??=[];
  const deps=await defaultDeps({maxModelCalls,reviewCache,autoRepair:false,reviewSettings:{provider:'codex',model,effort,binary:'/offline/codex',cacheDir:join(fx.root,'reviews'),
    runReview:options=>runCodexReview({...options,run:run??(async(binary,args,opts)=>{
      const schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
      const kind=schema.properties.accurate?'narration':'redesign';calls.push({kind,binary,args,opts});
      writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(kind==='narration'?narrationAnswer:redesignAnswer));
      return {stdout:'',stderr:`model: ${model}\n`};
    })})}});
  const fake=fakeDeps(fx);
  Object.assign(deps,{readScript:fake.readScript,capture:fake.capture,recordingsRoot:fx.rec,bridgeStatus:async()=>null,exclusions:null,
    compare:async({runDir})=>{writeFileSync(join(runDir,'compare.json'),JSON.stringify({steps:[{index:0,classification:'screenshot_changed',todayScreenshot:'step-00-today.png',dimensions:{match:true},diffFractionNonDynamic:0.01,ssimMasked:0.97,regions:[]}]}));return {};},
    releaseEvidence:async()=>({summary:{status:'ok'},byStep:{0:candidateRelease()},excerpt:()=>'-"Create rule"\n+"New rule"',
      filesTouched:()=>candidateRelease().screenFiles,uiStringsAt:sha=>new Set(sha==='b'.repeat(40)?['new rule']:['create rule']),
      diffLabels:()=>({added:['New rule'],removed:['Create rule']})})});
  return {fx,deps,calls};
}

test('normal defaultDeps initial detection uses Codex for both reviews and keeps exact evidence/provenance through selection',async t=>{
  const {fx,deps,calls}=await detectionFixture(t,{maxModelCalls:2});
  const summary=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'default-detection'),deps,log:()=>{}});
  assert.deepEqual(calls.map(c=>c.kind),['redesign','narration']);
  assert.equal(summary.reviewUsage.calls,2);assert.equal(summary.reviewUsage.errors,0);assert.equal(summary.reviewProvider.provider,'codex-cli');
  assert.equal(summary.videos[0].status,'ok');assert.ok(summary.videos[0].candidatePath);
  const job=JSON.parse(readFileSync(summary.videos[0].job,'utf8'));
  for(const answer of [job.steps[0].judge,job.steps[0].uiReleaseEvidence.redesign.raw]){
    assert.equal(answer.provider,'codex-cli');assert.equal(answer.model,'gpt-6.1-sol');assert.equal(answer.effort,'medium');assert.match(answer.reviewId,/^[a-f0-9]{64}$/);
  }
  assert.equal(job.steps[0].uiReleaseEvidence.redesign.changes[0].verified,true);
  assert.deepEqual(job.uiSelection.slides.map(s=>s.index),[0]);
  assert.equal(calls[0].args.filter(a=>a.startsWith('--image=')).length,2);
  assert.equal(calls[1].args.filter(a=>a.startsWith('--image=')).length,1);
});

test('both cache tiers bypass the live budget, and provider/model/effort changes never reuse another reviewer',async t=>{
  const {fx,deps,calls}=await detectionFixture(t,{maxModelCalls:2});
  const first=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'cache-first'),deps,log:()=>{}});
  const reused=await detectionFixture(t,{maxModelCalls:0,shared:fx});
  const second=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'cache-second'),deps:reused.deps,log:()=>{}});
  assert.equal(second.videos[0].status,'ok');assert.equal(second.reviewUsage.calls,0);assert.equal(second.reviewUsage.cacheHits,2);assert.equal(calls.length,2);
  const original=JSON.parse(readFileSync(first.videos[0].job,'utf8')).steps[0].judge;
  const cached=JSON.parse(readFileSync(second.videos[0].job,'utf8')).steps[0].judge;
  assert.equal(cached.reviewId,original.reviewId);assert.equal(cached.createdAt,original.createdAt);
  // Bypass the outer cache to prove the adapter checkpoint, not just the wrapper, is free at cap zero.
  const checkpoint=await detectionFixture(t,{maxModelCalls:0,reviewCache:false,shared:fx});
  const answer=await checkpoint.deps.judge({title:'Vid-A',stepNumber:1,stepCount:1,action:'navigate',targetName:null,narration:'Open New rule.',
    todayPath:join(fx.root,'cache-first/Vid-A/capture/step-00-today.png'),todayTitle:null,todayUrl:null,todayText:'Open\nNew rule'});
  assert.equal(answer.cached,true);assert.equal(checkpoint.deps.reviewBudget.usage.calls,0);assert.equal(checkpoint.deps.reviewBudget.usage.cacheHits,1);
  for(const settings of [{model:'gpt-6.1'},{effort:'high'}]){
    const changed=await detectionFixture(t,{maxModelCalls:0,shared:fx,...settings});
    const held=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'changed-'+(settings.model??settings.effort)),deps:changed.deps,log:()=>{}});
    assert.equal(held.videos[0].status,'review_pending');assert.equal(held.videos[0].verdict,null);assert.equal(held.reviewUsage.calls,0);
  }
});

test('a one-call cap holds narration without caching pending answers; resume retries the held video',async t=>{
  const {fx,deps,calls}=await detectionFixture(t,{maxModelCalls:1}),outDir=join(fx.root,'capped');
  const held=await runWeekly({names:['Vid-A'],outDir,deps,log:()=>{}});
  assert.equal(held.videos[0].status,'review_pending');assert.equal(held.videos[0].verdict,null);assert.equal(held.videos[0].candidatePath,null);
  assert.equal(held.reviewUsage.calls,1);assert.equal(held.reviewUsage.budgetSkipped,1);assert.equal(calls.length,1);
  assert.deepEqual(held.reviewPending,[{name:'Vid-A',reasons:['review_budget_exhausted']}]);
  assert.equal(existsSync(join(fx.root,'reviews/narration'))?readdirSync(join(fx.root,'reviews/narration')).length:0,0);
  const next=await detectionFixture(t,{maxModelCalls:1,shared:fx});
  const resumed=await runWeekly({names:['Vid-A'],outDir,deps:next.deps,resume:true,log:()=>{}});
  assert.equal(resumed.videos[0].status,'ok');assert.ok(resumed.videos[0].candidatePath);assert.equal(calls.length,2);
  assert.equal(resumed.reviewUsage.calls,1);assert.equal(resumed.reviewUsage.cacheHits,1);
});

test('one provider auth failure holds the batch, never becomes unchanged, and never reaches candidate creation',async t=>{
  let invocations=0;
  const {fx,deps}=await detectionFixture(t,{run:async()=>{invocations++;throw new Error('401 Unauthorized: Not logged in');}});
  const summary=await runWeekly({names:['Vid-A','Vid-B'],outDir:join(fx.root,'auth-held'),deps,log:()=>{}});
  assert.equal(invocations,1);assert.equal(summary.reviewUsage.calls,1);assert.equal(summary.reviewProvider.state,'held');
  assert.equal(summary.reviewProvider.hold.reason,'review_provider_auth_unavailable');
  assert.deepEqual(summary.videos.map(v=>v.status),['review_pending','review_pending']);
  assert.deepEqual(summary.counts,{review_pending:2});assert.ok(summary.videos.every(v=>v.verdict===null&&v.candidatePath===null));
  const job=JSON.parse(readFileSync(summary.videos[0].job,'utf8'));
  assert.equal(job.steps[0].uiReleaseEvidence.reviewPending,'review_provider_auth_unavailable');
  assert.ok(existsSync(join(fx.root,'auth-held/Vid-A/capture/classify.json')),'raw classifier evidence preserved');
});

test('defaultDeps Codex claims cannot bypass deterministic commit-diff or UI-only selection gates',async t=>{
  const {fx,deps,calls}=await detectionFixture(t);
  const release=deps.releaseEvidence;
  deps.releaseEvidence=async()=>({...await release(),diffLabels:()=>({added:['Unrelated'],removed:[]})});
  const summary=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'unrelated-release'),deps,log:()=>{}});
  const job=JSON.parse(readFileSync(summary.videos[0].job,'utf8'));
  assert.equal(job.candidatePath,null);assert.equal(job.steps[0].uiReleaseEvidence.redesign.confirmed,false);
  assert.ok(job.steps[0].uiReleaseEvidence.redesign.rejected[0].why.includes('not_in_commit_diff'));
  assert.equal(calls.length,1,'unconfirmed page does not trigger weekly narration');
  assert.equal(job.steps[0].uiReleaseEvidence.redesign.raw.provider,'codex-cli');
});
