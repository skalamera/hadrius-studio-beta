// Fixture lifecycle for the weekly drift check: replay data-changing walkthrough steps in Hadrius Academy prod
// (company 1150) ONLY on job-owned test records labelled '[Studio QA]'.
//
// Import-safe: no side effects at import (Playwright/capture are imported lazily by the CLI).
//
//   spec    tools/drift/fixture-specs/<video>.fixture.json  (reviewed once by a human/agent; unreviewed specs refused)
//   journal tools/drift/journal.mjs (write-ahead JSONL per run, fsync'd before every create/mutate/undo/cleanup)
//   guard   fixtureAllow(): app/API non-GETs pass only for this run's fixture ids or that fixture's own create
//           request (POST to the spec's create path whose name field equals the run's labelled name)
//   backend createPageBackend(page): the app's own REST endpoints, called from INSIDE the signed-in page with the
//           session header the app itself uses (captured in-page by an init script; never returned to Node/logged)
//
// CLI:
//   node tools/drift/fixtures.mjs --run --script scripts/X.script.json [--spec SPEC] [--out NEW_DIR]
//        [--journal-dir DIR] [--simulate-crash-after-step N]     (N: test only, SIGKILLs itself after step N)
//   node tools/drift/fixtures.mjs --reconcile [--spec SPEC ...]     (reconcile unfinished runs + sweep, no replay)
//   node tools/drift/fixtures.mjs --status [--journal-dir DIR]
//   node tools/drift/fixtures.mjs --draft --script S --requests RUN/requests.json [--out spec.json]
import {readFileSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openJournal,newRunId,runIdTime,reduceJournal,readJournalFile,listJournals,openRuns,acquireLock,DEFAULT_JOURNAL_DIR} from './journal.mjs';

