/**
 * Sample catalogue used by `npm run db:seed`.
 *
 * IMPORTANT: these are illustrative branch prices and delivery rules, not a
 * verified price list. Replace them with approved prices for each real outlet
 * before taking live orders.
 */
const BRANCHES = [
  {
    branch_name: 'Nairobi',
    display_name: 'Nairobi Headquarters',
    is_headquarters: true,
    phone: '+254700000001',
    address: 'Nairobi CBD, Nairobi',
    delivery_fee_kes: 150,
    free_delivery_threshold_kes: 3000,
    min_order_kes: 500,
    accepting_orders: true,
    active: true,
    price_multiplier: 1,
  },
  {
    branch_name: 'Mombasa',
    display_name: 'Mombasa Branch',
    is_headquarters: false,
    phone: '+254700000002',
    address: 'Mombasa Island, Mombasa',
    delivery_fee_kes: 200,
    free_delivery_threshold_kes: 3500,
    min_order_kes: 600,
    accepting_orders: true,
    active: true,
    price_multiplier: 1.05,
  },
  {
    branch_name: 'Kisumu',
    display_name: 'Kisumu Branch',
    is_headquarters: false,
    phone: '+254700000003',
    address: 'Kisumu CBD, Kisumu',
    delivery_fee_kes: 200,
    free_delivery_threshold_kes: 3500,
    min_order_kes: 600,
    accepting_orders: true,
    active: true,
    price_multiplier: 0.98,
  },
  {
    branch_name: 'Nakuru',
    display_name: 'Nakuru Branch',
    is_headquarters: false,
    phone: '+254700000004',
    address: 'Nakuru CBD, Nakuru',
    delivery_fee_kes: 180,
    free_delivery_threshold_kes: 3000,
    min_order_kes: 500,
    accepting_orders: true,
    active: true,
    price_multiplier: 0.96,
  },
  {
    branch_name: 'Eldoret',
    display_name: 'Eldoret Branch',
    is_headquarters: false,
    phone: '+254700000005',
    address: 'Eldoret CBD, Eldoret',
    delivery_fee_kes: 180,
    free_delivery_threshold_kes: 3000,
    min_order_kes: 500,
    accepting_orders: true,
    active: true,
    price_multiplier: 0.97,
  },
];

const CATALOGUE = [
  { meal_name: 'Chicken Biryani', description: 'Aromatic & Flavorful', category: 'Indian', base_price_kes: 249 },
  { meal_name: 'Margherita Pizza', description: 'Classic Delight', category: 'Pizza', base_price_kes: 299 },
  { meal_name: 'Crispy Chicken Burger', description: 'Juicy & Crunchy', category: 'Burger', base_price_kes: 199 },
  { meal_name: 'Paneer Butter Masala', description: 'Rich & Creamy', category: 'Indian', base_price_kes: 229 },
  { meal_name: 'Chocolate Lava Cake', description: 'Heavenly Dessert', category: 'Desserts', base_price_kes: 149 },
  { meal_name: 'Veg Hakka Noodles', description: 'Wok-tossed & satisfying', category: 'Chinese', base_price_kes: 249 },
  { meal_name: 'Masala Dosa', description: 'Crisp, golden & savoury', category: 'South Indian', base_price_kes: 189 },
  { meal_name: 'Fresh Mango Juice', description: 'Blended to order', category: 'Beverages', base_price_kes: 120 },
  { meal_name: 'Grilled Chicken Salad', description: 'Fresh, light & filling', category: 'Healthy', base_price_kes: 320 },
];

const PROMOTIONS = [
  {
    code: 'TASTE30',
    description: '30% off your order (capped at KSh 1,000)',
    discount_percent: 30,
    max_discount_kes: 1000,
    min_subtotal_kes: 1500,
    active: true,
  },
];

function roundToNearestFive(value) {
  return Math.max(0, Math.round(value / 5) * 5);
}

function mealPriceForBranch(basePrice, branch) {
  return roundToNearestFive(Number(basePrice) * Number(branch.price_multiplier || 1));
}

module.exports = { BRANCHES, CATALOGUE, PROMOTIONS, mealPriceForBranch };
