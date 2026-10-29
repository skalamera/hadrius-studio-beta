// Fixture lifecycle tests: spec validation, fixture-mode network allowlist, journal, crash-at-every-step
// recovery, sweep, drafting, and captureRun in fixture mode with a fake browser. No network, no Playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {classifyRequest,createRequestGuard,captureRun,mutationPlan} from '../../tools/drift/capture.mjs';
import {fixtureLabel,parseLabel,pathRe,fillPath,renderValue,validateSpec,fixtureAllow,findByName,createFixtureSession,
  reconcileRuns,sweepStale,draftSpec,loadSpec,pageApiInit} from '../../tools/drift/fixtures.mjs';
import {openJournal,readJournalFile,reduceJournal,openRuns,newRunId,runIdTime,acquireLock,listJournals} from '../../tools/drift/journal.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const SPEC_PATH=join(HERE,'..','..','tools','drift','fixture-specs','How-to-Populate-Controls-and-Risks-Manually.fixture.json');
const SPEC=loadSpec(SPEC_PATH);
const APP='https://app.hadrius.com',API='https://hadriusapi.com';
const RISKS='/api/company/1150/firm_oversight/risks/',CONTROLS='/api/company/1150/firm_oversight/controls/';
const tmp=()=>mkdtempSync(join(tmpdir(),'drift-fx-'));
// A minimal script with the pilot's step layout (indices 0..11).
const L1=`${APP}/testing-program/risks?company_id=1150`,L2=`${APP}/testing-program/controls?company_id=1150`;
const R1='/testing-program/risks?company_id=1150',R2='/testing-program/controls?company_id=1150';
const SCRIPT={name:SPEC.video,environment:{startUrl:L1},recording:{id:'r'},steps:[
  {index:0,action:'navigate',url:L1,value:L1,route:R1},
  {index:1,action:'click',url:L1,route:R1,target:{role:'button',tag:'button',name:'Add risk'}},
  {index:2,action:'type',url:L1,route:R1,value:'Advisors share client data with unapproved AI tools',target:{role:'textbox',tag:'textarea',name:'Describe the risk scenario',placeholder:'Describe the risk scenario'}},
  {index:3,action:'hover',url:L1,route:R1,target:{role:'slider',tag:'span',name:'Inherent risk'}},
  {index:4,action:'click',url:L1,route:R1,target:{role:'button',tag:'button',name:'Create risk'}},
  {index:5,action:'navigate',url:L1,value:L1,route:R1},
  {index:6,action:'navigate',url:L2,value:L2,route:R2},
  {index:7,action:'click',url:L2,route:R2,target:{role:'button',tag:'button',name:'Add control'}},
  {index:8,action:'type',url:L2,route:R2,value:'Approved AI Tools Review',target:{role:'textbox',tag:'input',name:'Name',placeholder:'Enter control name'}},
  {index:9,action:'type',url:L2,route:R2,value:'Quarterly review',target:{role:'textbox',tag:'textarea',name:'Describe the control',placeholder:'Describe the control'}},
  {index:10,action:'click',url:L2,route:R2,target:{role:'button',tag:'button',name:'Create Control'}},
  {index:11,action:'navigate',url:'https://app.hadrius.com/testing-program/controls',value:'',route:'/testing-program/controls'}]};

// ---------- fake backend (the app's REST API semantics observed live) ----------
function fakeBackend(seed={}){
  const db={'firm_oversight.risk':[...(seed.risk??[{id:46444,name:'Non-compliance with Regulatory Requirements'}])],'firm_oversight.control':[...(seed.control??[{id:48980,name:'WSP Implementation and Attestation'}])]};
  let next=50000;const calls=[];const crash={at:null,n:0};
  const tick=(what)=>{calls.push(what);if(crash.at!=null&&++crash.n===crash.at)throw Object.assign(new Error(`CRASH@${what}`),{crash:true});};
  return {db,calls,crash,
    async list(rt){tick(`list:${rt}`);return db[rt].map(x=>({...x}));},
    async create(rt,name){const id=next++;db[rt].unshift({id,name});tick(`create:${rt}`);return id;},
    uiCreate(rt,name){const id=next++;db[rt].unshift({id,name});return {data:db[rt].map(x=>({id:x.id,[rt.endsWith('risk')?'scenario':'display_name']:x.name}))};},
    async remove(rt,id){const i=db[rt].findIndex(x=>String(x.id)===String(id));if(i>=0)db[rt].splice(i,1);tick(`remove:${rt}:${id}`);return {status:i>=0?200:404,ok:true};},
    studioQa(){return Object.values(db).flat().filter(x=>x.name.startsWith('[Studio QA]'));}};
}

