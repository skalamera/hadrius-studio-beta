// Drift classification: per step and per video, decide what a drifted walkthrough needs.
//   unchanged | slide_update | moved_highlight | narration_review | full_rerecord
// Inputs: compare.json + run.json (capture.mjs/compare.mjs output), the script, recorded + today's PNGs.
// Deterministic signals first (target resolution, SSIM/diff, changed-region coverage, persistent chrome
// such as the sidebar that appears on every slide, route/flow changes); narration accuracy is judged by
// the same `claude` CLI path the bridge uses (tools/coverage-scan.mjs runClaude) with a strict JSON verdict.
// Import-safe (no side effects). Never writes outside the run directory; never touches scripts/ or out/.
//
// CLI: node tools/drift/classify.mjs --run RUN_DIR --script SCRIPT.json --recordings RECORDING_DIR [--no-judge]
//   writes RUN_DIR/classify.json (must not exist) and prints the video verdict.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {decodePng,DEFAULT_THRESHOLDS as CMP} from './compare.mjs';

export const VERDICTS=Object.freeze(['unchanged','slide_update','moved_highlight','narration_review','full_rerecord']);
const RANK=Object.fromEntries(VERDICTS.map((v,i)=>[v,i]));
export const worst=(list)=>list.filter(v=>v in RANK).reduce((a,b)=>RANK[b]>RANK[a]?b:a,'unchanged');
export const THRESHOLDS=Object.freeze({
  redesignSsim:0.80,      // masked SSIM below this = the page itself was redesigned
  redesignCoverage:0.50,  // union of non-dynamic changed regions covering more than this fraction of the frame
  redesignDiff:0.15,      // non-dynamic changed-pixel fraction above this
  chromeCell:16,          // grid cell (px) for persistent-chrome detection
  chromeStableMax:8,      // max per-channel difference across ALL recorded frames for a cell to be "persistent"
  chromeTextureStd:6,     // luma std-dev a persistent cell needs (blank background is not chrome)
  chromeCellChanged:0.08, // fraction of changed pixels (> pixel threshold) that marks a chrome cell changed today
  chromeChangedFraction:0.20, // fraction of chrome cells changed on a slide => chrome changed (mixed-UI risk)
  chromeMinCells:12,
});

// ---------- deterministic image signals ----------
/** Union area of non-dynamic changed regions as a fraction of the frame (cell grid, no double counting). */
export function regionCoverage(regions,width,height,cell=CMP.cell){
  if(!width||!height)return 0;const gw=Math.ceil(width/cell),gh=Math.ceil(height/cell),g=new Uint8Array(gw*gh);
  for(const r of regions||[]){if(r.dynamic)continue;for(let y=Math.floor(r.y/cell);y<Math.ceil((r.y+r.h)/cell)&&y<gh;y++)for(let x=Math.floor(r.x/cell);x<Math.ceil((r.x+r.w)/cell)&&x<gw;x++)g[y*gw+x]=1;}
  let n=0;for(const v of g)n+=v;return n/(gw*gh);
}
const lumaAt=(img,i)=>0.299*img.data[i*4]+0.587*img.data[i*4+1]+0.114*img.data[i*4+2];
/** Persistent chrome = textured cells identical across every distinct recorded frame of the video (sidebar,
 *  header). recorded: [{index,img,route}], today: Map(index -> img). Needs >= 2 distinct recorded frames on
 *  >= 2 different routes: frames of one page share their content too, which is not chrome. */
