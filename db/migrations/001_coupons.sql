-- Coupon codes for order creation (POST /orders `couponCode`).
CREATE TABLE IF NOT EXISTS coupons (
  code        TEXT PRIMARY KEY,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  expires_at  TIMESTAMPTZ,
  max_uses    INTEGER CHECK (max_uses IS NULL OR max_uses >= 0),
  uses        INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  CHECK (max_uses IS NULL OR uses <= max_uses)
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS coupon_code TEXT REFERENCES coupons (code),
  ADD COLUMN IF NOT EXISTS discount    INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0);
