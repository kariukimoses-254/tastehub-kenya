const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES,
  DRIVER_ACTIONS,
  ISSUE_TYPES,
  isStatus,
  nextStatuses,
  canTransition,
  assertTransition,
  isIssueType,
  issueLabel,
  confirmationToken,
  statusNotification,
} = require('../server/lib/deliveries');

test('delivery status list covers the full workflow', () => {
  assert.deepEqual(STATUSES, [
    'assigned',
    'picked_up',
    'arrived',
    'delivered',
    'issue',
    'cancelled',
  ]);
  assert.equal(isStatus('arrived'), true);
  assert.equal(isStatus('teleported'), false);
});

test('drivers can only move pickup and arrival', () => {
  assert.deepEqual(DRIVER_ACTIONS, ['picked_up', 'arrived']);
});

test('the happy delivery path is allowed', () => {
  assert.equal(canTransition('assigned', 'picked_up'), true);
  assert.equal(canTransition('picked_up', 'arrived'), true);
  assert.equal(canTransition('arrived', 'delivered'), true);
  assert.doesNotThrow(() => assertTransition('arrived', 'delivered'));
});

test('arrival can become a customer issue', () => {
  assert.equal(canTransition('arrived', 'issue'), true);
  assert.equal(canTransition('issue', 'delivered'), false);
  assert.equal(canTransition('issue', 'arrived'), false);
});

test('cancellation is only available before arrival', () => {
  assert.equal(canTransition('assigned', 'cancelled'), true);
  assert.equal(canTransition('picked_up', 'cancelled'), true);
  assert.equal(canTransition('arrived', 'cancelled'), false);
  assert.equal(canTransition('delivered', 'cancelled'), false);
});

test('skipped or backward transitions are rejected with a useful message', () => {
  assert.equal(canTransition('assigned', 'arrived'), false);
  assert.equal(canTransition('picked_up', 'assigned'), false);
  assert.equal(canTransition('delivered', 'arrived'), false);
  assert.throws(() => assertTransition('assigned', 'arrived'), /Cannot move this delivery/i);
});

test('terminal delivery states cannot change', () => {
  assert.deepEqual(nextStatuses('delivered'), []);
  assert.deepEqual(nextStatuses('issue'), []);
  assert.deepEqual(nextStatuses('cancelled'), []);
  assert.throws(() => assertTransition('delivered', 'arrived'), /Cannot move this delivery/i);
});

test('unknown target status fails with a useful message', () => {
  assert.throws(() => assertTransition('assigned', 'teleported'), /Delivery status must be one of/i);
});

test('issue types and labels are complete', () => {
  assert.deepEqual(ISSUE_TYPES, [
    'wrong_delivery',
    'breakage',
    'missing_item',
    'late',
    'other',
  ]);
  ISSUE_TYPES.forEach((type) => assert.equal(isIssueType(type), true));
  assert.equal(isIssueType('cold_food'), false);
  assert.equal(issueLabel('breakage'), 'Breakage or damage');
  assert.equal(issueLabel('unknown'), 'Delivery problem');
});

test('confirmation tokens are 64 hex characters and unique', () => {
  const first = confirmationToken();
  const second = confirmationToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test('delivery notifications describe each state', () => {
  assert.match(statusNotification('assigned', 7), /Order #7 is now assigned to a driver/);
  assert.match(statusNotification('picked_up', 7), /picked up by the driver/);
  assert.match(statusNotification('arrived', 7), /driver has arrived/);
  assert.match(statusNotification('delivered', 7), /confirmed delivered by the customer/);
  assert.match(statusNotification('issue', 7), /customer reported a problem/);
});
