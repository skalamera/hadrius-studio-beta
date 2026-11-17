// Shell rollouts (shell-rollout.mjs): sidebar text classification from real OCR lines, the rollout record contract, the
// self-contained per-slide evidence check, and the offline evidence builder (fake OCR, cache).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {encodePng} from '../../tools/drift/compare.mjs';
import {classifyShellText,validateRollouts,loadRollouts,confirmsShellRollout,rolloutDigest,shellEvidence,shellState,SHELL_METHOD} from '../../tools/drift/shell-rollout.mjs';

// OCR lines as Apple Vision returned them for real frames (recorded 2026-09/10, replayed 2026-11-10).
const CLASSIC=['Hadrius Academy','1150','g8 Overview','People directory','• Documents','Templates','Vendors','* Testing program','Policies','Tests',
  'Findings','Calendar','Risks','Controls','Entities','2 People oversight','Trade monitoring','Holdings','O Need help?','E Announcements','>'];
const CLASSIC_FOOTER_HIDDEN=['+ Hadrius','Hadrius Academy','1150|','* Ask Hadrius','gå Overview','People directory','Documents','Templates','Vendors','User counts'];
const AGENTIC=['N Hadrius','Hadrius Academy 1150','* Ask Hadrius','~ Inbox','54','PROGRAM','9= Testing program','° People oversight','dA Branches',
  'Q Communications','Marketing','Projects','SYSTEM','g8 Overview','g People directory','Need help?','SS','Stephen Skalamera','stephen@hadrius.com'];
const AGENTIC_GLYPHS=['• Hadrius','Hadrius Academy','1150','* Ask Hadrius','• Inbox','54','PROGRAMI','9= Testing program','SYSTEMI','gå Overview','Need help?'];
// Tab list scrolled to the active tab (settings/templates pages): Inbox and PROGRAM are off screen; SYSTEM lists Templates/Vendors.
const AGENTIC_SCROLLED=['Hadrius','Hadrius Academy','1150','T Ask Hadrius','~ Communications','Email','Instant messages','f Marketing','Projects',
  '$ Account surveillance','Overview','SYSTEM','Bå Overview','People directory','Vendors','Documents','Templates','Need help?','SS','Stephen Skalamera','stephen@hadrius.com'];
const NO_SIDEBAR=['Marketing Projects','Submitter review 2','o Workflow in prog','Test Project','Last updated at: 09-2!','GVAF','dab'];

test('classifyShellText: classic, agentic (also scrolled or with OCR glyphs), and no sidebar', () => {
  assert.equal(classifyShellText(CLASSIC),'classic');
  assert.equal(classifyShellText(CLASSIC_FOOTER_HIDDEN),'classic','Templates and Vendors at top level are the classic sidebar');
  assert.equal(classifyShellText(AGENTIC),'agentic');
  assert.equal(classifyShellText(AGENTIC_GLYPHS),'agentic','a chevron read as a trailing I');
  assert.equal(classifyShellText(AGENTIC_SCROLLED),'agentic','SYSTEM heading plus the user footer, Inbox scrolled away');
  assert.equal(classifyShellText(NO_SIDEBAR),null);
  assert.equal(classifyShellText([]),null);assert.equal(classifyShellText(undefined),null);
});
test('classifyShellText: half an agentic sidebar is never classic, and a heading alone is not agentic', () => {
  assert.equal(classifyShellText(['Hadrius','~ Inbox','Templates','Vendors','E Announcements']),null,'Inbox with a classic footer');
  assert.equal(classifyShellText(['PROGRAM','Templates','Vendors']),null,'heading without Inbox or the user footer');
  assert.equal(classifyShellText(['SYSTEM','Need help?','E Announcements','a@b.co']),null,'Announcements rules out agentic');
  assert.equal(classifyShellText([...CLASSIC,'atticus.finch@supremeadmin.antoninus.com']),'classic','an email in the column edge does not make it agentic');
});

const record=(over={})=>({key:'agentic_sidebar',title:'Agentic sidebar',before:'classic',after:'agentic',tenants:['academy'],verifiedAt:'2026-11-10',
  decision:'every old-sidebar slide is stale',evidence:['live replay'],...over});
test('validateRollouts: the shipped record is valid; malformed records are refused', () => {
  const shipped=loadRollouts();assert.equal(shipped.length,1);assert.deepEqual(shipped[0].tenants,['academy','sandbox']);
  assert.equal(shipped[0].before,'classic');assert.equal(shipped[0].after,'agentic');
  const bad=[{schema:2,rollouts:[]},{schema:1,rollouts:[record({before:'agentic'})]},{schema:1,rollouts:[record({tenants:['nowhere']})]},
    {schema:1,rollouts:[record(),record({key:'other'})]},{schema:1,rollouts:[record({evidence:[]})]},{schema:1,rollouts:[record({decision:''})]},
    {schema:1,rollouts:[record({verifiedAt:'soon'})]},{schema:1,rollouts:[record({after:'new'})]}];
  for(const doc of bad)assert.throws(()=>validateRollouts(doc),/invalid_shell_rollouts/,JSON.stringify(doc).slice(0,80));
});

const ev=(over={})=>({method:SHELL_METHOD,rollout:'agentic_sidebar',rolloutDigest:rolloutDigest(record()),title:'Agentic sidebar',tenant:'academy',
  before:'classic',after:'agentic',recordedShell:'classic',todayShell:'agentic',captured:true,confirmed:true,...over});
