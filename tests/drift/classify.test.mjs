// Drift classifier (tools/drift/classify.mjs): pure decision rules on synthetic signals and synthetic PNGs,
// plus a read-only regression on the real pilot recapture (run4) when it exists on this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {errorStateOf,emptyStateOf,classifyStepSignals,videoVerdict,chromeAnalysis,regionCoverage,parseJudge,buildJudgePrompt,worst,classifyRun,THRESHOLDS} from '../../tools/drift/classify.mjs';
import {confirmedRelease,candidateRelease} from './release-fixture.mjs';
import {parseRedesignJudge} from '../../tools/drift/redesign-judge.mjs';

const base={index:1,action:'navigate',narration:'This is the list.',hasScreenshot:true,compareClass:'unchanged',dimensionsMatch:true,targetStatus:null,
  routeChanged:false,flowChanged:false,metrics:{diff:0,ssimMasked:1,coverage:0},chromeChanged:false,chromeFraction:0,judge:null};
const sig=(o)=>({...base,...o,metrics:{...base.metrics,...(o.metrics||{})}});
const accurate={accurate:true,claim_missing:false,reason:'ok'};
const uiReleaseEvidence=confirmedRelease();

test('worst() orders unchanged < slide_update < moved_highlight < narration_review < full_rerecord', () => {
  assert.equal(worst(['slide_update','unchanged']),'slide_update');
  assert.equal(worst(['moved_highlight','narration_review','slide_update']),'narration_review');
  assert.equal(worst(['full_rerecord','unchanged']),'full_rerecord');
  assert.equal(worst([]),'unchanged');
});
test('unchanged step stays unchanged and does not ask the judge', () => {
  const r=classifyStepSignals(sig({}));assert.equal(r.verdict,'unchanged');assert.equal(r.needsJudge,false);
});
test('an unverified read prerequisite dominates pixels, routes and positive reviews without model calls',()=>{
  for(const hasScreenshot of [true,false]){
    const r=classifyStepSignals(sig({hasScreenshot,prerequisiteUnverified:true,prerequisiteReason:'closed filter did not establish CLOSED records',
      compareClass:'screenshot_changed',routeChanged:true,flowChanged:true,metrics:{diff:0.9,ssimMasked:0.1,coverage:0.9},uiReleaseEvidence,judge:accurate}));
    assert.equal(r.verdict,'unverified');assert.equal(r.reasons[0].code,'prerequisite_unverified');assert.equal(r.needsJudge,false);assert.equal(r.needsRedesignJudge,false);
  }
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
test('unresolved targets need independent evidence; route/flow changes are separate; redesign needs a production UI-code diff', () => {
  const missing=sig({action:'click',targetStatus:'missing',compareClass:'target_missing'});
  assert.equal(classifyStepSignals(missing).verdict,'unverified','a missing locator alone cannot distinguish UI drift from data/state');
  assert.equal(classifyStepSignals({...missing,judge:{accurate:false,claim_missing:true,data_missing:false,reason:'the narrated control was removed'}}).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({action:'click',targetStatus:'ambiguous',targetMatches:2,compareClass:'target_missing'})).verdict,'unverified');
  assert.equal(classifyStepSignals(sig({action:'click',targetStatus:'ambiguous',targetMatches:2,compareClass:'target_missing',judge:{accurate:false,claim_missing:true,data_missing:false,reason:'the narrated control was removed'}})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({routeChanged:true,recordedPath:'/a',todayPath:'/b'})).verdict,'full_rerecord');
  assert.equal(classifyStepSignals(sig({flowChanged:true})).verdict,'full_rerecord');
  for (const m of [{ssimMasked:0.7,diff:0.05,coverage:0.2},{ssimMasked:0.9,diff:0.05,coverage:0.8},{ssimMasked:0.9,diff:0.3,coverage:0.2}]) {
    const r=classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:m,judge:accurate}));
    assert.equal(r.verdict,'unverified',JSON.stringify(m));assert.equal(r.reasons[0].code,'redesign_release_unconfirmed');
  }
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.7,diff:0.05,coverage:0.2},judge:accurate,uiReleaseEvidence})).verdict,'full_rerecord');
  // a missing target without a screenshot is not verified drift
  assert.equal(classifyStepSignals(sig({hasScreenshot:false,action:'click',targetStatus:'missing'})).verdict,'unverified');
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
  const s=(index,verdict,chromeChanged=false)=>({index,verdict,reasons:[{verdict,code:verdict==='unchanged'?'x':'screenshot_changed',detail:''}],chromeChanged,uiReleaseEvidence:chromeChanged?confirmedRelease({chrome:true}):null});
  assert.equal(videoVerdict([s(0,'unchanged'),s(1,'slide_update')]).verdict,'slide_update');
  assert.equal(videoVerdict([s(0,'slide_update'),s(1,'moved_highlight')]).verdict,'moved_highlight');
  const mixed=videoVerdict([s(0,'slide_update',true),s(1,'unchanged',false)]);
  assert.equal(mixed.verdict,'full_rerecord');assert.equal(mixed.reasons[0].code,'mixed_old_new_ui');
  assert.equal(videoVerdict([{...s(0,'unverified',true),uiReleaseEvidence:null},s(1,'unchanged',false)]).verdict,'unchanged','unconfirmed chrome pixels cannot force a re-record');
  // every slide replaced (sidebar changed everywhere, all updatable): not mixed
  assert.equal(videoVerdict([s(0,'slide_update',true),s(1,'slide_update',true)]).verdict,'slide_update');
});

