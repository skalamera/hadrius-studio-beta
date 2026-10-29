// Pure-part tests for the read-only recapture (tools/drift/capture.mjs) and the
// screenshot comparison (tools/drift/compare.mjs). No browser, no network:
// synthetic request descriptors, synthetic DOM descriptors and synthetic PNGs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {
  classifyRequest, resolveTarget, rectDelta, preflight, companyIdOf, signedInFromProbe, normalizeName, isProjectDetailHref, dynamicTextKind,
  classifyStepMutation, mutatingWord, mutationPlan, DEFAULT_PROFILE, isDriftProfile, captureRun, createRequestGuard, fixtureEvidence, recordRefsFromUrl,
} from '../../tools/drift/capture.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {
  decodePng, encodePng, diffImages, ssim, changedRegions, classifyStep, DEFAULT_THRESHOLDS, compareImages,
} from '../../tools/drift/compare.mjs';

// Independent PNG writer (not the module under test) so decode is checked against a known layout.
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);}
function rgbPng(w,h,pixel){const rows=[];for(let y=0;y<h;y++){const row=Buffer.alloc(1+w*3);for(let x=0;x<w;x++){const [r,g,b]=pixel(x,y);row[1+x*3]=r;row[2+x*3]=g;row[3+x*3]=b;}rows.push(row);}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);}
const grey=(x,y)=>{const v=(x*7+y*13)%200+20;return [v,v,v];};

