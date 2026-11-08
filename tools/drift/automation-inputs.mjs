// Durable, local-only inputs for weekly automation. No candidate, model, browser, or service imports.
// The caller owns the weekly slot lock. A new sibling staging directory is atomically published;
// completed artifacts are read-only. Never attach proofs to these files: use a separate working copy.
import {readFile,writeFile,mkdir,lstat,rename,rm,chmod,readdir,realpath} from 'node:fs/promises';
import {join,resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,bytesDigest,canonical} from './contracts.mjs';
import {selectWeeklyJobs,selectionMarker} from './ui-selection.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const MANIFEST='automation-inputs.json';
const ORIGIN='weekly_release_verified_no_per_run_human_approval';
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const plain=value=>JSON.parse(JSON.stringify(value));
const inside=(root,path)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('../')&&rel!=='..'&&!isAbsolute(rel));};
const fail=(code,path='')=>{throw new Error(code+(path?':'+path:''));};
const nameOK=n=>typeof n==='string'&&n.length>0&&!['.','..','scripts'].includes(n)&&!/[\\/\0]/.test(n);
async function stat(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function regularBytes(path){const s=await stat(path);if(!s)return null;if(!s.isFile())fail('automation_input_not_regular',path);return readFile(path);}
function indexed(steps,label){
  if(!Array.isArray(steps))fail(label+'_missing_steps');
  const map=new Map();for(const step of steps){
    const index=step.index;if(!Number.isSafeInteger(index)||index<0||map.has(index))fail(label+'_invalid_index');map.set(index,step);
  }return map;
}
function claims(selection){
  if(!selection?.review||!Array.isArray(selection.names))fail('invalid_selection');
  const groups={};for(const group of ['flagged','newControlsOnly','frameOnly']){
    if(!Array.isArray(selection.review[group]))fail('invalid_selection');
    groups[group]=selection.review[group].map(v=>({name:v.name,slides:v.slides.map(s=>({index:s.index,changes:s.changes})).sort((a,b)=>a.index-b.index)})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  return {names:selection.names.slice().sort(),...groups,frameChanges:selection.review.frameChanges.slice().sort()};
}
function assertClaims(a,b){if(canonical(claims(a))!==canonical(claims(b)))fail('selection_claims_changed');}
const pairs=selection=>selection.review.flagged.flatMap(v=>v.slides.map(s=>`${v.name}#${s.index}`)).sort();
async function sourceUnchanged(inputs){
  for(const input of inputs){const bytes=await regularBytes(input.path);if((bytes===null?null:bytesDigest(bytes))!==input.sha256)fail('automation_input_source_changed',input.path);}
}
async function verifyFiles(manifest,root){
  const seen=new Set();for(const file of manifest.files){
    if(typeof file.relativePath!=='string'||!file.relativePath||!inside(root,resolve(root,file.relativePath))||seen.has(file.relativePath))fail('invalid_automation_input_manifest');
    seen.add(file.relativePath);const path=resolve(root,file.relativePath),bytes=await regularBytes(path);
    if(bytes===null||bytes.length!==file.size||bytesDigest(bytes)!==file.sha256)fail('automation_input_archive_changed',path);
  }
  for(const missing of manifest.missing)if(missing.relativePath&&await stat(resolve(root,missing.relativePath)))fail('automation_input_archive_changed',missing.relativePath);
}

/** Verify every archived byte; by default also reject changed/disappeared ORIGINAL sources.
 * After intentional source pruning, use {verifySources:false}: archive files remain fully checked.
 */
export async function verifyAutomationInputs(manifestPath,{verifySources=true}={}){
  const path=resolve(manifestPath),manifest=JSON.parse(await readFile(path,'utf8'));
  if(manifest.schema!==1||manifest.kind!=='weekly_automation_inputs'||manifest.ready!==true||!Array.isArray(manifest.files)||!Array.isArray(manifest.inputs)||!Array.isArray(manifest.missing))fail('automation_inputs_not_ready');
  const {manifestDigest,...body}=manifest;if(digest(body)!==manifestDigest)fail('automation_input_manifest_changed');
  await verifyFiles(manifest,dirname(path));if(verifySources)await sourceUnchanged(manifest.inputs);return manifest;
}

/**
 * Archive the ENTIRE batch before semantic review, preserving the exact release-selected claims.
 * jobs/summary are JSON objects; selection is the real selectWeeklyJobs() result (optional).
 * summary.videos[].job or summary.outDir locates original job files. If neither is available,
 * originaljob.json is an explicitly marked in-memory snapshot, not a fabricated on-disk source.
 * Returns {sourceDir, selection, jobs, summary, manifestPath, reviewPath, parityPath, manifest}.
 */
export async function archiveAutomationInputs({jobs,summary,outDir,repo=REPO,selection}={}){
  if(typeof outDir!=='string'||!outDir)fail('output_required');
  const out=resolve(outDir),repoPath=resolve(repo);
  if(await stat(out))fail('output_exists',out);
  // Runtime state belongs in the existing gitignored durable cache, never source scripts/media.
  const durableRoots=[join(repoPath,'.drift-cache/automation'),join(repoPath,'out/drift-runs')];
  if(inside(repoPath,out)&&!durableRoots.some(root=>inside(root,out)))fail('output_inside_repo');
  for(const root of [tmpdir(),join(homedir(),'.hermes/cache/scratch'),'/tmp','/private/tmp'])if(inside(resolve(root),out))fail('output_not_durable',out);
  if(!Array.isArray(jobs)||!summary||!Array.isArray(summary.names))fail('invalid_batch_names');
  const originals=plain(jobs),summaryInput=plain(summary),names=originals.map(j=>j.name);
  if(names.some(n=>!nameOK(n))||new Set(names).size!==names.length||new Set(summaryInput.names).size!==summaryInput.names.length||canonical(names.slice().sort())!==canonical(summaryInput.names.slice().sort()))fail('batch_names_mismatch');
  const inputs=new Map(),files=[],missing=[],issues=[],retiredProofs=[],scripts=new Map(),jobSources=new Map(),written=new Map();
  async function snapshot(path,kind){
    const p=resolve(path),bytes=await regularBytes(p),sha256=bytes===null?null:bytesDigest(bytes),prior=inputs.get(p);
    if(prior&&prior.sha256!==sha256)fail('automation_input_source_changed',p);
    if(!prior)inputs.set(p,{path:p,sha256,size:bytes?.length??null,status:bytes===null?'missing':'present',kind});
    return {path:p,sha256,bytes};
  }
  const from=s=>({path:s.path,sha256:s.sha256});
  const parse=s=>{try{return JSON.parse(s.bytes.toString('utf8'));}catch{fail('invalid_source_json',s.path);}};
  const sourceOut=typeof summaryInput.outDir==='string'?resolve(summaryInput.outDir):null;
  if(sourceOut&&inside(sourceOut,out))fail('output_inside_source');
  // Resolve and pin all scripts before recomputing selection: nonflagged routes still vote on app frames.
  for(const job of originals){
    indexed(job.steps??[],'job');
    const row=summaryInput.videos?.find(v=>v.name===job.name);
    const explicit=row?.job??job.jobPath??(sourceOut?join(sourceOut,job.name,'job.json'):null);
    const inferred=job.evidence?.runDir?join(dirname(resolve(job.evidence.runDir)),'job.json'):null;
    const jobPath=explicit?resolve(sourceOut??repoPath,explicit):inferred;
    let source=null;
    if(jobPath){source=await snapshot(jobPath,'original_job');if(source.bytes&&explicit&&digest(parse(source))!==digest(job))fail('source_job_changed',jobPath);}
    jobSources.set(job.name,{source,matches:!!source?.bytes&&digest(parse(source))===digest(job),jobPath});
    const scriptPath=job.scriptPath?resolve(jobPath?dirname(jobPath):repoPath,job.scriptPath):join(repoPath,'scripts',job.name+'.script.json');
    const scriptSource=await snapshot(scriptPath,'original_script');
    const script=scriptSource.bytes?parse(scriptSource):null;
    if(script){if(script.name&&script.name!==job.name)fail('source_script_name_mismatch',job.name);if(job.scriptHash&&job.scriptHash!==digest(script))fail('script_changed_since_capture',job.name);}
    scripts.set(job.name,{source:scriptSource,script});
  }
  const originalSelection=selectWeeklyJobs(originals,{readScript:n=>scripts.get(n)?.script??null});
  if(selection)assertClaims(selection,originalSelection);
  const flagged=new Set(originalSelection.review.flagged.map(v=>v.name));
  await mkdir(dirname(out),{recursive:true,mode:0o700});
  const parent=await realpath(dirname(out));
  if(parent!==dirname(out))fail('output_parent_symlink',out);
  const staging=join(parent,`.${basename(out)}.staging-${randomUUID()}`);
  await mkdir(staging,{mode:0o700});let published=false;
  async function emit(rel,bytes,{kind='context',archiveFrom=null,transformation=null}={}){
    const target=resolve(staging,rel);if(!inside(staging,target)||target===staging)fail('unsafe_archive_path',rel);
    const sha256=bytesDigest(bytes),prior=written.get(rel);
    if(prior){if(prior!==sha256)fail('contradictory_archive_source',rel);return join(out,rel);}
    await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
    if(bytesDigest(await readFile(target))!==sha256)fail('automation_input_copy_mismatch',rel);
    written.set(rel,sha256);files.push({relativePath:rel,path:join(out,rel),sha256,size:bytes.length,kind,...(archiveFrom?{archiveFrom}:{}),...(transformation?{transformation}:{})});return join(out,rel);
  }
  function absent(s,rel,kind){if(!missing.some(m=>m.path===s.path&&m.relativePath===rel))missing.push({path:s.path,sha256:null,status:'missing',kind,...(rel?{relativePath:rel,archivePath:join(out,rel)}:{})});}
  async function exact(source,rel,kind){if(source.bytes===null){absent(source,rel,kind);return join(out,rel);}return emit(rel,source.bytes,{kind,archiveFrom:from(source)});}
  try{
    const sourceSummary=sourceOut?await snapshot(join(sourceOut,'summary.json'),'original_summary'):null;
    if(sourceSummary?.bytes)await exact(sourceSummary,'original-summary.json','original_summary');
    else await emit('original-summary.json',json(summaryInput),{kind:'in_memory_original_summary',transformation:'caller_supplied_summary_snapshot'});
    const cloned=plain(originals);
    for(const job of cloned){
      const {source,matches}=jobSources.get(job.name),script=scripts.get(job.name);
      if(matches)await exact(source,join(job.name,'originaljob.json'),'original_job');
      else{
        await emit(join(job.name,'originaljob.json'),json(originals.find(j=>j.name===job.name)),{kind:'in_memory_original_job',transformation:'caller_supplied_job_snapshot'});
        if(source?.bytes)await exact(source,join(job.name,'original-sourcejob.json'),'original_source_job');
        else if(source)absent(source,null,'original_job');
      }
      const scriptRel=join('scripts',job.name+'.script.json');
      await exact(script.source,scriptRel,'original_script');
      // Pin present scripts byte-for-byte. An absent source remains absent at its pinned destination.
      job.scriptPath=join(out,scriptRel);
      for(const step of job.steps??[])for(const key of ['semanticRepair','flowEquivalence'])if(Object.hasOwn(step,key)){retiredProofs.push({name:job.name,index:step.index,field:key});delete step[key];}
      const rawRunPath=job.evidence?.runDir?join(resolve(job.evidence.runDir),'run.json'):null;
      const currentDirs=new Map();
      if(flagged.has(job.name))for(const step of job.steps??[]){const path=step.evidence?.today;if(typeof path==='string'&&path){if(!isAbsolute(path))fail('absolute_current_path_required',path);const dir=dirname(path);currentDirs.set(dir,join(job.name,'captures',bytesDigest(Buffer.from(dir))));}}
      const runCache=new Map();
      async function getRun(path){
        if(runCache.has(path))return runCache.get(path);
        const source=await snapshot(path,'capture_run'),run=source.bytes?parse(source):null;
        const entry={source,run,byIndex:run?indexed(run.steps,'capture'):new Map()};runCache.set(path,entry);return entry;
      }
      async function image(path,dir,kind){
        const source=await snapshot(path,kind),rel=join(dir,bytesDigest(Buffer.from(source.path)).slice(0,16)+'-'+basename(source.path));
        return exact(source,rel,kind);
      }
      async function rewriteRun(entry,dir){
        if(!entry.run){absent(entry.source,join(dir,'run.json'),'capture_run');return null;}
        await exact(entry.source,join(dir,'original-run.json'),'original_capture_run');
        const run=plain(entry.run);
        for(const step of run.steps)if(typeof step.screenshot==='string'&&step.screenshot){
          const original=resolve(dirname(entry.source.path),step.screenshot),imageDir=currentDirs.get(dirname(original))??dir;
          step.screenshot=relative(join(out,dir),await image(original,imageDir,'current_image'));
        }
        run.archiveFrom=from(entry.source);return run;
      }
      const rewritten=new Map();
      if(flagged.has(job.name)){
        // Each current image stays adjacent to the exact run.json used for its semantic binding.
        for(const [dir,target] of currentDirs){
          const entry=await getRun(join(dir,'run.json')),run=await rewriteRun(entry,target);rewritten.set(dir,{entry,run});
          if(run)await emit(join(target,'run.json'),json(run),{kind:'bound_capture_run',archiveFrom:from(entry.source),transformation:'archive_screenshot_paths'});
        }
        for(const step of job.steps??[]){
          const evidence=step.evidence;if(!evidence)continue;
          if(typeof evidence.today==='string'&&evidence.today){
            const path=evidence.today,{entry}=rewritten.get(dirname(path)),cap=entry.byIndex.get(step.index);
            if(cap&&(!cap.screenshot||resolve(dirname(entry.source.path),cap.screenshot)!==path))fail('capture_image_path_mismatch',`${job.name}#${step.index}`);
            if(entry.run&&!cap)issues.push({name:job.name,index:step.index,code:'capture_step_missing',path:entry.source.path});
            evidence.today=await image(path,currentDirs.get(dirname(path)),'current_image');
          }
          if(typeof evidence.recorded==='string'&&evidence.recorded){if(!isAbsolute(evidence.recorded))fail('absolute_recorded_path_required',evidence.recorded);evidence.recorded=await image(evidence.recorded,join(job.name,'recorded'),'recorded_image');}
        }
      }
      // Candidate target-rect context exists only when the raw job's run actually existed.
      // A composite chooses each index from its bound current run, never array position or a stale run.
      if(rawRunPath){
        const entry=await getRun(rawRunPath),dir=join(job.name,'capture');
        if(entry.run){
          if(!flagged.has(job.name))await exact(entry.source,join(dir,'run.json'),'nonflagged_capture_context');
          else{
            const run=await rewriteRun(entry,dir),steps=indexed(run.steps,'capture'),sources=[];
            for(const raw of originals.find(j=>j.name===job.name).steps??[]){
              const current=raw.evidence?.today,bound=current?rewritten.get(dirname(current)):null,cap=bound?.run?.steps.find((s,i)=>(s.index??i)===raw.index);
              if(cap){const copied=plain(cap);if(copied.screenshot)copied.screenshot=relative(join(out,dir),resolve(join(out,currentDirs.get(dirname(current))),copied.screenshot));steps.set(raw.index,copied);sources.push(from(bound.entry.source));}
              else if(current&&steps.has(raw.index)){
                // A different raw run is not a substitute for absent bound evidence.
                steps.delete(raw.index);issues.push({name:job.name,index:raw.index,code:'canonical_capture_step_unavailable'});
              }
            }
            run.steps=[...steps.values()].sort((a,b)=>a.index-b.index);
            run.archiveSources=[...new Map(sources.map(s=>[s.path,s])).values()];
            await emit(join(dir,'run.json'),json(run),{kind:'candidate_capture_context',archiveFrom:from(entry.source),transformation:'composite_by_bound_step_index'});
          }
        }else absent(entry.source,join(dir,'run.json'),'capture_run');
      }
      if(rawRunPath)job.evidence.runDir=join(out,job.name,'capture');
      job.archiveFrom={originalJob:join(out,job.name,'originaljob.json'),...(matches?from(source):{path:null,sha256:bytesDigest(json(originals.find(j=>j.name===job.name))),origin:'caller_supplied_job_snapshot'}),manifestPath:join(out,MANIFEST)};
    }
    const archivedSelection=selectWeeklyJobs(cloned,{readScript:n=>scripts.get(n)?.script??null});assertClaims(originalSelection,archivedSelection);
    for(const job of cloned){job.uiSelection=archivedSelection.byName.get(job.name);await emit(join(job.name,'job.json'),json(job),{kind:'archived_job',archiveFrom:from({path:join(out,job.name,'originaljob.json'),sha256:files.find(f=>f.relativePath===join(job.name,'originaljob.json')).sha256}),transformation:'pinned_script_and_flagged_evidence_paths_retired_additional_proofs'});}
    const clonedSummary=plain(summaryInput);clonedSummary.outDir=out;clonedSummary.uiSelection=selectionMarker(archivedSelection);
    if(Array.isArray(clonedSummary.videos))clonedSummary.videos=clonedSummary.videos.map(row=>({...row,job:join(out,row.name,'job.json')}));
    await emit('summary.json',json(clonedSummary),{kind:'archived_summary',transformation:'archive_batch_paths_and_selection_marker'});
    await emit('ui-selection.json',json({...selectionMarker(archivedSelection),frameChanges:archivedSelection.review.frameChanges,videos:[...archivedSelection.byName.values()]}),{kind:'selection'});
    const review={schema:1,origin:ORIGIN,...archivedSelection.review,flagged:archivedSelection.review.flagged.map(v=>({...v,repair:archivedSelection.byName.get(v.name).repair}))};
    await emit('review.json',json(review),{kind:'release_verified_review'});
    const acceptedPairs=pairs(originalSelection),parity={schema:1,origin:ORIGIN,acceptedPairs,weeklyPairs:pairs(archivedSelection),claimsUnchanged:true,exclusionsUnchanged:true,approvedScopeUnchanged:true,
      selectedClaims:claims(archivedSelection).flagged,exclusions:{newControlsOnly:claims(archivedSelection).newControlsOnly,frameOnly:claims(archivedSelection).frameOnly,frameChanges:archivedSelection.review.frameChanges},
      repair:Object.fromEntries(archivedSelection.review.flagged.map(v=>[v.name,archivedSelection.byName.get(v.name).repair]))};
    await emit('selection-parity.json',json(parity),{kind:'selection_parity'});
    const body={schema:1,kind:'weekly_automation_inputs',origin:ORIGIN,sourceDir:out,ready:true,inputsUnchanged:true,names:summaryInput.names,flaggedNames:[...flagged],acceptedPairs,
      files,inputs:[...inputs.values()],missing,issues,retiredProofs};
    const manifest={...body,manifestDigest:digest(body)};
    await sourceUnchanged(manifest.inputs);await verifyFiles(manifest,staging);
    // This is the last file written. No partially built archive is ever published as ready.
    await writeFile(join(staging,MANIFEST),json(manifest),{flag:'wx',mode:0o600});
    await verifyAutomationInputs(join(staging,MANIFEST));
    async function seal(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await seal(path);else await chmod(path,0o400);}await chmod(dir,0o500);}
    await seal(staging);
    if(await stat(out))fail('output_exists',out);
    await rename(staging,out);published=true;
    await verifyAutomationInputs(join(out,MANIFEST));
    return {sourceDir:out,selection:archivedSelection,jobs:cloned,summary:clonedSummary,manifestPath:join(out,MANIFEST),reviewPath:join(out,'review.json'),parityPath:join(out,'selection-parity.json'),manifest};
  }catch(error){
    async function unlock(dir){if(!await stat(dir))return;await chmod(dir,0o700);for(const e of await readdir(dir,{withFileTypes:true}))if(e.isDirectory())await unlock(join(dir,e.name));}
    const owned=published?out:staging;await unlock(owned);await rm(owned,{recursive:true,force:true});throw error;
  }
}