test('video aggregation cannot promote missing prerequisites through confirmed chrome evidence',()=>{
  const held={index:0,verdict:'unverified',reasons:[{verdict:'unverified',code:'prerequisite_unverified',detail:'Closed state missing'}],chromeChanged:true,uiReleaseEvidence:confirmedRelease({chrome:true})};
  const kept={index:1,verdict:'unchanged',reasons:[],chromeChanged:false};
  for(const steps of [[held],[held,kept],[{...kept,verdict:'slide_update',chromeChanged:true,uiReleaseEvidence:confirmedRelease({chrome:true})},{...held,chromeChanged:false}]]){
    const result=videoVerdict(steps);assert.notEqual(result.verdict,'full_rerecord');assert.equal(result.complete,false);assert.ok(!result.reasons.some(x=>x.code==='mixed_old_new_ui'));
  }
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
test('real pilot run4 (How-to-Find-a-Project-ID) stays unverified without production UI-code evidence', {skip:!(existsSync(RUN4)&&existsSync(SCRIPT))}, async () => {
  const script=JSON.parse(readFileSync(SCRIPT,'utf8'));
  const recordingsDir=new URL(`../../out/_recordings/${script.recording.id}`,import.meta.url).pathname;
  // Stub judge reproduces the observed live verdict for slide 3 only (the live claude call is exercised by the weekly run).
  const judge=async({stepNumber})=>stepNumber===3?{accurate:false,claim_missing:true,reason:'no project ID on the page'}:{accurate:true,claim_missing:false,reason:'ok'};
  const r=await classifyRun({runDir:RUN4,script,recordingsDir,judge,write:false});
  assert.equal(r.verdict,'unchanged');assert.equal(r.complete,false);
  assert.ok(r.steps.some(s=>s.reasons.some(x=>x.code==='redesign_release_unconfirmed'||x.code==='chrome_release_unconfirmed')),'pixel/chrome evidence alone is unverified');
  assert.ok(r.steps.every(s=>s.verdict==='unverified'));
  assert.equal(r.chrome.available,true);assert.ok(r.steps.every(s=>s.chromeChanged),'sidebar redesign visible on every slide');
  // Deterministic signals alone (no judge or release evidence) stay unverified.
  const noJudge=await classifyRun({runDir:RUN4,script,recordingsDir,judge:null,write:false});
  assert.equal(noJudge.verdict,'unchanged');assert.equal(noJudge.complete,false);
});
test('environment gaps are unverified, not drift: page still loading; record not visible (empty state + judge data_missing)', () => {
  assert.equal(classifyStepSignals(sig({pageState:'loading',compareClass:'screenshot_changed',metrics:{ssimMasked:0.7,coverage:0.9}})).verdict,'unverified');
  const miss=sig({action:'click',targetStatus:'missing',compareClass:'target_missing',emptyState:'You are up to date',targetName:'Card'});
  assert.equal(classifyStepSignals(miss).verdict,'unverified','empty-state text without a verified cause is not drift evidence');
  const r=classifyStepSignals({...miss,judge:{accurate:false,claim_missing:false,data_missing:true,reason:'board empty'}});
  assert.equal(r.verdict,'unverified');assert.equal(r.reasons[0].code,'empty_state');
  // A missing named record can coexist with a large pixel diff because its row is gone.
  // Even without recognized empty-state copy, judge-confirmed missing data must not make
  // target_missing/page_redesigned into a video-update signal.
  const absentRecord=sig({action:'click',targetStatus:'missing',compareClass:'target_missing',targetName:'Hadrius Sandbox Advisors - Updated',
    metrics:{diff:0.03,ssimMasked:0.88,coverage:0.43,diffUi:0.03,ssimUi:0.88,coverageUi:0.43},
    judge:{accurate:false,claim_missing:false,data_missing:true,reason:'The named policy record is absent; only another policy row is present.'}});
  const absent=classifyStepSignals(absentRecord);
  assert.equal(absent.verdict,'unverified');assert.equal(absent.reasons[0].code,'record_not_visible');
  assert.ok(!absent.reasons.some(x=>x.code==='target_missing'||x.code==='page_redesigned'));
  assert.equal(classifyStepSignals({...absentRecord,judge:{accurate:false,claim_missing:true,data_missing:false,reason:'The page UI changed.'}}).verdict,'full_rerecord');
  // Missing/unverifiable data blocks a same-step drift verdict, even when pixel signals look severe.
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.7},judge:{accurate:false,data_missing:true,reason:'records unavailable'}})).verdict,'unverified');
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.95},judge:{accurate:false,data_missing:true,reason:'x'}})).verdict,'unverified');
  assert.equal(classifyStepSignals(sig({compareClass:'screenshot_changed',metrics:{ssimMasked:0.7},judge:{accurate:true,data_missing:true,reason:'contradictory but unavailable'}})).verdict,'unverified');
  assert.equal(parseJudge({accurate:false,claim_missing:true,data_missing:true,reason:'empty'}).claim_missing,false);
});
test('error/empty state text detection (live Flags capture strings)', () => {
  assert.equal(errorStateOf("Couldn't load this document\nTry again\nMarketing project not found"),"Couldn't load this document");
  assert.equal(errorStateOf('Marketing Projects\nSubmitter review0'),null);
  assert.equal(emptyStateOf('Submitter review0\nYou are up to date'),'You are up to date');
  assert.equal(classifyStepSignals(sig({errorState:'Marketing project not found',action:'click',targetStatus:'missing',compareClass:'target_missing'})).verdict,'unverified');
});
test('an empty or zero-result page is never a redesign, whatever the pixels or release evidence say', () => {
  for (const judge of [null, accurate, { accurate: false, data_missing: true, reason: 'no rows' }]) {
    for (const ev of [null, uiReleaseEvidence]) {
      const r = classifyStepSignals(sig({ compareClass: 'screenshot_changed', emptyState: '0 of 0 results', judge, uiReleaseEvidence: ev, metrics: { ssimMasked: 0.5, diff: 0.4, coverage: 0.9 } }));
      assert.equal(r.verdict, 'unverified'); assert.equal(r.reasons[0].code, 'empty_state'); assert.equal(r.needsJudge, false);
    }
  }
  assert.equal(emptyStateOf('Submissions\nShowing 0 of 0 results'), '0 of 0 results');
  assert.equal(emptyStateOf('Trade alerts\nNo trade alerts found'), 'No trade alerts found');
  assert.equal(emptyStateOf('Rules\n10 of 20 results'), null);
  assert.equal(emptyStateOf('Notes found here'), null);
});

