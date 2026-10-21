# Backend and Telegram bot API contract

## Account access

`POST /api/login` accepts `{ "login": "...", "password": "..." }`. The backend looks up `users.site_login`, verifies the password only against the bcrypt `users.site_password_hash`, and issues a token only when `is_paid = true` and `expires_at` is a future UTC instant. Missing expiry is inactive. Trial accounts use the same login path; the bot must store their `expires_at` at `now + 3 days`.

## Bot report and pricing

`GET /api/bot/report?login=<login>&period=monthly` returns a numeric UZS `net_profit`, for example:

```json
{ "net_profit": 1000000 }
```

The report endpoint returns a non-2xx response and logs database/report errors rather than representing an unavailable report as zero. `GET /api/bot/profits/{login}` likewise returns a numeric `monthlyProfit` for the legacy fallback.

The backend exposes a source-of-truth quote endpoint:

```http
GET /api/bot/pricing?login=<login>
Authorization: Bearer <BOT_API_TOKEN>
```

Example response:

```json
{
  "pricing_model": "fixed_subscription",
  "currency": "UZS",
  "tariff_price": 299000,
  "expected_amount": 299000,
  "max_products": 1000,
  "max_groups": 1,
  "current_products": 450,
  "distinct_product_id_count": 450,
  "is_paid": true,
  "expires_at": "2026-11-20T18:00:00Z"
}
```

The legacy "15% of net profit" and "per 100 products" fee models are deprecated and replaced by fixed monthly subscriptions. The bot uses `tariff_price` (`expected_amount`) for subscription renewal.

## Product limits

The backend enforces user limits based on `users.max_products`:
- When adding a product (`POST /api/products`), the system checks `COUNT(*) >= max_products`. If reached, it returns HTTP 403 Forbidden with `{ "error": "PRODUCT_LIMIT_REACHED", ... }`.
- In bulk imports (`POST /api/products/import` / `POST /api/products/bulk`), if `current_count + incoming_count > max_products`, the request is rejected with 403.
- User profile endpoint `GET /api/user/me` (and `GET /api/profile`, `GET /api/me`) returns `subscription` containing `max_products`, `current_products`, `remaining_products`, `max_groups`, `tariff_price`.

## Payment approval / renewal

After the admin has verified a payment request and its exact `expected_amount`, the bot can sync the existing account to the backend:

```http
POST /api/bot/account/activate
Authorization: Bearer <BOT_API_TOKEN>
Content-Type: application/json
```

```json
{
  "login": "existing-site-login",
  "expires_at": "2026-11-13T12:00:00Z",
  "payment_method": "transfer",
  "expected_amount": 299000,
  "paid_amount": 299000,
  "max_products": 1000,
  "max_groups": 1,
  "tariff_price": 299000
}
```

The backend rejects unequal/non-integer amounts and non-timezoned or expired dates. It updates the existing login's `is_paid`, `expires_at`, `payment_method`, and sets `max_products`, `max_groups`, `tariff_price` when provided, resets expiry reminders, and never generates or replaces the login or password hash. A trial can be synced with `payment_method: "trial"` and equal zero amounts, using an expiry exactly three days after trial creation.

## Expired-account deletion

After the bot has sent its three final warnings, it must call the backend as well as deleting data from its own database:

```http
POST /api/bot/account/delete
Authorization: Bearer <BOT_API_TOKEN>
Content-Type: application/json
```

```json
{ "login": "existing-site-login" }
```

The backend transaction removes rows with the account's `user_id` from public user-owned tables, deletes login-linked notifications/payment requests when present, then deletes the user. Repeating the call succeeds. The endpoint does not make the bot's separate database part of this transaction; the bot must finish its own cleanup independently.

## Timestamps

The backend DB connection timezone is UTC. Existing PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` values are treated as UTC instants when parsed; frontend displays use the device's local timezone. The frontend sends its IANA zone in `X-Time-Zone`; return and expense Telegram timestamps use that zone when provided. New return events store a timezone-aware `sales.returned_at`, returned by `POST /api/sales/:saleId/return` and `GET /api/sales`.

## Authentication and deployment

Set a long random `BOT_API_TOKEN` in both the backend environment and the bot's HTTP client configuration before calling the new pricing, activation, or deletion endpoints. Missing backend configuration returns `503`; invalid credentials return `401`. Existing `/api/bot/*` read endpoints predate this token and currently rely only on rate limiting, so adding the header to them is a separate bot integration/security migration. No website/APK URL should be added to Telegram notification text or buttons.

The account-contract migration runs during backend table initialization. It can also be applied explicitly with `npm run migrate` from `backend/`.
