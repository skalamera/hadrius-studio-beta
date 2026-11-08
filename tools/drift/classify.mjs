// Drift classification: per step and per video, decide what a drifted walkthrough needs.
//   unchanged | unchanged_with_data_drift | slide_update | moved_highlight | narration_review | full_rerecord
// unchanged_with_data_drift: only DATA differs (shared tenants: other people's rows/cards/records, counts, names,
// dates; an extra record carrying the recorded button name): the video stays accurate, nothing is posted.
// Inputs: compare.json + run.json (capture.mjs/compare.mjs output), the script, recorded + today's PNGs.
// Deterministic signals first (target resolution, SSIM/diff, changed-region coverage, persistent chrome
// such as the sidebar that appears on every slide, route/flow changes); narration accuracy is judged by
// the same `claude` CLI path the bridge uses (tools/coverage-scan.mjs runClaude) with a strict JSON verdict.
// Import-safe (no side effects). Never writes outside the run directory; never touches scripts/ or out/.
//
// CLI: node tools/drift/classify.mjs --run RUN_DIR --script SCRIPT.json --recordings RECORDING_DIR [--no-judge]
//   writes RUN_DIR/classify.json (must not exist) and prints the video verdict.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {decodePng,DEFAULT_THRESHOLDS as CMP,classifyStep as compareClassOf} from './compare.mjs';
import {disambiguateTarget,lumaPlane} from './disambiguate.mjs';
import {confirmsProductionUiCodeChange,releaseGate} from './release-evidence.mjs';

export const VERDICTS=Object.freeze(['unchanged','unchanged_with_data_drift','slide_update','moved_highlight','narration_review','full_rerecord']);
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
    const addDirs=[input?.todayPath&&dirname(resolve(input.todayPath))].filter(Boolean);
    const raw=await run(buildJudgePrompt(input),{allowedTools:'Read',addDirs,maxTurns:6,timeout:timeoutMs,model:cs.decisionModel(),onMeta:m=>Object.assign(meta,m)});
    return {...parseJudge(cs.extractJson(raw)),model:meta.model??null,costUsd:meta.costUsd??null};
  };
}

