import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { validateRoleSwitchSource, loadRoleSwitchSource, revalidateRoleSwitchSource } from '../../tools/drift/role-switch-source.mjs';
// Complete real eligibility blobs; tests need no production mirror or network.
const SNAPSHOTS = JSON.parse(inflateSync(Buffer.from('eJyFVt9v3DYM/leYeyh8WeZbt4cVF6SHoljRAENb9NbtIc4cxabPWmzJE+VLgyT/eyn5x9k55/ImWSL58eNHyvczUVW0yEVqZE0/82ZBJlmISi5EbXO3iBOhYrqVNsljowsMLc2WMJNlpY2Fe6gJ3+uyEuoOHiEzuoRoNvKxQRsnzY1odhqpCcuPgj6gsLXBAz5KndYFxhWaUhJJrWjsLhf0Li2l+lvi7blaY4GJxfQwthwL9kd7uL4RmudMtL6h2C29VaTwu7fLapVYRuXTEmrtGfvKhAXzJVxrXggF95ECSBi6hZYSOBvwEMxPdxc8EIfirEM0OuZ0/yirQt+hty6kUAmOvO1YDaIZtnfj5A1Gs8aRQT5UELg1wNHRtMtXr7rzDvLui0O4CgupbjCNuxAUki4xCLr9HM7eQrcJ+7zPzjoOQpnOe6cHyxi4gCdDO2fksnmM1OwEXpBzW+6nEuaQ72uyDNp8kKZcW5Fl75IEiZ7RgGsLcrfGwlkXsjysN3tXIU13wwHJNVYu9bGJU9e+SV+GhWtXaq39ulXs4viYaTuGL8IQgoCrFlAs0yv4v0ZzB5UwogSprObzSpO0cotujxs0IfzF3oywSPBfrW6AiUaVYgp83eYIqi6vGayLEWC4CeHq919/i2aLqwar0wsQzxXFxWAV3hp2rzasESEL9vLt6580P23lSVCz60wqPrjNUYHSwL2UOoMOj4u02O/EyuXXFuQ8/eJSCraiqHEJZI1z8NAuLi55uYvzwBkUBfdtk8jozLewzCBwvOoMvEM4YjVzCbwzbq+utXqzQeOWggcDN+ri3yii4yCK0p/mixC/Y9KAa3rTRTjyVw86S7rs2OEnDzbwRhevL0c93pyFktYiw/OGtqA3dt03cPUWfoHVYL8chX6cGnqU67pIWcOft2i23Lof3QiQTSv386/rXIm0HHbLxeXTGdnCbh3s4LFlWKDa2JxRvu7QsKChC8w2kHNwyLRh7Wbc0MCzOIckl0Xq93QCQqXuoihIg2bxghe6v2xzwbwyEK2utTB8z5I7Yba1wnBSaU3661zfdjD8UN3LvyncNAXNoVCfm7AsV6uagURDB88wdbAAA97n8PAAwZDXyYjzjtr2sdFFuhvLrLXAzZOln0B+vPs/A+HJoLiQZFehVElRp0j8+FSFsFyOMhTORezghdeCZBILP2Zdx6xWkHE5cPJNHT4KzWT2L8GymZpNuw679ClJvpucRd9MXayewOcfgaAxdLy5VehH6ap55MbE7LKYD6X5T448FY0fjZ4B6ITaSc+d+Neez9ya2mevf+ngk9jKjfBkaFXcncLGCMXC5Gm4+yOaFufLL+qIx5M+ej86pwbhsxQ7oo72XEwQ7yxeYr03s6YelWuvEpOKHP5s7EFy6h/Xz/uYj7To/isefwCIF/1f', 'base64')));
import {FLOW_EQUIVALENCE_SOURCE} from '../../tools/drift/flow-equivalence.mjs';

const names=['apps/hadrius-app/src/api/auth/api_can_switch_role.ts','apps/hadrius-app/src/api/auth/helpers.ts'];
const fixture=()=>({commit:FLOW_EQUIVALENCE_SOURCE.commit,files:names.map(path=>({path,text:'unverified excerpt',sha256:'0'.repeat(64),blobSha:'0'.repeat(40)}))});

test('eligibility rejects missing identity or files; legacy evidence is limited to the reviewed PIN',()=>{
  for(const x of [null,{verified:true},{commit:'0'.repeat(40),files:[]},{commit:FLOW_EQUIVALENCE_SOURCE.commit,files:[]}])assert.throws(()=>validateRoleSwitchSource(x),/identity_conflict/);
});
test('caller claims and excerpts cannot stand in for full source bytes with both hash pins',()=>{
  assert.throws(()=>validateRoleSwitchSource(fixture()),/hash_conflict/);
  const x=fixture();delete x.files[0].text;assert.throws(()=>validateRoleSwitchSource(x),/bytes_required/);
});
test('eligibility cannot be inferred from another path or duplicate source handle',()=>{
  const x=fixture();x.files[0].path='apps/hadrius-app/unrelated.ts';assert.throws(()=>validateRoleSwitchSource(x),/file_conflict/);
  const y=fixture();y.files=[y.files[0],y.files[0]];assert.throws(()=>validateRoleSwitchSource(y),/file_conflict/);
});

