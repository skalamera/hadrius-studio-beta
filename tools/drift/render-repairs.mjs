// LOCAL ONLY: finalized repair candidate -> unchanged-image control -> scoped renderer -> preservation report.
// No bridge/jobs client, publishing, fixture writes or scheduler. Proof-approved narration is opt-in.
import fs from 'node:fs';
import os from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest,requireValue} from './contracts.mjs';
import {validatePng} from './candidate.mjs';
import {prepareSubmissions} from './weekly-submit.mjs';
import {verifySemanticRepairAssets} from './semantic-repair-assets.mjs';
import {verifyFlowEquivalenceAssets} from './flow-equivalence-assets.mjs';
import {resolveInputs,buildChangeManifest,defaultRender,readPyJson,checkVerification,runProcess} from './executor.mjs';
import {sha256File} from './publish.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const sameSet=(a,b)=>a.length===new Set(a).size&&b.length===new Set(b).size&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());

export function readLocalStage(output,dry=false){
  // The Python updater deliberately emits plan.json, NOT verification.json, for --dry-run.
  const verification=readPyJson(join(output,dry?'plan.json':'verification.json'));
  requireValue(verification.ok===true&&(dry?verification.dry_run===true:!verification.dry_run),'render_not_verified');
  return verification;
}

export async function detectLocalCaptionLayout({baseline,inputs,out,repo=REPO,log=console.log}){
  const manifest=read(join(baseline,'baseline-manifest.json')),output=join(out,'caption-layout');
  const args=['-B','-m','renderer.caption_layout','--assembly',join(baseline,manifest.assembly.file),'--build-dir',inputs.buildDir,
    ...(inputs.reportPath?['--report',inputs.reportPath]:[]),'--output',output];
  const result=await runProcess(join(repo,'.venv/bin/python'),args,{cwd:repo,timeoutMs:120000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',TMPDIR:join(os.homedir(),'.hermes/cache/scratch')},log});
  requireValue(result.code===0,'caption_layout_not_reproduced');
  const report=read(join(output,'caption-layout.json'));
  requireValue(report.ok===true&&['basic','raqm'].includes(report.font_layout),'caption_layout_not_reproduced');
  log(`[local-repair] caption layout verified: ${report.font_layout} (${report.captions} saved caption images)`);
  return report.font_layout;
}

export function validateLocalRenderCandidate({original,identified,candidateManifest,approvedIndices}) {
  requireValue(original?.name===identified?.name&&Array.isArray(original.steps)&&original.steps.length===identified.steps?.length,'identified_script_conflict');
  const stripped=structuredClone(identified);
  if(!Object.hasOwn(original,'id'))delete stripped.id;
  stripped.steps.forEach((s,i)=>{if(!Object.hasOwn(original.steps[i],'id'))delete s.id;});
  requireValue(digest(stripped)===digest(original),'identified_script_conflict');
  requireValue(identified.steps.every((s,i)=>(s.index??i)===i&&typeof s.id==='string'&&s.id.length),'invalid_step_mapping');
  requireValue(new Set(identified.steps.map(s=>s.id)).size===identified.steps.length,'duplicate_step_id');
  requireValue(candidateManifest?.baseHash===digest(identified),'candidate_base_conflict');
  requireValue(Array.isArray(candidateManifest.structuralChanges)&&candidateManifest.structuralChanges.length===0,'unsupported_structural_change');
  requireValue(Array.isArray(candidateManifest.changes)&&approvedIndices.every(i=>Number.isInteger(i)&&identified.steps[i]),'invalid_repair_scope');
  const ids=approvedIndices.map(i=>identified.steps[i].id);
  requireValue(sameSet(ids,candidateManifest.changes.map(c=>c.stepId)),'candidate_scope_conflict');
  for(const c of candidateManifest.changes){
    requireValue(Object.keys(c).every(k=>['stepId','beforeHash','imagePath','sha256','target','dpr'].includes(k)),'unsupported_candidate_change');
    const st=identified.steps.find(s=>s.id===c.stepId);
    requireValue(c.beforeHash===digest(st),'candidate_step_conflict');
    requireValue(typeof c.imagePath==='string'&&isAbsolute(c.imagePath)&&/^[a-f0-9]{64}$/.test(c.sha256),'unbound_screenshot');
  }
  return true;
}

function checkNarrationTranscript(reportPath,{verification,candidate,sha256,verificationSha256}){
  requireValue(typeof reportPath==='string'&&isAbsolute(reportPath),'transcript_report_required');
  const tr=read(reportPath);
  requireValue(tr.schema===1&&tr.kind==='automatic-narration-transcript'&&tr.ok===true&&tr.transcript?.ok===true
    &&tr.source_unchanged===true,'transcript_not_verified');
  requireValue(tr.candidate===candidate&&tr.candidate_sha256===sha256&&tr.verification===verification
    &&tr.verification_sha256===verificationSha256,'transcript_artifact_conflict');
  requireValue(sha256File(candidate)===sha256&&sha256File(verification)===verificationSha256,'transcript_sources_changed');
  return tr;
}

/** Offline ASR only, on the delivered candidate. Injection never bypasses artifact readback. */
export async function transcribeLocalNarration({verification,baseline,out,repo=REPO,log=console.log,run=runProcess}){
  const v=readPyJson(verification),manifest=join(baseline,'baseline-manifest.json'),bm=read(manifest);
  requireValue(v.ok===true&&!v.dry_run&&!v.noop&&v.source_unchanged===true&&v.audio?.ok===true,'completed_narration_repair_required');
  const paths=[verification,v.candidate,v.candidate_assembly,manifest,join(baseline,bm.assembly.file),join(baseline,bm.final.file)];
  const before=Object.fromEntries(paths.map(p=>[p,sha256File(p)]));
  requireValue(before[v.candidate]===v.candidate_sha256,'transcript_source_hash_conflict');
  const output=join(out,'transcript');requireValue(!fs.existsSync(output),'new_transcript_output_required');
  const result=await run(join(repo,'.venv/bin/python'),['-B','-m','renderer.drift_qa','--verification',verification,'--baseline',baseline,'--output',output],
    {cwd:repo,timeoutMs:20*60_000,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TMPDIR:join(os.homedir(),'.hermes/cache/scratch')},log});
  requireValue(result.code===0&&!result.timedOut,'transcription_failed');
  const reportPath=join(output,'transcript-report.json'),tr=checkNarrationTranscript(reportPath,
    {verification,candidate:v.candidate,sha256:v.candidate_sha256,verificationSha256:before[verification]});
  requireValue(paths.every(p=>sha256File(p)===before[p]&&tr.source_snapshot?.[p]===before[p]),'transcript_sources_changed');
  return reportPath;
}

export async function renderPreparedRepair({preparationDir,name,rebaselineDir,outDir,repo=REPO,baselineInputs=null,allowNarration=false,prepareOnly=false,fontLayout='auto',detectLayout=detectLocalCaptionLayout,render=defaultRender,transcribeNarration=transcribeLocalNarration,log=console.log}) {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name??''),'invalid_script_name');
  requireValue(['auto','basic','raqm'].includes(fontLayout),'invalid_font_layout');
  const source=resolve(preparationDir),baseline=resolve(rebaselineDir),out=resolve(outDir);
  const summary=read(join(source,'summary.json'));
  const io={readJson:p=>{try{return read(p)}catch{return null}},readScript:n=>{try{return read(join(repo,'scripts',n+'.script.json'))}catch{return null}},readAssembly:()=>null};
  // Recompute FULL-batch selection under current policies; a cached candidate-ready flag cannot authorize this render.
  const rows=prepareSubmissions({summary,runDir:source,names:[name],io,requireCertifiedPreview:false}); // eligibility, not posting
  const row=rows.find(r=>r.name===name);
  requireValue(row?.decision==='post'&&row.kind==='auto_update','finalized_automatic_candidate_required');
  const job=read(join(source,name,'job.json'));
  const indices=row.payload.details.changes.map(c=>c.index);
  for(const st of job.steps??[])if(indices.includes(st.index)&&st.flowEquivalence)verifyFlowEquivalenceAssets(st,{name,scriptStep:io.readScript(name)?.steps?.find((s,i)=>(s.index??i)===st.index)});
  for(const st of job.steps??[])if(indices.includes(st.index)&&st.semanticRepair)verifySemanticRepairAssets(st);
  const narrationChanges=row.payload.details.changes.filter(c=>c.newNarration!=null||(c.changeTypes??[]).includes('narration'));
  requireValue(allowNarration||!narrationChanges.length,'local_visual_runner_rejects_narration');
  for(const change of narrationChanges){
    const step=job.steps.find(s=>s.index===change.index),review=step?.semanticRepair;
    requireValue(review?.review?.narration?.status==='rewrite'&&review.review.narration.suggestedNarration===change.newNarration
      &&review.verification?.narration?.text===change.newNarration&&review.verification.narration.preservesIntent===true,'independently_verified_narration_required');
  }
  const snapshotInputs=Object.fromEntries(['buildDir','reportPath','recordingsDir'].filter(key=>typeof baselineInputs?.[key]==='string').map(key=>[key,baselineInputs[key]]));
  for(const path of Object.values(snapshotInputs)){const rel=relative(baseline,resolve(path));requireValue(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'baseline_snapshot_path_conflict');}
  const payload={...row.payload,details:{...row.payload.details,execution:{...row.payload.details.execution,...snapshotInputs,rebaselineDir:baseline}}};
  const inputs=resolveInputs(payload,{repo});
  const cm=read(inputs.candidateManifest);
  validateLocalRenderCandidate({original:io.readScript(name),identified:inputs.script,candidateManifest:cm,approvedIndices:indices});
  const bv=readPyJson(join(baseline,'verification.json')),manifestPath=join(baseline,'baseline-manifest.json'),bm=read(manifestPath);
  requireValue(bv.ok===true&&bv.source_unchanged===true&&bv.manifest_sha256===sha256File(manifestPath),'verified_rebaseline_required');
  requireValue(bm.final.sha256===bv.final_sha256&&sha256File(join(baseline,bm.final.file))===bm.final.sha256,'baseline_media_conflict');
  const changeManifest=buildChangeManifest(payload,inputs,sha256File(manifestPath));
  requireValue(sameSet(changeManifest.changes.map(c=>c.stepId),cm.changes.map(c=>c.stepId)),'renderer_scope_conflict');
  for(const c of changeManifest.changes){requireValue(allowNarration||!c.narration,'local_visual_runner_rejects_narration');validatePng(fs.readFileSync(c.screenshot.path));}
  const control={baselineManifestHash:changeManifest.baselineManifestHash,changes:changeManifest.changes.map(c=>{
    const st=inputs.script.steps.find(s=>s.id===c.stepId),path=join(inputs.recordingsDir,st.media.pre);
    const old={stepId:c.stepId,screenshot:{path,sha256:sha256File(path)}};
    if(Object.hasOwn(c,'target'))old.target=st.target??null;
    if(Object.hasOwn(c,'dpr'))old.dpr=st.dpr;
    return old;
  })};
  const scratch=fs.realpathSync(join(os.homedir(),'.hermes/cache/scratch')),parent=fs.realpathSync(dirname(out)),rel=relative(scratch,parent);
  requireValue((rel===''||(!rel.startsWith('..')&&!isAbsolute(rel)))&&!fs.existsSync(out),'new_scratch_output_required');
  fs.mkdirSync(out,{mode:0o700});
  const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
  const changed=join(out,'repair.changes.json'),golden=join(out,'control.changes.json');
  write(changed,changeManifest);write(golden,control);
  const chosenLayout=fontLayout==='auto'?await detectLayout({baseline,inputs,out,repo,log}):fontLayout;
  requireValue(['basic','raqm'].includes(chosenLayout),'invalid_font_layout');
  const args=(changes,output,dry=false)=>['--rebaseline-dir',baseline,'--script',inputs.identifiedScript,'--recordings-dir',inputs.recordingsDir,
    '--changes',changes,'--build-dir',inputs.buildDir,...(inputs.reportPath?['--report',inputs.reportPath]:[]),'--font-layout',chosenLayout,'--take-mode',
    changes===changed&&narrationChanges.length?'elevenlabs':'manifest',...(dry?['--dry-run']:[]),'--output',output];
  const run=async(changes,dir,dry=false)=>{
    const output=join(out,dir);log(`[local-repair] ${name}: ${dir}`);
    await render({args:args(changes,output,dry),log});
    const verification=readLocalStage(output,dry);
    return {output,verification};
  };
  await run(golden,'control-preflight',true);await run(changed,'repair-preflight',true);
  if(prepareOnly){const result={schema:1,name,status:'preflight_verified',rendered:false,posts:0,uploads:0,fontLayout:chosenLayout,changes:changed,control:golden};write(join(out,'local-repair.json'),result);return result;}
  const goldenResult=await run(golden,'control');
  requireValue(goldenResult.verification.candidate_sha256===bm.final.sha256,'control_not_baseline_identical');
  requireValue(sha256File(goldenResult.verification.candidate)===bm.final.sha256,'control_media_conflict');
  const repaired=await run(changed,'repair'),verified=checkVerification(repaired.output);
  requireValue(verified.v.source_unchanged===true,'source_preservation_not_verified');
  let transcriptReport;
  if(narrationChanges.length){
    const verificationSha256=sha256File(verified.file);
    transcriptReport=await transcribeNarration({verification:verified.file,baseline,out,repo,log});
    checkNarrationTranscript(transcriptReport,{verification:verified.file,candidate:verified.candidate,sha256:verified.sha256,verificationSha256});
  }
  const result={schema:1,name,status:'local_render_preservation_verified',rendered:true,posts:0,uploads:0,
    candidate:verified.candidate,sha256:verified.sha256,verification:verified.file,controlSha256:bm.final.sha256,
    changedIndices:indices,dirtySlides:verified.dirtySlides,framesPreservedPct:verified.framesPreservedPct,
    oldDurationSec:verified.oldDurationSec,newDurationSec:verified.newDurationSec,elevenLabsChars:verified.elevenLabsChars,
    pictureAndAudioInspection:'pending',baselineReencodeDisclosed:true,fontLayout:chosenLayout,
    narrationChanged:narrationChanges.length>0,narrationIndices:narrationChanges.map(c=>c.index),...(transcriptReport?{transcriptReport}:{})};
  write(join(out,'local-repair.json'),result);return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1];
  for(const flag of ['--preparation','--name','--baseline','--out'])requireValue(a.includes(flag)&&get(flag)&&!get(flag).startsWith('--'),'missing '+flag);
  renderPreparedRepair({preparationDir:get('--preparation'),name:get('--name'),rebaselineDir:get('--baseline'),outDir:get('--out'),prepareOnly:a.includes('--prepare-only'),fontLayout:a.includes('--font-layout')?get('--font-layout'):'auto'})
    .then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.stack);process.exitCode=1;});
}
