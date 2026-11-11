const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const defaultSettings = require('./config');
const { HttpError, asyncHandler } = require('./lib/errors');
const { createAuth } = require('./lib/auth');
const { createRateLimiter } = require('./lib/rate-limit');
const { normaliseItems, priceItems, computeTotals, DELIVERY_TYPES } = require('./lib/pricing');
const orderFlow = require('./lib/orders');
const deliveryFlow = require('./lib/deliveries');
const { createEmailer } = require('./lib/email');
const v = require('./lib/validation');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('tastehub-dummy-password', 12);

const MESSAGE_STATUSES = ['new', 'read', 'in_progress', 'resolved', 'forwarded'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ROLES = ['central_admin', 'branch_manager', 'driver', 'staff'];

function createApp({ pool, settings = defaultSettings, logger = console } = {}) {
  if (!pool) throw new Error('createApp requires a database pool');

  const auth = createAuth({ secret: settings.jwtSecret, expiresIn: settings.jwtExpiresIn });
  const app = express();

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use(
    helmet({
      // The starter ships inline scripts and data-URI images. Move assets to
      // separate files and enable a strict CSP before public launch.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );
  if (settings.corsOrigins.length) {
    app.use(cors({ origin: settings.corsOrigins }));
  }
  app.use(express.json({ limit: '100kb' }));

  const loginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });
  const orderLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'Too many orders from this connection. Please wait a moment and try again.',
  });
  const lookupLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 60 });
  const messageLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: 'Too many messages from this connection. Please wait and try again.',
  });
  const deliveryLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'Too many delivery confirmation attempts. Please wait and try again.',
  });

  app.locals.limiters = {
    loginLimiter,
    orderLimiter,
    lookupLimiter,
    messageLimiter,
    deliveryLimiter,
  };

  const emailer = createEmailer({ pool, settings, logger });

  // ---------------------------------------------------------------- helpers
  async function loadBranch(name, executor = pool, { activeOnly = true } = {}) {
    const sql = activeOnly
      ? 'SELECT * FROM branches WHERE branch_name = ? AND active = 1'
      : 'SELECT * FROM branches WHERE branch_name = ?';
    const [rows] = await executor.execute(sql, [name]);
    return rows[0] || null;
  }

  async function defaultBranch(executor = pool) {
    const [rows] = await executor.query(
      'SELECT * FROM branches WHERE active = 1 ORDER BY is_headquarters DESC, branch_name ASC LIMIT 1'
    );
    return rows[0] || null;
  }

  const DELIVERY_SELECT = `
    SELECT d.*, o.customer_name, o.customer_phone, o.customer_email, o.delivery_type,
           o.delivery_address, o.notes AS order_notes, o.subtotal_kes, o.total_kes,
           o.status AS order_status, o.created_at AS order_created_at,
           u.email AS driver_email, u.full_name AS driver_name
      FROM deliveries d
      JOIN orders o ON o.id = d.order_id
      JOIN users u ON u.id = d.driver_id`;

  async function fetchDeliveryDetail(executor, where, params) {
    const [rows] = await executor.execute(`${DELIVERY_SELECT} WHERE ${where}`, params);
    if (!rows.length) return null;
    const row = rows[0];
    const [items] = await executor.execute(
      'SELECT id, meal_name, category, quantity, unit_price_kes, line_total_kes FROM order_items WHERE order_id = ? ORDER BY id',
      [row.order_id]
    );
    return mapDelivery({ ...row, items }, settings.publicBaseUrl);
  }

  async function fetchOrderDetail(executor, orderId) {
    const [orders] = await executor.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!orders.length) return null;
    const [items] = await executor.execute(
      'SELECT id, meal_id, meal_name, category, quantity, unit_price_kes, line_total_kes FROM order_items WHERE order_id = ? ORDER BY id',
      [orderId]
    );
    const [history] = await executor.execute(
      'SELECT from_status, to_status, changed_by, note, created_at FROM order_status_history WHERE order_id = ? ORDER BY id',
      [orderId]
    );
    const [deliveries] = await executor.execute(
      `SELECT d.*, u.email AS driver_email, u.full_name AS driver_name
         FROM deliveries d JOIN users u ON u.id = d.driver_id
        WHERE d.order_id = ?`,
      [orderId]
    );
    const order = mapOrder(orders[0], items, history);
    order.delivery = deliveries.length
      ? mapDeliveryForOrder(deliveries[0], settings.publicBaseUrl, orders[0])
      : null;
    return order;
  }

  function optionalDateTime(value, field) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const raw = v.requiredString(value, { max: 40, field });
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, `${field} must be a valid date and time`);
    }
    return date;
  }

  function deliveryToken(value) {
    const token = v.requiredString(value, { max: 64, field: 'Delivery link' });
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new HttpError(404, 'Delivery link not found');
    return token;
  }

  function publicDelivery(delivery) {
    return {
      orderId: delivery.orderId,
      branch: delivery.branch,
      status: delivery.status,
      customerName: delivery.customer.name,
      deliveryAddress: delivery.deliveryAddress,
      totalKes: delivery.totalKes,
      items: delivery.items,
      driver: delivery.driver,
      nextReadyAt: delivery.nextReadyAt,
      nextDeliveryAt: delivery.nextDeliveryAt,
      arrivedAt: delivery.arrivedAt,
      confirmedAt: delivery.confirmedAt,
      issue: delivery.issue,
      canConfirm: delivery.status === 'arrived',
      confirmationUrl: delivery.confirmationUrl,
    };
  }

  async function confirmDelivery({ deliveryId, actorEmail, force = false }) {
    const connection = await pool.getConnection();
    let shouldEmail = false;
    let already = false;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM deliveries WHERE id = ? FOR UPDATE',
        [deliveryId]
      );
      const delivery = rows[0];
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      if (delivery.status === 'delivered') {
        already = true;
      } else if (delivery.status === 'cancelled') {
        throw new HttpError(409, 'This delivery was cancelled');
      } else if (delivery.status === 'issue') {
        throw new HttpError(409, 'This delivery has an open problem report');
      } else {
        if (delivery.status !== 'arrived' && !force) {
          throw new HttpError(409, 'The driver has not marked this delivery as arrived yet');
        }
        const [orders] = await connection.execute(
          'SELECT * FROM orders WHERE id = ? FOR UPDATE',
          [delivery.order_id]
        );
        const order = orders[0];
        if (!order) throw new HttpError(404, 'Order not found');
        if (order.status === 'cancelled') throw new HttpError(409, 'This order was cancelled');

        await connection.execute(
          "UPDATE deliveries SET status = 'delivered', confirmed_at = NOW(), confirmed_by = ? WHERE id = ?",
          [actorEmail || 'customer', deliveryId]
        );
        if (order.status !== 'completed') {
          await connection.execute('UPDATE orders SET status = ? WHERE id = ?', [
            'completed',
            order.id,
          ]);
          await connection.execute(
            `INSERT INTO order_status_history
              (order_id, from_status, to_status, changed_by, note)
             VALUES (?, ?, 'completed', ?, ?)`,
            [order.id, order.status, actorEmail || 'customer', 'Delivery confirmed']
          );
        }
        await connection.execute(
          'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
          [
            order.branch_name,
            'delivery_confirmed',
            order.id,
            `Order #${order.id} delivery confirmed by ${actorEmail || 'customer'}`,
          ]
        );
        shouldEmail = true;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [deliveryId]);
    const email = shouldEmail && delivery ? await emailer.confirmation(delivery) : null;
    return { delivery, email, already };
  }

  async function reportDeliveryIssue({ deliveryId, issueType, note, reportedBy = 'customer' }) {
    const connection = await pool.getConnection();
    let shouldEmail = false;
    let duplicate = false;
    let messageId = null;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT * FROM deliveries WHERE id = ? FOR UPDATE',
        [deliveryId]
      );
      const delivery = rows[0];
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      if (delivery.status === 'delivered') {
        throw new HttpError(409, 'This delivery is already confirmed');
      }
      if (delivery.status === 'issue') {
        duplicate = true;
      } else {
        if (delivery.status !== 'arrived') {
          throw new HttpError(409, 'The driver has not marked this delivery as arrived yet');
        }
        const [orders] = await connection.execute(
          'SELECT * FROM orders WHERE id = ? FOR UPDATE',
          [delivery.order_id]
        );
        const order = orders[0];
        if (!order) throw new HttpError(404, 'Order not found');

        await connection.execute(
          `UPDATE deliveries
              SET status = 'issue', issue_type = ?, issue_note = ?, issue_reported_at = NOW()
            WHERE id = ?`,
          [issueType, note, deliveryId]
        );
        const label = deliveryFlow.issueLabel(issueType);
        const text = [
          `Delivery issue reported for order #${order.id}.`,
          `Type: ${label}`,
          `Details: ${note}`,
          `Customer: ${order.customer_name} · ${order.customer_phone}`,
          `Driver: ${delivery.driver_id}`,
          `Address: ${order.delivery_address || 'Collection'}`,
          `Reported by: ${reportedBy}`,
        ].join('\n');
        const [message] = await connection.execute(
          `INSERT INTO messages
            (from_branch, to_branch, sender_name, sender_email, subject, message, priority, status)
           VALUES (?, NULL, ?, ?, ?, ?, 'urgent', 'new')`,
          [
            order.branch_name,
            order.customer_name,
            order.customer_email,
            `Delivery issue: order #${order.id}`,
            text,
          ]
        );
        messageId = message.insertId;
        await connection.execute(
          'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
          [
            order.branch_name,
            'delivery_issue',
            order.id,
            `Order #${order.id}: ${label}`,
          ]
        );
        shouldEmail = true;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [deliveryId]);
    const email =
      shouldEmail && delivery ? await emailer.issueAcknowledgement(delivery) : null;
    return { delivery, email, duplicate, messageId };
  }

  async function changeOrderStatus({ orderId, to, actor, branchScope = null, note = null, force = false }) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      const order = rows[0];
      if (!order) throw new HttpError(404, 'Order not found');
      if (branchScope && order.branch_name !== branchScope) {
        throw new HttpError(403, 'This order belongs to another branch');
      }
      orderFlow.assertTransition(order.status, to, { force });
      await connection.execute('UPDATE orders SET status = ? WHERE id = ?', [to, orderId]);
      await connection.execute(
        'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES (?, ?, ?, ?, ?)',
        [orderId, order.status, to, actor?.email || null, note]
      );
      await connection.execute(
        'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
        [order.branch_name, 'order_status', orderId, orderFlow.statusNotification(to, orderId)]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return fetchOrderDetail(pool, orderId);
  }

  function branchScopeFor(req, requested) {
    if (req.user.role === 'central_admin') {
      return v.optionalString(requested, { max: 80, field: 'Branch' });
    }
    if (!req.user.branch) throw new HttpError(403, 'Your account is not assigned to a branch');
    return req.user.branch;
  }

  // ---------------------------------------------------------------- health
  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      try {
        await pool.query('SELECT 1');
        res.json({
          status: 'ok',
          database: 'connected',
          headquarters: 'Nairobi',
          currency: 'KES',
          time: new Date().toISOString(),
        });
      } catch (error) {
        res.status(503).json({ status: 'degraded', database: 'disconnected' });
      }
    })
  );

  // ---------------------------------------------------------------- public catalogue
  app.get(
    '/api/branches',
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query(
        'SELECT * FROM branches WHERE active = 1 ORDER BY is_headquarters DESC, branch_name ASC'
      );
      res.json(rows.map(mapBranch));
    })
  );

  app.get(
    '/api/menu',
    asyncHandler(async (req, res) => {
      const requested = v.optionalString(req.query.branch, { max: 80, field: 'Branch' });
      const branch = requested ? await loadBranch(requested) : await defaultBranch();
      if (!branch) throw new HttpError(400, 'Choose a valid branch');

      const [meals] = await pool.execute(
        'SELECT id, meal_name, description, category, price_kes, available, image_url FROM branch_meals WHERE branch_name = ? ORDER BY id',
        [branch.branch_name]
      );
      const [promotions] = await pool.query(
        'SELECT code, description, discount_percent, max_discount_kes, min_subtotal_kes FROM promotions WHERE active = 1 ORDER BY code'
      );
      const categories = ['All', ...new Set(meals.filter((meal) => meal.available).map((meal) => meal.category))];

      res.json({
        currency: 'KES',
        branch: mapBranch(branch),
        categories,
        promotions: promotions.map((promotion) => ({
          code: promotion.code,
          description: promotion.description,
          discountPercent: Number(promotion.discount_percent),
          maxDiscountKes: promotion.max_discount_kes === null ? null : Number(promotion.max_discount_kes),
          minSubtotalKes: Number(promotion.min_subtotal_kes),
        })),
        meals: meals.map((meal) => ({
          id: meal.id,
          name: meal.meal_name,
          description: meal.description,
          category: meal.category,
          priceKes: Number(meal.price_kes),
          available: Boolean(meal.available),
          imageUrl: meal.image_url,
        })),
      });
    })
  );

  // ---------------------------------------------------------------- auth
  app.post(
    '/api/auth/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const email = v.normaliseEmail(req.body?.email, { required: true });
      const password = v.requiredString(req.body?.password, { field: 'Password', max: 200 });
      const [rows] = await pool.execute(
        'SELECT id, email, full_name, password_hash, role, branch_name FROM users WHERE email = ? AND active = 1',
        [email]
      );
      const user = rows[0];
      const hash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
      const passwordMatches = await bcrypt.compare(password, hash);
      if (!user || !passwordMatches) {
        throw new HttpError(401, 'Invalid email or password');
      }
      await pool.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      const token = auth.sign(user);
      res.json({
        token,
        user: { id: user.id, email: user.email, name: user.full_name, role: user.role, branch: user.branch_name },
      });
    })
  );

  app.get(
    '/api/auth/me',
    auth.requireRole(),
    asyncHandler(async (req, res) => {
      const [rows] = await pool.execute(
        'SELECT id, email, full_name, role, branch_name, active FROM users WHERE id = ? AND active = 1',
        [req.user.id]
      );
      if (!rows.length) throw new HttpError(401, 'Account is no longer active');
      res.json({
        user: {
          id: rows[0].id,
          email: rows[0].email,
          name: rows[0].full_name,
          role: rows[0].role,
          branch: rows[0].branch_name,
        },
      });
    })
  );

  // ---------------------------------------------------------------- orders (public)
  app.post(
    '/api/orders',
    orderLimiter,
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const branchName = v.requiredString(body.branch, { max: 80, field: 'Branch' });
      const branch = await loadBranch(branchName);
      if (!branch) throw new HttpError(400, 'Choose a valid branch');
      if (!branch.accepting_orders) {
        throw new HttpError(400, `${branch.display_name} is not accepting orders right now`);
      }

      const requestedItems = normaliseItems(body.items, settings.order);
      const deliveryType = v.oneOf(body.deliveryType, DELIVERY_TYPES, {
        field: 'Fulfilment method',
        fallback: 'collection',
      });
      const customer = body.customer || {};
      const customerName = v.requiredString(customer.name ?? body.customerName, {
        max: 150,
        field: 'Full name',
      });
      const customerPhone = v.normalisePhone(customer.phone ?? body.customerPhone, {
        field: 'Phone number',
      });
      const customerEmail =
        deliveryType === 'delivery'
          ? v.normaliseEmail(customer.email ?? body.customerEmail, {
              field: 'Email',
              required: true,
            })
          : v.normaliseEmail(customer.email ?? body.customerEmail, {
              field: 'Email',
            });
      const deliveryAddress =
        deliveryType === 'delivery'
          ? v.requiredString(customer.address ?? body.deliveryAddress, {
              max: 500,
              field: 'Delivery address',
            })
          : v.optionalString(customer.address ?? body.deliveryAddress, {
              max: 500,
              field: 'Delivery address',
            });
      const notes = v.optionalString(body.notes, { max: 500, field: 'Order notes' });
      const promotionCode = v.optionalString(body.promotionCode, { max: 40, field: 'Promo code' });
      const requestId = v.optionalString(body.requestId, { max: 64, field: 'Request id' });

      if (requestId) {
        const [existing] = await pool.execute(
          'SELECT id FROM orders WHERE client_request_id = ?',
          [requestId]
        );
        if (existing.length) {
          const order = await fetchOrderDetail(pool, existing[0].id);
          return res.status(200).json({ duplicate: true, order });
        }
      }

      const connection = await pool.getConnection();
      let createdId = null;
      try {
        await connection.beginTransaction();

        const [branchRows] = await connection.execute(
          'SELECT * FROM branches WHERE branch_name = ? AND active = 1 FOR UPDATE',
          [branchName]
        );
        if (!branchRows.length) throw new HttpError(400, 'Choose a valid branch');
        if (!branchRows[0].accepting_orders) {
          throw new HttpError(400, `${branchRows[0].display_name} is not accepting orders right now`);
        }

        const placeholders = requestedItems.map(() => '?').join(',');
        const [mealRows] = await connection.query(
          `SELECT id, meal_name, category, price_kes, available
             FROM branch_meals
            WHERE branch_name = ? AND meal_name IN (${placeholders})`,
          [branchName, ...requestedItems.map((item) => item.name)]
        );
        const pricedItems = priceItems(requestedItems, mealRows);

        let promotion = null;
        if (promotionCode) {
          const [promotionRows] = await connection.execute(
            'SELECT * FROM promotions WHERE code = ? FOR UPDATE',
            [promotionCode]
          );
          promotion = promotionRows[0] || null;
          if (!promotion) throw new HttpError(400, 'That promo code is not valid');
        }

        const totals = computeTotals({
          items: pricedItems,
          branch: branchRows[0],
          promotion,
          deliveryType,
        });

        const [result] = await connection.execute(
          `INSERT INTO orders
            (branch_name, client_request_id, customer_name, customer_phone, customer_email,
             delivery_type, delivery_address, notes, subtotal_kes, discount_kes, delivery_fee_kes,
             total_kes, promotion_code, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
          [
            branchName,
            requestId,
            customerName,
            customerPhone,
            customerEmail,
            deliveryType,
            deliveryAddress,
            notes,
            totals.subtotal,
            totals.discount,
            totals.deliveryFee,
            totals.total,
            totals.promotionCode,
          ]
        );
        createdId = result.insertId;

        for (const item of pricedItems) {
          await connection.execute(
            `INSERT INTO order_items
              (order_id, meal_id, meal_name, category, quantity, unit_price_kes, line_total_kes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [createdId, item.mealId, item.name, item.category, item.quantity, item.unitPrice, item.lineTotal]
          );
        }
        await connection.execute(
          'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES (?, NULL, ?, ?, ?)',
          [createdId, 'received', 'customer', 'Order placed']
        );
        await connection.execute(
          'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
          [branchName, 'new_order', createdId, `New order #${createdId} for KSh ${totals.total}`]
        );

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        if (error && error.code === 'ER_DUP_ENTRY' && requestId) {
          const [existing] = await pool.execute(
            'SELECT id FROM orders WHERE client_request_id = ?',
            [requestId]
          );
          if (existing.length) {
            const order = await fetchOrderDetail(pool, existing[0].id);
            return res.status(200).json({ duplicate: true, order });
          }
        }
        throw error;
      } finally {
        connection.release();
      }

      const order = await fetchOrderDetail(pool, createdId);
      res.status(201).json({ order });
    })
  );

  app.get(
    '/api/orders/:id',
    lookupLimiter,
    asyncHandler(async (req, res) => {
      const orderId = v.positiveInt(req.params.id, { field: 'Order id', max: 9007199254740991 });
      const phone = v.normalisePhone(req.query.phone, { field: 'Phone number' });
      const [rows] = await pool.execute('SELECT customer_phone FROM orders WHERE id = ?', [orderId]);
      if (!rows.length || rows[0].customer_phone !== phone) {
        throw new HttpError(404, 'Order not found');
      }
      const order = await fetchOrderDetail(pool, orderId);
      res.json({ order });
    })
  );

  // ---------------------------------------------------------------- delivery confirmation (public)
  app.get(
    '/api/delivery/:token',
    lookupLimiter,
    asyncHandler(async (req, res) => {
      const token = deliveryToken(req.params.token);
      const delivery = await fetchDeliveryDetail(pool, 'd.token = ?', [token]);
      if (!delivery) throw new HttpError(404, 'Delivery link not found');
      res.json({ delivery: publicDelivery(delivery) });
    })
  );

  app.post(
    '/api/delivery/:token/confirm',
    deliveryLimiter,
    asyncHandler(async (req, res) => {
      const token = deliveryToken(req.params.token);
      const delivery = await fetchDeliveryDetail(pool, 'd.token = ?', [token]);
      if (!delivery) throw new HttpError(404, 'Delivery link not found');
      const result = await confirmDelivery({
        deliveryId: delivery.id,
        actorEmail: 'customer',
      });
      res.json({
        confirmed: true,
        duplicate: result.already,
        delivery: publicDelivery(result.delivery),
        email: result.email,
      });
    })
  );

  app.post(
    '/api/delivery/:token/report',
    deliveryLimiter,
    asyncHandler(async (req, res) => {
      const token = deliveryToken(req.params.token);
      const delivery = await fetchDeliveryDetail(pool, 'd.token = ?', [token]);
      if (!delivery) throw new HttpError(404, 'Delivery link not found');
      const issueType = v.oneOf(req.body?.issueType, deliveryFlow.ISSUE_TYPES, {
        field: 'Problem type',
      });
      const note = v.requiredString(req.body?.message, {
        max: 1000,
        field: 'Problem details',
      });
      const result = await reportDeliveryIssue({
        deliveryId: delivery.id,
        issueType,
        note,
        reportedBy: 'customer',
      });
      res.status(result.duplicate ? 200 : 201).json({
        reported: true,
        duplicate: result.duplicate,
        messageId: result.messageId,
        delivery: publicDelivery(result.delivery),
        email: result.email,
      });
    })
  );

  // ---------------------------------------------------------------- messages (public)
  app.post(
    '/api/messages',
    messageLimiter,
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const fromBranch = v.requiredString(body.fromBranch, { max: 80, field: 'Origin branch' });
      const from = await loadBranch(fromBranch);
      if (!from) throw new HttpError(400, 'Choose a valid origin branch');

      const toBranch = v.optionalString(body.toBranch, { max: 80, field: 'Destination branch' });
      if (toBranch && !(await loadBranch(toBranch, pool, { activeOnly: false }))) {
        throw new HttpError(400, 'Choose a valid destination branch');
      }
      const senderName = v.optionalString(body.senderName, { max: 150, field: 'Sender name' });
      const senderEmail = v.normaliseEmail(body.senderEmail, { field: 'Sender email' });
      const subject = v.optionalString(body.subject, { max: 200, field: 'Subject' });
      const message = v.requiredString(body.message, { max: 5000, field: 'Message' });
      const priority = v.oneOf(body.priority, PRIORITIES, { field: 'Priority', fallback: 'normal' });

      const [result] = await pool.execute(
        `INSERT INTO messages (from_branch, to_branch, sender_name, sender_email, subject, message, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [fromBranch, toBranch, senderName, senderEmail, subject || 'Branch message', message, priority]
      );
      await pool.execute(
        'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
        ['Nairobi', 'new_message', result.insertId, `Message #${result.insertId} from ${fromBranch}`]
      );
      res.status(201).json({ messageId: result.insertId, visibleAtHeadquarters: true });
    })
  );

  // ---------------------------------------------------------------- admin
  app.post(
    '/api/admin/bootstrap',
    asyncHandler(async (req, res) => {
      if (settings.isProduction && !settings.allowBootstrap) {
        throw new HttpError(404, 'Not found');
      }
      if (settings.bootstrapToken && req.get('x-bootstrap-token') !== settings.bootstrapToken) {
        throw new HttpError(403, 'A valid bootstrap token is required');
      }

      const [admins] = await pool.query(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'central_admin'"
      );
      if (Number(admins[0].total) > 0) {
        const payload = auth.verifyRequest(req);
        if (payload.role !== 'central_admin') throw new HttpError(403, 'Insufficient permissions');
      }

      const email = v.normaliseEmail(req.body?.email, { required: true });
      const password = v.requiredString(req.body?.password, { field: 'Password', max: 200 });
      if (password.length < settings.auth.minPasswordLength) {
        throw new HttpError(
          400,
          `Password must be at least ${settings.auth.minPasswordLength} characters`
        );
      }
      const hash = await bcrypt.hash(password, 12);
      await pool.execute(
        `INSERT INTO users (email, password_hash, role, branch_name)
         VALUES (?, ?, 'central_admin', 'Nairobi')
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'central_admin', branch_name = 'Nairobi'`,
        [email, hash]
      );
      res.status(201).json({ created: true });
    })
  );

  app.get(
    '/api/admin/stats',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const [byStatus] = await pool.query(
        'SELECT status, COUNT(*) AS total FROM orders GROUP BY status'
      );
      const [today] = await pool.query(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(total_kes), 0) AS revenue
           FROM orders
          WHERE status = 'completed' AND DATE(created_at) = CURDATE()`
      );
      const [messages] = await pool.query(
        "SELECT COUNT(*) AS open_messages FROM messages WHERE status IN ('new','read','in_progress')"
      );
      const [deliveryStatus] = await pool.query(
        'SELECT status, COUNT(*) AS total FROM deliveries GROUP BY status'
      );
      const [drivers] = await pool.query(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'driver' AND active = 1"
      );
      const [issues] = await pool.query(
        "SELECT COUNT(*) AS total FROM deliveries WHERE status = 'issue'"
      );
      const counts = Object.fromEntries(byStatus.map((row) => [row.status, Number(row.total)]));
      res.json({
        ordersByStatus: counts,
        ordersToday: Number(today[0].orders),
        revenueTodayKes: Number(today[0].revenue),
        openMessages: Number(messages[0].open_messages),
        deliveriesByStatus: Object.fromEntries(
          deliveryStatus.map((row) => [row.status, Number(row.total)])
        ),
        activeDrivers: Number(drivers[0].total),
        openDeliveryIssues: Number(issues[0].total),
      });
    })
  );

  app.get(
    '/api/admin/users',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query(
        'SELECT id, email, full_name, role, branch_name, active, last_login_at, created_at FROM users ORDER BY created_at DESC'
      );
      res.json(
        rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.full_name,
          role: row.role,
          branch: row.branch_name,
          active: Boolean(row.active),
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
        }))
      );
    })
  );

  app.post(
    '/api/admin/users',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const email = v.normaliseEmail(req.body?.email, { required: true });
      const fullName = v.requiredString(req.body?.name, { max: 150, field: 'Full name' });
      if (fullName.length < 2) throw new HttpError(400, 'Full name must be at least 2 characters');
      const password = v.requiredString(req.body?.password, { field: 'Password', max: 200 });
      if (password.length < settings.auth.minPasswordLength) {
        throw new HttpError(400, `Password must be at least ${settings.auth.minPasswordLength} characters`);
      }
      const role = v.oneOf(req.body?.role, ROLES, { field: 'Role', fallback: 'branch_manager' });
      const branchName =
        role === 'central_admin'
          ? 'Nairobi'
          : v.requiredString(req.body?.branch, { max: 80, field: 'Branch' });
      if (!(await loadBranch(branchName, pool, { activeOnly: false }))) {
        throw new HttpError(400, 'Choose a valid branch');
      }
      const hash = await bcrypt.hash(password, 12);
      try {
        const [result] = await pool.execute(
          'INSERT INTO users (email, full_name, password_hash, role, branch_name) VALUES (?, ?, ?, ?, ?)',
          [email, fullName, hash, role, branchName]
        );
        res.status(201).json({ id: result.insertId, email, name: fullName, role, branch: branchName });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'A user with that email already exists');
        throw error;
      }
    })
  );

  app.patch(
    '/api/admin/users/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'User id' });
      const updates = [];
      const params = [];
      if (req.body?.active !== undefined) {
        if (Number(req.user.id) === id && req.body.active === false) {
          throw new HttpError(400, 'You cannot deactivate your own account');
        }
        updates.push('active = ?');
        params.push(v.booleanFlag(req.body.active));
      }
      if (req.body?.password !== undefined) {
        const password = v.requiredString(req.body.password, { field: 'Password', max: 200 });
        if (password.length < settings.auth.minPasswordLength) {
          throw new HttpError(400, `Password must be at least ${settings.auth.minPasswordLength} characters`);
        }
        updates.push('password_hash = ?');
        params.push(await bcrypt.hash(password, 12));
      }
      if (req.body?.name !== undefined) {
        updates.push('full_name = ?');
        params.push(v.optionalString(req.body.name, { max: 150, field: 'Full name' }));
      }
      if (req.body?.role !== undefined) {
        const role = v.oneOf(req.body.role, ROLES, { field: 'Role' });
        updates.push('role = ?');
        params.push(role);
      }
      if (req.body?.branch !== undefined) {
        const branchName = v.requiredString(req.body.branch, { max: 80, field: 'Branch' });
        if (!(await loadBranch(branchName, pool, { activeOnly: false }))) {
          throw new HttpError(400, 'Choose a valid branch');
        }
        updates.push('branch_name = ?');
        params.push(branchName);
      }
      if (!updates.length) throw new HttpError(400, 'Nothing to update');
      params.push(id);
      const [result] = await pool.execute(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      if (!result.affectedRows) throw new HttpError(404, 'User not found');
      res.json({ updated: true });
    })
  );

  // Messages
  app.get(
    '/api/admin/messages',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const filters = [];
      const params = [];
      if (req.query.status) {
        filters.push('status = ?');
        params.push(v.oneOf(req.query.status, MESSAGE_STATUSES, { field: 'Status' }));
      }
      if (req.query.branch) {
        filters.push('(from_branch = ? OR to_branch = ?)');
        const branch = v.requiredString(req.query.branch, { max: 80, field: 'Branch' });
        params.push(branch, branch);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT m.*, (SELECT COUNT(*) FROM message_replies r WHERE r.message_id = m.id) AS reply_count
           FROM messages m ${where}
          ORDER BY m.created_at DESC
          LIMIT 250`,
        params
      );
      res.json(rows.map(mapMessage));
    })
  );

  app.get(
    '/api/admin/messages/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Message id' });
      const [rows] = await pool.execute('SELECT * FROM messages WHERE id = ?', [id]);
      if (!rows.length) throw new HttpError(404, 'Message not found');
      const [replies] = await pool.execute(
        'SELECT id, author_email, reply_text, created_at FROM message_replies WHERE message_id = ? ORDER BY id',
        [id]
      );
      res.json({
        ...mapMessage(rows[0]),
        replies: replies.map((reply) => ({
          id: reply.id,
          author: reply.author_email,
          text: reply.reply_text,
          createdAt: reply.created_at,
        })),
      });
    })
  );

  app.patch(
    '/api/admin/messages/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Message id' });
      const updates = [];
      const params = [];
      if (req.body?.status !== undefined) {
        updates.push('status = ?');
        params.push(v.oneOf(req.body.status, MESSAGE_STATUSES, { field: 'Status' }));
      }
      if (req.body?.assignedTo !== undefined) {
        updates.push('assigned_to = ?');
        params.push(v.optionalString(req.body.assignedTo, { max: 190, field: 'Assigned to' }));
      }
      const reply = v.optionalString(req.body?.reply, { max: 5000, field: 'Reply' });

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute('SELECT id FROM messages WHERE id = ? FOR UPDATE', [id]);
        if (!rows.length) throw new HttpError(404, 'Message not found');
        if (updates.length) {
          params.push(id);
          await connection.execute(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        if (reply) {
          await connection.execute(
            'INSERT INTO message_replies (message_id, author_email, reply_text) VALUES (?, ?, ?)',
            [id, req.user.email, reply]
          );
          if (!updates.length) {
            await connection.execute("UPDATE messages SET status = 'in_progress' WHERE id = ?", [id]);
          }
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      res.json({ updated: true });
    })
  );

  // Orders
  app.get(
    '/api/admin/orders',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const filters = [];
      const params = [];
      if (req.query.branch) {
        filters.push('o.branch_name = ?');
        params.push(v.requiredString(req.query.branch, { max: 80, field: 'Branch' }));
      }
      if (req.query.status) {
        filters.push('o.status = ?');
        params.push(v.oneOf(req.query.status, orderFlow.STATUSES, { field: 'Status' }));
      }
      const limit = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
        500
      );
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT o.*, d.id AS delivery_id, d.status AS delivery_status,
                d.driver_id, d.issue_type AS delivery_issue_type,
                d.confirmed_at AS delivery_confirmed_at,
                u.email AS driver_email, u.full_name AS driver_name
           FROM orders o
           LEFT JOIN deliveries d ON d.order_id = o.id
           LEFT JOIN users u ON u.id = d.driver_id
           ${where}
          ORDER BY o.created_at DESC LIMIT ${limit}`,
        params
      );
      res.json(rows.map(mapOrderSummary));
    })
  );

  app.get(
    '/api/admin/orders/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Order id' });
      const order = await fetchOrderDetail(pool, id);
      if (!order) throw new HttpError(404, 'Order not found');
      res.json(order);
    })
  );

  app.patch(
    '/api/admin/orders/:id/status',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Order id' });
      const status = v.oneOf(req.body?.status, orderFlow.STATUSES, { field: 'Status' });
      const note = v.optionalString(req.body?.note, { max: 255, field: 'Note' });
      const order = await changeOrderStatus({
        orderId: id,
        to: status,
        actor: req.user,
        note,
        force: true,
      });
      res.json(order);
    })
  );

  // Deliveries and drivers
  app.get(
    '/api/admin/drivers',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const filters = ["u.role = 'driver'", 'u.active = 1'];
      const params = [];
      if (req.query.branch) {
        filters.push('u.branch_name = ?');
        params.push(v.requiredString(req.query.branch, { max: 80, field: 'Branch' }));
      }
      const [rows] = await pool.query(
        `SELECT u.id, u.email, u.full_name, u.branch_name,
                (SELECT COUNT(*) FROM deliveries d
                  WHERE d.driver_id = u.id
                    AND d.status IN ('assigned','picked_up','arrived')) AS active_deliveries
           FROM users u
          WHERE ${filters.join(' AND ')}
          ORDER BY u.full_name ASC, u.email ASC`,
        params
      );
      res.json(
        rows.map((row) => ({
          id: row.id,
          name: row.full_name || row.email,
          email: row.email,
          branch: row.branch_name,
          activeDeliveries: Number(row.active_deliveries),
        }))
      );
    })
  );

  app.post(
    '/api/admin/orders/:id/assign-driver',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const orderId = v.positiveInt(req.params.id, { field: 'Order id' });
      const driverId = v.positiveInt(req.body?.driverId, { field: 'Driver' });
      const nextReadyAt = optionalDateTime(req.body?.nextReadyAt, 'Next ready date');
      const nextDeliveryAt = optionalDateTime(req.body?.nextDeliveryAt, 'Next delivery date');

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [orders] = await connection.execute(
          'SELECT * FROM orders WHERE id = ? FOR UPDATE',
          [orderId]
        );
        const order = orders[0];
        if (!order) throw new HttpError(404, 'Order not found');
        if (order.delivery_type !== 'delivery') {
          throw new HttpError(400, 'Only delivery orders can be assigned to a driver');
        }
        if (['completed', 'cancelled'].includes(order.status)) {
          throw new HttpError(409, 'Completed or cancelled orders cannot be assigned');
        }
        const [drivers] = await connection.execute(
          "SELECT id, email, full_name, branch_name FROM users WHERE id = ? AND role = 'driver' AND active = 1",
          [driverId]
        );
        const driver = drivers[0];
        if (!driver) throw new HttpError(400, 'Choose an active driver');
        if (driver.branch_name !== order.branch_name) {
          throw new HttpError(400, `${driver.email} is not assigned to ${order.branch_name}`);
        }
        const [existing] = await connection.execute(
          'SELECT * FROM deliveries WHERE order_id = ? FOR UPDATE',
          [orderId]
        );
        if (existing.length && existing[0].status === 'delivered') {
          throw new HttpError(409, 'This delivery is already confirmed');
        }
        const token = existing.length ? existing[0].token : deliveryFlow.confirmationToken();
        await connection.execute(
          `INSERT INTO deliveries
            (order_id, driver_id, branch_name, token, status, next_ready_at, next_delivery_at,
             assigned_by, assigned_at)
           VALUES (?, ?, ?, ?, 'assigned', ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE
             driver_id = VALUES(driver_id),
             branch_name = VALUES(branch_name),
             status = 'assigned',
             next_ready_at = VALUES(next_ready_at),
             next_delivery_at = VALUES(next_delivery_at),
             assigned_by = VALUES(assigned_by),
             assigned_at = NOW(),
             picked_up_at = NULL,
             arrived_at = NULL,
             confirmed_at = NULL,
             confirmed_by = NULL,
             issue_type = NULL,
             issue_note = NULL,
             issue_reported_at = NULL`,
          [
            orderId,
            driverId,
            order.branch_name,
            token,
            nextReadyAt,
            nextDeliveryAt,
            req.user.email,
          ]
        );
        await connection.execute(
          'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
          [
            order.branch_name,
            'delivery_assigned',
            orderId,
            `Order #${orderId} assigned to driver ${driver.full_name || driver.email}`,
          ]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      const delivery = await fetchDeliveryDetail(pool, 'd.order_id = ?', [orderId]);
      res.json({ delivery });
    })
  );

  app.get(
    '/api/admin/deliveries',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const filters = [];
      const params = [];
      if (req.query.status) {
        filters.push('d.status = ?');
        params.push(v.oneOf(req.query.status, deliveryFlow.STATUSES, { field: 'Status' }));
      }
      if (req.query.branch) {
        filters.push('d.branch_name = ?');
        params.push(v.requiredString(req.query.branch, { max: 80, field: 'Branch' }));
      }
      if (req.query.driverId) {
        filters.push('d.driver_id = ?');
        params.push(v.positiveInt(req.query.driverId, { field: 'Driver id' }));
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `${DELIVERY_SELECT} ${where} ORDER BY d.updated_at DESC LIMIT 250`,
        params
      );
      res.json(rows.map((row) => mapDelivery(row, settings.publicBaseUrl)));
    })
  );

  app.get(
    '/api/admin/deliveries/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [id]);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      res.json(delivery);
    })
  );

  app.post(
    '/api/admin/deliveries/:id/confirm',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const result = await confirmDelivery({
        deliveryId: id,
        actorEmail: req.user.email,
        force: true,
      });
      res.json({
        confirmed: true,
        duplicate: result.already,
        delivery: result.delivery,
        email: result.email,
      });
    })
  );

  app.patch(
    '/api/admin/deliveries/:id/resolve-issue',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const note = v.optionalString(req.body?.note, { max: 500, field: 'Resolution note' });
      const [rows] = await pool.execute('SELECT * FROM deliveries WHERE id = ?', [id]);
      if (!rows.length) throw new HttpError(404, 'Delivery not found');
      if (rows[0].status !== 'issue') throw new HttpError(409, 'This delivery has no open issue');
      await pool.execute(
        "UPDATE deliveries SET status = 'arrived', issue_type = NULL, issue_note = CONCAT(COALESCE(issue_note, ''), ?) WHERE id = ?",
        [note ? `\n[Resolved] ${note}` : '\n[Resolved]', id]
      );
      const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [id]);
      res.json({ resolved: true, delivery });
    })
  );

  app.patch(
    '/api/admin/deliveries/:id/schedule',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const nextReadyAt = optionalDateTime(req.body?.nextReadyAt, 'Next ready date');
      const nextDeliveryAt = optionalDateTime(req.body?.nextDeliveryAt, 'Next delivery date');
      const [result] = await pool.execute(
        'UPDATE deliveries SET next_ready_at = ?, next_delivery_at = ? WHERE id = ?',
        [nextReadyAt, nextDeliveryAt, id]
      );
      if (!result.affectedRows) throw new HttpError(404, 'Delivery not found');
      const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [id]);
      const email =
        delivery.customer.email && (nextReadyAt || nextDeliveryAt)
          ? await emailer.nextDelivery(delivery)
          : null;
      res.json({ delivery, email });
    })
  );

  app.post(
    '/api/admin/deliveries/:id/send-link',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [id]);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      if (delivery.status !== 'arrived') {
        throw new HttpError(409, 'The confirmation link can be sent after the driver marks arrival');
      }
      const email = await emailer.arrival(delivery);
      res.json({ sent: email.status !== 'failed', email });
    })
  );

  app.get(
    '/api/admin/emails',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query(
        `SELECT id, order_id, recipient, subject, kind, status, error, sent_at, created_at
           FROM email_outbox ORDER BY id DESC LIMIT 100`
      );
      res.json(
        rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          recipient: row.recipient,
          subject: row.subject,
          kind: row.kind,
          status: row.status,
          error: row.error,
          sentAt: row.sent_at,
          createdAt: row.created_at,
        }))
      );
    })
  );

  // Admin menu management
  app.get(
    '/api/admin/meals',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const branchName = v.requiredString(req.query.branch, { max: 80, field: 'Branch' });
      const [rows] = await pool.execute(
        'SELECT id, branch_name, meal_name, description, category, price_kes, available FROM branch_meals WHERE branch_name = ? ORDER BY id',
        [branchName]
      );
      res.json(
        rows.map((row) => ({
          id: row.id,
          branch: row.branch_name,
          name: row.meal_name,
          description: row.description,
          category: row.category,
          priceKes: Number(row.price_kes),
          available: Boolean(row.available),
        }))
      );
    })
  );

  app.patch(
    '/api/admin/meals/:id',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Meal id' });
      const updates = [];
      const params = [];
      if (req.body?.priceKes !== undefined) {
        updates.push('price_kes = ?');
        params.push(v.positiveInt(req.body.priceKes, { field: 'Price', min: 0, max: 1000000 }));
      }
      if (req.body?.available !== undefined) {
        updates.push('available = ?');
        params.push(v.booleanFlag(req.body.available));
      }
      if (req.body?.description !== undefined) {
        updates.push('description = ?');
        params.push(v.optionalString(req.body.description, { max: 255, field: 'Description' }));
      }
      if (req.body?.category !== undefined) {
        updates.push('category = ?');
        params.push(v.requiredString(req.body.category, { max: 80, field: 'Category' }));
      }
      if (!updates.length) throw new HttpError(400, 'Nothing to update');
      params.push(id);
      const [result] = await pool.execute(
        `UPDATE branch_meals SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      if (!result.affectedRows) throw new HttpError(404, 'Menu item not found');
      res.json({ updated: true });
    })
  );

  app.get(
    '/api/admin/notifications',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query(
        'SELECT id, branch_name, event_type, reference_id, message, read_at, created_at FROM branch_notifications ORDER BY created_at DESC LIMIT 100'
      );
      res.json(
        rows.map((row) => ({
          id: row.id,
          branch: row.branch_name,
          eventType: row.event_type,
          referenceId: row.reference_id,
          message: row.message,
          readAt: row.read_at,
          createdAt: row.created_at,
        }))
      );
    })
  );

  app.patch(
    '/api/admin/notifications/:id/read',
    auth.requireRole('central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Notification id' });
      const [result] = await pool.execute(
        'UPDATE branch_notifications SET read_at = NOW() WHERE id = ? AND read_at IS NULL',
        [id]
      );
      res.json({ updated: result.affectedRows > 0 });
    })
  );

  // ---------------------------------------------------------------- branch manager
  app.get(
    '/api/branch/orders',
    auth.requireRole('branch_manager', 'central_admin'),
    asyncHandler(async (req, res) => {
      const branchName = branchScopeFor(req, req.query.branch);
      const filters = [];
      const params = [];
      if (branchName) {
        filters.push('o.branch_name = ?');
        params.push(branchName);
      }
      if (req.query.status) {
        filters.push('o.status = ?');
        params.push(v.oneOf(req.query.status, orderFlow.STATUSES, { field: 'Status' }));
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT o.*, d.id AS delivery_id, d.status AS delivery_status,
                d.driver_id, d.issue_type AS delivery_issue_type,
                d.confirmed_at AS delivery_confirmed_at,
                u.email AS driver_email, u.full_name AS driver_name
           FROM orders o
           LEFT JOIN deliveries d ON d.order_id = o.id
           LEFT JOIN users u ON u.id = d.driver_id
           ${where}
          ORDER BY o.created_at DESC LIMIT 250`,
        params
      );
      res.json(rows.map(mapOrderSummary));
    })
  );

  app.get(
    '/api/branch/orders/:id',
    auth.requireRole('branch_manager', 'central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Order id' });
      const order = await fetchOrderDetail(pool, id);
      if (!order) throw new HttpError(404, 'Order not found');
      if (req.user.role !== 'central_admin' && order.branch !== req.user.branch) {
        throw new HttpError(403, 'This order belongs to another branch');
      }
      res.json(order);
    })
  );

  app.patch(
    '/api/branch/orders/:id/status',
    auth.requireRole('branch_manager', 'central_admin'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Order id' });
      const status = v.oneOf(req.body?.status, orderFlow.STATUSES, { field: 'Status' });
      const note = v.optionalString(req.body?.note, { max: 255, field: 'Note' });
      const order = await changeOrderStatus({
        orderId: id,
        to: status,
        actor: req.user,
        branchScope: req.user.role === 'central_admin' ? null : req.user.branch,
        note,
        force: false,
      });
      res.json(order);
    })
  );

  app.get(
    '/api/branch/messages',
    auth.requireRole('branch_manager', 'central_admin'),
    asyncHandler(async (req, res) => {
      const branchName = branchScopeFor(req, req.query.branch);
      const filters = [];
      const params = [];
      if (branchName) {
        filters.push('(from_branch = ? OR to_branch = ?)');
        params.push(branchName, branchName);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json(rows.map(mapMessage));
    })
  );

  app.get(
    '/api/branch/notifications',
    auth.requireRole('branch_manager', 'central_admin'),
    asyncHandler(async (req, res) => {
      const branchName = branchScopeFor(req, req.query.branch);
      const filters = ['read_at IS NULL'];
      const params = [];
      if (branchName) {
        filters.push('branch_name = ?');
        params.push(branchName);
      }
      const [rows] = await pool.query(
        `SELECT id, branch_name, event_type, reference_id, message, created_at
           FROM branch_notifications
          WHERE ${filters.join(' AND ')}
          ORDER BY created_at DESC LIMIT 100`,
        params
      );
      res.json(rows);
    })
  );

  // ---------------------------------------------------------------- driver portal
  app.get(
    '/api/driver/deliveries',
    auth.requireRole('driver'),
    asyncHandler(async (req, res) => {
      const filters = ['d.driver_id = ?'];
      const params = [req.user.id];
      if (req.query.status) {
        filters.push('d.status = ?');
        params.push(v.oneOf(req.query.status, deliveryFlow.STATUSES, { field: 'Status' }));
      }
      const [rows] = await pool.query(
        `${DELIVERY_SELECT} WHERE ${filters.join(' AND ')} ORDER BY d.updated_at DESC LIMIT 200`,
        params
      );
      res.json(rows.map((row) => mapDelivery(row, settings.publicBaseUrl)));
    })
  );

  app.get(
    '/api/driver/deliveries/:id',
    auth.requireRole('driver'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const delivery = await fetchDeliveryDetail(pool, 'd.id = ? AND d.driver_id = ?', [
        id,
        req.user.id,
      ]);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      res.json(delivery);
    })
  );

  app.patch(
    '/api/driver/deliveries/:id/status',
    auth.requireRole('driver'),
    asyncHandler(async (req, res) => {
      const id = v.positiveInt(req.params.id, { field: 'Delivery id' });
      const status = v.oneOf(req.body?.status, deliveryFlow.DRIVER_ACTIONS, {
        field: 'Delivery status',
      });

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute(
          'SELECT * FROM deliveries WHERE id = ? AND driver_id = ? FOR UPDATE',
          [id, req.user.id]
        );
        const delivery = rows[0];
        if (!delivery) throw new HttpError(404, 'Delivery not found');
        deliveryFlow.assertTransition(delivery.status, status);

        if (status === 'picked_up') {
          await connection.execute(
            'UPDATE deliveries SET status = ?, picked_up_at = NOW() WHERE id = ?',
            [status, id]
          );
          const [orders] = await connection.execute(
            'SELECT id, status, branch_name FROM orders WHERE id = ? FOR UPDATE',
            [delivery.order_id]
          );
          const order = orders[0];
          if (order && order.status === 'ready') {
            await connection.execute("UPDATE orders SET status = 'out_for_delivery' WHERE id = ?", [
              order.id,
            ]);
            await connection.execute(
              `INSERT INTO order_status_history
                (order_id, from_status, to_status, changed_by, note)
               VALUES (?, 'ready', 'out_for_delivery', ?, 'Driver picked up the order')`,
              [order.id, req.user.email]
            );
            await connection.execute(
              'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
              [order.branch_name, 'order_status', order.id, orderFlow.statusNotification('out_for_delivery', order.id)]
            );
          }
        } else {
          await connection.execute(
            'UPDATE deliveries SET status = ?, arrived_at = NOW() WHERE id = ?',
            [status, id]
          );
        }

        await connection.execute(
          'INSERT INTO branch_notifications (branch_name, event_type, reference_id, message) VALUES (?, ?, ?, ?)',
          [
            delivery.branch_name,
            'delivery_status',
            delivery.order_id,
            deliveryFlow.statusNotification(status, delivery.order_id),
          ]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      const delivery = await fetchDeliveryDetail(pool, 'd.id = ?', [id]);
      const email = status === 'arrived' ? await emailer.arrival(delivery) : null;
      res.json({ delivery, confirmationUrl: delivery.confirmationUrl, email });
    })
  );

  // ---------------------------------------------------------------- static site
  app.use(express.static(PUBLIC_DIR, { maxAge: settings.isProduction ? '1h' : 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ---------------------------------------------------------------- errors
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500;
    let message = error.message || 'Something went wrong';
    if (error.type === 'entity.parse.failed') {
      status = 400;
      message = 'Request body must be valid JSON';
    }
    if (status >= 500) {
      logger.error(error);
      if (settings.isProduction) message = 'Something went wrong';
    }
    const body = { error: message };
    if (error.details !== undefined) body.details = error.details;
    res.status(status).json(body);
  });

  return app;
}

// ---------------------------------------------------------------- serialisers
function mapBranch(row) {
  return {
    name: row.branch_name,
    displayName: row.display_name,
    isHeadquarters: Boolean(row.is_headquarters),
    phone: row.phone,
    address: row.address,
    deliveryFeeKes: Number(row.delivery_fee_kes),
    freeDeliveryThresholdKes: Number(row.free_delivery_threshold_kes),
    minOrderKes: Number(row.min_order_kes),
    acceptingOrders: Boolean(row.accepting_orders),
  };
}

function mapOrderSummary(row) {
  return {
    id: row.id,
    branch: row.branch_name,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
    },
    deliveryType: row.delivery_type,
    deliveryAddress: row.delivery_address,
    totalKes: Number(row.total_kes),
    subtotalKes: Number(row.subtotal_kes),
    discountKes: Number(row.discount_kes),
    deliveryFeeKes: Number(row.delivery_fee_kes),
    promotionCode: row.promotion_code,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextStatuses: orderFlow.nextStatuses(row.status),
    delivery: row.delivery_id
      ? {
          id: Number(row.delivery_id),
          status: row.delivery_status,
          driver: {
            name: row.driver_name || row.driver_email,
            email: row.driver_email,
          },
          issueType: row.delivery_issue_type,
          confirmedAt: row.delivery_confirmed_at,
        }
      : null,
  };
}

