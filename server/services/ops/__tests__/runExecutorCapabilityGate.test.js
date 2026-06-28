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

// Provider-scoping: a cap on a different provider must NOT satisfy the gate.
test('gated check does not accept capabilities from a different provider', () => {
  const wrongConn = { status: 'verified', capabilities: ['read'], service_category: 'analytics', provider: 'ga4' };
  const r = gateCheck(
    { requiredCapabilities: ['read'], serviceCategory: 'cms', provider: 'wordpress' },
    [wrongConn]
  );
  assert.equal(r.skip, true);
  assert.deepEqual(r.missing, ['read']);
});

test('gated check is satisfied by the correct provider connection', () => {
  const rightConn = { status: 'verified', capabilities: ['read'], service_category: 'cms', provider: 'wordpress' };
  const r = gateCheck(
    { requiredCapabilities: ['read'], serviceCategory: 'cms', provider: 'wordpress' },
    [rightConn]
  );
  assert.equal(r.skip, false);
});

test('gated check without serviceCategory/provider falls back to all connections (legacy)', () => {
  const anyConn = { status: 'verified', capabilities: ['read'], service_category: 'cms', provider: 'wordpress' };
  const r = gateCheck({ requiredCapabilities: ['read'] }, [anyConn]);
  assert.equal(r.skip, false);
});
