import "server-only";

import { cleanHtml } from "./sanitize";
import { formatMoney } from "./money";
import type {
  BrandCard,
  BrandFamily,
  CategoryGroup,
  OrderDelivery,
  PaymentVia,
  Product,
  PurchaseOption,
  Quote,
} from "./types";

const BASE =
  process.env.CRYPTOREFILLS_API_BASE ?? "https://api.cryptorefills.com";
const PARTNER_ID = process.env.CRYPTOREFILLS_PARTNER_ID ?? "";
const APP_VERSION = process.env.CRYPTOREFILLS_APP_VERSION ?? "1.0.0";

/**
 * The supplier does not enforce the partner header — catalogue and order calls
 * succeed without it. That makes a missing Partner ID silent and expensive:
 * every sale would complete and earn no commission, with nothing in the logs
 * to show for it. Browsing is unaffected, but selling is refused.
 */
export function hasPartnerId() {
  return PARTNER_ID.length > 0;
}

export class SupplierError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SupplierError";
  }
}

type CallOptions = {
  /** Forwarded so the supplier sees the buyer, not our server. */
  endUserIp?: string;
  endUserAgent?: string;
  /** Seconds. Omit to opt out of caching entirely. */
  revalidate?: number;
};

function headers(opts: CallOptions = {}): HeadersInit {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Cr-Application": PARTNER_ID,
    "X-Cr-Version": APP_VERSION,
  };
  // Attribution only lands correctly when the end user's context is forwarded.
  if (opts.endUserIp) h["X-Forwarded-For"] = opts.endUserIp;
  if (opts.endUserAgent) h["User-Agent"] = opts.endUserAgent;
  return h;
}

async function call<T>(
  path: string,
  init: RequestInit & CallOptions = {},
): Promise<T> {
  const { endUserIp, endUserAgent, revalidate, ...rest } = init;
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: { ...headers({ endUserIp, endUserAgent }), ...(rest.headers ?? {}) },
    next: revalidate === undefined ? undefined : { revalidate },
    cache: revalidate === undefined ? "no-store" : undefined,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    throw new SupplierError(
      `Supplier responded ${res.status} for ${path}`,
      res.status,
      parsed,
    );
  }
  return parsed as T;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The supplier keys products by `family_name`, which is the display name.
 * We slug names for our URLs, so we keep a per-country reverse index.
 */
const familyIndex = new Map<string, Map<string, string>>();

function rememberFamily(country: string, name: string) {
  let byCountry = familyIndex.get(country);
  if (!byCountry) {
    byCountry = new Map();
    familyIndex.set(country, byCountry);
  }
  byCountry.set(slugify(name), name);
}

export function resolveFamilyName(
  country: string,
  slug: string,
): string | undefined {
  return familyIndex.get(country)?.get(slug);
}

/** Raw brand entry as the supplier returns it in /v2/brands. */
type RawBrand = {
  family?: string;
  brand?: string;
  brand_id?: string;
  logo_url?: string;
  bg_color?: string;
  min?: string | null;
  max?: string | null;
  category?: string;
  additional_categories?: string[];
  kind?: string;
  product_type?: string;
  is_out_of_stock?: boolean;
  country_code?: string;
};

function toBrandCard(b: RawBrand, countryCode: string): BrandCard | null {
  const family = b.family ?? b.brand;
  if (!family) return null;
  const name = b.brand ?? family;
  return {
    // Slug from the brand, not the family: families are not unique.
    slug: slugify(name),
    name,
    family,
    brandId: b.brand_id,
    logo: b.logo_url ?? "",
    bgColor: b.bg_color,
    kind: b.kind ?? "giftcard",
    category: b.category ?? "other_products",
    additionalCategories: b.additional_categories ?? [],
    countryCode: b.country_code ?? countryCode,
    outOfStock: Boolean(b.is_out_of_stock),
    minLabel: b.min ?? undefined,
    maxLabel: b.max ?? undefined,
    productType: b.product_type,
  };
}

