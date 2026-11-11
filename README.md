# TasteHub Kenya — multi-branch restaurant ordering

TasteHub uses one shared brand, but every order belongs to exactly one selected branch. Nairobi is the confirmed headquarters. Mombasa, Kisumu, Nakuru and Eldoret are example branches; replace or reconfigure them with the outlets that actually operate before launch.

The app now has a launch-hardened ordering flow: branch-specific menus and prices, server-side order validation, delivery fees and minimum orders, the `TASTE30` promotion, an order status workflow, a central HQ dashboard, and role-scoped branch manager API access.

## Stack

- Node.js 20+ and Express 4
- MySQL 8 or MariaDB 10.4+
- `mysql2`, `jsonwebtoken`, `bcryptjs`, `helmet`, `cors`, `dotenv`
- Plain HTML/CSS/JavaScript front ends in `public/`

## Included

- Customer page (`public/index.html`) that loads branches and menu items from the API.
- Branch selector with live branch details: delivery fee, free-delivery threshold and minimum order.
- Cart, promo preview, collection/delivery choice, customer details and idempotent checkout.
- Prices always come from the branch catalogue on the server; client-supplied prices are ignored.
- Central HQ dashboard (`public/admin.html`) for orders, deliveries, driver assignment, messages, menu prices, staff accounts and recent activity.
- Branch manager dashboard (`public/branch.html`) scoped to one branch: live order queue, stats, status updates, messages and unread notifications.
- Driver portal (`public/driver.html`) showing only the driver's assigned deliveries, with pickup and arrival actions.
- Customer confirmation page (`public/confirm.html`) opened from an emailed tokenised link. No customer login is needed.
- Delivery workflow with assignment, pickup, arrival, customer confirmation, problem reports and next-delivery scheduling.
- Delivery emails through SMTP, plus an `email_outbox` record for every message (logged when SMTP is not configured).
- Branch manager API that lists and updates only that branch's orders.
- JWT authentication, bcrypt password hashes, request validation, rate limiting and optional CORS.
- Central message inbox with sender, origin branch, destination branch, priority, status and timestamp.
- Automated tests for pricing, workflow and validation.

## Run locally

1. Install Node.js LTS and start MySQL (for example from XAMPP).
2. Copy `.env.example` to `.env` and fill in the database settings. Set a long random `JWT_SECRET`. Optionally set `ADMIN_EMAIL` and `ADMIN_PASSWORD` so the seed creates the first central administrator.
3. In a terminal in this folder:

   ```bash
   npm install
   npm run db:seed
   npm start
   ```

   `npm run db:seed` creates the `tastehub_kenya` database if needed, applies `sql/schema.sql`, loads the sample branch catalogue and promotion, and creates or updates the seeded administrator.

4. Open:

   - Customer page: `http://localhost:5000`
   - HQ dashboard: `http://localhost:5000/admin.html`
   - Branch dashboard: `http://localhost:5000/branch.html`
   - Driver portal: `http://localhost:5000/driver.html`

   If port 5000 is already in use, set `PORT=5050` in `.env` and use `http://localhost:5050` instead.

Keep the application server and MySQL on the same timezone. The schema uses `CURRENT_TIMESTAMP` for order history, and `server/db.js` reads those wall-clock values as local time so order times and “Completed today” stay correct.

On Windows, if PowerShell blocks `npm.ps1`, use `npm.cmd install`, `npm.cmd run db:seed`, `npm.cmd start` and `npm.cmd test`.

### Existing database

For an existing installation, apply the migration instead of relying on `schema.sql`:

```bash
mysql -u root -p tastehub_kenya < sql/migrations/001_launch_hardening.sql
mysql -u root -p tastehub_kenya < sql/migrations/002_delivery_workflow.sql
```

Then run `npm run db:seed` to load the branch catalogue and promotion. The second migration adds the `driver` role, `users.full_name`, `deliveries` and `email_outbox`.

## Seeded administrator

