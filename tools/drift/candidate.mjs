// Local preparation only. Never imports bridge/config, renders, or publishes.
import {mkdir,writeFile,readFile,rm,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {identify,digest,bytesDigest,requireValue,applyVisualPatch} from './contracts.mjs';
import {readRegular,putArtifact,readArtifact} from './artifacts.mjs';
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);
function filename(value){requireValue(typeof value==='string'&&/^[A-Za-z0-9_.-]+\.png$/.test(value)&&!value.startsWith('.'),'unsupported_asset');return value;}
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
// Validate full chunk CRCs, zlib stream and non-interlaced 8-bit raster size.
// Unsupported PNG profiles/clips fail closed; no external decoder is invoked.
export function validatePng(b){
  requireValue(b.length>=33&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),'invalid_png');
  let pos=8,header,ended=false,idat=[];
  while(pos<b.length){requireValue(pos+12<=b.length,'invalid_png');const n=b.readUInt32BE(pos);requireValue(pos+12+n<=b.length,'invalid_png');const type=b.toString('ascii',pos+4,pos+8),data=b.subarray(pos+8,pos+8+n);requireValue(crc(b.subarray(pos+4,pos+8+n))===b.readUInt32BE(pos+8+n),'invalid_png');if(!header){requireValue(type==='IHDR'&&n===13,'invalid_png');header=Buffer.from(data);}else requireValue(type!=='IHDR','invalid_png');if(type==='IDAT')idat.push(data);if(type==='IEND'){requireValue(n===0&&pos+12===b.length,'invalid_png');ended=true;}pos+=12+n;}
  requireValue(ended&&idat.length,'invalid_png');const w=header.readUInt32BE(0),h=header.readUInt32BE(4),channels={0:1,2:3,4:2,6:4}[header[9]];
  requireValue(w>0&&h>0&&w<=16384&&h<=16384&&channels&&header[8]===8&&header[10]===0&&header[11]===0&&header[12]===0,'invalid_png');
  let raw;try{raw=inflateSync(Buffer.concat(idat),{maxOutputLength:128*1024*1024});}catch{throw new Error('invalid_png');}const stride=w*channels+1;requireValue(raw.length===stride*h,'invalid_png');for(let row=0;row<h;row++)requireValue(raw[row*stride]<=4,'invalid_png');return {width:w,height:h};
}
async function inside(root,file){const r=await realpath(root),f=await realpath(file),rel=relative(r,f);requireValue(rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel),'unsafe_asset');return f;}
export async function createCandidate({baseScriptPath,recordingsRoot,manifest,outputRoot}){
  requireValue(manifest&&Object.keys(manifest).every(k=>['baseHash','structuralChanges','changes'].includes(k)),'invalid_manifest');
  const baseBytes=await readRegular(baseScriptPath),source=JSON.parse(baseBytes);requireValue(digest(source)===manifest.baseHash,'base_conflict');
  // Existing IDs are retained; migration is candidate-local and archived, never saved over source.
  const base=identify(source);requireValue(token(base.recording?.id),'invalid_recording');
  const recRoot=join(resolve(recordingsRoot),base.recording.id);requireValue((await lstat(recRoot)).isDirectory(),'unsafe_asset');await inside(recordingsRoot,recRoot);
  const assets=new Map();
  for(const step of base.steps){if(step.capture!==false)requireValue(step.media?.pre,'capture_required');if(step.captureId&&step.media?.pre)requireValue(step.media.pre===`step_${step.captureId}.png`,'ambiguous_capture');
    for(const value of Object.values(step.media??{})){if(value===null)continue;const name=filename(value);const file=join(recRoot,name);await inside(recRoot,file);const bytes=await readRegular(file);validatePng(bytes);assets.set(name,bytes);}}
  requireValue(Array.isArray(manifest.changes),'invalid_manifest');const replacements=[];
  for(const change of manifest.changes){requireValue(change&&Object.keys(change).every(k=>['stepId','beforeHash','imagePath','sha256','target','dpr'].includes(k)),'field_not_allowed');const old=base.steps.find(s=>s.id===change.stepId);requireValue(old,'unknown_step');requireValue(digest(old)===change.beforeHash,'step_conflict');const bytes=await readRegular(change.imagePath);validatePng(bytes);const hash=bytesDigest(bytes);requireValue(hash===change.sha256,'asset_mismatch');const name=`step_${hash}.png`;if(assets.has(name))requireValue(assets.get(name).equals(bytes),'asset_collision');assets.set(name,bytes);replacements.push({stepId:change.stepId,fields:{media:{...old.media,pre:name},captureId:hash,...(Object.hasOwn(change,'target')?{target:change.target}:{}),...(Object.hasOwn(change,'dpr')?{dpr:change.dpr}:{})}});}
  const normalizedPlan={...manifest,baseHash:digest(base)};const candidate=applyVisualPatch(base,normalizedPlan,replacements);
  const recordingId=`drift-${randomUUID()}`;candidate.recording={...candidate.recording,id:recordingId};
  // All validation precedes exclusive ownership of a new output directory.
  const out=join(await realpath(dirname(resolve(outputRoot))),basename(resolve(outputRoot)));const relativeOutput=relative(await realpath(recRoot),out);requireValue(relativeOutput.startsWith('..')||isAbsolute(relativeOutput),'unsafe_output');
  await mkdir(out,{mode:0o700});
  try{const recordingPath=join(out,'_recordings',recordingId);await mkdir(recordingPath,{recursive:true,mode:0o700});const assetManifest=[];
    for(const [name,bytes] of assets){const ref=await putArtifact(join(out,'artifacts'),bytes);await writeFile(join(recordingPath,name),await readArtifact(join(out,'artifacts'),ref),{flag:'wx',mode:0o400});requireValue(bytesDigest(await readRegular(join(recordingPath,name)))===ref.sha256,'asset_mismatch');assetManifest.push({name,...ref});}
    requireValue((await readRegular(baseScriptPath)).equals(baseBytes),'base_conflict');for(const [name,bytes] of assets){if(name===`step_${bytesDigest(bytes)}.png`&&!source.steps.some(s=>Object.values(s.media??{}).includes(name)))continue;requireValue((await readRegular(join(recRoot,name))).equals(bytes),'asset_conflict');}
    const scriptPath=join(out,'candidate.script.json');await writeFile(scriptPath,JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o400});await writeFile(join(out,'base.script.json'),baseBytes,{flag:'wx',mode:0o400});await writeFile(join(out,'identified-base.script.json'),JSON.stringify(base,null,2)+'\n',{flag:'wx',mode:0o400});
    const report={schema:1,status:'local_candidate_ready',baseHash:digest(source),identifiedBaseHash:digest(base),candidateHash:digest(candidate),recordingId,changedStepIds:manifest.changes.map(c=>c.stepId),assets:assetManifest,renderReady:false,outputEqualityVerified:false};await writeFile(join(out,'manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o400});return {...report,scriptPath,recordingPath};
  }catch(e){await rm(out,{recursive:true,force:true});throw e;}
}
export async function main(args=process.argv.slice(2)){
  requireValue(args.length===8&&args[0]==='--base'&&args[2]==='--recordings-root'&&args[4]==='--manifest'&&args[6]==='--output','usage: candidate.mjs --base SCRIPT --recordings-root ROOT --manifest JSON --output NEW_DIRECTORY');
  const manifestPath=resolve(args[5]);const manifest=JSON.parse(await readRegular(manifestPath));for(const change of manifest.changes??[])if(typeof change.imagePath==='string')change.imagePath=resolve(dirname(manifestPath),change.imagePath);
  const result=await createCandidate({baseScriptPath:resolve(args[1]),recordingsRoot:resolve(args[3]),manifest,outputRoot:resolve(args[7])});console.log(JSON.stringify(result,null,2));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