export function chromeAnalysis(recorded,today,T=THRESHOLDS){
  const frames=[],seen=new Set(),routes=new Set();
  for(const r of recorded){if(!r.img)continue;const h=createHash('sha1').update(r.img.data).digest('hex');if(!seen.has(h)){seen.add(h);frames.push(r.img);routes.add(r.route??h);}}
  if(frames.length<2)return {available:false,reason:'fewer_than_2_distinct_recorded_frames',perStep:{}};
  if(routes.size<2)return {available:false,reason:'all_recorded_frames_on_one_route',perStep:{}};
  const {width:w,height:h}=frames[0];if(frames.some(f=>f.width!==w||f.height!==h))return {available:false,reason:'recorded_size_mismatch',perStep:{}};
  const c=T.chromeCell,gw=Math.ceil(w/c),gh=Math.ceil(h/c),stable=[];
  for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){let ok=true,sum=0,sq=0,n=0;
    for(let y=gy*c;y<Math.min(h,gy*c+c)&&ok;y++)for(let x=gx*c;x<Math.min(w,gx*c+c);x++){const i=y*w+x;
      for(let f=1;f<frames.length&&ok;f++)for(let k=0;k<3;k++)if(Math.abs(frames[0].data[i*4+k]-frames[f].data[i*4+k])>T.chromeStableMax){ok=false;break;}
      if(!ok)break;const l=lumaAt(frames[0],i);sum+=l;sq+=l*l;n++;}
    if(ok&&n&&Math.sqrt(Math.max(0,sq/n-(sum/n)**2))>=T.chromeTextureStd)stable.push(gy*gw+gx);}
  if(stable.length<T.chromeMinCells)return {available:false,reason:'no_persistent_chrome',cells:stable.length,perStep:{}};
  let x0=gw,y0=gh,x1=0,y1=0;for(const s of stable){const x=s%gw,y=(s-x)/gw;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  const perStep={};
  for(const r of recorded){const t=today.get(r.index);if(!r.img||!t||t.width!==w||t.height!==h)continue;let changed=0;
    for(const s of stable){const gx=s%gw,gy=(s-gx)/gw;let d=0,n=0;
      for(let y=gy*c;y<Math.min(h,gy*c+c);y++)for(let x=gx*c;x<Math.min(w,gx*c+c);x++){const i=(y*w+x)*4;n++;if(Math.max(Math.abs(r.img.data[i]-t.data[i]),Math.abs(r.img.data[i+1]-t.data[i+1]),Math.abs(r.img.data[i+2]-t.data[i+2]))>CMP.pixel)d++;}
      if(d/n>=T.chromeCellChanged)changed++;}
    const fraction=changed/stable.length;perStep[r.index]={changedCells:changed,fraction:Math.round(fraction*1e4)/1e4,changed:fraction>T.chromeChangedFraction};}
  return {available:true,cells:stable.length,distinctRecordedFrames:frames.length,bbox:{x:x0*c,y:y0*c,w:(x1-x0+1)*c,h:(y1-y0+1)*c},perStep};
}

// ---------- narration judge (claude CLI, same path as the bridge) ----------
// Only TODAY's screenshot is shown: given both frames the model mixed them up (it "saw" the recorded
// project ID on today's redesigned page). Today's visible DOM text, when captured, is added as grounding.
export function buildJudgePrompt({title,stepNumber,stepCount,action,targetName,narration,todayPath,todayTitle,todayUrl,todayText}){
  return [
    'You are checking ONE slide of a recorded Hadrius product walkthrough video against the LIVE product as it looks TODAY.',
    `Use the Read tool to open this screenshot of the live product today: ${todayPath}`,
    'That screenshot (and the page text below, if any) is the ONLY evidence. Do not assume anything that is not visible in it.',
    `Video: "${title}". Slide ${stepNumber} of ${stepCount}. Recorded action on this slide: ${action}${targetName?` on "${targetName}"`:''}.`,
    todayTitle||todayUrl?`Today's page: ${todayTitle??''} ${todayUrl??''}`.trim():'',
    todayText?`Visible text on today's page (DOM innerText, truncated):\n"""\n${String(todayText).slice(0,3000)}\n"""`:'',
    `Narration spoken over this slide: "${narration}"`,
    'Question: if this TODAY screenshot were shown under this narration, would the narration be factually accurate?',
    'Judge only what the narration claims about the screen/product (labels, elements, values, where things are, what the page shows). Ignore styling, colours, layout and sample data that differs (names, dates, counts).',
    'claim_missing = true when a UI element, field, label or feature the narration describes is NOT present/visible in today\'s screenshot.',
    'data_missing = true when the page is still loading, or is loaded but the specific records the narration relies on are absent (empty list/board, "no items", record not visible to this account). That is an environment/data gap, not a UI change: then set accurate=false, claim_missing=false, data_missing=true.',
    'Quote what you looked for in "evidence".',
    'Reply with ONLY this JSON, no prose: {"accurate": boolean, "claim_missing": boolean, "data_missing": boolean, "reason": "one sentence", "evidence": "what you saw or could not find", "suggested_rewrite": "replacement narration or null"}',
  ].filter(Boolean).join('\n');
}
export function parseJudge(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error('judge_not_object');
  if(typeof obj.accurate!=='boolean')throw new Error('judge_missing_accurate');
  if(typeof obj.reason!=='string'||!obj.reason.trim())throw new Error('judge_missing_reason');
  const out={accurate:obj.accurate,claim_missing:obj.claim_missing===true,reason:obj.reason.trim().slice(0,500)};
  if(obj.data_missing===true&&!obj.accurate){out.data_missing=true;out.claim_missing=false;}
  if(typeof obj.evidence==='string'&&obj.evidence.trim())out.evidence=obj.evidence.trim().slice(0,500);
  if(typeof obj.suggested_rewrite==='string'&&obj.suggested_rewrite.trim()&&obj.suggested_rewrite.trim().toLowerCase()!=='null')out.suggested_rewrite=obj.suggested_rewrite.trim().slice(0,500);
  if(out.accurate)out.claim_missing=false;
  return out;
}
/** Default judge: runClaude from tools/coverage-scan.mjs (claude CLI, keychain login, Read tool only;
 *  Claude is the only provider, so nothing here reads API keys from .env files). */
