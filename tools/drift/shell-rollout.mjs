// Shell rollouts: an app-wide change of the persistent chrome (the admin sidebar) that a company flag turned on, not a
// release. The release gate (release-evidence.mjs) cannot confirm these: the code shipped long before, behind the flag,
// so no release between a recording and today touched the shell. A rollout record (shell-rollouts.json) names the change,
// the tenants it reached and the sidebar kind before and after. A slide is confirmed only by its OWN frames: the recorded
// one shows the old sidebar and today's capture of the same step shows the new one (offline text recognition of the
// sidebar column, ocr-text.swift). Nothing here reads a flag date: the two frames bracket the change themselves.
//
// The policy consequence is deliberate and lives with the record ("decision"): unlike release changes, which update a
// video only where they would mislead (ui-selection.mjs), a confirmed rollout makes every slide that shows the old
// sidebar stale. ui-selection.mjs selects all of them; any that cannot be replaced holds the whole video for a re-record.
// Pure helpers plus one offline evidence builder (local OCR, no network). Import-safe.
import fs from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {TENANTS} from './tenants.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export const ROLLOUTS_PATH=join(REPO,'tools','drift','shell-rollouts.json');
export const SHELL_OCR_CACHE=join(REPO,'.drift-cache','shell-ocr');
export const SHELL_METHOD='sidebar-text-ocr-v1';
export const SHELL_KINDS=Object.freeze(['classic','agentic']);
// OCR region: the left 250 CSS px of a frame (the sidebar is 256 px wide; its labels end well inside it).
export const SIDEBAR_CSS_PX=250;

// ---------- frame classification ----------
const line=(word)=>new RegExp(String.raw`^(?:\S{1,2}\s+)?${word}\W*$`,'i'); // an icon glyph may lead the label
const INBOX=line('inbox'),ANNOUNCEMENTS=line('announcements'),TEMPLATES=line('templates'),VENDORS=line('vendors');
// Agentic group headings are upper-case (PROGRAM/SYSTEM live, PROGRAMS/SETUP on main); a trailing chevron reads as I|1.
const GROUP=/^\W*(PROGRAMS?|SYSTEM|SETUP)[Il|1]?\W*$/;

const EMAIL=/^\W*[\w.+-]+@[\w-]+(\.[\w-]+)+\W*$/; // the agentic footer's signed-in user (the classic footer is Announcements)

/** OCR lines of a frame's sidebar column -> 'agentic' | 'classic' | null (no sidebar text: collapsed, hidden, covered).
 *  agentic: an upper-case group heading, no Announcements footer, and the Inbox tab or the signed-in user's email in the
 *  footer (the tab list scrolls the active tab into view, so Inbox and PROGRAM can be off screen; headings below it and
 *  the footer are not). classic: no group heading and no Inbox, plus the Announcements footer or the classic top-level
 *  Templates AND Vendors tabs. Anything in between is null: half an agentic sidebar is never classic. */
export function classifyShellText(lines){
  const L=(Array.isArray(lines)?lines:[]).map(x=>String(x??'').trim()).filter(Boolean);
  const inbox=L.some(x=>INBOX.test(x)),group=L.some(x=>GROUP.test(x)),ann=L.some(x=>ANNOUNCEMENTS.test(x)),email=L.some(x=>EMAIL.test(x));
  if(group&&!ann&&(inbox||email))return 'agentic';
  if(group||inbox)return null;
  if(ann)return 'classic';
  if(L.some(x=>TEMPLATES.test(x))&&L.some(x=>VENDORS.test(x)))return 'classic';
  return null;
}

