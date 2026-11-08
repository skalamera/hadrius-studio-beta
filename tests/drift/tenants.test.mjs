// Tenant registry (tools/drift/tenants.mjs) + tenant-aware capture/fixtures. Synthetic only: fake browser,
// no network, no Keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {TENANTS,getTenant,tenantForCompanyId,tenantForProfile,tenantProfileDir,tenantStartUrl,scriptCompanyIds,detectScriptTenant,buildAllowlist} from '../../tools/drift/tenants.mjs';
import {captureRun,withAppPage,resolveRunTenant,isDriftProfile,preflight,tenantNameVisible} from '../../tools/drift/capture.mjs';
import {validateSpec,createFixtureSession} from '../../tools/drift/fixtures.mjs';
import {tenantLoginConfig,ACCOUNT,SERVICE,EXPECTED_COMPANY_ID,DEFAULT_START_URL,DEFAULT_PROFILE_DIR,redact} from '../../tools/drift/academy-login.mjs';

const APP='https://app.hadrius.com';
const S=(urls,extra={})=>({name:extra.name??'X',environment:{startUrl:urls[0]},steps:urls.slice(1).map((u,i)=>({index:i,action:'navigate',url:u,value:u})),...extra});

test('registry: academy + sandbox entries, lookups, never guesses unknown keys', () => {
  assert.deepEqual(Object.keys(TENANTS),['academy','sandbox']);
  assert.equal(getTenant('academy').companyId,1150);assert.equal(getTenant('sandbox').companyId,1048);
  assert.equal(getTenant('sandbox').account,'stephen+hsandbox@hadrius.com');assert.equal(getTenant('sandbox').keychainService,'hadrius-studio-sandbox');
  assert.equal(getTenant('sandbox').profileDir,'.browser-profile-drift-sandbox');assert.equal(getTenant('academy').profileDir,'.browser-profile-drift');
  assert.throws(()=>getTenant('prod'),/unknown_tenant/);
  assert.equal(tenantForCompanyId('1048').key,'sandbox');assert.equal(tenantForCompanyId(1150).key,'academy');assert.equal(tenantForCompanyId(777),null);assert.equal(tenantForCompanyId(null),null);
  assert.equal(tenantForProfile('/r/.browser-profile-drift-sandbox').key,'sandbox');assert.equal(tenantForProfile('/r/.browser-profile-drift').key,'academy');assert.equal(tenantForProfile('/r/.browser-profile-ai-2'),null);
  assert.equal(basename(tenantProfileDir('sandbox')),'.browser-profile-drift-sandbox');
  assert.equal(tenantStartUrl('sandbox'),`${APP}/marketing/projects?company_id=1048`);
});
test('academy-login keeps its Academy exports; per-tenant login config; every account is redacted', () => {
  assert.equal(ACCOUNT,'stephen+hstudio@hadrius.com');assert.equal(SERVICE,'hadrius-studio-academy');assert.equal(EXPECTED_COMPANY_ID,1150);
  assert.equal(DEFAULT_START_URL,`${APP}/marketing/projects?company_id=1150`);assert.equal(basename(DEFAULT_PROFILE_DIR),'.browser-profile-drift');
  const a=tenantLoginConfig('academy');assert.equal(a.startUrl,DEFAULT_START_URL);assert.equal(a.profileDir,DEFAULT_PROFILE_DIR);
  const s=tenantLoginConfig('sandbox');assert.deepEqual([s.account,s.service,s.expectedCompanyId,basename(s.profileDir)],['stephen+hsandbox@hadrius.com','hadrius-studio-sandbox',1048,'.browser-profile-drift-sandbox']);
  assert.equal(redact('a stephen+hsandbox@hadrius.com b stephen+hstudio@hadrius.com'),'a st***@hadrius.com b st***@hadrius.com');
});
test('detectScriptTenant: 1150 / 1048 / unknown / conflict / unregistered, from startUrl AND step URLs', () => {
  assert.deepEqual(detectScriptTenant(S([`${APP}/a?company_id=1150`])).tenant,'academy');
  assert.deepEqual(detectScriptTenant(S([`${APP}/a?company_id=1048`,`${APP}/b?company_id=1048`])).tenant,'sandbox');
  // the start URL alone misses some: company only on a later step
  const late=detectScriptTenant(S([`${APP}/a`,`${APP}/b?x=1&company_id=1048`]));assert.equal(late.tenant,'sandbox');assert.deepEqual(late.companyIds,['1048']);
  const u=detectScriptTenant(S([`${APP}/a`,`${APP}/b`]));assert.equal(u.status,'unknown');assert.equal(u.tenant,null);
  const c=detectScriptTenant(S([`${APP}/a?company_id=1150`,`${APP}/b?company_id=1048`]));assert.equal(c.status,'conflict');assert.equal(c.tenant,null);assert.deepEqual(c.companyIds,['1048','1150']);
  const r=detectScriptTenant(S([`${APP}/a?company_id=777`]));assert.equal(r.status,'unregistered');
  assert.deepEqual(scriptCompanyIds({steps:[{route:'/x?company_id=1048'},{url:'not a url'}]}),['1048']);
  assert.equal(detectScriptTenant({}).status,'unknown');
});
test('buildAllowlist: per-tenant lists + counts; internal records excluded', () => {
  const a=buildAllowlist([S([`${APP}/a?company_id=1150`],{name:'A'}),S([`${APP}/a?company_id=1048`],{name:'B'}),S([`${APP}/a`],{name:'C'}),
    S([`${APP}/a?company_id=1150`,`${APP}/a?company_id=1048`],{name:'D'}),S([`${APP}/a?company_id=1150`],{name:'_studio-x'})],{now:new Date(0)});
  assert.deepEqual([a.academy.map(x=>x.name),a.sandbox.map(x=>x.name),a.unknown.map(x=>x.name),a.conflict.map(x=>x.name)],[['A'],['B'],['C'],['D']]);
  assert.deepEqual(a.counts,{academy:1,sandbox:1,unknown:1,conflict:1,unregistered:0});
  assert.equal(a.academy[0].company_id,'1150');assert.equal(a.sandbox[0].company_id,'1048');
});
test('allowlist.json: per-tenant object; academy = every company-1150 walkthrough, sandbox all 1048, no internal records', () => {
  const o=JSON.parse(readFileSync(new URL('../../tools/drift/allowlist.json',import.meta.url),'utf8'));
  assert.equal(o.schema,2);assert.ok(o.academy.length>=41);assert.equal(o.counts.academy,o.academy.length);assert.equal(o.counts.sandbox,o.sandbox.length);assert.equal(o.counts.unknown,o.unknown.length);
  assert.ok(o.academy.every(x=>x.company_id==='1150'&&!x.name.startsWith('_studio')));
  assert.ok(o.sandbox.length>0&&o.sandbox.every(x=>x.company_id==='1048'&&!x.name.startsWith('_studio')));
  assert.ok(o.unknown.every(x=>x.company_ids.length===0));
});

