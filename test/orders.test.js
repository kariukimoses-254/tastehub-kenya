const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES,
  isStatus,
  nextStatuses,
  canTransition,
  assertTransition,
  statusNotification,
} = require('../server/lib/orders');

test('status list and validator cover every workflow state', () => {
  assert.deepEqual(STATUSES, [
    'received',
    'confirmed',
    'preparing',
    'ready',
    'out_for_delivery',
    'completed',
    'cancelled',
  ]);
  assert.equal(isStatus('preparing'), true);
  assert.equal(isStatus('teleported'), false);
});

test('the happy delivery path is allowed', () => {
  assert.equal(canTransition('received', 'confirmed'), true);
  assert.equal(canTransition('confirmed', 'preparing'), true);
  assert.equal(canTransition('preparing', 'ready'), true);
  assert.equal(canTransition('ready', 'out_for_delivery'), true);
  assert.equal(canTransition('out_for_delivery', 'completed'), true);
});

test('collection orders can complete from ready', () => {
  assert.equal(canTransition('ready', 'completed'), true);
});

test('skipped or backward transitions are rejected', () => {
  assert.equal(canTransition('received', 'ready'), false);
  assert.equal(canTransition('preparing', 'received'), false);
  assert.equal(canTransition('completed', 'preparing'), false);
  assert.throws(() => assertTransition('received', 'ready'), /Allowed next steps/i);
});

test('terminal states cannot change without a forced admin correction', () => {
  assert.throws(() => assertTransition('completed', 'preparing'), /cannot be changed/i);
  assert.equal(canTransition('completed', 'preparing', { force: true }), true);
  assert.doesNotThrow(() => assertTransition('completed', 'preparing', { force: true }));
});

test('unknown target status fails with a useful message', () => {
  assert.throws(() => assertTransition('received', 'done'), /Status must be one of/i);
});

test('nextStatuses and notifications are derived from the workflow', () => {
  assert.deepEqual(nextStatuses('received'), ['confirmed', 'cancelled']);
  assert.deepEqual(nextStatuses('completed'), []);
  assert.match(statusNotification('out_for_delivery', 42), /Order #42 is now out for delivery/);
});