export function makeClaudeJudge({runModel=null,timeoutMs=240_000}={}){
  return async(input)=>{
    const cs=await import('../coverage-scan.mjs');const run=runModel??cs.runClaude;const meta={};
    const raw=await run(buildJudgePrompt(input),{allowedTools:'Read',maxTurns:6,timeout:timeoutMs,model:cs.decisionModel(),onMeta:m=>Object.assign(meta,m)});
    return {...parseJudge(cs.extractJson(raw)),model:meta.model??null,costUsd:meta.costUsd??null};
  };
}

// ---------- per-step decision (pure) ----------
const pathOf=(u)=>{try{return new URL(u).pathname.replace(/\/+$/,'');}catch{return null;}};
/** sig -> {verdict|'unverified', reasons:[{code,detail}], needsJudge} ; judge may be null (not asked yet). */
export function classifyStepSignals(sig,T=THRESHOLDS){
  const reasons=[];const add=(verdict,code,detail)=>reasons.push({verdict,code,detail});
  if(sig.targetStatus&&sig.targetStatus!=='resolved')add('full_rerecord',`target_${sig.targetStatus}`,`recorded ${sig.action} target "${sig.targetName??'?'}" ${sig.targetStatus==='ambiguous'?`is ambiguous today (${sig.targetMatches??'>1'} matches)`:'no longer exists today'}`);
  if(!sig.hasScreenshot){
    if(reasons.length)return {verdict:'full_rerecord',reasons,needsJudge:false};
    if(sig.guardStatus==='needs_fixture')return {verdict:'unverified',reasons:[{verdict:'unverified',code:'needs_fixture',detail:sig.guardReason??'replay stopped before a data-changing step'}],needsJudge:false};
    return {verdict:'unverified',reasons:[{verdict:'unverified',code:'not_captured',detail:sig.error??'no screenshot'}],needsJudge:false};
  }
  // Environment/data gaps are not drift: a page that never finished loading, or a recorded record the
  // automation account cannot see (empty state where the target was), leaves the step unverified.
  if(sig.errorState)return {verdict:'unverified',reasons:[{verdict:'unverified',code:'page_error',detail:`page shows an error ("${sig.errorState}"): record likely not visible to the capture account`}],needsJudge:false};
  if(sig.pageState==='loading')return {verdict:'unverified',reasons:[{verdict:'unverified',code:'page_not_loaded',detail:'page still showed only a loading indicator (record may not be visible to the capture account)'},...reasons.filter(r=>r.verdict!=='full_rerecord')],needsJudge:false};
  // Needs BOTH the DOM empty-state text and the judge's data_missing (Kanban columns say "up to date" even when
  // other columns hold the records), otherwise a missing target stays a re-record.
  if(sig.targetStatus&&(sig.targetStatus!=='resolved'||sig.targetMethod==='css')&&sig.emptyState&&sig.judge?.data_missing)
    return {verdict:'unverified',reasons:[{verdict:'unverified',code:'record_not_visible',detail:`recorded target "${sig.targetName??'?'}" not found and the page shows an empty state ("${sig.emptyState}"): the capture account likely cannot see this record`}],needsJudge:true};
  if(sig.targetMethod==='css'&&sig.targetStatus==='resolved')add('narration_review','target_renamed',`target found only by its CSS path; recorded name "${sig.targetName}" is now "${sig.todayTargetName}"`);
  if(sig.routeChanged)add('full_rerecord','route_changed',`page route changed: recorded ${sig.recordedPath} -> today ${sig.todayPath}`);
  if(sig.flowChanged)add('full_rerecord','flow_changed',sig.flowDetail??'the recorded click no longer leads to the next recorded page');
  if(!sig.dimensionsMatch&&sig.compareClass!=='unchanged')add('full_rerecord','viewport_changed','screenshot size differs from the recording');
  const visual=sig.compareClass==='screenshot_changed'||sig.compareClass==='target_geometry_changed'||sig.compareClass==='target_missing';
  const m=sig.metrics||{};
  if(visual&&sig.dimensionsMatch){
    const why=[];if(m.ssimMasked!=null&&m.ssimMasked<T.redesignSsim)why.push(`SSIM ${m.ssimMasked} < ${T.redesignSsim}`);
    if(m.coverage!=null&&m.coverage>T.redesignCoverage)why.push(`changed regions cover ${(m.coverage*100).toFixed(1)}% > ${T.redesignCoverage*100}%`);
    if(m.diff!=null&&m.diff>T.redesignDiff)why.push(`changed pixels ${(m.diff*100).toFixed(1)}% > ${T.redesignDiff*100}%`);
    if(why.length)add('full_rerecord','page_redesigned',why.join('; '));
  }
  if(sig.compareClass==='target_geometry_changed')add('moved_highlight','target_moved',`target moved/resized by up to ${sig.targetDeltaMax}px`);
  else if(sig.compareClass==='screenshot_changed')add('slide_update','screenshot_changed',`diff ${((m.diff??0)*100).toFixed(2)}% non-dynamic, SSIM ${m.ssimMasked}`);
  if(sig.chromeChanged)add('slide_update','persistent_chrome_changed',`persistent chrome (sidebar/header seen on every slide) changed in ${(sig.chromeFraction*100).toFixed(0)}% of its cells`);
  const needsJudge=visual&&!!(sig.narration&&sig.narration.trim());
  if(needsJudge){const j=sig.judge;
    if(!j)add('narration_review','narration_unchecked','screenshot changed; narration accuracy not checked');
    else if(j.error)add('narration_review','narration_unchecked',`narration judge unavailable: ${j.error}`);
    else if(!j.accurate&&j.data_missing)return {verdict:reasons.some(r=>r.verdict==='full_rerecord')?'full_rerecord':'unverified',reasons:[...reasons.filter(r=>r.verdict==='full_rerecord'),{verdict:'unverified',code:'data_missing',detail:j.reason}],needsJudge};
    else if(!j.accurate&&j.claim_missing)add('full_rerecord','narration_contradicted',j.reason);
    else if(!j.accurate)add('narration_review','narration_inaccurate',j.reason);
  }
  return {verdict:worst(reasons.map(r=>r.verdict)),reasons,needsJudge};
}