test('assistant questions are not empty/error states, but actual content states still fail closed', () => {
  const content = 'People directory\nEmployee name\nHadrius Studio\nShowing 1 to 1 of 1 results\n';
  assert.equal(emptyStateOf(content + 'Who has no login yet?'), null);
  assert.equal(emptyStateOf(content + 'Who has no login yet'), null);
  assert.equal(emptyStateOf(content + 'SUGGESTED FOR THIS PAGE\nNo records found\nChoose a question'), null);
  assert.equal(errorStateOf(content + 'Which documents were not found?'), null);
  assert.equal(errorStateOf(content + 'Ask about people directory\nPage not found'), null);
  assert.equal(emptyStateOf('No trade alerts found\nSUGGESTED FOR THIS PAGE\nWho has no login yet?'), 'No trade alerts found');
  assert.equal(errorStateOf("Couldn't load this document\nSUGGESTED FOR THIS PAGE\nWhat happened?"), "Couldn't load this document");
});

test('page redesign needs a confirmed, verified production release review', () => {
  const s = sig({ compareClass: 'screenshot_changed', judge: accurate, metrics: { ssimMasked: 0.6, diff: 0.3, coverage: 0.7 } });
  const cand = candidateRelease();
  for (const [ev, code, ask] of [[null, 'redesign_release_unconfirmed', false], [{ ...cand, status: 'no_release' }, 'no_frontend_release', false],
    [{ ...cand, status: 'no_release_touched_screen', commits: [] }, 'no_release_touched_screen', false], [cand, 'redesign_unreviewed', true],
    [{ ...cand, redesign: { confirmed: false, changes: [], rejected: [], reason: 'only data differs' } }, 'redesign_not_confirmed', false]]) {
    const r = classifyStepSignals({ ...s, uiReleaseEvidence: ev });
    assert.equal(r.verdict, 'unverified', code); assert.equal(r.reasons[0].code, code); assert.equal(!!r.needsRedesignJudge, ask, code);
  }
  const ok = classifyStepSignals({ ...s, uiReleaseEvidence: confirmedRelease() });
  assert.equal(ok.verdict, 'full_rerecord');
  assert.match(ok.reasons.find((x) => x.code === 'page_redesigned').detail, /renamed "New rule" \(#2\)/);
});

test('a smaller screenshot change (e.g. one renamed tab) is reviewed too; only a verified release change marks it ui_changed', () => {
  const s = sig({ compareClass: 'screenshot_changed', judge: accurate, metrics: { ssimMasked: 0.97, diff: 0.02, coverage: 0.05 } });
  const cand = candidateRelease();
  const unreviewed = classifyStepSignals({ ...s, uiReleaseEvidence: cand });
  assert.equal(unreviewed.verdict, 'slide_update'); assert.equal(unreviewed.needsRedesignJudge, true);
  assert.ok(!unreviewed.reasons.some((x) => x.code === 'ui_changed'));
  const notConfirmed = classifyStepSignals({ ...s, uiReleaseEvidence: { ...cand, redesign: { confirmed: false, changes: [], rejected: [], reason: 'only data differs' } } });
  assert.ok(!notConfirmed.reasons.some((x) => x.code === 'ui_changed')); assert.ok(!notConfirmed.needsRedesignJudge);
  const confirmed = classifyStepSignals({ ...s, uiReleaseEvidence: confirmedRelease() });
  assert.equal(confirmed.verdict, 'slide_update');
  assert.match(confirmed.reasons.find((x) => x.code === 'ui_changed').detail, /renamed "New rule" \(#2\)/);
  assert.ok(!classifyStepSignals({ ...s, uiReleaseEvidence: null }).needsRedesignJudge);
  // A data-only frame change is never reviewed.
  assert.ok(!classifyStepSignals({ ...s, dataOnly: true, uiReleaseEvidence: cand }).needsRedesignJudge);
});

test('chrome change needs a verified change from a release that touched an app-shell file', () => {
  const s = sig({ compareClass: 'unchanged', chromeChanged: true, chromeFraction: 0.4, judge: accurate });
  assert.equal(classifyStepSignals({ ...s, uiReleaseEvidence: confirmedRelease() }).reasons[0].code, 'redesign_not_confirmed');
  assert.ok(classifyStepSignals({ ...s, uiReleaseEvidence: confirmedRelease({ chrome: true }) }).reasons.some((x) => x.code === 'persistent_chrome_changed'));
});

test('classifyRun asks the redesign judge only for release candidates and stores the verified review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cls-'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ status: 'captured', steps: [0, 1].map((index) => ({ index, todayUrl: 'https://app.hadrius.com/rules', visibleText: 'Trading Rules\nNew rule' })) }));
  writeFileSync(join(dir, 'compare.json'), JSON.stringify({ steps: [0, 1].map((index) => ({ index, classification: 'screenshot_changed', todayScreenshot: `t${index}.png`, dimensions: { match: true }, diffFractionNonDynamic: 0.4, ssimMasked: 0.5, regions: [] })) }));
  const script = { name: 'Vid', title: 'Vid', steps: [0, 1].map((index) => ({ index, action: 'navigate', narration: '', url: 'https://app.hadrius.com/rules', media: { pre: `r${index}.png` } })) };
  const calls = [];
  const helpers = { excerpt: () => '+ New rule', filesTouched: () => ['apps/hadrius-app/src/features/rules/view_rules.tsx'],
    diffLabels: () => ({ added: ['new rule'], removed: ['create rule'] }),
    uiStringsAt: (sha) => (sha === 'b'.repeat(40) ? new Set(['new rule']) : new Set(['create rule'])) };
  const releaseEvidence = { summary: { status: 'ok' }, byStep: { 0: candidateRelease(), 1: { ...candidateRelease(), status: 'no_release_touched_screen', commits: [] } }, ...helpers };
  const redesignJudge = async (input) => { calls.push(input.stepNumber); return parseRedesignJudge({ redesigned: true, reason: 'renamed', changes: [{ element: 'button', kind: 'renamed', before: 'Create rule', after: 'New rule', commit: 'c'.repeat(12) }] }); };
  const r = await classifyRun({ runDir: dir, script, recordingsDir: join(dir, 'rec'), releaseEvidence, redesignJudge, write: false });
  assert.deepEqual(calls, [1]);
  assert.ok(r.steps[0].reasons.some((x) => x.code === 'page_redesigned'));
  assert.equal(r.steps[0].uiReleaseEvidence.redesign.confirmed, true);
  assert.equal(r.steps[1].verdict, 'unverified'); assert.equal(r.steps[1].reasons[0].code, 'no_release_touched_screen');
  assert.equal(r.verdict, 'full_rerecord');
});
