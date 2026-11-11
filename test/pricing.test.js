const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseItems,
  priceItems,
  resolveDiscount,
  deliveryFeeFor,
  computeTotals,
} = require('../server/lib/pricing');

const catalogue = [
  { id: 1, meal_name: 'Chicken Biryani', category: 'Indian', price_kes: 250, available: 1 },
  { id: 2, meal_name: 'Margherita Pizza', category: 'Pizza', price_kes: 300, available: 1 },
  { id: 3, meal_name: 'Sold Out Dish', category: 'Other', price_kes: 100, available: 0 },
];

const branch = {
  branch_name: 'Nairobi',
  display_name: 'Nairobi Headquarters',
  delivery_fee_kes: 150,
  free_delivery_threshold_kes: 1000,
  min_order_kes: 200,
};

test('normaliseItems trims names, merges duplicates and ignores client prices', () => {
  const items = normaliseItems([
    { name: ' Chicken Biryani ', quantity: 2, unitPrice: 1 },
    { name: 'chicken biryani', quantity: 1, unitPrice: 9999 },
    { name: 'Margherita Pizza', quantity: 1 },
  ]);
  assert.deepEqual(items, [
    { name: 'Chicken Biryani', quantity: 3 },
    { name: 'Margherita Pizza', quantity: 1 },
  ]);
});

test('normaliseItems rejects empty and invalid quantities', () => {
  assert.throws(() => normaliseItems([]), /order is empty/i);
  assert.throws(() => normaliseItems([{ name: 'Pizza', quantity: 0 }]), /between 1 and 20/i);
  assert.throws(() => normaliseItems([{ name: 'Pizza', quantity: 1.5 }]), /between 1 and 20/i);
  assert.throws(() => normaliseItems([{ name: '', quantity: 1 }]), /valid dish name/i);
});

test('normaliseItems enforces per-item and total caps', () => {
  assert.throws(
    () => normaliseItems([{ name: 'Pizza', quantity: 10 }, { name: 'Pizza', quantity: 11 }]),
    /between 1 and 20/i
  );
  assert.throws(
    () =>
      normaliseItems(
        Array.from({ length: 6 }, (_, i) => ({ name: `Dish ${i}`, quantity: 20 })),
        { maxTotalItems: 100 }
      ),
    /at most 100 items/i
  );
});

test('priceItems prices from the branch catalogue, not the request', () => {
  const items = priceItems([{ name: 'Chicken Biryani', quantity: 2 }], catalogue);
  assert.equal(items[0].unitPrice, 250);
  assert.equal(items[0].lineTotal, 500);
  assert.equal(items[0].mealId, 1);
});

test('priceItems rejects unknown and unavailable dishes', () => {
  assert.throws(
    () => priceItems([{ name: 'Unknown', quantity: 1 }], catalogue),
    /not on this branch's menu/i
  );
  assert.throws(
    () => priceItems([{ name: 'Sold Out Dish', quantity: 1 }], catalogue),
    /unavailable/i
  );
});

test('resolveDiscount validates promo state and caps the discount', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const promo = {
    code: 'TASTE30',
    active: 1,
    discount_percent: 30,
    max_discount_kes: 100,
    min_subtotal_kes: 200,
    starts_at: null,
    ends_at: null,
  };

  assert.deepEqual(resolveDiscount(null, 500, now), { discount: 0, promotionCode: null });
  assert.deepEqual(resolveDiscount(promo, 1000, now), { discount: 100, promotionCode: 'TASTE30' });
  assert.deepEqual(resolveDiscount({ ...promo, max_discount_kes: null }, 500, now), {
    discount: 150,
    promotionCode: 'TASTE30',
  });

  assert.throws(() => resolveDiscount({ ...promo, active: 0 }, 500, now), /not active/i);
  assert.throws(
    () => resolveDiscount({ ...promo, ends_at: '2026-01-09T00:00:00Z' }, 500, now),
    /expired/i
  );
  assert.throws(
    () => resolveDiscount({ ...promo, starts_at: '2026-01-11T00:00:00Z' }, 500, now),
    /not valid yet/i
  );
  assert.throws(() => resolveDiscount(promo, 100, now), /minimum subtotal/i);
});

test('delivery fees respect collection, delivery and free-delivery threshold', () => {
  assert.equal(deliveryFeeFor(branch, 500, 'collection'), 0);
  assert.equal(deliveryFeeFor(branch, 500, 'delivery'), 150);
  assert.equal(deliveryFeeFor(branch, 1000, 'delivery'), 0);
});

test('computeTotals produces integer KSh amounts and enforces the minimum order', () => {
  const items = priceItems([{ name: 'Chicken Biryani', quantity: 4 }], catalogue);
  const totals = computeTotals({
    items,
    branch,
    promotion: {
      code: 'TASTE30',
      active: 1,
      discount_percent: 30,
      max_discount_kes: null,
      min_subtotal_kes: 0,
    },
    deliveryType: 'delivery',
  });
  assert.deepEqual(totals, {
    subtotal: 1000,
    discount: 300,
    deliveryFee: 0,
    total: 700,
    promotionCode: 'TASTE30',
  });

  assert.throws(
    () =>
      computeTotals({
        items: priceItems([{ name: 'Chicken Biryani', quantity: 1 }], catalogue),
        branch: { ...branch, min_order_kes: 300 },
        promotion: null,
        deliveryType: 'collection',
      }),
    /minimum order/i
  );
});

test('computeTotals rejects an invalid fulfilment method', () => {
  assert.throws(
    () =>
      computeTotals({
        items: priceItems([{ name: 'Chicken Biryani', quantity: 2 }], catalogue),
        branch,
        promotion: null,
        deliveryType: 'teleport',
      }),
    /collection or delivery/i
  );
});
