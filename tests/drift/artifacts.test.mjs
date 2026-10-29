import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {putArtifact,readArtifact} from '../../tools/drift/artifacts.mjs';
test('immutable content addressing verifies size/hash and rejects symlinks',async t=>{const root=await mkdtemp(join(tmpdir(),'drift-artifacts-'));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from('synthetic');const ref=await putArtifact(root,bytes);assert.deepEqual(await readArtifact(root,ref),bytes);assert.deepEqual(await putArtifact(root,bytes),ref);await assert.rejects(readArtifact(root,{...ref,size:99}),/asset_mismatch/);await assert.rejects(readArtifact(root,{sha256:'../escape',size:1}),/invalid_asset/);await rm(join(root,ref.sha256));await writeFile(join(root,ref.sha256),'corrupt');await assert.rejects(putArtifact(root,bytes),/asset_mismatch/);await rm(join(root,ref.sha256));await symlink(join(root,'missing'),join(root,ref.sha256));await assert.rejects(readArtifact(root,ref),/unsafe_asset/);});
