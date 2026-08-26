import { cached } from "./cache";

/**
 * The whole Base tokenized-equity market, not just the B20s this site lists.
 *
 * Blockworks' analytics dashboard tracks every issuer on Base — Backed, Coinbase, Centrifuge,
 * Dinari — and each of its widgets is fed by a public, unauthenticated JSON endpoint with a 60s CDN
 * cache in front of it. That is the only place this breadth of data exists outside an Enterprise
 * subscription: Messari's documented free API does not carry tokenized equities at all (verified —
 * the asset search answers empty for every issuer and ticker).
 *
 * UNDOCUMENTED, so held at arm's length: every widget is fetched through `cached()` with a 5-minute
 * TTL and settles independently. A widget that stops answering drops its own card from the section;
 * the section only disappears when the headline numbers are gone too. The visualization IDs below
 * are the studio's own and change if a widget is ever recreated over there — when a card goes
 * missing, re-read them from the dashboard page's `/_next/data/…/base-tokenized-equities.json`.
 */

const STUDIO = "https://blockworks.com/api/studio/dashboard/base-tokenized-equities/visualization";

const VIZ = {
  kpis: 13268,
  totalSupply: 13257,
  supplyByIssuer: 13258,
  tokens: 13260,
  volumeByDex: 13261,
  volumeByIssuer: 13262,
  lendingByToken: 13263,
  lendingByProtocol: 13264,
  holderVenues: 13266,
  holderCounts: 13267,
} as const;

type Row = Record<string, unknown>;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown) => (typeof value === "string" && value ? value : null);

async function fetchViz(id: number): Promise<Row[]> {
  const response = await fetch(`${STUDIO}/${id}/execution?limit=50000&page=1`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`blockworks viz ${id}: ${response.status}`);
  const body = (await response.json()) as { data?: Row[] };
  // THROWN, never returned empty — `cached()` can only serve its last good answer if a failure
  // looks different from "the market has nothing to report". Same contract as the Yahoo client.
  if (!Array.isArray(body.data) || body.data.length === 0) throw new Error(`blockworks viz ${id}: empty`);
  return body.data;
}

const viz = (id: number) => cached(`blockworks:${id}`, 300_000, () => fetchViz(id));

/** One chart: dates ascending, series aligned to them. `null` is "not live yet", never zero. */
export type MarketSeries = { name: string; color: string; v: (number | null)[] };
export type MarketChartData = { dates: string[]; series: MarketSeries[] };

export type PulseKpis = {
  supplyUsd: number;
  tokenCount: number;
  equityCount: number;
  /** 0..1 — how much of the market the largest issuer holds. */
  topIssuerShare: number;
};

export type PulseToken = {
  symbol: string;
  issuer: string;
  underlying: string | null;
  priceUsd: number | null;
  /** null: listed with nothing circulating yet — most of the market, same as the unminted B20s. */
  supplyUsd: number | null;
  holders: number | null;
};

export type MarketPulse = {
  kpis: PulseKpis;
  asOf: string;
  totalSupply: MarketChartData | null;
  supplyByIssuer: MarketChartData | null;
  volumeByIssuer: MarketChartData | null;
  volumeByDex: MarketChartData | null;
  lendingByToken: MarketChartData | null;
  lendingByProtocol: MarketChartData | null;
  holderVenues: MarketChartData | null;
  holderCounts: MarketChartData | null;
  tokens: PulseToken[];
};

/**
 * Fallback palette for series nobody owns a color for, stepped and ORDERED for color-blind
 * separation on the navy desk. Named entities do not draw from here — see BRAND_COLORS.
 */
export const VIZ_COLORS = ["#91d4ff", "#ff9a5c", "#c39bff", "#29b377", "#ffdd7e", "#ff8fc0"];

const ISSUERS = ["Backed Finance", "Coinbase", "Centrifuge", "Dinari"] as const;