// ---------- capture tenant checks with a fake browser ----------
function fakeChromium({bodyText}){
  const actions=[];const launches=[];
  const mkPage=()=>{let url='about:blank';return {url:()=>url,goto:async(u)=>{actions.push(['goto',u]);url=u;},waitForURL:async()=>{},waitForTimeout:async()=>{},waitForLoadState:async()=>{},setViewportSize:async()=>{},on:()=>{},
    title:async()=>'T',screenshot:async({path})=>{writeFileSync(path,'png');actions.push(['shot',url]);},keyboard:{press:async()=>{}},isClosed:()=>false,
    evaluate:async(expr)=>{const e=String(expr);if(e.includes('aria-busy'))return false;
      if(e.includes('hasPassword')){const m=/\)\(("(?:[^"\\]|\\.)*")\)$/.exec(e);const name=m?JSON.parse(m[1]):null;
        return {url,hasPassword:false,hasAppNav:true,academy:/Hadrius Academy/.test(bodyText),tenantNameVisible:!!name&&bodyText.toLowerCase().includes(name.toLowerCase()),title:'T'};}
      return [];},evaluateHandle:async()=>({evaluate:async()=>null})};};
  return {actions,launches,launchPersistentContext:async(dir)=>{launches.push(dir);const p=mkPage();return {route:async()=>{},addInitScript:async()=>{},pages:()=>[p],newPage:async()=>p,close:async()=>{}};}};
}
const LIM={stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0,loadingWaitMs:0};
async function cap({url,profile,bodyText,session={status:'already_signed_in',companyIds:[1048]},tenant=null,extra={}}){
  const dir=mkdtempSync(join(tmpdir(),'drift-tenant-'));const prof=join(dir,profile);mkdirSync(prof);
  const script={name:'t',recording:{id:'r'},environment:{startUrl:url},steps:[{index:0,action:'navigate',url,value:url,route:'/x'}],...extra};
  const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(script));
  const fc=fakeChromium({bodyText});const calls=[];const orig=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),tenant,log:()=>{},chromium:fc,limits:LIM,
      ensureSession:async(o)=>{calls.push(o.profileDir);return session;}});return {run,fc,calls,prof};}
  finally{globalThis.fetch=orig;}
}
test('capture: Sandbox script + Sandbox profile + Sandbox name visible + session [1048] -> tenant verified', async () => {
  const {run,calls,prof}=await cap({url:`${APP}/marketing/export?company_id=1048`,profile:'.browser-profile-drift-sandbox',bodyText:'Hadrius Sandbox  Marketing'});
  assert.equal(run.status,'captured',JSON.stringify(run.findings));assert.equal(run.tenantVerified,true);assert.equal(run.tenantKey,'sandbox');
  assert.equal(run.tenant.tenant,'sandbox');assert.equal(run.tenant.tenantNameVisible,true);assert.deepEqual(calls,[prof]);
});
test('capture: Sandbox URL without company_id passes only via a [1048]-only session; [1048,1150] fails closed', async () => {
  const ok=await cap({url:`${APP}/marketing/export`,profile:'.browser-profile-drift-sandbox',tenant:'sandbox',bodyText:'Hadrius Sandbox'});
  assert.equal(ok.run.tenantVerified,true);assert.equal(ok.run.tenant.viaSession,true);
  const bad=await cap({url:`${APP}/marketing/export`,profile:'.browser-profile-drift-sandbox',tenant:'sandbox',bodyText:'Hadrius Sandbox',session:{status:'already_signed_in',companyIds:[1048,1150]}});
  assert.equal(bad.run.tenantVerified,false);assert.equal(bad.run.status,'aborted');assert.match(bad.run.aborted,/tenant_mismatch/);
});
test('capture: Sandbox name not on the page -> tenant_mismatch (Academy name does not count for Sandbox)', async () => {
  const {run}=await cap({url:`${APP}/marketing/export?company_id=1048`,profile:'.browser-profile-drift-sandbox',bodyText:'Hadrius Academy'});
  assert.equal(run.tenantVerified,false);assert.match(run.aborted,/tenant_mismatch/);
});
test('capture: a Sandbox script on the Academy profile (or vice versa) fails closed before any browser launch', async () => {
  const a=await cap({url:`${APP}/marketing/export?company_id=1048`,profile:'.browser-profile-drift',bodyText:'Hadrius Sandbox'});
  assert.equal(a.run.status,'tenant_mismatch');assert.equal(a.fc.launches.length,0);assert.deepEqual(a.calls,[]);
  const b=await cap({url:`${APP}/a?company_id=1150`,profile:'.browser-profile-drift-sandbox',bodyText:'Hadrius Academy'});
  assert.equal(b.run.status,'tenant_mismatch');assert.equal(b.fc.launches.length,0);
  const c=await cap({url:`${APP}/a?company_id=1048`,profile:'.browser-profile-drift-sandbox',tenant:'academy',bodyText:'x'});
  assert.equal(c.run.status,'tenant_mismatch');assert.match(c.run.findings[0].problem,/profile_belongs_to_sandbox/);
  const d=await cap({url:`${APP}/a?company_id=1048`,profile:'.browser-profile-drift-sandbox',bodyText:'x',extra:{steps:[{index:0,action:'navigate',url:`${APP}/a?company_id=1150`,value:`${APP}/a?company_id=1150`}]}});
  assert.equal(d.run.status,'tenant_mismatch');assert.equal(d.fc.launches.length,0,'conflicting company ids never launch');
});
test('capture: Academy behaviour unchanged (1150 + legacy academy probe field)', async () => {
  const {run}=await cap({url:`${APP}/a?company_id=1150`,profile:'.browser-profile-drift',bodyText:'Hadrius Academy',session:{status:'already_signed_in',companyIds:[1150]}});
  assert.equal(run.status,'captured');assert.equal(run.tenantVerified,true);assert.equal(run.tenantKey,undefined);assert.deepEqual(Object.keys(run.tenant),['urlCompanyId','academyVisible','session','viaSession']);
  assert.equal(tenantNameVisible({academy:true},'academy'),true);assert.equal(tenantNameVisible({academy:true},'sandbox'),false);
});
test('resolveRunTenant / preflight / isDriftProfile know the Sandbox profile', () => {
  assert.ok(isDriftProfile('/r/.browser-profile-drift-sandbox'));
  assert.ok(!preflight({profileDir:'/x/.browser-profile-drift-sandbox',bridgeStatus:{running:false},psOutput:''}).includes('profile_not_ai_slot'));
  assert.equal(resolveRunTenant({expectedCompany:'1048'}).tenant.key,'sandbox');assert.equal(resolveRunTenant({}).tenant.key,'academy');
  assert.equal(resolveRunTenant({expectedCompany:'777'}).ok,false);
  assert.equal(resolveRunTenant({tenant:'sandbox',expectedCompany:'1150'}).ok,false);
});
test('withAppPage: start URL must be the tenant company', async () => {
  const r=await withAppPage({tenant:'sandbox',startUrl:`${APP}/testing-program/risks?company_id=1150`,fn:async()=>{throw new Error('must not run');}});
  assert.equal(r.status,'tenant_check_failed');
});

