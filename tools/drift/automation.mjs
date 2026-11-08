// Normal weekly local automation. Models supply evidence, never select scope or bypass renderer gates.
// No publisher, Slack client, fixture writer, or schedule activation is reachable from this module.
import fs from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from './contracts.mjs';
import {selectWeeklyJobs,selectionMarker} from './ui-selection.mjs';
import {sha256File} from './publish.mjs';
import {acquireLock,readPyJson} from './executor.mjs';
import {identifiedCopy} from './weekly.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const AUTOMATION_VERSION='weekly-local-repairs-v1';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,v)=>{fs.mkdirSync(dirname(p),{recursive:true});const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v,null,2)+'\n',{mode:0o600});fs.renameSync(t,p);};
const pairs=selection=>selection.review.flagged.flatMap(v=>v.slides.map(s=>`${v.name}#${s.index}`)).sort();
const claims=selection=>selection.review.flagged.map(v=>({name:v.name,slides:v.slides.map(s=>({index:s.index,changes:s.changes}))})).sort((a,b)=>a.name.localeCompare(b.name));
const safeName=name=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)&&!name.startsWith('_studio');

/** Offline lookup only: an installed binary, or the already-downloaded npm CLI. Never downloads a tool. */
export function resolveReviewBinary({binary=process.env.KBS_CODEX_BIN,env=process.env,repo=REPO,spawn=spawnSync}={}){
  if(binary){if(typeof binary!=='string'||!binary.trim())throw new Error('invalid_review_binary');return binary;}
  for(const directory of String(env.PATH??'').split(':')){
    const candidate=join(directory,'codex');try{fs.accessSync(candidate,fs.constants.X_OK);return candidate;}catch{}
  }
  const found=spawn('npm',['exec','--offline','--yes','--package=@openai/codex','--','which','codex'],{cwd:repo,env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  const candidate=String(found.stdout??'').trim();
  if(found.status===0&&isAbsolute(candidate)&&fs.existsSync(candidate))return candidate;
  throw new Error('review_provider_not_installed');
}

export function automationInputKey({jobs,selection,repo=REPO,settings={}}){
  const files=new Map(),add=p=>{if(typeof p==='string'&&!files.has(p)){try{files.set(p,sha256File(p));}catch{files.set(p,null);}}};
  const selected=new Set(selection.review.flagged.map(v=>v.name));
  for(const job of jobs){
    add(job.scriptPath??join(repo,'scripts',job.name+'.script.json'));
    if(!selected.has(job.name))continue;
    for(const step of job.steps??[]){add(step.evidence?.recorded);add(step.evidence?.today);if(step.evidence?.today)add(join(dirname(step.evidence.today),'run.json'));}
  }
  // Renderer/QA upgrades invalidate output certificates, not the immutable captured evidence paths.
  add(join(repo,'tools/drift/automation-inputs.mjs'));
  // A larger retry budget does not invalidate successful reviews/renders; their exact inputs do.
  return digest({version:AUTOMATION_VERSION,selection:selection.inputHash,settings:{model:settings.model??'gpt-6.1-sol',effort:settings.effort??'medium'},files:[...files].sort(([a],[b])=>a.localeCompare(b))});
}

export function automationExecutionVersion({repo=REPO}={}){
  const files=['tools/drift/automation.mjs','tools/drift/automation-policy.mjs','tools/drift/automatic-qa.mjs','tools/drift/automatic-narration-qa.mjs','tools/drift/render-repairs.mjs','tools/drift/repairability.mjs','tools/drift/ui-selection.mjs','tools/drift/semantic-repair-proof.mjs','tools/drift/semantic-repair-assets.mjs','tools/drift/flow-equivalence.mjs','tools/drift/flow-equivalence-assets.mjs','tools/drift/role-switch-source.mjs','renderer/drift_update.py','renderer/drift_render.py','renderer/drift_qa.py','renderer/preservation.py','renderer/caption_layout.py','renderer/fx_draw.py','renderer/tts.py','renderer/take_provider.py'];
  return digest(files.map(file=>{try{return [file,sha256File(join(repo,file))];}catch{return [file,null];}}));
}

export function defaultAutomationDeps({repo=REPO}={}){
  return {
    archive:async o=>(await import('./automation-inputs.mjs')).archiveAutomationInputs(o),
    verifyArchive:async source=>(await import('./automation-inputs.mjs')).verifyAutomationInputs(join(source,'automation-inputs.json'),{verifySources:false}),
    flow:async o=>(await import('./flow-equivalence-assets.mjs')).createFlowEquivalenceProof(o),
    review:async o=>(await import('./review-repairs.mjs')).reviewRepairs(o),
    prepare:async o=>(await import('./prepare-repairs.mjs')).prepareRepairs(o),
    baseline:async o=>(await import('./baseline-registry.mjs')).getOrEnrollBaseline(o),
    render:async o=>(await import('./render-repairs.mjs')).renderPreparedRepair(o),
    route:async o=>(await import('./automation-policy.mjs')).routeAutomationVideo(o),
    certify:async o=>o.result?.narrationChanged===true?(await import('./automatic-narration-qa.mjs')).certifyAutomaticNarrationRepair(o):(await import('./automatic-qa.mjs')).certifyAutomaticRepair(o),
    binary:()=>resolveReviewBinary({repo}),
  };
}

/** Persistent result cache: QA certificates and every retained byte are checked, not just a ready flag. */
export function loadAutomaticResult(file,{inputKey,baselineManifestHash,executionVersion=null,repairPlanKey=null}={}){
  try{
    const saved=read(file);
    if(saved.schema!==1||saved.inputKey!==inputKey||saved.baselineManifestHash!==baselineManifestHash||(executionVersion!==null&&saved.executionVersion!==executionVersion)||(repairPlanKey!==null&&saved.repairPlanKey!==repairPlanKey)||saved.qa?.ok!==true
      ||!Array.isArray(saved.files)||!saved.files.length||!saved.result?.sha256)return null;
    for(const entry of saved.files)if(sha256File(entry.path)!==entry.sha256)return null;
    const certificate=saved.files.find(entry=>entry.path===saved.result.automaticQa);
    if(!certificate||digest(read(certificate.path))!==digest(saved.qa)
      ||!saved.files.some(entry=>entry.path===saved.result.candidate&&entry.sha256===saved.result.sha256))return null;
    if(sha256File(saved.result.candidate)!==saved.result.sha256)return null;
    return saved;
  }catch{return null;}
}

function retainResult({result,qa,renderDir,destination,inputKey,executionVersion,repairPlanKey,baselineManifestHash}){
  if(fs.existsSync(destination))throw new Error('result_archive_exists');
  fs.mkdirSync(destination,{recursive:true});const files=[];
  const copy=(from,to,required=false)=>{if(!fs.existsSync(from)){if(required)throw new Error('result_artifact_missing');return;}const sha256=sha256File(from);fs.mkdirSync(dirname(to),{recursive:true});fs.copyFileSync(from,to);if(sha256File(to)!==sha256)throw new Error('result_copy_mismatch');files.push({path:to,sha256});};
  const candidate=join(destination,'candidate.mp4');copy(result.candidate,candidate,true);
  copy(result.verification,join(destination,'repair/verification.json'),true);
  const verification=readPyJson(result.verification);
  if(verification.candidate_assembly)copy(verification.candidate_assembly,join(destination,'repair/candidate-assembly.json'),true);
  if(verification.candidate_script)copy(verification.candidate_script,join(destination,'repair/candidate-final.script.json'),true);
  if(result.narrationChanged){copy(result.transcriptReport,join(destination,'transcript/transcript-report.json'),true);copy(join(renderDir,'transcript/segments/candidate.transcript.json'),join(destination,'transcript/segments/candidate.transcript.json'),true);}
  for(const file of ['local-repair.json','control.changes.json','repair.changes.json','caption-layout/caption-layout.json','control/verification.json','repair/contact-sheet.jpg'])copy(join(renderDir,file),join(destination,file));
  const qaPath=join(destination,'automatic-qa.json');write(qaPath,qa);files.push({path:qaPath,sha256:sha256File(qaPath)});
  const retained={schema:1,inputKey,executionVersion,repairPlanKey,baselineManifestHash,qa,files,result:{...result,candidate,verification:join(destination,'repair/verification.json'),automaticQa:qaPath,...(result.narrationChanged?{transcriptReport:join(destination,'transcript/transcript-report.json')}:{}),originalRenderDir:renderDir,pictureAndAudioInspection:'automated_verified'}};
  write(join(destination,'result.json'),retained);return retained;
}

function flowInputs({job,slot,name,stepIndex}){
  const source=join(slot,'flow-inputs',name);
  const step=job.steps.find(s=>s.index===stepIndex),runDir=dirname(step.evidence.today),run=read(join(runDir,'run.json'));
  if(typeof run.scriptPath!=='string'||sha256File(run.scriptPath)!==sha256File(job.scriptPath))throw new Error('flow_script_copy_conflict');
  // The pure checker requires one coherent file identity. Point only this proof-input copy at
  // the byte-identical original script and the exact archived run that produced its screenshots.
  const proofJob={...job,scriptPath:run.scriptPath,evidence:{...job.evidence,runDir}};
  const jobPath=join(source,'step-'+stepIndex,'job.json');write(jobPath,proofJob);return jobPath;
}

async function makeReviewSource({archive,slot,names,repo,deps,log}){
  const source=join(slot,'review-source'),marker=join(source,'ready.json');
  if(fs.existsSync(marker)){
    const saved=read(marker);
    if(saved.version===3){if(!saved.files?.every(f=>fs.existsSync(f.path)&&sha256File(f.path)===f.sha256))throw new Error('automation_review_source_changed');return {sourceDir:source,flowProofPaths:saved.flowProofPaths};}
  }
  if(fs.existsSync(source))fs.renameSync(source,source+'.interrupted-'+Date.now());
  fs.mkdirSync(source,{recursive:true});const jobs=[],flowProofPaths=[];
  const selectedNames=new Set(read(join(archive,'selection-parity.json')).acceptedPairs.map(pair=>pair.split('#')[0]));
  for(const name of names){
    const job=read(join(archive,name,'job.json')),target=join(source,name);fs.mkdirSync(target,{recursive:true});
    const capture=join(archive,name,'capture/run.json');if(fs.existsSync(capture)){fs.mkdirSync(join(target,'capture'));fs.copyFileSync(capture,join(target,'capture/run.json'));}
    for(const step of job.steps??[])if(selectedNames.has(name)&&(step.reasons??[]).some(r=>r.code==='flow_changed')){
      try{
        const flowJobPath=flowInputs({job,archive,slot,name,stepIndex:step.index});
        const proof=await deps.flow({jobPath:flowJobPath,stepIndex:step.index,frontendGitDir:join(repo,'.drift-cache/frontend.git')});
        if(proof?.verified===true){const path=join(slot,'flow-proofs',`${name}-${step.index}.json`);write(path,proof);flowProofPaths.push(path);step.flowEquivalence=proof;}
        else log(`[auto-repair] ${name} #${step.index}: source-flow evidence pending (${proof?.reasons?.join(',')??'unverified'})`);
      }catch(error){log(`[auto-repair] ${name} #${step.index}: source-flow evidence pending (${error.code??error.message})`);}
    }
    jobs.push(job);write(join(target,'job.json'),job);
  }
  const readScript=name=>read(join(repo,'scripts',name+'.script.json'));
  const selection=selectWeeklyJobs(jobs,{readScript}),original=read(join(archive,'selection-parity.json'));
  if(digest(pairs(selection))!==digest([...original.acceptedPairs].sort())||digest(claims(selection))!==digest(original.selectedClaims))throw new Error('automation_scope_changed');
  const summary={...read(join(archive,'summary.json')),outDir:source,finishedAt:new Date().toISOString(),uiSelection:selectionMarker(selection)};
  write(join(source,'summary.json'),summary);write(join(source,'selection-parity.json'),original);
  write(join(source,'review.json'),{...selection.review,origin:'weekly_release_verified_selection',humanApprovalRequired:false});
  const boundFiles=[join(source,'summary.json'),join(source,'review.json'),join(source,'selection-parity.json'),...names.map(name=>join(source,name,'job.json')),...names.map(name=>join(source,name,'capture/run.json')).filter(path=>fs.existsSync(path)),...flowProofPaths];
  write(marker,{version:3,flowProofPaths,files:boundFiles.map(path=>({path,sha256:sha256File(path)}))});return {sourceDir:source,flowProofPaths};
}

/** One end-to-end invocation; every video is routed and an individual failure never discards other repairs. */
export async function runRepairAutomation({jobs,summary,outDir,selection=null,repo=REPO,settings={},budget=null,deps={},log=()=>{}}){
  if(!Array.isArray(jobs)||!Array.isArray(summary?.names)||new Set(summary.names).size!==summary.names.length
    ||summary.names.some(name=>!safeName(name))||digest(jobs.map(j=>j.name).sort())!==digest([...summary.names].sort()))throw new Error('automation_invalid_batch');
  repo=resolve(repo);deps={...defaultAutomationDeps({repo}),...deps};
  const readScript=name=>{try{return read(join(repo,'scripts',name+'.script.json'));}catch{return null;}};
  const current=selectWeeklyJobs(jobs,{readScript});
  if(selection&&selection.inputHash!==current.inputHash)throw new Error('automation_stale_selection');selection=current;
  const inputKey=automationInputKey({jobs,selection,repo,settings}),executionVersion=automationExecutionVersion({repo}),stateRoot=resolve(settings.stateRoot??join(repo,'.drift-cache/automation'));
  const slot=join(stateRoot,'runs',inputKey),reportPath=join(outDir,'automation-report.json');
  fs.mkdirSync(slot,{recursive:true});const lock=acquireLock(join(stateRoot,'automation.lock'),{staleMs:3*24*3600_000});
  if(!lock)throw new Error('automatic_repair_already_running');
  const report={schema:1,policy:AUTOMATION_VERSION,inputKey,executionVersion,sourceSelectionInputHash:selection.inputHash,startedAt:new Date().toISOString(),finishedAt:null,posts:0,uploads:0,
    publication:'disabled_separate_authorization',selectedPairs:pairs(selection),names:summary.names,rows:[],counts:{},humanQueue:[],review:null};
  const save=()=>{report.counts=report.rows.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{});report.humanQueue=report.rows.filter(r=>r.status==='human_required');write(reportPath,report);write(join(slot,'latest.json'),report);write(join(slot,'human-queue.json'),report.humanQueue);};
  try{
    save();let preparation=null,reviewRows=[],stageError=null;
    if(selection.review.flagged.length){
      try{
        const archive=join(slot,'inputs');
        if(!fs.existsSync(join(archive,'automation-inputs.json')))await deps.archive({jobs,summary:{...summary,finishedAt:summary.finishedAt??new Date().toISOString()},outDir:archive,repo,selection});
        await deps.verifyArchive(archive);
        const preparedSource=await makeReviewSource({archive,slot,names:summary.names,repo,deps,log});
        report.sourceDir=archive;report.reviewSourceDir=preparedSource.sourceDir;
        const historyFile=join(slot,'review-history.json'),history=fs.existsSync(historyFile)?read(historyFile):[];
        let attempt=1;while(fs.existsSync(join(slot,'review-'+attempt)))attempt++;
        const reviews=join(slot,'review-'+attempt),binary=await (settings.binary??deps.binary());
        // With a finite review budget, finish already-enrolled videos before spending on setup-held ones.
        // This is discovered readiness, never a per-video exception or a selection filter.
        let priorityNames=[];try{const index=read(join(settings.baselineRoot??join(repo,'out/drift-baselines'),'index.json'));
          const selectedNames=new Set(selection.review.flagged.map(v=>v.name));priorityNames=[...new Set((index.baselines??[]).map(v=>v.name).filter(name=>selectedNames.has(name)))];}catch{}
        const reviewed=await deps.review({sourceDir:preparedSource.sourceDir,reviewPath:join(preparedSource.sourceDir,'review.json'),outDir:reviews,repo,
          binary,model:settings.model??'gpt-6.1-sol',effort:settings.effort??'medium',maxModelCalls:settings.maxModelCalls??null,
          cacheDir:join(stateRoot,'model-cache'),priorReports:history,priorityNames,budget});
        reviewRows=reviewed.rows;report.review={path:join(reviews,'report.json'),counts:reviewed.counts,budget:reviewed.budget};
        history.push(report.review.path);write(historyFile,history);
        const preparationDir=join(slot,'prepared-'+attempt);
        preparation=await deps.prepare({sourceDir:preparedSource.sourceDir,semanticReport:report.review.path,outDir:preparationDir,repo,requireAllCandidates:false});
        report.preparationDir=preparationDir;
        if(digest(preparation.approvedPairs)!==digest(report.selectedPairs))throw new Error('automation_scope_changed');
      }catch(error){stageError=String(error.code??error.message);report.stageError=stageError;}
    }
    for(const name of summary.names){
      const original=jobs.find(j=>j.name===name),chosen=selection.byName.get(name),video=preparation?.videos.find(v=>v.name===name);
      const rawJob=video?read(join(report.preparationDir,name,'job.json')):original,script=readScript(name);
      // Identity migration is deterministic and local; original step contents stay bound to their reviews.
      const job={...rawJob,renderer:{...rawJob.renderer,automaticNarration:settings.allowNarration!==false},...(script?{script,identifiedScript:rawJob.candidateInputs?.identifiedScript?read(rawJob.candidateInputs.identifiedScript):identifiedCopy(script)}:{})};
      const chosenAfter=video?{...chosen,repair:video.repair}:chosen;
      let route=await deps.route({job,selection:chosenAfter,reviewRows:reviewRows.filter(r=>r.name===name),baselineError:stageError});
      const row={name,...route,selectedSlides:chosen?.slides?.map(s=>s.index)??[]};report.rows.push(row);save();
      if(row.status!=='automatic_repair')continue;
      if(!video?.candidatePath||video.candidateError){row.status='setup_required';row.reason=video?.candidateError??'automatic_candidate_missing';save();continue;}
      try{
        const baseline=await deps.baseline({name,repo,stateRoot:settings.baselineRoot??join(repo,'out/drift-baselines'),runRoot:outDir,log});
        const baselineDir=typeof baseline==='string'?baseline:baseline.directory;
        const baselineHash=sha256File(join(baselineDir,'baseline-manifest.json'));
        const repairPlanKey=digest({actions:video.repair.actions,extended:video.repair.extended??[]});
        const resultsRoot=join(stateRoot,'results',inputKey,name),resultIndex=join(stateRoot,'result-index',inputKey,name+'.json');
        const resultPath=fs.existsSync(resultIndex)?read(resultIndex).path:join(resultsRoot,'result.json');
        const cached=loadAutomaticResult(resultPath,{inputKey,executionVersion,repairPlanKey,baselineManifestHash:baselineHash});
        if(cached){row.status='automatically_repaired';row.result=cached.result;row.reused=true;row.qa=cached.qa;save();continue;}
        // QA upgrades need fresh certification, not necessarily new encoding. Exact same inputs,
        // plan and baseline plus every retained hash are still required; current QA may refuse reuse.
        const prior=loadAutomaticResult(resultPath,{inputKey,repairPlanKey,baselineManifestHash:baselineHash});
        if(prior&&prior.result.narrationChanged!==true){
          try{
            const verification=join(prior.result.originalRenderDir,'repair/verification.json'),v=readPyJson(verification);
            if(v.candidate_sha256!==prior.result.sha256||sha256File(v.candidate)!==prior.result.sha256)throw new Error('recertification_media_conflict');
            const result={...prior.result,verification,candidate:v.candidate},qa=await deps.certify({result,repo,preparationDir:report.preparationDir,baselineDir});
            if(qa.ok===true){
              const destination=resultsRoot+'-recertified-'+Date.now(),retained=retainResult({result,qa,renderDir:prior.result.originalRenderDir,destination,inputKey,executionVersion,repairPlanKey,baselineManifestHash:baselineHash});
              write(resultIndex,{path:join(destination,'result.json')});row.status='automatically_repaired';row.result=retained.result;row.qa=qa;row.reused=true;row.recertified=true;save();continue;
            }
          }catch(error){log(`[auto-repair] ${name}: fresh render required (${error.code??error.message})`);}
        }
        const renderRoot=join(outDir,'automatic-renders');fs.mkdirSync(renderRoot,{recursive:true});let n=1,renderDir=join(renderRoot,name);
        while(fs.existsSync(renderDir))renderDir=join(renderRoot,name+'-'+n++);
        const result=await deps.render({preparationDir:report.preparationDir,name,rebaselineDir:baselineDir,baselineInputs:typeof baseline==='object'?baseline.sourceSnapshot:null,outDir:renderDir,repo,allowNarration:settings.allowNarration!==false,log});
        const qa=await deps.certify({result,repo,preparationDir:report.preparationDir,baselineDir});
        if(qa.ok!==true)throw new Error('automatic_quality_not_verified');
        const destination=fs.existsSync(resultsRoot)?resultsRoot+'-retry-'+Date.now():resultsRoot;
        const retained=retainResult({result,qa,renderDir,destination,inputKey,executionVersion,repairPlanKey,baselineManifestHash:baselineHash});
        write(resultIndex,{path:join(destination,'result.json')});
        row.status='automatically_repaired';row.result=retained.result;row.qa=qa;row.reused=false;
      }catch(error){
        const failure=String(error.code??error.message);route=await deps.route({job,selection:chosenAfter,reviewRows:reviewRows.filter(r=>r.name===name),renderError:failure});
        row.status=route.status==='human_required'?'human_required':route.status==='evidence_pending'?'evidence_pending':'setup_required';row.reason=failure;
      }
      save();log(`[auto-repair] ${name}: ${row.status}${row.reason?' ('+row.reason+')':''}`);
    }
    if(report.rows.length!==summary.names.length)throw new Error('automation_incomplete_inventory');
    report.finishedAt=new Date().toISOString();save();return report;
  }finally{lock.release();}
}

export function parseAutomationArgs(args){
  const flags=new Map([['--run','runDir'],['--out','outDir'],['--codex-bin','binary'],['--max-model-calls','maxModelCalls']]);
  const result={settings:{}},seen=new Set();
  for(let i=0;i<args.length;i++){
    const flag=args[i],key=flags.get(flag);
    if(!key||seen.has(flag))throw new Error('unknown_or_duplicate_argument:'+flag);
    seen.add(flag);const value=args[++i];
    if(!value||value.startsWith('--'))throw new Error('argument_value_required:'+flag);
    if(key==='maxModelCalls'){
      if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error('invalid_max_model_calls');
      result.settings[key]=Number(value);
    }else if(key==='binary')result.settings.binary=value;
    else result[key]=value;
  }
  if(!result.runDir)throw new Error('usage: automation.mjs --run FINISHED_WEEKLY_DIR [--out NEW_DIR] [--codex-bin PATH] [--max-model-calls N]');
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const parsed=parseAutomationArgs(process.argv.slice(2));
  const runDir=resolve(parsed.runDir),summary=read(join(runDir,'summary.json'));
  if(!summary.finishedAt)throw new Error('weekly_run_incomplete');
  const jobs=summary.names.map(name=>read(join(runDir,name,'job.json')));
  const outDir=parsed.outDir?resolve(parsed.outDir):fs.mkdtempSync(join(homedir(),'.hermes/cache/scratch/weekly-repair-'));
  if(outDir===runDir)throw new Error('automation_output_must_not_be_source');
  runRepairAutomation({jobs,summary,outDir,settings:parsed.settings,log:console.error})
    .then(r=>console.log(JSON.stringify({report:join(outDir,'automation-report.json'),counts:r.counts,posts:r.posts,uploads:r.uploads},null,2)))
    .catch(e=>{console.error(e.stack);process.exitCode=1;});
}