// ---------- labels / templates ----------
test('labels carry the run id and parse back with their UTC time', () => {
  const runId=newRunId(new Date('2026-10-29T15:30:00Z'),()=>0.5);assert.match(runId,/^20261029T153000Z-[a-z0-9]{6}$/);
  const l=fixtureLabel(SPEC,runId);assert.equal(l,`[Studio QA] populate-risks-controls ${runId}`);
  const p=parseLabel(`${l} Advisors share`);assert.equal(p.runId,runId);assert.equal(p.at,Date.parse('2026-10-29T15:30:00Z'));
  assert.equal(parseLabel('Studio QA thing'),null);assert.equal(parseLabel('[Studio QA] x notarunid'),null);assert.equal(runIdTime('bad'),null);
  assert.equal(fillPath(SPEC.recordTypes['firm_oversight.risk'].cleanup.path,{companyId:1150,fixtureId:7}),`${RISKS}7/`);
  assert.throws(()=>fillPath('/api/company/{companyId}/x/{fixtureId}/',{companyId:1150}),/fixture_id_unknown/);
  assert.ok(pathRe('/api/company/{companyId}/x/{fixtureId}/',1150).test('/api/company/1150/x/12/'));
  assert.ok(!pathRe('/api/company/{companyId}/x/{fixtureId}/',1150).test('/api/company/1048/x/12/'));
  assert.equal(renderValue('{fixture.risk.name}',{label:'L',names:{risk:'L r'}}),'L r');assert.equal(renderValue('{recorded}',{label:'L',recorded:'v'}),'v');
  assert.throws(()=>renderValue('{fixture.zzz.name}',{label:'L',names:{}}),/unknown_fixture/);
});

// ---------- spec validation ----------
test('pilot spec is valid, reviewed and covers every statically mutating step', () => {
  assert.deepEqual(validateSpec(SPEC,{script:SCRIPT,mutationPlan:mutationPlan(SCRIPT)}),[]);
});
test('validateSpec refuses unreviewed / other-tenant / uncovered / unconfined-unset specs', () => {
  const bad=JSON.parse(JSON.stringify(SPEC));delete bad.reviewed;bad.companyId=1048;bad.steps=bad.steps.filter(s=>s.stepIndex!==7);delete bad.steps.find(s=>s.stepIndex===4).effect;
  bad.recordTypes['firm_oversight.risk'].cleanup.path='/api/risks/{fixtureId}/';
  const p=validateSpec(bad,{script:SCRIPT,mutationPlan:mutationPlan(SCRIPT)});
  for(const want of ['spec_not_reviewed','company_not_1150','uncovered_mutating_step_7','step_4_effect_unset','recordType_firm_oversight.risk_cleanup_not_company_scoped'])assert.ok(p.includes(want),want);
  const noLabel=JSON.parse(JSON.stringify(SPEC));noLabel.fixtures[0].name='Advisors share';assert.ok(validateSpec(noLabel).includes('fixture_risk_name_must_start_with_label'));
});

// ---------- network allowlist (synthetic requests through the real guard) ----------
function guardFor(state){return createRequestGuard({allow:[fixtureAllow(SPEC,()=>state)]});}
function st(over={}){const label=fixtureLabel(SPEC,'20261029T153000Z-abc123');return {phase:'replay',currentStep:null,extraIds:[],
  fixtures:[{key:'risk',recordType:'firm_oversight.risk',via:'ui',createSteps:[4],name:`${label} Advisors share client data with unapproved AI tools`,created:false},
            {key:'control',recordType:'firm_oversight.control',via:'ui',createSteps:[10],name:`${label} Approved AI Tools Review`,created:false}],
  ids:{risk:new Set(),control:new Set()},...over};}
