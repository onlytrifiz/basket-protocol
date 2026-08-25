import "server-only";

import { neon } from "@neondatabase/serverless";

import { denominationLabel } from "./money";

/**
 * Order ledger.
 *
 * CryptoRefills remains the system of record — this is our own copy, kept so we
 * can answer "what did we sell, to whom, for how much" without logging into the
 * supplier. Nothing here is on the critical path: if the database is missing or
 * down, orders still go through and the shop keeps working.
 */

let client: ReturnType<typeof neon> | null = null;
let ready: Promise<void> | null = null;

/** Null when no database is configured, which is a supported state. */
function db() {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  // Lazily created: a top-level neon() would throw during `next build` before
  // the environment is provisioned.
  client = neon(url);
  return client;
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Which storefront wrote a row.
 *
 * This database is shared with the other shops that fulfil through the same
 * supplier, and both create the same `orders` table, so without this every
 * report mixes two businesses into one number.
 *
 * Rows written before the column existed stay null — that is not a gap to be
 * guessed at, it simply means "not this shop", and the admin page says so.
 */
export const ORDER_SOURCE = "stockify";

/**
 * Creates the table on first use. Cheap enough to run per cold start and
 * avoids a separate migration step for a single-table ledger.
 */
async function ensureSchema() {
  const sql = db();
  if (!sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      order_id       text PRIMARY KEY,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      status         text        NOT NULL,
      payment_status text,
      brand          text        NOT NULL,
      family         text,
      denomination   text,
      face_value     numeric,
      currency       text,
      country_code   text,
      coin           text,
      coin_amount    numeric,
      network        text,
      wallet_address text,
      email          text,
      phone          text,
      delivered_at   timestamptz,
      source         text,
      payer_address  text
    )
  `;
  // The table usually already exists — created by the other shop, without this
  // column — so adding it is a separate statement rather than part of the
  // CREATE above, which would be skipped.
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source text`;
  /**
   * Who paid, in their own words.
   *
   * The supplier will only take a refund address when the order is created, and
   * by then most buyers have not connected a wallet yet — so when an order has
   * to be unwound by hand, this column is the only record of where the money
   * should go back to. It is not the sender of the funds: those arrive from a
   * bridge relayer, and refunding that address would pay a stranger.
   */
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_address text`;
  await sql`CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS orders_email_idx ON orders (email)`;
  await sql`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`;
  await sql`CREATE INDEX IF NOT EXISTS orders_source_idx ON orders (source)`;
}

function schemaReady() {
  if (!ready) {
    ready = ensureSchema().catch((err) => {
      // Reset so a transient failure can be retried on the next call.
      ready = null;
      throw err;
    });
  }
  return ready;
}

export type OrderRecord = {
  orderId: string;
  status: string;
  paymentStatus?: string | null;
  brand: string;
  family?: string | null;
  denomination?: string | null;
  faceValue?: number | null;
  currency?: string | null;
  countryCode?: string | null;
  coin?: string | null;
  coinAmount?: string | null;
  network?: string | null;
  walletAddress?: string | null;
  email?: string | null;
  phone?: string | null;
  payerAddress?: string | null;
};

/**
 * Records a newly created order.
 *
 * Deliberately does NOT store the redeem code, PIN serial or security code.
 * Those are bearer instruments — a leak of this table would be a leak of
 * spendable value, and the supplier already stores and emails them.
 */
export async function recordOrder(order: OrderRecord): Promise<void> {
  const sql = db();
  if (!sql) return;
  await schemaReady();
  await sql`
    INSERT INTO orders (
      order_id, status, payment_status, brand, family, denomination,
      face_value, currency, country_code, coin, coin_amount, network,
      wallet_address, email, phone, source, payer_address
    ) VALUES (
      ${order.orderId}, ${order.status}, ${order.paymentStatus ?? null},
      ${order.brand}, ${order.family ?? null}, ${order.denomination ?? null},
      ${order.faceValue ?? null}, ${order.currency ?? null},
      ${order.countryCode ?? null}, ${order.coin ?? null},
      ${order.coinAmount ?? null}, ${order.network ?? null},
      ${order.walletAddress ?? null}, ${order.email ?? null},
      ${order.phone ?? null}, ${ORDER_SOURCE}, ${order.payerAddress ?? null}
    )
    ON CONFLICT (order_id) DO NOTHING
  `;
}

/**
 * Leading money amount in a denomination: "5 EUR", "44.99 EUR", and also
 * "5 EUR - PIN", which carries a suffix. Anchored to the start so entitlements
 * like "10 GB 30 days" or "1 month" do not match.
 */
const MONEY_DENOMINATION = /^([\d.,]+)\s*([A-Z]{3})\b/;

/**
 * Records or refreshes an order straight from a supplier payload.
 *
 * Makes the ledger self-healing: an order placed before the database existed,
 * or while a write was failing, gets picked up the first time its page is
 * viewed rather than being missing for good.
 */
export async function upsertFromSupplier(
  order: Record<string, unknown>,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await schemaReady();

  const orderId = String(order.order_id ?? order.id ?? "");
  if (!orderId) return;

  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
  const first = (deliveries[0] ?? {}) as Record<string, unknown>;
  const item = (first.deliverable ?? {}) as Record<string, unknown>;

  /**
   * A range-priced order carries its value in `product_value` and the literal
   * string "range" in both denomination fields, so the regex below finds
   * nothing and the row would land with no face value and "range" where the
   * amount should be. See `denominationLabel`.
   */
  const raw = item.denomination ? String(item.denomination) : null;
  const money = raw?.match(MONEY_DENOMINATION);
  const ranged = Number(item.product_value);
  const faceValue =
    Number.isFinite(ranged) && ranged > 0
      ? ranged
      : money
        ? Number(money[1].replace(",", "."))
        : null;
  const denomination = denominationLabel(item as Parameters<typeof denominationLabel>[0]) ?? raw;

  const beneficiary = item.beneficiary_account
    ? String(item.beneficiary_account)
    : null;
  const byPhone = item.delivery_type === "by_phone";
  const accountEmail = (order.user as Record<string, unknown> | undefined)?.email;

  const status = String(order.order_state ?? "Unknown");
  const delivered = ["done", "completed", "delivered", "succeeded"].includes(
    status.toLowerCase().replace(/[^a-z]/g, ""),
  );

  await sql`
    INSERT INTO orders (
      order_id, status, payment_status, brand, family, denomination,
      face_value, currency, country_code, coin, coin_amount, network,
      wallet_address, email, phone, delivered_at, source
    ) VALUES (
      ${orderId},
      ${status},
      ${order.payment_state ? String(order.payment_state) : null},
      ${String(item.brand_name ?? item.family ?? "Unknown")},
      ${item.family ? String(item.family) : null},
      ${denomination},
      ${faceValue},
      ${item.currency_code ? String(item.currency_code) : (money?.[2] ?? null)},
      ${item.country_code ? String(item.country_code) : null},
      ${order.coin ? String(order.coin) : null},
      ${order.coin_amount ? String(order.coin_amount) : null},
      ${order.network ? String(order.network) : null},
      ${order.wallet_address ? String(order.wallet_address) : null},
      ${byPhone ? (accountEmail ? String(accountEmail) : null) : beneficiary},
      ${byPhone ? beneficiary : null},
      ${delivered ? new Date().toISOString() : null},
      ${ORDER_SOURCE}
    )
    -- source is deliberately absent below: this runs on every poll of the
    -- tracker, and an order from the other shop opened here must keep its own
    -- provenance rather than be relabelled by whoever looked at it last.
    ON CONFLICT (order_id) DO UPDATE SET
      status         = EXCLUDED.status,
      payment_status = COALESCE(EXCLUDED.payment_status, orders.payment_status),
      coin_amount    = COALESCE(EXCLUDED.coin_amount, orders.coin_amount),
      wallet_address = COALESCE(EXCLUDED.wallet_address, orders.wallet_address),
      -- Backfill gaps left by an earlier, less complete parse.
      face_value     = COALESCE(orders.face_value, EXCLUDED.face_value),
      currency       = COALESCE(orders.currency, EXCLUDED.currency),
      country_code   = COALESCE(orders.country_code, EXCLUDED.country_code),
      network        = COALESCE(orders.network, EXCLUDED.network),
      updated_at     = now(),
      -- First time we see it delivered wins; never re-stamp on later polls.
      delivered_at   = COALESCE(orders.delivered_at, EXCLUDED.delivered_at)
  `;
}

/**
 * Remembers who paid, once a wallet finally appears.
 *
 * Most buyers connect one screen after the order is created, which is one
 * screen too late for the supplier — their refund field is write-once, at
 * creation. This is the fallback, and in practice the usual case: the address
 * is recorded here the moment a payment is signed, so a quarantined or failed
 * order can be unwound without asking the customer where to send their money.
 *
 * First write wins. A second attempt from a different wallet must not overwrite
 * the one that actually paid.
 */
export async function recordPayer(orderId: string, address: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  await schemaReady();
  await sql`
    UPDATE orders
       SET payer_address = ${address}, updated_at = now()
     WHERE order_id = ${orderId} AND payer_address IS NULL
  `;
}

/** Keeps the ledger in step with the supplier as an order progresses. */
export async function updateOrderStatus(
  orderId: string,
  status: string,
  paymentStatus?: string | null,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await schemaReady();
  const delivered = ["done", "completed", "delivered", "succeeded"].includes(
    status.toLowerCase().replace(/[^a-z]/g, ""),
  );
  await sql`
    UPDATE orders
       SET status         = ${status},
           payment_status = COALESCE(${paymentStatus ?? null}, payment_status),
           updated_at     = now(),
           delivered_at   = CASE
                              WHEN ${delivered} AND delivered_at IS NULL THEN now()
                              ELSE delivered_at
                            END
     WHERE order_id = ${orderId}
       AND (status IS DISTINCT FROM ${status}
            OR payment_status IS DISTINCT FROM ${paymentStatus ?? null})
  `;
}

export type StoredOrder = {
  order_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  payment_status: string | null;
  brand: string;
  denomination: string | null;
  face_value: string | null;
  currency: string | null;
  country_code: string | null;
  coin: string | null;
  coin_amount: string | null;
  email: string | null;
  phone: string | null;
  delivered_at: string | null;
  /** Which storefront placed it. Null on rows written before the column. */
  source: string | null;
  /** The buyer's own wallet, where a refund would have to go. */
  payer_address: string | null;
};

/**
 * The ledger, this shop's rows by default.
 *
 * `everySource` widens it to the whole table — useful because the database is
 * shared, and useless as a default: a page that silently counted another
 * business's sales as ours would be worse than no page.
 */
export async function listOrders(limit = 100, everySource = false): Promise<StoredOrder[]> {
  const sql = db();
  if (!sql) return [];
  await schemaReady();
  // Null widens to every row. Written as a nullable parameter with an explicit
  // cast rather than a boolean one, because a bare JS boolean reaches Postgres
  // untyped and "argument of OR must be boolean" is a runtime error, not a
  // compile-time one.
  const scope = everySource ? null : ORDER_SOURCE;
  const rows = await sql`
    SELECT order_id, created_at, updated_at, status, payment_status, brand,
           denomination, face_value, currency, country_code, coin, coin_amount,
           email, phone, delivered_at, source, payer_address
      FROM orders
     WHERE (${scope}::text IS NULL OR source = ${scope}::text)
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows as StoredOrder[];
}

export type OrderStats = {
  total: number;
  delivered: number;
  pending: number;
  revenueByCurrency: { currency: string; total: string }[];
  /**
   * What buyers actually handed over, in dollars.
   *
   * Every order settles in USDC, so summing `coin_amount` is the spend — no
   * exchange rate to apply and none to get wrong. Restricted to that coin
   * because a stray order in something else would silently add its own units
   * to a dollar figure.
   */
  spentUsd: number;
  /** First delivered order, so the page can say how long this has run. */
  firstDeliveredAt: string | null;
  /** Median seconds from order placed to code delivered, measured not claimed. */
  typicalSeconds: number | null;
  /** How far the catalogue has actually reached, not how far it could. */
  countriesServed: number;
};

/** Scoped to this shop unless `everySource`, for the same reason as the list. */
export async function orderStats(everySource = false): Promise<OrderStats | null> {
  const sql = db();
  if (!sql) return null;
  await schemaReady();

  // Same nullable-parameter trick as listOrders: null means every source.
  const scope = everySource ? null : ORDER_SOURCE;

  const [counts] = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered
      FROM orders
     WHERE (${scope}::text IS NULL OR source = ${scope}::text)
  `) as { total: number; delivered: number }[];

  const revenue = (await sql`
    SELECT COALESCE(currency, '?') AS currency,
           SUM(face_value)::text   AS total
      FROM orders
     WHERE delivered_at IS NOT NULL AND face_value IS NOT NULL
       AND (${scope}::text IS NULL OR source = ${scope}::text)
     GROUP BY 1
     ORDER BY 1
  `) as { currency: string; total: string }[];

  const [spend] = (await sql`
    SELECT COALESCE(SUM(coin_amount), 0)::float8 AS spent,
           MIN(delivered_at)                     AS first_delivered
      FROM orders
     WHERE delivered_at IS NOT NULL AND coin = 'USDC'
       AND (${scope}::text IS NULL OR source = ${scope}::text)
  `) as { spent: number; first_delivered: string | null }[];

  /**
   * Delivery speed, measured rather than claimed. The shop tells people codes
   * arrive in minutes; this is where that sentence is checked.
   */
  const [speed] = (await sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (delivered_at - created_at))
           )::float8 AS typical
      FROM orders
     WHERE delivered_at IS NOT NULL AND delivered_at >= created_at
       AND (${scope}::text IS NULL OR source = ${scope}::text)
  `) as { typical: number | null }[];

  const [reach] = (await sql`
    SELECT count(DISTINCT country_code)::int AS countries
      FROM orders
     WHERE delivered_at IS NOT NULL AND country_code IS NOT NULL
       AND (${scope}::text IS NULL OR source = ${scope}::text)
  `) as { countries: number }[];

  return {
    total: counts?.total ?? 0,
    delivered: counts?.delivered ?? 0,
    pending: (counts?.total ?? 0) - (counts?.delivered ?? 0),
    revenueByCurrency: revenue,
    spentUsd: Number(spend?.spent ?? 0),
    firstDeliveredAt: spend?.first_delivered ?? null,
    typicalSeconds: speed?.typical ?? null,
    countriesServed: reach?.countries ?? 0,
  };
}
