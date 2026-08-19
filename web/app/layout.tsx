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

export const metadata: Metadata = {
  metadataBase: new URL("https://stockify.finance"),
  title: {
    default: "Stockify — Stock dividend protocol",
    template: "%s",
  },
  description: "Stock dividend protocol for Coinbase L2’s tokenized stocks.",
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