function mapOrder(row, items, history) {
  return {
    ...mapOrderSummary(row),
    notes: row.notes,
    items: (items || []).map((item) => ({
      id: item.id,
      mealId: item.meal_id,
      name: item.meal_name,
      category: item.category,
      quantity: Number(item.quantity),
      unitPriceKes: Number(item.unit_price_kes),
      lineTotalKes: Number(item.line_total_kes),
    })),
    history: (history || []).map((entry) => ({
      from: entry.from_status,
      to: entry.to_status,
      changedBy: entry.changed_by,
      note: entry.note,
      createdAt: entry.created_at,
    })),
  };
}

function mapDeliveryForOrder(row, publicBaseUrl) {
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    branch: row.branch_name,
    status: row.status,
    token: row.token,
    confirmationUrl: `${publicBaseUrl}/confirm.html?token=${row.token}`,
    driver: {
      id: Number(row.driver_id),
      name: row.driver_name || row.driver_email,
      email: row.driver_email,
    },
    nextReadyAt: row.next_ready_at,
    nextDeliveryAt: row.next_delivery_at,
    assignedAt: row.assigned_at,
    pickedUpAt: row.picked_up_at,
    arrivedAt: row.arrived_at,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    issue: row.issue_type
      ? {
          type: row.issue_type,
          label: deliveryFlow.issueLabel(row.issue_type),
          note: row.issue_note,
          reportedAt: row.issue_reported_at,
        }
      : null,
    canCustomerConfirm: row.status === 'arrived',
  };
}

function mapDelivery(row, publicBaseUrl) {
  return {
    ...mapDeliveryForOrder(row, publicBaseUrl),
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
    },
    deliveryType: row.delivery_type,
    deliveryAddress: row.delivery_address,
    orderStatus: row.order_status,
    orderNotes: row.order_notes,
    orderCreatedAt: row.order_created_at,
    subtotalKes: Number(row.subtotal_kes || 0),
    totalKes: Number(row.total_kes || 0),
    items: (row.items || []).map((item) => ({
      id: item.id,
      name: item.meal_name,
      category: item.category,
      quantity: Number(item.quantity),
      unitPriceKes: Number(item.unit_price_kes),
      lineTotalKes: Number(item.line_total_kes),
    })),
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    fromBranch: row.from_branch,
    toBranch: row.to_branch,
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    subject: row.subject,
    message: row.message,
    priority: row.priority,
    status: row.status,
    assignedTo: row.assigned_to,
    replyCount: row.reply_count === undefined ? undefined : Number(row.reply_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  createApp,
  mapBranch,
  mapOrderSummary,
  mapOrder,
  mapDelivery,
  mapDeliveryForOrder,
  mapMessage,
};
