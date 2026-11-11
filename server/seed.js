#!/usr/bin/env node
/**
 * Create/upgrade the schema and load the sample branch catalogue.
 * Usage: npm run db:seed
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { BRANCHES, CATALOGUE, PROMOTIONS, mealPriceForBranch } = require('./lib/catalogue');

async function main() {
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    multipleStatements: true,
  });

  try {
    const databaseName = config.database.database;
    console.log(`Preparing database ${databaseName} ...`);
    await connection
      .query(
        `CREATE DATABASE IF NOT EXISTS \`${databaseName.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      )
      .catch((error) => {
        if (error.code !== 'ER_DBACCESS_DENIED_ERROR') throw error;
        console.warn(`[seed] No permission to create ${databaseName}; assuming it already exists.`);
      });
    await connection.changeUser({ database: databaseName });
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    const schema = fs
      .readFileSync(schemaPath, 'utf8')
      .replace(/CREATE\s+DATABASE[^;]*;/gi, '')
      .replace(/^\s*USE\s+[^;]+;/gim, '');
    console.log('Applying sql/schema.sql ...');
    await connection.query(schema);

    for (const branch of BRANCHES) {
      await connection.execute(
        `INSERT INTO branches
          (branch_name, display_name, is_headquarters, phone, address, delivery_fee_kes,
           free_delivery_threshold_kes, min_order_kes, accepting_orders, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           is_headquarters = VALUES(is_headquarters),
           phone = VALUES(phone),
           address = VALUES(address),
           delivery_fee_kes = VALUES(delivery_fee_kes),
           free_delivery_threshold_kes = VALUES(free_delivery_threshold_kes),
           min_order_kes = VALUES(min_order_kes),
           active = VALUES(active)`,
        [
          branch.branch_name,
          branch.display_name,
          branch.is_headquarters,
          branch.phone,
          branch.address,
          branch.delivery_fee_kes,
          branch.free_delivery_threshold_kes,
          branch.min_order_kes,
          branch.accepting_orders,
          branch.active,
        ]
      );

      for (const meal of CATALOGUE) {
        await connection.execute(
          `INSERT INTO branch_meals
            (branch_name, meal_name, description, category, price_kes, available)
           VALUES (?, ?, ?, ?, ?, TRUE)
           ON DUPLICATE KEY UPDATE
             description = VALUES(description),
             category = VALUES(category),
             price_kes = VALUES(price_kes)`,
          [
            branch.branch_name,
            meal.meal_name,
            meal.description,
            meal.category,
            mealPriceForBranch(meal.base_price_kes, branch),
          ]
        );
      }
    }

    for (const promotion of PROMOTIONS) {
      await connection.execute(
        `INSERT INTO promotions
          (code, description, discount_percent, max_discount_kes, min_subtotal_kes, active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           description = VALUES(description),
           discount_percent = VALUES(discount_percent),
           max_discount_kes = VALUES(max_discount_kes),
           min_subtotal_kes = VALUES(min_subtotal_kes),
           active = VALUES(active)`,
        [
          promotion.code,
          promotion.description,
          promotion.discount_percent,
          promotion.max_discount_kes,
          promotion.min_subtotal_kes,
          promotion.active,
        ]
      );
    }

    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || '';
    if (adminEmail && adminPassword.length >= config.auth.minPasswordLength) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await connection.execute(
        `INSERT INTO users (email, password_hash, role, branch_name)
         VALUES (?, ?, 'central_admin', 'Nairobi')
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'central_admin', branch_name = 'Nairobi'`,
        [adminEmail, hash]
      );
      console.log(`Central administrator ready: ${adminEmail}`);
    }

    const [mealCount] = await connection.query('SELECT COUNT(*) AS total FROM branch_meals');
    const [branchCount] = await connection.query('SELECT COUNT(*) AS total FROM branches');
    console.log(`Seed complete: ${branchCount[0].total} branches, ${mealCount[0].total} branch menu items.`);
    console.log('Sample prices only - replace them with approved branch prices before launch.');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('Database seed failed:', error.message);
  process.exitCode = 1;
});
