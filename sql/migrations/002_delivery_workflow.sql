-- TasteHub Kenya - delivery assignment, driver portal, customer confirmation
-- and issue reporting.
--
-- Apply to an existing database before starting the updated server:
--   mysql -u root -p tastehub_kenya < sql/migrations/002_delivery_workflow.sql

USE tastehub_kenya;

ALTER TABLE users
  MODIFY COLUMN role ENUM('central_admin','branch_manager','driver','staff')
    NOT NULL DEFAULT 'staff';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(150) NULL AFTER email;

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
