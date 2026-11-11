const crypto = require('crypto');
const { HttpError } = require('./errors');

const STATUSES = ['assigned', 'picked_up', 'arrived', 'delivered', 'issue', 'cancelled'];
const DRIVER_ACTIONS = ['picked_up', 'arrived'];
const ISSUE_TYPES = ['wrong_delivery', 'breakage', 'missing_item', 'late', 'other'];

// The driver moves the parcel to the customer's door. Only the customer (via
// the tokenised confirmation page) may mark it delivered. HQ may also record a
// confirmation by phone.
const TRANSITIONS = {
  assigned: ['picked_up', 'cancelled'],
  picked_up: ['arrived', 'cancelled'],
  arrived: ['delivered', 'issue'],
  delivered: [],
  issue: [],
  cancelled: [],
};

const ISSUE_LABELS = {
  wrong_delivery: 'Wrong delivery',
  breakage: 'Breakage or damage',
  missing_item: 'Missing item',
  late: 'Late delivery',
  other: 'Other problem',
};

function isStatus(value) {
  return STATUSES.includes(value);
}

function nextStatuses(from) {
  return TRANSITIONS[from] ? [...TRANSITIONS[from]] : [];
}

function canTransition(from, to, { force = false } = {}) {
  if (!isStatus(to)) return false;
  if (force) return true;
  if (from === to) return false;
  return nextStatuses(from).includes(to);
}

function assertTransition(from, to, options = {}) {
  if (!isStatus(to)) {
    throw new HttpError(400, `Delivery status must be one of: ${STATUSES.join(', ')}`);
  }
  if (!canTransition(from, to, options)) {
    throw new HttpError(409, `Cannot move this delivery from ${from} to ${to}`);
  }
}

function isIssueType(value) {
  return ISSUE_TYPES.includes(value);
}

function issueLabel(value) {
  return ISSUE_LABELS[value] || 'Delivery problem';
}

function confirmationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function statusNotification(status, orderId) {
  const labels = {
    assigned: 'assigned to a driver',
    picked_up: 'picked up by the driver',
    arrived: 'driver has arrived',
    delivered: 'confirmed delivered by the customer',
    issue: 'customer reported a problem',
    cancelled: 'delivery cancelled',
  };
  return `Order #${orderId} is now ${labels[status] || status}`;
}

module.exports = {
  STATUSES,
  DRIVER_ACTIONS,
  ISSUE_TYPES,
  TRANSITIONS,
  isStatus,
  nextStatuses,
  canTransition,
  assertTransition,
  isIssueType,
  issueLabel,
  confirmationToken,
  statusNotification,
};