const post=(path,body)=>({method:'POST',url:`${API}${path}`,postData:JSON.stringify(body),headers:{}});
test('fixture guard: only the labelled create request, in its step, once', () => {
  const s=st();const g=guardFor(s);const name=s.fixtures[0].name;
  assert.equal(g.decide(post(RISKS,{scenario:name}),'recapture').decision,'abort','outside the create step');
  s.currentStep=4;
  assert.deepEqual(g.decide(post(RISKS,{scenario:name,inherent_risk_impact:2})),{decision:'allow_logged',reason:'fixture_create:risk'});
  assert.equal(g.decide(post(RISKS,{scenario:'Advisors share client data with unapproved AI tools'})).decision,'abort','unlabelled record');
  assert.equal(g.decide(post(RISKS,{scenario:`${name} extra`})).decision,'abort','name must match exactly');
  assert.equal(g.decide(post(CONTROLS,{display_name:s.fixtures[1].name})).decision,'abort','control create only in step 10');
  assert.equal(g.decide({...post(RISKS,{scenario:name}),url:`${APP}${RISKS}`}).decision,'abort','API host only');
  s.fixtures[0].created=true;s.ids.risk.add('48742');
  assert.equal(g.decide(post(RISKS,{scenario:name})).decision,'abort','a second create of the same fixture');
  assert.match(g.failure(),/network_guard: POST hadriusapi\.com\/api\/company\/1150\/firm_oversight\/risks\/ \(unclassified_app_post\)/);
});
test('fixture guard: writes on the run\'s fixture ids pass; any other record id is aborted', () => {
  const s=st();s.ids.risk.add('48742');s.fixtures[0].created=true;const g=guardFor(s);
  assert.deepEqual(g.decide({method:'DELETE',url:`${API}${RISKS}48742/`}),{decision:'allow_logged',reason:'fixture_id:firm_oversight.risk:48742'});
  assert.equal(g.decide({method:'PATCH',url:`${API}${RISKS}48742/`,postData:'{}'}).decision,'allow_logged');
  assert.equal(g.decide({method:'DELETE',url:`${API}${RISKS}46444/`}).decision,'abort','a teammate\'s risk');
  assert.equal(g.decide({method:'DELETE',url:`${API}${CONTROLS}48742/`}).decision,'abort','same number, other record type');
  assert.equal(g.decide({method:'DELETE',url:`${API}/api/company/1048/firm_oversight/risks/48742/`}).decision,'abort','other tenant');
  assert.equal(g.decide({method:'POST',url:`${API}/api/users/analytics/33041/track-event/`,postData:'{}'}).decision,'block','telemetry: blocked, does not fail');
  assert.equal(g.decide({method:'POST',url:`${API}${RISKS}48742/archive/`,postData:'{}'}).decision,'abort','sub-resource not in the spec');
  const s2=st({phase:'reconcile',extraIds:[{recordType:'firm_oversight.control',id:'51779'}]});
  assert.equal(guardFor(s2).decide({method:'DELETE',url:`${API}${CONTROLS}51779/`}).decision,'allow_logged','journaled id during reconcile');
});
test('classifyRequest passes postData to predicates and reports their reason', () => {
  const c=classifyRequest(post('/api/x/',{a:1}),{allow:[({postData})=>JSON.parse(postData).a===1&&'custom_reason']});
  assert.deepEqual(c,{decision:'allow_logged',reason:'custom_reason'});
});
test('findByName picks the labelled item out of a whole-list create response', () => {
  assert.equal(findByName({data:[{id:1,scenario:'a'},{id:2,scenario:'L x'}]},'scenario','L x').id,2);
  assert.equal(findByName({id:3,display_name:'L'},'display_name','L').id,3);
  assert.deepEqual(findByName({data:[{id:1,scenario:'d'},{id:2,scenario:'d'}]},'scenario','d'),{ambiguous:['1','2']});
  assert.equal(findByName({data:[]},'scenario','x'),null);
});
test('page API init keeps the session header inside the page (never returned)', () => {
  const js=pageApiInit('hadriusapi.com');assert.match(js,/https:\/\/hadriusapi\.com/);assert.match(js,/return \{ status: r\.status, json: j \}/);
  assert.doesNotMatch(js,/return h\b|status: r\.status, json: j, h/);assert.throws(()=>pageApiInit('evil.com/"'),/bad_api_host/);
});

