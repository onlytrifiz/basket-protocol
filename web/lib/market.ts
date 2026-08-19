import { cached } from "./cache";
import { stocks } from "./stocks";

/**
 * The underlying company, as the stock market sees it.
 *
 * This is the half of the story a DEX cannot tell. A tokenized equity is only worth what it tracks,
 * so the page listing NVDAc has to say what NVDA itself did today — and, more usefully than either
 * number alone, how far the on-chain price has drifted from it. That spread is the one figure a
 * tokenized-stock hub is uniquely placed to show, and it needs this route.
 *
 * TWO SOURCES, RANKED BY WHAT BREAKS IF THEY FAIL:
 *
 *   Finnhub is the SPINE — quotes, fundamentals and news. It is a documented API with a key and a
 *   60-call/minute free tier; thirteen quotes in parallel measured 390ms with no throttling. The
 *   headline price of every row comes from here.
 *
 *   Yahoo supplies only the historical SERIES behind the charts. It is an undocumented endpoint
 *   that throttles hard and erratically — measured from this codebase, the same request answers 429
 *   and then 200 a second later, with the User-Agent making no difference. That is survivable for a
 *   sparkline, which simply does not draw, and unacceptable for a price, which would read as fact.
 *   An earlier version had this backwards and the entire board rendered empty whenever Yahoo
 *   sulked.
 *
 * Without FINNHUB_API_KEY the route falls back to Yahoo for quotes too, so the site still works on
 * a fresh clone — just less reliably, which is the honest trade for having no key.
 *
 * The ticker is never taken from the request: it is matched against the seed list, so this cannot be
 * pointed at an arbitrary symbol or used to proxy traffic to either upstream.
 */

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const FINNHUB = "https://finnhub.io/api/v1";
const RANGES: Record<string, { range: string; interval: string }> = {
  "1d": { range: "1d", interval: "5m" },
  "5d": { range: "5d", interval: "30m" },
  "1mo": { range: "1mo", interval: "1d" },
  "6mo": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "5y": { range: "5y", interval: "1wk" },
};

export type Quote = {
  ticker: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  currency: string;
  dayHigh?: number;
  dayLow?: number;
  open?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  /** Seconds. When the last regular-session print landed — a weekend price is not a live one. */
  marketTime?: number;
};

export type Series = { t: number[]; c: number[] };

export type Profile = {
  name?: string;
  industry?: string;
  country?: string;
  weburl?: string;
  ipo?: string;
  exchange?: string;
  /** USD. Finnhub reports millions; normalised here so callers never guess the unit. */
  marketCapUsd?: number;
  sharesOutstanding?: number;
  peRatio?: number;
  dividendYield?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
};

export type NewsItem = { headline: string; source: string; url: string; datetime: number; summary?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const KEY = process.env.FINNHUB_API_KEY;

async function finnhub<T>(path: string): Promise<T | null> {
  if (!KEY) return null;
  try {
    const response = await fetch(`${FINNHUB}${path}${path.includes("?") ? "&" : "?"}token=${KEY}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/** Finnhub's `/quote`: c current, d change, dp change %, h/l/o day range, pc previous close. */
type FinnhubQuote = { c?: number; d?: number; dp?: number; h?: number; l?: number; o?: number; pc?: number; t?: number };

async function finnhubQuote(ticker: string): Promise<Quote | null> {
  const raw = await finnhub<FinnhubQuote>(`/quote?symbol=${encodeURIComponent(ticker)}`);
  const price = num(raw?.c);
  // Finnhub answers an unknown symbol with a zero-filled object rather than an error, and a price of
  // zero rendered next to a live DEX price would read as a 100% discount.
  if (!price) return null;
  const previousClose = num(raw?.pc) ?? price;
  return {
    ticker,
    price,
    previousClose,
    change: num(raw?.d) ?? price - previousClose,
    changePercent: num(raw?.dp) ?? (previousClose ? ((price - previousClose) / previousClose) * 100 : 0),
    currency: "USD",
    dayHigh: num(raw?.h),
    dayLow: num(raw?.l),
    open: num(raw?.o),
    marketTime: num(raw?.t),
  };
}

/**
 * One Yahoo request, retried gently and WITHOUT a fake browser User-Agent.
 *
 * SENDING A CHROME USER-AGENT IS WHAT BREAKS THIS. Measured against the live endpoint: with a
 * browser UA the server got 429 on every attempt, four in a row, while a plain Node request from the
 * same machine in the same second got 200 and 251 closes. Removing the header fixed it outright.
 * Yahoo appears to bucket its rate limit per (IP, User-Agent) and to be far stricter with a browser
 * UA arriving from something that is plainly not a browser — so the disguise costs the request it
 * was meant to protect. Do not "fix" a 429 here by adding a UA back.
 *
 * The retry stays gentle for the other half of the problem: the bucket refills in about a second, so
 * a 429 means "ask again in a moment", and an early version that retried both hosts three times
 * inside 2.4 seconds simply throttled itself. One request per attempt, alternating hosts, with a
 * pause between each — and the result is cached for minutes, so the extra second costs nothing.
 */
async function yahooJson<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    try {
      const response = await fetch(`${YAHOO_HOSTS[attempt % YAHOO_HOSTS.length]}${path}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.ok) return await response.json() as T;
    } catch {
      // Network trouble on this host: the next attempt uses the other one.
    }
  }
  // THROWN, never returned empty. `cached()` can only fall back to its last good answer if it can
  // tell a failure from a success; an empty result reads as "there is nothing to report" and would
  // poison the cache with a blank board for the whole TTL.
  throw new Error(`yahoo unavailable: ${path}`);
}

