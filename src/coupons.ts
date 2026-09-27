import { sql, TransactionClient } from "./db";

/**
 * Raised when a coupon cannot be redeemed. The message is safe to return to
 * the client verbatim; routes map this to a 422.
 */
export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouponError";
  }
}

interface CouponRow {
  code: string;
  percent_off: number;
  expires_at: Date | string | null;
  max_uses: number | null;
  uses: number;
}

/**
 * Discount in integer cents for `percentOff` percent of `totalCents`,
 * rounded half up. Pure integer arithmetic so there is no float drift:
 * floor((total * pct + 50) / 100).
 */
export function computeDiscount(totalCents: number, percentOff: number): number {
  return Math.floor((totalCents * percentOff + 50) / 100);
}

/**
 * Redeem `code` inside the caller's transaction and return its percent_off.
 *
 * The use counter is incremented by a single conditional UPDATE whose WHERE
 * clause re-checks expiry and remaining uses. Postgres takes a row lock for
 * the UPDATE and re-evaluates the predicate against the latest committed row
 * when concurrent redemptions contend, so `uses` can never exceed `max_uses`.
 * Because it runs in the caller's transaction, a failure to create the order
 * rolls the increment back as well.
 *
 * If no row was updated, the coupon is looked up again only to produce a
 * specific rejection reason.
 */
export async function redeemCoupon(
  client: TransactionClient,
  code: string
): Promise<number> {
  const redeemed = await client.query<Pick<CouponRow, "percent_off">>(
    sql`UPDATE coupons SET uses = uses + 1
     WHERE code = ${code}
       AND (expires_at IS NULL OR expires_at > now())
       AND (max_uses IS NULL OR uses < max_uses)
     RETURNING percent_off`
  );
  if (redeemed[0]) {
    return Number(redeemed[0].percent_off);
  }

  const rows = await client.query<CouponRow & { expired: boolean }>(
    sql`SELECT code, percent_off, expires_at, max_uses, uses,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired
     FROM coupons WHERE code = ${code}`
  );
  const coupon = rows[0];
  if (!coupon) {
    throw new CouponError("coupon code not found");
  }
  if (coupon.expired) {
    throw new CouponError("coupon has expired");
  }
  if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses) {
    throw new CouponError("coupon has reached its maximum number of uses");
  }
  // Row became redeemable between the two statements (e.g. max_uses raised);
  // treat conservatively rather than retrying.
  throw new CouponError("coupon could not be applied");
}