// ---------- journal ----------
test('journal: fsync\'d JSONL, torn last line ignored, reduce + open runs + lock', () => {
  const dir=tmp();const runId=newRunId();const j=openJournal({dir,runId});
  j.append('run_begin',{video:'v'});j.append('create_intent',{fixture:'risk',recordType:'firm_oversight.risk',name:'[Studio QA] n'});
  appendFileSync(j.file,'{"seq":9,"type":"crea');
  const e=readJournalFile(j.file);assert.equal(e.length,2);let s=reduceJournal(e);assert.equal(s.open,true);assert.deepEqual(s.dirty,['risk']);
  assert.equal(openRuns(dir).length,1);
  const j2=openJournal({dir,runId});j2.append('created',{fixture:'risk',id:'5'});j2.append('verified_absent',{fixture:'risk'});j2.append('run_end',{status:'captured'});
  s=reduceJournal(readJournalFile(j.file));assert.equal(s.open,false);assert.equal(s.fixtures.risk.id,'5');assert.equal(openRuns(dir).length,0);
  assert.throws(()=>openJournal({dir,runId:'../x'}),/invalid_run_id/);
  const l1=acquireLock(dir,{pid:111,isAlive:()=>true});assert.ok(l1.ok);assert.equal(acquireLock(dir,{pid:222,isAlive:()=>true}).ok,false);
  const l2=acquireLock(dir,{pid:222,isAlive:()=>false});assert.ok(l2.ok,'stale lock (dead pid) is taken over');l2.release();assert.ok(acquireLock(dir,{pid:333,isAlive:()=>true}).ok,'released');
});

// ---------- driver: the session's hooks in the order captureRun calls them ----------
async function drive(session,be,{badStep=null}={}){
  await session.prepare({});
  const reqs=[];
  for(const step of SCRIPT.steps){const d=session.stepDecision(step,{mutating:mutationPlan(SCRIPT).find(m=>m.index===step.index).mutating});if(!d.perform)continue;
    session.beforeStep(step);
    const e=SPEC.steps.find(x=>x.stepIndex===step.index);
    if(e.kind==='create'){const f=session.state.fixtures.find(x=>x.key===e.fixture);const path=e.fixture==='risk'?RISKS:CONTROLS;
      const dec=session.allow({method:'POST',host:'hadriusapi.com',path,postData:JSON.stringify({[e.fixture==='risk'?'scenario':'display_name']:f.name})});
      reqs.push({step:step.index,method:'POST',host:'hadriusapi.com',path,decision:dec?'allow_logged':'abort',reason:dec||'x'});
      if(dec){const json=be.uiCreate(f.recordType,f.name);await session.onResponse({method:'POST',path,status:200,json:async()=>json});}}
    await session.afterStep(step,reqs,{});}
  await session.teardown({});return session.finish('captured');
}
const mkSession=(dir,be,extra={})=>createFixtureSession({spec:SPEC,script:SCRIPT,journalDir:dir,backendFor:()=>be,runId:newRunId(),...extra});