/** Yahoo emits a null close for halted intervals. Dropping the pair keeps a line continuous;
 *  carrying the null forward would draw a spike down to zero. */
function toSeries(stamps: (number | undefined)[], closes: (number | null | undefined)[]): Series {
  const series: Series = { t: [], c: [] };
  closes.forEach((close, i) => {
    const stamp = stamps[i];
    if (typeof close === "number" && Number.isFinite(close) && typeof stamp === "number") {
      series.t.push(stamp); series.c.push(close);
    }
  });
  return series;
}

/** A month of closes for every listed ticker, in ONE request — the hub's inline sparklines. */
async function yahooSparks(tickers: string[]): Promise<Record<string, Series>> {
  const payload = await yahooJson<Record<string, { timestamp?: number[]; close?: (number | null)[] }>>(
    `/v8/finance/spark?symbols=${encodeURIComponent(tickers.join(","))}&range=1mo&interval=1d`,
  );
  const out: Record<string, Series> = {};
  for (const ticker of tickers) {
    const entry = payload?.[ticker];
    if (!entry?.close) continue;
    const series = toSeries(entry.timestamp ?? [], entry.close);
    if (series.c.length > 1) out[ticker] = series;
  }
  if (Object.keys(out).length === 0) throw new Error("yahoo spark: no usable series");
  return out;
}

async function yahooChart(ticker: string, range: string, interval: string): Promise<Series> {
  const payload = await yahooJson<{
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
  }>(`/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`);

  const result = payload.chart?.result?.[0];
  const series = toSeries(result?.timestamp ?? [], result?.indicators?.quote?.[0]?.close ?? []);
  if (series.c.length === 0) throw new Error("yahoo chart: no closes");
  return series;
}