// ---------- per-step decision (pure) ----------
const pathOf=(u)=>{try{return new URL(u).pathname.replace(/\/+$/,'');}catch{return null;}};
/** sig -> {verdict|'unverified', reasons:[{code,detail}], needsJudge} ; judge may be null (not asked yet). */
export function classifyStepSignals(sig,T=THRESHOLDS){
  if(sig.prerequisiteUnverified)return {verdict:'unverified',reasons:[{verdict:'unverified',code:'prerequisite_unverified',detail:sig.prerequisiteReason??'a required earlier step did not establish the task state'}],needsJudge:false,needsRedesignJudge:false};
  const reasons=[];const add=(verdict,code,detail)=>reasons.push({verdict,code,detail});
  // Several elements carry the recorded name, but the recorded one was identified (disambiguate.mjs): not drift by
  // itself. Extra matches inside record rows/cards = data drift; matches already on screen when recorded = nothing.
  const d=sig.disambiguation;
  if(d?.status==='resolved'&&sig.targetStatus==='resolved'){
    const alts=(d.candidates||[]).filter(c=>c.index!==d.chosen);
    add('unchanged','target_disambiguated',`recorded target "${sig.targetName??'?'}" matches ${alts.length+1} elements today; the recorded one was identified by ${d.method} (${d.reason})`);
    if(d.preexisting)add('unchanged','ambiguity_preexisting',`the other match(es) were already on screen when the video was recorded`);
    else if(d.extraAreData)add('unchanged_with_data_drift','extra_record_matches',`${d.extraAlternatives} other record(s) with the same control are new since the recording (shared-tenant data: ${alts.filter(c=>c.presentInRecording===false).map(c=>JSON.stringify(String(c.recordLabel??'').slice(0,60))).join(', ')})`);
  }
  // Provisional only: a missing locator can mean absent shared data or an unreachable prerequisite, not removed UI.
  if(sig.targetStatus&&sig.targetStatus!=='resolved')add('full_rerecord',`target_${sig.targetStatus}`,`recorded ${sig.action} target "${sig.targetName??'?'}" ${sig.targetStatus==='ambiguous'?`is ambiguous today (${sig.targetMatches??'>1'} matches)`:'no longer exists today'}`);
  if(!sig.hasScreenshot){
    if(sig.targetStatus&&sig.targetStatus!=='resolved'&&!sig.routeChanged&&!sig.flowChanged)
      return {verdict:'unverified',reasons:[{verdict:'unverified',code:'target_unverified',detail:'target is missing or ambiguous, but no screenshot is available to verify whether this is UI drift or a data/state difference'}],needsJudge:false};
    if(reasons.length)return {verdict:'full_rerecord',reasons,needsJudge:false};
    if(sig.guardStatus==='needs_fixture')return {verdict:'unverified',reasons:[{verdict:'unverified',code:'needs_fixture',detail:sig.guardReason??'replay stopped before a data-changing step'}],needsJudge:false};
    return {verdict:'unverified',reasons:[{verdict:'unverified',code:'not_captured',detail:sig.error??'no screenshot'}],needsJudge:false};
  }
  // Environment/data gaps are not drift: a page that never finished loading, or a recorded record the
  // automation account cannot see (empty state where the target was), leaves the step unverified.
  if(sig.errorState)return {verdict:'unverified',reasons:[{verdict:'unverified',code:'page_error',detail:`page shows an error ("${sig.errorState}"): record likely not visible to the capture account`}],needsJudge:false};
  if(sig.pageState==='loading')return {verdict:'unverified',reasons:[{verdict:'unverified',code:'page_not_loaded',detail:'page still showed only a loading indicator (record may not be visible to the capture account)'},...reasons.filter(r=>r.verdict!=='full_rerecord')],needsJudge:false};
  const visual=sig.compareClass==='screenshot_changed'||sig.compareClass==='target_geometry_changed'||sig.compareClass==='target_missing';
  // Empty or zero-result pages are data/state, never redesign evidence: the slide stays unverified.
  if(sig.emptyState&&visual)return {verdict:'unverified',reasons:[{verdict:'unverified',code:'empty_state',detail:`page shows an empty state ("${sig.emptyState}"); missing or empty records are data, not a UI redesign`}],needsJudge:false,needsRedesignJudge:false};
  // Needs BOTH the DOM empty-state text and the judge's data_missing (Kanban columns say "up to date" even when
  // other columns hold the records), otherwise a missing target stays a re-record.
  if(sig.targetStatus&&(sig.targetStatus!=='resolved'||sig.targetMethod==='css')&&sig.emptyState&&sig.judge?.data_missing)
    return {verdict:'unverified',reasons:[{verdict:'unverified',code:'record_not_visible',detail:`recorded target "${sig.targetName??'?'}" not found and the page shows an empty state ("${sig.emptyState}"): the capture account likely cannot see this record`}],needsJudge:true};
  if(sig.targetMethod==='css'&&sig.targetStatus==='resolved')add('narration_review','target_renamed',`target found only by its CSS path; recorded name "${sig.targetName}" is now "${sig.todayTargetName}"`);
  if(sig.routeChanged)add('full_rerecord','route_changed',`page route changed: recorded ${sig.recordedPath} -> today ${sig.todayPath}`);
  if(sig.flowChanged)add('full_rerecord','flow_changed',sig.flowDetail??'the recorded click no longer leads to the next recorded page');
  if(!sig.dimensionsMatch&&sig.compareClass!=='unchanged')add('full_rerecord','viewport_changed','screenshot size differs from the recording');
  const m=sig.metrics||{};
  // UI-only metrics (data areas excluded) when the capture recorded today's data areas; else the full-frame ones.
  const ui=m.diffUi!=null?{ssim:m.ssimUi,coverage:m.coverageUi,diff:m.diffUi,label:' (data areas excluded)'}:{ssim:m.ssimMasked,coverage:m.coverage,diff:m.diff,label:''};
  if(visual&&sig.dimensionsMatch){
    const why=[];if(ui.ssim!=null&&ui.ssim<T.redesignSsim)why.push(`SSIM ${ui.ssim} < ${T.redesignSsim}`);
    if(ui.coverage!=null&&ui.coverage>T.redesignCoverage)why.push(`changed regions cover ${(ui.coverage*100).toFixed(1)}% > ${T.redesignCoverage*100}%`);
    if(ui.diff!=null&&ui.diff>T.redesignDiff)why.push(`changed pixels ${(ui.diff*100).toFixed(1)}% > ${T.redesignDiff*100}%`);
    if(why.length){
      const gate=releaseGate(sig.uiReleaseEvidence);
      if(!gate.ok)return {verdict:'unverified',reasons:[{verdict:'unverified',code:gate.code,detail:`screenshot threshold met (${why.join('; ')}); ${gate.detail}`}],needsJudge:false,needsRedesignJudge:!!gate.needsRedesignJudge};
      add('full_rerecord','page_redesigned',`${why.join('; ')}${ui.label}; ${gate.detail}`);
    }
  }
  // Data-only: every non-dynamic change lies inside today's data areas (rows, record cards, list bodies, counts).
  const dataOnly=!!sig.dataOnly&&sig.dimensionsMatch&&!sig.chromeChanged;
  // The record the step acts on is still there but moved because rows were added/removed: data, not a moved control
  // (disambiguation found the recorded record at another row and the other matches are new records = data). The rest
  // of the frame is then judged like any screenshot change.
  const movedWithData=sig.compareClass==='target_geometry_changed'&&sig.targetIsRecord&&(dataOnly||(d?.status==='resolved'&&d.extraAreData));
  if(movedWithData)add('unchanged_with_data_drift','target_moved_with_data',`target record moved by up to ${sig.targetDeltaMax}px because other records were added/removed (shared-tenant data)`);
  else if(sig.compareClass==='target_geometry_changed')add('moved_highlight','target_moved',`target moved/resized by up to ${sig.targetDeltaMax}px`);
  const frameChanged=sig.compareClass==='screenshot_changed'||(movedWithData&&((m.diff??0)>CMP.diffFraction||(m.ssimMasked!=null&&m.ssimMasked<CMP.ssim)));
  let needsRedesignJudge=false;
  if(frameChanged){
    if(dataOnly)add('unchanged_with_data_drift','data_only_change',`only data areas changed (${sig.dataChangedPixels??'?'} px in rows/records/counts); outside them diff ${((m.diffUi??0)*100).toFixed(2)}%, SSIM ${m.ssimUi}`);
    else{
      add('slide_update','screenshot_changed',`diff ${((ui.diff??0)*100).toFixed(2)}% non-dynamic${ui.label}, SSIM ${ui.ssim}`);
      // Below the redesign threshold a single renamed tab or button can still mislead: review it against the releases
      // too. Only a verified release change marks the slide ui_changed (the weekly path posts nothing else).
      if(!reasons.some(r=>r.code==='page_redesigned')){
        const gate=releaseGate(sig.uiReleaseEvidence);
        if(gate.ok)add('slide_update','ui_changed',`${gate.detail}`);
        else needsRedesignJudge=!!gate.needsRedesignJudge;
      }
    }
  }
  if(sig.chromeChanged){
    const gate=releaseGate(sig.uiReleaseEvidence,{chrome:true});
    if(gate.ok)add('slide_update','persistent_chrome_changed',`persistent chrome (sidebar/header seen on every slide) changed in ${(sig.chromeFraction*100).toFixed(0)}% of its cells; ${gate.detail}`);
    else if(!reasons.some(r=>r.code==='page_redesigned'||r.code==='ui_changed'))return {verdict:'unverified',reasons:[{verdict:'unverified',code:gate.code,detail:`persistent chrome differs; ${gate.detail}`}],needsJudge:false,needsRedesignJudge:!!gate.needsRedesignJudge};
  }
  const needsJudge=visual&&!(dataOnly&&!reasons.some(r=>RANK[r.verdict]>RANK.unchanged_with_data_drift))&&!!(sig.narration&&sig.narration.trim());
  if(needsJudge){const j=sig.judge;
    if(!j)add('narration_review','narration_unchecked','screenshot changed; narration accuracy not checked');
    else if(j.skipped)add('narration_review','narration_unchecked',`narration not checked: ${j.skipped}`);
    else if(j.error)add('narration_review','narration_unchecked',`narration judge unavailable: ${j.error}`);
    // Missing data is a hard block: same-step pixel/target signals cannot be trusted as UI drift.
    else if(j.data_missing)return {verdict:'unverified',reasons:[{verdict:'unverified',code:sig.targetStatus==='missing'?'record_not_visible':'data_missing',detail:j.reason}],needsJudge};
    else if(!j.accurate&&j.claim_missing)add('full_rerecord','narration_contradicted',j.reason);
    else if(!j.accurate)add('narration_review','narration_inaccurate',j.reason);
  }
  const targetUnresolved=sig.targetStatus&&sig.targetStatus!=='resolved';
  const targetConfirmedMissing=sig.judge&&!sig.judge.error&&!sig.judge.data_missing&&sig.judge.claim_missing===true;
  // Keep an unresolved target as a full re-record only with independent claim/route/flow evidence.
  if(targetUnresolved&&!targetConfirmedMissing&&!sig.routeChanged&&!sig.flowChanged)
    return {verdict:'unverified',reasons:[{verdict:'unverified',code:'target_unverified',detail:`recorded target "${sig.targetName??'?'}" is not resolved today and the evidence does not confirm that the UI control itself was removed`}],needsJudge};
  return {verdict:worst(reasons.map(r=>r.verdict)),reasons,needsJudge,needsRedesignJudge};
}

