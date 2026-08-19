import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "./components/wallet";

/* Schibsted Grotesk is variable (400–900): next/font resolves the axis itself,
   so no weight list is passed. IBM Plex Mono ships static cuts and needs one. */
const ui = Schibsted_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-mono",
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#071229" },
  ],
};

/* Applied before first paint so a stored theme never flashes the other palette. */
const themeBoot = `(function(){try{var t=localStorage.getItem("stfy-theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body><WalletProvider>{children}</WalletProvider></body>
    </html>
  );
}
