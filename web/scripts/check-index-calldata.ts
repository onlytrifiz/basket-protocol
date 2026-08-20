/**
 * Proves `encodeCreateIndex` produces exactly what the ABI says it should.
 *
 * Hand-rolled calldata for a struct with two dynamic arrays is the kind of thing that looks right,
 * decodes to garbage, and only tells you at the worst possible moment. This compares it against
 * `cast calldata`, which encodes from the signature itself.
 *
 *   npx tsx scripts/check-index-calldata.ts
 */
import { execFileSync } from "node:child_process";

import { encodeCreateIndex, type IndexConfig } from "../lib/indexCalldata";

const SIG =
  "createIndex((address,address,address,address[],uint16[],uint32,uint16,uint8,address),bytes32,address)";

const cases: { name: string; cfg: IndexConfig; salt: string; expected: string }[] = [
  {
    name: "basket of three",
    cfg: {
      owner: "0x1111111111111111111111111111111111111111",
      creator: "0x2222222222222222222222222222222222222222",
      quote: "0x0000000000000000000000000000000000000000",
      basket: [
        "0xb20000000000000000000078ee7ce2fE4908108C",
        "0xb200000000000000000000C2e324d24d7eEcd1fb",
        "0xb2000000000000000000002D0BA3164cc74f58B7",
      ],
      weights: [4000, 3500, 2500],
      interval: 3600,
      creatorShareBps: 2000,
      mode: 0,
      coin: "0x3333333333333333333333333333333333333333",
    },
    salt: "0x00000000000000000000000000000000000000000000000000000000000000ff",
    expected: "0x4444444444444444444444444444444444444444",
  },
  {
    name: "buyback, empty arrays",
    cfg: {
      owner: "0x1111111111111111111111111111111111111111",
      creator: "0x0000000000000000000000000000000000000000",
      quote: "0x4200000000000000000000000000000000000006",
      basket: [],
      weights: [],
      interval: 900,
      creatorShareBps: 0,
      mode: 1,
      coin: "0x0000000000000000000000000000000000000000",
    },
    salt: `0x${"ab".repeat(32)}`,
    expected: "0x0000000000000000000000000000000000000000",
  },
  {
    name: "single name, coin bound at creation",
    cfg: {
      owner: "0x5555555555555555555555555555555555555555",
      creator: "0x5555555555555555555555555555555555555555",
      quote: "0xb20000000000000000000078ee7ce2fE4908108C",
      basket: ["0xb200000000000000000000d9192b6B456483C2E8"],
      weights: [10000],
      interval: 604800,
      creatorShareBps: 10000,
      mode: 0,
      coin: "0x6666666666666666666666666666666666666666",
    },
    salt: `0x${"01".repeat(32)}`,
    expected: "0x7777777777777777777777777777777777777777",
  },
];

let failed = 0;
for (const c of cases) {
  const tuple =
    `(${c.cfg.owner},${c.cfg.creator},${c.cfg.quote},` +
    `[${c.cfg.basket.join(",")}],[${c.cfg.weights.join(",")}],` +
    `${c.cfg.interval},${c.cfg.creatorShareBps},${c.cfg.mode},${c.cfg.coin})`;
  const want = execFileSync("cast", ["calldata", SIG, tuple, c.salt, c.expected], {
    encoding: "utf8",
  }).trim();
  const got = encodeCreateIndex(c.cfg, c.salt, c.expected);
  const ok = want.toLowerCase() === got.toLowerCase();
  console.log(`  ${ok ? "ok  " : "FAIL"} ${c.name}`);
  if (!ok) {
    failed++;
    console.log(`    cast : ${want}`);
    console.log(`    ours : ${got}`);
  }
}
process.exit(failed ? 1 : 0);