test('happy path: two fixtures created in their steps, verified, cleaned, verified absent; journal closed', async () => {
  const dir=tmp();const be=fakeBackend();const s=mkSession(dir,be);
  const fin=await drive(s,be);assert.equal(fin.clean,true);assert.deepEqual(be.studioQa(),[]);
  const types=readJournalFile(s.journal.file).map(e=>e.type);
  assert.deepEqual(types,['run_begin','create_intent','created','verified_present','create_intent','created','verified_present',
    'cleanup_intent','cleaned','verified_absent','cleanup_intent','cleaned','verified_absent','run_end']);
  assert.ok(types.indexOf('create_intent')<types.indexOf('created'),'intent is written before the create');
  assert.equal(s.report.cleanup[0].fixture,'control','cleanupOrder respected');
  assert.ok(Object.values(s.report.steps).every(x=>x.ok));
  assert.equal(be.db['firm_oversight.risk'].length,1,'teammate record untouched');
});

test('crash at EVERY point (journal write or backend op) is reconciled by the next run', async () => {
  // Count the crash points of a clean run, then crash at each one and recover.
  const probeDir=tmp();const probe=fakeBackend();let points=0;const s0=mkSession(probeDir,probe);const ap=s0.journal.append;
  s0.journal.append=(...x)=>{points++;return ap(...x);};const orig={list:probe.list,remove:probe.remove};
  probe.list=async(...x)=>{points++;return orig.list(...x);};probe.remove=async(...x)=>{points++;return orig.remove(...x);};
  await drive(s0,probe);assert.ok(points>=20,`crash points: ${points}`);
  for(let k=1;k<=points;k++){
    // From crash point k on the process is dead: every later journal write / backend op fails (no side effects),
    // even where the code would catch and continue.
    const dir=tmp();const be=fakeBackend();const s=mkSession(dir,be);let n=0;const boom=()=>{if(++n>=k)throw Object.assign(new Error(`CRASH@${k}`),{crash:true});};
    const a=s.journal.append;s.journal.append=(...x)=>{boom();return a(...x);};
    const ol=be.list,orr=be.remove;be.list=async(...x)=>{boom();return ol(...x);};be.remove=async(...x)=>{const r=await orr(...x);boom();return r;};
    await drive(s,be).catch(()=>{});be.list=ol;be.remove=orr;   // the process is gone; nothing else ran after point k
    if(k===points)assert.ok(readJournalFile(s.journal.file).at(-1).type!=='run_end','last point = before run_end');
    // next run: reconcile first (same journal dir, same backend)
    const s2=mkSession(dir,be);await s2.prepare({});
    assert.deepEqual(be.studioQa(),[],`k=${k}: leftover after reconcile`);
    assert.equal(openRuns(dir,{exceptRunId:s2.runId}).length,0,`k=${k}: earlier run still open`);
    assert.equal(be.db['firm_oversight.risk'].some(x=>x.id===46444)&&be.db['firm_oversight.control'].some(x=>x.id===48980),true,`k=${k}: teammate records kept`);
    await s2.teardown({});assert.equal(s2.finish('captured').clean,true);
  }
});
test('reconcile finds a record by its unique label when the crash came before the id was journaled', async () => {
  const dir=tmp();const be=fakeBackend();const runId=newRunId();const j=openJournal({dir,runId});const name=`${fixtureLabel(SPEC,runId)} Advisors share client data with unapproved AI tools`;
  j.append('run_begin',{video:SPEC.video});j.append('create_intent',{fixture:'risk',recordType:'firm_oversight.risk',name});be.uiCreate('firm_oversight.risk',name);
  const st={phase:'reconcile',fixtures:[],ids:{},extraIds:[]};const r=await reconcileRuns({journalDir:dir,backendFor:()=>be,specs:[SPEC],state:st});
  assert.equal(r[0].status,'reconciled');assert.deepEqual(be.studioQa(),[]);assert.equal(st.extraIds.length,1,'the found id was allowlisted for the delete');
  const types=readJournalFile(j.file).map(e=>e.type);assert.deepEqual(types.slice(-4),['cleanup_intent','cleaned','verified_absent','run_end']);
});
test('reconcile leaves a run open (and reports it) when its spec is unknown', async () => {
  const dir=tmp();const j=openJournal({dir,runId:newRunId()});j.append('run_begin',{video:'Other-Video'});j.append('create_intent',{fixture:'x',recordType:'t',name:'[Studio QA] n'});
  const r=await reconcileRuns({journalDir:dir,backendFor:()=>fakeBackend(),specs:[SPEC]});assert.equal(r[0].status,'no_spec_for_video');assert.equal(openRuns(dir).length,1);
});

