const { HttpError } = require('./errors');

const DEFAULT_LIMITS = {
  maxLineItems: 30,
  maxQuantityPerItem: 20,
  maxTotalItems: 100,
};

const DELIVERY_TYPES = ['collection', 'delivery'];

/**
 * Normalise the items sent by a client. Prices are deliberately ignored here:
 * the server always prices an order from the branch catalogue.
 *
 * Duplicate lines are merged case-insensitively so a caller cannot bypass the
 * per-item quantity cap by splitting the same meal across several lines.
 */
function normaliseItems(rawItems, limits = {}) {
  const { maxLineItems, maxQuantityPerItem, maxTotalItems } = { ...DEFAULT_LIMITS, ...limits };

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'Your order is empty');
  }
  if (rawItems.length > maxLineItems) {
    throw new HttpError(400, `An order can contain at most ${maxLineItems} different items`);
  }

  const merged = new Map();
  let totalQuantity = 0;

  rawItems.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new HttpError(400, `Order item ${index + 1} is invalid`);
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > 180) {
      throw new HttpError(400, `Order item ${index + 1} needs a valid dish name`);
    }
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantityPerItem) {
      throw new HttpError(400, `Quantity for ${name} must be between 1 and ${maxQuantityPerItem}`);
    }

    const key = name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += quantity;
      if (existing.quantity > maxQuantityPerItem) {
        throw new HttpError(400, `Quantity for ${name} must be between 1 and ${maxQuantityPerItem}`);
      }
    } else {
      merged.set(key, { name, quantity });
    }
    totalQuantity += quantity;
  });

  if (totalQuantity > maxTotalItems) {
    throw new HttpError(400, `An order can contain at most ${maxTotalItems} items`);
  }

  return [...merged.values()];
}

/**
 * Match requested items against a branch catalogue and snapshot prices.
 * The client-supplied unitPrice is never trusted.
 */
function priceItems(requestedItems, catalogue) {
  const byName = new Map();
  for (const meal of catalogue) byName.set(String(meal.meal_name).toLowerCase(), meal);

  const items = requestedItems.map((requested) => {
    const meal = byName.get(requested.name.toLowerCase());
    if (!meal) {
      throw new HttpError(400, `${requested.name} is not on this branch's menu`);
    }
    if (!meal.available) {
      throw new HttpError(400, `${requested.name} is currently unavailable at this branch`);
    }
    const unitPrice = Number(meal.price_kes);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw new HttpError(500, `The price for ${requested.name} is not configured correctly`);
    }
    return {
      mealId: meal.id,
      name: meal.meal_name,
      category: meal.category || 'Other',
      quantity: requested.quantity,
      unitPrice,
      lineTotal: unitPrice * requested.quantity,
    };
  });

  return items;
}

function subtotalOf(items) {
  return items.reduce((sum, item) => sum + item.lineTotal, 0);
}

/**
 * Validate a promotion at order time and return the KSh discount.
 * Throws a 400 with a customer-friendly message when the code cannot be used.
 */
function resolveDiscount(promotion, subtotal, now = new Date()) {
  if (!promotion) return { discount: 0, promotionCode: null };

  if (!promotion.active) {
    throw new HttpError(400, 'That promo code is not active');
  }
  if (promotion.starts_at && new Date(promotion.starts_at) > now) {
    throw new HttpError(400, 'That promo code is not valid yet');
  }
  if (promotion.ends_at && new Date(promotion.ends_at) < now) {
    throw new HttpError(400, 'That promo code has expired');
  }
  if (subtotal < Number(promotion.min_subtotal_kes || 0)) {
    throw new HttpError(
      400,
      `Promo code ${promotion.code} requires a minimum subtotal of KSh ${Number(promotion.min_subtotal_kes).toLocaleString('en-KE')}`
    );
  }

  const percent = Number(promotion.discount_percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new HttpError(500, 'That promo code is configured incorrectly');
  }

  let discount = Math.round((subtotal * percent) / 100);
  if (promotion.max_discount_kes) {
    discount = Math.min(discount, Number(promotion.max_discount_kes));
  }
  return { discount, promotionCode: promotion.code };
}

function deliveryFeeFor(branch, subtotal, deliveryType) {
  if (deliveryType === 'collection') return 0;
  const fee = Number(branch.delivery_fee_kes || 0);
  const threshold = Number(branch.free_delivery_threshold_kes || 0);
  if (threshold > 0 && subtotal >= threshold) return 0;
  return fee;
}

function assertMinimumOrder(branch, subtotal) {
  const minimum = Number(branch.min_order_kes || 0);
  if (minimum > 0 && subtotal < minimum) {
    throw new HttpError(
      400,
      `${branch.display_name || branch.branch_name} has a minimum order of KSh ${minimum.toLocaleString('en-KE')}`
    );
  }
}

/**
 * Compute everything the server will charge. Returns integer KSh amounts.
 */
function computeTotals({ items, branch, promotion, deliveryType, now = new Date() }) {
  if (!DELIVERY_TYPES.includes(deliveryType)) {
    throw new HttpError(400, 'Choose collection or delivery');
  }
  const subtotal = subtotalOf(items);
  assertMinimumOrder(branch, subtotal);
  const { discount, promotionCode } = resolveDiscount(promotion, subtotal, now);
  const deliveryFee = deliveryFeeFor(branch, subtotal, deliveryType);
  const total = subtotal - discount + deliveryFee;
  return { subtotal, discount, deliveryFee, total, promotionCode };
}

module.exports = {
  DEFAULT_LIMITS,
  DELIVERY_TYPES,
  normaliseItems,
  priceItems,
  subtotalOf,
  resolveDiscount,
  deliveryFeeFor,
  assertMinimumOrder,
  computeTotals,
};
