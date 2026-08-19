export type IndexStock = {
  /** In the index the deployed vault actually buys, and therefore quotable today. The other names
   *  are published as the intended universe but report `totalSupply() == 0` on Base: no supply, no
   *  pool, no route. Offering them in the trade panel would be offering a trade that cannot fill. */
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
   * literal brand value twice: Apple's black would vanish into the background, so it takes the
   * silver from its hardware palette, and Microsoft's four-square has no single colour, so it takes
   * the blue. The rest are the real thing.
   */
  brand: string;
  referencePrice?: string;
};

export const stocks: IndexStock[] = [
  { inIndex: true, symbol: "NVDAc", name: "NVIDIA", domain: "nvidia.com", ticker: "NVDA", brand: "#76B900", address: "0xb20000000000000000000078ee7ce2fe4908108c", referencePrice: "479.490" },
  { inIndex: true, symbol: "AAPLc", name: "Apple", domain: "apple.com", ticker: "AAPL", brand: "#A2AAAD", address: "0xb200000000000000000000c2e324d24d7eecd1fb", referencePrice: "333.730" },
  { inIndex: true, symbol: "GOOGLc", name: "Alphabet", domain: "google.com", ticker: "GOOGL", brand: "#4285F4", address: "0xb2000000000000000000002d0ba3164cc74f58b7", referencePrice: "294.914" },
  { inIndex: true, symbol: "METAc", name: "Meta Platforms", domain: "about.meta.com", ticker: "META", brand: "#0866FF", address: "0xb2000000000000000000008bc8786b856e61707c", referencePrice: "172.185" },
  { symbol: "AMZNc", name: "Amazon", domain: "amazon.com", ticker: "AMZN", brand: "#FF9900", address: "0xb200000000000000000000d9192b6b456483c2e8" },
  { symbol: "COINc", name: "Coinbase Global", domain: "coinbase.com", ticker: "COIN", brand: "#0052FF", address: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { symbol: "CRCLc", name: "Circle Internet Group", domain: "circle.com", ticker: "CRCL", brand: "#3ECFAF", address: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { symbol: "INTCc", name: "Intel", domain: "intel.com", ticker: "INTC", brand: "#0F8FE0", address: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { symbol: "MSFTc", name: "Microsoft", domain: "microsoft.com", ticker: "MSFT", brand: "#00A4EF", address: "0xb200000000000000000000ab99cfa739e253872b" },
  { symbol: "MSTRc", name: "Strategy", domain: "strategy.com", ticker: "MSTR", brand: "#E8352B", address: "0xb2000000000000000000004884b426556b92883d" },
  { symbol: "SNDKc", name: "SanDisk", domain: "sandisk.com", ticker: "SNDK", brand: "#E5202E", address: "0xb200000000000000000000397293cb8cda9a10c5" },
  { symbol: "SPCXc", name: "SpaceX", domain: "spacex.com", ticker: "SPCX", brand: "#C7D3E3", address: "0xb2000000000000000000007b9fcbd005511acbd5" },
  { symbol: "TSLAc", name: "Tesla", domain: "tesla.com", ticker: "TSLA", brand: "#E82127", address: "0xb2000000000000000000001e800a7f5189430cd0" },
];

export const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;

const BY_SYMBOL = new Map(stocks.map((s) => [s.symbol.toLowerCase(), s]));
const BY_ADDRESS = new Map(stocks.map((s) => [s.address.toLowerCase(), s]));

export const stockBySymbol = (symbol: string) => BY_SYMBOL.get(symbol.toLowerCase());
export const stockByAddress = (address: string) => BY_ADDRESS.get(address.toLowerCase());