/** Video verdict = worst step, plus the mixed-old/new-UI rule. */
export function videoVerdict(steps){
  const verified=steps.filter(s=>s.verdict!=='unverified');const unverified=steps.filter(s=>s.verdict==='unverified');
  let verdict=worst(verified.map(s=>s.verdict));const reasons=[];
  for(const s of steps)for(const r of s.reasons)if(r.verdict===verdict&&verdict!=='unchanged')reasons.push({step:s.index,...r});
  const chromeSteps=steps.filter(s=>s.chromeChanged).map(s=>s.index);
  const kept=steps.filter(s=>s.verdict==='unchanged'||s.verdict==='unverified').map(s=>s.index);
  if(chromeSteps.length&&kept.length&&verdict!=='full_rerecord'){
    reasons.unshift({step:null,verdict:'full_rerecord',code:'mixed_old_new_ui',detail:`persistent chrome (sidebar/header) changed on slide(s) ${chromeSteps.map(i=>i+1).join(', ')}; slide(s) ${kept.map(i=>i+1).join(', ')} cannot be updated (unchanged or unverified), so a partial update would mix old and new UI`});
    verdict='full_rerecord';
  }else if(chromeSteps.length&&kept.length)reasons.push({step:null,verdict:'full_rerecord',code:'mixed_old_new_ui',detail:`persistent chrome changed on slide(s) ${chromeSteps.map(i=>i+1).join(', ')}; slide(s) ${kept.map(i=>i+1).join(', ')} would keep the old UI`});
  const complete=unverified.length===0;
  const label={unchanged:'No visible drift',slide_update:'Screenshots changed; narration still accurate: slide update',moved_highlight:'Click target moved: re-plan highlight',narration_review:'Screenshot changed and narration may be inaccurate: human narration review',full_rerecord:'Needs a FULL RE-RECORD'}[verdict];
  const top=reasons.slice(0,6).map(r=>`${r.step==null?'video':`slide ${r.step+1}`}: ${r.code} (${r.detail})`);
  const summary=`${label}.${top.length?' '+top.join('; ')+'.':''}${complete?'':` ${unverified.length} step(s) not verified (${[...new Set(unverified.flatMap(s=>s.reasons.map(r=>r.code)))].join(', ')}).`}`;
  return {verdict,complete,reasons,summary,unverifiedSteps:unverified.map(s=>s.index),chromeChangedSteps:chromeSteps};
}

