"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { COUNTRIES, COUNTRY_COOKIE, countryFlag } from "../../../lib/shop/countries";

/**
 * The shop's own row, under the site nav.
 *
 * The nav above answers "which product am I in". This answers "where in the
 * shop", and it carries the country control because that changes what is on
 * sale rather than where you are — a card bought for the wrong country does
 * not redeem, so it is a purchase decision, not a preference.
 */
export function ShopBar({
  country,
}: {
  /** What the server resolved: an explicit cookie, or a guess from the IP. */
  country: string;
}) {
  // Read from the path rather than passed down: the bar lives in the layout,
  // which every page renders through and none of them can pass props to.
  const path = usePathname() ?? "";
  const on = (href: string) => (path === href || path.startsWith(`${href}/`) ? "on" : "");

  return (
    <div className="sh-bar">
      <SearchBar countryCode={country} />
      <nav className="sh-bar-links">
        <a className={on("/shop/brands")} href="/shop/brands">All brands</a>
        <a className={on("/shop/esim")} href="/shop/esim">eSIM</a>
        {/* The two things sold here that are not a gift card get named, because
            nobody browsing a wall of brand tiles would guess either is on it. */}
        <a className={on("/shop/topups")} href="/shop/topups">Top-ups</a>
        <a className={on("/shop/order")} href="/shop/order">Track order</a>
      </nav>
      <CountryPicker resolved={country} />
    </div>
  );
}

/* ── search ──────────────────────────────────────────────────────────────── */

type Hit = { slug: string; name: string; logo: string; bgColor?: string; minLabel?: string; maxLabel?: string };

function SearchBar({ countryCode }: { countryCode: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  // Searched on the server: 500+ brands is not a payload to hand a browser so
  // it can filter them itself.
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const id = ++requestId.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/shop/search?q=${encodeURIComponent(q)}&country=${countryCode}`);
        const data = await res.json();
        if (id === requestId.current) { setHits(data.results ?? []); setActive(-1); }
      } catch { /* a failed lookup just shows nothing */ }
    }, 180);
    return () => clearTimeout(t);
  }, [q, countryCode]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || !hits.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % hits.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + hits.length) % hits.length); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active] ?? hits[0];
      if (hit) { setOpen(false); router.push(`/shop/b/${hit.slug}`); }
    } else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div className="sh-search" ref={box}>
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="9" cy="9" r="6" />
        <path d="M14 14l4 4" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="Search 2,000+ brands"
        aria-label="Search brands"
      />
      {open && hits.length > 0 && (
        <ul className="sh-hits">
          {hits.map((h, i) => (
            <li key={h.slug}>
              <a className={`sh-hit${i === active ? " on" : ""}`} href={`/shop/b/${h.slug}`} onClick={() => setOpen(false)}>
                <span className="art" style={{ backgroundColor: h.bgColor || "var(--card)" }}>
                  {h.logo && <img src={h.logo} alt="" />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="nm">{h.name}</span>
                  {h.minLabel && h.maxLabel && <span className="rg">{h.minLabel} – {h.maxLabel}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── country ─────────────────────────────────────────────────────────────── */

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie.split("; ").find((row) => row.startsWith(`${name}=`))?.split("=")[1];
}

/** Countries most shoppers pick, floated to the top of an unfiltered list. */
const PINNED = ["US", "GB", "IT", "DE", "FR", "ES", "NL", "CA", "AU"];

function CountryPicker({ resolved }: { resolved: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [country, setCountry] = useState(resolved);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Only syncs the first render with a cookie the server may not have seen.
  useEffect(() => {
    const stored = readCookie(COUNTRY_COOKIE);
    if (stored && stored !== country) setCountry(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const pinned = PINNED.map((code) => COUNTRIES.find((c) => c.code === code)).filter(
        (c): c is (typeof COUNTRIES)[number] => Boolean(c),
      );
      return [...pinned, ...COUNTRIES.filter((c) => !PINNED.includes(c.code))];
    }
    // Name-prefix first, then code, then anywhere in the name.
    const starts: typeof COUNTRIES = [], codes: typeof COUNTRIES = [], contains: typeof COUNTRIES = [];
    for (const c of COUNTRIES) {
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) starts.push(c);
      else if (c.code.toLowerCase() === q) codes.push(c);
      else if (name.includes(q)) contains.push(c);
    }
    return [...starts, ...codes, ...contains];
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    const index = results.findIndex((c) => c.code === country);
    setActive(query ? 0 : index < 0 ? 0 : index);
  }, [results, country, query]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelectorAll("li")[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(next: string) {
    setCountry(next);
    setOpen(false);
    document.cookie = `${COUNTRY_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (results.length ? (i + 1) % results.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const pick = results[active]; if (pick) choose(pick.code); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }

  const label = COUNTRIES.find((c) => c.code === country)?.name ?? country;

  return (
    <div className="sh-country" ref={box}>
      <button
        type="button"
        className="sh-country-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Delivery country: ${label}`}
      >
        <span aria-hidden>{countryFlag(country)}</span>
        {/* The full name on anything wider than a phone, where it is worth the
            room: this control changes what is on sale, and "IT" alone is a
            weaker warning than "Italy". On a phone the name and the section
            links do not both fit, and the links win — the code still tells you
            which catalogue you are in. */}
        <span className="nm">{label}</span>
        <span className="cd">{country}</span>
        <svg className={`chev${open ? " up" : ""}`} width="11" height="7" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M1 1l5 5 5-5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="sh-country-pop">
          <div className="filter">
            <input
              ref={input}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search countries"
              aria-label="Search countries"
            />
          </div>
          {results.length === 0 ? (
            <p className="sh-empty">No country matches that.</p>
          ) : (
            <ul className="sh-country-list" ref={list} role="listbox" aria-label="Delivery country">
              {results.map((c, i) => (
                <li key={c.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={c.code === country}
                    onClick={() => choose(c.code)}
                    onMouseEnter={() => setActive(i)}
                    className={`${i === active ? "on" : ""}${c.code === country ? " picked" : ""}`}
                  >
                    <span aria-hidden>{countryFlag(c.code)}</span>
                    <span className="nm">{c.name}</span>
                    <span className="code">{c.code}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