/**
 * Brand-anchored series colors, TUNED FOR THE NAVY DESK — the authentic hex of most brands is
 * too dark there, so each is the recognizable hue stepped up to ≥3:1 (Coinbase's #0052FF becomes
 * #4d7dff, NVIDIA's #76B900 becomes #82ca00, and so on). Where a brand has no ownable hue, or
 * its true hue collapses against a chart-mate for color-blind readers, the entity takes the
 * nearest distinguishable slot instead (Dinari reads teal here, SpaceX gold): recognizable-when-
 * possible loses to tell-apart-always.
 *
 * Every CHART's line-up was run through the CVD validator in its actual series order (worst
 * surviving pair: protan ΔE 9.0 on the issuer set, normal-vision floor 15.7) — so a new entity or
 * a "truer" hex is not a one-line edit: re-run the sets it appears in before shipping it.
 * DEX keys are the upstream slugs, since colors attach before the legend names are prettified.
 */
export const BRAND_COLORS: Record<string, string> = {
  // Issuers — also the table's chips. Centrifuge is orange in Blockworks' own charts; kept.
  "Backed Finance": "#91d4ff",
  Coinbase: "#4d7dff",
  Centrifuge: "#ff9a5c",
  Dinari: "#2fc79f",
  // Tokens, by the company underneath. deSPXA wears its issuer's orange, tying the S&P token to
  // Centrifuge across every chart and chip it shares the section with.
  NVDAc: "#82ca00",
  GOOGLc: "#ea4335",
  AAPLc: "#c9d2da",
  METAc: "#58b8ff",
  wbCOIN: "#4d7dff",
  deSPXA: "#ff9a5c",
  SPCX: "#ffdd7e",
  // DEXs (slug-keyed) and lending protocols.
  uniswap: "#ff4d9d",
  aerodrome: "#5f8bff",
  pancakeswap: "#33d6e2",
  sushiswap: "#c084fc",
  balancer: "#b9c4d0",
  // No brand to anchor to; pinned (not fallback) because the fallback slot would sit green
  // beside PancakeSwap's cyan. Gold is what the DEX set was validated with.
  tessera: "#ffdd7e",
  Morpho: "#6f8fff",
  Euler: "#ffdd7e",
};

export const ISSUER_COLORS: Record<string, string> = {
  "Backed Finance": BRAND_COLORS["Backed Finance"],
  Coinbase: BRAND_COLORS.Coinbase,
  Centrifuge: BRAND_COLORS.Centrifuge,
  Dinari: BRAND_COLORS.Dinari,
};

const colorFor = (name: string, slot: number) =>
  BRAND_COLORS[name] ?? VIZ_COLORS[slot % VIZ_COLORS.length];

/** The token table names issuers by slug; the timeseries name them in full. One spelling here. */
const ISSUER_BY_SLUG: Record<string, string> = {
  backed: "Backed Finance",
  "backed-finance": "Backed Finance",
  coinbase: "Coinbase",
  centrifuge: "Centrifuge",
  dinari: "Dinari",
};

const dateOf = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);

/** Every 7th day plus the newest — daily grids at chart width are pixels the reader cannot see. */
function weeklyIndexes(length: number): number[] {
  const picks: number[] = [];
  for (let i = 0; i < length; i += 7) picks.push(i);
  if (picks[picks.length - 1] !== length - 1) picks.push(length - 1);
  return picks;
}

/** Long rows (date, key, value) → aligned weekly series, keyed rows may skip dates entirely. */
function pivotWeekly(
  rows: Row[],
  keyField: string,
  valueField: string,
  dateField: string,
  names: string[] | null,
): MarketChartData | null {
  const byKey = new Map<string, Map<string, number>>();
  const dates = new Set<string>();
  for (const row of rows) {
    const date = dateOf(row[dateField]);
    const key = str(row[keyField]);
    if (!date || !key) continue;
    dates.add(date);
    if (!byKey.has(key)) byKey.set(key, new Map());
    const value = num(row[valueField]);
    if (value !== null) byKey.get(key)!.set(date, value);
  }
  if (byKey.size === 0) return null;

  const grid = [...dates].sort();
  const picks = weeklyIndexes(grid.length);
  // Callers that pass no order get largest-first, so the first palette slots go to the series a
  // reader will actually chase, and the legend lists them the way the chart ranks them.
  const keys =
    names ??
    [...byKey.keys()].sort((a, b) => {
      const peak = (key: string) => Math.max(0, ...byKey.get(key)!.values());
      return peak(b) - peak(a);
    });
  return {
    dates: picks.map((i) => grid[i]),
    series: keys
      .filter((name) => byKey.has(name))
      .map((name, slot) => ({
        name,
        color: colorFor(name, slot),
        v: picks.map((i) => byKey.get(name)!.get(grid[i]) ?? null),
      })),
  };
}

