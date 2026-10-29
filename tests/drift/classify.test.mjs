// Drift classifier (tools/drift/classify.mjs): pure decision rules on synthetic signals and synthetic PNGs,
// plus a read-only regression on the real pilot recapture (run4) when it exists on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {errorStateOf,emptyStateOf,classifyStepSignals,videoVerdict,chromeAnalysis,regionCoverage,parseJudge,buildJudgePrompt,worst,classifyRun,THRESHOLDS} from '../../tools/drift/classify.mjs';

const base={index:1,action:'navigate',narration:'This is the list.',hasScreenshot:true,compareClass:'unchanged',dimensionsMatch:true,targetStatus:null,
  routeChanged:false,flowChanged:false,metrics:{diff:0,ssimMasked:1,coverage:0},chromeChanged:false,chromeFraction:0,judge:null};
const sig=(o)=>({...base,...o,metrics:{...base.metrics,...(o.metrics||{})}});
const accurate={accurate:true,claim_missing:false,reason:'ok'};

test('worst() orders unchanged < slide_update < moved_highlight < narration_review < full_rerecord', () => {
  assert.equal(worst(['slide_update','unchanged']),'slide_update');
  assert.equal(worst(['moved_highlight','narration_review','slide_update']),'narration_review');
  assert.equal(worst(['full_rerecord','unchanged']),'full_rerecord');
  assert.equal(worst([]),'unchanged');
});
test('unchanged step stays unchanged and does not ask the judge', () => {
  const r=classifyStepSignals(sig({}));assert.equal(r.verdict,'unchanged');assert.equal(r.needsJudge,false);
});
test('small screenshot change + accurate narration = slide_update; unchecked narration = narration_review', () => {
  const s=sig({compareClass:'screenshot_changed',metrics:{diff:0.01,ssimMasked:0.95,coverage:0.05}});
  assert.equal(classifyStepSignals(s).verdict,'narration_review');
  assert.equal(classifyStepSignals(s).needsJudge,true);
  assert.equal(classifyStepSignals({...s,judge:accurate}).verdict,'slide_update');
  assert.equal(classifyStepSignals({...s,narration:''}).verdict,'slide_update');
  assert.equal(classifyStepSignals({...s,judge:{error:'cli down'}}).verdict,'narration_review');
});
test('judge: inaccurate = narration_review; claim no longer on screen = full_rerecord', () => {
  const s=sig({compareClass:'screenshot_changed',metrics:{diff:0.01,ssimMasked:0.95}});
  assert.equal(classifyStepSignals({...s,judge:{accurate:false,claim_missing:false,reason:'label renamed'}}).verdict,'narration_review');
  const r=classifyStepSignals({...s,judge:{accurate:false,claim_missing:true,reason:'ID gone'}});
  assert.equal(r.verdict,'full_rerecord');assert.ok(r.reasons.some(x=>x.code==='narration_contradicted'));
});
test('target geometry change = moved_highlight', () => {
  const r=classifyStepSignals(sig({action:'click',targetStatus:'resolved',targetMethod:'role_name',compareClass:'target_geometry_changed',targetDeltaMax:40,judge:accurate,metrics:{ssimMasked:0.97,diff:0.004}}));
  assert.equal(r.verdict,'moved_highlight');
});
test('missing/ambiguous target, route change, flow change, redesign => full_rerecord', () => {
  assert.equal(classifyStepSignals(sig({action:'click',targetStatus:'missing',compareClass:'target_missing'})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({action:'click',targetStatus:'ambiguous',targetMatches:2,compareClass:'target_missing',judge:accurate})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({routeChanged:true,recordedPath:'/a',todayPath:'/b'})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({flowChanged:true})).verdict,'full_rerecord');
  for (const m of [{ssimMasked:0.7,diff:0.05,coverage:0.2},{ssimMasked:0.9,diff:0.05,coverage:0.8},{ssimMasked:0.9,diff:0.3,coverage:0.2}])
    assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:m,judge:accurate})).verdict,'full_rerecord',JSON.stringify(m));
  // a missing target without a screenshot is still a re-record, not "unverified"
  assert.equal(classifyStepSignals(sig({hasScreenshot:false,action:'click',targetStatus:'missing'})).verdict,'full_rerecord');
});
test('css-only (renamed) target = narration_review', () => {
  const r=classifyStepSignals(sig({action:'click',targetStatus:'resolved',targetMethod:'css',targetName:'Archive',todayTargetName:'Retire'}));
  assert.equal(r.verdict,'narration_review');assert.ok(r.reasons.some(x=>x.code==='target_renamed'));
});
test('steps the mutation guard did not replay are unverified, not unchanged', () => {
  const r=classifyStepSignals(sig({hasScreenshot:false,guardStatus:'needs_fixture',guardReason:'name_matches:archive'}));
  assert.equal(r.verdict,'unverified');
  const v=videoVerdict([{index:0,verdict:'unchanged',reasons:[],chromeChanged:false},{index:1,verdict:'unverified',reasons:r.reasons,chromeChanged:false}]);
  assert.equal(v.verdict,'unchanged');assert.equal(v.complete,false);assert.match(v.summary,/not verified/);
});
test('video = worst step; persistent-chrome change with a kept slide => full_rerecord (mixed old/new UI)', () => {
  const s=(index,verdict,chromeChanged=false)=>({index,verdict,reasons:[{verdict,code:verdict==='unchanged'?'x':'screenshot_changed',detail:''}],chromeChanged});
  assert.equal(videoVerdict([s(0,'unchanged'),s(1,'slide_update')]).verdict,'slide_update');
  assert.equal(videoVerdict([s(0,'slide_update'),s(1,'moved_highlight')]).verdict,'moved_highlight');
  const mixed=videoVerdict([s(0,'slide_update',true),s(1,'unchanged',false)]);
  assert.equal(mixed.verdict,'full_rerecord');assert.equal(mixed.reasons[0].code,'mixed_old_new_ui');
  // every slide replaced (sidebar changed everywhere, all updatable): not mixed
  assert.equal(videoVerdict([s(0,'slide_update',true),s(1,'slide_update',true)]).verdict,'slide_update');
});