// ---------- rollout records ----------
export function validateRollouts(doc){
  const bad=(why)=>{throw Object.assign(new Error(`invalid_shell_rollouts: ${why}`),{code:'invalid_shell_rollouts'});};
  if(doc?.schema!==1||!Array.isArray(doc.rollouts))bad('schema');
  const keys=new Set();
  for(const r of doc.rollouts){
    if(typeof r?.key!=='string'||!/^[a-z][a-z0-9_]*$/.test(r.key)||keys.has(r.key))bad(`key ${r?.key}`);keys.add(r.key);
    if(!SHELL_KINDS.includes(r.before)||!SHELL_KINDS.includes(r.after)||r.before===r.after)bad(`${r.key} before/after`);
    if(!Array.isArray(r.tenants)||!r.tenants.length||!r.tenants.every(t=>Object.hasOwn(TENANTS,t)))bad(`${r.key} tenants`);
    if(typeof r.title!=='string'||!r.title.trim()||typeof r.decision!=='string'||!r.decision.trim())bad(`${r.key} title/decision`);
    if(!Array.isArray(r.evidence)||!r.evidence.length||!r.evidence.every(e=>typeof e==='string'&&e.trim()))bad(`${r.key} evidence`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(r.verifiedAt??'')))bad(`${r.key} verifiedAt`);
  }
  // One rollout per tenant: two would need an order between them, which no record states.
  const seen=new Map();for(const r of doc.rollouts)for(const t of r.tenants){if(seen.has(t))bad(`tenant ${t} in ${seen.get(t)} and ${r.key}`);seen.set(t,r.key);}
  return doc.rollouts;
}
export function loadRollouts(path=ROLLOUTS_PATH){return validateRollouts(JSON.parse(fs.readFileSync(path,'utf8')));}
export const rolloutDigest=(r)=>createHash('sha256').update(JSON.stringify({key:r.key,before:r.before,after:r.after,tenants:[...r.tenants].sort(),decision:r.decision})).digest('hex');

// ---------- per-slide evidence ----------
/** Self-contained, so pure consumers (ui-selection, weekly-submit) can check it without reading files. */
export function confirmsShellRollout(ev){
  return !!ev&&ev.method===SHELL_METHOD&&ev.confirmed===true&&typeof ev.rollout==='string'&&/^[0-9a-f]{64}$/.test(ev.rolloutDigest??'')
    &&SHELL_KINDS.includes(ev.before)&&SHELL_KINDS.includes(ev.after)&&ev.before!==ev.after
    &&ev.recordedShell===ev.before&&ev.todayShell===ev.after&&typeof ev.tenant==='string';
}
export function describeShellRollout(ev){
  return `${ev.title??ev.rollout} rolled out in ${ev.tenant}: the recorded slide shows the ${ev.before} sidebar, today's capture the ${ev.after} one`;
}

const sha=(p)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pngWidth=(p)=>{const b=fs.readFileSync(p);return b.length>=24&&b.toString('ascii',12,16)==='IHDR'?b.readUInt32BE(16):null;};
/** ocr-text.swift with a sidebar-column region; one process per region. -> {path:[lines]} */
export function swiftShellOcr(paths,{roi}){
  if(!paths.length)return {};
  return JSON.parse(execFileSync('swift',[join(REPO,'tools','drift','ocr-text.swift'),'--roi',roi,...paths],{maxBuffer:64*1024*1024,timeout:900_000}).toString());
}
/** OCR every frame once per (content, region); cached by sha256 so recorded frames are read once across runs. */
export function ocrSidebars(frames,{ocr=swiftShellOcr,cacheDir=SHELL_OCR_CACHE}={}){
  const out=new Map(),todo=new Map();
  for(const f of frames){
    const key=`${sha(f.path)}-${f.roi.replace(/[^0-9.]/g,'_')}`,file=cacheDir?join(cacheDir,key+'.json'):null;
    if(file&&fs.existsSync(file)){try{out.set(f.path,JSON.parse(fs.readFileSync(file,'utf8')).lines);continue;}catch{}}
    if(!todo.has(f.roi))todo.set(f.roi,[]);todo.get(f.roi).push({...f,file});
  }
  for(const [roi,list] of todo){
    const res=ocr(list.map(f=>f.path),{roi});
    for(const f of list){const lines=Array.isArray(res?.[f.path])?res[f.path]:[];out.set(f.path,lines);
      if(f.file){fs.mkdirSync(dirname(f.file),{recursive:true});fs.writeFileSync(f.file,JSON.stringify({method:SHELL_METHOD,roi,lines})+'\n');}}
  }
  return out;
}
const roiFor=(frameWidth,cssWidth)=>{const f=Math.min(0.25,Math.max(0.1,SIDEBAR_CSS_PX/(cssWidth>0?cssWidth:frameWidth)));return `0,0,${Math.round(f*1e4)/1e4},1`;};

/** Per-slide evidence for one captured video. Reads run.json/compare.json, the recorded and today frames; local OCR only.
 *  -> {status, method, rollout, byStep:{[index]:{...}}, counts} ; status 'no_rollout' when no record covers the tenant. */