`npm run db:seed` creates the administrator only when `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set and the password is at least `MIN_PASSWORD_LENGTH` (12 by default) characters. Sign in at `/admin.html`.

Re-running `db:seed` with `ADMIN_PASSWORD` set resets that administrator's password. Keep `.env` out of version control and use a secrets manager in production.

## Order API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service and database health |
| `GET` | `/api/branches` | Active branches and delivery rules |
| `GET` | `/api/menu?branch=Nairobi` | Branch menu, categories and active promotions |
| `POST` | `/api/orders` | Place an order |
| `GET` | `/api/orders/:id` | Customer order lookup |
| `POST` | `/api/auth/login` | Sign in and receive a JWT |
| `GET` | `/api/auth/me` | Current signed-in user |
| `GET` | `/api/admin/orders` | HQ order list |
| `GET` | `/api/admin/orders/:id` | Order detail and status history |
| `PATCH` | `/api/admin/orders/:id/status` | HQ status update or correction |
| `GET` | `/api/admin/drivers?branch=` | Active drivers and their workload |
| `POST` | `/api/admin/orders/:id/assign-driver` | Assign or reassign a delivery driver |
| `GET` | `/api/admin/deliveries` | Delivery list with status, branch and driver filters |
| `GET` | `/api/admin/deliveries/:id` | Delivery detail |
| `POST` | `/api/admin/deliveries/:id/confirm` | Record a phone confirmation |
| `PATCH` | `/api/admin/deliveries/:id/resolve-issue` | Close a customer problem report |
| `PATCH` | `/api/admin/deliveries/:id/schedule` | Save next ready/delivery dates and email the customer |
| `POST` | `/api/admin/deliveries/:id/send-link` | Resend the arrival confirmation email |
| `GET` | `/api/admin/emails` | Email outbox log |
| `GET` | `/api/delivery/:token` | Public delivery summary for the customer |
| `POST` | `/api/delivery/:token/confirm` | Customer confirms receipt |
| `POST` | `/api/delivery/:token/report` | Customer reports a problem |
| `GET` | `/api/driver/deliveries` | Deliveries assigned to the signed-in driver |
| `GET` | `/api/driver/deliveries/:id` | Driver's delivery detail |
| `PATCH` | `/api/driver/deliveries/:id/status` | Driver marks `picked_up` or `arrived` |
| `GET` | `/api/admin/messages` | Central message inbox |
| `PATCH` | `/api/admin/messages/:id` | Mark, resolve or reply to a message |
| `GET` | `/api/admin/meals?branch=` | Branch menu prices |
| `PATCH` | `/api/admin/meals/:id` | Update a branch price or availability |
| `GET/POST` | `/api/admin/users` | List or create staff accounts |
| `PATCH` | `/api/admin/users/:id` | Enable/disable an account or change role |
| `GET` | `/api/branch/orders` | Orders for the manager's branch only |
| `GET` | `/api/branch/orders/:id` | Branch-scoped order detail and history |
| `PATCH` | `/api/branch/orders/:id/status` | Valid status transition for that branch |
| `GET` | `/api/branch/messages` | Messages involving the manager's branch |
| `GET` | `/api/branch/notifications` | Unread branch notifications |

### Placing an order

`POST /api/orders` accepts:

```json
{
  "branch": "Nairobi",
  "items": [{ "name": "Chicken Biryani", "quantity": 2 }],
  "deliveryType": "delivery",
  "promotionCode": "TASTE30",
  "requestId": "b1d4c7f0-7c1e-4b4e-9d30-2f0d26b9f001",
  "notes": "Extra napkins",
  "customer": {
    "name": "Amina Otieno",
    "phone": "0712 345 678",
    "email": "amina@example.com",
    "address": "Westlands, Nairobi"
  }
}
```

- `items[].name` must match the selected branch's menu. Prices are read from `branch_meals`; any client price is ignored.
- `deliveryType` is `collection` or `delivery`. Delivery adds the branch fee unless the subtotal reaches its free-delivery threshold.
- The branch minimum order is enforced on the subtotal before discount.
- `requestId` makes retries idempotent: the same request returns the original order instead of creating a duplicate.
- The client never sends a total; the server returns the authoritative subtotal, discount, delivery fee and total.
- `customer.email` is required for delivery orders, because the delivery confirmation link is emailed. It is optional for collection orders.

### Promotion

`TASTE30` gives 30% off, capped at KSh 1,000, on subtotals of at least KSh 1,500. The promotion is validated again on the server.

## Order status workflow

Normal path:

```text
received -> confirmed -> preparing -> ready -> out_for_delivery -> completed
```

- `cancelled` is available as an alternative next step.
- Collection orders may move from `ready` directly to `completed`.
- Branch managers can only move their own branch's orders along valid transitions.
- Central administrators may force a correction when an order is stuck.
- Every status change is recorded in `order_status_history` with the actor, note and timestamp.

## Delivery workflow

1. HQ creates a driver under **Staff accounts** in `/admin.html`. Choose role **Driver** and the driver's branch. Drivers can only receive orders from that branch.
2. Open a delivery order and choose the driver under **Assign a driver**. Optionally set the next delivery ready date and next delivery date at the same time.
3. The driver signs in at `/driver.html`, sees only their assigned deliveries, and marks **picked up** when leaving the branch. A `ready` order then moves to `out_for_delivery`.
4. When the driver reaches the customer, they mark **arrived**. The server emails the customer a tokenised link to `/confirm.html?token=...`.
5. The customer opens the link, checks the order and either confirms delivery or reports a problem (wrong delivery, breakage, missing item, late or other).
6. A confirmation marks the order `completed` and emails the customer a receipt with the next-delivery dates. A problem report creates an urgent message in the HQ inbox, notifies the branch and emails the customer an acknowledgement.
7. HQ can record a phone confirmation, resend the confirmation link, resolve an open issue, and update next-delivery dates from the order or delivery detail. Every email is visible in the **Email outbox** on the Deliveries tab.

Delivery statuses:

```text
assigned -> picked_up -> arrived -> delivered
                    \-> issue (customer report; HQ resolves back to arrived)