// ---------- request guard ----------
const APP='https://app.hadrius.com';
test('request guard: GET/HEAD/OPTIONS are allowed silently', () => {
  for (const method of ['GET','HEAD','OPTIONS']) assert.equal(classifyRequest({method,url:`${APP}/api/projects`}).decision,'allow');
});
test('request guard: PUT/PATCH/DELETE to app/api hosts are aborted (fail the video)', () => {
  for (const method of ['PUT','PATCH','DELETE']) {
    const r=classifyRequest({method,url:'https://api.hadrius.com/v1/projects/41113'});
    assert.equal(r.decision,'abort',method);
  }
});
test('request guard: mutation-named non-GET paths abort the run', () => {
  for (const url of [`${APP}/api/projects/create`,'https://api.hadrius.com/v1/project/41113/archive','https://api.hadrius.com/v1/updateProject','https://api.hadrius.com/graphql/mutation','https://api.hadrius.com/v1/delete-doc']) {
    assert.equal(classifyRequest({method:'POST',url}).decision,'abort',url);
  }
});
test('request guard: GraphQL POST read queries are allowed but logged; mutations abort', () => {
  const read=classifyRequest({method:'POST',url:'https://api.hadrius.com/graphql',postData:JSON.stringify({query:'query Projects { projects { id } }'})});
  assert.equal(read.decision,'allow_logged');
  const anon=classifyRequest({method:'POST',url:'https://api.hadrius.com/graphql',postData:JSON.stringify({query:'{ projects { id } }'})});
  assert.equal(anon.decision,'allow_logged');
  const mut=classifyRequest({method:'POST',url:'https://api.hadrius.com/graphql',postData:JSON.stringify({query:'mutation Archive { archiveProject(id: 1) { id } }'})});
  assert.equal(mut.decision,'abort');
  const batch=classifyRequest({method:'POST',url:'https://api.hadrius.com/graphql',postData:JSON.stringify([{query:'query A { a }'},{query:'  mutation B { b }'}])});
  assert.equal(batch.decision,'abort');
});
test('request guard: Cognito token refresh is allowed and logged; other Cognito targets blocked', () => {
  const ok=classifyRequest({method:'POST',url:'https://cognito-idp.us-east-1.amazonaws.com/',headers:{'x-amz-target':'AWSCognitoIdentityProviderService.InitiateAuth'},postData:JSON.stringify({AuthFlow:'REFRESH_TOKEN_AUTH'})});
  assert.equal(ok.decision,'allow_logged');
  const pw=classifyRequest({method:'POST',url:'https://cognito-idp.us-east-1.amazonaws.com/',headers:{'x-amz-target':'AWSCognitoIdentityProviderService.InitiateAuth'},postData:JSON.stringify({AuthFlow:'USER_PASSWORD_AUTH'})});
  assert.equal(pw.decision,'block');
  const upd=classifyRequest({method:'POST',url:'https://cognito-idp.us-east-1.amazonaws.com/',headers:{'x-amz-target':'AWSCognitoIdentityProviderService.UpdateUserAttributes'}});
  assert.notEqual(upd.decision,'allow_logged');
  // Refresh-token rotation API used by the live app (regression: blocking it bounced the app to sign-in).
  const rot=classifyRequest({method:'POST',url:'https://cognito-idp.us-east-2.amazonaws.com/',headers:{'X-Amz-Target':'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken'}});
  assert.equal(rot.decision,'allow_logged');
});
test('request guard: manual-login mode lets the human complete Cognito sign-in, still never app writes', () => {
  const srp={method:'POST',url:'https://cognito-idp.us-east-2.amazonaws.com/',headers:{'x-amz-target':'AWSCognitoIdentityProviderService.InitiateAuth'},postData:JSON.stringify({AuthFlow:'USER_SRP_AUTH'})};
  assert.equal(classifyRequest(srp).decision,'block');
  assert.equal(classifyRequest(srp,{mode:'manual_login'}).decision,'allow_logged');
  const chal={method:'POST',url:'https://cognito-idp.us-east-2.amazonaws.com/',headers:{'x-amz-target':'AWSCognitoIdentityProviderService.RespondToAuthChallenge'}};
  assert.equal(classifyRequest(chal,{mode:'manual_login'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://api.hadrius.com/v1/projects/create'},{mode:'manual_login'}).decision,'abort');
  assert.equal(classifyRequest({method:'PUT',url:'https://api.hadrius.com/v1/projects/1'},{mode:'manual_login'}).decision,'abort');
});
test('request guard: PostHog feature-flag reads pass (logged); analytics capture is blocked', () => {
  assert.equal(classifyRequest({method:'POST',url:'https://us.i.posthog.com/flags/?v=2'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://us.i.posthog.com/decide/?v=3'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://us.i.posthog.com/e/?ip=1'}).decision,'block');
});
test('request guard: read-named REST POST is allowed+logged; unknown app POST aborts; third-party POST blocked', () => {
  assert.equal(classifyRequest({method:'POST',url:'https://api.hadrius.com/v1/projects/search'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://api.hadrius.com/v1/projects/list'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://api.hadrius.com/v1/projects'}).decision,'abort');
  assert.equal(classifyRequest({method:'POST',url:'https://o123.ingest.sentry.io/api/1/envelope/'}).decision,'block');
  // Blocked third-party POSTs never abort even when a word matches: they are not Hadrius data.
  assert.equal(classifyRequest({method:'POST',url:'https://api.segment.io/v1/update'}).decision,'block');
});
test('request guard: hadriusapi.com is an app API host (live app backend)', () => {
  assert.equal(classifyRequest({method:'POST',url:'https://hadriusapi.com/api/users/analytics/13372/track-event/'}).reason,'telemetry_blocked');
  assert.equal(classifyRequest({method:'POST',url:'https://hadriusapi.com/api/users/analytics/13372/track-event/'},{mode:'manual_login'}).decision,'block');
  assert.equal(classifyRequest({method:'POST',url:'https://hadriusapi.com/api/marketing/projects/41113/archive/'}).decision,'abort');
  assert.equal(classifyRequest({method:'PATCH',url:'https://hadriusapi.com/api/marketing/projects/41113/'}).decision,'abort');
});
test('request guard: data: and blob: URLs are not network writes', () => {
  assert.equal(classifyRequest({method:'GET',url:'data:image/png;base64,AAA'}).decision,'allow');
});

// ---------- sign-in / tenant ----------
test('signed-in probe mirrors ai-record isSignedIn', () => {
  assert.equal(signedInFromProbe({url:`${APP}/marketing/projects?company_id=1150`,hasPassword:false,hasAppNav:true},APP),true);
  assert.equal(signedInFromProbe({url:`${APP}/auth/sign-in`,hasPassword:true,hasAppNav:false},APP),false);
  assert.equal(signedInFromProbe({url:'https://login.hadrius.com/oauth2/authorize',hasPassword:false,hasAppNav:false},APP),false);
  assert.equal(signedInFromProbe({url:`${APP}/settings/integrations`,hasPassword:true,hasAppNav:true},APP),true);
  assert.equal(signedInFromProbe({url:`${APP}/overview`,hasPassword:true,hasAppNav:false},APP),false);
});
test('preflight: only a browser on the profile counts as in use; bridge must be idle', () => {
  const dir='/nonexistent/.browser-profile-ai-3';
  const own=`123 node tools/drift/capture.mjs --profile ${dir} --out x`;
  assert.ok(!preflight({profileDir:dir,bridgeStatus:{running:false},psOutput:own}).includes('profile_in_use'));
  assert.ok(preflight({profileDir:dir,bridgeStatus:{running:false},psOutput:`9 /x/Chromium --user-data-dir=${dir} --headless`}).includes('profile_in_use'));
  assert.ok(preflight({profileDir:dir,bridgeStatus:{running:true},psOutput:''}).includes('bridge_not_idle'));
  assert.ok(preflight({profileDir:'/x/.browser-profile',bridgeStatus:{running:false},psOutput:''}).includes('profile_not_ai_slot'));
  assert.ok(!preflight({profileDir:'/x/.browser-profile-drift',bridgeStatus:{running:false},psOutput:''}).includes('profile_not_ai_slot'));
  assert.ok(preflight({profileDir:'/x/.browser-profile-drift',bridgeStatus:{running:false},psOutput:'9 Chromium --user-data-dir=/x/.browser-profile-drift'}).includes('profile_in_use'));
});
test('default profile is the dedicated drift profile', () => {
  assert.equal(basename(DEFAULT_PROFILE),'.browser-profile-drift');assert.ok(isDriftProfile(DEFAULT_PROFILE));assert.ok(!isDriftProfile('/x/.browser-profile-ai-3'));
});
test('request guard auto_login: Cognito auth + hosted UI pass, analytics/Sentry/app writes are blocked', () => {
  const cog='https://cognito-idp.us-east-1.amazonaws.com/';
  assert.equal(classifyRequest({method:'POST',url:cog,headers:{'X-Amz-Target':'AWSCognitoIdentityProviderService.InitiateAuth'},postData:'{"AuthFlow":"USER_SRP_AUTH"}'},{mode:'auto_login'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://hadrius.auth.us-east-1.amazoncognito.com/login'},{mode:'auto_login'}).decision,'allow_logged');
  assert.equal(classifyRequest({method:'POST',url:'https://o1.ingest.sentry.io/api/1/envelope/'},{mode:'auto_login'}).decision,'block');
  assert.equal(classifyRequest({method:'POST',url:'https://us.i.posthog.com/e/'},{mode:'auto_login'}).decision,'block');
  assert.equal(classifyRequest({method:'POST',url:'https://hadriusapi.com/api/users/analytics/1/track-event/'},{mode:'auto_login'}).decision,'block');
  assert.equal(classifyRequest({method:'POST',url:'https://hadriusapi.com/api/policies/9/archive/'},{mode:'auto_login'}).decision,'abort');
  // recapture mode never lets the hosted UI through
  assert.equal(classifyRequest({method:'POST',url:'https://hadrius.auth.us-east-1.amazoncognito.com/login'}).decision,'block');
});

// ---------- mutation guard ----------
const click=(target)=>({index:1,action:'click',url:`${APP}/x`,target});
test('mutation guard: data-changing names are never replayed', () => {
  for (const name of ['Save','Submit for review','Create project','Add documents','New','Delete','Remove member','Archive','Restore version','Activate sandbox','Deactivate',
    'Run test','Send email','Approve','Reject','Assign reviewer','Publish','Upload artifact','Import CSV','Confirm','Cancel task','Withdraw project','Request changes','Share project link','Sign out','Mark as resolved'])
    assert.equal(classifyStepMutation(click({role:'button',tag:'button',name})).mutating,true,name);
  // the archive pilot: menu item and confirm button
  assert.equal(classifyStepMutation(click({role:'menuitem',tag:'div',name:'Archive',text:'Archive'})).reason,'name_matches:archive');
});
test('mutation guard: read-only navigation clicks are allowed', () => {
  for (const name of ['View audit trail','Review flag','All Flags','View','Workflow in progress 1 Test Project Last updated at: 09-25-2026 GV AF','Approved 2 4 Test Project','Resolved','Dashboard','Comments','Activity log'])
    assert.equal(classifyStepMutation(click({role:/^(View|Review|All|Dash|Comm|Act)/.test(name)?'button':'link',tag:'a',name})).mutating,false,name);
});
test('mutation guard: "Actions for <entity>" menu openers check only the action head', () => {
  assert.equal(mutatingWord('Actions for Hadrius Sandbox Advisors - Updated'),null);
  assert.equal(mutatingWord('More actions for Delete-me project'),null);
  assert.equal(mutatingWord('Hadrius Sandbox Advisors'),'sandbox');
  assert.equal(classifyStepMutation(click({role:'button',tag:'button',name:'Actions for Hadrius Sandbox Advisors - Updated'})).mutating,false);
});
test('mutation guard: word boundaries (Approved/Updated/Marketing do not match)', () => {
  for (const n of ['Approved','Last updated at','Marketing','Resolved','Assigned to me','Removed items'])assert.equal(mutatingWord(n),null,n);
});
test('mutation guard: typing, uploads, unknown actions, toggles, form submits and Enter are mutating', () => {
  assert.equal(classifyStepMutation({action:'type',target:{role:'textbox',name:'Search'},value:'x'}).reason,'typing_into_input');
  assert.equal(classifyStepMutation({action:'upload',target:{role:'button',name:'Browse'}}).reason,'file_upload');
  assert.equal(classifyStepMutation({action:'custom'}).mutating,true);
  assert.equal(classifyStepMutation({action:'press',key:'Enter'}).mutating,true);
  assert.equal(classifyStepMutation({action:'press',key:'Escape'}).mutating,false);
  for (const role of ['checkbox','switch','radio','option','menuitemcheckbox'])assert.equal(classifyStepMutation(click({role,tag:'button',name:'Email alerts'})).mutating,true,role);
  assert.equal(classifyStepMutation(click({role:'button',tag:'button',name:'Next'}),{role:'button',tag:'button',name:'Next',submits:true}).reason,'form_submit');
  assert.equal(classifyStepMutation(click({role:'button',tag:'button',name:'Browse'}),{role:'button',tag:'div',name:'Browse',fileInput:true}).reason,'file_upload');
  assert.equal(classifyStepMutation(click({role:'button',tag:'button',name:'Open'}),{role:'button',name:'Delete'}).reason,'todayName_matches:delete');
  assert.equal(classifyStepMutation(click({role:'button',tag:'button'})).reason,'unnamed_target');
  assert.equal(classifyStepMutation({action:'navigate',url:`${APP}/x`}).mutating,false);
  assert.equal(classifyStepMutation({action:'hover',target:{name:'Delete'}}).mutating,false);
});
test('mutationPlan over the real archive-a-policy script stops at the Archive menu item (read-only file read)', () => {
  const p=new URL('../../scripts/How-to-archive-a-policy.script.json',import.meta.url);
  if(!existsSync(p))return;
  const plan=mutationPlan(JSON.parse(readFileSync(p,'utf8')));
  assert.equal(plan.find(x=>x.mutating).index,2);assert.deepEqual(plan.map(x=>x.mutating),[false,false,true,true]);
});

// ---------- captureRun with a fake browser (no network, no Playwright) ----------
function fakeChromium(pages){
  // pages: url -> {candidates:[...]}; records every action.
  const actions=[];
  const mkPage=()=>{let url='about:blank';const page={
    url:()=>url,goto:async(u)=>{actions.push(['goto',u]);url=u;},waitForURL:async()=>{},waitForTimeout:async()=>{},waitForLoadState:async()=>{},setViewportSize:async()=>{},on:()=>{},
    title:async()=>'T',screenshot:async({path})=>{writeFileSync(path,'png');actions.push(['shot',url]);},
    keyboard:{press:async(k)=>actions.push(['press',k])},
    evaluate:async(expr)=>{const e=String(expr);
      if(e.includes('aria-busy'))return false;
      if(e.includes('hasPassword'))return {url,hasPassword:false,hasAppNav:true,academy:true,title:'T'};
      if(e.includes('__driftCandidates'))return (pages[url]?.candidates??[]).map((c,i)=>({i,visible:true,cssMatch:false,href:null,bbox:{x:1,y:1,w:10,h:10},...c}));
      return [];},
    evaluateHandle:async(_fn,i)=>{const c=(pages[url]?.candidates??[])[i];return {evaluate:async()=>c?{name:c.name,href:c.href??null}:null,
      click:async()=>{actions.push(['click',c.name]);if(c.to)url=c.to;if(c.fires&&handler)await handler({request:()=>({method:()=>c.fires.method,url:()=>c.fires.url,postData:()=>null,headers:()=>({})}),
        continue:async()=>actions.push(['net_continue',c.fires.url]),abort:async()=>actions.push(['net_abort',c.fires.url])});},hover:async()=>actions.push(['hover',c.name]),focus:async()=>{}};},
  };return page;};
  let handler=null;
  return {actions,launchPersistentContext:async()=>{const p=mkPage();return {route:async(_pat,h)=>{handler=h;},pages:()=>[p],newPage:async()=>p,close:async()=>{}};}};
}
test('captureRun: stops before the mutating step, never clicks it, later non-navigate steps are not_verified', async () => {
  const dir=mkdtempSync(join(tmpdir(),'drift-cap-'));const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);
  const L=`${APP}/testing-program/policies?company_id=1150`;
  const script={name:'fake',environment:{startUrl:L},recording:{id:'r'},steps:[
    {index:0,action:'navigate',url:L,value:L,route:'/testing-program/policies?company_id=1150',media:{pre:'a.png'}},
    {index:1,action:'click',url:L,route:'/testing-program/policies?company_id=1150',media:{pre:'b.png'},target:{role:'button',tag:'button',name:'Actions for Policy A'}},
    {index:2,action:'click',url:L,route:'/testing-program/policies?company_id=1150',media:{pre:'c.png'},target:{role:'menuitem',tag:'div',name:'Archive'}},
    {index:3,action:'click',url:L,route:'/testing-program/policies?company_id=1150',media:{pre:'d.png'},target:{role:'button',tag:'button',name:'Archive'}},
    {index:4,action:'navigate',url:`${APP}/x?company_id=1150`,value:`${APP}/x?company_id=1150`,route:'/x?company_id=1150',media:{pre:'e.png'}}]};
  const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(script));
  const fc=fakeChromium({[L]:{candidates:[{role:'button',tag:'button',name:'Actions for Policy A'},{role:'menuitem',tag:'div',name:'Archive'},{role:'button',tag:'button',name:'Archive'}]}});
  const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  let sessionCalls=0;
  try{
    const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fc,ensureSession:async()=>{sessionCalls++;return {status:'already_signed_in',companyIds:[1150]};},limits:{stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0}});
    assert.equal(sessionCalls,1);
    assert.equal(run.mutationStop.index,2);
    assert.deepEqual(fc.actions.filter(a=>a[0]==='click').map(a=>a[1]),['Actions for Policy A']);
    assert.equal(run.steps[2].mutationGuard.status,'needs_fixture');assert.ok(run.steps[2].screenshot,'pre-action shot of the stopped step');
    assert.equal(run.steps[3].mutationGuard.status,'needs_fixture');assert.equal(run.steps[3].screenshot,undefined);
    assert.ok(run.steps[2].mutationGuard.fixture.records.some(r=>r.name==='Policy A'),'record opened from the Actions menu');
    assert.equal(run.steps[3].mutationGuard.fixture.target.name,'Archive');assert.equal(run.mutationStop.fixture.pageUrl,L);
    assert.equal(run.steps[4].prerequisiteUnverified,true);assert.ok(run.steps[4].screenshot);
    assert.equal(run.status,'captured_partial_mutation_guard');assert.ok(run.steps.every(st=>st.pageState!=='loading'));
  }finally{globalThis.fetch=origFetch;}
});
test('captureRun: any non-success session status fails closed before any page is opened', async () => {
  const dir=mkdtempSync(join(tmpdir(),'drift-cap-'));const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);
  const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify({name:'f',environment:{startUrl:`${APP}/a`},steps:[{index:0,action:'navigate',url:`${APP}/a`}]}));
  const fc=fakeChromium({});const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{for (const status of ['mfa_required','tenant_mismatch','keychain_missing','unexpected','not_signed_in']){
    const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,`run-${status}`),log:()=>{},chromium:fc,ensureSession:async()=>({status})});
    assert.equal(run.status,'session_failed',status);}
    assert.equal(fc.actions.length,0);
  }finally{globalThis.fetch=origFetch;}
});
test('companyIdOf reads the company_id query parameter', () => {
  assert.equal(companyIdOf(`${APP}/marketing/projects?company_id=1150`),'1150');
  assert.equal(companyIdOf(`${APP}/marketing/project/41113`),null);
});

// ---------- target resolution ----------
const recorded={role:'link',tag:'a',name:'Workflow in progress 1 Test Project Last updated at: 09-25-2026 GV AF',css:'div > a:nth-of-type(1)',hint:{bbox:{x:289,y:227,w:415,h:147},viewport:{w:1600,h:900}}};
const card=(over={})=>({role:'link',tag:'a',name:recorded.name,href:`${APP}/marketing/project/41113`,cssMatch:false,visible:true,bbox:{x:289,y:227,w:415,h:147},...over});
test('resolveTarget: unique exact role+name wins', () => {
  const r=resolveTarget(recorded,[card(),card({name:'Workflow in progress 1 Aegis Framework Position Paper Last updated at: 09-22-2026 AS',href:`${APP}/marketing/project/2`,bbox:{x:289,y:383,w:415,h:139}})]);
  assert.equal(r.status,'resolved');assert.equal(r.method,'role_name');assert.equal(r.index,0);
});
test('resolveTarget: duplicated role+name is ambiguous, never guessed', () => {
  const r=resolveTarget(recorded,[card(),card({href:`${APP}/marketing/project/9`})]);
  assert.equal(r.status,'ambiguous');assert.equal(r.matches.length,2);
});
test('resolveTarget: date-only name change resolves via normalized name and is reported', () => {
  const r=resolveTarget(recorded,[card({name:'Workflow in progress 1 Test Project Last updated at: 10-27-2026 GV AF'})]);
  assert.equal(r.status,'resolved');assert.equal(r.method,'role_name_normalized');
  assert.ok(r.notes.some(n=>/name_changed/.test(n)));
});
test('resolveTarget: falls back to a unique css match only when role/tag agree', () => {
  const r=resolveTarget(recorded,[card({name:'Something else',cssMatch:true})]);
  assert.equal(r.status,'resolved');assert.equal(r.method,'css');
  const wrong=resolveTarget(recorded,[card({name:'x',cssMatch:true,role:'button',tag:'button'})]);
  assert.equal(wrong.status,'missing');
});
test('resolveTarget: no match is missing; invisible candidates are ignored', () => {
  assert.equal(resolveTarget(recorded,[]).status,'missing');
  assert.equal(resolveTarget(recorded,[card({visible:false})]).status,'missing');
});
test('resolveTarget: a resolved element that is not a project-detail link is not clickable', () => {
  const r=resolveTarget(recorded,[card({href:`${APP}/marketing/projects?company_id=1150&tab=x`})],{requireHref:isProjectDetailHref});
  assert.equal(r.status,'not_navigation');
});
test('isProjectDetailHref / normalizeName / dynamicTextKind', () => {
  assert.equal(isProjectDetailHref(`${APP}/marketing/project/41113`),true);
  assert.equal(isProjectDetailHref(`${APP}/marketing/project/41113/edit`),false);
  assert.equal(isProjectDetailHref('https://evil.example/marketing/project/1'),false);
  assert.equal(normalizeName('Last updated at: 09-25-2026  GV'),'last updated at: <date> gv');
  assert.equal(dynamicTextKind('09-25-2026'),'date');
  assert.equal(dynamicTextKind('Last updated at: 09-25-2026'),'date');
  assert.equal(dynamicTextKind('3 minutes ago'),'relative_time');
  assert.equal(dynamicTextKind('Test Project'),null);
});
test('rectDelta reports per-edge pixel deltas', () => {
  assert.deepEqual(rectDelta({x:289,y:227,w:415,h:147},{x:289,y:230,w:415,h:150}),{dx:0,dy:3,dw:0,dh:3,max:3});
  assert.equal(rectDelta(null,{x:0,y:0,w:1,h:1}),null);
});

// ---------- compare ----------
test('decode/encode round trip on an independently written RGB PNG', () => {
  const img=decodePng(rgbPng(5,4,grey));
  assert.equal(img.width,5);assert.equal(img.height,4);
  assert.deepEqual([...img.data.subarray(0,4)],[...grey(0,0),255]);
  const again=decodePng(encodePng(img));assert.deepEqual(again.data,img.data);
});
test('identical images: zero diff, SSIM 1, no regions, unchanged', () => {
  const a=decodePng(rgbPng(64,48,grey)),b=decodePng(rgbPng(64,48,grey));
  const d=diffImages(a,b);assert.equal(d.changedPixels,0);
  assert.ok(Math.abs(ssim(a,b)-1)<1e-9);
  const c=compareImages(a,b);assert.equal(c.classification,'unchanged');assert.deepEqual(c.regions,[]);
});
test('sub-threshold noise (JPEG-like ±3) does not count as change', () => {
  const a=decodePng(rgbPng(64,48,grey)),b=decodePng(rgbPng(64,48,(x,y)=>grey(x,y).map(v=>v+((x+y)%2?3:-3))));
  assert.equal(diffImages(a,b).changedPixels,0);
  assert.equal(compareImages(a,b).classification,'unchanged');
});
test('a changed block is detected, localized, and classified screenshot_changed', () => {
  const a=decodePng(rgbPng(160,90,grey));
  const b=decodePng(rgbPng(160,90,(x,y)=>x>=100&&x<130&&y>=20&&y<40?[255,0,0]:grey(x,y)));
  const c=compareImages(a,b,{cell:8});
  assert.equal(c.classification,'screenshot_changed');
  assert.equal(c.regions.length,1);const r=c.regions[0];
  assert.ok(r.x<=100&&r.y<=20&&r.x+r.w>=130&&r.y+r.h>=40&&r.w<=48&&r.h<=36,JSON.stringify(r));
  assert.ok(c.ssim<0.999);
});
test('changes fully inside declared dynamic regions are reported but do not change the classification', () => {
  const a=decodePng(rgbPng(160,90,grey));
  const b=decodePng(rgbPng(160,90,(x,y)=>x>=100&&x<130&&y>=20&&y<40?[0,0,0]:grey(x,y)));
  const c=compareImages(a,b,{cell:8,dynamicRects:[{x:96,y:16,w:40,h:28,text:'10-27-2026',kind:'date'}]});
  assert.equal(c.classification,'unchanged');
  assert.ok(c.diffFraction>0);assert.equal(c.diffFractionNonDynamic,0);
  assert.equal(c.regions[0].dynamic,true);
  assert.ok(c.dynamicChangedPixels>0);
});
test('dimension mismatch is screenshot_changed with no pixel metric', () => {
  const c=compareImages(decodePng(rgbPng(16,9,grey)),decodePng(rgbPng(32,18,grey)));
  assert.equal(c.classification,'screenshot_changed');assert.equal(c.dimensionsMatch,false);assert.equal(c.ssim,null);
});
test('classifyStep precedence: missing > geometry > screenshot > unchanged', () => {
  const T=DEFAULT_THRESHOLDS;
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:0,ssimMasked:1,target:{status:'missing'}},T),'target_missing');
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:0,ssimMasked:1,target:{status:'ambiguous'}},T),'target_missing');
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:0,ssimMasked:1,target:{status:'resolved',delta:{max:T.targetPx+1}}},T),'target_geometry_changed');
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:0,ssimMasked:1,target:{status:'resolved',delta:{max:T.targetPx}}},T),'unchanged');
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:T.diffFraction*2,ssimMasked:1,target:null},T),'screenshot_changed');
  assert.equal(classifyStep({dimensionsMatch:true,diffFractionNonDynamic:0,ssimMasked:T.ssim-0.01,target:null},T),'screenshot_changed');
});
test('changedRegions merges adjacent cells and separates distant ones', () => {
  const w=64,h=32,mask=new Uint8Array(w*h);
  for(let y=2;y<6;y++)for(let x=2;x<20;x++)mask[y*w+x]=1;
  for(let y=20;y<24;y++)for(let x=50;x<60;x++)mask[y*w+x]=1;
  const r=changedRegions(mask,w,h,{cell:4});assert.equal(r.length,2);
});