/** Raw homepage payload — used for merchandising rows. */
export async function getHomepage(countryCode: string) {
  return call<Record<string, unknown>>(
    `/v2/homepage?country_code=${encodeURIComponent(countryCode)}`,
    { revalidate: 600 },
  );
}

type BrandsResponse = {
  country_code: string;
  categories?: { kind: string; category?: string; brands?: RawBrand[] }[];
  all_brands?: RawBrand[];
};

export type Catalog = {
  countryCode: string;
  all: BrandCard[];
  categories: CategoryGroup[];
  /** Category key -> brands, preserving the supplier's own ordering. */
  byCategory: Record<string, BrandCard[]>;
};

/**
 * Brand list for a country. Light payload (names, logos, range labels) — full
 * pricing is fetched per brand on the product page.
 */
export async function getCatalog(countryCode: string): Promise<Catalog> {
  const data = await call<BrandsResponse>(
    `/v2/brands?country_code=${encodeURIComponent(countryCode)}`,
    { revalidate: 600 },
  );

  const byCategory: Record<string, BrandCard[]> = {};
  const categories: CategoryGroup[] = [];

  // A handful of distinct products share a brand name ("Instacart" vs
  // "Instacart+" collapse to the same slug). Keep URLs unique and stable by
  // suffixing with the brand id rather than dropping one of them.
  const slugOwner = new Map<string, string>();
  const finalise = (card: BrandCard): BrandCard => {
    const owner = slugOwner.get(card.slug);
    if (owner === undefined) {
      slugOwner.set(card.slug, card.brandId ?? card.slug);
      return card;
    }
    if (owner === (card.brandId ?? card.slug)) return card;
    return { ...card, slug: `${card.slug}-${(card.brandId ?? "x").slice(0, 4)}` };
  };

  for (const cat of data.categories ?? []) {
    const key = cat.category ?? cat.kind;
    const brands = (cat.brands ?? [])
      .map((b) => toBrandCard(b, countryCode))
      .filter((b): b is BrandCard => b !== null)
      .map(finalise);
    if (!brands.length) continue;
    byCategory[key] = brands;
    categories.push({ kind: cat.kind, category: key, count: brands.length });
  }

  // `all_brands` is the authoritative de-duplicated list; categories repeat
  // brands that belong to more than one section.
  const seen = new Set<string>();
  const all: BrandCard[] = [];
  const source = data.all_brands?.length
    ? data.all_brands
    : Object.values(byCategory).flat().map((c) => ({
        family: c.family,
        brand: c.name,
        logo_url: c.logo,
        bg_color: c.bgColor,
        category: c.category,
        kind: c.kind,
        is_out_of_stock: c.outOfStock,
      }));

  for (const raw of source) {
    const base = toBrandCard(raw as RawBrand, countryCode);
    if (!base) continue;
    const card = finalise(base);
    if (seen.has(card.slug)) continue;
    seen.add(card.slug);
    rememberFamily(countryCode, card.family);
    all.push(card);
  }

  // Index category members too, so deep links resolve on a cold server.
  for (const list of Object.values(byCategory)) {
    for (const c of list) rememberFamily(countryCode, c.family);
  }

  categories.sort((a, b) => b.count - a.count);
  return { countryCode, all, categories, byCategory };
}

/** Full product detail (denominations, ranges) for one brand family. */
export async function getProductsByFamily(
  countryCode: string,
  familyName: string,
  coin = "USDC",
  lang = "en",
): Promise<BrandFamily[]> {
  const qs = new URLSearchParams({ family_name: familyName, coin, lang });
  const families = await call<BrandFamily[]>(
    `/v5/products/country/${encodeURIComponent(countryCode)}?${qs}`,
    { revalidate: 300 },
  );
  for (const f of families ?? []) {
    rememberFamily(countryCode, f.family ?? f.brand);
  }
  return families ?? [];
}

export { toBrandCard };

/**
 * The markets counted for the headline brand figure.
 *
 * The supplier has no global brand endpoint — `/v2/brands` needs a country —
 * so a total has to be assembled. Thirty markets is where the curve flattens:
 * five give 1,235 distinct brands, twenty give 2,092, thirty give 2,247, and
 * the next thirty would add a handful. Fetched in parallel, it costs about two
 * seconds on a page that is rebuilt hourly.
 */