assigned/picked_up -> cancelled
```

Only the customer (or HQ recording a phone confirmation) can mark a delivery `delivered`. Drivers cannot confirm on the customer's behalf.

### Email configuration

Set these in `.env` to send real email:

```text
PUBLIC_BASE_URL=https://orders.example.co.ke
HQ_EMAIL=orders@example.co.ke
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=TasteHub Kenya <orders@example.co.ke>
```

When `SMTP_HOST` is blank, every message is still written to `email_outbox` with status `logged`, so the flow can be tested without an email provider. A failed send is recorded with status `failed` and the error message. The confirmation link always uses `PUBLIC_BASE_URL`, so set it to the public site address in production.

## Branch manager dashboard

Open `/branch.html` and sign in with a `branch_manager` account. Create accounts in the HQ dashboard under **Staff**; assign each manager to a branch. A branch manager sees only their own branch's orders, messages and notifications.

The dashboard provides:

- Branch header with address, phone, delivery fee, free-delivery threshold, minimum order and whether the branch is accepting orders.
- Counters for new, in-progress, ready, out-for-delivery, completed-today and active orders.
- Filterable order list with a one-step status update, plus a detail dialog showing items, totals, status history and notes.
- A messages tab for branch-to-HQ messages and an unread notifications tab.

Central administrators can open `/branch.html` too; when their account has a branch assigned, the dashboard is scoped to that branch. HQ-wide work stays in `/admin.html`.

## Tests

```bash
npm test
```

The test suite does not need MySQL. It covers server-side item normalisation and pricing, promotion and delivery calculations, order and delivery status transitions, token and issue validation, and input validation.

## Deployment (Railway)

The production site runs at **https://tastehub-kenya-production.up.railway.app**.

- **Build:** the `Dockerfile` builds a `node:20-alpine` image; Railway detects it automatically from the repository root.
- **Health check:** `/api/health` is configured in `railway.json`.
- **Database:** a Railway MySQL service. The app service uses `DATABASE_*` reference variables pointing at the MySQL service (`${{MySQL.MYSQLHOST}}`, and so on). `server/config.js` also accepts Railway's native `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD` and `MYSQLDATABASE` when the `DATABASE_*` values are absent.
- **Public URL:** `PUBLIC_BASE_URL` is set explicitly. If it is blank, the server falls back to `https://$RAILWAY_PUBLIC_DOMAIN` so confirmation links are correct.
- **Email:** SMTP is not configured in production, so every message is recorded in `email_outbox` with status `logged`.

