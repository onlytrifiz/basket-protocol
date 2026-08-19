"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

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
  disconnect: () => Promise<void>;
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

  /**
   * EIP-1193 HAS NO DISCONNECT. A dapp cannot revoke its own access; the closest thing is
   * `wallet_revokePermissions`, which MetaMask supports and most wallets do not. So this asks, and
   * clears local state either way — from the site's point of view the session is over, and a
   * "Disconnect" that silently did nothing would be worse than one that only forgets.
   */
  const disconnect = useCallback(async () => {
    try {
      await provider().request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Unsupported or refused: local state is still cleared below.
    }
    setAccount(undefined);
  }, [provider]);

  const value = useMemo(
    () => ({ account, connect, disconnect, isConnecting, provider }),
    [account, connect, disconnect, isConnecting, provider],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function WalletGlyph() {
  return (
    <svg aria-hidden="true" className="wallet-glyph" viewBox="0 0 20 20" focusable="false">
      <path
        d="M3 6.2A2.2 2.2 0 0 1 5.2 4h9.1a1.7 1.7 0 0 1 1.7 1.7V7"
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
      <rect x="3" y="6.2" width="14" height="9.8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13.6" cy="11.1" r="1.15" fill="currentColor" />
    </svg>
  );
}

/**
 * Header affordance: connects, then becomes a menu.
 *
 * Connected, it used to be an inert `<span>` — an address and a status dot with nothing to do. The
 * two things a connected visitor actually wants from it are the balance they are about to spend and
 * a way out, so it is a button now, and the balance is read only while the menu is open rather than
 * polled by every page.
 */
export function ConnectWalletButton() {
  const { account, connect, disconnect, isConnecting, provider } = useWallet();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string>();
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // A menu that survives a click elsewhere, or Escape, is a menu people get stuck in.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !account) return;
    let cancelled = false;
    provider()
      .request({ method: "eth_getBalance", params: [account, "latest"] })
      .then((raw) => {
        if (cancelled || typeof raw !== "string") return;
        setBalance((Number(BigInt(raw)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 }));
      })
      .catch(() => { if (!cancelled) setBalance(undefined); });
    return () => { cancelled = true; };
  }, [open, account, provider]);

  if (!account) {
    return (
      <button
        className="wallet-pill"
        disabled={isConnecting}
        onClick={() => { setError(undefined); connect().catch((e) => setError(e instanceof Error ? e.message : "Connection failed")); }}
        title={error}
        type="button"
      >
        <WalletGlyph />
        {isConnecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className="wallet-menu" ref={box}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="wallet-pill is-connected"
        onClick={() => setOpen((value) => !value)}
        title={account}
        type="button"
      >
        <WalletGlyph />
        {truncateAddress(account)}
        <svg aria-hidden="true" className="wallet-caret" viewBox="0 0 10 6" focusable="false">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </svg>
      </button>

      {open && (
        <div className="wallet-drop" role="menu">
          <div className="wallet-drop-head">
            <span>Balance</span>
            <b>{balance === undefined ? "…" : `${balance} ETH`}</b>
          </div>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(account).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }).catch(() => undefined);
            }}
            role="menuitem"
            type="button"
          >
            {copied ? "Address copied" : "Copy address"}
          </button>
          <a href={`https://basescan.org/address/${account}`} rel="noreferrer" role="menuitem" target="_blank">
            View on Basescan ↗
          </a>
          <button
            className="is-danger"
            onClick={() => { setOpen(false); void disconnect(); }}
            role="menuitem"
            type="button"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
