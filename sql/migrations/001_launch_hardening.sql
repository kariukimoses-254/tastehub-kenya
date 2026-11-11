-- Upgrade an existing TasteHub Kenya database created from the original starter.
-- Safe to run more than once. Run with: mysql -u root tastehub_kenya < sql/migrations/001_launch_hardening.sql
USE tastehub_kenya;

CREATE TABLE IF NOT EXISTS branches (
  branch_name VARCHAR(80) PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  is_headquarters BOOLEAN NOT NULL DEFAULT FALSE,
  phone VARCHAR(40),
  address VARCHAR(255),
  delivery_fee_kes INT UNSIGNED NOT NULL DEFAULT 0,
  free_delivery_threshold_kes INT UNSIGNED NOT NULL DEFAULT 0,
  min_order_kes INT UNSIGNED NOT NULL DEFAULT 0,
  accepting_orders BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  opening_time TIME NULL,
  closing_time TIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS promotions (
  code VARCHAR(40) PRIMARY KEY,
  description VARCHAR(200),
  discount_percent TINYINT UNSIGNED NOT NULL,
  max_discount_kes INT UNSIGNED NULL,
  min_subtotal_kes INT UNSIGNED NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at DATETIME NULL,
  ends_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS branch_meals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(80) NOT NULL,
  meal_name VARCHAR(180) NOT NULL,
  description VARCHAR(255),
  category VARCHAR(80) NOT NULL DEFAULT 'Other',
  price_kes INT UNSIGNED NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  image_url VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_branch_meal (branch_name, meal_name),
  INDEX idx_branch_meals_category (branch_name, category, available),
  CONSTRAINT fk_branch_meals_branch FOREIGN KEY (branch_name)
    REFERENCES branches (branch_name) ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_status_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  changed_by VARCHAR(190) NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_history_order (order_id, created_at),
  CONSTRAINT fk_status_history_order FOREIGN KEY (order_id)
    REFERENCES orders (id) ON DELETE CASCADE
) ENGINE=InnoDB;

DROP PROCEDURE IF EXISTS th_add_column;
DROP PROCEDURE IF EXISTS th_add_index;

DELIMITER //
CREATE PROCEDURE th_add_column(IN tbl VARCHAR(64), IN col VARCHAR(64), IN def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

CREATE PROCEDURE th_add_index(IN tbl VARCHAR(64), IN idx VARCHAR(64), IN def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', tbl, '` ADD ', def);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL th_add_column('users', 'last_login_at', 'TIMESTAMP NULL');
CALL th_add_column('orders', 'client_request_id', 'VARCHAR(64) NULL');
CALL th_add_column('orders', 'customer_email', 'VARCHAR(190) NULL');
CALL th_add_column('orders', 'notes', 'VARCHAR(500) NULL');
CALL th_add_column('orders', 'subtotal_kes', 'INT UNSIGNED NOT NULL DEFAULT 0');
CALL th_add_column('orders', 'discount_kes', 'INT UNSIGNED NOT NULL DEFAULT 0');
CALL th_add_column('orders', 'delivery_fee_kes', 'INT UNSIGNED NOT NULL DEFAULT 0');
CALL th_add_column('orders', 'promotion_code', 'VARCHAR(40) NULL');
CALL th_add_column('orders', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
CALL th_add_index('orders', 'uq_orders_request', 'UNIQUE KEY uq_orders_request (client_request_id)');
CALL th_add_index('orders', 'idx_orders_created', 'INDEX idx_orders_created (created_at)');
CALL th_add_column('order_items', 'meal_id', 'BIGINT UNSIGNED NULL');
CALL th_add_column('order_items', 'category', "VARCHAR(80) NOT NULL DEFAULT 'Other'");
CALL th_add_column('messages', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

DROP PROCEDURE IF EXISTS th_add_column;
DROP PROCEDURE IF EXISTS th_add_index;

-- Backfill the new money columns for existing orders.
UPDATE orders SET subtotal_kes = total_kes WHERE subtotal_kes = 0;