function repository(t) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'role-source-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const frontendGitDir = join(root, 'frontend.git');
  execFileSync('git', ['init', '--quiet', '--bare', frontendGitDir]);
  const git = (args, input) => execFileSync('git', ['--git-dir', frontendGitDir, ...args], { input, encoding: 'utf8' }).trim();
  const commit = (snapshots = SNAPSHOTS) => {
    const tree = {};
    for (const [path, text] of Object.entries(snapshots)) {
      const parts = path.split('/'), name = parts.pop(); let node = tree;
      for (const part of parts) node = node[part] ||= {};
      node[name] = git(['hash-object', '-w', '--stdin'], text);
    }
    const saveTree = node => git(['mktree'], Object.entries(node).map(([name, value]) =>
      typeof value === 'string' ? `100644 blob ${value}\t${name}\n` : `040000 tree ${saveTree(value)}\t${name}\n`).join(''));
    return git(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${saveTree(tree)}\nauthor Offline <test@example.test> 1793653200 +0000\ncommitter Offline <test@example.test> 1793653200 +0000\n\nEligibility deployment\n`);
  };
  return { frontendGitDir, git, commit };
}

test('eligibility loads both complete pinned files at exact actual deployment and persists source binding', t => {
  const f = repository(t), captureCommit = f.commit(), options = { frontendGitDir: f.frontendGitDir, captureCommit };
  const evidence = loadRoleSwitchSource(options);
  assert.notEqual(captureCommit, FLOW_EQUIVALENCE_SOURCE.commit);
  assert.equal(evidence.commit, captureCommit);
  assert.equal(evidence.captureCommit, captureCommit);
  assert.equal(evidence.reviewedAtCommit, FLOW_EQUIVALENCE_SOURCE.commit);
  assert.equal(validateRoleSwitchSource(evidence, { captureCommit }), true);
  const persisted = JSON.parse(JSON.stringify(evidence));
  assert.equal(revalidateRoleSwitchSource(persisted, options), true);
  assert.equal(revalidateRoleSwitchSource(persisted, { frontendGitDir: f.frontendGitDir }), true);
  for (const change of [
    x => { x.commit = FLOW_EQUIVALENCE_SOURCE.commit; },
    x => { x.captureCommit = FLOW_EQUIVALENCE_SOURCE.commit; },
    x => { x.reviewedAtCommit = captureCommit; },
    x => { delete x.reviewedAtCommit; },
    x => { x.files[0].text += '\n'; },
  ]) { const changed = structuredClone(persisted); change(changed); assert.throws(() => validateRoleSwitchSource(changed)); }
  assert.throws(() => revalidateRoleSwitchSource(persisted, { ...options, captureCommit: FLOW_EQUIVALENCE_SOURCE.commit }), /identity_conflict/);
  // Removing provenance must not downgrade another commit to the legacy reviewed-PIN shape.
  delete persisted.reviewedAtCommit; delete persisted.captureCommit;
  assert.throws(() => validateRoleSwitchSource(persisted), /identity_conflict/);
});

test('either eligibility blob changing at the actual deployment fails closed', t => {
  const f = repository(t);
  for (const path of names) {
    const captureCommit = f.commit({ ...SNAPSHOTS, [path]: `${SNAPSHOTS[path]}\n// altered eligibility\n` });
    assert.throws(() => loadRoleSwitchSource({ frontendGitDir: f.frontendGitDir, captureCommit }), /hash_conflict/);
  }
});

test('eligibility refuses revisions, noncommit objects, source redirection and replacement refs offline', t => {
  const f = repository(t), captureCommit = f.commit(), options = { frontendGitDir: f.frontendGitDir, captureCommit };
  const evidence = loadRoleSwitchSource(options), blob = evidence.files[0].blobSha;
  for (const bad of ['HEAD', `${captureCommit}~0`, `${captureCommit}\n`, null]) {
    assert.throws(() => loadRoleSwitchSource({ ...options, captureCommit: bad }), /capture_commit_required/);
  }
  assert.throws(() => loadRoleSwitchSource({ ...options, captureCommit: blob }), /not_commit/);
  const wrong = f.git(['hash-object', '-w', '--stdin'], 'wrong eligibility source');
  f.git(['replace', blob, wrong]);
  assert.deepEqual(loadRoleSwitchSource(options), evidence, 'replace refs cannot alter immutable reads');
  rmSync(join(f.frontendGitDir, 'objects', blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => revalidateRoleSwitchSource(evidence, options), /Command failed/);
});
