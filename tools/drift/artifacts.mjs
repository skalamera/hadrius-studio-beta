import {mkdir,open,readFile,link,unlink,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {bytesDigest,requireValue} from './contracts.mjs';
export async function readRegular(file){
  requireValue((await lstat(file)).isFile(),'unsafe_asset');
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{requireValue((await fd.stat()).isFile(),'unsafe_asset');return await fd.readFile();}finally{await fd.close();}
}
export async function readArtifact(root,ref){requireValue(/^[a-f0-9]{64}$/.test(ref?.sha256??'')&&Number.isSafeInteger(ref.size)&&ref.size>=0,'invalid_asset');const bytes=await readRegular(join(root,ref.sha256));requireValue(bytes.length===ref.size&&bytesDigest(bytes)===ref.sha256,'asset_mismatch');return bytes;}
export async function putArtifact(root,value){const bytes=Buffer.from(value),ref={sha256:bytesDigest(bytes),size:bytes.length};await mkdir(root,{recursive:true,mode:0o700});requireValue((await lstat(root)).isDirectory(),'unsafe_asset');const temp=join(root,`.pending-${randomUUID()}`);let fd;try{fd=await open(temp,'wx',0o400);await fd.writeFile(bytes);await fd.sync();await fd.close();fd=null;try{await link(temp,join(root,ref.sha256));}catch(e){if(e.code!=='EEXIST')throw e;}}finally{await fd?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}await readArtifact(root,ref);return ref;}