// ---------- image signals ----------
const img=(w,h,f)=>{const d=new Uint8Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const [r,g,b]=f(x,y);const o=(y*w+x)*4;d[o]=r;d[o+1]=g;d[o+2]=b;d[o+3]=255;}return {width:w,height:h,data:d};};
const sidebar=(x,y,alt=false)=>{if(x<32){const v=((x*7+y*13)%2?40:200);return alt?[255-v,0,0]:[v,v,v];}return null;};
test('chromeAnalysis: sidebar identical across two recorded pages is chrome; a redesigned sidebar today is detected', () => {
  const W=128,H=64;
  const recA=img(W,H,(x,y)=>sidebar(x,y)??[250,250,250]),recB=img(W,H,(x,y)=>sidebar(x,y)??((x+y)%9?[250,250,250]:[0,0,0]));
  const todA=img(W,H,(x,y)=>sidebar(x,y,true)??[250,250,250]),todB=img(W,H,(x,y)=>sidebar(x,y)??((x+y)%9?[250,250,250]:[0,0,0]));
  const c=chromeAnalysis([{index:0,img:recA,route:'/a'},{index:1,img:recB,route:'/b'}],new Map([[0,todA],[1,todB]]),{...THRESHOLDS,chromeMinCells:2});
  assert.equal(c.available,true);assert.ok(c.bbox.x===0&&c.bbox.w<=48,JSON.stringify(c.bbox));
  assert.equal(c.perStep[0].changed,true);assert.equal(c.perStep[1].changed,false);
  // one route only => not chrome (same-page frames share content)
  assert.equal(chromeAnalysis([{index:0,img:recA,route:'/a'},{index:1,img:recB,route:'/a'}],new Map()).available,false);
});
test('regionCoverage counts the union of non-dynamic regions once', () => {
  assert.equal(regionCoverage([{x:0,y:0,w:32,h:32},{x:0,y:0,w:32,h:32}],64,64,16),0.25);
  assert.equal(regionCoverage([{x:0,y:0,w:64,h:64,dynamic:true}],64,64,16),0);
});
test('parseJudge enforces the strict verdict shape', () => {
  assert.deepEqual(parseJudge({accurate:true,reason:'fine',claim_missing:true}),{accurate:true,claim_missing:false,reason:'fine'});
  assert.equal(parseJudge({accurate:false,claim_missing:true,reason:'gone',suggested_rewrite:'New line'}).suggested_rewrite,'New line');
  assert.equal(parseJudge({accurate:false,reason:'x',suggested_rewrite:'null'}).suggested_rewrite,undefined);
  assert.throws(()=>parseJudge({accurate:'yes',reason:'x'}));assert.throws(()=>parseJudge({accurate:true}));assert.throws(()=>parseJudge([]));
});
test('judge prompt shows only TODAY\'s screenshot and asks for strict JSON', () => {
  const p=buildJudgePrompt({title:'T',stepNumber:3,stepCount:3,action:'navigate',narration:'The ID is right there.',todayPath:'/s/today.png',todayText:'Project: Test'});
  assert.match(p,/\/s\/today\.png/);assert.doesNotMatch(p,/RECORDED/);assert.match(p,/"accurate": boolean/);assert.match(p,/Project: Test/);
});