// ---------- network guard (separate, pluggable) ----------
test('createRequestGuard: logs method+host+path, aborts unknown app writes and records the failure', () => {
  const g=createRequestGuard();
  assert.equal(g.decide({method:'GET',url:'https://hadriusapi.com/api/projects/1'}).decision,'allow');
  assert.equal(g.decide({method:'POST',url:'https://hadriusapi.com/api/users/analytics/1/track-event/'}).decision,'block');
  assert.equal(g.failure(),null,'telemetry is aborted at the network but does not fail the video');
  assert.equal(g.decide({method:'POST',url:'https://hadriusapi.com/api/policies/77/'}).decision,'abort');
  assert.equal(g.failure(),'network_guard: POST hadriusapi.com/api/policies/77/ (unclassified_app_post)');
  assert.equal(g.decide({method:'DELETE',url:'https://app.hadrius.com/api/x/1'}).decision,'abort');
  assert.match(g.failure(),/policies\/77/,'first failure is kept');
  assert.deepEqual(g.requests.map(r=>[r.method,r.path,r.decision]),[['POST','/api/users/analytics/1/track-event/','block'],['POST','/api/policies/77/','abort'],['DELETE','/api/x/1','abort']]);
  assert.equal(g.hostCounts['hadriusapi.com'],1);
});
test('createRequestGuard: an allowlist (future fixture record IDs) lets only the listed app write through', () => {
  const g=createRequestGuard({allow:[{method:'POST',host:'hadriusapi.com',pathRe:'^/api/policies/900123/archive/?$'}]});
  assert.equal(g.decide({method:'POST',url:'https://hadriusapi.com/api/policies/900123/archive/'}).reason,'allowlisted');
  assert.equal(g.decide({method:'POST',url:'https://hadriusapi.com/api/policies/77/archive/'}).decision,'abort');
  assert.equal(g.decide({method:'PATCH',url:'https://hadriusapi.com/api/policies/900123/archive/'}).decision,'abort','method must match');
  // allowlist never applies to third parties
  assert.equal(createRequestGuard({allow:[()=>true]}).decide({method:'POST',url:'https://o1.ingest.sentry.io/api/1/envelope/'}).decision,'block');
});
test('fixtureEvidence: action, target, page URL and the record the step acts on', () => {
  const steps=[{index:1,action:'click',url:`${APP}/testing-program/policies?company_id=1048`,target:{role:'button',tag:'button',name:'Actions for Hadrius Sandbox Advisors - Updated',css:'#radix-x'}},
    {index:2,action:'click',url:`${APP}/testing-program/policies?company_id=1048`,target:{role:'menuitem',tag:'div',name:'Archive',css:'div:nth-of-type(10)'}}];
  const f=fixtureEvidence(steps[1],{prevStep:steps[0],pageUrl:`${APP}/testing-program/policies?company_id=1048`});
  assert.equal(f.action,'click');assert.equal(f.target.role,'menuitem');assert.equal(f.target.css,'div:nth-of-type(10)');
  assert.ok(f.records.some(r=>r.kind==='named_entity'&&r.name==='Hadrius Sandbox Advisors - Updated'&&r.source==='opened_from_menu'));
  assert.ok(f.records.some(r=>r.kind==='company_id'&&r.id==='1048'));
  assert.deepEqual(recordRefsFromUrl(`${APP}/marketing/project/41113/documents/63254/1`,'u').map(r=>[r.kind,r.id]),[['project','41113'],['documents','63254']]);
  const t=fixtureEvidence({action:'click',url:`${APP}/a`,target:{name:'Delete'}},{today:{name:'Delete',href:`${APP}/marketing/project/55/delete`,recordHint:{id:'row-55',label:'Row 55'}}});
  assert.ok(t.records.some(r=>r.kind==='project'&&r.id==='55'&&r.source==='target_href'));assert.ok(t.records.some(r=>r.kind==='dom_record'&&r.id==='row-55'));
});
test('mutationPlan attaches fixture evidence only to guarded steps', () => {
  const plan=mutationPlan({steps:[{index:0,action:'navigate',url:`${APP}/a`},{index:1,action:'click',url:`${APP}/a/99`,target:{role:'button',name:'Archive'}}]});
  assert.equal(plan[0].fixture,undefined);assert.ok(plan[1].fixture.records.some(r=>r.id==='99'));
});
test('captureRun: a write that slips past the click guard is aborted at the network layer and fails the video', async () => {
  const dir=mkdtempSync(join(tmpdir(),'drift-cap-'));const prof=join(dir,'.browser-profile-drift');mkdirSync(prof);
  const L=`${APP}/p?company_id=1150`;
  const script={name:'f',environment:{startUrl:L},steps:[{index:0,action:'navigate',url:L,value:L,route:'/p?company_id=1150'},
    {index:1,action:'click',url:L,route:'/p?company_id=1150',target:{role:'button',tag:'button',name:'Open details'}},{index:2,action:'navigate',url:L,value:L,route:'/p?company_id=1150'}]};
  const sp=join(dir,'s.json');writeFileSync(sp,JSON.stringify(script));
  const fc=fakeChromium({[L]:{candidates:[{role:'button',tag:'button',name:'Open details',fires:{method:'PATCH',url:'https://hadriusapi.com/api/policies/5/'}}]}});
  const origFetch=globalThis.fetch;globalThis.fetch=async()=>({json:async()=>({running:false})});
  try{const run=await captureRun({scriptPath:sp,profileDir:prof,outDir:join(dir,'run'),log:()=>{},chromium:fc,ensureSession:async()=>({status:'already_signed_in'}),limits:{stepMs:5000,totalMs:30000,settleMs:0,idleMs:0,manualLoginMs:0}});
    assert.ok(fc.actions.some(a=>a[0]==='net_abort'));assert.ok(!fc.actions.some(a=>a[0]==='net_continue'&&/policies/.test(a[1])));
    assert.equal(run.status,'aborted');assert.match(run.aborted,/^network_guard: PATCH hadriusapi\.com\/api\/policies\/5\/ \(app_write_method\)$/);
    assert.equal(run.steps.length,2,'replay stops after the failing step');
    const req=JSON.parse(readFileSync(join(dir,'run','requests.json'),'utf8')).nonGet;assert.equal(req[0].method,'PATCH');assert.equal(req[0].path,'/api/policies/5/');
  }finally{globalThis.fetch=origFetch;}
});