/** Video verdict = worst step, plus the mixed-old/new-UI rule. */
export function videoVerdict(steps){
  const verified=steps.filter(s=>s.verdict!=='unverified');const unverified=steps.filter(s=>s.verdict==='unverified');
  let verdict=worst(verified.map(s=>s.verdict));const reasons=[];
  for(const s of steps)for(const r of s.reasons)if(r.verdict===verdict&&verdict!=='unchanged')reasons.push({step:s.index,...r});
  const chromeSteps=verified.filter(s=>s.chromeChanged&&confirmsProductionUiCodeChange(s.uiReleaseEvidence,{chrome:true})).map(s=>s.index);
  const kept=verified.filter(s=>s.verdict==='unchanged'||s.verdict==='unchanged_with_data_drift').map(s=>s.index);
  if(chromeSteps.length&&kept.length&&verdict!=='full_rerecord'){
    reasons.unshift({step:null,verdict:'full_rerecord',code:'mixed_old_new_ui',detail:`persistent chrome (sidebar/header) changed on slide(s) ${chromeSteps.map(i=>i+1).join(', ')}; slide(s) ${kept.map(i=>i+1).join(', ')} cannot be updated (unchanged or unverified), so a partial update would mix old and new UI`});
    verdict='full_rerecord';
  }else if(chromeSteps.length&&kept.length)reasons.push({step:null,verdict:'full_rerecord',code:'mixed_old_new_ui',detail:`persistent chrome changed on slide(s) ${chromeSteps.map(i=>i+1).join(', ')}; slide(s) ${kept.map(i=>i+1).join(', ')} would keep the old UI`});
  const complete=unverified.length===0;
  const label={unchanged:'No visible drift',unchanged_with_data_drift:'No UI drift; only shared-tenant data differs (rows/records/counts)',slide_update:'Screenshots changed; narration still accurate: slide update',moved_highlight:'Click target moved: re-plan highlight',narration_review:'Screenshot changed and narration may be inaccurate: human narration review',full_rerecord:'Needs a FULL RE-RECORD'}[verdict];
  const top=reasons.slice(0,6).map(r=>`${r.step==null?'video':`slide ${r.step+1}`}: ${r.code} (${r.detail})`);
  const summary=`${label}.${top.length?' '+top.join('; ')+'.':''}${complete?'':` ${unverified.length} step(s) not verified (${[...new Set(unverified.flatMap(s=>s.reasons.map(r=>r.code)))].join(', ')}).`}`;
  return {verdict,complete,reasons,summary,unverifiedSteps:unverified.map(s=>s.index),chromeChangedSteps:chromeSteps};
}