/** Yahoo's chart meta, used only when there is no Finnhub key to ask for a quote. */
async function yahooQuote(ticker: string): Promise<Quote | null> {
  const payload = await yahooJson<{ chart?: { result?: Array<{ meta?: Record<string, unknown> }> } }>(
    `/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`,
  );
  const meta = payload.chart?.result?.[0]?.meta;
  const price = num(meta?.regularMarketPrice);
  if (!meta || price === undefined) return null;
  // `chartPreviousClose` follows the requested RANGE, so on a long chart it is an old price and the
  // change built from it would be a months-long move labelled as today's.
  const previousClose = num(meta.previousClose) ?? num(meta.chartPreviousClose) ?? price;
  return {
    ticker,
    price,
    previousClose,
    change: price - previousClose,
    changePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : 0,
    currency: str(meta.currency) ?? "USD",
    dayHigh: num(meta.regularMarketDayHigh),
    dayLow: num(meta.regularMarketDayLow),
    fiftyTwoWeekHigh: num(meta.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(meta.fiftyTwoWeekLow),
    marketTime: num(meta.regularMarketTime),
  };
}

const quoteFor = (ticker: string) =>
  cached(`quote:${ticker}`, 60_000, () => (KEY ? finnhubQuote(ticker) : yahooQuote(ticker))).catch(() => null);

async function profileFor(ticker: string): Promise<Profile | null> {
  const [profile, metrics] = await Promise.all([
    finnhub<Record<string, unknown>>(`/stock/profile2?symbol=${encodeURIComponent(ticker)}`),
    finnhub<{ metric?: Record<string, unknown> }>(`/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all`),
  ]);
  if (!profile && !metrics) return null;

  const metric = metrics?.metric ?? {};
  // Finnhub reports both of these in MILLIONS. Normalised here so no caller has to remember that.
  const marketCapMillions = num(profile?.marketCapitalization);
  const sharesMillions = num(profile?.shareOutstanding);

  return {
    name: str(profile?.name),
    industry: str(profile?.finnhubIndustry),
    country: str(profile?.country),
    weburl: str(profile?.weburl),
    ipo: str(profile?.ipo),
    exchange: str(profile?.exchange),
    marketCapUsd: marketCapMillions !== undefined ? marketCapMillions * 1e6 : undefined,
    sharesOutstanding: sharesMillions !== undefined ? sharesMillions * 1e6 : undefined,
    peRatio: num(metric.peBasicExclExtraTTM) ?? num(metric.peTTM),
    dividendYield: num(metric.dividendYieldIndicatedAnnual),
    beta: num(metric.beta),
    fiftyTwoWeekHigh: num(metric["52WeekHigh"]),
    fiftyTwoWeekLow: num(metric["52WeekLow"]),
  };
}

async function newsFor(ticker: string): Promise<NewsItem[]> {
  const day = 86_400_000;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 14 * day).toISOString().slice(0, 10);
  const items = await finnhub<Array<Record<string, unknown>>>(
    `/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}`,
  );
  if (!Array.isArray(items)) return [];
  return items
    .filter((n) => str(n.headline) && str(n.url))
    .slice(0, 6)
    .map((n) => ({
      headline: n.headline as string,
      source: str(n.source) ?? "",
      url: n.url as string,
      datetime: num(n.datetime) ?? 0,
      summary: str(n.summary)?.slice(0, 240),
    }));
}

/** Only tickers this site actually lists may be requested — see the note at the top. */
export const LISTED = new Set(stocks.map((s) => s.ticker).filter(Boolean) as string[]);

export type MarketBoard = { quotes: Record<string, Quote>; series: Record<string, Series>; degraded: boolean };

/** Quotes plus month-long sparkline series for a set of tickers. Used by the hub, list-wide. */
export async function marketBoard(tickers: string[]): Promise<MarketBoard> {
  const unique = [...new Set(tickers.filter((t) => LISTED.has(t)))].sort().slice(0, 25);
  if (unique.length === 0) return { quotes: {}, series: {}, degraded: true };

  const [quoteList, series] = await Promise.all([
    Promise.all(unique.map(quoteFor)),
    // Sparklines are an enhancement: when Yahoo throttles, rows simply lose their mini-charts.
    cached(`sparks:${unique.join(",")}`, 300_000, () => yahooSparks(unique)).catch(() => ({} as Record<string, Series>)),
  ]);

  const quotes: Record<string, Quote> = {};
  quoteList.forEach((quote, i) => { if (quote) quotes[unique[i]] = quote; });

  return { quotes, series, degraded: Object.keys(quotes).length === 0 };
}

export type MarketDetail = {
  quote: Quote | null;
  series: Series | null;
  profile: Profile | null;
  news: NewsItem[];
  hasFundamentals: boolean;
};

/** Everything the detail page knows about one company. */
export async function marketDetail(ticker: string, rangeKey = "1y"): Promise<MarketDetail> {
  const { range, interval } = RANGES[rangeKey] ?? RANGES["1y"];
  // Settled independently: a sulking chart endpoint must not take the quote or the fundamentals
  // down with it. Each degrades to its own empty state and the page still renders.
  const [quote, series, profile, news] = await Promise.all([
    quoteFor(ticker),
    cached(`chart:${ticker}:${range}`, 300_000, () => yahooChart(ticker, range, interval)).catch(() => null),
    cached(`profile:${ticker}`, 6 * 3_600_000, () => profileFor(ticker)).catch(() => null),
    cached(`news:${ticker}`, 3_600_000, () => newsFor(ticker)).catch(() => [] as NewsItem[]),
  ]);
  return { quote, series, profile, news, hasFundamentals: Boolean(KEY) };
}
