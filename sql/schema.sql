-- TasteHub Kenya - schema for a fresh installation.
-- For an existing installation, run sql/migrations/001_launch_hardening.sql instead.
CREATE DATABASE IF NOT EXISTS tastehub_kenya CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE tastehub_kenya;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  full_name VARCHAR(150) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('central_admin','branch_manager','driver','staff') NOT NULL DEFAULT 'staff',
  branch_name VARCHAR(80),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

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

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(80) NOT NULL,
  client_request_id VARCHAR(64) NULL,
  customer_name VARCHAR(150) NOT NULL,
  customer_phone VARCHAR(40) NOT NULL,
  customer_email VARCHAR(190) NULL,
  delivery_type ENUM('collection','delivery') NOT NULL DEFAULT 'collection',
  delivery_address TEXT NULL,
  notes VARCHAR(500) NULL,
  subtotal_kes INT UNSIGNED NOT NULL DEFAULT 0,
  discount_kes INT UNSIGNED NOT NULL DEFAULT 0,
  delivery_fee_kes INT UNSIGNED NOT NULL DEFAULT 0,
  total_kes INT UNSIGNED NOT NULL,
  promotion_code VARCHAR(40) NULL,
  status ENUM('received','confirmed','preparing','ready','out_for_delivery','completed','cancelled')
    NOT NULL DEFAULT 'received',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_request (client_request_id),
  INDEX idx_orders_branch_status (branch_name, status, created_at),
  INDEX idx_orders_created (created_at),
  CONSTRAINT fk_orders_branch FOREIGN KEY (branch_name)
    REFERENCES branches (branch_name) ON UPDATE CASCADE,
  CONSTRAINT fk_orders_promotion FOREIGN KEY (promotion_code)
    REFERENCES promotions (code) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  meal_id BIGINT UNSIGNED NULL,
  meal_name VARCHAR(180) NOT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'Other',
  quantity SMALLINT UNSIGNED NOT NULL,
  unit_price_kes INT UNSIGNED NOT NULL,
  line_total_kes INT UNSIGNED NOT NULL,
  INDEX idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id)
    REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_meal FOREIGN KEY (meal_id)
    REFERENCES branch_meals (id) ON DELETE SET NULL
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

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_branch VARCHAR(80) NOT NULL,
  to_branch VARCHAR(80) NULL,
  sender_name VARCHAR(150),
  sender_email VARCHAR(190),
  subject VARCHAR(200),
  message TEXT NOT NULL,
  priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status ENUM('new','read','in_progress','resolved','forwarded') NOT NULL DEFAULT 'new',
  assigned_to VARCHAR(190),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_messages_status (status, created_at),
  INDEX idx_messages_route (from_branch, to_branch),
  CONSTRAINT fk_messages_from FOREIGN KEY (from_branch)
    REFERENCES branches (branch_name) ON UPDATE CASCADE,
  CONSTRAINT fk_messages_to FOREIGN KEY (to_branch)
    REFERENCES branches (branch_name) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS message_replies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  author_email VARCHAR(190) NOT NULL,
  reply_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_replies_message (message_id, created_at),
  CONSTRAINT fk_replies_message FOREIGN KEY (message_id)
    REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS branch_notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  branch_name VARCHAR(80) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  reference_id BIGINT UNSIGNED,
  message VARCHAR(500) NOT NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notifications_branch (branch_name, read_at, created_at)
) ENGINE=InnoDB;

-- One active delivery assignment per order. The token is the customer's
-- no-login key for confirming the delivery or reporting a problem.
CREATE TABLE IF NOT EXISTS deliveries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  driver_id BIGINT UNSIGNED NOT NULL,
  branch_name VARCHAR(80) NOT NULL,
  token CHAR(64) NOT NULL,
  status ENUM('assigned','picked_up','arrived','delivered','issue','cancelled')
    NOT NULL DEFAULT 'assigned',
  next_ready_at DATETIME NULL,
  next_delivery_at DATETIME NULL,
  assigned_by VARCHAR(190) NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  picked_up_at DATETIME NULL,
  arrived_at DATETIME NULL,
  confirmed_at DATETIME NULL,
  confirmed_by VARCHAR(190) NULL,
  issue_type ENUM('wrong_delivery','breakage','missing_item','late','other') NULL,
  issue_note TEXT NULL,
  issue_reported_at DATETIME NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_deliveries_order (order_id),
  UNIQUE KEY uq_deliveries_token (token),
  INDEX idx_deliveries_driver (driver_id, status),
  INDEX idx_deliveries_branch (branch_name, status),
  CONSTRAINT fk_deliveries_order FOREIGN KEY (order_id)
    REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_deliveries_driver FOREIGN KEY (driver_id)
    REFERENCES users (id) ON UPDATE CASCADE,
  CONSTRAINT fk_deliveries_branch FOREIGN KEY (branch_name)
    REFERENCES branches (branch_name) ON UPDATE CASCADE
) ENGINE=InnoDB;

-- Every message that would be emailed to a customer is recorded here, even
-- when SMTP is not configured (status = logged). Configure SMTP_* to send.
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NULL,
  recipient VARCHAR(190) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  kind VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_order (order_id, created_at),
  CONSTRAINT fk_email_order FOREIGN KEY (order_id)
    REFERENCES orders (id) ON DELETE SET NULL
) ENGINE=InnoDB;
