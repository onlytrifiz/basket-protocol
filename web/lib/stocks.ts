export type IndexStock = {
  /** In the index the deployed vault actually buys, and therefore quotable today. Membership is
   *  NOT the same question as issuance, and the gap has widened: nineteen of these forty-three report a
   *  non-zero `totalSupply()` on Base, but supply alone does not make a name routable. What the
   *  trade panel needs is an Aerodrome Slipstream USDC pool with depth, which is also what the
   *  keeper needs — it skips the entire purchase when any active asset has no complete route, so an
   *  unroutable member stalls every buy rather than just its own leg. Read the live index from
   *  `stocksLength()` / `stockAt(i)`; this flag is the seed list's copy of it. */
  inIndex?: boolean;
  symbol: string;
  name: string;
  address: string;
  domain: string;
  /** The underlying's TradFi ticker — what Finnhub and Yahoo know the company as. It is the B20
   *  symbol minus the "c" suffix in every case so far, but it is written out rather than derived:
   *  a listing whose token symbol does not simply append "c" would silently query the wrong
   *  company, and being wrong about which stock a price belongs to is the one error this page
   *  cannot afford.
   *
   *  OPTIONAL BECAUSE COINBASE TOKENIZES PRE-IPO EQUITY. SPCXc was exactly that until SpaceX listed
   *  on 12 June 2026; it has a ticker now, and the next pre-IPO listing will not. Everything
   *  downstream treats a missing ticker as "no public market to compare against" rather than as an
   *  error, so such an asset still renders with its on-chain half intact. */
  ticker?: string;
  /**
   * The company's own mark colour, for charts.
   *
   * Chosen to stay legible on the dark navy panel the index donut sits on, which rules out the
   * literal brand value three times now: Apple's black would vanish into the background, so it takes
   * the silver from its hardware palette; Microsoft's four-square has no single colour, so it takes
   * the blue; and SpaceX is monochrome outright — white on black in its own icon and in the one the
   * token publishes through `contractURI()` — so it takes the engine plume, the one colour every
   * photograph of the company has in it. The rest are the real thing.
   *
   * SPCXc's is amber for a measured reason, not a taste one. The ring's separation is carried by
   * lightness between the two blues and by hue everywhere else, and a fifth cool grey landed on top
   * of Apple's silver: 1.56 contrast between them, with no hue difference left to tell them apart.
   * Darkening it made that worse rather than better, because every step down the blue-grey ramp
   * crosses one of the four already there — #8FA6BF sits at 1.06 against Apple, #6E8CA8 at 1.01
   * against Alphabet. Amber is the only hue in the ring with no neighbour, and at 5.02 against the
   * panel it is legible on its own.
   */
  brand: string;
  /**
   * The company's colour on a LIGHT surface, when the ring colour is the wrong answer there.
   *
   * `brand` above is chosen to survive the donut: five arcs on dark navy that have to stay apart
   * from each other, which is why SpaceX's is amber rather than the black its own icon is, and why
   * Alphabet takes the blue out of a four-colour mark. Neither constraint exists on a white card —
   * there is nothing to be legible against and nothing to be told apart from — so a card can wear
   * the colour the company actually uses. Absent, the ring colour is already right for both.
   */
  wash?: string;
  referencePrice?: string;
};

/**
 * The colour a company wears on a LIGHT surface — a card wash, a tinted border, a hover.
 *
 * `wash` when the listing declares one, the ring colour otherwise, and the house blue for a
 * listing this repo has never seen. Centralised so a company cannot end up two different colours
 * on two pages that both claim to show its brand.
 */
export const washColor = (stock?: IndexStock) => stock?.wash ?? stock?.brand ?? "#7aa8ff";

