// Opt-in, image-only Codex review. No bridge import, no publishing and no inherited MCP/config.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export function codexReviewArgs({ model, effort = 'medium', images, schemaPath, outputPath }) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('codex_model_required');
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('codex_invalid_effort');
  if (!Array.isArray(images) || !images.length || images.some(p => typeof p !== 'string' || !p)) throw new Error('codex_images_required');
  return ['--ask-for-approval', 'never', 'exec', '--model', model, '--sandbox', 'read-only',
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--color', 'never',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks', '--disable', 'plugins',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'multi_agent',
    '-c', `model_reasoning_effort="${effort}"`, '-c', 'web_search="disabled"',
    '--output-schema', schemaPath, '--output-last-message', outputPath,
    ...images.map(p => `--image=${p}`), '-'];
}

export function runReviewProcess(bin, args, { prompt, cwd, timeoutMs = 300_000, signal, spawnProcess = spawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const child = spawnProcess(bin, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = null;
    const kill = (why) => { stopped = why; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const abort = () => kill('cancelled');
    const timer = setTimeout(() => kill('codex_review_timeout'), timeoutMs);
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', b => { stdout += b.toString(); if (stdout.length > 8_000_000) kill('codex_output_limit'); });
    child.stderr.on('data', b => { stderr += b.toString(); if (stderr.length > 8_000_000) kill('codex_output_limit'); });
    child.once('error', e => { clear(); reject(e); });
    child.once('close', code => {
      clear();
      if (stopped) return reject(new Error(stopped));
      if (code !== 0) return reject(new Error(`codex_review_failed:${String(stderr || stdout || code).replace(/\s+/g, ' ').slice(-500)}`));
      resolvePromise({ stdout, stderr });
    });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') { clear(); reject(e); } });
    child.stdin.end(prompt);
  });
}

/** Every answer is checkpointed under a content key that includes exact prompt, image bytes, schema and model. */
export async function runCodexReview({ prompt, images, schema, outputDir, model = 'gpt-6.1-sol', effort = 'medium',
  binary = process.env.KBS_CODEX_BIN || 'codex', signal, timeoutMs, beforeRun = () => {}, validateAnswer = () => {}, run = runReviewProcess } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('codex_prompt_required');
  const imageHashes = images.map(path => ({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const schemaText = JSON.stringify(schema);
  const key = createHash('sha256').update(JSON.stringify({ prompt, imageHashes, schema, model, effort, version: 1 })).digest('hex');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const checkpoint = join(outputDir, `${key}.review.json`);
  if (existsSync(checkpoint)) {
    const prior = JSON.parse(readFileSync(checkpoint, 'utf8'));
    if (prior.key !== key || prior.model !== model || prior.effort !== effort) throw new Error('codex_checkpoint_conflict');
    validateAnswer(prior.raw);
    return { ...prior, cached: true };
  }
  // The weekly budget is charged only here: validated durable cache hits need no live model allowance.
  await beforeRun();
  const schemaPath = join(outputDir, `${key}.schema.json`), outputPath = join(outputDir, `${key}.answer.json`);
  writeFileSync(schemaPath, schemaText + '\n', { mode: 0o600 });
  const args = codexReviewArgs({ model, effort, images: imageHashes.map(x => x.path), schemaPath, outputPath });
  const result = await run(binary, args, { prompt, cwd: outputDir, signal, timeoutMs });
  const raw = JSON.parse(readFileSync(outputPath, 'utf8'));
  validateAnswer(raw);
  // The CLI text header is provider evidence, not the model's own claim in its answer.
  const actual = result.stderr.match(/^model:\s*(\S+)/m)?.[1];
  if (!actual || actual !== model) throw new Error(`codex_model_unverified:${actual || 'missing'}`);
  for (const image of imageHashes) if (createHash('sha256').update(readFileSync(image.path)).digest('hex') !== image.sha256) throw new Error('codex_image_changed');
  const reviewed = { schema: 1, key, provider: 'codex-cli', model: actual, effort, imageHashes, raw, createdAt: new Date().toISOString() };
  writeFileSync(checkpoint, JSON.stringify(reviewed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...reviewed, cached: false };
}

/** Primary Claude vision review via claude-cli (Read tool for attached images) with automatic Codex fallback. */
export async function runClaudeWithCodexFallback({ prompt, images, schema, outputDir, model = 'gpt-6.1-sol', effort = 'medium',
  binary = process.env.KBS_CODEX_BIN || 'codex', signal, timeoutMs = 300_000, beforeRun = () => {}, validateAnswer = () => {}, run = runReviewProcess, runClaudeFn = null } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('codex_prompt_required');
  const imageHashes = images.map(path => ({ path: resolve(path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const claudeModel = process.env.KBS_DECISION_MODEL || 'claude-sonnet-5';
  const claudeKey = createHash('sha256').update(JSON.stringify({ prompt, imageHashes, schema, model: claudeModel, effort, provider: 'claude-cli', version: 1 })).digest('hex');
  const codexKey = createHash('sha256').update(JSON.stringify({ prompt, imageHashes, schema, model, effort, version: 1 })).digest('hex');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const claudeCheckpoint = join(outputDir, `${claudeKey}.review.json`);
  if (existsSync(claudeCheckpoint)) {
    const prior = JSON.parse(readFileSync(claudeCheckpoint, 'utf8'));
    if (prior.key !== claudeKey || prior.model !== claudeModel || prior.effort !== effort) throw new Error('codex_checkpoint_conflict');
    validateAnswer(prior.raw);
    return { ...prior, cached: true };
  }
  const codexCheckpoint = join(outputDir, `${codexKey}.review.json`);
  if (existsSync(codexCheckpoint)) {
    const prior = JSON.parse(readFileSync(codexCheckpoint, 'utf8'));
    if (prior.key !== codexKey || prior.model !== model || prior.effort !== effort) throw new Error('codex_checkpoint_conflict');
    validateAnswer(prior.raw);
    return { ...prior, cached: true };
  }
  await beforeRun();
  try {
    const cs = await import('../coverage-scan.mjs');
    const execClaude = runClaudeFn ?? cs.runClaude;
    const attachmentLines = imageHashes.map((img, idx) => `Attachment ${idx + 1} (${idx === 0 ? 'RECORDED image' : idx === 1 ? 'CURRENT image' : 'POST-ACTION image'}): ${img.path}`).join('\n');
    const claudePrompt = [
      'IMPORTANT: Use the Read tool to open and inspect each attached image file below in order before answering (Read is permitted and required solely for these exact image files):',
      attachmentLines,
      '',
      prompt,
      '',
      'CRITICAL SCHEMA RULES FOR CLAUDE:',
      '1. When narration.status is "accurate" (including when scriptStep has empty/absent narration and caption, which must be marked narration.status="accurate"), you MUST set narration.preservesIntent=true and explain in intentEvidence why the step\'s instructional intent is still supported. Never set preservesIntent=false just because no rewrite was needed.',
      '2. When captureContext.pageState is "empty", set recordsIndependent=true on every area (workflow, narration, target, linkedInterface) whose claim or control is a screen-level UI element (header button, tab, banner, sidebar) that does not depend on table data rows.',
      'Return ONLY a single JSON object matching the required schema, with no markdown fences or prose.',
    ].join('\n');
    const rawText = await execClaude(claudePrompt, {
      allowedTools: 'Read',
      addDirs: [...new Set(imageHashes.map(x => dirname(x.path)))],
      maxTurns: 8,
      timeout: timeoutMs,
      model: claudeModel,
    });
    const raw = cs.extractJson(rawText);
    validateAnswer(raw);
    for (const image of imageHashes) if (createHash('sha256').update(readFileSync(image.path)).digest('hex') !== image.sha256) throw new Error('claude_image_changed');
    const reviewed = { schema: 1, key: claudeKey, provider: 'claude-cli', model: claudeModel, effort, imageHashes, raw, createdAt: new Date().toISOString() };
    writeFileSync(claudeCheckpoint, JSON.stringify(reviewed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ...reviewed, cached: false };
  } catch (error) {
    if (signal?.aborted || process.env.KBS_DRIFT_REVIEW_FALLBACK_PROVIDER === 'none') throw error;
    console.error(`[review] claude semantic review failed (${String(error?.message || error).slice(0, 200)}); falling back to codex`);
    return await runCodexReview({ prompt, images, schema, outputDir, model, effort, binary, signal, timeoutMs, beforeRun: () => {}, validateAnswer, run });
  }
}
