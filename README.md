# checkout-service

Checkout and payments API for the Hyrax Labs storefront. Handles order creation,
payment capture against the upstream processor, and a small set of internal
admin endpoints.

## Stack

- Node + Express (TypeScript)
- PostgreSQL via `pg`
- JWT session tokens

## Local development

```bash
npm install
cp .env.example .env   # fill in DB + secrets
npm run dev
```

The service listens on `:3000` by default.

## Endpoints

| Method | Path                        | Description                          |
| ------ | --------------------------- | ------------------------------------ |
| GET    | `/health`                   | Liveness check                       |
| GET    | `/orders/:id`               | Fetch a single order                 |
| GET    | `/orders`                   | List the caller's orders             |
| POST   | `/orders`                   | Create an order                      |
| POST   | `/payments/charge`          | Capture payment for an order         |
| POST   | `/payments/capture-batch`   | Capture several orders at once       |
| POST   | `/refunds`                  | Refund a paid order (full or partial)|
| POST   | `/webhooks/processor`       | Processor status callbacks (signed)  |
| POST   | `/admin/orders/purge`       | Remove cancelled orders (internal)   |
| POST   | `/admin/credits`            | Issue a manual account credit        |
| GET    | `/admin/webhook-events`     | Webhook delivery log (admin)         |

## Processor webhooks

`POST /webhooks/processor` accepts signed callbacks from the payment processor.
The shared secret is read from the `WEBHOOK_SECRET` environment variable
(required at boot).

Required headers:

- `x-webhook-signature`: lowercase hex HMAC-SHA256 of the exact raw request
  body, keyed with `WEBHOOK_SECRET`. An optional `sha256=` prefix is accepted.
- `x-webhook-timestamp`: unix epoch seconds. It must be within 5 minutes
  (300s) of the server clock, in either direction.

The checks run in this order:

| Status | When                                                                 |
| ------ | -------------------------------------------------------------------- |
| 401    | Signature missing or invalid (checked before anything else)          |
| 400    | Timestamp missing, non-numeric or outside the 5-minute window; malformed body or missing event `id` |
| 200    | `{ "received": true, "duplicate": true }`: event `id` was already processed, so nothing is re-applied |
| 409    | `charge.succeeded` for an order that is not `pending`; the order is left unchanged |
| 200    | `{ "received": true }`: event handled and its `id` recorded          |

An event id is recorded only after it is handled successfully, so a delivery
that got a 409 or failed can be retried. Processed ids are held in memory right
now (`src/processedEvents.ts`). They are lost on restart and not shared between
instances.

### Webhook event log

`GET /admin/webhook-events` (admin role required) lists webhook deliveries,
newest first. Every delivery is recorded, rejected attempts included. Each
entry has `event_id`, `type`, `order_id`, `outcome` (`processed`, `duplicate`
or `rejected`), `reason`, `status` (the HTTP status returned) and `received_at`
(ISO-8601). Event fields are only logged for correctly signed requests, so
they are `null` for a delivery with a bad signature.

Query parameters: `limit` (1 to 200, default 50) and `offset` (default 0). The
response is `{ events, total, limit, offset }`. The log is held in memory
(`src/webhookEventLog.ts`) and keeps the most recent 1000 entries.

## Deployment

Built with `npm run build`, deployed as a container behind the storefront ALB.