// ---------- sweep ----------
test('sweep deletes [Studio QA] records older than 24h; keeps young, unknown-age, open-run and teammate records', async () => {
  const dir=tmp();const now=new Date('2026-10-30T12:00:00Z');
  const old=`[Studio QA] populate-risks-controls 20261028T100000Z-aaaaaa Old`,young=`[Studio QA] populate-risks-controls 20261030T080000Z-bbbbbb Young`;
  const openRun='20261027T100000Z-cccccc';openJournal({dir,runId:openRun}).append('run_begin',{video:SPEC.video});
  const be=fakeBackend({risk:[{id:1,name:old},{id:2,name:young},{id:3,name:'[Studio QA] hand-made'},{id:4,name:`[Studio QA] populate-risks-controls ${openRun} X`},{id:46444,name:'Real risk'}],control:[{id:9,name:old}]});
  const r=await sweepStale({specs:[SPEC],backend:be,journalDir:dir,now:()=>now});
  assert.deepEqual(r.removed.map(x=>x.id).sort(),['1','9']);
  assert.deepEqual(Object.fromEntries(r.skipped.map(x=>[x.id,x.reason])),{2:'younger_than_24h',3:'unknown_age',4:'run_open'});
  assert.deepEqual(be.db['firm_oversight.risk'].map(x=>x.id),[2,3,4,46444]);
  assert.ok(listJournals(dir).some(j=>j.runId==='20261028T100000Z-aaaaaa'),'sweep deletes are journaled under the record\'s run id');
});

// ---------- drafting helper ----------
test('draftSpec proposes create fixtures + labelled typed names from observed requests (unreviewed)', () => {
  const requests=[{step:4,method:'POST',host:'hadriusapi.com',path:RISKS,bodyKeys:['scenario','notes'],bodyValues:{scenario:SCRIPT.steps[2].value}},
    {step:10,method:'POST',host:'hadriusapi.com',path:CONTROLS,bodyKeys:['display_name'],bodyValues:{display_name:'Approved AI Tools Review'}},
    {step:4,method:'POST',host:'hadriusapi.com',path:'/api/users/analytics/1/track-event/'}];
  const d=draftSpec({script:SCRIPT,requests,mutationPlan:mutationPlan(SCRIPT)});
  assert.equal(d.reviewed,null);assert.ok(validateSpec(d).includes('spec_not_reviewed'));
  assert.equal(d.recordTypes['firm_oversight.risks'].create.nameField,'scenario');
  assert.equal(d.recordTypes['firm_oversight.risks'].cleanup.path,'/api/company/{companyId}/firm_oversight/risks/{fixtureId}/');
  assert.equal(d.steps.find(s=>s.stepIndex===2).value,'{fixture.risk.name}');assert.equal(d.steps.find(s=>s.stepIndex===1).kind,'ui_only');
  assert.equal(d.steps.find(s=>s.stepIndex===10).kind,'create');
});

