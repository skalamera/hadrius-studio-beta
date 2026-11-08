import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexReviewArgs, runCodexReview } from '../../tools/drift/codex-review.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const image = join(root, 'image.png'); writeFileSync(image, 'test-image-bytes');
  return { root, image };
}
const schema = { type: 'object', properties: { accurate: { type: 'boolean' } }, required: ['accurate'], additionalProperties: false };
test('argv keeps the prompt out of variadic image arguments and disables external tools', () => {
  const args = codexReviewArgs({ model: 'test-model', images: ['/one image.png', '/two.png'], schemaPath: '/s.json', outputPath: '/o.json' });
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  assert.deepEqual(args.slice(-3), ['--image=/one image.png', '--image=/two.png', '-']);
  assert.ok(args.includes('read-only'));
  for (const name of ['shell_tool', 'unified_exec', 'hooks', 'plugins', 'apps', 'browser_use', 'computer_use', 'multi_agent']) assert.ok(args.includes(name));
  assert.throws(() => codexReviewArgs({ model: 'x', images: [], schemaPath: 's', outputPath: 'o' }), /images_required/);
  assert.throws(() => codexReviewArgs({ model: 'x', images: ['x'], effort: 'max' }), /invalid_effort/);
});
test('checkpoint reuse requires exact prompt, image bytes, schema, model and effort', async t => {
  const { root, image } = fixture(t); let calls = 0;
  const run = async (_bin, args, opts) => {
    calls++; assert.equal(opts.prompt, 'Inspect image.');
    writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ accurate: true }));
    return { stdout: '', stderr: 'model: test-model\n' };
  };
  const input = { prompt: 'Inspect image.', images: [image], schema, outputDir: root, model: 'test-model', run };
  const a = await runCodexReview(input), b = await runCodexReview(input);
  assert.equal(a.cached, false); assert.equal(b.cached, true); assert.equal(calls, 1);
  writeFileSync(image, 'different-bytes');
  const c = await runCodexReview(input); assert.equal(c.cached, false); assert.equal(calls, 2); assert.notEqual(a.key, c.key);
  await runCodexReview({ ...input, effort: 'high' }); assert.equal(calls, 3);
  await runCodexReview({ ...input, schema: { ...schema, title: 'version 2' } }); assert.equal(calls, 4);
});
test('provider model metadata must agree; image mutation during review fails closed', async t => {
  const { root, image } = fixture(t);
  const run = async (_bin, args) => {
    writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ accurate: true }));
    return { stdout: '', stderr: 'model: other-model\n' };
  };
  const input = { prompt: 'test', images: [image], schema, outputDir: root, model: 'test-model', run };
  await assert.rejects(runCodexReview(input), /model_unverified/);
  await assert.rejects(runCodexReview({ ...input, run: async (...args) => {
    const result = await run(...args); writeFileSync(image, 'changed'); return { ...result, stderr: 'model: test-model\n' };
  } }), /image_changed/);
});

test('a durable cache hit uses no live budget; invalid answers never become reusable checkpoints', async t => {
  const {root,image}=fixture(t);let live=0,charged=0;
  const input={prompt:'budgeted review',images:[image],schema,outputDir:root,model:'test-model',
    beforeRun:()=>{charged++;},validateAnswer:raw=>assert.equal(raw.accurate,true),
    run:async(_bin,args)=>{live++;writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({accurate:true}));return {stderr:'model: test-model\n'};}};
  await runCodexReview(input);
  const cached=await runCodexReview({...input,beforeRun:()=>{throw new Error('budget exhausted');}});
  assert.equal(cached.cached,true);assert.equal(live,1);assert.equal(charged,1);
  await assert.rejects(()=>runCodexReview({...input,prompt:'invalid',validateAnswer:()=>{throw new Error('malformed');}}),/malformed/);
  await runCodexReview({...input,prompt:'invalid'});assert.equal(live,3);
});