Deploy or update:

```bash
railway login
railway link
railway up --ci                                          # build and deploy
railway ssh --service tastehub-kenya "npm run db:seed"   # first install and schema changes
railway redeploy --yes                                   # apply environment-variable changes
```

Set these variables on the app service (`railway variable set KEY=value`):

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `JWT_SECRET` | 32+ random characters |
| `ADMIN_EMAIL` | administrator sign-in email |
| `ADMIN_PASSWORD` | strong one-time seed password |
| `TRUST_PROXY` | `1` |
| `ALLOW_BOOTSTRAP` | `false` |
| `PUBLIC_BASE_URL` | the public HTTPS URL |
| `DATABASE_*` or `MYSQL*` | database connection details |

Keep `.env` out of the repository; set secrets in the Railway dashboard. Re-running `npm run db:seed` re-applies `sql/schema.sql` and resets the seeded administrator's password to `ADMIN_PASSWORD`.

## Before public launch

- Replace every sample price in `branch_meals` with approved branch prices. The seeded menu is illustrative only.
- Confirm the real branch list, phone numbers, addresses, delivery fees, free-delivery thresholds, minimum orders and acceptance hours.
- Add payment integration (M-Pesa Daraja or a card provider) with callback verification and reconciliation. Never store card numbers or CVVs.
- Create a real branch manager and driver account for every live branch and remove the sample accounts.
- Configure `SMTP_*` and `PUBLIC_BASE_URL` so delivery confirmation links and next-delivery emails reach real customers. Keep `email_outbox` monitored for failed sends.
- Confirm the application server and MySQL share a timezone so order timestamps and daily counters agree.
- Move inline scripts and data-URI images into separate assets and enable a strict Content Security Policy.
- Use HTTPS, a production secrets manager, short-lived JWTs or secure cookies, and a persistent rate-limit store behind a proxy.
- Replace the in-memory rate limiter if you run more than one server process.
- Add SMS notifications, stock control, promotions administration, reports, backups and monitoring.
- Remove or keep the development bootstrap endpoint disabled (`ALLOW_BOOTSTRAP=false`) in production, and restrict `CLIENT_ORIGIN` if the front end is hosted separately.
- Review the privacy notice, customer data retention and access controls before taking live orders.

## Project layout

```text
public/index.html              Customer ordering page
public/admin.html              Central HQ dashboard
public/branch.html             Branch manager dashboard
public/driver.html             Driver delivery portal
public/confirm.html            Public customer delivery confirmation and issue report
server/index.js                HTTP server and graceful shutdown
server/app.js                  Routes, auth, validation and order workflow
server/config.js               Environment configuration
server/db.js                   MySQL pool
server/seed.js                 Schema + sample catalogue + admin seed
server/lib/pricing.js          Server-side pricing, promo and delivery rules
server/lib/orders.js           Order statuses, transitions and notifications
server/lib/deliveries.js       Delivery statuses, transitions, issue types and tokens
server/lib/email.js            SMTP transport, customer templates and email outbox
server/lib/validation.js       Phone, email, string and number validation
server/lib/auth.js             JWT helpers and role guards
server/lib/rate-limit.js       In-memory rate limiter
server/lib/catalogue.js        Sample branches, menu and promotion
sql/schema.sql                 Fresh-install schema
sql/migrations/                Upgrade path for existing databases
test/                          Node test runner suites
```