test('confirmsShellRollout: only the recorded old shell and today\'s new shell, bound to a record digest', () => {
  assert.equal(confirmsShellRollout(ev()),true);
  for(const o of [{recordedShell:'agentic'},{todayShell:null},{todayShell:'classic'},{confirmed:false},{method:'x'},{rolloutDigest:'abc'},{before:'agentic',after:'agentic'},{tenant:null}])
    assert.equal(confirmsShellRollout(ev(o)),false,JSON.stringify(o));
  assert.equal(confirmsShellRollout(null),false);
});

test('shellEvidence: per-slide old/new shells from the recorded and today frames; OCR cached by content', () => {
  const dir=fs.mkdtempSync(join(tmpdir(),'drift-shell-'));const rec=join(dir,'rec'),run=join(dir,'run'),cache=join(dir,'cache');fs.mkdirSync(rec);fs.mkdirSync(run);
  const png=(seed)=>{const d=new Uint8Array(64*36*4).fill(seed);return encodePng({width:64,height:36,data:d});};
  // Slide 0 and 1 recorded classic; 0 captured agentic today, 1 not captured; slide 2 has no sidebar in the recording.
  fs.writeFileSync(join(rec,'r0.png'),png(1));fs.writeFileSync(join(rec,'r1.png'),png(2));fs.writeFileSync(join(rec,'r2.png'),png(3));fs.writeFileSync(join(run,'t0.png'),png(4));fs.writeFileSync(join(run,'t2.png'),png(5));
  fs.writeFileSync(join(run,'run.json'),JSON.stringify({viewport:{width:1600,height:900},deviceScaleFactor:1,steps:[]}));
  fs.writeFileSync(join(run,'compare.json'),JSON.stringify({steps:[{index:0,todayScreenshot:'t0.png'},{index:1},{index:2,todayScreenshot:'t2.png'}]}));
  const script={steps:[0,1,2].map(i=>({index:i,action:'click',media:{pre:`r${i}.png`},target:{name:'X',hint:{bbox:{x:0,y:0,w:1,h:1},viewport:{w:1600,h:900}}}}))};
  const lines={r0:CLASSIC,r1:CLASSIC_FOOTER_HIDDEN,r2:NO_SIDEBAR,t0:AGENTIC_SCROLLED,t2:AGENTIC};
  let calls=0;const ocr=(paths,{roi})=>{calls++;assert.equal(roi,'0,0,0.1563,1');return Object.fromEntries(paths.map(p=>[p,lines[p.split('/').pop().replace('.png','')]]));};
  const rollouts=[record()];
  const out=shellEvidence({script,tenant:'academy',runDir:run,recordingsDir:rec,rollouts,ocr,cacheDir:cache});
  assert.equal(out.status,'ok');assert.equal(out.rollout,'agentic_sidebar');assert.equal(out.oldShellSlides,2);assert.equal(out.confirmedSlides,1);
  assert.equal(confirmsShellRollout(out.byStep[0]),true);
  assert.deepEqual([out.byStep[1].recordedShell,out.byStep[1].captured,out.byStep[1].confirmed],['classic',false,false]);
  assert.deepEqual([out.byStep[2].recordedShell,out.byStep[2].todayShell,out.byStep[2].confirmed],[null,'agentic',false],'a recording without a sidebar is not a rollout slide');
  assert.deepEqual(out.counts,{'classic->agentic':1,'classic->not_captured':1,'none->agentic':1});
  const again=shellEvidence({script,tenant:'academy',runDir:run,recordingsDir:rec,rollouts,ocr,cacheDir:cache});
  assert.equal(calls,1,'second pass is served from the cache');assert.deepEqual(again.byStep,out.byStep);
  assert.equal(shellEvidence({script,tenant:'sandbox',runDir:run,recordingsDir:rec,rollouts,ocr,cacheDir:cache}).status,'no_rollout');
});

test('shellState: a video is replaceable only when every old-sidebar slide was recaptured with the new one', () => {
  const ev=(steps)=>({status:'ok',before:'classic',after:'agentic',byStep:Object.fromEntries(steps.map(([recordedShell,todayShell,captured=true],i)=>
    [i,{recordedShell,todayShell,captured,confirmed:recordedShell==='classic'&&todayShell==='agentic'}]))});
  // Every old slide recaptured; a slide with no sidebar in the recording (full-screen builder, employee view) is not one.
  assert.deepEqual(shellState(ev([['classic','agentic'],[null,null],['classic','agentic']])),{state:'stale_replaceable',old:2,confirmed:[0,2],notCaptured:[],unconfirmed:[],mixed:false});
  // The replay stopped before slide 3: replacing the first two would leave both sidebars in one video.
  assert.deepEqual(shellState(ev([['classic','agentic'],['classic','agentic'],['classic',null,false]])),{state:'stale_blocked',old:3,confirmed:[0,1],notCaptured:[2],unconfirmed:[],mixed:false});
  // Captured, but today's frame does not show the new sidebar (covered, another view, still classic).
  const un=shellState(ev([['classic','agentic'],['classic',null],['classic','classic']]));
  assert.equal(un.state,'stale_blocked');assert.deepEqual(un.unconfirmed,[1,2]);assert.deepEqual(un.notCaptured,[]);
  // Recorded with the new sidebar already; a recording that holds both is stale and says so.
  assert.equal(shellState(ev([['agentic','agentic'],[null,'agentic']])).state,'current');
  const both=shellState(ev([['classic','agentic'],['agentic','agentic']]));assert.equal(both.state,'stale_replaceable');assert.equal(both.mixed,true);
  // No sidebar readable in any recorded frame is never "current"; neither is a reader that failed.
  assert.equal(shellState(ev([[null,'agentic'],[null,null]])).state,'unknown');
  assert.equal(shellState({status:'no_rollout'}).state,'no_rollout');
  assert.equal(shellState(null).state,'error');assert.equal(shellState({status:'ok'}).state,'error');
});
