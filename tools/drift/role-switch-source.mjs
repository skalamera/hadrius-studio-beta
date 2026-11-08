// Extra immutable source evidence for the EXISTING narration's role-switch eligibility clause.
// This is not permission to perform admin actions and never clears a workflow/target guard.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {digest,bytesDigest,requireValue} from './contracts.mjs';
import {FLOW_EQUIVALENCE_SOURCE} from './flow-equivalence.mjs';

const PINS=[
  {path:'apps/hadrius-app/src/api/auth/api_can_switch_role.ts',sha256:'ae4e725969bc4127cf5cd2e6f34719b6c9f68d0eec9866a66c4ecb6e13e6559c',blobSha:'20fef0094b83284426b26d217fab0794b22c4c0c'},
  {path:'apps/hadrius-app/src/api/auth/helpers.ts',sha256:'d6c064022391db1bc26c87ce0efca4c1e51d670adbe4e1a9ea0f8946f526c9e2',blobSha:'a4d10717eec6ee7b40a089f7e24ce34be01530f6'},
];
const MIRROR=fileURLToPath(new URL('../../.drift-cache/frontend.git',import.meta.url));

export function validateRoleSwitchSource(evidence,{captureCommit}={}){
  const legacy=evidence&&!Object.hasOwn(evidence,'reviewedAtCommit')&&!Object.hasOwn(evidence,'captureCommit');
  const actual=legacy?evidence.commit:evidence?.captureCommit;
  requireValue(typeof actual==='string'&&actual.length===40&&/^[a-f0-9]{40}$/.test(actual)
    &&evidence.commit===actual&&(legacy?actual===FLOW_EQUIVALENCE_SOURCE.commit:evidence.reviewedAtCommit===FLOW_EQUIVALENCE_SOURCE.commit)
    &&(captureCommit===undefined||actual===captureCommit)
    &&Array.isArray(evidence.files)&&evidence.files.length===PINS.length,'role_switch_source_identity_conflict');
  for(const pin of PINS){
    const matches=evidence.files.filter(x=>x.path===pin.path);
    requireValue(matches.length===1,'role_switch_source_file_conflict');
    const f=matches[0];requireValue(typeof f.text==='string','role_switch_source_bytes_required');
    const b=Buffer.from(f.text),blob=createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
    requireValue(f.sha256===pin.sha256&&bytesDigest(b)===pin.sha256&&f.blobSha===pin.blobSha&&blob===pin.blobSha,'role_switch_source_hash_conflict');
  }
  return true;
}
export function loadRoleSwitchSource({frontendGitDir=MIRROR,captureCommit=FLOW_EQUIVALENCE_SOURCE.commit}={}){
  requireValue(typeof captureCommit==='string'&&captureCommit.length===40&&/^[a-f0-9]{40}$/.test(captureCommit),'role_switch_source_capture_commit_required');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
  Object.assign(env,{GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'});
  const git=args=>execFileSync('git',['--git-dir',resolve(frontendGitDir),'-c','protocol.allow=never',...args],{env,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
  requireValue(git(['cat-file','-t',captureCommit]).toString('utf8').trim()==='commit','role_switch_source_not_commit');
  const files=PINS.map(pin=>({...pin,text:git(['show',`${captureCommit}:${pin.path}`]).toString('utf8')}));
  const evidence={commit:captureCommit,reviewedAtCommit:FLOW_EQUIVALENCE_SOURCE.commit,captureCommit,files};validateRoleSwitchSource(evidence);return evidence;
}
export function revalidateRoleSwitchSource(evidence,options={}){
  validateRoleSwitchSource(evidence,{captureCommit:options.captureCommit});
  const fresh=loadRoleSwitchSource({...options,captureCommit:evidence.captureCommit??evidence.commit});
  // Preserve exact-PIN legacy review bindings; do not reinterpret old evidence at a new commit.
  if(!Object.hasOwn(evidence,'reviewedAtCommit')&&!Object.hasOwn(evidence,'captureCommit')){
    delete fresh.reviewedAtCommit;delete fresh.captureCommit;
  }
  requireValue(digest(evidence)===digest(fresh),'role_switch_source_stale');
  return true;
}
