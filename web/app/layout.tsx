import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import "./globals.css";
import "./v2.css";
import { WalletProvider } from "./components/wallet";

/* Three families, each with one job. Bricolage Grotesque sets the headlines (its optical-size axis
   tightens it at display sizes); Geist carries every running line of UI; Geist Mono carries every
   figure. All three are variable, so next/font resolves the weight axis itself. */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

const ui = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

/* The Stonks Exchange's own wordmark face, used only for its name on the hero card. Not preloaded:
   it is one short word on one card, and every other page would pay for it. */
const pixel = Press_Start_2P({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  preload: false,
  variable: "--font-pixel",
});

const TITLE = "Stockify — Stock dividend protocol";
const DESCRIPTION = "Stock dividend protocol for Coinbase L2’s tokenized stocks.";

/**
 * `metadataBase` is what makes every relative image URL below absolute. Social scrapers do not
 * resolve relative paths — they fetch the tag verbatim — so without it the cards silently ship a
 * broken image rather than an error anyone would notice locally.
 *
 * The card image itself is NOT configured here: `app/opengraph-image.png` and `app/twitter-image.png`
 * are file conventions, so Next emits the og:image and twitter:image tags — with the right type,
 * width and height read off the file — as soon as those files exist. A per-page image works the same
 * way, by dropping one into that route's folder.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://stockify.finance"),
  title: {
    default: TITLE,
    template: "%s",
  },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Stockify",
    url: "/",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    // Upgraded from the default small square: the hub's whole point is a wide table of figures, and
    // a summary card crops it to a thumbnail.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  // Lets the mobile bottom bar sit above the home indicator via env(safe-area-inset-bottom).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#050a16" },
  ],
};

/* THE THEME FOLLOWS THE READER'S SYSTEM. Run before first paint, so no palette flashes:
   - a choice made with the toggle (`stfy-theme`) wins;
   - otherwise the OS preference decides, and keeps deciding: a system that switches to dark at
     sunset switches the open page with it.
   The server renders dark, the default for a reader whose browser reports no preference. */
const themeBoot = `(function(){try{var d=document.documentElement,m=window.matchMedia("(prefers-color-scheme: dark)"),k="stfy-theme";var s=function(){var t=null;try{t=localStorage.getItem(k)}catch(e){}d.setAttribute("data-theme",t==="dark"||t==="light"?t:(m.matches?"dark":"light"))};s();m.addEventListener("change",function(){var t=null;try{t=localStorage.getItem(k)}catch(e){}if(t!=="dark"&&t!=="light")s()})}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable} ${pixel.variable}`} data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body><WalletProvider>{children}</WalletProvider></body>
    </html>
  );
}
