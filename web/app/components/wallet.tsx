"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * One wallet connection, shared by the header and the swap card.
 *
 * Deliberately built on the EIP-1193 dialect rather than wagmi/RainbowKit: the panels already spoke
 * it, the site ships no other web3 surface, and a connector library would add a dependency tree
 * heavier than the whole app for a single button.
 *
 * Two sources speak it. A browser extension or a wallet's in-app browser injects `window.ethereum`;
 * everywhere else — Safari or Chrome on a phone above all — WalletConnect (Reown) opens the wallet
 * list and deeplinks into the installed app. Its provider is EIP-1193 too, so the panels never know
 * which one they are talking to.
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

export const BASE_CHAIN_HEX = "0x2105";
const BASE_CHAIN_ID = 8453;

/**
 * A public identifier for the WalletConnect relay, not a secret. Optional on purpose: without it the
 * site degrades to injected wallets instead of failing, so a preview without the env var still works.
 */
const REOWN_PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
const SESSION_KEY = "stfy-wallet";

type WalletConnectProvider = Eip1193Provider & {
  accounts: string[];
  session?: unknown;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

let walletConnectPromise: Promise<WalletConnectProvider> | null = null;

/**
 * The WalletConnect provider, created on first use.
 *
 * Imported lazily for two reasons. Its modal is heavy and nobody with an extension needs it. And it
 * throws while constructing when the project id is missing or rejected: inside a dynamic import that
 * is one failed connect, where at module scope it would blank every page.
 */
function walletConnect(): Promise<WalletConnectProvider> | null {
  if (!REOWN_PROJECT_ID) return null;
  walletConnectPromise ??= import("@walletconnect/ethereum-provider")
    .then(({ EthereumProvider }) => EthereumProvider.init({
      projectId: REOWN_PROJECT_ID,
      chains: [BASE_CHAIN_ID],
      showQrModal: true,
      qrModalOptions: {
        themeMode: document.documentElement.dataset.theme === "light" ? "light" : "dark",
        themeVariables: { "--wcm-z-index": "1000" },
      },
      metadata: {
        name: "Stockify",
        description: "Hold STFY, receive tokenized stocks.",
        url: window.location.origin,
        icons: [`${window.location.origin}/icon.png`],
      },
    }) as unknown as Promise<WalletConnectProvider>)
    .catch((error) => {
      walletConnectPromise = null;
      throw error;
    });
  return walletConnectPromise;
}

const isBase = (chainId: unknown) => Number(chainId) === BASE_CHAIN_ID;

/**
 * The provider every panel receives, with the chain enforced at the one place all signing passes.
 *
 * Most panels call `ensureBase` before sending, but not all of them did, and a new one will forget.
 * So every `eth_sendTransaction` is held here until the wallet is on Base, and carries `chainId` so
 * a wallet that changes network between the check and the signature refuses rather than signs.
 */
function guarded(inner: Eip1193Provider): Eip1193Provider {
  return {
    on: inner.on?.bind(inner),
    removeListener: inner.removeListener?.bind(inner),
    request: async (args) => {
      if (args.method !== "eth_sendTransaction") return inner.request(args);
      await ensureBase(inner);
      const [tx, ...rest] = (args.params ?? []) as Array<Record<string, unknown>>;
      return inner.request({ method: args.method, params: [{ ...tx, chainId: BASE_CHAIN_HEX }, ...rest] });
    },
  };
}

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

/**
 * Put the wallet on Base, and confirm it is there.
 *
 * EXPORTED BECAUSE CONNECTING IS NOT THE ONLY MOMENT THIS MATTERS. A wallet can be moved to another
 * chain at any point after connecting — the site is never told, because nothing here listens for
 * `chainChanged` — and every transaction this app builds is Base calldata: a router address, a pool
 * key, an aggregator route. Sent on Ethereum mainnet that is not a failed trade, it is a call to
 * whatever happens to live at that address there. So the panels call this immediately before
 * `eth_sendTransaction` rather than trusting the state left behind by `connect()`.
 *
 * Cheap to repeat: on the ordinary path it is one `eth_chainId` and no prompt.
 */
export async function ensureBase(provider: Eip1193Provider) {
  // Compared as a number: injected wallets answer in hex, WalletConnect's provider in decimal.
  if (isBase(await provider.request({ method: "eth_chainId" }))) return;
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

  // Asked again, because neither call above promises the switch actually happened: some wallets
  // resolve `wallet_addEthereumChain` having only ADDED the chain, and a user can dismiss the
  // prompt without the request rejecting. Returning here on the strength of a resolved promise is
  // how a Base transaction gets signed on another chain.
  if (!isBase(await provider.request({ method: "eth_chainId" }))) {
    throw new Error("Switch your wallet to Base to continue.");
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string>();
  const [isConnecting, setIsConnecting] = useState(false);
  // The WalletConnect session, when that is how this visitor connected; otherwise the injected one.
  const remote = useRef<WalletConnectProvider | null>(null);

  const follow = useCallback((source: Eip1193Provider) => {
    const onAccountsChanged = (...args: never[]) => setAccount((args[0] as unknown as string[])?.[0]);
    const onDisconnect = () => {
      if (source !== remote.current) return;
      remote.current = null;
      try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
      setAccount(undefined);
    };
    source.on?.("accountsChanged", onAccountsChanged);
    source.on?.("disconnect", onDisconnect);
    return () => {
      source.removeListener?.("accountsChanged", onAccountsChanged);
      source.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  // Restore an existing authorisation without prompting: eth_accounts never opens the wallet, and a
  // WalletConnect session is only revived when this browser made one, so nobody else pays its import.
  useEffect(() => {
    let cancelled = false;
    let unfollow: (() => void) | undefined;
    let usedRemote = false;
    try { usedRemote = localStorage.getItem(SESSION_KEY) === "walletconnect"; } catch { /* storage blocked */ }

    if (usedRemote) {
      walletConnect()?.then((wc) => {
        if (cancelled || !wc.session || !wc.accounts[0]) return;
        remote.current = wc;
        setAccount(wc.accounts[0]);
        unfollow = follow(wc);
      }).catch(() => undefined);
    } else if (window.ethereum) {
      const injected = window.ethereum;
      injected.request({ method: "eth_accounts" })
        .then((accounts) => { if (!cancelled) setAccount((accounts as string[])[0]); })
        .catch(() => undefined);
      unfollow = follow(injected);
    }
    return () => { cancelled = true; unfollow?.(); };
  }, [follow]);

  const provider = useCallback(() => {
    const source = remote.current ?? window.ethereum;
    if (!source) throw new Error("Connect a wallet to continue.");
    return guarded(source);
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const injected = window.ethereum;
      if (injected) {
        await ensureBase(injected);
        const accounts = await injected.request({ method: "eth_requestAccounts" }) as string[];
        const next = accounts[0];
        if (!next) throw new Error("No wallet account was selected.");
        setAccount(next);
        return next;
      }

      const pending = walletConnect();
      if (!pending) throw new Error("Install a wallet such as Coinbase Wallet or MetaMask to trade.");
      const wc = await pending;
      // Base is the session's only required chain, so a wallet cannot approve it on another network.
      if (!wc.session) await wc.connect();
      const next = wc.accounts[0];
      if (!next) throw new Error("No wallet account was selected.");
      await ensureBase(wc);
      remote.current = wc;
      follow(wc);
      try { localStorage.setItem(SESSION_KEY, "walletconnect"); } catch { /* storage blocked */ }
      setAccount(next);
      return next;
    } finally {
      setIsConnecting(false);
    }
  }, [follow]);

  /**
   * EIP-1193 HAS NO DISCONNECT. A dapp cannot revoke its own access; the closest thing is
   * `wallet_revokePermissions`, which MetaMask supports and most wallets do not. So this asks, and
   * clears local state either way — from the site's point of view the session is over, and a
   * "Disconnect" that silently did nothing would be worse than one that only forgets.
   * A WalletConnect session is the exception: it can be ended from this side, and is.
   */
  const disconnect = useCallback(async () => {
    const wc = remote.current;
    try {
      if (wc) {
        remote.current = null;
        try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
        await wc.disconnect();
      } else {
        await window.ethereum?.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      }
    } catch {
      // Unsupported or refused: local state is still cleared below.
    }
    setAccount(undefined);
  }, []);

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
