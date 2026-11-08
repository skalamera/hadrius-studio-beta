import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {dirname} from 'node:path';
import {sha256File} from '../../tools/drift/publish.mjs';
import {selectWeeklyJobs,selectionMarker} from '../../tools/drift/ui-selection.mjs';
import {repairReviewBinding} from '../../tools/drift/semantic-repair.mjs';
import {semanticStepDigest} from '../../tools/drift/semantic-repair-proof.mjs';
import {confirmedRelease} from './release-fixture.mjs';
import * as repairs from '../../tools/drift/render-repairs.mjs';
import {digest} from '../../tools/drift/contracts.mjs';
import {validateLocalRenderCandidate,renderPreparedRepair,readLocalStage} from '../../tools/drift/render-repairs.mjs';

function fixture(){
  const original={name:'Synthetic',recording:{id:'rec'},steps:[{index:0,capture:true,narration:'Keep the task.',media:{pre:'step.png'}},{index:1,capture:true,media:{pre:'step2.png'}}]};
  const identified=structuredClone(original);identified.id='script';identified.steps.forEach((s,i)=>s.id='step-'+i);
  const candidateManifest={baseHash:digest(identified),structuralChanges:[],changes:[{stepId:'step-0',beforeHash:digest(identified.steps[0]),imagePath:'/scratch/new.png',sha256:'a'.repeat(64)}]};
  return {original,identified,candidateManifest,approvedIndices:[0]};
}

test('local renderer accepts only the exact identified original and full approved replacement set',()=>{
  const f=fixture(),before=digest(f);assert.equal(validateLocalRenderCandidate(f),true);assert.equal(digest(f),before);
});
test('stable identity migration cannot hide changed narration, recording, target, or existing IDs',()=>{
  for(const mutate of [f=>f.identified.steps[0].narration='Different task',f=>f.identified.recording.id='other',f=>f.identified.steps[0].target={name:'Delete'},f=>{f.original.id='saved-id';},f=>f.identified.steps.reverse()]){
    const f=fixture();mutate(f);assert.throws(()=>validateLocalRenderCandidate(f),/identified_script_conflict/);
  }
});
test('candidate scope cannot add, omit, duplicate or point to unknown steps',()=>{
  for(const mutate of [f=>f.approvedIndices=[0,1],f=>f.candidateManifest.changes.push({...f.candidateManifest.changes[0]}),f=>f.candidateManifest.changes[0].stepId='other',f=>f.approvedIndices=[0,0]]){
    const f=fixture();mutate(f);assert.throws(()=>validateLocalRenderCandidate(f),/candidate_scope_conflict/);
  }
});
test('source-step hashes, image binding, allowed fields and structural gate fail closed',()=>{
  for(const mutate of [f=>f.candidateManifest.baseHash='b'.repeat(64),f=>f.candidateManifest.changes[0].beforeHash='b'.repeat(64),f=>f.candidateManifest.changes[0].imagePath='relative.png',f=>f.candidateManifest.changes[0].sha256='not-a-hash',f=>f.candidateManifest.structuralChanges=['insert'],f=>f.candidateManifest.changes[0].narration='Rewrite']){
    const f=fixture();mutate(f);assert.throws(()=>validateLocalRenderCandidate(f),/conflict|unbound_screenshot|unsupported/);
  }
});
test('invalid name is rejected before any filesystem read or subprocess',async()=>{
  await assert.rejects(()=>renderPreparedRepair({name:'../other',render:()=>{throw new Error('must not execute');}}),/invalid_script_name/);
});

