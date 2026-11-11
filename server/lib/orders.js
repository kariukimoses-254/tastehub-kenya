const { HttpError } = require('./errors');

const STATUSES = [
  'received',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
];

const TERMINAL = new Set(['completed', 'cancelled']);

// Transitions a branch manager may make. Central admins can additionally force
// a status change (for example to correct a mistake) while every change is
// recorded in order_status_history.
const TRANSITIONS = {
  received: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
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
    throw new HttpError(400, `Status must be one of: ${STATUSES.join(', ')}`);
  }
  if (!canTransition(from, to, options)) {
    const allowed = nextStatuses(from);
    const message = allowed.length
      ? `Cannot move an order from ${from} to ${to}. Allowed next steps: ${allowed.join(', ')}`
      : `An order that is ${from} cannot be changed`;
    throw new HttpError(409, message);
  }
}

function statusNotification(status, orderId) {
  const labels = {
    received: 'received',
    confirmed: 'confirmed',
    preparing: 'being prepared',
    ready: 'ready for collection',
    out_for_delivery: 'out for delivery',
    completed: 'completed',
    cancelled: 'cancelled',
  };
  return `Order #${orderId} is now ${labels[status] || status}`;
}

module.exports = {
  STATUSES,
  TERMINAL,
  TRANSITIONS,
  isStatus,
  nextStatuses,
  canTransition,
  assertTransition,
  statusNotification,
};
