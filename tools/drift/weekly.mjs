// Weekly read-only drift job: for each listed walkthrough, find its tenant from the script's company_id (tenants.mjs;
// no or conflicting company => skipped as tenant_unknown/tenant_conflict, never guessed). Only Hadrius Academy (1150)
// is replayed: a Sandbox (1048) script is skipped as tenant_not_replayed (operator decision 2026-11-16: Sandbox videos
// are recreated in Academy, Sandbox is never replayed or written to). Then ensure that tenant's session, recapture
// read-only
// (mutation guard), compare, classify, and for slide_update / moved_highlight / narration_review build a
// LOCAL candidate (candidate.mjs, stable-ID scratch copy). Never writes scripts/ or out/<name>/, never
// uploads, never publishes. Concurrency 1; one video's failure never stops the run.
// Import-safe (no side effects); every stage is injectable for tests.
//
// CLI (only one-shot mode exists; scheduling is documented in tools/drift/README.md):
//   node tools/drift/weekly.mjs --once (--names A,B | --allowlist FILE) [--out NEW_DIR] [--dry-run]
//     [--no-judge] [--timeout-min 15] [--resume EXISTING_RUN_DIR]
//     [--review-provider codex|claude] [--review-model MODEL] [--review-effort LEVEL]
// Codex (gpt-6.1-sol, medium) is the default for BOTH initial detection judges; Claude is opt-in.
// Videos matching a rule in tools/drift/exclusions.json are skipped (status 'excluded', never captured).
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {REPO,DEFAULT_PROFILE,mutationPlan,LIMITS} from './capture.mjs';
import {detectScriptTenant,tenantProfileDir,getTenant,REPLAY_TENANT_KEYS,tenantReplayed} from './tenants.mjs';
import {identify,digest,bytesDigest} from './contracts.mjs';
import {SELECTION_POLICY,selectWeeklyJobs,selectedJob,slideText,selectionMarker} from './ui-selection.mjs';
import {loadExclusions,exclusionFor,hasRules,parseExclusions} from './exclusions.mjs';
import {verifySemanticRepairAssets} from './semantic-repair-assets.mjs';
import {verifyFlowEquivalenceAssets} from './flow-equivalence-assets.mjs';
import {cachedJudge,createReviewStore,createReviewBudget,reviewerVersion,fileDigest,BUDGET_EXHAUSTED} from './review-cache.mjs';
import {createGroundedReviewers} from './grounded-review-provider.mjs';
import {shellState} from './shell-rollout.mjs';

/** Initial detection is Codex by default, independently of the legacy Claude bridge settings.
 * CLI/API values override KBS_DRIFT_REVIEW_*; KBS_CODEX_BIN remains the shared offline binary override.
 * Claude opt-in uses KBS_DECISION_MODEL/EFFORT (runClaude owns its effort flag). */
export function detectionReviewSettings(settings={},env=process.env){
  const provider=settings.provider??env.KBS_DRIFT_REVIEW_PROVIDER??'codex';
  if(!['codex','claude'].includes(provider))throw new Error(`invalid_review_provider:${provider}`);
  const model=settings.model??env.KBS_DRIFT_REVIEW_MODEL??(provider==='codex'?'gpt-6.1-sol':env.KBS_DECISION_MODEL||'claude-sonnet-5');
  const effort=settings.effort??env.KBS_DRIFT_REVIEW_EFFORT??(provider==='codex'?'medium':env.KBS_DECISION_EFFORT||null);
  if(provider==='claude'){
    if(typeof model!=='string'||!/^claude-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model))throw new Error('invalid_review_claude_model');
    if(effort!==(env.KBS_DECISION_EFFORT||null))throw new Error('claude_review_effort_requires_KBS_DECISION_EFFORT');
    if(effort&&!['low','medium','high','xhigh','max'].includes(effort))throw new Error('invalid_review_claude_effort');
  }
  const binary=settings.binary??env.KBS_DRIFT_REVIEW_BIN??env.KBS_CODEX_BIN;
  const cacheDir=settings.cacheDir??env.KBS_DRIFT_REVIEW_CACHE_DIR;
  return {...settings,provider,model,effort,...(binary!==undefined?{binary}:{}),...(cacheDir!==undefined?{cacheDir}:{})};
}

export const SCRATCH=process.env.HADRIUS_DRIFT_SCRATCH||join(homedir(),'.hermes','cache','scratch');
export const CANDIDATE_VERDICTS=Object.freeze(['slide_update','moved_highlight','narration_review']);
export const DEFAULT_TIMEOUT_MS=15*60_000;
const NAME_RE=/^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const stamp=(d=new Date())=>d.toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);

/** Names from --names and/or an allowlist file (JSON array, one name per line with # comments, or the per-tenant
 *  object {academy:[...], sandbox:[...], unknown:[...]} from tenants.mjs, of which only the replayed tenants are run
 *  (REPLAY_TENANT_KEYS: academy); `tenants` names the lists to read instead (reports and tests). */
