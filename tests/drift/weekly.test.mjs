// Weekly orchestration (tools/drift/weekly.mjs) with injected fake capture/compare/classify/candidate:
// no browser, no network, no claude. Synthetic scripts and PNGs under TMPDIR only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {runWeekly,parseNames,stableId,identifiedCopy,buildManifest} from '../../tools/drift/weekly.mjs';
import {createCandidate} from '../../tools/drift/candidate.mjs';
import {digest} from '../../tools/drift/contracts.mjs';

function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(t,d){const n=Buffer.from(t),l=Buffer.alloc(4),s=Buffer.alloc(4);l.writeUInt32BE(d.length);s.writeUInt32BE(crc(Buffer.concat([n,d])));return Buffer.concat([l,n,d,s]);}
function png(v){const w=4,h=4,rows=[];for(let y=0;y<h;y++){const r=Buffer.alloc(1+w*3,v);r[0]=0;rows.push(r);}const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);}

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'drift-weekly-'));const rec=join(root,'_recordings');
  const scripts={};
  for(const [name,rid] of [['Vid-A','rec-a'],['Vid-B','rec-b'],['Vid-Archive','rec-c'],['Vid-Crash','rec-d']]){
    mkdirSync(join(rec,rid),{recursive:true});
    const steps=[0,1].map(i=>{writeFileSync(join(rec,rid,`s${i}.png`),png(10+i));return {index:i,action:i?'click':'navigate',url:'https://app.hadrius.com/a',media:{pre:`s${i}.png`},narration:`n${i}`,
      ...(i?{target:{role:name==='Vid-Archive'?'menuitem':'button',tag:'button',name:name==='Vid-Archive'?'Archive':'Open',hint:{bbox:{x:1,y:1,w:5,h:5}}}}:{})};});
    scripts[name]={name,title:name,recording:{id:rid},environment:{startUrl:'https://app.hadrius.com/a'},steps};
  }
  return {root,rec,scripts};
}
function fakeDeps(fx,{verdicts={},calls=[]}={}){
  return {
    recordingsRoot:fx.rec,judge:null,bridgeStatus:async()=>({running:false}),
    readScript:(n)=>fx.scripts[n]?{path:join(fx.root,`${n}.script.json`),script:fx.scripts[n]}:null,
    capture:async({scriptPath,outDir})=>{calls.push(['capture',scriptPath]);const name=scriptPath.split('/').pop().replace('.script.json','');
      if(name==='Vid-Crash')throw new Error('browser exploded');
      mkdirSync(outDir);const stop=name==='Vid-Archive';
      writeFileSync(join(outDir,'step-00-today.png'),png(99));if(!stop)writeFileSync(join(outDir,'step-01-today.png'),png(98));
      const run={status:stop?'captured_partial_mutation_guard':'captured',mutationStop:stop?{index:1,reason:'name_matches:archive'}:null,
        steps:[{index:0,screenshot:'step-00-today.png'},{index:1,screenshot:stop?undefined:'step-01-today.png',target:{rect:{x:9,y:9,w:5,h:5}},mutationGuard:stop?{status:'needs_fixture'}:null}]};
      writeFileSync(join(outDir,'run.json'),JSON.stringify(run));
      writeFileSync(join(outDir,'requests.json'),JSON.stringify({nonGet:[{method:'POST',url:'https://hadriusapi.com/api/users/analytics/1/track-event/',decision:'block',reason:'unclassified_post'}]}));return run;},
    compare:async({runDir})=>{calls.push(['compare',runDir]);writeFileSync(join(runDir,'compare.json'),'{}');return {contactSheet:'contact-sheet.png'};},
    classify:async({runDir,script})=>{calls.push(['classify',script.name]);const v=verdicts[script.name]??'unchanged';
      const steps=script.steps.map(s=>({index:s.index,action:s.action,verdict:s.index===1&&script.name==='Vid-Archive'?'unverified':v,reasons:[],evidence:{today:existsSync(join(runDir,`step-0${s.index}-today.png`))?join(runDir,`step-0${s.index}-today.png`):null}}));
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
  // the candidate's base is the stable-ID LOCAL copy, never the fixture script
  assert.equal(fx.scripts['Vid-A'].steps[0].id,undefined);
});
test('runWeekly: a mutating-looking request that got through discards the video', async () => {
  const fx=fixture();const deps=fakeDeps(fx,{verdicts:{'Vid-A':'slide_update'}});const cap=deps.capture;
  deps.capture=async(a)=>{const r=await cap(a);writeFileSync(join(a.outDir,'requests.json'),JSON.stringify({nonGet:[{method:'POST',url:'https://hadriusapi.com/api/policies/1/archive/',decision:'allow_logged'}]}));return r;};
  const s=await runWeekly({names:['Vid-A'],outDir:join(fx.root,'o2'),deps,log:()=>{}});
  assert.equal(s.videos[0].status,'aborted_mutating_request');assert.equal(s.videos[0].candidatePath,null);
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
