"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * One wallet connection, shared by the header and the swap card.
 *
 * Deliberately built on the injected EIP-1193 provider rather than wagmi/RainbowKit: the panel
 * already spoke this dialect, the site ships no other web3 surface, and a connector library would
 * add a dependency tree heavier than the whole app for a single button.
 */

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

const BASE_CHAIN_HEX = "0x2105";

type WalletState = {
  account?: string;
  isConnecting: boolean;
  connect: () => Promise<string>;
  provider: () => Eip1193Provider;
};

const WalletContext = createContext<WalletState | undefined>(undefined);

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}

export const truncateAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

async function ensureBase(provider: Eip1193Provider) {
  if (await provider.request({ method: "eth_chainId" }) === BASE_CHAIN_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (error) {
    // 4902 is "chain unknown to this wallet" — the only case worth recovering from.
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        blockExplorerUrls: ["https://basescan.org"],
        chainId: BASE_CHAIN_HEX,
        chainName: "Base Mainnet",
        nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
        rpcUrls: ["https://mainnet.base.org"],
      }],
    });
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string>();
  const [isConnecting, setIsConnecting] = useState(false);

  // Restore an existing authorisation without prompting: eth_accounts never opens the wallet.
  useEffect(() => {
    const injected = window.ethereum;
    if (!injected) return;
    injected.request({ method: "eth_accounts" })
      .then((accounts) => setAccount((accounts as string[])[0]))
      .catch(() => undefined);

    const onAccountsChanged = (...args: never[]) => setAccount((args[0] as unknown as string[])?.[0]);
    injected.on?.("accountsChanged", onAccountsChanged);
    return () => injected.removeListener?.("accountsChanged", onAccountsChanged);
  }, []);

  const provider = useCallback(() => {
    const injected = window.ethereum;
    if (!injected) throw new Error("Install a wallet such as Coinbase Wallet or MetaMask to trade.");
    return injected;
  }, []);

  const connect = useCallback(async () => {
    const injected = provider();
    setIsConnecting(true);
    try {
      await ensureBase(injected);
      const accounts = await injected.request({ method: "eth_requestAccounts" }) as string[];
      const next = accounts[0];
      if (!next) throw new Error("No wallet account was selected.");
      setAccount(next);
      return next;
    } finally {
      setIsConnecting(false);
    }
  }, [provider]);

  const value = useMemo(() => ({ account, connect, isConnecting, provider }), [account, connect, isConnecting, provider]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Header affordance: connects, then shows the connected address. */
export function ConnectWalletButton() {
  const { account, connect, isConnecting } = useWallet();
  const [error, setError] = useState<string>();

  if (account) {
    return <span className="wallet-pill is-connected" title={account}><i />{truncateAddress(account)}</span>;
  }
  return (
    <button
      className="wallet-pill"
      disabled={isConnecting}
      onClick={() => { setError(undefined); connect().catch((e) => setError(e instanceof Error ? e.message : "Connection failed")); }}
      title={error}
      type="button"
    >
      {isConnecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