export function parseNames({names=null,allowlistText=null,tenants=null}={}){
  const out=[];
  if(names)out.push(...String(names).split(',').map(s=>s.trim()).filter(Boolean));
  if(allowlistText!=null){const t=String(allowlistText).trim();
    const pick=(a)=>a.map(x=>typeof x==='string'?x:x?.name).filter(Boolean);
    if(t.startsWith('{')){const o=JSON.parse(t);const keys=tenants??REPLAY_TENANT_KEYS;for(const k of keys){getTenant(k);if(o[k]!=null&&!Array.isArray(o[k]))throw new Error(`allowlist_${k}_not_array`);out.push(...pick(o[k]??[]));}}
    else if(t.startsWith('[')){const a=JSON.parse(t);if(!Array.isArray(a))throw new Error('allowlist_not_array');out.push(...pick(a));}
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
/** Model reviewers behind the validated answer cache and a shared per-run call budget (review-cache.mjs). */
export function reviewedJudges({narrationJudge,redesignJudge,model,effort=null,store,budget,cls,rj,grounded=null}){
  const plain=(o)=>JSON.parse(JSON.stringify(o));
  const reviewer=grounded?.cacheIdentity??(model?`${model};effort=${effort??'default'}`:model);
  const validate=(parse,a)=>{
    if(a?.pending||a?.error)throw new Error('review_answer_pending');
    parse(a);
    if(grounded&&(a.provider!==grounded.provider||a.model!==grounded.model||a.effort!==grounded.effort||typeof a.reviewId!=='string'||!a.reviewId
      ||typeof a.reviewKey!=='string'||!/^[a-f0-9]{64}$/.test(a.reviewKey)))throw new Error('review_metadata_invalid');
  };
  // cachedJudge's legacy budget sits BEFORE its judge. Codex also has an exact-input checkpoint:
  // defer spend to the adapter's beforeRun, so either cache tier can succeed with zero remaining calls.
  const accounting=grounded&&budget?{...budget,take:()=>true,cost:()=>{}}:budget;
  const safeStore=store&&{...store,put:(kind,key,record)=>{
    try{validate(kind==='narration'?cls.parseJudge:rj.parseRedesignJudge,record.answer);}catch{return;}
    store.put(kind,key,record);
  }};
  const invoke=(kind,judge)=>!grounded?judge:async input=>{
    if(grounded.hold)return {pending:grounded.hold.reason,error:grounded.hold.reason,reviewStatus:'pending'};
    const answer=await judge(input);
    if(answer?.cached)budget?.hit(kind);
    else if(answer?.pending){if(answer.pending!==BUDGET_EXHAUSTED)budget?.error(kind);}
    else budget?.cost(kind,answer?.costUsd);
    return answer;
  };
  const gate=fn=>!grounded?fn:input=>grounded.hold?Promise.resolve({pending:grounded.hold.reason,error:grounded.hold.reason,reviewStatus:'pending'}):fn(input);
  return {
    judge:narrationJudge&&gate(cachedJudge({kind:'narration',judge:invoke('narration',narrationJudge),store:safeStore,budget:accounting,version:reviewerVersion(reviewer,cls.buildJudgePrompt,cls.parseJudge),
      // Strict: identical narration, page text and today's screenshot bytes. Narration answers depend on data.
      keyOf:(i)=>{const today=fileDigest(i.todayPath);if(!today)return null;const {todayPath,...rest}=i;return digest(plain({...rest,today}));},
      validate:(a)=>validate(cls.parseJudge,a),onExhausted:()=>{throw new Error(BUDGET_EXHAUSTED);}})),
    // Reused while today's screen looks the same as when it was reviewed (redesignReusable); otherwise re-asked.
    redesignJudge:redesignJudge&&gate(cachedJudge({kind:'redesign',judge:invoke('redesign',redesignJudge),store:safeStore,budget:accounting,version:reviewerVersion(reviewer,rj.buildRedesignPrompt,rj.parseRedesignJudge,rj.redesignCacheInputs,rj.redesignReusable),
      keyOf:(i)=>i.cache?.slot??null,validate:(a)=>validate(rj.parseRedesignJudge,a),reusable:(rec,i)=>rj.redesignReusable(rec,i.cache),
      extra:(i,key,s)=>rj.redesignCacheExtra(i.cache,key,s),onExhausted:()=>({pending:BUDGET_EXHAUSTED})})),
  };
}
export async function defaultDeps({judge=true,maxModelCalls=null,reviewCache=true,autoRepair=true,reviewSettings={}}={}){
  const [{captureRun},{compareRun},cls,{createCandidate},{createReleaseProvider},rj]=await Promise.all([import('./capture.mjs'),import('./compare.mjs'),import('./classify.mjs'),import('./candidate.mjs'),import('./release-provider.mjs'),import('./redesign-judge.mjs')]);
  const budget=createReviewBudget({maxCalls:maxModelCalls}),settings=judge?detectionReviewSettings(reviewSettings):null;
  const store=reviewCache?createReviewStore(settings?.cacheDir?{root:settings.cacheDir}:{}):null;
  let grounded=null,narrationJudge=null,redesignJudge=null;
  if(judge&&settings.provider==='codex'){
    const {beforeRun:hook,...options}=settings;
    grounded=createGroundedReviewers({...options,beforeRun:async context=>{
      // An injected pre-spawn hook must succeed before consuming the live allowance.
      await hook?.(context);
      if(!budget.take(context.kind))throw new Error(BUDGET_EXHAUSTED);
    }});
    narrationJudge=grounded.judge;redesignJudge=grounded.redesignJudge;
  }else if(judge){
    const cs=await import('../coverage-scan.mjs');
    const runModel=(prompt,options)=>cs.runClaude(prompt,{...options,model:settings.model});
    const provenance=fn=>async input=>({...await fn(input),provider:'claude-cli',effort:settings.effort});
    const claudeNarration=provenance(cls.makeClaudeJudge({runModel}));
    const claudeRedesign=provenance(rj.makeRedesignJudge({runModel}));
    const fallbackProvider=settings.fallbackProvider??process.env.KBS_DRIFT_REVIEW_FALLBACK_PROVIDER??'codex';
    if(fallbackProvider==='codex'){
      const fb=createGroundedReviewers({
        provider:'codex',
        model:settings.fallbackModel??process.env.KBS_DRIFT_REVIEW_FALLBACK_MODEL??'gpt-6.1-sol',
        effort:settings.fallbackEffort??process.env.KBS_DRIFT_REVIEW_FALLBACK_EFFORT??'medium',
        ...(settings.binary!==undefined?{binary:settings.binary}:{}),
        ...(settings.cacheDir!==undefined?{cacheDir:settings.cacheDir}:{}),
      });
      const withFallback=(primary,fallback,label)=>async input=>{
        try{return await primary(input);}
        catch(e){
          console.error(`[weekly] claude ${label} review failed (${String(e?.message||e).slice(0,200)}); falling back to codex`);
          const res=await fallback(input);
          if(res?.pending||res?.error)throw new Error(res.error||res.pending||'codex_fallback_failed');
          return res;
        }
      };
      narrationJudge=withFallback(claudeNarration,fb.judge,'narration');
      redesignJudge=withFallback(claudeRedesign,fb.redesignJudge,'redesign');
    }else{
      narrationJudge=claudeNarration;redesignJudge=claudeRedesign;
    }
  }
  const judges=reviewedJudges({narrationJudge,redesignJudge,model:settings?`${settings.provider}:${settings.model}`:null,effort:settings?.effort,store,budget,cls,rj,grounded});
  const ownerWarmup=async(tenant,log)=>{const [{borrowOwnerSession,MAX_WAIT_FOR_REFRESH_MS},{chromium}]=await Promise.all([import('./owner-session.mjs'),import('playwright')]);
    return borrowOwnerSession({tenant,chromium,log,maxWaitMs:MAX_WAIT_FOR_REFRESH_MS});};
  return {ownerWarmup,capture:captureRun,compare:compareRun,classify:cls.classifyRun,candidate:createCandidate,judge:judges.judge,reviewBudget:budget,reviewProvider:grounded??(settings?{status:()=>({state:'ready',provider:'claude-cli',model:settings.model,effort:settings.effort})}:null),narrationScope:'ui_confirmed',
    // Production release attribution + grounded redesign review. Provider errors fail closed per video (job.releaseEvidence.status='error').
    releaseEvidence:createReleaseProvider({log:(m)=>console.error(`[release] ${m}`)}),redesignJudge:judges.redesignJudge,
    exclusions:loadExclusions(), // tools/drift/exclusions.json (temporary module exclusions; fail closed when unreadable)
    bridgeStatus:async()=>{try{return await (await fetch('http://127.0.0.1:8787/render/status',{signal:AbortSignal.timeout(5000)})).json();}catch{return null;}},
    readScript:(name)=>{const p=join(REPO,'scripts',`${name}.script.json`);if(!existsSync(p))return null;return {path:p,script:JSON.parse(readFileSync(p,'utf8'))};},
    recordingsRoot:join(REPO,'out','_recordings'),
    // Sidebar kind per recorded and today frame (local text recognition, no network); see shell-rollouts.json.
    shellEvidence:async options=>(await import('./shell-rollout.mjs')).shellEvidence(options),
    // Unattended local repair is part of the normal weekly run, not a collection of operator commands.
    // --no-judge / --no-auto-repair disable it; no posting or publishing is enabled here.
    repairAutomation:autoRepair&&judge?async options=>(await import('./automation.mjs')).runRepairAutomation(options):null};
}

export async function runVideo(name,{outDir,deps,dryRun=false,profileDir=null,log=()=>{},signal=null}){
  const t0=Date.now(),timings={},errors=[];const dir=join(outDir,name);mkdirSync(dir,{mode:0o700});
  const job={schema:1,name,status:'running',verdict:null,complete:null,summary:null,reasons:[],steps:[],mutationPlan:null,mutationStop:null,
    evidence:{},candidatePath:null,nonGetRequests:[],timings,errors,startedAt:new Date().toISOString()};
  const save=()=>{if(!signal?.aborted)writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');};
  const time=async(k,fn)=>{const s=Date.now();try{const result=await fn();if(signal?.aborted)throw Object.assign(new Error('video_cancelled'),{code:'timeout'});return result;}finally{timings[k]=Date.now()-s;}};
  try{
    const src=deps.readScript(name);
    if(!src){job.status='script_not_found';errors.push({stage:'script',error:`scripts/${name}.script.json not present locally (library not queried to avoid cache writes)`});return job;}
    const script=src.script;job.scriptPath=src.path;job.recordingId=script.recording?.id??null;job.mutationPlan=mutationPlan(script);
    // Tenant from the script's own company_id(s); never guessed. Unknown/conflicting/unregistered => skipped and reported.
    const ten=detectScriptTenant(script);job.tenant={key:ten.tenant,status:ten.status,companyIds:ten.companyIds,reason:ten.reason,...(ten.tenant?{name:getTenant(ten.tenant).name}:{})};
    if(ten.status!=='ok'){job.status=`tenant_${ten.status}`;job.summary=`skipped: ${ten.reason}`;errors.push({stage:'tenant',error:ten.reason});return job;}
    // A tenant that is not replayed (Sandbox): nothing is opened there, whichever way the name reached this run
    // (--names, an old allowlist, the PR queue). The video is listed with the other tenant skips.
    if(!tenantReplayed(ten.tenant)){job.status='tenant_not_replayed';job.summary=`skipped: ${getTenant(ten.tenant).name} videos are recreated in Hadrius Academy and never replayed`;errors.push({stage:'tenant',error:'tenant_not_replayed'});return job;}
    const ownerSession=deps.captureSession==='owner';
    const videoProfile=ownerSession?null:profileDir??tenantProfileDir(ten.tenant,REPO);job.profile=ownerSession?'owner':videoProfile;job.captureSession=ownerSession?'owner':'automation';
    if(dryRun){job.status='dry_run';job.summary=`would recapture ${script.steps.length} steps; guard would stop at ${job.mutationPlan.find(p=>p.mutating)?`step ${job.mutationPlan.find(p=>p.mutating).index} (${job.mutationPlan.find(p=>p.mutating).reason})`:'no step'}`;return job;}
    const recordingsDir=join(deps.recordingsRoot,script.recording?.id??'_missing_');
    const runDir=join(dir,'capture');job.evidence.runDir=runDir;
    const run=await time('capture',()=>deps.capture({scriptPath:src.path,profileDir:videoProfile,tenant:ten.tenant,outDir:runDir,recordingsDir:existsSync(recordingsDir)?recordingsDir:null,...(deps.captureLimits?{limits:deps.captureLimits}:{}),...(deps.rehearse?{rehearse:true}:{}),...(ownerSession?{session:'owner'}:{}),log:(m)=>log(`[${name}] ${m}`)}));
    job.captureStatus=run.status;job.session=run.session??null;job.mutationStop=run.mutationStop??null;
    const reqFile=join(runDir,'requests.json');if(existsSync(reqFile)){job.evidence.requests=reqFile;try{job.nonGetRequests=JSON.parse(readFileSync(reqFile,'utf8')).nonGet??[];}catch{}}
    // A write the capture aborted after a rehearsed form step (tolerated:true) never left the browser and already
    // stopped the replay at that step (needs_fixture); it is evidence, not a reason to discard the video.
    const mutatingReq=job.nonGetRequests.filter(r=>(r.decision==='abort'&&!r.tolerated)||((r.decision==='allow'||r.decision==='allow_logged')&&MUTATING_REQ.test(r.url)));
    const blocked=job.nonGetRequests.filter(r=>r.decision==='abort'&&r.tolerated);if(blocked.length)job.rehearsalBlockedWrites=blocked;
    if(mutatingReq.length){job.mutatingRequests=mutatingReq;}
    job.needsFixture=(run.steps??[]).filter(st=>st.mutationGuard?.status==='needs_fixture').map(st=>({index:st.index,reason:st.mutationGuard.reason,fixture:st.mutationGuard.fixture??null}));
    if(run.status==='aborted'&&/^network_guard:/.test(run.aborted??'')){job.status='aborted_mutating_request';errors.push({stage:'capture',error:run.aborted});return job;}
    if(mutatingReq.length){job.status='aborted_mutating_request';errors.push({stage:'capture',error:'a mutating-looking request was allowed through; video results discarded'});return job;}
    if(!['captured','captured_partial_mutation_guard','partial'].includes(run.status)){job.status='capture_failed';errors.push({stage:'capture',error:run.aborted??run.error??run.status,findings:run.findings});
      job.summary=`capture ${run.status}${run.aborted?`: ${run.aborted}`:''}; no verdict`;return job;}
    if(!existsSync(recordingsDir)){job.status='error';errors.push({stage:'compare',error:'recording directory missing'});return job;}
    const cmp=await time('compare',()=>deps.compare({runDir,recordingsDir}));
    job.evidence.compare=join(runDir,'compare.json');if(cmp?.contactSheet)job.evidence.contactSheet=join(runDir,cmp.contactSheet);
    // App-shell rollout (shell-rollout.mjs): which slides were recorded with the old sidebar, and whether today's capture
    // of the same step shows the new one. Recorded as evidence and as the video's state; a reader that cannot tell
    // (OCR failed) says so and never counts as current. Selection and repair do not act on it yet.
    let shellByStep=null;
    if(deps.shellEvidence){
      try{const shell=await time('shellEvidence',()=>deps.shellEvidence({script,tenant:ten.tenant,runDir,recordingsDir}));
        job.shellRollout={status:shell.status,rollout:shell.rollout??null,...(shell.status==='ok'?{rolloutDigest:shell.rolloutDigest,before:shell.before,after:shell.after}:{}),...shellState(shell)};
        if(shell.status==='ok')shellByStep=shell.byStep;}
      catch(e){if(e?.code==='timeout')throw e;job.shellRollout={status:'error',state:'error',reason:String(e?.message||e).slice(0,300)};errors.push({stage:'shell_rollout',error:job.shellRollout.reason});}
    }
    let releaseEvidence=null;
    if(deps.releaseEvidence){
      try{releaseEvidence=await time('releaseEvidence',()=>deps.releaseEvidence({script,tenant:ten.tenant,runDir,capturedAt:job.startedAt}));}
      catch(e){job.releaseEvidence={status:'error',reason:String(e?.message||e).slice(0,300)};errors.push({stage:'release_evidence',error:job.releaseEvidence.reason});}
    }
    job.releaseEvidence??=releaseEvidence?.summary??{status:'unavailable'};
    const cls=await time('classify',()=>deps.classify({runDir,script,recordingsDir,judge:deps.judge,releaseEvidence,redesignJudge:deps.redesignJudge??null,narrationScope:deps.narrationScope??'all',log:(m)=>log(`[${name}] ${m}`)}));
    job.evidence.classify=join(runDir,'classify.json');
    job.scriptHash=digest(script);
    Object.assign(job,{verdict:cls.verdict,complete:cls.complete,summary:cls.summary,reasons:cls.reasons,steps:cls.steps.map(s=>{
      const st=script.steps.find(x=>x.index===s.index),captured=run.steps?.find(x=>x.index===s.index);
      return {index:s.index,action:s.action,verdict:s.verdict,
        reasons:s.reasons,metrics:s.metrics,chromeChanged:s.chromeChanged,target:s.target,guard:s.guard,judge:s.judge,uiReleaseEvidence:s.uiReleaseEvidence??null,evidence:s.evidence,
        ...(shellByStep?{shellRollout:shellByStep[s.index]??null}:{}),
        uiContext:{route:captured?.todayUrl??s.uiReleaseEvidence?.routePath??st?.url??st?.route,slideText:slideText(st),visibleText:captured?.visibleText??null}};})});
    // Cross-page app-frame decisions require the whole run. Never create a candidate here.
    job.uiSelection={policy:SELECTION_POLICY,status:'pending',slides:[]};
    if(deps.reviewProvider)job.reviewProvider=deps.reviewProvider.status();
    const pending=[...new Set(job.steps.flatMap(s=>[s.judge?.pending,s.judge?.error,s.uiReleaseEvidence?.reviewPending,s.uiReleaseEvidence?.redesign?.error]).filter(Boolean))];
    if(pending.length){
      // Keep classify.json and all raw step evidence intact; an unavailable reviewer is NOT a no-change verdict.
      job.reviewPending=pending;job.classificationVerdict=job.verdict;job.verdict=null;job.complete=false;
      job.classificationSummary=job.summary;job.summary=`Model review held: ${pending.join('; ')}`;
      job.status='review_pending';return job;
    }
    job.status='ok';return job;
  }catch(e){job.status=e?.code==='timeout'?'timeout':'error';errors.push({stage:'video',error:String(e?.message||e).slice(0,500)});return job;}
  finally{timings.total=Date.now()-t0;job.finishedAt=new Date().toISOString();save();}
}

/** Batch selection precedes candidate creation. Raw steps/reasons/verdicts are never rewritten. */
export async function finalizeWeeklySelection({jobs,outDir,deps,log=()=>{}}){
  const scripts=new Map();
  for(const job of jobs){try{scripts.set(job.name,deps.readScript(job.name)?.script??null);}catch{scripts.set(job.name,null);}}
  for (const job of jobs) for (const step of job.steps || []) if (step.flowEquivalence) {
    try { verifyFlowEquivalenceAssets(step, { name: job.name, scriptStep: scripts.get(job.name)?.steps?.find((s,i)=>(s.index??i)===step.index) }); }
    catch (error) {
      delete step.flowEquivalence;
      (job.errors ??= []).push({ stage: 'flow_equivalence', index: step.index, error: String(error.message) });
    }
  }
  for (const job of jobs) for (const step of job.steps || []) if (step.semanticRepair) {
    try { verifySemanticRepairAssets(step); }
    catch (error) {
      // Retire only this additional proof, not original capture/classifier findings. Without it the pure
      // policy falls back to conservative blockers and cannot generate a stale-image automatic candidate.
      delete step.semanticRepair;
      (job.errors ??= []).push({ stage: 'semantic_review', index: step.index, error: String(error.message) });
    }
  }
  const selection=selectWeeklyJobs(jobs,{readScript:n=>scripts.get(n)});
  for(const job of jobs){
    if(job.status!=='ok')continue;
    const dir=join(outDir,job.name),previousPath=job.candidatePath,previousHash=job.candidatePlanHash;
    job.uiSelection=selection.byName.get(job.name);job.candidatePath=null;job.candidate=null;delete job.candidateInputs;
    delete job.candidatePlanHash;delete job.candidateError;delete job.candidateSkipped;
    const active=join(dir,'candidate-manifest.json');
    if(existsSync(active)){let n=1;while(existsSync(`${active}.superseded-${n}`))n++;renameSync(active,`${active}.superseded-${n}`);}
    const started=Date.now();
    try{
      const projected=selectedJob(job,job.uiSelection);
      if(!projected){job.candidateSkip=job.uiSelection?.reason??'no_selected_ui_steps';continue;}
      if(!CANDIDATE_VERDICTS.includes(projected.verdict)){job.candidateSkip='manual_rerecord';continue;}
      const script=scripts.get(job.name);
      if(!script)throw new Error('script_not_found');
      if(job.scriptHash&&job.scriptHash!==digest(script))throw new Error('script_changed_since_capture');
      const base=identifiedCopy(script),runDir=join(dir,'capture');
      const run=JSON.parse(readFileSync(join(runDir,'run.json'),'utf8'));
      const steps=projected.steps.map(s=>({...s,todayRect:run.steps.find(r=>r.index===s.index)?.target?.rect??null}));
      const {manifest,skipped}=buildManifest({base,classification:{steps},runDir});job.candidateSkipped=skipped;
      if(!manifest.changes.length){job.candidateSkip='no_replaceable_steps';continue;}
      const planHash=digest(manifest);
      writeFileSync(active,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      if(previousPath&&previousHash===planHash&&existsSync(join(previousPath,'manifest.json'))){
        const cached=JSON.parse(readFileSync(join(previousPath,'manifest.json'),'utf8'));
        if(cached.baseHash===manifest.baseHash&&JSON.stringify(cached.changedStepIds)===JSON.stringify(manifest.changes.map(c=>c.stepId))){
          job.candidatePath=previousPath;job.candidate=cached;job.candidatePlanHash=planHash;
          job.candidateInputs={schema:1,scriptName:job.name,weeklyDir:dir,identifiedScript:join(previousPath,'identified-base.script.json'),candidateManifest:active,recordingsDir:join(deps.recordingsRoot,base.recording.id)};
          delete job.candidateSkip;continue;
        }
      }
      const basePath=join(dir,`identified-base-${manifest.baseHash.slice(0,16)}.script.json`);
      if(!existsSync(basePath))writeFileSync(basePath,JSON.stringify(base,null,2)+'\n',{flag:'wx',mode:0o400});
      let outputRoot=join(dir,`candidate-${planHash.slice(0,16)}`),n=1;
      while(existsSync(outputRoot))outputRoot=join(dir,`candidate-${planHash.slice(0,16)}-${n++}`);
      const res=await deps.candidate({baseScriptPath:basePath,recordingsRoot:deps.recordingsRoot,manifest,outputRoot});
      job.candidatePath=outputRoot;job.candidate=res;job.candidatePlanHash=planHash;delete job.candidateSkip;
      job.candidateInputs={schema:1,scriptName:job.name,weeklyDir:dir,identifiedScript:join(outputRoot,'identified-base.script.json'),candidateManifest:active,recordingsDir:join(deps.recordingsRoot,base.recording.id)};
    }catch(e){job.candidateError=String(e?.message||e);(job.errors??=[]).push({stage:'candidate',error:job.candidateError});
      if(existsSync(active)){let n=1;while(existsSync(`${active}.invalid-${n}`))n++;renameSync(active,`${active}.invalid-${n}`);}
      log(`[weekly] ${job.name}: candidate failed: ${job.candidateError}`);
    }finally{(job.timings??={}).candidate=Date.now()-started;writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');}
  }
  const report={...selectionMarker(selection),finishedAt:new Date().toISOString(),frameChanges:selection.review.frameChanges,videos:[...selection.byName.values()]};
  writeFileSync(join(outDir,'ui-selection.json'),JSON.stringify(report,null,2)+'\n');
  return selection;
}

/** Excluded video (tools/drift/exclusions.json): recorded with reason 'excluded', never read further or captured. */
function excludedJob(name,dir,ex){mkdirSync(dir,{mode:0o700});
  const job={schema:1,name,status:'excluded',verdict:null,complete:null,summary:`excluded (${ex.rule}, module from ${ex.moduleSource}): ${ex.reason}`,reason:'excluded',exclusion:ex,reasons:[],steps:[],errors:[],timings:{total:0},startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
  writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');return job;}
// Sign-in results that need a human (academy-login.mjs exit codes 30-33, "do not re-run --ensure in a loop"): after
// one, no further video of that tenant tries to sign in during the run (each attempt would be another password
// submit: account lockout risk). tenant_mismatch (e.g. the users/?uuid= payload not observed) is per-video, not a stop.
export const SESSION_HARD_STOP=Object.freeze(['mfa_required','invalid_credentials','sso_redirect','captcha']);
function blockedJob(name,dir,tenant,block){mkdirSync(dir,{mode:0o700});
  const job={schema:1,name,status:'capture_failed',captureStatus:'session_blocked',verdict:null,complete:null,tenant:{key:tenant,status:'ok'},
    summary:`not attempted: ${tenant} sign-in needs a human (${block.status} on ${block.video}); skipped to avoid an account lockout`,reasons:[],steps:[],
    errors:[{stage:'session',error:`tenant_session_blocked:${block.status}`,video:block.video}],timings:{total:0},startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()};
  writeFileSync(join(dir,'job.json'),JSON.stringify(job,null,2)+'\n');return job;}
// The operator's sign-in is gone or out of reach (Studio profile signed out, busy or missing; Chrome debugging
// connection lost; tokens not refreshed): the next video would fail the same way within seconds, so one lost sign-in
// used to mark every remaining video capture_failed. The run waits and tries the SAME video again instead; if the
// sign-in stays away for sessionWaitMs the run stops with this and every later video untouched, and --resume continues
// from here. The owner session never types credentials, so trying again cannot lock an account (unlike
// SESSION_HARD_STOP). Not here: owner_tenant_not_accessible (this account cannot open that tenant; other tenants'
// videos still run) and owner_session_unsafe_key (a safety refusal, not a lost sign-in).
export const SESSION_LOST=Object.freeze(['owner_chrome_unreachable','owner_not_signed_in','owner_token_expiring','owner_token_unreadable','owner_profile_busy','owner_profile_unavailable','owner_profile_missing','owner_profile_lock_port_conflict','owner_session_failed']);
export const sessionLost=(job)=>job?.captureStatus==='session_failed'&&SESSION_LOST.includes(job.session?.status);
// The Mac lost its network (DNS/Wi-Fi drop overnight): every video in that window fails at page.goto. That says nothing
// about the video, so it is waited out and retried like a lost sign-in instead of being recorded as an error.
const NET_DOWN_RE=/net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|CONNECTION_TIMED_OUT|NAME_RESOLUTION_FAILED)\b/;
export const networkLost=(job)=>{const t=JSON.stringify(job?.errors??[]);const m=NET_DOWN_RE.exec(t);return m?m[0]:null;};
export const DEFAULT_SESSION_WAIT_MS=60*60_000,DEFAULT_SESSION_RETRY_MS=60_000;
const FINAL_STATUSES=new Set(['ok','excluded','dry_run','script_not_found','capture_failed','aborted_mutating_request','timeout','error','tenant_unknown','tenant_conflict','tenant_unregistered','tenant_not_replayed']);
const summaryRow=(name,job,out)=>({name,status:job.status,tenant:job.tenant?.key??null,tenantStatus:job.tenant?.status??null,verdict:job.verdict??null,complete:job.complete??null,summary:job.summary??null,candidatePath:job.candidatePath??null,
  mutationStop:job.mutationStop??null,needsFixtureSteps:(job.needsFixture??[]).map(x=>x.index),nonGetRequests:(job.nonGetRequests??[]).length,mutatingRequests:(job.mutatingRequests??[]).length,job:join(out,name,'job.json'),seconds:job.timings?.total!=null?Math.round(job.timings.total/1000):null,
  ...(job.exclusion?{exclusion:{rule:job.exclusion.rule,module:job.exclusion.module,moduleSource:job.exclusion.moduleSource,topicModule:job.exclusion.topicModule??null}}:{})});

/**
 * resume:true continues an interrupted run in the SAME outDir: videos whose job.json has a final status are kept
 * as they are; an unfinished video's folder is moved aside (`<name>.interrupted-N`) and the video is run again.
 * exclusions: {rules:[{module, topicModule?}]} | legacy {modules:[...]} (default deps.exclusions = tools/drift/exclusions.json; injected test deps have none).
 * sessionWaitMs / sessionRetryMs: how long a lost owner sign-in (SESSION_LOST) is waited out, and how often the same
 * video is tried again. When it does not come back the run returns with summary.stopped set, no finishedAt and no
 * selection (cross-page selection needs the whole batch): resume it once the sign-in is back.
 */
export async function runWeekly({rehearse=true,session=null,names,outDir=join(SCRATCH,`weekly-${stamp()}`),dryRun=false,deps=null,judge=true,timeoutMs=DEFAULT_TIMEOUT_MS,profileDir=null,log=console.error,resume=false,exclusions=undefined,maxModelCalls=null,autoRepair=undefined,repairSettings={},reviewSettings={},sessionWaitMs=DEFAULT_SESSION_WAIT_MS,sessionRetryMs=DEFAULT_SESSION_RETRY_MS}){
  if(!names?.length)throw new Error('no_names');
  const out=resolve(outDir);const rel=relative(REPO,out);
  if(!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('output_inside_repo');
  let prev=null;
  if(existsSync(out)){if(!resume)throw new Error('output_exists');try{prev=JSON.parse(readFileSync(join(out,'summary.json'),'utf8'));}catch{throw new Error('resume_summary_unreadable');}}
  else{if(!existsSync(dirname(out)))throw new Error('output_parent_missing');mkdirSync(out,{mode:0o700});}
  deps=deps??await defaultDeps({judge:judge&&!dryRun,maxModelCalls,autoRepair:autoRepair!==false,reviewSettings});
  // The capture's inner deadline used to truncate long videos at five minutes despite --timeout-min.
  // Keep the actual read-only guard and reserve outer time for compare/classify instead of needing weekly retries.
  deps={...deps,captureLimits:{...LIMITS,...deps.captureLimits,totalMs:Math.max(1000,timeoutMs-60_000)}};
  // Rehearsal (capture.mjs rehearsalFor): walk through forms up to, never including, the save; resume after a stop
  // at the next page load. On by default (writes are aborted at the network layer either way); --no-rehearse disables.
  if(rehearse)deps={...deps,rehearse:true};
  // Capture session: 'automation' (each tenant's automation account) or 'owner' (the operator's Chrome sign-in, which
  // sees the same records as the original recordings; owner-session.mjs). A resumed run keeps its original session so
  // one run never mixes data visibility.
  const captureSession=prev?.captureSession??session??deps.captureSession??'automation';
  if(!['automation','owner'].includes(captureSession))throw new Error(`unknown_session:${captureSession}`);
  deps={...deps,captureSession};
  const excl=exclusions!==undefined?exclusions:(deps.exclusions??null);
  const summary={schema:1,startedAt:prev?.startedAt??new Date().toISOString(),outDir:out,dryRun,names,captureSession,profile:captureSession==='owner'?'owner':profileDir??'per-tenant',bridgeAtStart:prev?.bridgeAtStart??(dryRun?null:await deps.bridgeStatus?.()??null),
    exclusions:hasRules(excl)?{rules:(excl.rules??parseExclusions(excl).rules).map(r=>({id:r.id,module:r.module,topicModule:r.topicModule??null,reason:r.reason??null})),reason:excl.reason??null,addedAt:excl.addedAt??null,addedBy:excl.addedBy??null}:null,videos:[],
    ...(prev?{resumes:[...(prev.resumes??[]),{at:new Date().toISOString(),alreadyDone:0}]}:{}),sessionWaits:[...(prev?.sessionWaits??[])]};
  const save=()=>writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const sleep=deps.sleep??((ms)=>new Promise(r=>setTimeout(r,ms)));
  // Resume: keep finished videos (from their job.json, the source of truth), in the original order.
  const done=new Map(),jobs=new Map();
  if(prev)for(const name of names){const f=join(out,name,'job.json');let j=null;try{j=JSON.parse(readFileSync(f,'utf8'));}catch{}
    // A video that only failed because the sign-in was lost was never checked: it runs again (like 'session_blocked').
    if(j&&FINAL_STATUSES.has(j.status)&&j.finishedAt&&j.captureStatus!=='session_blocked'&&!sessionLost(j))done.set(name,j);
    else if(existsSync(join(out,name))){let k=1;while(existsSync(join(out,`${name}.interrupted-${k}`)))k++;renameSync(join(out,name),join(out,`${name}.interrupted-${k}`));log(`[weekly] ${name}: unfinished folder moved to ${name}.interrupted-${k}; running again`);}}
  if(prev)summary.resumes.at(-1).alreadyDone=done.size;
  // Tenant sign-in circuit breaker (also rebuilt from finished jobs on resume).
  summary.tenantBlocked={}; // rebuilt from the finished jobs (a 'session_blocked' video is re-evaluated on resume)
  for(const [n,j] of done)if(SESSION_HARD_STOP.includes(j.session?.status)&&j.tenant?.key&&!summary.tenantBlocked[j.tenant.key])summary.tenantBlocked[j.tenant.key]={status:j.session.status,video:n,at:j.finishedAt??null};
  save();
  for(const name of names){ // concurrency 1, by design (one browser profile, one bridge)
    if(done.has(name)){jobs.set(name,done.get(name));summary.videos.push(summaryRow(name,done.get(name),out));continue;}
    let job;
    const src=hasRules(excl)?(()=>{try{return deps.readScript(name);}catch{return null;}})():null;
    const ex=src?exclusionFor(src.script,excl):null;
    if(ex){job=excludedJob(name,join(out,name),ex);jobs.set(name,job);log(`[weekly] ${name}: excluded (${ex.rule})`);summary.videos.push(summaryRow(name,job,out));save();continue;}
    if(Object.keys(summary.tenantBlocked).length&&!dryRun){let t=null;try{const sc=(src??deps.readScript(name))?.script;t=sc?detectScriptTenant(sc).tenant:null;}catch{}
      if(t&&summary.tenantBlocked[t]){job=blockedJob(name,join(out,name),t,summary.tenantBlocked[t]);jobs.set(name,job);log(`[weekly] ${name}: ${job.summary}`);summary.videos.push(summaryRow(name,job,out));save();continue;}}
    // Owner session: borrow/refresh the operator's sign-in BEFORE the per-video timeout starts (it may wait for the
    // app to refresh short-lived tokens). A lost sign-in (SESSION_LOST) is waited out here: this video is tried again
    // every sessionRetryMs, and after sessionWaitMs the run stops with this and every later video untouched.
    let away=null; // {video,status,detail,since,tries} while the sign-in is away
    for(;;){
      let lost=null;
      if(deps.captureSession==='owner'&&!dryRun&&deps.ownerWarmup){try{const sc=(src??deps.readScript(name))?.script;const t=sc?detectScriptTenant(sc):null;
        if(t?.status==='ok'&&tenantReplayed(t.tenant))await deps.ownerWarmup(t.tenant,(m)=>log(`[weekly] ${m}`));}catch(e){log(`[weekly] ${name}: owner session warm-up: ${e?.code||e?.message||e}`);
        if(SESSION_LOST.includes(e?.code))lost={status:e.code,detail:e.detail??null};}}
      if(!lost){
        log(`[weekly] ${name}: start`);
        const controller=new AbortController();
        // The capture is bounded at timeoutMs-1 min (captureLimits.totalMs); model reviews of a long video (e.g. 39 slides)
        // run after it and need their own time, so a judged video gets a second budget instead of timing out after capture.
        try{job=await withTimeout(runVideo(name,{outDir:out,deps,dryRun,profileDir,log,signal:controller.signal}),judge?2*timeoutMs:timeoutMs,name);}
        catch(e){controller.abort();job={name,status:e?.code==='timeout'?'timeout':'error',candidatePath:null,errors:[{stage:'video',error:String(e?.message||e)}],finishedAt:new Date().toISOString()};
          try{const f=join(out,name,'job.json');const prevJob=existsSync(f)?JSON.parse(readFileSync(f,'utf8')):{};writeFileSync(f,JSON.stringify({...prevJob,...job},null,2)+'\n');}catch{}}
        if(sessionLost(job)||networkLost(job)){lost=sessionLost(job)?{status:job.session.status,detail:job.session.detail??null}:{status:'network_unreachable',detail:networkLost(job)};
          // The failed attempt stays as evidence, out of the way of the next try (and of a resume).
          let k=1;while(existsSync(join(out,`${name}.session-lost-${k}`)))k++;if(existsSync(join(out,name)))renameSync(join(out,name),join(out,`${name}.session-lost-${k}`));job=null;}
      }
      if(!lost){if(away){summary.sessionWaits.push({...away,until:new Date().toISOString(),recovered:true});log(`[weekly] ${name}: sign-in is back after ${Math.round((Date.now()-Date.parse(away.since))/1000)} s; continuing`);}break;}
      away={video:name,since:away?.since??new Date().toISOString(),tries:(away?.tries??0)+1,status:lost.status,detail:lost.detail};
      const waited=Date.now()-Date.parse(away.since);
      if(waited>=sessionWaitMs){
        summary.sessionWaits.push({...away,until:new Date().toISOString(),recovered:false});
        summary.stopped={reason:'session_lost',video:name,status:lost.status,detail:lost.detail,since:away.since,at:new Date().toISOString(),done:summary.videos.length,remaining:names.length-summary.videos.length};
        log(`[weekly] stopped at ${name}: the sign-in did not come back within ${Math.round(sessionWaitMs/60_000)} min (${lost.status}${lost.detail?`: ${lost.detail}`:''}). ${summary.stopped.done} of ${names.length} videos are done; the other ${summary.stopped.remaining} were not touched. Continue with --resume ${out} once it is signed in.`);
        break;}
      log(`[weekly] ${name}: sign-in lost (${lost.status}${lost.detail?`: ${lost.detail}`:''}); trying again in ${Math.round(sessionRetryMs/1000)} s, giving up in ${Math.max(1,Math.round((sessionWaitMs-waited)/60_000))} min`);
      save();await sleep(sessionRetryMs);
    }
    if(summary.stopped){save();break;}
    jobs.set(name,job);summary.videos.push(summaryRow(name,job,out));
    if(SESSION_HARD_STOP.includes(job.session?.status)&&job.tenant?.key&&!summary.tenantBlocked[job.tenant.key]){
      summary.tenantBlocked[job.tenant.key]={status:job.session.status,video:name,at:new Date().toISOString()};
      log(`[weekly] ${job.tenant.key} sign-in returned ${job.session.status}: no further ${job.tenant.key} video will try to sign in this run (lockout protection); needs a human`);}
    save();log(`[weekly] ${name}: ${job.status} ${job.verdict??''}${job.shellRollout?.state?` | sidebar ${job.shellRollout.state}${job.shellRollout.old?` (${job.shellRollout.confirmed.length} of ${job.shellRollout.old} old-sidebar slides recaptured)`:''}`:''}`);
  }
  // A stopped run is not finalized: cross-page selection needs every video, so the resumed run does it.
  if(!dryRun&&!summary.stopped){
    const selection=await finalizeWeeklySelection({jobs:[...jobs.values()],outDir:out,deps,log});
    summary.uiSelection={...selectionMarker(selection),path:join(out,'ui-selection.json')};
    summary.videos=summary.videos.map(row=>jobs.has(row.name)?summaryRow(row.name,jobs.get(row.name),out):row);
    summary.captureFinishedAt=new Date().toISOString();save();
    if(autoRepair!==false&&deps.repairAutomation){
      try{
        const automated=await deps.repairAutomation({jobs:[...jobs.values()],summary:{...summary,finishedAt:summary.captureFinishedAt},outDir:out,selection,settings:repairSettings,budget:deps.reviewBudget??null,log});
        summary.automation={policy:automated.policy,status:'finished',report:join(out,'automation-report.json'),counts:automated.counts,posts:0,uploads:0};
      }catch(error){
        // A provider/baseline failure is an operational hold, never a human re-record verdict or unchanged video.
        summary.automation={status:'setup_required',reason:String(error.code??error.message),posts:0,uploads:0};
        log(`[weekly] automatic repairs held: ${summary.automation.reason}`);
      }
    }
  }
  if(!summary.stopped)summary.finishedAt=new Date().toISOString();
  if(deps.reviewProvider)summary.reviewProvider=deps.reviewProvider.status();
  summary.reviewPending=[...jobs.values()].filter(j=>j.status==='review_pending').map(j=>({name:j.name,reasons:j.reviewPending}));
  // Model reviews made / reused / deferred by the per-run budget (pending work is reported, never counted unchanged).
  if(deps.reviewBudget){summary.reviewUsage=structuredClone(deps.reviewBudget.usage);
    log(`[weekly] model reviews: ${summary.reviewUsage.calls} made, ${summary.reviewUsage.cacheHits} reused, ${summary.reviewUsage.budgetSkipped} deferred (cap ${summary.reviewUsage.maxCalls??'none'})`);}
  summary.counts=summary.videos.reduce((a,v)=>{const k=v.verdict??v.status;a[k]=(a[k]??0)+1;return a;},{});
  // App-shell rollout worklist: per captured video, its old-sidebar slides and how many were recaptured (step indexes
  // are in each job.json). A video that was not captured has no row: its sidebar was not checked.
  const shellRows=[...jobs.values()].filter(j=>j.shellRollout);
  if(shellRows.length)summary.shellRollout={counts:shellRows.reduce((a,j)=>{const k=j.shellRollout.state;a[k]=(a[k]??0)+1;return a;},{}),notChecked:summary.videos.length-shellRows.length,
    videos:shellRows.map(j=>({name:j.name,state:j.shellRollout.state,old:j.shellRollout.old??0,recaptured:j.shellRollout.confirmed?.length??0,notCaptured:j.shellRollout.notCaptured?.length??0,unconfirmed:j.shellRollout.unconfirmed?.length??0,
      ...(j.shellRollout.mixed?{mixed:true}:{}),...(j.shellRollout.notCaptured?.length&&j.mutationStop?{stoppedAt:j.mutationStop.index,stopReason:j.mutationStop.reason??null}:{})}))};
  summary.tenantCounts=summary.videos.reduce((a,v)=>{const k=v.tenant??v.tenantStatus??'n/a';a[k]=(a[k]??0)+1;return a;},{});
  summary.tenantSkipped=summary.videos.filter(v=>/^tenant_/.test(v.status)).map(v=>({name:v.name,status:v.status,summary:v.summary}));
  const exRows=summary.videos.filter(v=>v.status==='excluded');
  summary.excluded={count:exRows.length,byRule:exRows.reduce((a,v)=>{const k=v.exclusion?.rule??'excluded';a[k]=(a[k]??0)+1;return a;},{}),
    byRuleAndSource:exRows.reduce((a,v)=>{const k=`${v.exclusion?.rule??'excluded'} (${v.exclusion?.moduleSource??'?'})`;a[k]=(a[k]??0)+1;return a;},{}),names:exRows.map(v=>v.name)};
  save();return summary;
}

function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export async function main(args=process.argv.slice(2)){
  if(!args.includes('--once'))throw Object.assign(new Error('usage: weekly.mjs --once (--names A,B | --allowlist FILE) [--out NEW_DIR | --resume EXISTING_RUN_DIR] [--dry-run] [--no-judge] [--timeout-min N] [--session-wait-min N] [--max-model-calls N] [--no-rehearse] [--review-provider codex|claude] [--review-model MODEL] [--review-effort LEVEL] [--review-cache-dir DIR] [--codex-bin PATH] [--session automation|owner]'),{exit:64});
  const cap=arg(args,'--max-model-calls');
  // How long a lost owner sign-in is waited out before the run stops, resumable (0 = stop at once).
  const waitMin=arg(args,'--session-wait-min');
  if(args.includes('--session-wait-min')&&!/^\d+$/.test(waitMin??''))throw Object.assign(new Error('--session-wait-min must be a whole number of minutes'),{exit:64});
  const reviewSettings={};
  for(const [flag,key]of [['--review-provider','provider'],['--review-model','model'],['--review-effort','effort'],['--review-cache-dir','cacheDir'],['--codex-bin','binary']]){
    if(args.includes(flag)){
      const value=arg(args,flag);if(!value||value.startsWith('--'))throw Object.assign(new Error(`${flag} requires a value`),{exit:64});
      reviewSettings[key]=value;
    }
  }
  // Validate explicit provider configuration before creating an output directory, including dry-run invocations.
  if(Object.keys(reviewSettings).length){
    const settings=detectionReviewSettings(reviewSettings);
    if(settings.provider==='codex')createGroundedReviewers(settings);
  }
  if(cap!=null&&!/^\d+$/.test(cap))throw Object.assign(new Error('--max-model-calls must be a whole number'),{exit:64});
  const session=arg(args,'--session')??(process.env.DRIFT_CAPTURE_SESSION||null);
  if(session!=null&&!['automation','owner'].includes(session))throw Object.assign(new Error('--session must be automation or owner'),{exit:64});
  const allow=arg(args,'--allowlist');
  const names=parseNames({names:arg(args,'--names'),allowlistText:allow?readFileSync(resolve(allow),'utf8'):null});
  const resumeDir=arg(args,'--resume');
  let s;
  try{s=await runWeekly({names,outDir:resumeDir??arg(args,'--out')??join(SCRATCH,`weekly-${stamp()}`),resume:!!resumeDir,dryRun:args.includes('--dry-run'),judge:!args.includes('--no-judge'),reviewSettings,session,
    timeoutMs:arg(args,'--timeout-min')?Number(arg(args,'--timeout-min'))*60_000:DEFAULT_TIMEOUT_MS,maxModelCalls:cap!=null?Number(cap):null,rehearse:!args.includes('--no-rehearse'),
    ...(waitMin!=null?{sessionWaitMs:Number(waitMin)*60_000}:{}),
    autoRepair:args.includes('--no-auto-repair')?false:undefined,repairSettings:{...(arg(args,'--codex-bin')?{binary:arg(args,'--codex-bin')}:{}),...(arg(args,'--repair-model')?{model:arg(args,'--repair-model')}:{}),...(arg(args,'--repair-effort')?{effort:arg(args,'--repair-effort')}:{})}});}
  // One Chrome debugging connection served every borrow of this run (one Allow prompt); release it so the run exits.
  // Unconditional: a resumed run takes its session from summary.json inside runWeekly, not from this CLI's --session.
  finally{await (await import('./owner-session.mjs')).releaseOwnerConnection().catch(()=>{});}
  console.log(JSON.stringify({outDir:s.outDir,stopped:s.stopped??null,counts:s.counts,tenantCounts:s.tenantCounts,reviewUsage:s.reviewUsage??null,reviewProvider:s.reviewProvider??null,reviewPending:s.reviewPending,automation:s.automation??null,videos:s.videos.map(v=>({name:v.name,tenant:v.tenant,status:v.status,verdict:v.verdict,summary:v.summary,candidate:v.candidatePath}))},null,2));
  return s;
}
// Exit 75 (temporary failure): the run stopped because the sign-in was lost and can be resumed.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().then(s=>{if(s?.stopped)process.exitCode=75;}).catch(e=>{console.error(e.message);process.exitCode=e.exit??1;});