// ---------- fixtures: spec companyId must match the run tenant ----------
const SPEC=(companyId)=>({schema:1,video:'V',labelKey:'v-test',companyId,apiHost:'hadriusapi.com',reviewed:{by:'t',at:'2026-10-29'},
  recordTypes:{r:{list:{path:'/api/company/{companyId}/r/',nameField:'name'},item:{path:'/api/company/{companyId}/r/{fixtureId}/'},create:{method:'POST',path:'/api/company/{companyId}/r/',nameField:'name'},cleanup:{method:'DELETE',path:'/api/company/{companyId}/r/{fixtureId}/'}}},
  fixtures:[{key:'r1',recordType:'r',name:'{label} x',create:{via:'api'}}],steps:[],cleanupOrder:['r1']});
const SCRIPT=(cid)=>({name:'V',environment:{startUrl:`${APP}/a?company_id=${cid}`},steps:[{index:0,action:'navigate',url:`${APP}/a?company_id=${cid}`}]});
test('fixtures: spec companyId must equal the run tenant; script tenant must match too', () => {
  assert.deepEqual(validateSpec(SPEC(1150)),[]);
  assert.ok(validateSpec(SPEC(1048)).includes('company_not_1150'),'academy default unchanged');
  assert.deepEqual(validateSpec(SPEC(1048),{tenant:'sandbox',script:SCRIPT(1048)}),[]);
  assert.ok(validateSpec(SPEC(1150),{tenant:'sandbox'}).includes('company_not_1048'));
  assert.ok(validateSpec(SPEC(1048),{tenant:'sandbox',script:SCRIPT(1150)}).includes('script_tenant_academy_not_sandbox'));
  const jd=mkdtempSync(join(tmpdir(),'drift-tenant-j-'));
  assert.throws(()=>createFixtureSession({spec:SPEC(1150),script:SCRIPT(1048),tenant:'sandbox',journalDir:jd}),/company_not_1048/);
  assert.throws(()=>createFixtureSession({spec:SPEC(1048),script:SCRIPT(1048),journalDir:jd}),/company_not_1150/);
  const s=createFixtureSession({spec:SPEC(1048),script:SCRIPT(1048),tenant:'sandbox',journalDir:jd,otherSpecs:[SPEC(1150)]});
  assert.equal(s.tenant,'sandbox');assert.match(s.label,/^\[Studio QA\] v-test /);
  s.finish('test');
});
test('capture refuses a fixture session of another tenant', async () => {
  const {run}=await cap({url:`${APP}/a?company_id=1048`,profile:'.browser-profile-drift-sandbox',bodyText:'Hadrius Sandbox',extra:{}}).catch(e=>({run:{status:String(e)}}));
  assert.equal(run.status,'captured');
  const dir=mkdtempSync(join(tmpdir(),'drift-tenant-'));const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);
  const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(SCRIPT(1150)));
  const r=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fakeChromium({bodyText:''}),limits:LIM,
    fixture:{tenant:'sandbox',runId:'x',label:'l',journal:{file:'f'}},ensureSession:async()=>{throw new Error('must not sign in');}});
  assert.equal(r.status,'tenant_mismatch');assert.match(r.findings[0].problem,/fixture_tenant_sandbox_not_academy/);
});