/** Same pivot, but SUMMED into Monday-anchored weeks — for flows, where sampling would lie. */
function pivotWeeklySum(
  rows: Row[],
  keyField: string,
  valueField: string,
  dateField: string,
): MarketChartData | null {
  const byWeek = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const date = dateOf(row[dateField]);
    const key = str(row[keyField]);
    const value = num(row[valueField]);
    if (!date || !key || value === null) continue;
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const week = day.toISOString().slice(0, 10);
    if (!byWeek.has(week)) byWeek.set(week, new Map());
    const bucket = byWeek.get(week)!;
    bucket.set(key, (bucket.get(key) ?? 0) + value);
    totals.set(key, (totals.get(key) ?? 0) + value);
  }
  if (byWeek.size === 0) return null;

  const weeks = [...byWeek.keys()].sort();
  // Largest flow first, so the stack reads bottom-up in the order the legend lists.
  const keys = [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  return {
    dates: weeks,
    series: keys.map((name, slot) => ({
      name,
      color: colorFor(name, slot),
      v: weeks.map((week) => byWeek.get(week)!.get(name) ?? 0),
    })),
  };
}

function shapeKpis(rows: Row[]): PulseKpis | null {
  const row = rows[0];
  const supplyUsd = num(row?.total_supply_usd);
  const tokenCount = Number(row?.num_tokenized_equities);
  const equityCount = Number(row?.num_equities);
  const topIssuerShare = num(row?.pct_top_issuer);
  if (supplyUsd === null || !Number.isFinite(tokenCount) || topIssuerShare === null) return null;
  return { supplyUsd, tokenCount, equityCount: Number.isFinite(equityCount) ? equityCount : 0, topIssuerShare };
}

function shapeTotalSupply(rows: Row[]): MarketChartData | null {
  const points = rows
    .map((row) => ({ date: dateOf(row.block_date), value: num(row.circulating_supply_usd) }))
    .filter((p): p is { date: string; value: number } => p.date !== null && p.value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 2) return null;
  // Every 2nd day keeps the shape at half the payload; the newest point always survives.
  const kept = points.filter((_, i) => i % 2 === 0 || i === points.length - 1);
  return {
    dates: kept.map((p) => p.date),
    series: [{ name: "Circulating supply", color: VIZ_COLORS[0], v: kept.map((p) => p.value) }],
  };
}

/** The venue columns of viz 13266, unpacked into "where the supply sits" series. */
function shapeHolderVenues(rows: Row[]): MarketChartData | null {
  const VENUES: Array<[string, string]> = [
    ["balance_usd_spot_dex", "Spot DEXs"],
    ["balance_usd_cex", "CEXs"],
    ["balance_usd_lending", "Lending"],
    ["balance_usd_unknown", "Wallets & other"],
  ];
  const long: Row[] = [];
  for (const row of rows) {
    for (const [field, name] of VENUES) {
      long.push({ date: row.date, key: name, value: row[field] });
    }
  }
  const shaped = pivotWeekly(long, "key", "value", "date", VENUES.map(([, name]) => name));
  if (!shaped) return null;
  shaped.series.forEach((series, slot) => { series.color = VIZ_COLORS[slot % VIZ_COLORS.length]; });
  return shaped;
}

