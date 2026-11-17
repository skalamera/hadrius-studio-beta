import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeEffortArgs, codexModel, decisionEffort, decisionModel } from '../../tools/coverage-scan.mjs';

test('decision model and effort are read at call time; medium effort produces the Claude CLI flag', () => {
  const oldModel = process.env.KBS_DECISION_MODEL, oldEffort = process.env.KBS_DECISION_EFFORT;
  try {
    process.env.KBS_DECISION_MODEL = 'claude-opus-5-5';
    process.env.KBS_DECISION_EFFORT = 'medium';
    assert.equal(decisionModel(), 'claude-opus-5-5');
    assert.equal(decisionEffort(), 'medium');
    assert.deepEqual(claudeEffortArgs(), ['--effort', 'medium']);
  } finally {
    if (oldModel === undefined) delete process.env.KBS_DECISION_MODEL; else process.env.KBS_DECISION_MODEL = oldModel;
    if (oldEffort === undefined) delete process.env.KBS_DECISION_EFFORT; else process.env.KBS_DECISION_EFFORT = oldEffort;
  }
});

test('Codex plan and decision models are independently configurable and use the current Codex model by default', () => {
  const keys = ['KBS_CODEX_MODEL', 'KBS_CODEX_PLAN_MODEL', 'KBS_CODEX_DECISION_MODEL'];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(codexModel('plan'), 'gpt-6.1-sol');
    assert.equal(codexModel('decision'), 'gpt-6.1-sol');
    process.env.KBS_CODEX_MODEL = 'codex-shared';
    assert.equal(codexModel('plan'), 'codex-shared');
    assert.equal(codexModel('decision'), 'codex-shared');
    process.env.KBS_CODEX_PLAN_MODEL = 'codex-planner';
    process.env.KBS_CODEX_DECISION_MODEL = 'codex-decider';
    assert.equal(codexModel('plan'), 'codex-planner');
    assert.equal(codexModel('decision'), 'codex-decider');
  } finally {
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
});

test('effort stays opt-in, and unsupported effort values fail closed', () => {
  const old = process.env.KBS_DECISION_EFFORT;
  try {
    delete process.env.KBS_DECISION_EFFORT;
    assert.equal(decisionEffort(), null);
    assert.deepEqual(claudeEffortArgs(), []);
    assert.throws(() => claudeEffortArgs('extreme'), /invalid_claude_effort/);
  } finally {
    if (old === undefined) delete process.env.KBS_DECISION_EFFORT; else process.env.KBS_DECISION_EFFORT = old;
  }
});