const COUNTED_MARKETS = [
  "US", "GB", "DE", "IT", "FR", "ES", "NL", "PL", "SE", "AU",
  "CA", "JP", "BR", "MX", "IN", "TR", "AE", "ZA", "PT", "BE",
  "AT", "CH", "IE", "DK", "NO", "FI", "GR", "CZ", "RO", "HU",
];

/** Distinct brands on sale, counted rather than claimed. */
export async function countBrands(): Promise<number> {
  const catalogues = await Promise.all(
    COUNTED_MARKETS.map((c) => getCatalog(c).catch(() => null)),
  );
  const names = new Set<string>();
  for (const c of catalogues) {
    for (const b of c?.all ?? []) names.add(b.name);
  }
  return names.size;
}

/** Supported coins + networks. */
export async function getPaymentVias(): Promise<PaymentVia[]> {
  return call<PaymentVia[]>("/v3/payment_vias", { revalidate: 900 });
}

export type ResolvedProduct = {
  familyName: string;
  brandName: string;
  logo: string;
  /** Range-priced: the shopper names any amount between min and max. */
  isDynamic: boolean;
  /** Options are data plans rather than money amounts (eSIM, mobile bundles). */
  isPlanBased: boolean;
  /**
   * Where the product lands. Phone top-ups credit a number directly and the
   * supplier rejects the order unless `beneficiary_account` is an E.164 phone.
   */
  deliversTo: "email" | "phone";
  currency: string;
  /** Range-priced products only. */
  min: number;
  max: number;
  step: number;
  /** Everything else: the exact things on sale. */
  options: PurchaseOption[];
  /** Default money amount to preselect, for range products. */
  suggested: number;
  outOfStock: boolean;
  /** Plain-text summary the supplier ships on every product. */
  terms?: string;
  /** Sanitised editorial HTML. Any field may be absent for a given brand. */
  content: {
    description: string | null;
    howToRedeem: string | null;
    termsAndConditions: string | null;
    note: string | null;
    brandUrl: string | null;
  };
  redeemMethods: string[];
  category: string;
  kind: string;
};