export const EMPTY_STATE_RE=/(you(?:'|’| a)re up to date|all projects are archived|no (?:projects|results|items|records|documents|data|flags)(?: found| yet)?\b|nothing (?:here|to show)|you don't have access|not authori[sz]ed|access denied|page not found|\b0 of 0(?: results)?\b|showing 0 (?:results|items|records)\b|\b0 results\b|no matching (?:results|records|items)\b|\bno [a-z]+(?: [a-z]+)? (?:found|yet)\b)/i;
export const ERROR_STATE_RE=/(couldn['’]t load (?:this|the) [a-z ]{2,30}|[a-z ]{2,30} not found\b|failed to load|something went wrong|you don['’]t have (?:access|permission)|access denied|page not found|\b404\b)/i;
// Page-wide innerText includes Ask Hadrius suggestions such as “Who has no login yet?” or
// “Which documents were not found?”. Questions are not state assertions. Ignore that assistant
// section and interrogative lines before looking for a real empty/error message in the page.
const stateLines = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  .reduce((out, line) => {
    if (/^(?:SUGGESTED FOR THIS PAGE|Ask about .+)$/i.test(line)) out.assistant = true;
    if (!out.assistant && !/[?？]/.test(line) && !/^(?:who|what|which|where|when|why|how|can|could|do|does|is|are|show me|find)\b/i.test(line)) out.lines.push(line);
    return out;
  }, { assistant: false, lines: [] }).lines;
export const errorStateOf = text => {
  for (const line of stateLines(text)) { const match = ERROR_STATE_RE.exec(line); if (match) return match[1].trim(); }
  return null;
};
export const emptyStateOf = text => {
  for (const line of stateLines(text)) { const match = EMPTY_STATE_RE.exec(line); if (match) return match[1]; }
  return null;
};
// ---------- run-level ----------
// narrationScope 'ui_confirmed' (weekly): ask the narration judge only on slides with a release-confirmed interface
// change, the only slides the weekly scan can act on. 'all' keeps the full narration audit.
const UI_CONFIRMED_CODES=new Set(['page_redesigned','ui_changed','persistent_chrome_changed']);
export async function classifyRun({runDir,script,recordingsDir,judge=null,thresholds=THRESHOLDS,releaseEvidence=null,redesignJudge=null,log=()=>{},write=true,narrationScope='all'}){
  const run=JSON.parse(readFileSync(join(runDir,'run.json'),'utf8'));const cmp=JSON.parse(readFileSync(join(runDir,'compare.json'),'utf8'));
  const byIdx=new Map(run.steps.map(s=>[s.index,s]));const cmpBy=new Map(cmp.steps.map(s=>[s.index,s]));
  const recorded=[],today=new Map(),paths={};
  for(const st of script.steps){const c=cmpBy.get(st.index);let rimg=null;
    if(st.media?.pre&&existsSync(join(recordingsDir,st.media.pre))){try{rimg=decodePng(readFileSync(join(recordingsDir,st.media.pre)));}catch{}}
    recorded.push({index:st.index,img:rimg,route:pathOf(st.url)});
    if(c?.todayScreenshot){try{today.set(st.index,decodePng(readFileSync(join(runDir,c.todayScreenshot))));}catch{}}
    paths[st.index]={recorded:st.media?.pre?join(recordingsDir,st.media.pre):null,today:c?.todayScreenshot?join(runDir,c.todayScreenshot):null};}
  const chrome=chromeAnalysis(recorded,today,thresholds);
  const findings=run.findings??[];const steps=[],deferred=[];
  const recImgs=new Map(recorded.map(r=>[r.index,r.img]));
  for(const st of script.steps){
    const c=cmpBy.get(st.index)??{};const r=byIdx.get(st.index)??{};const img=today.get(st.index);
    // Ambiguous target in a run captured before capture-time disambiguation (or without the recording): identify the
    // recorded element offline from the recorded + today frames. The capture never clicked it, so later steps keep
    // whatever the capture saw; only this step's ambiguity verdict changes.
    let tgt=r.target??null,disamb=tgt?.disambiguation??null,compareClass=c.classification??'not_captured';
    // Only NAME matches are disambiguated: CSS-only matches mean the recorded name is gone (stays a finding).
    if(tgt?.status==='ambiguous'&&!['css','status_counter'].includes(tgt.method)&&(tgt.matches?.length??0)>1&&img&&recImgs.get(st.index)){
      const t=st.target??{};
      disamb=disambiguateTarget({matches:tgt.matches,recordedRect:tgt.recordedRect??t.hint?.bbox??t.bbox??null,recordedViewport:t.hint?.viewport??t.viewport??null,todayViewport:{w:img.width,h:img.height},
        recorded:lumaPlane(recImgs.get(st.index)),today:lumaPlane(img)});
      if(disamb?.status==='resolved'){const ch=tgt.matches[disamb.chosen];const delta=tgt.recordedRect&&ch?.bbox?{dx:ch.bbox.x-tgt.recordedRect.x,dy:ch.bbox.y-tgt.recordedRect.y,dw:ch.bbox.w-tgt.recordedRect.w,dh:ch.bbox.h-tgt.recordedRect.h}:null;
        if(delta)delta.max=Math.max(...Object.values(delta).map(Math.abs));
        tgt={...tgt,status:'resolved',resolved:ch,rect:ch?.bbox??null,delta,disambiguation:disamb,offlineDisambiguation:true};
        if(c.todayScreenshot&&compareClass==='target_missing')compareClass=compareClassOf({dimensionsMatch:c.dimensions?.match!==false,diffFractionNonDynamic:c.diffFractionNonDynamic??0,ssimMasked:c.ssimMasked??null,target:{status:'resolved',delta}});}
    }
    const flow=findings.find(f=>f.step===st.index&&/click_destination_differs|click_navigated_unexpectedly/.test(f.kind));
    const recPath=pathOf(st.url),todayPath=pathOf(c.todayUrl??r.todayUrl);
    const sig={index:st.index,action:st.action,narration:st.narration??'',hasScreenshot:!!(c.todayScreenshot&&c.classification!=='not_captured'&&c.classification!=='needs_fixture'),
      compareClass,dimensionsMatch:c.dimensions?.match!==false,guardStatus:r.mutationGuard?.status??null,guardReason:r.mutationGuard?.reason??null,error:r.error??c.reason??null,
      prerequisiteUnverified:!!r.prerequisiteUnverified,prerequisiteReason:r.readGuard?.reason??r.prerequisiteFailure?.reason??null,
      targetStatus:tgt?.status??null,targetMethod:tgt?.method??null,targetName:st.target?.name??null,todayTargetName:tgt?.resolved?.name??null,targetMatches:tgt?.matches?.length??null,targetDeltaMax:tgt?.delta?.max??null,
      disambiguation:disamb,targetIsRecord:!!(tgt?.resolved?.recordHint&&(tgt.resolved.recordHint.id||tgt.resolved.recordHint.label)),
      dataOnly:!!c.dataOnly,dataChangedPixels:c.dataChangedPixels??null,
      routeChanged:!!(recPath&&todayPath&&recPath!==todayPath),recordedPath:recPath,todayPath,flowChanged:!!flow,flowDetail:flow?`${flow.kind}: expected ${flow.expected} got ${flow.actual}`:null,
      metrics:{diff:c.diffFractionNonDynamic??null,ssimMasked:c.ssimMasked??null,coverage:img?Math.round(regionCoverage(c.regions,img.width,img.height)*1e4)/1e4:null,
        ...(c.diffFractionUi!=null?{diffUi:c.diffFractionUi,ssimUi:c.ssimUi??null,coverageUi:img?Math.round(regionCoverage((c.regions||[]).filter(x=>!x.data),img.width,img.height)*1e4)/1e4:null,dataChangedPixels:c.dataChangedPixels??0}:{})},
      chromeChanged:!!chrome.perStep?.[st.index]?.changed,chromeFraction:chrome.perStep?.[st.index]?.fraction??0,judge:null,
      uiReleaseEvidence:releaseEvidence?.byStep?.[st.index]??releaseEvidence?.byStep?.[String(st.index)]??null,
      pageState:r.pageState??null,emptyState:emptyStateOf(r.visibleText),errorState:errorStateOf(r.visibleText)};
    let res=classifyStepSignals(sig,thresholds);
    if(res.needsRedesignJudge&&redesignJudge&&paths[st.index].today&&paths[st.index].recorded){
      const {reviewRedesign}=await import('./redesign-judge.mjs');
      sig.uiReleaseEvidence=await reviewRedesign({redesignJudge,releaseEvidence,evidence:sig.uiReleaseEvidence,script,step:st,paths:paths[st.index],todayText:r.visibleText??'',
        todayRects:{dynamicRects:r.dynamicRects??[],dataRects:r.dataRects??[]},log});
      res=classifyStepSignals(sig,thresholds);}
    if(res.needsJudge&&judge&&paths[st.index].today&&narrationScope!=='all'&&!res.reasons.some(r=>UI_CONFIRMED_CODES.has(r.code))){
      sig.judge={skipped:'no release-confirmed interface change on this slide (outside the weekly scope)'};res=classifyStepSignals(sig,thresholds);
      deferred.push({sig,st,r,c,recPath});}
    else if(res.needsJudge&&judge&&paths[st.index].today){
      try{log(`judging narration for step ${st.index}`);sig.judge=await judge({title:script.title??script.name,stepNumber:st.index+1,stepCount:script.steps.length,action:st.action,targetName:st.target?.name??null,
        narration:st.narration,todayPath:paths[st.index].today,todayTitle:r.title??null,todayUrl:c.todayUrl??null,todayText:r.visibleText??null});}
      catch(e){sig.judge={error:String(e?.message||e).slice(0,200)};}
      res=classifyStepSignals(sig,thresholds);}
    steps.push({index:st.index,action:st.action,verdict:res.verdict,reasons:res.reasons,narration:st.narration??'',judge:sig.judge,metrics:sig.metrics,compareClass:sig.compareClass,
      chromeChanged:sig.chromeChanged,chromeFraction:sig.chromeFraction,uiReleaseEvidence:sig.uiReleaseEvidence,target:sig.targetStatus?{status:sig.targetStatus,method:sig.targetMethod,deltaMax:sig.targetDeltaMax,recordedName:sig.targetName,todayName:sig.todayTargetName,
        ...(disamb?{matches:sig.targetMatches,disambiguation:disamb,offline:!!tgt?.offlineDisambiguation}:{})}:null,dataOnly:sig.dataOnly,
      guard:sig.guardStatus,pageState:sig.pageState,emptyState:sig.emptyState,errorState:sig.errorState,prerequisiteUnverified:!!r.prerequisiteUnverified,evidence:{recorded:paths[st.index].recorded,today:paths[st.index].today,diff:c.diff?join(runDir,c.diff):null}});
  }
  // Weekly scope, second pass: a slide on the same page as a release-confirmed change may be replaced along with it
  // (repairability: kept slide showing the same verified change), and a replaced slide needs a positive narration
  // check. So deferred slides on a confirmed page are judged too; slides on other pages stay out of scope.
  if(judge&&narrationScope!=='all'&&deferred.length){
    const confirmedPaths=new Set(steps.filter(s=>s.reasons.some(x=>UI_CONFIRMED_CODES.has(x.code))).map(s=>pathOf(script.steps.find(x=>x.index===s.index)?.url)).filter(Boolean));
    for(const d of deferred){if(!d.recPath||!confirmedPaths.has(d.recPath))continue;const {sig,st,r,c}=d;
      try{log(`judging narration for step ${st.index} (same page as a confirmed change)`);sig.judge=await judge({title:script.title??script.name,stepNumber:st.index+1,stepCount:script.steps.length,action:st.action,targetName:st.target?.name??null,
        narration:st.narration,todayPath:paths[st.index].today,todayTitle:r.title??null,todayUrl:c.todayUrl??null,todayText:r.visibleText??null});}
      catch(e){sig.judge={error:String(e?.message||e).slice(0,200)};}
      const res=classifyStepSignals(sig,thresholds),out=steps.find(s=>s.index===st.index);Object.assign(out,{verdict:res.verdict,reasons:res.reasons,judge:sig.judge});}
  }
  const video=videoVerdict(steps);
  const report={schema:1,script:script.name,title:script.title??null,classifiedAt:new Date().toISOString(),thresholds,verdict:video.verdict,complete:video.complete,summary:video.summary,reasons:video.reasons,
    unverifiedSteps:video.unverifiedSteps,chrome:{available:chrome.available,reason:chrome.reason??null,cells:chrome.cells??null,bbox:chrome.bbox??null,perStep:chrome.perStep},
    captureStatus:run.status,mutationStop:run.mutationStop??null,releaseEvidence:releaseEvidence?.summary??{status:'unavailable'},steps,contactSheet:cmp.contactSheet?join(runDir,cmp.contactSheet):null};
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
