"use client";

/**
 * The three calls anyone may make on an index.
 *
 * Collecting, burning and paying the creator all have a single fixed destination and cannot be
 * pointed anywhere, which is why they are open to everyone — and why exposing them here costs
 * nothing and removes a liveness dependency on our keeper. If the keeper is down, a holder can still
 * make an index collect.
 */

import { useState } from "react";

import { useWallet } from "./wallet";

const SELECTORS = {
  harvest: "0x4641257d",
  burn: "0x44df8e70",
  claimCreator: "0x232adc65",
} as const;

type Action = keyof typeof SELECTORS;

export function IndexActions({ address, buyback }: { address: string; buyback: boolean }) {
  const { account, connect, provider, isConnecting } = useWallet();
  const [busy, setBusy] = useState<Action | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action) {
    setError(null);
    setHash(null);
    try {
      const from = account ?? (await connect());
      setBusy(action);
      const tx = (await provider().request({
        method: "eth_sendTransaction",
        params: [{ from, to: address, data: SELECTORS[action] }],
      })) as string;
      setHash(tx);
    } catch (e) {
      // Reverts here are ordinary, not faults: an index with nothing to collect says so, and a burn
      // with nothing bought says so. Showing the reason beats a spinner that stops.
      const message = (e as { message?: string })?.message ?? "The wallet refused the transaction.";
      setError(message.split("\n")[0]);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="index-actions">
      <button disabled={!!busy || isConnecting} onClick={() => run("harvest")} type="button">
        {busy === "harvest" ? "Confirm…" : "Collect fees"}
      </button>
      {buyback && (
        <button disabled={!!busy || isConnecting} onClick={() => run("burn")} type="button">
          {busy === "burn" ? "Confirm…" : "Burn what it bought"}
        </button>
      )}
      <button disabled={!!busy || isConnecting} onClick={() => run("claimCreator")} type="button">
        {busy === "claimCreator" ? "Confirm…" : "Pay the creator"}
      </button>

      {hash && (
        <a href={`https://basescan.org/tx/${hash}`} rel="noreferrer" target="_blank">
          Sent ↗
        </a>
      )}
      {error && <span className="index-actions-error">{error}</span>}
    </div>
  );
}