export const EMPTY_STATE_RE=/(you(?:'|’| a)re up to date|all projects are archived|no (?:projects|results|items|records|documents|data|flags)(?: found| yet)?\b|nothing (?:here|to show)|you don't have access|not authori[sz]ed|access denied|page not found)/i;
export const ERROR_STATE_RE=/(couldn['’]t load (?:this|the) [a-z ]{2,30}|[a-z ]{2,30} not found\b|failed to load|something went wrong|you don['’]t have (?:access|permission)|access denied|page not found|\b404\b)/i;
export const errorStateOf=(text)=>{const m=ERROR_STATE_RE.exec(text??'');return m?m[1].trim():null;};
export const emptyStateOf=(text)=>{const m=EMPTY_STATE_RE.exec(text??'');return m?m[1]:null;};
// ---------- run-level ----------
export async function classifyRun({runDir,script,recordingsDir,judge=null,thresholds=THRESHOLDS,log=()=>{},write=true}){
  const run=JSON.parse(readFileSync(join(runDir,'run.json'),'utf8'));const cmp=JSON.parse(readFileSync(join(runDir,'compare.json'),'utf8'));
  const byIdx=new Map(run.steps.map(s=>[s.index,s]));const cmpBy=new Map(cmp.steps.map(s=>[s.index,s]));
  const recorded=[],today=new Map(),paths={};
  for(const st of script.steps){const c=cmpBy.get(st.index);let rimg=null;
    if(st.media?.pre&&existsSync(join(recordingsDir,st.media.pre))){try{rimg=decodePng(readFileSync(join(recordingsDir,st.media.pre)));}catch{}}
    recorded.push({index:st.index,img:rimg,route:pathOf(st.url)});
    if(c?.todayScreenshot){try{today.set(st.index,decodePng(readFileSync(join(runDir,c.todayScreenshot))));}catch{}}
    paths[st.index]={recorded:st.media?.pre?join(recordingsDir,st.media.pre):null,today:c?.todayScreenshot?join(runDir,c.todayScreenshot):null};}
  const chrome=chromeAnalysis(recorded,today,thresholds);
  const findings=run.findings??[];const steps=[];
  for(const st of script.steps){
    const c=cmpBy.get(st.index)??{};const r=byIdx.get(st.index)??{};const img=today.get(st.index);
    const flow=findings.find(f=>f.step===st.index&&/click_destination_differs|click_navigated_unexpectedly/.test(f.kind));
    const recPath=pathOf(st.url),todayPath=pathOf(c.todayUrl??r.todayUrl);
    const sig={index:st.index,action:st.action,narration:st.narration??'',hasScreenshot:!!(c.todayScreenshot&&c.classification!=='not_captured'&&c.classification!=='needs_fixture'),
      compareClass:c.classification??'not_captured',dimensionsMatch:c.dimensions?.match!==false,guardStatus:r.mutationGuard?.status??null,guardReason:r.mutationGuard?.reason??null,error:r.error??c.reason??null,
      targetStatus:r.target?.status??null,targetMethod:r.target?.method??null,targetName:st.target?.name??null,todayTargetName:r.target?.resolved?.name??null,targetMatches:r.target?.matches?.length??null,targetDeltaMax:r.target?.delta?.max??null,
      routeChanged:!!(recPath&&todayPath&&recPath!==todayPath),recordedPath:recPath,todayPath,flowChanged:!!flow,flowDetail:flow?`${flow.kind}: expected ${flow.expected} got ${flow.actual}`:null,
      metrics:{diff:c.diffFractionNonDynamic??null,ssimMasked:c.ssimMasked??null,coverage:img?Math.round(regionCoverage(c.regions,img.width,img.height)*1e4)/1e4:null},
      chromeChanged:!!chrome.perStep?.[st.index]?.changed,chromeFraction:chrome.perStep?.[st.index]?.fraction??0,judge:null,
      pageState:r.pageState??null,emptyState:emptyStateOf(r.visibleText),errorState:errorStateOf(r.visibleText)};
    let res=classifyStepSignals(sig,thresholds);
    if(res.needsJudge&&judge&&paths[st.index].today){
      try{log(`judging narration for step ${st.index}`);sig.judge=await judge({title:script.title??script.name,stepNumber:st.index+1,stepCount:script.steps.length,action:st.action,targetName:st.target?.name??null,
        narration:st.narration,todayPath:paths[st.index].today,todayTitle:r.title??null,todayUrl:c.todayUrl??null,todayText:r.visibleText??null});}
      catch(e){sig.judge={error:String(e?.message||e).slice(0,200)};}
      res=classifyStepSignals(sig,thresholds);}
    steps.push({index:st.index,action:st.action,verdict:res.verdict,reasons:res.reasons,narration:st.narration??'',judge:sig.judge,metrics:sig.metrics,compareClass:sig.compareClass,
      chromeChanged:sig.chromeChanged,chromeFraction:sig.chromeFraction,target:sig.targetStatus?{status:sig.targetStatus,method:sig.targetMethod,deltaMax:sig.targetDeltaMax,recordedName:sig.targetName,todayName:sig.todayTargetName}:null,
      guard:sig.guardStatus,pageState:sig.pageState,emptyState:sig.emptyState,errorState:sig.errorState,prerequisiteUnverified:!!r.prerequisiteUnverified,evidence:{recorded:paths[st.index].recorded,today:paths[st.index].today,diff:c.diff?join(runDir,c.diff):null}});
  }
  const video=videoVerdict(steps);
  const report={schema:1,script:script.name,title:script.title??null,classifiedAt:new Date().toISOString(),thresholds,verdict:video.verdict,complete:video.complete,summary:video.summary,reasons:video.reasons,
    unverifiedSteps:video.unverifiedSteps,chrome:{available:chrome.available,reason:chrome.reason??null,cells:chrome.cells??null,bbox:chrome.bbox??null,perStep:chrome.perStep},
    captureStatus:run.status,mutationStop:run.mutationStop??null,steps,contactSheet:cmp.contactSheet?join(runDir,cmp.contactSheet):null};
  if(write)writeFileSync(join(runDir,'classify.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}

function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export async function main(args=process.argv.slice(2)){
  const runDir=arg(args,'--run'),scriptPath=arg(args,'--script'),recordingsDir=arg(args,'--recordings');
  if(!runDir||!scriptPath||!recordingsDir)throw new Error('usage: classify.mjs --run RUN_DIR --script SCRIPT.json --recordings RECORDING_DIR [--no-judge]');
  const script=JSON.parse(readFileSync(resolve(scriptPath),'utf8'));
  const r=await classifyRun({runDir:resolve(runDir),script,recordingsDir:resolve(recordingsDir),judge:args.includes('--no-judge')?null:makeClaudeJudge(),log:m=>console.error(m)});
  console.log(JSON.stringify({verdict:r.verdict,complete:r.complete,summary:r.summary,steps:r.steps.map(s=>({index:s.index,verdict:s.verdict,reasons:s.reasons.map(x=>`${x.verdict}:${x.code}`),judge:s.judge}))},null,2));return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
