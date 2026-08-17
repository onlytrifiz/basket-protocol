export type IndexStock = {
  symbol: string;
  name: string;
  address: string;
  domain: string;
  referencePrice?: string;
};

export const stocks: IndexStock[] = [
  { symbol: "NVDAc", name: "NVIDIA", domain: "nvidia.com", address: "0xb20000000000000000000078ee7ce2fe4908108c", referencePrice: "479.490" },
  { symbol: "AAPLc", name: "Apple", domain: "apple.com", address: "0xb200000000000000000000c2e324d24d7eecd1fb", referencePrice: "333.730" },
  { symbol: "GOOGLc", name: "Alphabet", domain: "google.com", address: "0xb2000000000000000000002d0ba3164cc74f58b7", referencePrice: "294.914" },
  { symbol: "METAc", name: "Meta Platforms", domain: "about.meta.com", address: "0xb2000000000000000000008bc8786b856e61707c", referencePrice: "172.185" },
  { symbol: "AMZNc", name: "Amazon", domain: "amazon.com", address: "0xb200000000000000000000d9192b6b456483c2e8" },
  { symbol: "COINc", name: "Coinbase Global", domain: "coinbase.com", address: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { symbol: "CRCLc", name: "Circle Internet Group", domain: "circle.com", address: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { symbol: "INTCc", name: "Intel", domain: "intel.com", address: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { symbol: "MSFTc", name: "Microsoft", domain: "microsoft.com", address: "0xb200000000000000000000ab99cfa739e253872b" },
  { symbol: "MSTRc", name: "Strategy", domain: "strategy.com", address: "0xb2000000000000000000004884b426556b92883d" },
  { symbol: "SNDKc", name: "SanDisk", domain: "sandisk.com", address: "0xb200000000000000000000397293cb8cda9a10c5" },
  { symbol: "SPCXc", name: "SpaceX", domain: "spacex.com", address: "0xb2000000000000000000007b9fcbd005511acbd5" },
  { symbol: "TSLAc", name: "Tesla", domain: "tesla.com", address: "0xb2000000000000000000001e800a7f5189430cd0" },
];

export const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;