// ---------- captureRun in fixture mode with a fake browser ----------
function fakeChromium(be,{rogue=false}={}){
  const actions=[];let handler=null;const respCbs=[];
  const cands={[L1]:[{role:'button',tag:'button',name:'Add risk'},{role:'textbox',tag:'textarea',name:'Scenario',placeholder:'Describe the risk scenario'},
      {role:'slider',tag:'span',name:''},{role:'button',tag:'button',name:'Create risk',fires:'risk'},...(rogue?[{role:'button',tag:'button',name:'Delete other',fires:'rogue'}]:[])],
    [L2]:[{role:'button',tag:'button',name:'Add control'},{role:'textbox',tag:'input',name:'Name',placeholder:'Enter control name'},{role:'textbox',tag:'textarea',name:'Description',placeholder:'Describe the control'},{role:'button',tag:'button',name:'Create Control',fires:'control'}]};
  const typed={};let slider=0;
  const net=async(method,url,postData)=>{let ok=false;await handler({request:()=>({method:()=>method,url:()=>url,postData:()=>postData,headers:()=>({})}),
    continue:async()=>{ok=true;actions.push(['net_continue',method,url]);},abort:async()=>actions.push(['net_abort',method,url])});return ok;};
  const mkPage=()=>{let url='about:blank';const page={
    url:()=>url,goto:async(u)=>{actions.push(['goto',u]);url=u;},waitForURL:async()=>{},waitForTimeout:async()=>{},waitForLoadState:async()=>{},setViewportSize:async()=>{},
    on:(ev,cb)=>{if(ev==='response')respCbs.push(cb);},isClosed:()=>false,title:async()=>'T',screenshot:async({path})=>{writeFileSync(path,'png');actions.push(['shot',url]);},
    keyboard:{press:async(k)=>{actions.push(['press',k]);if(k==='ArrowRight')slider++;if(k==='ArrowLeft')slider--;}},
    locator:(sel)=>({count:async()=>1,hover:async()=>{},focus:async()=>{},getAttribute:async()=>String(slider)}),
    evaluate:async(expr)=>{const e=String(expr);if(e.includes('aria-busy'))return false;
      if(e.includes('hasPassword'))return {url,hasPassword:false,hasAppNav:true,academy:true,title:'T'};
      if(e.includes('__driftCandidates'))return (cands[url.split('#')[0]]??[]).map((c,i)=>({i,visible:true,cssMatch:false,href:null,bbox:{x:1,y:1,w:10,h:10},...c}));return [];},
    evaluateHandle:async(_fn,i)=>{const c=(cands[url]??[])[i];return {evaluate:async()=>c?{name:c.name,href:c.href??null}:null,hover:async()=>{},focus:async()=>{},
      fill:async(v)=>{typed[c.placeholder]=v;actions.push(['fill',c.placeholder,v]);},
      click:async()=>{actions.push(['click',c.name]);
        if(c.fires==='risk'||c.fires==='control'){const rt=`firm_oversight.${c.fires}`;const path=c.fires==='risk'?RISKS:CONTROLS;const f=c.fires==='risk'?'scenario':'display_name';
          const name=typed[c.fires==='risk'?'Describe the risk scenario':'Enter control name'];const body=JSON.stringify({[f]:name,...(c.fires==='risk'?{inherent_risk_impact:slider}:{})});
          if(await net('POST',`${API}${path}`,body)){const json=be.uiCreate(rt,name);for(const cb of respCbs)cb({request:()=>({method:()=>'POST',url:()=>`${API}${path}`}),status:()=>200,json:async()=>json});}}
        if(c.fires==='rogue')await net('DELETE',`${API}${RISKS}46444/`,null);}};},
  };return page;};
  return {actions,launchPersistentContext:async()=>{const p=mkPage();return {route:async(_pat,h)=>{handler=h;},addInitScript:async()=>{},pages:()=>[p],newPage:async()=>p,close:async()=>{}};}};
}
async function fixtureCapture({script=SCRIPT,rogue=false}={}){
  const dir=tmp();const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(script));
  const be=fakeBackend();const fc=fakeChromium(be,{rogue});const session=createFixtureSession({spec:SPEC,script,journalDir:join(dir,'journal'),backendFor:()=>be});
  const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fc,fixture:session,
      ensureSession:async()=>({status:'already_signed_in',companyIds:[1150]}),limits:{stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0,loadingWaitMs:0}});
    return {run,be,fc,session,dir};}finally{globalThis.fetch=origFetch;}
}
test('captureRun fixture mode: performs the spec\'s steps on labelled fixtures, captures every slide, tears down', async () => {
  const {run,be,fc,session,dir}=await fixtureCapture();
  assert.equal(run.status,'captured',JSON.stringify(run.findings));assert.equal(run.steps.filter(s=>s.screenshot).length,12);
  assert.deepEqual(fc.actions.filter(a=>a[0]==='click').map(a=>a[1]),['Add risk','Create risk','Add control','Create Control']);
  const fills=fc.actions.filter(a=>a[0]==='fill');assert.ok(fills[0][2].startsWith(`${session.label} Advisors`));assert.ok(fills[1][2].startsWith(`${session.label} Approved`));assert.equal(fills[2][2],'Quarterly review');
  assert.equal(run.steps[3].performed,'set_slider:2');assert.equal(run.steps[11].screenshot!=null,true,'empty navigate value falls back to the url');
  assert.equal(run.fixture.status,'clean');assert.deepEqual(be.studioQa(),[]);
  const req=JSON.parse(readFileSync(join(dir,'run','requests.json'),'utf8')).nonGet;
  assert.deepEqual(req.filter(r=>r.decision==='allow_logged').map(r=>[r.step,r.reason]),[[4,'fixture_create:risk'],[10,'fixture_create:control']]);
  assert.equal(readJournalFile(session.journal.file).at(-1).type,'run_end');
});
test('captureRun fixture mode: a write on a non-fixture record is aborted, fails the run, and teardown still cleans up', async () => {
  const script=JSON.parse(JSON.stringify(SCRIPT));script.steps[5]={index:5,action:'click',url:L1,route:R1,target:{role:'button',tag:'button',name:'Delete other'}};
  // A mis-click the click guard would stop: force it through a spec ui_only entry to prove the NETWORK layer catches it.
  const spec=JSON.parse(JSON.stringify(SPEC));spec.steps.push({stepIndex:5,kind:'ui_only',expectedRequests:[]});
  const dir=tmp();const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(script));
  const be=fakeBackend();const fc=fakeChromium(be,{rogue:true});
  const session=createFixtureSession({spec:{...spec,steps:spec.steps.map(s=>s)},script,journalDir:join(dir,'journal'),backendFor:()=>be});
  const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fc,fixture:session,
      ensureSession:async()=>({status:'already_signed_in'}),limits:{stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0,loadingWaitMs:0}});
    assert.equal(run.status,'aborted');assert.match(run.aborted,/DELETE hadriusapi\.com\/api\/company\/1150\/firm_oversight\/risks\/46444\//);
    assert.ok(fc.actions.some(a=>a[0]==='net_abort'&&a[1]==='DELETE'));assert.ok(be.db['firm_oversight.risk'].some(x=>x.id===46444),'teammate record untouched');
    assert.deepEqual(be.studioQa(),[],'the fixture created before the abort was cleaned up');assert.equal(run.fixture.status,'clean');
  }finally{globalThis.fetch=origFetch;}
});
test('captureRun fixture mode: a mutating step missing from the spec still stops the replay (needs_fixture)', async () => {
  const spec=JSON.parse(JSON.stringify(SPEC));spec.steps=spec.steps.filter(s=>s.stepIndex!==7&&s.stepIndex<7);spec.fixtures=spec.fixtures.filter(f=>f.key==='risk');spec.cleanupOrder=['risk'];
  const dir=tmp();const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(SCRIPT));
  const be=fakeBackend();const fc=fakeChromium(be);const session=createFixtureSession({spec,script:SCRIPT,journalDir:join(dir,'journal'),backendFor:()=>be});
  const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fc,fixture:session,
      ensureSession:async()=>({status:'already_signed_in'}),limits:{stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0,loadingWaitMs:0}});
    assert.equal(run.mutationStop.index,7);assert.equal(run.steps[7].mutationGuard.status,'needs_fixture');assert.ok(!fc.actions.some(a=>a[1]==='Add control'));
    assert.deepEqual(be.studioQa(),[]);
  }finally{globalThis.fetch=origFetch;}
});
test('unconfined irreversible step goes to a human, never performed', () => {
  const spec=JSON.parse(JSON.stringify(SPEC));spec.steps.find(s=>s.stepIndex===4).effect='unconfined';
  const s=createFixtureSession({spec,script:SCRIPT,journalDir:tmp(),backendFor:()=>fakeBackend()});
  assert.deepEqual(s.stepDecision(SCRIPT.steps[4],{mutating:true}),{perform:false,status:'needs_human',reason:'irreversible_effect_not_confined_to_fixture'});
});
