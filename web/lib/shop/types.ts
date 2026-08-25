// Shapes we actually consume from the supplier API. Deliberately narrow —
// the upstream payloads carry far more than the storefront needs.

export type ProductRange = {
  min: number;
  max: number;
  currency: string;
  step_size: number;
  default: string;
};

export type ProductBenefit = {
  type?: string;
  unit_type?: string;
  unit?: string;
  amount?: {
    total_including_tax?: { amount?: number };
    base?: { amount?: number };
  };
};

export type Product = {
  product_id: string;
  is_dynamic: boolean;
  range?: ProductRange;
  /**
   * The supplier's canonical identifier for a non-dynamic product, e.g.
   * "50 USD" or "10 GB 30 days". Orders must quote this string verbatim.
   */
  denomination?: string;
  localized_denomination?: string;
  coin?: string;
  coin_amount?: string;
  payment_method?: string;
  delivery_type?: string;
  points?: string;
  product_type?: string;
  benefits?: ProductBenefit[];
  face_value?: {
    currency_code: string;
    amount:
      | { type: "range"; min: string; max: string }
      | { type?: string; price?: string; value?: string; amount?: string };
  };
};

/**
 * One thing a shopper can actually buy. Covers both money denominations
 * ("50 USD") and plan denominations ("10 GB 30 days") behind one shape.
 */
export type PurchaseOption = {
  /** Exact string to send upstream as `denomination`. Never reconstructed. */
  denomination: string;
  /**
   * What to show the shopper. Prefers the supplier's own localised label, which
   * carries the right currency symbol and distinguishes variants that share a
   * face value — "€5" (credited to a phone) vs "5 EUR - PIN" (emailed).
   */
  label: string;
  /**
   * Where *this option* is delivered. Varies within a single product: WindTre
   * sells both a by_phone top-up and a by_email PIN at every price.
   */
  deliversTo: "email" | "phone";
  /** Face value in the product currency, when the option is a money amount. */
  faceValue: number | null;
  /** Catalogue price in coin, when the supplier pre-quotes it. */
  coinAmount?: string;
  coin?: string;
  /** Data allowance, for plan options. Absent on an unlimited plan. */
  data?: { amount: number; unit: string };
  /** No allowance to state, because there is not one. See `planDetails`. */
  unlimited?: boolean;
  /** Validity in days, for plan options. */
  days?: number;
  /**
   * True when the denomination is a monetary amount. False for entitlements —
   * a data bundle or a subscription period. Brands sell both: DAZN lists
   * "1 month" alongside "44.99 EUR" as separate products at different prices.
   */
  isMoney: boolean;
  /** Human period for subscription options, e.g. "1 month". */
  period?: string;
};

/**
 * Editorial copy the supplier ships per brand. All HTML.
 * Note the upstream spelling of `term_and_conditions`.
 */
export type RichDescription = {
  markup?: string;
  description?: string | null;
  how_to_redeem?: string | null;
  term_and_conditions?: string | null;
  note?: string | null;
  redeem_geo?: string | null;
  brand_tagline?: string | null;
  brand_url?: string | null;
};

export type BrandFamily = {
  country_code: string;
  category: string;
  additional_categories: string[];
  kind: string;
  default_denomination: string;
  products: Product[];
  family: string;
  brand_id: string;
  brand: string;
  is_out_of_stock: boolean;
  logo_url: string;
  logo_base_url?: string;
  product_tc?: string;
  redeem_method?: string[];
  rich_description?: RichDescription | null;
  product_type?: string;
  brand_tags?: string[];
};

/** Flattened brand card used across the storefront grid. */
export type BrandCard = {
  slug: string;
  /** Display name. Unique per product; `family` is not. */
  name: string;
  /**
   * The key the supplier indexes products by. One family can return several
   * products — "Lycamobile" yields both "Lycamobile Credits" and
   * "Lycamobile Bundle" — so `name` is what disambiguates them.
   */
  family: string;
  brandId?: string;
  logo: string;
  /** Brand's own backdrop colour, shipped by the supplier. */
  bgColor?: string;
  kind: string;
  category: string;
  additionalCategories: string[];
  countryCode: string;
  outOfStock: boolean;
  /** Presentational range labels, e.g. "$5" / "$500". Not always numeric. */
  minLabel?: string;
  maxLabel?: string;
  productType?: string;
};

/** One selectable category tab. */
export type CategoryGroup = {
  kind: string;
  category: string;
  count: number;
};

export type PaymentCurrency = {
  name: string;
  logo_url?: string;
  networks?: { name: string; display_name?: string }[];
};

export type PaymentVia = {
  name: string;
  currencies: PaymentCurrency[];
};

export type QuoteProblem = {
  problem: string;
  moreDetails?: unknown;
};

export type Quote = {
  coin: string;
  coin_amount: string;
  original_coin_amount: string;
  payment_fee?: { amount: string; original_amount: string };
  summary?: {
    coin_amount_to_pay_in_crypto: string;
    as_USD?: { value_to_pay_in_crypto: string };
    as_EUR?: { value_to_pay_in_crypto: string };
  };
  problems?: QuoteProblem[];
  deliveries?: {
    id: string;
    delivery_state: string;
    kind: string;
    deliverable?: Record<string, unknown>;
  }[];
};

export type OrderDelivery = {
  beneficiary_account: string;
  brand_name: string;
  country_code: string;
  denomination: string;
  product_value?: number;
};
