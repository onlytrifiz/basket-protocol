import assert from "node:assert/strict";
import { test } from "node:test";

process.env.RPC_URL ||= "http://127.0.0.1:1";
process.env.KEEPER_PRIVATE_KEY ||= "0x0000000000000000000000000000000000000000000000000000000000000001";
process.env.INDEX_FACTORY ||= "0x0000000000000000000000000000000000000001";
process.env.ETHERSCAN_API_KEY ||= "test";
process.env.PRICE_TTL_MS = "0"; // every call asks again, so each test step is one lookup
process.env.PRICE_STALE_MAX_MS = "200";

const { usdPrice, usdValue } = await import("../src/prices.js");

const TOKEN = "0xb20000000000000000000078ee7ce2fE4908108C";
const WETH = "0x4200000000000000000000000000000000000006";
const ZERO = "0x0000000000000000000000000000000000000000";

/** DexScreener's shape: the token as base side, one pool. */
const answer = (token: string, usd: number) =>
  new Response(JSON.stringify([{ baseToken: { address: token }, priceUsd: String(usd), liquidity: { usd: 1e6 } }]));

let next: () => Promise<Response>;
globalThis.fetch = (async () => next()) as typeof fetch;
const quiet = console.log;
console.log = () => {};

test("a price that arrives is used", async () => {
  next = async () => answer(TOKEN, 200);
  assert.equal(await usdPrice(TOKEN as never), 200);
});

test("a lookup that fails answers with the last price that arrived", async () => {
  next = async () => new Response("rate limited", { status: 429 });
  assert.equal(await usdPrice(TOKEN as never), 200);
  next = async () => {
    throw new Error("network down");
  };
  assert.equal(await usdPrice(TOKEN as never), 200);
  // and the dollar helpers see it too: 0.05 of a $200 token
  assert.equal(await usdValue(TOKEN as never, 5_000_000n, 8), 10);
});

test("a fresh price replaces the remembered one", async () => {
  next = async () => answer(TOKEN, 210);
  assert.equal(await usdPrice(TOKEN as never), 210);
  next = async () => new Response("", { status: 500 });
  assert.equal(await usdPrice(TOKEN as never), 210);
});

test("past PRICE_STALE_MAX_MS a miss is a miss again (the gates go permissive)", async () => {
  await new Promise((r) => setTimeout(r, 250));
  next = async () => new Response("", { status: 500 });
  assert.equal(await usdPrice(TOKEN as never), null);
});

test("a token never priced stays unpriced", async () => {
  next = async () => new Response("[]");
  assert.equal(await usdPrice("0x000000000000000000000000000000000000beef" as never), null);
});

test("native and WETH share one remembered price", async () => {
  next = async () => answer(WETH, 2700);
  assert.equal(await usdPrice(WETH as never), 2700);
  next = async () => new Response("", { status: 503 });
  assert.equal(await usdPrice(ZERO as never), 2700);
  console.log = quiet;
});
