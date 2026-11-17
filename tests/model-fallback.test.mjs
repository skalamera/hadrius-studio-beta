// Claude first, Codex as the fallback: the operator's standing choice for the Studio's model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallback, fallbackEnabled } from '../tools/model-fallback.mjs';

const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms) => { t += ms; } }; };
const counted = (impl) => { const f = async () => { f.calls++; return impl(); }; f.calls = 0; return f; };
const fails = (message, extra = {}) => counted(() => { throw Object.assign(new Error(message), extra); });

test('Claude answers when it can; Codex is not called', async () => {
  const fb = createFallback();
  const claude = counted(() => 'claude answer'), codex = counted(() => 'codex answer');
  assert.equal(await fb.run(claude, codex), 'claude answer');
  assert.equal(codex.calls, 0);
});

test('any Claude failure but a cancel is answered by Codex, and the next call tries Claude again', async () => {
  const fb = createFallback(), notes = [];
  const claude = fails('claude: timed out after 300s'), codex = counted(() => 'codex answer');
  assert.equal(await fb.run(claude, codex, { onFallback: (why) => notes.push(why) }), 'codex answer');
  assert.deepEqual(notes, ['claude: timed out after 300s']);
  await fb.run(claude, codex);
  assert.equal(claude.calls, 2, 'a one-off failure does not take Claude out of rotation');
});

test('after a usage limit or a lost sign-in Claude is skipped for the cool-down, then tried again', async () => {
  for (const why of ["claude: You've hit your usage limit · resets 3pm", "Claude isn't connected on this Mac", 'claude: Not logged in']) {
    const c = clock(), fb = createFallback({ cooldownMs: 600_000, now: c.now });
    const claude = fails(why), codex = counted(() => 'codex answer');
    await fb.run(claude, codex);
    await fb.run(claude, codex);
    assert.equal(claude.calls, 1, `skipped while cooling down: ${why}`);
    assert.equal(codex.calls, 2);
    c.advance(600_001);
    await fb.run(claude, codex);
    assert.equal(claude.calls, 2, 'Claude is first again once the cool-down is over');
  }
});

test('a cancel is never answered by the fallback', async () => {
  const fb = createFallback(), codex = counted(() => 'codex answer');
  await assert.rejects(fb.run(fails('cancelled'), codex), /^Error: cancelled$/);
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(fb.run(fails('claude: killed'), codex, { signal: ctl.signal }), /killed/);
  assert.equal(codex.calls, 0);
});

test('a Mac without the Codex CLI gets Claude\'s own error back', async () => {
  const fb = createFallback();
  const claude = fails("claude: You've hit your usage limit"), codex = fails('spawn codex ENOENT', { code: 'ENOENT' });
  await assert.rejects(fb.run(claude, codex), (e) => e.message === "claude: You've hit your usage limit");
  await fb.run(claude, counted(() => 'x'));
  assert.equal(claude.calls, 2, 'no cool-down when Codex never answered');
});

test('when both fail, the error names both, so a usage limit is still recognised as an outage', async () => {
  const fb = createFallback();
  await assert.rejects(fb.run(fails("claude: You've hit your usage limit"), fails('codex: stream disconnected')),
    (e) => /usage limit/.test(e.message) && /Codex fallback also failed: codex: stream disconnected/.test(e.message));
});

test('while Claude is cooling down and Codex fails, Claude is tried', async () => {
  const c = clock(), fb = createFallback({ now: c.now });
  await fb.run(fails('claude: rate_limit_error'), counted(() => 'codex'));
  const claude = counted(() => 'claude answer');
  assert.equal(await fb.run(claude, fails('codex: 500 Internal Server Error')), 'claude answer');
  assert.equal(claude.calls, 1);
});

test('the fallback can be turned off', async () => {
  assert.equal(fallbackEnabled({}), true);
  assert.equal(fallbackEnabled({ KBS_AI_FALLBACK_PROVIDER: 'codex' }), true);
  assert.equal(fallbackEnabled({ KBS_AI_FALLBACK_PROVIDER: 'none' }), false);
  const fb = createFallback(), codex = counted(() => 'codex answer');
  await assert.rejects(fb.run(fails('claude: boom'), codex, { enabled: false }), /boom/);
  assert.equal(codex.calls, 0);
});

test('when both Claude and Codex fail, optional third fallback (Agy) answers', async () => {
  const fb = createFallback();
  const third = counted(() => 'agy answer');
  assert.equal(await fb.run(fails('claude: usage limit'), fails('codex: 500'), { third }), 'agy answer');
  assert.equal(third.calls, 1);
});