export function shellEvidence({script,tenant,runDir,recordingsDir,rollouts=null,ocr=swiftShellOcr,cacheDir=SHELL_OCR_CACHE}){
  const records=rollouts??loadRollouts();
  const r=records.find(x=>x.tenants.includes(tenant))??null;
  if(!r)return {status:'no_rollout',method:SHELL_METHOD,rollout:null,byStep:{},counts:{}};
  const run=JSON.parse(fs.readFileSync(join(runDir,'run.json'),'utf8'));
  const cmp=fs.existsSync(join(runDir,'compare.json'))?JSON.parse(fs.readFileSync(join(runDir,'compare.json'),'utf8')):{steps:[]};
  const todayOf=new Map((cmp.steps??[]).map(s=>[s.index,s.todayScreenshot?join(runDir,s.todayScreenshot):null]));
  // Recorded CSS width: the steps' own hint viewport (extension recordings) or the frame itself (1600x900 @1 recordings).
  const hintWidths=(script?.steps??[]).map(s=>Number(s?.target?.hint?.viewport?.w??s?.target?.hint?.viewport?.width)).filter(w=>w>0);
  const recordedCss=hintWidths.length?hintWidths.sort((a,b)=>hintWidths.filter(x=>x===b).length-hintWidths.filter(x=>x===a).length)[0]:null;
  const todayCss=run.viewport?.width>0?run.viewport.width:null;
  const frames=[],slots=[];
  for(const st of script?.steps??[]){
    const rec=st?.media?.pre&&recordingsDir&&fs.existsSync(join(recordingsDir,st.media.pre))?join(recordingsDir,st.media.pre):null;
    const tod=todayOf.get(st.index)&&fs.existsSync(todayOf.get(st.index))?todayOf.get(st.index):null;
    if(rec){const w=pngWidth(rec);frames.push({path:rec,roi:roiFor(w,recordedCss??w)});}
    if(tod){const w=pngWidth(tod);frames.push({path:tod,roi:roiFor(w,todayCss??w)});}
    slots.push({index:st.index,rec,tod});
  }
  const lines=ocrSidebars(frames,{ocr,cacheDir});
  const digest=rolloutDigest(r),byStep={},counts={};
  for(const s of slots){
    const recordedShell=s.rec?classifyShellText(lines.get(s.rec)):null,todayShell=s.tod?classifyShellText(lines.get(s.tod)):null;
    const ev={method:SHELL_METHOD,rollout:r.key,rolloutDigest:digest,title:r.title,tenant,before:r.before,after:r.after,
      recordedShell,todayShell,captured:!!s.tod,confirmed:recordedShell===r.before&&todayShell===r.after};
    byStep[s.index]=ev;const k=`${recordedShell??'none'}->${s.tod?todayShell??'none':'not_captured'}`;counts[k]=(counts[k]??0)+1;
  }
  const oldShell=Object.values(byStep).filter(e=>e.recordedShell===r.before).length;
  return {status:'ok',method:SHELL_METHOD,rollout:r.key,rolloutDigest:digest,tenant,before:r.before,after:r.after,
    oldShellSlides:oldShell,confirmedSlides:Object.values(byStep).filter(e=>e.confirmed).length,byStep,counts};
}

// ---------- per-video state ----------
/** What one video needs for the rollout, from shellEvidence(). Pure.
 *  current           no recorded slide shows the old sidebar and at least one shows the new one
 *  stale_replaceable every old-sidebar slide was captured today showing the new sidebar
 *  stale_blocked     an old-sidebar slide was not captured (the replay stopped before it), or today's capture of it
 *                    does not show the new sidebar: replacing only the others would mix both sidebars in one video
 *  unknown           no recorded slide shows either sidebar (collapsed, hidden, another view): needs a look
 *  Slide numbers are step indexes. `mixed`: the recording itself already holds both sidebars. */
export function shellState(ev){
  if(ev?.status==='no_rollout')return {state:'no_rollout'};
  if(ev?.status!=='ok'||!ev.byStep)return {state:'error'};
  const steps=Object.entries(ev.byStep).map(([i,e])=>({index:Number(i),...e})).sort((a,b)=>a.index-b.index);
  const old=steps.filter(s=>s.recordedShell===ev.before),fresh=steps.filter(s=>s.recordedShell===ev.after);
  if(!old.length)return {state:fresh.length?'current':'unknown',old:0,confirmed:[],notCaptured:[],unconfirmed:[],mixed:false};
  const confirmed=old.filter(s=>s.confirmed).map(s=>s.index),notCaptured=old.filter(s=>!s.captured).map(s=>s.index);
  const unconfirmed=old.filter(s=>s.captured&&!s.confirmed).map(s=>s.index);
  return {state:notCaptured.length||unconfirmed.length?'stale_blocked':'stale_replaceable',old:old.length,confirmed,notCaptured,unconfirmed,mixed:fresh.length>0};
}