function shapeHolderCounts(rows: Row[]): MarketChartData | null {
  // The upstream widget already filters to the most-held tokens; keep its top six so every line
  // still gets a hue that survives the color-blind check.
  const latest = new Map<string, number>();
  for (const row of rows) {
    const symbol = str(row.symbol);
    const holders = num(row.holders_total);
    if (symbol && holders !== null) latest.set(symbol, Math.max(latest.get(symbol) ?? 0, holders));
  }
  const top = [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([symbol]) => symbol);
  // Colors come from the pivot: each symbol wears its company's hue via BRAND_COLORS.
  return pivotWeekly(rows, "symbol", "holders_total", "date", top);
}

function shapeTokens(rows: Row[]): PulseToken[] {
  // EVERY listed token, like the original table — only a handful have circulating supply, and
  // cutting to those would misrepresent a market that is mostly listings waiting for size.
  // Live tokens first by size; the empty tail alphabetical, so it reads as a directory.
  return rows
    .map((row) => {
      const symbol = str(row.symbol);
      if (!symbol) return null;
      const slug = str(row.issuer_id) ?? "";
      const supplyUsd = num(row.supply_circulating_usd);
      return {
        symbol,
        issuer: ISSUER_BY_SLUG[slug] ?? slug,
        underlying: str(row.underlying_asset_id)?.toUpperCase() ?? null,
        priceUsd: num(row.price_usd),
        supplyUsd: supplyUsd && supplyUsd > 0 ? supplyUsd : null,
        holders: num(row.holders_total),
      };
    })
    .filter((token): token is PulseToken => token !== null)
    .sort((a, b) => (b.supplyUsd ?? 0) - (a.supplyUsd ?? 0) || a.symbol.localeCompare(b.symbol))
    // A fuse against an upstream gone weird, not a design limit.
    .slice(0, 200);
}

/**
 * Everything the market section shows, in one settled object — or null, which the page reads as
 * "leave the whole section out". Each widget degrades alone; only the headline figures are load-
 * bearing, because a band of empty chart frames under a working KPI row would be worse than
 * neither.
 */
export async function marketPulse(): Promise<MarketPulse | null> {
  const grab = <T>(id: number, shape: (rows: Row[]) => T | null) =>
    viz(id).then(shape).catch(() => null);

  const [kpis, totalSupply, supplyByIssuer, volumeByIssuer, volumeByDex, lendingByToken, lendingByProtocol, holderVenues, holderCounts, tokens] =
    await Promise.all([
      grab(VIZ.kpis, shapeKpis),
      grab(VIZ.totalSupply, shapeTotalSupply),
      grab(VIZ.supplyByIssuer, (rows) => pivotWeekly(rows, "issuer_id", "circulating_supply_usd", "block_date", [...ISSUERS])),
      grab(VIZ.volumeByIssuer, (rows) => pivotWeeklySum(rows, "issuer_name", "volume_usd", "block_date")),
      grab(VIZ.volumeByDex, (rows) => {
        const shaped = pivotWeeklySum(rows, "exchange_id", "volume_usd", "block_date");
        // Exchange ids arrive as slugs; the legend should not.
        shaped?.series.forEach((series) => { series.name = series.name[0].toUpperCase() + series.name.slice(1); });
        return shaped;
      }),
      grab(VIZ.lendingByToken, (rows) => pivotWeekly(rows, "token_symbol", "deposit_balance_usd", "date", null)),
      grab(VIZ.lendingByProtocol, (rows) => pivotWeekly(rows, "protocol_name", "deposit_balance_usd", "date", null)),
      grab(VIZ.holderVenues, shapeHolderVenues),
      grab(VIZ.holderCounts, shapeHolderCounts),
      grab(VIZ.tokens, shapeTokens),
    ]);

  if (!kpis || !totalSupply) return null;
  return {
    kpis,
    asOf: totalSupply.dates[totalSupply.dates.length - 1],
    totalSupply,
    supplyByIssuer,
    volumeByIssuer,
    volumeByDex,
    lendingByToken,
    lendingByProtocol,
    holderVenues,
    holderCounts,
    tokens: tokens ?? [],
  };
}
