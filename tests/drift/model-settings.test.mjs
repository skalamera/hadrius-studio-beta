import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeEffortArgs, decisionEffort, decisionModel } from '../../tools/coverage-scan.mjs';

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