function parseMoney(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Face value of a single upstream product, whatever shape it arrives in. */
function faceValueOf(p: Product): number | undefined {
  const amount = p.face_value?.amount as Record<string, unknown> | undefined;
  if (!amount) return undefined;
  return (
    parseMoney(amount.price) ??
    parseMoney(amount.value) ??
    parseMoney(amount.amount)
  );
}

/**
 * Pulls "10 GB", "30 days" and "1 month" out of an entitlement denomination.
 *
 * MINUS ONE IS NOT AN ALLOWANCE. The supplier signals an unlimited plan with a
 * benefit amount of `-1` — its denomination reads "Unlimited 3 days" — and
 * preferring the benefit over the string printed that sentinel straight onto
 * the buying screen as "-1 GB", on the row a shopper picks the plan by.
 */
function planDetails(
  p: Product,
): Pick<PurchaseOption, "data" | "days" | "period" | "unlimited"> {
  const source = p.denomination ?? "";

  const benefit = p.benefits?.find((b) => b.type === "DATA" || b.unit_type === "DATA");
  const benefitAmount =
    benefit?.amount?.total_including_tax?.amount ?? benefit?.amount?.base?.amount;

  const dataMatch = source.match(/([\d.]+)\s*(GB|MB|TB)/i);
  const daysMatch = source.match(/(\d+)\s*day/i);
  // Subscription periods, e.g. DAZN's "1 month" / "3 months".
  const periodMatch = source.match(/(\d+)\s*(week|month|year)s?/i);

  // Either side can carry it: the benefit says -1, the denomination says the
  // word. Checked before the allowance is built, so no negative one is built.
  const unlimited =
    (benefitAmount !== undefined && benefitAmount < 0) || /unlimited/i.test(source);

  const data = unlimited
    ? undefined
    : benefitAmount !== undefined && benefit?.unit
      ? { amount: benefitAmount, unit: benefit.unit }
      : dataMatch
        ? { amount: Number(dataMatch[1]), unit: dataMatch[2].toUpperCase() }
        : undefined;

  const period = periodMatch
    ? `${periodMatch[1]} ${periodMatch[2].toLowerCase()}${
        Number(periodMatch[1]) === 1 ? "" : "s"
      }`
    : undefined;

  return {
    data,
    unlimited: unlimited || undefined,
    days: daysMatch ? Number(daysMatch[1]) : undefined,
    period,
  };
}

function toOption(p: Product): PurchaseOption | null {
  // The supplier's own string is the only safe thing to order by.
  const denomination = p.denomination;
  if (!denomination) return null;

  const faceValue = faceValueOf(p) ?? null;
  const { data, days, period, unlimited } = planDetails(p);

  // Money is what carries a face value and grants no allowance or period.
  // Pattern-matching the string alone gets this wrong both ways: "5 EUR - PIN"
  // and "Libon $5" are money, while "1 month" carries a face value but buys
  // time, not credit.
  const isMoney = faceValue !== null && !data && !days && !period && !unlimited;

  // The supplier's localised label is authoritative: it carries the correct
  // currency and separates same-priced variants ("€5" vs "5 EUR - PIN").
  const label = isMoney
    ? (p.localized_denomination ?? denomination)
    : [
        unlimited ? "Unlimited" : data ? `${data.amount} ${data.unit}` : null,
        days ? `${days} days` : null,
      ]
        .filter(Boolean)
        .join(" · ") || (p.localized_denomination ?? denomination);

  return {
    denomination,
    label,
    deliversTo: p.delivery_type === "by_phone" ? "phone" : "email",
    faceValue,
    coinAmount: p.coin_amount,
    coin: p.coin,
    data,
    unlimited,
    days,
    period,
    isMoney,
  };
}

/**
 * Resolves the purchasable shape of a brand. Centralised deliberately, because
 * two upstream quirks are easy to get wrong and both cost the buyer money:
 *
 *  1. Range-priced products must be ordered as `denomination: "range"` +
 *     `product_value`. Passing the literal `"100 USD"` string resolves to a
 *     different, dearer product (~4.5% vs ~1.3% on a $100 card).
 *  2. Fixed-price brands sell only discrete face values (Steam: 10/20/50/100/
 *     150/200). An arbitrary amount must never be sent — upstream silently
 *     falls back to `default_denomination`, which can be far larger than what
 *     the buyer picked.
 */
export async function resolveProduct(
  countryCode: string,
  familyName: string,
  coin = "USDC",
  /**
   * Disambiguates when a family returns several products — "Lycamobile" yields
   * both "Lycamobile Credits" and "Lycamobile Bundle". Without this the first
   * one always wins and the other is unreachable.
   */
  brandName?: string,
): Promise<ResolvedProduct | null> {
  const families = await getProductsByFamily(countryCode, familyName, coin);
  if (!families?.length) return null;

  const family =
    (brandName &&
      families.find(
        (f) => (f.brand ?? f.family)?.toLowerCase() === brandName.toLowerCase(),
      )) ||
    families[0];

  const first = family?.products?.[0];
  if (!family || !first) return null;

  const isDynamic = Boolean(first.is_dynamic);
  const currency =
    first.range?.currency ?? first.face_value?.currency_code ?? "USD";

  let min = 0;
  let max = 0;
  let step = 1;
  let options: PurchaseOption[] = [];

  if (isDynamic) {
    const amount = first.face_value?.amount as Record<string, unknown> | undefined;
    min = first.range?.min ?? parseMoney(amount?.min) ?? 5;
    max = first.range?.max ?? parseMoney(amount?.max) ?? Math.max(min, 500);
    step = first.range?.step_size ?? 1;
  } else {
    const seen = new Set<string>();
    for (const p of family.products) {
      const opt = toOption(p);
      if (!opt || seen.has(opt.denomination)) continue;
      seen.add(opt.denomination);
      options.push(opt);
    }

    // Without a denomination string there is nothing safe to order.
    if (!options.length) return null;

    options.sort((a, b) => {
      if (a.faceValue !== null && b.faceValue !== null) {
        return a.faceValue - b.faceValue;
      }
      return 0;
    });

    const values = options
      .map((o) => o.faceValue)
      .filter((v): v is number => v !== null);
    min = values.length ? values[0] : 0;
    max = values.length ? values[values.length - 1] : 0;
  }

  const isPlanBased =
    !isDynamic &&
    options.some((o) => o.data !== undefined || o.days !== undefined || o.unlimited);

  const rich = family.rich_description ?? undefined;

  // Read off the products themselves rather than inferring from the category:
  // most mobile top-ups are by_phone, but some (Libon) are by_email.
  const deliversTo: "email" | "phone" = family.products.some(
    (p) => p.delivery_type === "by_phone",
  )
    ? "phone"
    : "email";

  // 100 is the amount buyers compare on; clamp it into what is actually sold.
  const suggested = isDynamic ? Math.min(Math.max(100, min), max) : min;

  return {
    familyName: family.family ?? family.brand,
    brandName: family.brand ?? family.family,
    logo: family.logo_url,
    isDynamic,
    isPlanBased,
    deliversTo,
    currency,
    min,
    max,
    step,
    options,
    suggested,
    outOfStock: Boolean(family.is_out_of_stock),
    terms: family.product_tc,
    content: {
      description: cleanHtml(rich?.description),
      howToRedeem: cleanHtml(rich?.how_to_redeem),
      // Upstream spells this without the plural on "term".
      termsAndConditions: cleanHtml(rich?.term_and_conditions),
      note: cleanHtml(rich?.note),
      brandUrl: rich?.brand_url ?? null,
    },
    redeemMethods: family.redeem_method ?? [],
    category: family.category,
    kind: family.kind,
  };
}

export type Selection = {
  /** For range products. */
  value?: number;
  /** For option products — the exact upstream string. */
  denomination?: string;
  /** Face value being charged, when known. */
  faceValue: number | null;
  label: string;
  /** Delivery target of the chosen option, which can differ within a product. */
  deliversTo: "email" | "phone";
  /** True when the request could not be honoured exactly. */
  adjusted: boolean;
};

/**
 * Resolves what the shopper asked for onto something actually on sale.
 *
 * Callers must surface `adjusted` rather than quietly charging for a different
 * product than the one chosen.
 */
export function selectPurchase(
  product: ResolvedProduct,
  requested: { value?: number; denomination?: string },
): Selection {
  if (product.isDynamic) {
    const want =
      typeof requested.value === "number" && Number.isFinite(requested.value)
        ? requested.value
        : product.suggested;
    const clamped = Math.min(Math.max(want, product.min), product.max);
    const snapped =
      product.step > 0
        ? Math.round((clamped - product.min) / product.step) * product.step +
          product.min
        : clamped;
    const value = Math.min(
      Math.max(Number(snapped.toFixed(2)), product.min),
      product.max,
    );
    return {
      value,
      faceValue: value,
      label: formatMoney(value, product.currency),
      deliversTo: product.deliversTo,
      adjusted: Math.abs(value - want) > 0.001,
    };
  }

  // Exact denomination wins whenever the caller names one.
  if (requested.denomination) {
    const exact = product.options.find(
      (o) => o.denomination === requested.denomination,
    );
    if (exact) {
      return {
        denomination: exact.denomination,
        faceValue: exact.faceValue,
        label: exact.label,
        deliversTo: exact.deliversTo,
        adjusted: false,
      };
    }
  }

  // Otherwise fall back to matching on money value, for money denominations.
  const want = requested.value;
  if (typeof want === "number") {
    const exact = product.options.find(
      (o) => o.faceValue !== null && Math.abs(o.faceValue - want) < 0.001,
    );
    if (exact) {
      return {
        denomination: exact.denomination,
        faceValue: exact.faceValue,
        label: exact.label,
        deliversTo: exact.deliversTo,
        adjusted: false,
      };
    }

    const priced = product.options.filter((o) => o.faceValue !== null);
    if (priced.length) {
      // Nearest sold value, ties going down so we never overcharge.
      const nearest = priced.reduce((best, o) =>
        Math.abs(o.faceValue! - want) < Math.abs(best.faceValue! - want) - 0.001
          ? o
          : best,
      priced[0]);
      return {
        denomination: nearest.denomination,
        faceValue: nearest.faceValue,
        label: nearest.label,
        deliversTo: nearest.deliversTo,
        adjusted: true,
      };
    }
  }

  const first = product.options[0];
  return {
    denomination: first.denomination,
    faceValue: first.faceValue,
    label: first.label,
    deliversTo: first.deliversTo,
    adjusted: Boolean(requested.denomination || requested.value),
  };
}

/* -------------------------------------------------------------------------- */
/* Pricing & orders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Builds the delivery object in the shape the supplier expects.
 *
 * This matters more than it looks: dynamically priced products must be sent as
 * `denomination: "range"` + `product_value`. Sending the literal `"100 USD"`
 * string resolves to a different, materially more expensive product — measured
 * at ~4.5% vs ~1.3% markup on the same $100 card.
 */
export function buildDelivery(args: {
  brandName: string;
  countryCode: string;
  /**
   * Where the product is credited: an email for cards and eSIM, an E.164 phone
   * number for top-ups. Not necessarily the buyer's account email.
   */
  beneficiary: string;
  /** Range-priced products carry a numeric value instead of a denomination. */
  value?: number;
  /** The supplier's exact denomination string, for everything else. */
  denomination?: string;
}): OrderDelivery {
  const base = {
    beneficiary_account: args.beneficiary,
    brand_name: args.brandName,
    country_code: args.countryCode,
  };
  if (args.denomination) {
    // Always the supplier's own string — reconstructing it silently resolves
    // to the wrong product ("12 USD" for an eSIM is NOT_AVAILABLE_PRODUCT).
    return { ...base, denomination: args.denomination };
  }
  return { ...base, denomination: "range", product_value: args.value ?? 0 };
}

export type QuoteArgs = {
  email: string;
  coin: string;
  network?: string;
  deliveries: OrderDelivery[];
  lang?: string;
  endUserIp?: string;
  endUserAgent?: string;
};

function orderBody(args: QuoteArgs) {
  return {
    email: args.email,
    payment: {
      type: "via",
      payment_via: "USER_WALLET",
      coin: args.coin,
      ...(args.network ? { network: args.network } : {}),
    },
    deliveries: args.deliveries,
    lang: args.lang ?? "en",
  };
}

/** Non-committal price check. Does not create an order. */
export async function validateOrder(args: QuoteArgs): Promise<Quote> {
  return call<Quote>("/v5/orders/validations", {
    method: "POST",
    body: JSON.stringify(orderBody(args)),
    endUserIp: args.endUserIp,
    endUserAgent: args.endUserAgent,
  });
}

/**
 * Creates a real order and returns payment instructions.
 *
 * `refundWalletAddress` is worth passing whenever it is known, and it can only
 * be passed here: the supplier accepts the field on creation and offers no way
 * to set it afterwards — PATCH and PUT on an order both 404. An order that goes
 * wrong without one is refundable only by agreeing an address with them by
 * hand, which is exactly the conversation a quarantined payment already forces.
 *
 * It must be the buyer's own wallet, never the address the money arrived from:
 * payments here are bridged, so the sender on record is a relayer, and refunding
 * "to the sender" would pay a stranger.
 */
export async function createOrder(
  args: QuoteArgs & { user?: { email: string }; refundWalletAddress?: string },
): Promise<Record<string, unknown>> {
  const body = {
    ...orderBody(args),
    user: args.user ?? { email: args.email },
    ...(args.refundWalletAddress
      ? { refund_wallet_address: args.refundWalletAddress }
      : {}),
  };
  return call<Record<string, unknown>>("/v5/orders", {
    method: "POST",
    body: JSON.stringify(body),
    endUserIp: args.endUserIp,
    endUserAgent: args.endUserAgent,
  });
}

export async function getOrder(orderId: string) {
  return call<Record<string, unknown>>(
    `/v5/orders/${encodeURIComponent(orderId)}`,
  );
}