// ---------- real pilot (read-only; skipped when the scratch evidence is absent) ----------
const RUN4='/Users/stephenskalamera/.hermes/cache/scratch/academy-recapture-20261028-123813/run4';
const SCRIPT=new URL('../../scripts/How-to-Find-a-Project-ID.script.json',import.meta.url);
test('real pilot run4 (How-to-Find-a-Project-ID) classifies as full_rerecord with sensible reasons', {skip:!(existsSync(RUN4)&&existsSync(SCRIPT))}, async () => {
  const script=JSON.parse(readFileSync(SCRIPT,'utf8'));
  const recordingsDir=new URL(`../../out/_recordings/${script.recording.id}`,import.meta.url).pathname;
  // Stub judge reproduces the observed live verdict for slide 3 only (the live claude call is exercised by the weekly run).
  const judge=async({stepNumber})=>stepNumber===3?{accurate:false,claim_missing:true,reason:'no project ID on the page'}:{accurate:true,claim_missing:false,reason:'ok'};
  const r=await classifyRun({runDir:RUN4,script,recordingsDir,judge,write:false});
  assert.equal(r.verdict,'full_rerecord');
  const codes=new Set(r.reasons.map(x=>x.code));
  assert.ok(codes.has('target_ambiguous'),[...codes].join());assert.ok(codes.has('page_redesigned'));assert.ok(codes.has('narration_contradicted'));
  assert.equal(r.steps[1].verdict,'full_rerecord');assert.equal(r.steps[2].verdict,'full_rerecord');
  assert.equal(r.chrome.available,true);assert.ok(r.steps.every(s=>s.chromeChanged),'sidebar redesign visible on every slide');
  // deterministic signals alone (no judge) already demand a re-record
  assert.equal((await classifyRun({runDir:RUN4,script,recordingsDir,judge:null,write:false})).verdict,'full_rerecord');
});
test('environment gaps are unverified, not drift: page still loading; record not visible (empty state + judge data_missing)', () => {
  assert.equal(classifyStepSignals(sig({pageState:'loading',compareClass:'screenshot_changed',metrics:{ssimMasked:0.7,coverage:0.9}})).verdict,'unverified');
  const miss=sig({action:'click',targetStatus:'missing',compareClass:'target_missing',emptyState:'You are up to date',targetName:'Card'});
  assert.equal(classifyStepSignals(miss).verdict,'full_rerecord','empty-state text alone is not enough');
  const r=classifyStepSignals({...miss,judge:{accurate:false,claim_missing:false,data_missing:true,reason:'board empty'}});
  assert.equal(r.verdict,'unverified');assert.equal(r.reasons[0].code,'record_not_visible');
  // data_missing on a redesigned page keeps the deterministic re-record
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.7},judge:{accurate:false,data_missing:true,reason:'x'}})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.95},judge:{accurate:false,data_missing:true,reason:'x'}})).verdict,'unverified');
  assert.equal(parseJudge({accurate:false,claim_missing:true,data_missing:true,reason:'empty'}).claim_missing,false);
});
test('error/empty state text detection (live Flags capture strings)', () => {
  assert.equal(errorStateOf("Couldn't load this document\nTry again\nMarketing project not found"),"Couldn't load this document");
  assert.equal(errorStateOf('Marketing Projects\nSubmitter review0'),null);
  assert.equal(emptyStateOf('Submitter review0\nYou are up to date'),'You are up to date');
  assert.equal(classifyStepSignals(sig({errorState:'Marketing project not found',action:'click',targetStatus:'missing',compareClass:'target_missing'})).verdict,'unverified');
});
