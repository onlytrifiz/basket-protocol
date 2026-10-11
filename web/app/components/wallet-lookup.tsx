"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useWallet } from "./wallet";

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

/**
 * Paste an address, or use the connected one. Either way the address goes into the URL, so a recap
 * is a link someone can send, and the page reads it on the server.
 */
export function WalletLookup({ initial }: { initial?: string }) {
  const router = useRouter();
  const { account, connect, isConnecting } = useWallet();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  const open = (address: string) => {
    if (!isAddress(address)) {
      setError("That is not a wallet address. It starts with 0x and has 42 characters.");
      return;
    }
    setError(null);
    router.push(`/wallet?address=${address.trim().toLowerCase()}`);
  };

  const useMine = async () => {
    try {
      const address = account ?? await connect();
      setValue(address);
      open(address);
    } catch {
      setError("The wallet did not connect.");
    }
  };

  return (
    <form
      className="wallet-lookup"
      onSubmit={(event) => { event.preventDefault(); open(value); }}
    >
      <label className="sr-only" htmlFor="wallet-address">Wallet address</label>
      <input
        autoComplete="off"
        id="wallet-address"
        inputMode="text"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste a wallet address, 0x…"
        spellCheck={false}
        value={value}
      />
      <button className="button button-ink" type="submit">Show payouts</button>
      <button className="button button-ghost" disabled={isConnecting} onClick={useMine} type="button">
        {isConnecting ? "Connecting" : account ? "Use my wallet" : "Connect wallet"}
      </button>
      {error && <p className="wallet-lookup-error" role="alert">{error}</p>}
    </form>
  );
}
