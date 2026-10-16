export type IndexStock = {
  /** In the index the deployed vault actually buys, and therefore quotable today. Membership is
   *  NOT the same question as issuance, and the gap has widened: thirty-nine of fifty-three reported
   *  a non-zero `totalSupply()` on 29 September 2026, but supply alone does not make a name routable. What the
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
  // StablecoinX and Brinker use theirs for want of any favicon on the main site — and StablecoinX,
  // like BitMine and Oura, published no icon in `contractURI()` at listing, so this is its only mark.
  // Figure and Twenty One Capital listed with an empty `contractURI()`; their favicons are the mark.
  // BRK.Bc's ticker keeps Finnhub's dot; `lib/market` turns it into Yahoo's BRK-B.
  // The 8 October batch (NVOc to VALEc) are ADRs of foreign companies; each ticker is the US listing,
  // quoted in dollars, whatever home exchange Finnhub's profile names.
  // Simply Good Foods' own domains serve no favicon; atkins.com, its main brand, stands in.
  // Oura has no ticker: it postponed its Nasdaq IPO (as OURA) on 29 September 2026. Give it one
  // when it trades.
  { symbol: "AAOIc", name: "Applied Optoelectronics", domain: "ao-inc.com", ticker: "AAOI", brand: "#3F8FD8", address: "0xb200000000000000000000cf36d05963a3e2205c" },
  { symbol: "ABNBc", name: "Airbnb", domain: "airbnb.com", ticker: "ABNB", brand: "#FF5A5F", address: "0xb200000000000000000000045beafafbe0dc7664" },
  { symbol: "AEOc", name: "American Eagle", domain: "ae.com", ticker: "AEO", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000006064f8ec027f042294" },
  { symbol: "AMCc", name: "AMC Entertainment", domain: "amctheatres.com", ticker: "AMC", brand: "#E0202E", address: "0xb200000000000000000000cd7e6b8042cb7c2bb5" },
  { symbol: "AMDc", name: "AMD", domain: "amd.com", ticker: "AMD", brand: "#ED1C24", address: "0xb2000000000000000000000d8ce462e99ee7a47b" },
  { symbol: "AMZNc", name: "Amazon", domain: "amazon.com", ticker: "AMZN", brand: "#FF9900", address: "0xb200000000000000000000d9192b6b456483c2e8" },
  { symbol: "APPc", name: "AppLovin", domain: "applovin.com", ticker: "APP", brand: "#E6E6E6", wash: "#111111", address: "0xb20000000000000000000006f910a0e7bbd3c168" },
  { symbol: "ARMc", name: "Arm", domain: "arm.com", ticker: "ARM", brand: "#2AC4C4", wash: "#111111", address: "0xb20000000000000000000026215d755356e5043f" },
  { symbol: "ASTSc", name: "AST SpaceMobile", domain: "ast-science.com", ticker: "ASTS", brand: "#F58220", address: "0xb200000000000000000000b1a29cf17a1819288a" },
  { symbol: "AURc", name: "Aurora", domain: "aurora.tech", ticker: "AUR", brand: "#5B7BE0", wash: "#0A2A66", address: "0xb200000000000000000000cf62d7125cc77d2f96" },
  { symbol: "AVGOc", name: "Broadcom", domain: "broadcom.com", ticker: "AVGO", brand: "#CC092F", address: "0xb200000000000000000000fc737aea6196ab5a4c" },
  { symbol: "AXONc", name: "Axon", domain: "axon.com", ticker: "AXON", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000004cc3e96ceb78541d33" },
  { symbol: "AXTIc", name: "AXT", domain: "axt.com", ticker: "AXTI", brand: "#3E7BC8", address: "0xb200000000000000000000a640ec8c1de0efb484" },
  { symbol: "BALLc", name: "Ball", domain: "ball.com", ticker: "BALL", brand: "#4F7BF0", wash: "#0033A0", address: "0xb200000000000000000000747bffa52fe2c2510b" },
  { symbol: "BEc", name: "Bloom Energy", domain: "bloomenergy.com", ticker: "BE", brand: "#8DC63F", address: "0xb20000000000000000000016f9dfe862feba122b" },
  { symbol: "BIDUc", name: "Baidu", domain: "baidu.com", ticker: "BIDU", brand: "#4E6EF2", wash: "#2932E1", address: "0xb200000000000000000000d2b7d9aee52f6c6bef" },
  { symbol: "BILIc", name: "Bilibili", domain: "bilibili.com", ticker: "BILI", brand: "#23ADE5", address: "0xb200000000000000000000ca7c6d1438e7245eb6" },
  { symbol: "BIRDc", name: "Smartbird", domain: "ir.smartbird.ai", ticker: "BIRD", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000535fe96f18204bfd96" },
  { symbol: "BJc", name: "BJ's Wholesale", domain: "bjs.com", ticker: "BJ", brand: "#D71920", address: "0xb200000000000000000000082f7fea8f2ee8f438" },
  { symbol: "BKSYc", name: "BlackSky", domain: "blacksky.com", ticker: "BKSY", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000bc4d895df1eeed1d06" },
  { symbol: "BLNKc", name: "Blink Charging", domain: "blinkcharging.com", ticker: "BLNK", brand: "#3FB54A", address: "0xb2000000000000000000004ec7c19212979672f9" },
  { symbol: "BMNRc", name: "BitMine", domain: "bitminetech.io", ticker: "BMNR", brand: "#36D07A", address: "0xb200000000000000000000ea2df44a307cab279c" },
  { symbol: "BOOTc", name: "Boot Barn", domain: "bootbarn.com", ticker: "BOOT", brand: "#C0392B", wash: "#7A1F1F", address: "0xb2000000000000000000003e5e2892158e25dd7b" },
  { symbol: "BRK.Bc", name: "Berkshire Hathaway", domain: "berkshirehathaway.com", ticker: "BRK.B", brand: "#6A8FD0", wash: "#000080", address: "0xb20000000000000000000024170488e788cbbcb4" },
  { symbol: "BUDc", name: "AB InBev", domain: "ab-inbev.com", ticker: "BUD", brand: "#F2C200", wash: "#111111", address: "0xb200000000000000000000c36ce081dd09e86ca2" },
  { symbol: "BYNDc", name: "Beyond Meat", domain: "beyondmeat.com", ticker: "BYND", brand: "#7FB843", address: "0xb200000000000000000000801830b13b8e493423" },
  { symbol: "CAKEc", name: "Cheesecake Factory", domain: "thecheesecakefactory.com", ticker: "CAKE", brand: "#C79A4B", address: "0xb200000000000000000000f215e4c890cfb7176b" },
  { symbol: "CANc", name: "Canaan", domain: "canaan.io", ticker: "CAN", brand: "#4E7FD0", wash: "#1B3F7A", address: "0xb200000000000000000000f32d61ba597eddfbfd" },
  { symbol: "CAVAc", name: "CAVA", domain: "cava.com", ticker: "CAVA", brand: "#F2C94C", wash: "#B8860B", address: "0xb2000000000000000000001b6e407239eb31edcf" },
  { symbol: "CBRSc", name: "Cerebras", domain: "cerebras.ai", ticker: "CBRS", brand: "#F05A28", address: "0xb200000000000000000000720133eedf525f93e2" },
  { symbol: "CELHc", name: "Celsius", domain: "celsius.com", ticker: "CELH", brand: "#F5821F", address: "0xb2000000000000000000004161b4168d03841511" },
  { symbol: "CHPTc", name: "ChargePoint", domain: "chargepoint.com", ticker: "CHPT", brand: "#F7941D", address: "0xb2000000000000000000001ca01a48688ec7d3cc" },
  { symbol: "CHWYc", name: "Chewy", domain: "chewy.com", ticker: "CHWY", brand: "#3E7BF0", wash: "#1C49C2", address: "0xb200000000000000000000a5e12a1842dfcdb118" },
  { symbol: "CIFRc", name: "Cipher Digital", domain: "cipherdigital.com", ticker: "CIFR", brand: "#9ED615", address: "0xb200000000000000000000690275843b6e246286" },
  { symbol: "CLOVc", name: "Clover Health", domain: "cloverhealth.com", ticker: "CLOV", brand: "#3FBF8F", address: "0xb20000000000000000000055e63c4c1cdc6b7a36" },
  { symbol: "CLSKc", name: "CleanSpark", domain: "cleanspark.com", ticker: "CLSK", brand: "#5B84D6", wash: "#10306E", address: "0xb200000000000000000000fa63cfff5c794dbb95" },
  { symbol: "COINc", name: "Coinbase", domain: "coinbase.com", ticker: "COIN", brand: "#0052FF", address: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { symbol: "CORZc", name: "Core Scientific", domain: "corescientific.com", ticker: "CORZ", brand: "#F26B3A", address: "0xb2000000000000000000001aaa9010cd65f82c5e" },
  { symbol: "CRCLc", name: "Circle", domain: "circle.com", ticker: "CRCL", brand: "#3ECFAF", address: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { symbol: "CROXc", name: "Crocs", domain: "crocs.com", ticker: "CROX", brand: "#7FB241", address: "0xb200000000000000000000431a5c1e48e3b1d130" },
  { symbol: "CRWVc", name: "CoreWeave", domain: "coreweave.com", ticker: "CRWV", brand: "#5A5CF0", address: "0xb200000000000000000000f111184a74720787e6" },
  { symbol: "CVNAc", name: "Carvana", domain: "carvana.com", ticker: "CVNA", brand: "#16A6DE", address: "0xb200000000000000000000ffb10718f880a48274" },
  { symbol: "DASHc", name: "DoorDash", domain: "doordash.com", ticker: "DASH", brand: "#FF3008", address: "0xb200000000000000000000bf391678bf2e38cedb" },
  { symbol: "DJTc", name: "Trump Media", domain: "tmtgcorp.com", ticker: "DJT", brand: "#5B5BD6", address: "0xb200000000000000000000428e3a3eebbb20692b" },
  { symbol: "DKNGc", name: "DraftKings", domain: "draftkings.com", ticker: "DKNG", brand: "#F46C22", address: "0xb2000000000000000000009b870441031d4d8a41" },
  { symbol: "DNAc", name: "Ginkgo Bioworks", domain: "ginkgobioworks.com", ticker: "DNA", brand: "#2BB3C0", address: "0xb200000000000000000000cc17eea8c9495e1499" },
  { symbol: "DUOLc", name: "Duolingo", domain: "duolingo.com", ticker: "DUOL", brand: "#58CC02", address: "0xb200000000000000000000a613d12deafbbb1db7" },
  { symbol: "EATc", name: "Brinker", domain: "investors.brinker.com", ticker: "EAT", brand: "#6A93E0", wash: "#1B4F9C", address: "0xb200000000000000000000808e9cca9ed8e4da61" },
  { symbol: "ELFc", name: "e.l.f. Beauty", domain: "elfbeauty.com", ticker: "ELF", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000006b7f6966ee0453e251" },
  { symbol: "ENPHc", name: "Enphase", domain: "enphase.com", ticker: "ENPH", brand: "#F58220", address: "0xb2000000000000000000007a90b2d9ed101035a8" },
  { symbol: "FIGRc", name: "Figure", domain: "figure.com", ticker: "FIGR", brand: "#6C5CE7", address: "0xb2000000000000000000005a41bef59807119850" },
  { symbol: "FWDIc", name: "Forward Industries", domain: "forwardindustries.com", ticker: "FWDI", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000001e838d4beb66cf8fb7" },
  { symbol: "GAMEc", name: "GameSquare", domain: "gamesquare.com", ticker: "GAME", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000005550e8506124236271" },
  { symbol: "GEMIc", name: "Gemini", domain: "gemini.com", ticker: "GEMI", brand: "#F26B3A", address: "0xb2000000000000000000009c52748e1d1cbd5fd6" },
  { symbol: "GLXYc", name: "Galaxy Digital", domain: "galaxy.com", ticker: "GLXY", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000006de7888c3fffd803ac" },
  { symbol: "GMEc", name: "GameStop", domain: "gamestop.com", ticker: "GME", brand: "#E4002B", address: "0xb2000000000000000000007790ed6e48e06ed935" },
  { symbol: "GPROc", name: "GoPro", domain: "gopro.com", ticker: "GPRO", brand: "#2BA9E0", address: "0xb200000000000000000000f0e13d9c1cdfd211c8" },
  { symbol: "HIMSc", name: "Hims & Hers", domain: "forhims.com", ticker: "HIMS", brand: "#E6E6E6", wash: "#111111", address: "0xb20000000000000000000043a599976181bcf336" },
  { symbol: "HPQc", name: "HP", domain: "hp.com", ticker: "HPQ", brand: "#0096D6", address: "0xb2000000000000000000009a3602cf5d020afa98" },
  { symbol: "HSAIc", name: "Hesai", domain: "hesaitech.com", ticker: "HSAI", brand: "#E3262E", address: "0xb200000000000000000000f3049f4aa834b23b64" },
  { symbol: "HSYc", name: "Hershey", domain: "thehersheycompany.com", ticker: "HSY", brand: "#B07A5A", wash: "#4E2A1E", address: "0xb200000000000000000000f327a373aa86ac86a8" },
  { symbol: "HTZc", name: "Hertz", domain: "hertz.com", ticker: "HTZ", brand: "#FFD100", address: "0xb2000000000000000000002601c5c94f435da168" },
  { symbol: "HUTc", name: "Hut 8", domain: "hut8.com", ticker: "HUT", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000006ee1c139a723872e09" },
  { symbol: "IBRXc", name: "ImmunityBio", domain: "immunitybio.com", ticker: "IBRX", brand: "#3E8FD8", wash: "#0B4F8C", address: "0xb20000000000000000000077d13d6c79b6c11c5a" },
  { symbol: "INFYc", name: "Infosys", domain: "infosys.com", ticker: "INFY", brand: "#2E8FD0", wash: "#007CC3", address: "0xb200000000000000000000f6b0417af5f52341fc" },
  { symbol: "INTCc", name: "Intel", domain: "intel.com", ticker: "INTC", brand: "#0F8FE0", address: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { symbol: "IONQc", name: "IonQ", domain: "ionq.com", ticker: "IONQ", brand: "#F39C29", address: "0xb20000000000000000000058f143099d5f79b0ec" },
  { symbol: "JACKc", name: "Jack in the Box", domain: "jackinthebox.com", ticker: "JACK", brand: "#E2231A", address: "0xb200000000000000000000b44f193b3ffdf17037" },
  { symbol: "KODKc", name: "Kodak", domain: "kodak.com", ticker: "KODK", brand: "#E30613", address: "0xb200000000000000000000a63e35e673e3776b88" },
  { symbol: "KSSc", name: "Kohl's", domain: "kohls.com", ticker: "KSS", brand: "#D6497D", wash: "#860036", address: "0xb200000000000000000000105a1f43ff3605c5de" },
  { symbol: "LCIDc", name: "Lucid", domain: "lucidmotors.com", ticker: "LCID", brand: "#E6E6E6", wash: "#111111", address: "0xb20000000000000000000081050ac3d4395df527" },
  { symbol: "LEUc", name: "Centrus Energy", domain: "centrusenergy.com", ticker: "LEU", brand: "#3FA76B", wash: "#1F6B4A", address: "0xb200000000000000000000fab55ad3773f2c8ef1" },
  { symbol: "LFMDc", name: "LifeMD", domain: "lifemd.com", ticker: "LFMD", brand: "#3FB6A8", wash: "#0B6E66", address: "0xb200000000000000000000db15c02e133a9dab99" },
  { symbol: "LITEc", name: "Lumentum", domain: "lumentum.com", ticker: "LITE", brand: "#2FA84F", address: "0xb200000000000000000000eda6c2c6f11e0f838f" },
  { symbol: "LIc", name: "Li Auto", domain: "lixiang.com", ticker: "LI", brand: "#1FA06F", address: "0xb200000000000000000000d61efd9f54a23ef9eb" },
  { symbol: "LLYc", name: "Eli Lilly", domain: "lilly.com", ticker: "LLY", brand: "#D52B1E", address: "0xb200000000000000000000f1a0f91e34892e4718" },
  { symbol: "LUVc", name: "Southwest Airlines", domain: "southwest.com", ticker: "LUV", brand: "#5B7BE0", wash: "#304CB2", address: "0xb200000000000000000000d5c0393796e92fcab0" },
  { symbol: "LYVc", name: "Live Nation", domain: "livenation.com", ticker: "LYV", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000001347ccd9e83d5bf3e0" },
  { symbol: "MARAc", name: "MARA", domain: "mara.com", ticker: "MARA", brand: "#41D6B4", address: "0xb200000000000000000000a310e034e09186fb2d" },
  { symbol: "MCDc", name: "McDonald's", domain: "mcdonalds.com", ticker: "MCD", brand: "#FFC72C", wash: "#DA291C", address: "0xb200000000000000000000d2f4cf2f7debb244bb" },
  { symbol: "MNSTc", name: "Monster Beverage", domain: "monsterbevcorp.com", ticker: "MNST", brand: "#8DC63F", wash: "#111111", address: "0xb2000000000000000000005bcde0a6926919fef9" },
  { symbol: "MRNAc", name: "Moderna", domain: "modernatx.com", ticker: "MRNA", brand: "#E4173E", address: "0xb200000000000000000000e215e9b76ecba02468" },
  { symbol: "MRVLc", name: "Marvell", domain: "marvell.com", ticker: "MRVL", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000ec3c4c7395cc609813" },
  { symbol: "MSFTc", name: "Microsoft", domain: "microsoft.com", ticker: "MSFT", brand: "#00A4EF", address: "0xb200000000000000000000ab99cfa739e253872b" },
  { symbol: "MSTRc", name: "Strategy", domain: "strategy.com", ticker: "MSTR", brand: "#E8352B", address: "0xb2000000000000000000004884b426556b92883d" },
  { symbol: "MTCHc", name: "Match Group", domain: "mtch.com", ticker: "MTCH", brand: "#5B6CF0", address: "0xb200000000000000000000441ec9266133f611ef" },
  { symbol: "MUc", name: "Micron", domain: "micron.com", ticker: "MU", brand: "#9FC3E6", wash: "#111111", address: "0xb200000000000000000000fd2f87532b90095211" },
  { symbol: "NFLXc", name: "Netflix", domain: "netflix.com", ticker: "NFLX", brand: "#E50914", address: "0xb20000000000000000000058b8c947e44011dfe6" },
  { symbol: "NIOc", name: "NIO", domain: "nio.com", ticker: "NIO", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000002d2b5dc53c61f1ba06" },
  { symbol: "NOKc", name: "Nokia", domain: "nokia.com", ticker: "NOK", brand: "#4F7BF0", wash: "#005AFF", address: "0xb2000000000000000000005ac674f707e357409c" },
  { symbol: "NOWc", name: "ServiceNow", domain: "servicenow.com", ticker: "NOW", brand: "#62D84E", wash: "#032D42", address: "0xb20000000000000000000082cd2c7801305808df" },
  { symbol: "NVAXc", name: "Novavax", domain: "novavax.com", ticker: "NVAX", brand: "#4FC3D0", wash: "#1B1464", address: "0xb200000000000000000000c597c476fcf9aed3a8" },
  { symbol: "NVOc", name: "Novo Nordisk", domain: "novonordisk.com", ticker: "NVO", brand: "#5B6FD6", wash: "#001965", address: "0xb2000000000000000000008d5328e9208773dc58" },
  { symbol: "OKLOc", name: "Oklo", domain: "oklo.com", ticker: "OKLO", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000009188edfd2fcc8cc81e" },
  { symbol: "ONDSc", name: "Ondas", domain: "ondas.com", ticker: "ONDS", brand: "#5B7BE0", wash: "#0B2D6B", address: "0xb200000000000000000000e7137ca231c5e35f25" },
  { symbol: "OPENc", name: "Opendoor", domain: "opendoor.com", ticker: "OPEN", brand: "#3E7FF5", address: "0xb200000000000000000000259694b27bf052e7d7" },
  { symbol: "ORCLc", name: "Oracle", domain: "oracle.com", ticker: "ORCL", brand: "#C74634", address: "0xb200000000000000000000347afba223d7b6b63c" },
  { symbol: "OURAc", name: "Oura", domain: "ouraring.com", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000008536298e05fdfb65f4" },
  { symbol: "PDDc", name: "PDD Holdings", domain: "pddholdings.com", ticker: "PDD", brand: "#E02E24", address: "0xb200000000000000000000c8a7223510467d8563" },
  { symbol: "PFEc", name: "Pfizer", domain: "pfizer.com", ticker: "PFE", brand: "#2F6BFF", address: "0xb20000000000000000000018fe7ec7d6dfeeb528" },
  { symbol: "PLAYc", name: "Dave & Buster's", domain: "daveandbusters.com", ticker: "PLAY", brand: "#F7941D", address: "0xb20000000000000000000087d144f2c70cd1a5f6" },
  { symbol: "PLNTc", name: "Planet Fitness", domain: "planetfitness.com", ticker: "PLNT", brand: "#A05BD6", wash: "#5E2D91", address: "0xb20000000000000000000011b20aebe0bd567f1c" },
  { symbol: "PLTRc", name: "Palantir", domain: "palantir.com", ticker: "PLTR", brand: "#F4F4F5", wash: "#111111", address: "0xb2000000000000000000007d16372840df4dabbe" },
  { symbol: "PLc", name: "Planet Labs", domain: "planet.com", ticker: "PL", brand: "#3FB6A8", address: "0xb200000000000000000000cb6b2f4e33f0471556" },
  { symbol: "PMc", name: "Philip Morris", domain: "pmi.com", ticker: "PM", brand: "#5B8BD6", wash: "#1D4F91", address: "0xb2000000000000000000008fc2a8c23cf5937b66" },
  { symbol: "PTONc", name: "Peloton", domain: "onepeloton.com", ticker: "PTON", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000009272a491812842aa84" },
  { symbol: "PURRc", name: "Hyperliquid Strategies", domain: "hypestrat.xyz", ticker: "PURR", brand: "#4FC9A4", address: "0xb20000000000000000000065ca0f772a5502e976" },
  { symbol: "PYPLc", name: "PayPal", domain: "paypal.com", ticker: "PYPL", brand: "#009CDE", wash: "#003087", address: "0xb200000000000000000000450ad3abe5d4846c6e" },
  { symbol: "PZZAc", name: "Papa John's", domain: "papajohns.com", ticker: "PZZA", brand: "#E31837", address: "0xb20000000000000000000068987dacde1db79cd4" },
  { symbol: "QUBTc", name: "Quantum Computing", domain: "quantumcomputinginc.com", ticker: "QUBT", brand: "#6F7FE0", wash: "#1B2366", address: "0xb200000000000000000000ca425ab42e07c35bc3" },
  { symbol: "RBLXc", name: "Roblox", domain: "roblox.com", ticker: "RBLX", brand: "#E2231A", address: "0xb2000000000000000000005bd7ae89b9e6189bb5" },
  { symbol: "RDDTc", name: "Reddit", domain: "reddit.com", ticker: "RDDT", brand: "#FF4500", address: "0xb20000000000000000000066242d4067724cb7a1" },
  { symbol: "RDWc", name: "Redwire", domain: "redwirespace.com", ticker: "RDW", brand: "#E3262E", address: "0xb200000000000000000000cd7dfaef0423f1f103" },
  { symbol: "RGTIc", name: "Rigetti", domain: "rigetti.com", ticker: "RGTI", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000c22fff2785bb27b39a" },
  { symbol: "RIOTc", name: "Riot Platforms", domain: "riotplatforms.com", ticker: "RIOT", brand: "#F68B1F", address: "0xb200000000000000000000bd0c7627b663c581a6" },
  { symbol: "RIVNc", name: "Rivian", domain: "rivian.com", ticker: "RIVN", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000003e4249c65bd6c037d9" },
  { symbol: "RKLBc", name: "Rocket Lab", domain: "rocketlabcorp.com", ticker: "RKLB", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000e8e50cbbb9a3861a3c" },
  { symbol: "RKTc", name: "Rocket Companies", domain: "rocketcompanies.com", ticker: "RKT", brand: "#D7282F", address: "0xb200000000000000000000000d3176ee4af1102d" },
  { symbol: "ROOTc", name: "Root", domain: "joinroot.com", ticker: "ROOT", brand: "#FF5A3C", address: "0xb2000000000000000000004aa2b559ca0a0bbf5d" },
  { symbol: "RUNc", name: "Sunrun", domain: "sunrun.com", ticker: "RUN", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000b1b9200405fb52a8cf" },
  { symbol: "RXRXc", name: "Recursion", domain: "recursion.com", ticker: "RXRX", brand: "#9B5CF6", address: "0xb200000000000000000000501ef81f911eb57656" },
  { symbol: "SANc", name: "Santander", domain: "santander.com", ticker: "SAN", brand: "#EC0000", address: "0xb20000000000000000000017bb66e9301e913a99" },
  { symbol: "SAPc", name: "SAP", domain: "sap.com", ticker: "SAP", brand: "#2B8FE0", wash: "#0070F2", address: "0xb200000000000000000000da6f64c306234127e0" },
  { symbol: "SBETc", name: "SharpLink", domain: "sharplink.com", ticker: "SBET", brand: "#3E7BE0", address: "0xb200000000000000000000559ec0bedaacf436ea" },
  { symbol: "SEZLc", name: "Sezzle", domain: "sezzle.com", ticker: "SEZL", brand: "#8A6FE8", wash: "#392558", address: "0xb2000000000000000000000c1f8acd3c4496a762" },
  { symbol: "SEc", name: "Sea", domain: "sea.com", ticker: "SE", brand: "#F05A28", address: "0xb2000000000000000000003088798f6d0722aaac" },
  { symbol: "SGc", name: "Sweetgreen", domain: "sweetgreen.com", ticker: "SG", brand: "#D9F46A", wash: "#1F4D2B", address: "0xb200000000000000000000b57f99acec3a7490d0" },
  { symbol: "SHAZc", name: "SharonAI", domain: "sharonai.com", ticker: "SHAZ", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000000d9947c759429e7fe5" },
  { symbol: "SKHYc", name: "SK hynix", domain: "skhynix.com", ticker: "SKHY", brand: "#F2793D", address: "0xb200000000000000000000187f7071d6e321a7d2" },
  { symbol: "SMPLc", name: "Simply Good Foods", domain: "atkins.com", ticker: "SMPL", brand: "#E35A2B", address: "0xb2000000000000000000001409f816682b7772b7" },
  { symbol: "SMRc", name: "NuScale", domain: "nuscalepower.com", ticker: "SMR", brand: "#5F78D8", wash: "#1E2D78", address: "0xb200000000000000000000978546fe604b8dcbc6" },
  { symbol: "SNDKc", name: "SanDisk", domain: "sandisk.com", ticker: "SNDK", brand: "#E5202E", address: "0xb200000000000000000000397293cb8cda9a10c5" },
  { symbol: "SOFIc", name: "SoFi", domain: "sofi.com", ticker: "SOFI", brand: "#26B6E8", address: "0xb2000000000000000000003ef37a7c863dc1482a" },
  { symbol: "SONYc", name: "Sony", domain: "sony.com", ticker: "SONY", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000a26326a922ffa87f6c" },
  { symbol: "SOUNc", name: "SoundHound", domain: "soundhound.com", ticker: "SOUN", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000002137743d4a01fe4e88" },
  { symbol: "STZc", name: "Constellation Brands", domain: "cbrands.com", ticker: "STZ", brand: "#5B7BE0", wash: "#0B2D6B", address: "0xb2000000000000000000001ac12227a8ae0ef3ac" },
  { symbol: "TAPc", name: "Molson Coors", domain: "molsoncoors.com", ticker: "TAP", brand: "#C9A45C", wash: "#1C2C5B", address: "0xb200000000000000000000e0b9460c97f38f412f" },
  { symbol: "TKOc", name: "TKO Group", domain: "tkogrp.com", ticker: "TKO", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000b8f841940325db6b2c" },
  { symbol: "TSLAc", name: "Tesla", domain: "tesla.com", ticker: "TSLA", brand: "#E82127", address: "0xb2000000000000000000001e800a7f5189430cd0" },
  { symbol: "TTDc", name: "The Trade Desk", domain: "thetradedesk.com", ticker: "TTD", brand: "#2EA6E8", wash: "#0099FA", address: "0xb2000000000000000000008baf7bb82e4c37743f" },
  { symbol: "TTWOc", name: "Take-Two", domain: "take2games.com", ticker: "TTWO", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000f720c26062bc3067da" },
  { symbol: "UAAc", name: "Under Armour", domain: "underarmour.com", ticker: "UAA", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000879a74c76c73a27d71" },
  { symbol: "UBERc", name: "Uber", domain: "uber.com", ticker: "UBER", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000cae20cb1446462e24c" },
  { symbol: "ULc", name: "Unilever", domain: "unilever.com", ticker: "UL", brand: "#5B7FE0", wash: "#1F36C7", address: "0xb200000000000000000000349ef3aa93a0897476" },
  { symbol: "UNHc", name: "UnitedHealth", domain: "unitedhealthgroup.com", ticker: "UNH", brand: "#4F7BF0", wash: "#002677", address: "0xb200000000000000000000c367d37d07150182a2" },
  { symbol: "USDEc", name: "StablecoinX", domain: "ir.stablecoinx.com", ticker: "USDE", brand: "#E6E6E6", wash: "#111111", address: "0xb2000000000000000000009426b660396ebcf343" },
  { symbol: "Uc", name: "Unity", domain: "unity.com", ticker: "U", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000902f48cba1f39149f7" },
  { symbol: "VALEc", name: "Vale", domain: "vale.com", ticker: "VALE", brand: "#2BA6A0", wash: "#007E7A", address: "0xb20000000000000000000063376b142c0764b489" },
  { symbol: "VKTXc", name: "Viking Therapeutics", domain: "vikingtherapeutics.com", ticker: "VKTX", brand: "#E8502E", address: "0xb200000000000000000000979ef4dd6a001b58b1" },
  { symbol: "VVVc", name: "Valvoline", domain: "valvoline.com", ticker: "VVV", brand: "#E31937", address: "0xb200000000000000000000fec679b39992f67627" },
  { symbol: "WDCc", name: "Western Digital", domain: "westerndigital.com", ticker: "WDC", brand: "#4A90E2", wash: "#0B3B8C", address: "0xb2000000000000000000008fde21a1f5c69fec0b" },
  { symbol: "WENc", name: "Wendy's", domain: "wendys.com", ticker: "WEN", brand: "#E2203D", address: "0xb20000000000000000000044e3cd7a0e1028e57a" },
  { symbol: "WINGc", name: "Wingstop", domain: "wingstop.com", ticker: "WING", brand: "#2EA36B", wash: "#006938", address: "0xb200000000000000000000281c973bf2555dd94b" },
  { symbol: "WMTc", name: "Walmart", domain: "walmart.com", ticker: "WMT", brand: "#FFC220", wash: "#0071CE", address: "0xb2000000000000000000008a7508619c717a7106" },
  { symbol: "WOLFc", name: "Wolfspeed", domain: "wolfspeed.com", ticker: "WOLF", brand: "#8A6FE8", wash: "#4B2E83", address: "0xb2000000000000000000008df9bc22db1d7da2a5" },
  { symbol: "WRDc", name: "WeRide", domain: "weride.ai", ticker: "WRD", brand: "#3FA9F5", address: "0xb200000000000000000000e88efe88d8ade3f0da" },
  { symbol: "WULFc", name: "TeraWulf", domain: "terawulf.com", ticker: "WULF", brand: "#2E7BE0", address: "0xb200000000000000000000432a1d2bd864acec82" },
  { symbol: "WWc", name: "WW International", domain: "weightwatchers.com", ticker: "WW", brand: "#3348E0", address: "0xb20000000000000000000089221e238277d52515" },
  { symbol: "Wc", name: "Wayfair", domain: "wayfair.com", ticker: "W", brand: "#9B5CC4", wash: "#7F187F", address: "0xb20000000000000000000089bc72c3e637a02adb" },
  { symbol: "XXIc", name: "Twenty One Capital", domain: "xxi.money", ticker: "XXI", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000115bf2283265fb04db" },
  { symbol: "XYZc", name: "Block", domain: "block.xyz", ticker: "XYZ", brand: "#E6E6E6", wash: "#111111", address: "0xb20000000000000000000067c8c151f24e1c9924" },
  { symbol: "YETIc", name: "YETI", domain: "yeti.com", ticker: "YETI", brand: "#E6E6E6", wash: "#111111", address: "0xb200000000000000000000613c15f118df2b189b" },
  { symbol: "YUMc", name: "Yum! Brands", domain: "yum.com", ticker: "YUM", brand: "#E4002B", address: "0xb2000000000000000000005c8324136de0f4134a" },
];

export const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;

const BY_SYMBOL = new Map(stocks.map((s) => [s.symbol.toLowerCase(), s]));
const BY_ADDRESS = new Map(stocks.map((s) => [s.address.toLowerCase(), s]));

export const stockBySymbol = (symbol: string) => BY_SYMBOL.get(symbol.toLowerCase());
export const stockByAddress = (address: string) => BY_ADDRESS.get(address.toLowerCase());
