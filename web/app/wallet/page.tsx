import { redirect } from "next/navigation";

/**
 * The wallet checker lives on /dividends now. Old links to /wallet, with or without an address,
 * land on the same recap there.
 */
export default async function WalletPage({ searchParams }: PageProps<"/wallet">) {
  const raw = (await searchParams).address;
  const address = typeof raw === "string" && /^0x[a-fA-F0-9]{40}$/.test(raw) ? raw.toLowerCase() : null;
  redirect(address ? `/dividends?wallet=${address}#wallet` : "/dividends#wallet");
}