export const stocks: IndexStock[] = [
  { inIndex: true, symbol: "NVDAc", name: "NVIDIA", domain: "nvidia.com", ticker: "NVDA", brand: "#76B900", address: "0xb20000000000000000000078ee7ce2fe4908108c", referencePrice: "479.490" },
  { inIndex: true, symbol: "AAPLc", name: "Apple", domain: "apple.com", ticker: "AAPL", brand: "#A2AAAD", address: "0xb200000000000000000000c2e324d24d7eecd1fb", referencePrice: "333.730" },
  { inIndex: true, symbol: "GOOGLc", name: "Alphabet", domain: "google.com", ticker: "GOOGL", brand: "#4285F4", wash: "#EA4335", address: "0xb2000000000000000000002d0ba3164cc74f58b7", referencePrice: "294.914" },
  { inIndex: true, symbol: "METAc", name: "Meta", domain: "about.meta.com", ticker: "META", brand: "#0866FF", address: "0xb2000000000000000000008bc8786b856e61707c", referencePrice: "172.185" },
  { inIndex: true, symbol: "SPCXc", name: "SpaceX", domain: "spacex.com", ticker: "SPCX", brand: "#D9702F", wash: "#111111", address: "0xb2000000000000000000007b9fcbd005511acbd5", referencePrice: "149.383" },
  // A monochrome mark takes SpaceX's split: a light ring colour for the dark panel, the black of its
  // own icon on a light card. A mark too dark for the panel (Novavax, PayPal) takes a lighter step
  // of its hue for the ring and keeps the real one as `wash`. None of these ring colours has been
  // checked against the others in the donut; do that before any of them joins the index.
  // Smartbird's domain is its investor site because smartbird.ai's favicon is white on transparent,
  // which vanishes on the white tiles that draw from `domain`; the IR host serves it in black.
  { symbol: "AMDc", name: "AMD", domain: "amd.com", ticker: "AMD", brand: "#ED1C24", address: "0xb2000000000000000000000d8ce462e99ee7a47b" },
  { symbol: "AMZNc", name: "Amazon", domain: "amazon.com", ticker: "AMZN", brand: "#FF9900", address: "0xb200000000000000000000d9192b6b456483c2e8" },
  { symbol: "ASTSc", name: "AST SpaceMobile", domain: "ast-science.com", ticker: "ASTS", brand: "#F58220", address: "0xb200000000000000000000b1a29cf17a1819288a" },
  { symbol: "AVGOc", name: "Broadcom", domain: "broadcom.com", ticker: "AVGO", brand: "#CC092F", address: "0xb200000000000000000000fc737aea6196ab5a4c" },
  { symbol: "BEc", name: "Bloom Energy", domain: "bloomenergy.com", ticker: "BE", brand: "#8DC63F", address: "0xb20000000000000000000016f9dfe862feba122b" },
  { symbol: "BIRDc", name: "Smartbird", domain: "ir.smartbird.ai", ticker: "BIRD", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000535fe96f18204bfd96" },
  { symbol: "CAKEc", name: "Cheesecake Factory", domain: "thecheesecakefactory.com", ticker: "CAKE", brand: "#C79A4B", address: "0xb200000000000000000000f215e4c890cfb7176b" },
  { symbol: "COINc", name: "Coinbase", domain: "coinbase.com", ticker: "COIN", brand: "#0052FF", address: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { symbol: "CRCLc", name: "Circle", domain: "circle.com", ticker: "CRCL", brand: "#3ECFAF", address: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { symbol: "DJTc", name: "Trump Media", domain: "tmtgcorp.com", ticker: "DJT", brand: "#5B5BD6", address: "0xb200000000000000000000428e3a3eebbb20692b" },
  { symbol: "DKNGc", name: "DraftKings", domain: "draftkings.com", ticker: "DKNG", brand: "#F46C22", address: "0xb2000000000000000000009b870441031d4d8a41" },
  { symbol: "DUOLc", name: "Duolingo", domain: "duolingo.com", ticker: "DUOL", brand: "#58CC02", address: "0xb200000000000000000000a613d12deafbbb1db7" },
  { symbol: "GMEc", name: "GameStop", domain: "gamestop.com", ticker: "GME", brand: "#E4002B", address: "0xb2000000000000000000007790ed6e48e06ed935" },
  { symbol: "HIMSc", name: "Hims & Hers", domain: "forhims.com", ticker: "HIMS", brand: "#E6E6E6", wash: "#111111", address: "0xb20000000000000000000043a599976181bcf336" },
  { symbol: "HTZc", name: "Hertz", domain: "hertz.com", ticker: "HTZ", brand: "#FFD100", address: "0xb2000000000000000000002601c5c94f435da168" },
  { symbol: "INTCc", name: "Intel", domain: "intel.com", ticker: "INTC", brand: "#0F8FE0", address: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { symbol: "LLYc", name: "Eli Lilly", domain: "lilly.com", ticker: "LLY", brand: "#D52B1E", address: "0xb200000000000000000000f1a0f91e34892e4718" },
  { symbol: "MRNAc", name: "Moderna", domain: "modernatx.com", ticker: "MRNA", brand: "#E4173E", address: "0xb200000000000000000000e215e9b76ecba02468" },
  { symbol: "MRVLc", name: "Marvell", domain: "marvell.com", ticker: "MRVL", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000ec3c4c7395cc609813" },
  { symbol: "MSFTc", name: "Microsoft", domain: "microsoft.com", ticker: "MSFT", brand: "#00A4EF", address: "0xb200000000000000000000ab99cfa739e253872b" },
  { symbol: "MSTRc", name: "Strategy", domain: "strategy.com", ticker: "MSTR", brand: "#E8352B", address: "0xb2000000000000000000004884b426556b92883d" },
  { symbol: "MUc", name: "Micron", domain: "micron.com", ticker: "MU", brand: "#9FC3E6", wash: "#111111", address: "0xb200000000000000000000fd2f87532b90095211" },
  { symbol: "NFLXc", name: "Netflix", domain: "netflix.com", ticker: "NFLX", brand: "#E50914", address: "0xb20000000000000000000058b8c947e44011dfe6" },
  { symbol: "NVAXc", name: "Novavax", domain: "novavax.com", ticker: "NVAX", brand: "#4FC3D0", wash: "#1B1464", address: "0xb200000000000000000000c597c476fcf9aed3a8" },
  { symbol: "ORCLc", name: "Oracle", domain: "oracle.com", ticker: "ORCL", brand: "#C74634", address: "0xb200000000000000000000347afba223d7b6b63c" },
  { symbol: "PFEc", name: "Pfizer", domain: "pfizer.com", ticker: "PFE", brand: "#2F6BFF", address: "0xb20000000000000000000018fe7ec7d6dfeeb528" },
  { symbol: "PLTRc", name: "Palantir", domain: "palantir.com", ticker: "PLTR", brand: "#F4F4F5", wash: "#111111", address: "0xb2000000000000000000007d16372840df4dabbe" },
  { symbol: "PMc", name: "Philip Morris", domain: "pmi.com", ticker: "PM", brand: "#5B8BD6", wash: "#1D4F91", address: "0xb2000000000000000000008fc2a8c23cf5937b66" },
  { symbol: "PTONc", name: "Peloton", domain: "onepeloton.com", ticker: "PTON", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000009272a491812842aa84" },
  { symbol: "PYPLc", name: "PayPal", domain: "paypal.com", ticker: "PYPL", brand: "#009CDE", wash: "#003087", address: "0xb200000000000000000000450ad3abe5d4846c6e" },
  { symbol: "QUBTc", name: "Quantum Computing", domain: "quantumcomputinginc.com", ticker: "QUBT", brand: "#6F7FE0", wash: "#1B2366", address: "0xb200000000000000000000ca425ab42e07c35bc3" },
  { symbol: "RBLXc", name: "Roblox", domain: "roblox.com", ticker: "RBLX", brand: "#E2231A", address: "0xb2000000000000000000005bd7ae89b9e6189bb5" },
  { symbol: "RDDTc", name: "Reddit", domain: "reddit.com", ticker: "RDDT", brand: "#FF4500", address: "0xb20000000000000000000066242d4067724cb7a1" },
  { symbol: "SNDKc", name: "SanDisk", domain: "sandisk.com", ticker: "SNDK", brand: "#E5202E", address: "0xb200000000000000000000397293cb8cda9a10c5" },
  { symbol: "SOUNc", name: "SoundHound", domain: "soundhound.com", ticker: "SOUN", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000002137743d4a01fe4e88" },
  { symbol: "TSLAc", name: "Tesla", domain: "tesla.com", ticker: "TSLA", brand: "#E82127", address: "0xb2000000000000000000001e800a7f5189430cd0" },
  { symbol: "TTWOc", name: "Take-Two", domain: "take2games.com", ticker: "TTWO", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000f720c26062bc3067da" },
  { symbol: "WENc", name: "Wendy's", domain: "wendys.com", ticker: "WEN", brand: "#E2203D", address: "0xb20000000000000000000044e3cd7a0e1028e57a" },
];

export const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;

const BY_SYMBOL = new Map(stocks.map((s) => [s.symbol.toLowerCase(), s]));
const BY_ADDRESS = new Map(stocks.map((s) => [s.address.toLowerCase(), s]));

export const stockBySymbol = (symbol: string) => BY_SYMBOL.get(symbol.toLowerCase());
export const stockByAddress = (address: string) => BY_ADDRESS.get(address.toLowerCase());