test('preflight reads plan.json and cannot stand in for completed preservation verification',t=>{
  const root=mkdtempSync(join(tmpdir(),'local-render-plan-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'plan.json'),JSON.stringify({ok:true,dry_run:true}));
  assert.equal(readLocalStage(root,true).dry_run,true);
  assert.throws(()=>readLocalStage(root),/ENOENT/);
  writeFileSync(join(root,'verification.json'),JSON.stringify({ok:true,dry_run:true}));
  assert.throws(()=>readLocalStage(root),/render_not_verified/);
  writeFileSync(join(root,'verification.json'),JSON.stringify({ok:false}));
  assert.throws(()=>readLocalStage(root),/render_not_verified/);
});

// Explicit synthetic bytes and injected subprocess outputs: orchestration, not real media proof.
function transcriptFixture(t){
  const root=mkdtempSync(join(homedir(),'.hermes/cache/scratch/narration-render-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const write=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,typeof v==='object'&&!Buffer.isBuffer(v)?JSON.stringify(v):v);return p;};
  const candidate=write(join(root,'repair/candidate.mp4'),'synthetic candidate, not media');
  const assembly=write(join(root,'repair/candidate-assembly.json'),{slides:[]});
  const baseline=join(root,'baseline'),old=write(join(baseline,'assembly.json'),{slides:[]});
  const final=write(join(baseline,'baseline.mp4'),'synthetic baseline, not media');
  write(join(baseline,'baseline-manifest.json'),{assembly:{file:'assembly.json',sha256:sha256File(old)},final:{file:'baseline.mp4',sha256:sha256File(final)}});
  const verification=write(join(root,'repair/verification.json'),{ok:true,source_unchanged:true,candidate,candidate_sha256:sha256File(candidate),candidate_assembly:assembly,audio:{ok:true}});
  const reportPath=join(root,'transcript/transcript-report.json');
  const makeReport=()=>({schema:1,kind:'automatic-narration-transcript',ok:true,candidate,candidate_sha256:sha256File(candidate),verification,
    verification_sha256:sha256File(verification),source_unchanged:true,
    source_snapshot:Object.fromEntries([verification,candidate,assembly,join(baseline,'baseline-manifest.json'),old,final].map(p=>[p,sha256File(p)])),
    transcript:{ok:true,model:'synthetic-test (not ASR)'}});
  const run=async(cmd,args,opts)=>{assert.equal(cmd,join(root,'.venv/bin/python'));assert.deepEqual(args,['-B','-m','renderer.drift_qa','--verification',verification,'--baseline',baseline,'--output',join(root,'transcript')]);
    assert.equal(opts.cwd,root);assert.equal(opts.env.HF_HUB_OFFLINE,'1');assert.equal(opts.env.PYTHONDONTWRITEBYTECODE,'1');
    write(reportPath,makeReport());return {code:0};};
  return {root,write,candidate,verification,baseline,reportPath,makeReport,run,args:{verification,baseline,out:root,repo:root,log:()=>{}}};
}

test('offline narration helper invokes the existing CLI and returns the actual bound report path',async t=>{
  const f=transcriptFixture(t);assert.equal(typeof repairs.transcribeLocalNarration,'function');
  assert.equal(await repairs.transcribeLocalNarration({...f.args,run:f.run}),f.reportPath);
});
test('offline narration helper rejects subprocess failures, missing/stale/failed evidence and artifact mutation',async t=>{
  for(const mutation of ['exit','missing','candidate-hash','verification-hash','candidate-path','failed','snapshot','mutate-candidate','mutate-verification','mutate-assembly']){
    const f=transcriptFixture(t);
    const run=async()=>{if(mutation==='exit')return {code:2};if(mutation==='missing')return {code:0};
      const r=f.makeReport();
      if(mutation==='candidate-hash')r.candidate_sha256='0'.repeat(64);
      if(mutation==='verification-hash')r.verification_sha256='0'.repeat(64);
      if(mutation==='candidate-path')r.candidate='/wrong/candidate.mp4';
      if(mutation==='failed')r.transcript.ok=false;
      if(mutation==='snapshot')r.source_snapshot={};
      f.write(f.reportPath,r);
      if(mutation==='mutate-candidate')writeFileSync(f.candidate,'mutated');
      if(mutation==='mutate-verification')writeFileSync(f.verification,'{}');
      if(mutation==='mutate-assembly')f.write(join(f.root,'repair/candidate-assembly.json'),{slides:['mutated']});
      return {code:0};};
    await assert.rejects(()=>repairs.transcribeLocalNarration({...f.args,run}),/transcript|ENOENT/,mutation);
  }
});

function renderFixture(t,{narration=true}={}){
  const f=transcriptFixture(t),name='Synthetic',repo=join(f.root,'repo'),prep=join(f.root,'prep'),out=join(f.root,'render');
  const original={name,recording:{id:'recording'},steps:[{index:0,action:'navigate',capture:true,url:'https://app.hadrius.com/rules?company_id=1150',narration:'Open the Create rule button.',media:{pre:'old.png'}}]};
  const identified=structuredClone(original);identified.id='script';identified.steps[0].id='step-0';
  f.write(join(repo,'scripts/Synthetic.script.json'),original);
  const path=f.write(join(prep,name,'identified-base.script.json'),identified);
  // Valid 1x1 RGB PNG, intentionally tiny synthetic test image.
  const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082','hex');
  const old=f.write(join(f.root,'captures/old.png'),png),today=f.write(join(f.root,'captures/current.png'),png),capture=f.write(join(f.root,'captures/run.json'),{synthetic:true});
  const release=confirmedRelease(),step={index:0,action:'navigate',verdict:'full_rerecord',reasons:[{code:'page_redesigned',verdict:'full_rerecord'}],
    uiContext:{route:'/rules',visibleText:'Rules\nNew rule'},uiReleaseEvidence:release,evidence:{recorded:old,today}};
  const newText='Open the New rule button.';
  const selectedChanges=selectWeeklyJobs([{name,status:'ok',verdict:step.verdict,complete:true,steps:[step]}],{readScript:()=>original}).byName.get(name).slides.flatMap(s=>s.changes);
  const binding=repairReviewBinding({videoName:name,stepIndex:0,scriptStep:original.steps[0],selectedVerifiedChanges:selectedChanges,
    source:{job:{stepDigest:semanticStepDigest(step),recordedPath:old,currentPath:today},capture:{path:capture,sha256:sha256File(capture)}},
    imageSha256s:{recorded:sha256File(old),current:sha256File(today)},captureContext:{pageState:'loaded',taskContext:'verified',recordSpecificAction:false}});
  const claim={reason:'Synthetic same-task test.',evidence:'Synthetic current button is visible.',recordsIndependent:true};
  const review={schema:'semantic-repair-review-v1',bindingDigest:binding.digest,workflow:{...claim,status:'equivalent'},
    narration:{...claim,status:'rewrite',suggestedNarration:newText,preservesIntent:true,intentEvidence:'Synthetic opening the same rule creation control.'},
    target:{...claim,status:'not_applicable',currentLabel:null},linkedInterface:{...claim,status:'affected'}};
  const yes={verified:true,reason:'Synthetic independent check.',evidence:'Synthetic same-task evidence.'};
  step.semanticRepair={binding,review,metadata:{provider:'synthetic-test',model:'fixture',reviewId:'author'},verification:{bindingDigest:binding.digest,reviewDigest:digest(review),
    currentImageSha256:binding.imageSha256s.current,verifier:{kind:'model',id:'second',provider:'synthetic-test',model:'fixture',reviewId:'verifier'},
    workflow:{...yes},narration:{...yes,text:newText,preservesIntent:true,intentEvidence:'Synthetic same rule creation control.'},target:{...yes,currentLabel:null},linkedInterface:{...yes}}};
  if(!narration){
    original.steps[0].narration=identified.steps[0].narration='Open the rules page.';
    delete step.semanticRepair;step.verdict='slide_update';step.reasons=[{code:'ui_changed',verdict:'slide_update'}];
    f.write(join(repo,'scripts/Synthetic.script.json'),original);f.write(path,identified);
  }
  const candidate=f.write(join(prep,name,'candidate-manifest.json'),{baseHash:digest(identified),structuralChanges:[],changes:[{stepId:'step-0',beforeHash:digest(identified.steps[0]),imagePath:today,sha256:sha256File(today)}]});
  const job={name,status:'ok',verdict:step.verdict,complete:true,steps:[step],candidateInputs:{scriptName:name,identifiedScript:path,candidateManifest:candidate}};
  f.write(join(prep,name,'job.json'),job);
  const selected=selectWeeklyJobs([job],{readScript:()=>original});assert.equal(selected.byName.get(name).repair.decision,'auto',JSON.stringify(selected.byName.get(name)));
  f.write(join(prep,'summary.json'),{names:[name],finishedAt:'2026-11-02T12:00:00Z',videos:[{name}],uiSelection:selectionMarker(selected)});
  const bm=JSON.parse(readFileSync(join(f.baseline,'baseline-manifest.json')));
  f.write(join(f.baseline,'verification.json'),{ok:true,source_unchanged:true,manifest_sha256:sha256File(join(f.baseline,'baseline-manifest.json')),final_sha256:bm.final.sha256});
  f.write(join(f.baseline,'recordings/old.png'),png);mkdirSync(join(f.baseline,'build'));
  const calls=[],render=async({args})=>{const get=k=>args[args.indexOf(k)+1],output=get('--output'),changes=JSON.parse(readFileSync(get('--changes')));
    calls.push({output,args,changes});
    if(output.includes('control')){assert.equal(get('--take-mode'),'manifest');assert.equal(Object.hasOwn(changes.changes[0],'narration'),false);}
    else assert.equal(get('--take-mode'),narration?'elevenlabs':'manifest');
    if(args.includes('--dry-run')){f.write(join(output,'plan.json'),{ok:true,dry_run:true});return;}
    const candidate=f.write(join(output,'candidate.mp4'),output.endsWith('/control')?'synthetic baseline, not media':'synthetic repaired media');
    f.write(join(output,'verification.json'),{ok:true,source_unchanged:true,candidate,candidate_sha256:sha256File(candidate),candidate_assembly:f.write(join(output,'candidate-assembly.json'),{slides:[]})});
  };
  return {...f,repo,prep,out,calls,render,args:{name,repo,preparationDir:prep,rebaselineDir:f.baseline,outDir:out,baselineInputs:{buildDir:join(f.baseline,'build'),recordingsDir:join(f.baseline,'recordings')},fontLayout:'basic',render,log:()=>{}}};
}

test('proof-approved rewrite renders an old-narration control then transcribes only the actual repair',async t=>{
  const f=renderFixture(t),events=[];
  const transcribeNarration=async({verification,baseline,out})=>{assert.equal(f.calls.length,4);assert.equal(baseline,f.baseline);assert.equal(out,f.out);
    events.push(verification);const v=JSON.parse(readFileSync(verification)),reportPath=join(out,'transcript/transcript-report.json');
    f.write(reportPath,{schema:1,kind:'automatic-narration-transcript',ok:true,transcript:{ok:true},candidate:v.candidate,candidate_sha256:v.candidate_sha256,verification,
      verification_sha256:sha256File(verification),source_unchanged:true});return reportPath;};
  const result=await renderPreparedRepair({...f.args,allowNarration:true,transcribeNarration});
  assert.equal(result.narrationChanged,true);assert.deepEqual(result.narrationIndices,[0]);assert.equal(result.transcriptReport,join(f.out,'transcript/transcript-report.json'));
  assert.deepEqual(events,[join(f.out,'repair/verification.json')]);assert.equal(JSON.parse(readFileSync(join(f.out,'local-repair.json'))).transcriptReport,result.transcriptReport);
});
test('visual-only repairs and prepare-only narration do not invoke ASR or real TTS',async t=>{
  for(const narration of [false,true]){
    const f=renderFixture(t,{narration}),before=sha256File(join(f.baseline,'baseline.mp4'));
    const r=await renderPreparedRepair({...f.args,allowNarration:true,prepareOnly:narration,transcribeNarration:()=>assert.fail('no ASR without completed narration repair')});
    assert.equal(r.transcriptReport,undefined);assert.equal(f.calls.length,narration?2:4);assert.equal(sha256File(join(f.baseline,'baseline.mp4')),before);
  }
});
test('narration stays opt-in; ASR failure or mutation cannot produce a success result',async t=>{
  const off=renderFixture(t);await assert.rejects(()=>renderPreparedRepair({...off.args}),/local_visual_runner_rejects_narration/);assert.equal(off.calls.length,0);
  for(const mutation of ['failure','mutate','stale']){
    const f=renderFixture(t);
    await assert.rejects(()=>renderPreparedRepair({...f.args,allowNarration:true,transcribeNarration:async({verification})=>{
      if(mutation==='failure')throw new Error('transcription_failed');
      const v=JSON.parse(readFileSync(verification)),path=join(f.out,'transcript/transcript-report.json');
      f.write(path,{schema:1,kind:'automatic-narration-transcript',ok:true,transcript:{ok:true},candidate:v.candidate,candidate_sha256:v.candidate_sha256,verification,
        verification_sha256:mutation==='stale'?'0'.repeat(64):sha256File(verification),source_unchanged:true});
      if(mutation==='mutate')writeFileSync(v.candidate,'mutated');return path;
    }}),/transcript/,mutation);
    assert.equal(existsSync(join(f.out,'local-repair.json')),false);
  }
});
