// Weekly read-only drift job: for each listed walkthrough, ensure the Academy session, recapture read-only
// (mutation guard), compare, classify, and for slide_update / moved_highlight / narration_review build a
// LOCAL candidate (candidate.mjs, stable-ID scratch copy). Never writes scripts/ or out/<name>/, never
// uploads, never publishes. Concurrency 1; one video's failure never stops the run.
// Import-safe (no side effects); every stage is injectable for tests.
//
// CLI (only one-shot mode exists; scheduling is documented in tools/drift/README.md):
//   node tools/drift/weekly.mjs --once (--names A,B | --allowlist FILE) [--out NEW_DIR] [--dry-run]
//     [--no-judge] [--timeout-min 15]
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {REPO,DEFAULT_PROFILE,mutationPlan} from './capture.mjs';
import {identify,digest,bytesDigest} from './contracts.mjs';

export const SCRATCH=process.env.HADRIUS_DRIFT_SCRATCH||join(homedir(),'.hermes','cache','scratch');
export const CANDIDATE_VERDICTS=Object.freeze(['slide_update','moved_highlight','narration_review']);
export const DEFAULT_TIMEOUT_MS=15*60_000;
const NAME_RE=/^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const stamp=(d=new Date())=>d.toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);

/** Names from --names and/or an allowlist file (JSON array, or one name per line, # comments). */
export function parseNames({names=null,allowlistText=null}={}){
  const out=[];
  if(names)out.push(...String(names).split(',').map(s=>s.trim()).filter(Boolean));
  if(allowlistText!=null){const t=String(allowlistText).trim();
    if(t.startsWith('[')){const a=JSON.parse(t);if(!Array.isArray(a))throw new Error('allowlist_not_array');out.push(...a.map(x=>typeof x==='string'?x:x?.name).filter(Boolean));}
    else out.push(...t.split('\n').map(l=>l.replace(/#.*/,'').trim()).filter(Boolean));}
  const uniq=[...new Set(out)];
  for(const n of uniq){if(n.startsWith('_studio'))throw new Error(`internal_record_not_allowed:${n}`);if(!NAME_RE.test(n))throw new Error(`invalid_name:${n}`);}
  return uniq;
}

/** Deterministic UUID-shaped id (sha256-based, version nibble 5) so repeated runs reuse the same step IDs. */
export function stableId(...parts){const h=createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Stable-ID LOCAL copy (existing IDs kept). Never written back to scripts/. */
export function identifiedCopy(script){
  const c=structuredClone(script);if(!Object.hasOwn(c,'id'))c.id=stableId('script',c.name);
  for(const s of c.steps)if(!Object.hasOwn(s,'id'))s.id=stableId('step',c.name,c.recording?.id??'',String(s.index));
  return identify(c,()=>{throw new Error('unexpected_id_generation');});
}
/** Candidate manifest for the steps classified as visual updates. today rect -> geometry-only target change. */
export function buildManifest({base,classification,runDir,readBytes=(p)=>readFileSync(p)}){
  const changes=[],skipped=[];
  for(const st of classification.steps){
    if(!CANDIDATE_VERDICTS.includes(st.verdict))continue;
    const old=base.steps.find(s=>s.index===st.index);
    if(!old||old.capture===false){skipped.push({index:st.index,reason:'not_a_slide'});continue;}
    if(!st.evidence?.today){skipped.push({index:st.index,reason:'no_today_screenshot'});continue;}
    const bytes=readBytes(st.evidence.today);const ch={stepId:old.id,beforeHash:digest(old),imagePath:st.evidence.today,sha256:bytesDigest(bytes)};
    if(st.verdict==='moved_highlight'&&st.todayRect&&old.target){const t=structuredClone(old.target);
      if(t.hint?.bbox)t.hint.bbox={...st.todayRect};if(t.bbox)t.bbox={...st.todayRect};ch.target=t;}
    changes.push(ch);
  }
  return {manifest:{baseHash:digest(base),structuralChanges:[],changes},skipped};
}
const withTimeout=(p,ms,label)=>{let t;return Promise.race([p.finally(()=>clearTimeout(t)),new Promise((_,rej)=>{t=setTimeout(()=>rej(Object.assign(new Error(`timeout:${label}`),{code:'timeout'})),ms);})]);};
// Belt and braces on top of the network guard: anything mutating-looking that was NOT blocked/aborted discards the video.
const MUTATING_REQ=/(create|update|delete|archive|mutation|mutate|remove|destroy|upsert|track-event|submit|approve|reject|assign|publish|upload|import|send)/i;

/** Default dependencies (lazy imports keep this module import-safe and fast). */
export async function defaultDeps({judge=true}={}){
  const [{captureRun},{compareRun},{classifyRun,makeClaudeJudge},{createCandidate}]=await Promise.all([import('./capture.mjs'),import('./compare.mjs'),import('./classify.mjs'),import('./candidate.mjs')]);
  return {capture:captureRun,compare:compareRun,classify:classifyRun,candidate:createCandidate,judge:judge?makeClaudeJudge():null,
    bridgeStatus:async()=>{try{return await (await fetch('http://127.0.0.1:8787/render/status',{signal:AbortSignal.timeout(5000)})).json();}catch{return null;}},
    readScript:(name)=>{const p=join(REPO,'scripts',`${name}.script.json`);if(!existsSync(p))return null;return {path:p,script:JSON.parse(readFileSync(p,'utf8'))};},
    recordingsRoot:join(REPO,'out','_recordings')};
}

export async function runVideo(name,{outDir,deps,dryRun=false,profileDir=DEFAULT_PROFILE,log=()=>{}}){
  const t0=Date.now(),timings={},errors=[];const dir=join(outDir,name);mkdirSync(dir,{mode:0o700});
  const job={schema:1,name,status:'running',verdict:null,complete:null,summary:null,reasons:[],steps:[],mutationPlan:null,mutationStop:null,
    evidence:{},candidatePath:null,nonGetRequests:[],timings,errors,startedAt:new Date().toISOString()};
  const save=()=>writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');
  const time=async(k,fn)=>{const s=Date.now();try{return await fn();}finally{timings[k]=Date.now()-s;}};
  try{
    const src=deps.readScript(name);
    if(!src){job.status='script_not_found';errors.push({stage:'script',error:`scripts/${name}.script.json not present locally (library not queried to avoid cache writes)`});return job;}
    const script=src.script;job.scriptPath=src.path;job.recordingId=script.recording?.id??null;job.mutationPlan=mutationPlan(script);
    if(dryRun){job.status='dry_run';job.summary=`would recapture ${script.steps.length} steps; guard would stop at ${job.mutationPlan.find(p=>p.mutating)?`step ${job.mutationPlan.find(p=>p.mutating).index} (${job.mutationPlan.find(p=>p.mutating).reason})`:'no step'}`;return job;}
    const recordingsDir=join(deps.recordingsRoot,script.recording?.id??'_missing_');
    const runDir=join(dir,'capture');job.evidence.runDir=runDir;
    const run=await time('capture',()=>deps.capture({scriptPath:src.path,profileDir,outDir:runDir,log:(m)=>log(`[${name}] ${m}`)}));
    job.captureStatus=run.status;job.session=run.session??null;job.mutationStop=run.mutationStop??null;
    const reqFile=join(runDir,'requests.json');if(existsSync(reqFile)){job.evidence.requests=reqFile;try{job.nonGetRequests=JSON.parse(readFileSync(reqFile,'utf8')).nonGet??[];}catch{}}
    const mutatingReq=job.nonGetRequests.filter(r=>r.decision==='abort'||((r.decision==='allow'||r.decision==='allow_logged')&&MUTATING_REQ.test(r.url)));
    if(mutatingReq.length){job.mutatingRequests=mutatingReq;}
    job.needsFixture=(run.steps??[]).filter(st=>st.mutationGuard?.status==='needs_fixture').map(st=>({index:st.index,reason:st.mutationGuard.reason,fixture:st.mutationGuard.fixture??null}));
    if(run.status==='aborted'&&/^network_guard:/.test(run.aborted??'')){job.status='aborted_mutating_request';errors.push({stage:'capture',error:run.aborted});return job;}
    if(mutatingReq.length){job.status='aborted_mutating_request';errors.push({stage:'capture',error:'a mutating-looking request was allowed through; video results discarded'});return job;}
    if(!['captured','captured_partial_mutation_guard','partial'].includes(run.status)){job.status='capture_failed';errors.push({stage:'capture',error:run.aborted??run.error??run.status,findings:run.findings});
      job.summary=`capture ${run.status}${run.aborted?`: ${run.aborted}`:''}; no verdict`;return job;}
    if(!existsSync(recordingsDir)){job.status='error';errors.push({stage:'compare',error:'recording directory missing'});return job;}
    const cmp=await time('compare',()=>deps.compare({runDir,recordingsDir}));
    job.evidence.compare=join(runDir,'compare.json');if(cmp?.contactSheet)job.evidence.contactSheet=join(runDir,cmp.contactSheet);
    const cls=await time('classify',()=>deps.classify({runDir,script,recordingsDir,judge:deps.judge,log:(m)=>log(`[${name}] ${m}`)}));
    job.evidence.classify=join(runDir,'classify.json');
    Object.assign(job,{verdict:cls.verdict,complete:cls.complete,summary:cls.summary,reasons:cls.reasons,steps:cls.steps.map(s=>({index:s.index,action:s.action,verdict:s.verdict,
      reasons:s.reasons,metrics:s.metrics,chromeChanged:s.chromeChanged,target:s.target,guard:s.guard,judge:s.judge,evidence:s.evidence}))});
    if(CANDIDATE_VERDICTS.includes(cls.verdict)){
      await time('candidate',async()=>{try{
        const base=identifiedCopy(script);const basePath=join(dir,'identified-base.script.json');writeFileSync(basePath,JSON.stringify(base,null,2)+'\n',{flag:'wx',mode:0o400});
        const runJson=JSON.parse(readFileSync(join(runDir,'run.json'),'utf8'));
        const steps=cls.steps.map(s=>({...s,todayRect:runJson.steps.find(r=>r.index===s.index)?.target?.rect??null}));
        const {manifest,skipped}=buildManifest({base,classification:{steps},runDir});
        writeFileSync(join(dir,'candidate-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});job.candidateSkipped=skipped;
        if(!manifest.changes.length){job.candidateError='no_replaceable_steps';return;}
        const res=await deps.candidate({baseScriptPath:basePath,recordingsRoot:deps.recordingsRoot,manifest,outputRoot:join(dir,'candidate')});
        job.candidatePath=join(dir,'candidate');job.candidate={status:res.status,changedStepIds:res.changedStepIds,renderReady:res.renderReady,narrationReviewSteps:cls.steps.filter(s=>s.verdict==='narration_review').map(s=>s.index)};
      }catch(e){job.candidateError=String(e?.message||e);errors.push({stage:'candidate',error:job.candidateError});}});
    }
    job.status='ok';return job;
  }catch(e){job.status=e?.code==='timeout'?'timeout':'error';errors.push({stage:'video',error:String(e?.message||e).slice(0,500)});return job;}
  finally{timings.total=Date.now()-t0;job.finishedAt=new Date().toISOString();save();}
}

export async function runWeekly({names,outDir=join(SCRATCH,`weekly-${stamp()}`),dryRun=false,deps=null,judge=true,timeoutMs=DEFAULT_TIMEOUT_MS,profileDir=DEFAULT_PROFILE,log=console.error}){
  if(!names?.length)throw new Error('no_names');
  const out=resolve(outDir);const rel=relative(REPO,out);
  if(!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('output_inside_repo');
  if(existsSync(out))throw new Error('output_exists');if(!existsSync(dirname(out)))throw new Error('output_parent_missing');
  mkdirSync(out,{mode:0o700});
  deps=deps??await defaultDeps({judge:judge&&!dryRun});
  const summary={schema:1,startedAt:new Date().toISOString(),outDir:out,dryRun,names,profile:profileDir,bridgeAtStart:dryRun?null:await deps.bridgeStatus?.()??null,videos:[]};
  const save=()=>writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');save();
  for(const name of names){ // concurrency 1, by design (one browser profile, one bridge)
    log(`[weekly] ${name}: start`);let job;
    try{job=await withTimeout(runVideo(name,{outDir:out,deps,dryRun,profileDir,log}),timeoutMs,name);}
    catch(e){job={name,status:e?.code==='timeout'?'timeout':'error',errors:[{stage:'video',error:String(e?.message||e)}]};
      try{const f=join(out,name,'job.json');const prev=existsSync(f)?JSON.parse(readFileSync(f,'utf8')):{};writeFileSync(f,JSON.stringify({...prev,...job},null,2)+'\n');}catch{}}
    summary.videos.push({name,status:job.status,verdict:job.verdict??null,complete:job.complete??null,summary:job.summary??null,candidatePath:job.candidatePath??null,
      mutationStop:job.mutationStop??null,needsFixtureSteps:(job.needsFixture??[]).map(x=>x.index),nonGetRequests:(job.nonGetRequests??[]).length,mutatingRequests:(job.mutatingRequests??[]).length,job:join(out,name,'job.json'),seconds:job.timings?.total!=null?Math.round(job.timings.total/1000):null});
    save();log(`[weekly] ${name}: ${job.status} ${job.verdict??''}`);
  }
  summary.finishedAt=new Date().toISOString();
  summary.counts=summary.videos.reduce((a,v)=>{const k=v.verdict??v.status;a[k]=(a[k]??0)+1;return a;},{});
  save();return summary;
}

function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export async function main(args=process.argv.slice(2)){
  if(!args.includes('--once'))throw Object.assign(new Error('usage: weekly.mjs --once (--names A,B | --allowlist FILE) [--out NEW_DIR] [--dry-run] [--no-judge] [--timeout-min N]'),{exit:64});
  const allow=arg(args,'--allowlist');
  const names=parseNames({names:arg(args,'--names'),allowlistText:allow?readFileSync(resolve(allow),'utf8'):null});
  const s=await runWeekly({names,outDir:arg(args,'--out')??join(SCRATCH,`weekly-${stamp()}`),dryRun:args.includes('--dry-run'),judge:!args.includes('--no-judge'),
    timeoutMs:arg(args,'--timeout-min')?Number(arg(args,'--timeout-min'))*60_000:DEFAULT_TIMEOUT_MS});
  console.log(JSON.stringify({outDir:s.outDir,counts:s.counts,videos:s.videos.map(v=>({name:v.name,status:v.status,verdict:v.verdict,summary:v.summary,candidate:v.candidatePath}))},null,2));
  return s;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=e.exit??1;});
