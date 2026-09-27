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

## Coupons

`POST /orders` accepts an optional `couponCode`. The coupon's `percent_off`
is applied to `total` (integer cents, rounded half up); the order stores
`coupon_code` and `discount`. Unknown, expired, or exhausted coupons are
rejected with `422`. Schema: `db/migrations/001_coupons.sql`.

## Deployment

Built with `npm run build`, deployed as a container behind the storefront ALB.
