// Prepare scoped, local repair candidates from an immutable full-batch replay and independent semantic reviews.
// This command has no browser, model, bridge, publishing or network dependency. Rendering is a separate stage.
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {finalizeWeeklySelection} from './weekly.mjs';
import {selectionMarker} from './ui-selection.mjs';
import {semanticStepDigest} from './semantic-repair-proof.mjs';
import {verifySemanticRepairAssets} from './semantic-repair-assets.mjs';
import {loadFlowEquivalenceProof} from './flow-equivalence-assets.mjs';
import {prepareSubmissions} from './weekly-submit.mjs';
import {createCandidate} from './candidate.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
export async function prepareRepairs({sourceDir,semanticReport,outDir,verifiedJobDirs=[],flowProofPaths=[],repo=REPO,requireAllCandidates=true}) {
  const source=resolve(sourceDir),out=resolve(outDir),prior=read(join(source,'selection-parity.json'));
  const sourceSummary=read(join(source,'summary.json')),names=sourceSummary.names;
  if(!Array.isArray(names)||new Set(names).size!==names.length)throw new Error('invalid_batch_names');
  if(existsSync(out))throw new Error('output_exists');
  const semanticReports=Array.isArray(semanticReport)?semanticReport:semanticReport.split(',');
  const reviews=semanticReports.flatMap(path=>read(path).rows??[]);
  const flowProofs=flowProofPaths.map(path=>({path,proof:loadFlowEquivalenceProof(path)}));
  const supplemental=new Map();
  for(const dir of verifiedJobDirs){const job=read(join(dir,'job.json'));if(!names.includes(job.name))throw new Error('supplemental_job_outside_batch');supplemental.set(job.name,{dir,job});}
  mkdirSync(out,{mode:0o700});
  const jobs=[],attachments=[];
  for(const name of names){
    const replacement=supplemental.get(name),dir=replacement?.dir??join(source,name),job=replacement?.job??read(join(dir,'job.json'));
    const target=join(out,name);mkdirSync(join(target,'capture'),{recursive:true});
    if(existsSync(join(dir,'capture/run.json')))copyFileSync(join(dir,'capture/run.json'),join(target,'capture/run.json'));
    for(const step of job.steps??[]){
      const flow=flowProofs.find(x=>x.proof.binding.videoName===name&&x.proof.binding.stepIndex===step.index);
      if(flow){
        const scriptStep=read(join(repo,'scripts',name+'.script.json')).steps.find((s,i)=>(s.index??i)===step.index);
        step.flowEquivalence=loadFlowEquivalenceProof(flow.path,{step,scriptStep,name});
        attachments.push({kind:'flow_equivalence',name,index:step.index,status:'attached'});
      }
      const row=reviews.find(x=>x.name===name&&x.index===step.index&&x.check?.executionReady);
      if(!row)continue;
      if(row.proof?.binding?.source?.job?.stepDigest!==semanticStepDigest(step)){
        attachments.push({name,index:step.index,status:'stale',reason:'source step differs from independently reviewed input'});continue;
      }
      step.semanticRepair=row.proof;
      try{verifySemanticRepairAssets(step);attachments.push({name,index:step.index,status:'attached'});}
      catch(error){delete step.semanticRepair;attachments.push({name,index:step.index,status:'rejected',reason:error.message});}
    }
    jobs.push(job);writeFileSync(join(target,'job.json'),JSON.stringify(job,null,2)+'\n');
  }
  const deps={readScript:name=>({script:read(join(repo,'scripts',name+'.script.json'))}),recordingsRoot:join(repo,'out/_recordings'),candidate:createCandidate};
  const selection=await finalizeWeeklySelection({jobs,outDir:out,deps});
  const pairs=selection.review.flagged.flatMap(v=>v.slides.map(s=>`${v.name}#${s.index}`)).sort();
  if(JSON.stringify(pairs)!==JSON.stringify(prior.acceptedPairs.slice().sort()))throw new Error('approved_selection_changed');
  copyFileSync(join(source,'selection-parity.json'),join(out,'selection-parity.json'));
  const summary={schema:1,names,dryRun:true,finishedAt:new Date().toISOString(),uiSelection:selectionMarker(selection),videos:jobs.map(j=>({name:j.name,status:j.status}))};
  writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  const rows=prepareSubmissions({summary,runDir:out,requireCertifiedPreview:false,io:{readJson:path=>{try{return read(path)}catch{return null}},readScript:name=>deps.readScript(name).script,readAssembly:()=>null}}); // eligibility, not posting
  const videos=selection.review.flagged.map(v=>{const job=jobs.find(x=>x.name===v.name),repair=selection.byName.get(v.name).repair;
    return {name:v.name,selectedSlides:v.slides.map(s=>s.index),repair,candidatePath:job.candidatePath??null,candidateInputs:job.candidateInputs??null,candidateError:job.candidateError??null};});
  if(requireAllCandidates)for(const video of videos)if(video.repair.decision==='auto'&&(!video.candidatePath||video.candidateError))throw new Error(`candidate_not_ready:${video.name}:${video.candidateError??'missing'}`);
  const result={schema:1,sourceDir:source,semanticReports:semanticReports.map(path=>resolve(path)),outDir:out,approvedScopeUnchanged:true,approvedPairs:pairs,
    networkCalls:0,modelCalls:0,posts:0,attachments,videos,preparedPayloads:rows,renderedVideos:[]};
  writeFileSync(join(out,'repair-preparation.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const a=process.argv.slice(2),arg=k=>a[a.indexOf(k)+1];
  for(const k of ['--source','--semantic-reviews','--out'])if(!a.includes(k))throw new Error('missing '+k);
  prepareRepairs({sourceDir:arg('--source'),semanticReport:arg('--semantic-reviews'),outDir:arg('--out'),verifiedJobDirs:a.includes('--verified-job-dirs')?arg('--verified-job-dirs').split(','):[],flowProofPaths:a.includes('--flow-proofs')?arg('--flow-proofs').split(','):[]})
    .then(r=>console.log(JSON.stringify({report:join(r.outDir,'repair-preparation.json'),flagged:r.videos.length,automaticCandidates:r.videos.filter(v=>v.candidatePath).length,videos:r.videos.map(v=>({name:v.name,decision:v.repair.decision,candidate:!!v.candidatePath,blockers:v.repair.blockers.map(b=>b.code)})),posts:r.posts},null,2)))
    .catch(e=>{console.error(e.stack);process.exitCode=1;});
}