export const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export const SPEC_DIR=join(REPO,'tools','drift','fixture-specs');
export const LABEL_PREFIX='[Studio QA]';
export const EXPECTED_COMPANY_ID=1150;
export const SWEEP_MAX_AGE_MS=24*3600*1000;
const ID_SRC=String.raw`(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;
const TELEMETRY_RE=/^\/api\/users\/analytics\/\d+\/track-event\/?$/;

// ---------- labels / templates ----------
export function fixtureLabel(spec,runId){return `${LABEL_PREFIX} ${spec.labelKey} ${runId}`;}
/** '[Studio QA] <labelKey> <runId> ...' -> {labelKey, runId, at} | null */
export function parseLabel(name){const m=/^\[Studio QA\] (\S+) ([0-9]{8}T[0-9]{6}Z-[a-z0-9]{4,12})(?:\s|$)/.exec(String(name??''));
  return m?{labelKey:m[1],runId:m[2],at:runIdTime(m[2])}:null;}
const esc=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function fillPath(tpl,{companyId,fixtureId}={}){let s=String(tpl).replaceAll('{companyId}',String(companyId));
  if(s.includes('{fixtureId}')){if(fixtureId==null)throw new Error('fixture_id_unknown');s=s.replaceAll('{fixtureId}',encodeURIComponent(String(fixtureId)));}return s;}
/** Template -> RegExp; {fixtureId} becomes a capture group, {companyId} the literal company. */
export function pathRe(tpl,companyId){const parts=String(tpl).split('{fixtureId}').map(p=>esc(p).replaceAll(esc('{companyId}'),String(companyId)));
  return new RegExp('^'+parts.join(ID_SRC)+'$');}
/** '{label} text', '{fixture.risk.name}', '{recorded}' */
export function renderValue(tpl,{label,names={},recorded=''}){
  return String(tpl).replaceAll('{label}',label).replaceAll('{recorded}',String(recorded??'')).replace(/\{fixture\.([a-z0-9_]+)\.name\}/gi,(_,k)=>{if(!(k in names))throw new Error(`unknown_fixture:${k}`);return names[k];});}

// ---------- spec ----------
export function loadSpec(path){return JSON.parse(readFileSync(path,'utf8'));}
export function specPathFor(video,dir=SPEC_DIR){const p=join(dir,`${video}.fixture.json`);return existsSync(p)?p:null;}
export function listSpecs(dir=SPEC_DIR){return existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.fixture.json')).map(f=>join(dir,f)):[];}
const STEP_KINDS=['ui_only','type','set_slider','create','mutate'];
/** -> string[] problems (empty = valid). With script: every statically mutating step must be covered or the
 *  replay stops there (reported, not an error); spec steps must exist in the script. */
export function validateSpec(spec,{script=null,mutationPlan=null,requireReviewed=true}={}){
  const p=[];if(!spec||typeof spec!=='object')return ['spec_not_object'];
  if(spec.schema!==1)p.push('schema_not_1');
  if(spec.companyId!==EXPECTED_COMPANY_ID)p.push('company_not_1150');
  if(!/^[a-z0-9][a-z0-9-]{2,40}$/.test(spec.labelKey??''))p.push('bad_labelKey');
  if(requireReviewed&&!(spec.reviewed?.by&&spec.reviewed?.at))p.push('spec_not_reviewed');
  if(!/^[a-z0-9.-]+$/.test(spec.apiHost??''))p.push('bad_apiHost');
  const types=spec.recordTypes??{};
  for(const [name,t] of Object.entries(types)){
    for(const k of ['list','item','create','cleanup'])if(!t?.[k]?.path)p.push(`recordType_${name}_missing_${k}`);
    for(const k of ['list','item','create','cleanup'])if(t?.[k]?.path&&!String(t[k].path).startsWith('/api/company/{companyId}/'))p.push(`recordType_${name}_${k}_not_company_scoped`);
    if(t?.item?.path&&!t.item.path.includes('{fixtureId}'))p.push(`recordType_${name}_item_without_fixtureId`);
    if(t?.cleanup?.path&&!t.cleanup.path.includes('{fixtureId}'))p.push(`recordType_${name}_cleanup_without_fixtureId`);
    if(!t?.list?.nameField||!t?.create?.nameField)p.push(`recordType_${name}_missing_nameField`);
    if(t?.cleanup&&!['DELETE','PATCH','POST','PUT'].includes(String(t.cleanup.method)))p.push(`recordType_${name}_bad_cleanup_method`);
  }
  const keys=new Set();
  for(const f of spec.fixtures??[]){
    if(!/^[a-z0-9_]+$/.test(f.key??''))p.push('bad_fixture_key');if(keys.has(f.key))p.push(`duplicate_fixture_${f.key}`);keys.add(f.key);
    if(!types[f.recordType])p.push(`fixture_${f.key}_unknown_recordType`);
    if(!String(f.name??'').startsWith('{label}'))p.push(`fixture_${f.key}_name_must_start_with_label`);
    if(!['ui','api'].includes(f.create?.via))p.push(`fixture_${f.key}_bad_create_via`);
    if(f.create?.via==='ui'&&!(f.create.steps??[]).length)p.push(`fixture_${f.key}_ui_create_without_steps`);
  }
  if(!keys.size)p.push('no_fixtures');
  const seen=new Set();
  for(const s of spec.steps??[]){
    if(!Number.isInteger(s.stepIndex))p.push('step_without_index');if(seen.has(s.stepIndex))p.push(`duplicate_step_${s.stepIndex}`);seen.add(s.stepIndex);
    if(!STEP_KINDS.includes(s.kind))p.push(`step_${s.stepIndex}_bad_kind`);
    if(['type','create','mutate'].includes(s.kind)&&s.fixture&&!keys.has(s.fixture))p.push(`step_${s.stepIndex}_unknown_fixture`);
    if(s.kind==='create'){const f=(spec.fixtures??[]).find(x=>x.key===s.fixture);if(!f||!(f.create?.steps??[]).includes(s.stepIndex))p.push(`step_${s.stepIndex}_create_not_declared_on_fixture`);}
    if(s.kind==='mutate'&&!String(s.expectedRequest?.pathPattern??'').includes('{fixtureId}'))p.push(`step_${s.stepIndex}_mutate_without_fixtureId_path`);
    if(['create','mutate'].includes(s.kind)&&!['confined','unconfined'].includes(s.effect))p.push(`step_${s.stepIndex}_effect_unset`);
    if(s.kind==='set_slider'&&(!s.selector||!Number.isFinite(s.value)))p.push(`step_${s.stepIndex}_slider_needs_selector_value`);
    if(script&&!script.steps?.some(x=>x.index===s.stepIndex))p.push(`step_${s.stepIndex}_not_in_script`);
  }
  for(const f of spec.fixtures??[])for(const i of f.create?.steps??[])if(!(spec.steps??[]).some(s=>s.stepIndex===i&&s.kind==='create'&&s.fixture===f.key))p.push(`fixture_${f.key}_create_step_${i}_missing`);
  if(script&&spec.video!==script.name)p.push('video_mismatch');
  if(mutationPlan){for(const m of mutationPlan)if(m.mutating&&!seen.has(m.index))p.push(`uncovered_mutating_step_${m.index}`);}
  return p;
}

// ---------- network allowlist ----------
function bodyName(postData,field){try{const b=JSON.parse(postData??'');return b&&typeof b==='object'&&!Array.isArray(b)?b[field]:undefined;}catch{return undefined;}}
/** The fixture-mode allow predicate for createRequestGuard. Returns a reason string (truthy) or false.
 *  state: {companyId, apiHost, phase:'replay'|'setup'|'cleanup'|'reconcile'|'sweep', currentStep,
 *          fixtures:[{key,recordType,name,createSteps,via,created(bool)}], ids:{key:Set|Array}, extraIds:[{recordType,id}]}
 *  recordTypes from the spec. Only the API host is ever allowlisted. */
export function fixtureAllow(spec,getState){
  const types=spec.recordTypes,cid=spec.companyId;
  const createRe=Object.fromEntries(Object.entries(types).map(([n,t])=>[n,pathRe(t.create.path,cid)]));
  const itemRes=Object.fromEntries(Object.entries(types).map(([n,t])=>[n,[t.item.path,t.cleanup.path,...(t.itemPaths??[])].map(p=>pathRe(p,cid))]));
  const stepItemRes=(spec.steps??[]).filter(s=>s.kind==='mutate').map(s=>({s,re:pathRe(s.expectedRequest.pathPattern,cid)}));
  return ({method,host,path,postData})=>{
    const st=getState();if(String(host).toLowerCase()!==spec.apiHost)return false;const m=String(method).toUpperCase();
    // 1) The fixture's own creation request: right step (ui) or setup phase (api), exact labelled name, once.
    for(const f of st.fixtures){const t=types[f.recordType];
      if(f.created||m!==String(t.create.method??'POST').toUpperCase()||!createRe[f.recordType].test(path))continue;
      const inWindow=f.via==='ui'?st.phase==='replay'&&f.createSteps.includes(st.currentStep):st.phase==='setup';
      if(inWindow&&bodyName(postData,t.create.nameField)===f.name)return `fixture_create:${f.key}`;}
    // 2) Requests on a known fixture id (this run's, or journaled/swept ids during reconcile/sweep).
    const idsFor=(rt)=>[...st.fixtures.filter(f=>f.recordType===rt).flatMap(f=>[...(st.ids[f.key]??[])]),...(st.extraIds??[]).filter(x=>x.recordType===rt).map(x=>x.id)].map(String);
    for(const [rt,res] of Object.entries(itemRes)){const ids=idsFor(rt);if(!ids.length)continue;
      for(const re of res){const g=re.exec(path);if(g&&ids.includes(decodeURIComponent(g[1])))return `fixture_id:${rt}:${g[1]}`;}}
    for(const {s,re} of stepItemRes){const g=re.exec(path);const f=st.fixtures.find(x=>x.key===s.fixture);
      if(g&&f&&st.currentStep===s.stepIndex&&m===String(s.expectedRequest.method).toUpperCase()&&[...(st.ids[f.key]??[])].map(String).includes(decodeURIComponent(g[1])))return `fixture_mutate:${f.key}:${g[1]}`;}
    return false;};
}

// ---------- in-page API (session header stays inside the page) ----------
// Init script: remembers the 'jwt' request header the app itself sends (fetch or XHR) in a closure and exposes a
// non-enumerable window.__studioFixtureApi(method, path, body) that calls the API host with it. The header value is
// never returned: results are {status, json} only.
export const PAGE_API_INIT=`(() => { if (window.__studioFixtureApi) return; let h = null; const API = 'https://__API_HOST__';
  const of = window.fetch; window.fetch = function (i, o) { try { const hh = new Headers((o && o.headers) || (i instanceof Request ? i.headers : undefined)); const v = hh.get('jwt'); if (v) h = v; } catch (e) {} return of.apply(this, arguments); };
  const sh = XMLHttpRequest.prototype.setRequestHeader; XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (String(k).toLowerCase() === 'jwt' && v) h = v; return sh.apply(this, arguments); };
  Object.defineProperty(window, '__studioFixtureApi', { configurable: false, enumerable: false, value: async (method, path, body) => {
    if (!h) return { status: 0, error: 'no_session_header_seen' }; if (!/^\\/api\\//.test(path)) return { status: 0, error: 'bad_path' };
    const r = await of(API + path, { method, headers: { 'content-type': 'application/json', jwt: h }, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j }; } }); })()`;
export function pageApiInit(apiHost){if(!/^[a-z0-9.-]+$/.test(apiHost))throw new Error('bad_api_host');return PAGE_API_INIT.replace('__API_HOST__',apiHost);}
const asList=(j)=>Array.isArray(j)?j:Array.isArray(j?.data)?j.data:Array.isArray(j?.results)?j.results:null;
/** Find the record named `name` in a create/list response (object, {data:[...]}, {results:[...]}). */
export function findByName(json,field,name){const hits=[];const walk=(v,d)=>{if(d>3||v==null)return;if(Array.isArray(v)){for(const x of v)walk(x,d+1);return;}
  if(typeof v==='object'){if(v[field]===name&&v.id!=null)hits.push(v);if(d<2)for(const k of ['data','results','item','record'])if(k in v)walk(v[k],d+1);}};walk(json,0);
  const ids=[...new Set(hits.map(h=>String(h.id)))];return ids.length===1?hits.find(h=>String(h.id)===ids[0]):ids.length>1?{ambiguous:ids}:null;}

/** Backend over the app's REST API from inside a signed-in page. Every call still goes through the context's
 *  request guard, so cleanup/sweep deletes pass only for allowlisted fixture ids. */
export function createPageBackend(page,spec,{waitForSession=15000}={}){
  const call=async(method,path,body=null)=>{const t0=Date.now();let r;
    for(;;){r=await page.evaluate(([m,p,b])=>window.__studioFixtureApi?window.__studioFixtureApi(m,p,b):{status:0,error:'page_api_missing'},[method,path,body]);
      if(r.status!==0||r.error!=='no_session_header_seen'||Date.now()-t0>waitForSession)break;await page.waitForTimeout(500);}
    if(r.status===0)throw new Error(`page_api:${r.error}`);return r;};
  const T=(rt)=>{const t=spec.recordTypes[rt];if(!t)throw new Error(`unknown_record_type:${rt}`);return t;};
  return {
    async list(rt){const t=T(rt);const r=await call('GET',fillPath(t.list.path,{companyId:spec.companyId}));const l=asList(r.json);
      if(r.status!==200||!l)throw new Error(`list_failed:${rt}:${r.status}`);return l.map(x=>({id:x.id,name:x[t.list.nameField]}));},
    async create(rt,name,body){const t=T(rt);const r=await call(String(t.create.method??'POST'),fillPath(t.create.path,{companyId:spec.companyId}),{...(body??{}),[t.create.nameField]:name});
      const hit=findByName(r.json,t.create.nameField,name);if(r.status>=300||!hit||hit.ambiguous)throw new Error(`create_failed:${rt}:${r.status}`);return hit.id;},
    async remove(rt,id){const t=T(rt);const r=await call(String(t.cleanup.method),fillPath(t.cleanup.path,{companyId:spec.companyId,fixtureId:id}),t.cleanup.body??null);
      return {status:r.status,ok:r.status>=200&&r.status<300||r.status===404};},
  };
}

// ---------- the run session ----------
/** Ties spec + journal + backend together. capture.mjs drives it through these hooks:
 *  allow (guard predicate) · prepare(page) · stepDecision(step,mutation) · beforeStep(step) · onResponse(r) ·
 *  afterStep(step, requests) · teardown(page) · finish(status). */
export function createFixtureSession({spec,script,journalDir=DEFAULT_JOURNAL_DIR,runId=newRunId(),backendFor=(page)=>createPageBackend(page,spec),
  specPath=null,now=()=>new Date(),otherSpecs=[],afterStepHook=null,log=()=>{}}){
  const problems=validateSpec(spec,{script});if(problems.length)throw Object.assign(new Error(`invalid_fixture_spec: ${problems.join(', ')}`),{problems});
  const label=fixtureLabel(spec,runId);const journal=openJournal({dir:journalDir,runId,now});
  const fixtures=spec.fixtures.map(f=>({key:f.key,recordType:f.recordType,via:f.create.via,createSteps:f.create.steps??[],name:renderValue(f.name,{label}),created:false,body:f.create.body??null}));
  const names=Object.fromEntries(fixtures.map(f=>[f.key,f.name]));
  const state={companyId:spec.companyId,apiHost:spec.apiHost,phase:'idle',currentStep:null,fixtures,ids:Object.fromEntries(fixtures.map(f=>[f.key,new Set()])),extraIds:[]};
  const report={runId,label,journal:journal.file,fixtures:{},steps:{},reconcile:null,sweep:null,cleanup:[],postconditions:[],findings:[]};
  const pending=new Set();const stepSpec=(i)=>(spec.steps??[]).find(s=>s.stepIndex===i)??null;
  journal.append('run_begin',{video:spec.video,spec:specPath,label,pid:process.pid});
  const F=(k)=>fixtures.find(f=>f.key===k);
  const created=(f,id,how)=>{if(f.created)return;f.created=true;state.ids[f.key].add(String(id));journal.append('created',{fixture:f.key,recordType:f.recordType,id:String(id),how});
    report.fixtures[f.key]={...(report.fixtures[f.key]??{}),id:String(id),name:f.name,recordType:f.recordType,createdHow:how};log(`created ${f.key} id=${id}`);};
  const s={runId,label,names,state,report,journal,spec,pageInit:pageApiInit(spec.apiHost),
    allow:fixtureAllow(spec,()=>state),
    /** On a signed-in, tenant-verified page: reconcile earlier unfinished runs, sweep stale labels, api-create fixtures. */
    async prepare(page){const backend=backendFor(page);
      state.phase='reconcile';report.reconcile=await reconcileRuns({journalDir,backendFor:()=>backend,specs:[spec,...otherSpecs],exceptRunId:runId,state,now,log});
      state.phase='sweep';report.sweep=await sweepStale({specs:[spec,...otherSpecs],backend,journalDir,state,now,exceptRunId:runId,log});
      state.phase='setup';
      for(const f of fixtures.filter(x=>x.via==='api')){journal.append('create_intent',{fixture:f.key,recordType:f.recordType,name:f.name,label,via:'api'});
        const id=await backend.create(f.recordType,f.name,f.body);created(f,id,'api');}
      state.phase='replay';},
    /** -> {perform:boolean, kind, value?, selector?, reason} for a script step (spec entry decides). */
    stepDecision(step,mutation){const e=stepSpec(step.index);
      if(!e)return mutation?.mutating?{perform:false,status:'needs_fixture',reason:'step_not_in_fixture_spec'}:{perform:false,kind:null};
      if(['create','mutate'].includes(e.kind)&&e.effect!=='confined')return {perform:false,status:'needs_human',reason:'irreversible_effect_not_confined_to_fixture'};
      if(e.kind==='mutate'&&!state.ids[e.fixture]?.size)return {perform:false,status:'needs_fixture',reason:`fixture_${e.fixture}_not_created`};
      const value=e.kind==='type'?renderValue(e.value??'{recorded}',{label,names,recorded:step.value}):e.value;
      return {perform:true,kind:e.kind,value,selector:e.selector??null,fixture:e.fixture??null,reason:`fixture_spec:${e.kind}`};},
    beforeStep(step){state.currentStep=step.index;const e=stepSpec(step.index);if(!e)return;
      if(e.kind==='create'){const f=F(e.fixture);journal.append('create_intent',{fixture:f.key,recordType:f.recordType,name:f.name,label,via:'ui',step:step.index});}
      if(e.kind==='mutate')journal.append('mutate_intent',{fixture:e.fixture,step:step.index,request:e.expectedRequest,reversible:!!e.reversible,undo:e.undo??null});},
    /** Non-GET responses from the API host: capture fixture ids from create responses (by the labelled name). */
    onResponse(r){const p=(async()=>{const t=spec.recordTypes;
      for(const f of fixtures){if(f.created||state.phase!=='replay'||!f.createSteps.includes(state.currentStep))continue;const rt=t[f.recordType];
        if(r.method!==String(rt.create.method??'POST').toUpperCase()||!pathRe(rt.create.path,spec.companyId).test(r.path))continue;
        if(r.status>=300){journal.append('create_failed',{fixture:f.key,status:r.status});report.findings.push({kind:'fixture_create_failed',fixture:f.key,status:r.status});continue;}
        let json=null;try{json=await r.json();}catch{}const hit=findByName(json,rt.create.nameField,f.name);
        if(hit&&!hit.ambiguous)created(f,hit.id,'ui_response');else report.findings.push({kind:'fixture_id_not_in_response',fixture:f.key});}})();
      pending.add(p);p.catch(()=>{}).finally(()=>pending.delete(p));return p;},
    /** Verify the step's expected request(s); resolve ids by name if the response missed them; verify presence. */
    async afterStep(step,requests,page){await Promise.allSettled([...pending]);const e=stepSpec(step.index);const out={step:step.index,ok:true,notes:[]};
      const mine=requests.filter(r=>r.step===step.index&&!(TELEMETRY_RE.test(r.path)));
      if(e){const allowed=mine.filter(r=>r.decision==='allow_logged'&&/^fixture_/.test(r.reason));
        if(e.kind==='create'){const f=F(e.fixture);
          if(!allowed.some(r=>r.reason===`fixture_create:${f.key}`)){out.ok=false;out.notes.push('expected_create_request_not_seen');}
          if(!f.created&&page){try{const hit=(await backendFor(page).list(f.recordType)).filter(x=>x.name===f.name);if(hit.length===1)created(f,hit[0].id,'list_by_name');}catch(err){out.notes.push(`list_failed:${err.message}`);}}
          if(f.created&&e.verify?.present!==false&&page){try{const l=await backendFor(page).list(f.recordType);const ok=l.some(x=>String(x.id)===[...state.ids[f.key]][0]&&x.name===f.name);
            journal.append(ok?'verified_present':'verify_present_failed',{fixture:f.key});if(!ok){out.ok=false;out.notes.push('created_record_not_listed');}}catch(err){out.notes.push(`verify_failed:${err.message}`);}}
          if(!f.created){out.ok=false;out.notes.push('fixture_not_created');}}
        if(e.kind==='mutate'){const ok=allowed.some(r=>r.reason.startsWith(`fixture_mutate:${e.fixture}`)||r.reason.startsWith('fixture_id:'));
          if(ok)journal.append('mutated',{fixture:e.fixture,step:step.index});else{out.ok=false;out.notes.push('expected_mutation_request_not_seen');}}
        if(e.kind==='ui_only'||e.kind==='type'||e.kind==='set_slider'){const w=mine.filter(r=>r.decision!=='allow'&&!/^(cognito|oauth|feature_flag|read_named_post|graphql_query)/.test(r.reason));
          if(w.length){out.ok=false;out.notes.push(`unexpected_write_requests:${w.map(r=>`${r.method} ${r.path}`).join(',')}`);}}}
      report.steps[step.index]=out;if(!out.ok)report.findings.push({kind:'fixture_step_check_failed',...out});
      state.currentStep=null;if(afterStepHook)await afterStepHook(step,s);return out;},
    /** Undo + cleanup + verify absent for every fixture with a create intent. Runs in capture's finally. */
    async teardown(page){state.phase='cleanup';state.currentStep=null;const backend=backendFor(page);
      const order=[...(spec.cleanupOrder??[]),...fixtures.map(f=>f.key)].filter((k,i,a)=>a.indexOf(k)===i);
      const st=reduceJournal(journal.entries());
      for(const k of order){const f=F(k);const js=st.fixtures[k];if(!js?.createIntent)continue;
        const r=await cleanupFixture({backend,journal,fixture:{key:k,recordType:f.recordType,name:f.name,id:js.id??([...state.ids[k]][0]??null)},state,log});
        report.cleanup.push(r);report.postconditions.push({fixture:k,absent:r.verifiedAbsent});}
      return report.cleanup;},
    finish(status){const st=reduceJournal(journal.entries());const clean=!st.dirty.length;
      journal.append('run_end',{status:clean?status:`${status}_dirty`,dirty:st.dirty});return {clean,dirty:st.dirty};},
  };
  return s;
}

/** Journal + delete + verify for one record. Shared by teardown, reconcile and sweep. */
export async function cleanupFixture({backend,journal,fixture,state,log=()=>{},reason='cleanup'}){
  const {key,recordType,name}=fixture;let id=fixture.id;const out={fixture:key,recordType,name,id:id??null,reason,removed:false,verifiedAbsent:false,error:null};
  try{
    if(id==null){const hits=(await backend.list(recordType)).filter(x=>x.name===name);
      if(hits.length>1){out.error='ambiguous_name';return out;}
      if(!hits.length){journal.append('verified_absent',{fixture:key,recordType,how:'never_created_or_already_gone'});out.verifiedAbsent=true;return out;}
      id=String(hits[0].id);out.id=id;}
    if(state)state.extraIds.push({recordType,id:String(id)});
    journal.append('cleanup_intent',{fixture:key,recordType,id:String(id),name,reason});
    const r=await backend.remove(recordType,id);out.status=r.status;out.removed=r.ok;
    if(r.ok)journal.append('cleaned',{fixture:key,recordType,id:String(id),status:r.status});
    const still=(await backend.list(recordType)).some(x=>String(x.id)===String(id)||x.name===name);
    if(!still){journal.append('verified_absent',{fixture:key,recordType,id:String(id)});out.verifiedAbsent=true;}
    else out.error='still_present_after_cleanup';
  }catch(e){out.error=String(e?.message||e).slice(0,200);}
  log(`cleanup ${key} id=${out.id} -> ${out.verifiedAbsent?'absent':out.error}`);return out;
}

/** Reconcile every earlier run that has no run_end or an un-verified fixture: clean up by journal entries
 *  (id, or the unique labelled name when the crash came before the id), verify, then close the run. */
export async function reconcileRuns({journalDir=DEFAULT_JOURNAL_DIR,backendFor,specs,exceptRunId=null,state=null,now=()=>new Date(),log=()=>{}}){
  const results=[];
  for(const j of openRuns(journalDir,{exceptRunId})){
    const journal=openJournal({dir:journalDir,runId:j.runId,now});const st=j.state;
    const spec=specs.find(x=>x.video===st.video);
    if(!spec){results.push({runId:j.runId,status:'no_spec_for_video',video:st.video,dirty:st.dirty});continue;}
    journal.append('reconcile_begin',{by:exceptRunId,dirty:st.dirty});const backend=backendFor(spec);const r={runId:j.runId,video:st.video,cleaned:[]};
    for(const k of st.dirty){const f=st.fixtures[k];
      if(state&&!state.fixtures.some(x=>x.recordType===f.recordType)&&!spec.recordTypes[f.recordType]){r.cleaned.push({fixture:k,error:'unknown_record_type'});continue;}
      r.cleaned.push(await cleanupFixture({backend,journal,fixture:{key:k,recordType:f.recordType,name:f.name,id:f.id},state,log,reason:'reconcile'}));}
    const after=reduceJournal(journal.entries());
    journal.append('run_end',{status:after.dirty.length?'reconcile_incomplete':'reconciled',dirty:after.dirty,by:exceptRunId});
    r.status=after.dirty.length?'reconcile_incomplete':'reconciled';r.dirty=after.dirty;results.push(r);}
  return results;
}

/** Delete '[Studio QA]' records of the specs' record types whose label is older than maxAgeMs and whose run is
 *  not open (an open run is reconciled instead). Unparsable labels are reported, never deleted. */
export async function sweepStale({specs,backend=null,backendFor=()=>backend,journalDir=DEFAULT_JOURNAL_DIR,state=null,now=()=>new Date(),maxAgeMs=SWEEP_MAX_AGE_MS,exceptRunId=null,log=()=>{}}){
  const out={removed:[],skipped:[],errors:[]};const t=now().getTime();const seenTypes=new Set();
  const openIds=new Set([exceptRunId,...openRuns(journalDir,{exceptRunId}).map(r=>r.runId)].filter(Boolean));
  for(const spec of specs)for(const [rt] of Object.entries(spec.recordTypes)){const key=`${spec.companyId}:${rt}`;if(seenTypes.has(key))continue;seenTypes.add(key);
    const backend=backendFor(spec);let list;try{list=await backend.list(rt);}catch(e){out.errors.push({recordType:rt,error:e.message});continue;}
    for(const rec of list.filter(x=>String(x.name??'').startsWith(LABEL_PREFIX))){const p=parseLabel(rec.name);
      if(!p||p.at==null){out.skipped.push({recordType:rt,id:rec.id,name:rec.name,reason:'unknown_age'});continue;}
      if(openIds.has(p.runId)){out.skipped.push({recordType:rt,id:rec.id,name:rec.name,reason:'run_open'});continue;}
      if(t-p.at<maxAgeMs){out.skipped.push({recordType:rt,id:rec.id,name:rec.name,reason:'younger_than_24h'});continue;}
      const journal=openJournal({dir:journalDir,runId:p.runId,now});
      const r=await cleanupFixture({backend,journal,fixture:{key:`sweep_${rt.replace(/\W/g,'_')}_${rec.id}`,recordType:rt,name:rec.name,id:String(rec.id)},state,log,reason:'sweep'});
      journal.append('run_end',{status:r.verifiedAbsent?'swept':'sweep_incomplete'});(r.verifiedAbsent?out.removed:out.errors).push(r);}}
  return out;
}

// ---------- drafting helper ----------
/** Propose a spec from a script + observed non-GET requests (requests.json from a fixture/recapture run, with
 *  `step` on each entry). Output is a DRAFT (reviewed:null): a human must check endpoints, effects and undo. */
export function draftSpec({script,requests=[],mutationPlan=[],companyId=EXPECTED_COMPANY_ID,apiHost='hadriusapi.com'}){
  const labelKey=String(script.name).toLowerCase().replace(/^how-to-/,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
  const spec={schema:1,video:script.name,labelKey,companyId,apiHost,reviewed:null,draftNotes:[],recordTypes:{},fixtures:[],steps:[],cleanupOrder:[]};
  const tpl=(p)=>p.replace(`/api/company/${companyId}/`,'/api/company/{companyId}/').replace(/\/(\d+|[0-9a-f-]{36})(?=\/|$)/gi,'/{fixtureId}');
  const writes=requests.filter(r=>r.host===apiHost&&r.method!=='GET'&&!TELEMETRY_RE.test(r.path));
  const typed=script.steps.filter(s=>s.action==='type');
  for(const m of mutationPlan.filter(x=>x.mutating)){const step=script.steps.find(s=>s.index===m.index);const rs=writes.filter(r=>r.step===m.index);
    if(step.action==='type'){spec.steps.push({stepIndex:m.index,kind:'type',value:'{recorded}'});continue;}
    const post=rs.find(r=>r.method==='POST'&&!/\/(\d+|[0-9a-f-]{36})\/?$/i.test(r.path));
    const onId=rs.find(r=>/\/(\d+|[0-9a-f-]{36})\/?$/i.test(r.path));
    if(post){const coll=tpl(post.path);const rt=coll.replace('/api/company/{companyId}/','').replace(/\/$/,'').replace(/\//g,'.');
      const field=post.bodyKeys?.find(k=>typed.some(t=>post.bodyValues?.[k]===t.value))??post.bodyKeys?.[0]??'name';
      spec.recordTypes[rt]??={list:{path:coll,nameField:field},item:{path:`${coll}{fixtureId}/`},create:{method:'POST',path:coll,nameField:field},cleanup:{method:'DELETE',path:`${coll}{fixtureId}/`}};
      const key=rt.split('.').pop().replace(/s$/,'').replace(/\W/g,'_');const prev=[...typed].reverse().find(t=>t.index<m.index);
      spec.fixtures.push({key,recordType:rt,name:`{label} ${prev?.value??script.name}`,create:{via:'ui',steps:[m.index]}});
      if(prev){const e=spec.steps.find(x=>x.stepIndex===prev.index);if(e){e.fixture=key;e.value=`{fixture.${key}.name}`;}}
      spec.steps.push({stepIndex:m.index,kind:'create',fixture:key,expectedRequest:{method:'POST',pathPattern:coll},reversible:true,undo:'cleanup',effect:'confined',verify:{present:true}});
      spec.cleanupOrder.unshift(key);spec.draftNotes.push(`step ${m.index}: creates ${rt} (POST ${coll}); cleanup guessed as DELETE item — VERIFY`);}
    else if(onId){spec.steps.push({stepIndex:m.index,kind:'mutate',fixture:null,expectedRequest:{method:onId.method,pathPattern:tpl(onId.path)},reversible:null,undo:null,effect:null});
      spec.draftNotes.push(`step ${m.index}: ${onId.method} ${tpl(onId.path)} on an existing record — needs a setup fixture (via:'api') and an undo; effect unknown`);}
    else{spec.steps.push({stepIndex:m.index,kind:'ui_only',expectedRequests:[]});spec.draftNotes.push(`step ${m.index}: no write observed (dialog/menu opener?) — VERIFY`);}}
  return spec;
}

// ---------- CLI ----------
function arg(a,n){const i=a.indexOf(n);return i>=0?a[i+1]:undefined;}
function status(dir){return listJournals(dir).map(j=>{const s=reduceJournal(readJournalFile(j.file));return {runId:j.runId,video:s.video,ended:s.ended,endStatus:s.endStatus,open:s.open,dirty:s.dirty,
  fixtures:Object.values(s.fixtures).map(f=>({key:f.key,id:f.id,name:f.name,created:f.created,verifiedAbsent:f.verifiedAbsent}))};});}
export async function main(a=process.argv.slice(2)){
  const journalDir=resolve(arg(a,'--journal-dir')??DEFAULT_JOURNAL_DIR);
  if(a.includes('--status')){console.log(JSON.stringify(status(journalDir),null,2));return;}
  if(a.includes('--draft')){const script=JSON.parse(readFileSync(arg(a,'--script'),'utf8'));const req=arg(a,'--requests')?JSON.parse(readFileSync(arg(a,'--requests'),'utf8')).nonGet??[]:[];
    const {mutationPlan}=await import('./capture.mjs');const d=draftSpec({script,requests:req,mutationPlan:mutationPlan(script)});
    const o=arg(a,'--out');if(o){if(existsSync(o))throw new Error('output_exists');writeFileSync(o,JSON.stringify(d,null,2)+'\n');}console.log(JSON.stringify(d,null,2));return;}
  const lock=acquireLock(journalDir);if(!lock.ok)throw new Error(`fixture_runner_busy pid=${lock.heldBy.pid}`);
  try{
    const {captureRun,DEFAULT_PROFILE}=await import('./capture.mjs');
    if(a.includes('--reconcile')){const specs=(a.filter((x,i)=>a[i-1]==='--spec').length?a.filter((x,i)=>a[i-1]==='--spec'):listSpecs()).map(loadSpec);
      const {withAppPage}=await import('./capture.mjs');
      const st={phase:'reconcile',currentStep:null,fixtures:[],ids:{},extraIds:[]};
      const res=await withAppPage({profileDir:DEFAULT_PROFILE,startUrl:`https://app.hadrius.com/testing-program/risks?company_id=${EXPECTED_COMPANY_ID}`,
        allow:specs.map(sp=>fixtureAllow(sp,()=>st)),pageInit:pageApiInit(specs[0].apiHost),log:console.log,
        fn:async(page)=>{const backendFor=(sp)=>createPageBackend(page,sp);st.phase='reconcile';
          const rec=await reconcileRuns({journalDir,backendFor,specs,state:st,log:console.log});st.phase='sweep';
          const sw=await sweepStale({specs,backendFor,journalDir,state:st,log:console.log});return {reconcile:rec,sweep:sw};}});
      console.log(JSON.stringify(res,null,2));return res;}
    if(!a.includes('--run'))throw new Error('usage: fixtures.mjs --run --script S [--spec P] [--out DIR] | --reconcile | --status | --draft');
    const scriptPath=resolve(arg(a,'--script'));const script=JSON.parse(readFileSync(scriptPath,'utf8'));
    const specPath=resolve(arg(a,'--spec')??specPathFor(script.name)??'');if(!existsSync(specPath))throw new Error('no_fixture_spec');
    const spec=loadSpec(specPath);const runId=newRunId();
    const outDir=resolve(arg(a,'--out')??join(process.env.TMPDIR??'/tmp',`fixture-run-${runId}`));
    const crashAfter=arg(a,'--simulate-crash-after-step');
    const session=createFixtureSession({spec,script,specPath,journalDir,runId,otherSpecs:listSpecs().filter(p=>resolve(p)!==specPath).map(loadSpec),log:(m)=>console.log(`[fixture] ${m}`),
      afterStepHook:crashAfter!=null?async(step)=>{if(step.index===Number(crashAfter)){console.log(`[fixture] SIMULATED CRASH after step ${step.index} (SIGKILL)`);process.kill(process.pid,'SIGKILL');}}:null});
    console.log(`[fixture] run ${runId} label="${session.label}" journal=${session.journal.file}`);
    const run=await captureRun({scriptPath,outDir,profileDir:DEFAULT_PROFILE,fixture:session});
    if(run.fixture?.status==='pending'){const fin=session.finish(run.status);Object.assign(run.fixture,{status:fin.clean?'clean':'dirty',dirty:fin.dirty});}
    console.log(JSON.stringify({status:run.status,aborted:run.aborted,outDir,fixture:run.fixture,findings:run.findings,
      steps:run.steps.map(s=>({index:s.index,shot:s.screenshot,performed:s.performed??null,guard:s.mutationGuard?.status??null,target:s.target?.status,error:s.error}))},null,2));
    return run;
  }finally{lock.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
