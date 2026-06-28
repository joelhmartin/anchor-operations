import test from 'node:test';
import assert from 'node:assert/strict';
import { _gateCheckForTests as gateCheck } from '../runExecutor.js';

const conn = (status, capabilities) => ({ status, capabilities });

test('un-gated check (no requiredCapabilities) never skips', () => {
  assert.deepEqual(gateCheck({ requiredCapabilities: [] }, []), { skip: false });
  assert.deepEqual(gateCheck({}, []), { skip: false });
});

test('gated check with satisfied capabilities does not skip', () => {
  const r = gateCheck({ requiredCapabilities: ['read'] }, [conn('verified', ['read'])]);
  assert.equal(r.skip, false);
});

test('gated check with unsatisfied capabilities skips with a reason', () => {
  const r = gateCheck({ requiredCapabilities: ['publish'] }, [conn('verified', ['read'])]);
  assert.equal(r.skip, true);
  assert.equal(r.reason, 'capability_gate');
  assert.deepEqual(r.missing, ['publish']);
});

test('gated check with no connections at all skips (never errors)', () => {
  const r = gateCheck({ requiredCapabilities: ['read'] }, []);
  assert.equal(r.skip, true);
  assert.deepEqual(r.missing, ['read']);
});
