"use client";

import { usePathname } from "next/navigation";

import { PageSkeleton } from "./components/page-skeleton";

/**
 * The instant page for every route that waits on chain reads. One boundary at the root, choosing the
 * outline from the address, so a route added later is covered without a file of its own.
 */
export default function Loading() {
  const path = usePathname() ?? "/";
  if (path === "/") return <PageSkeleton active="home" body="hero" />;
  if (/^\/stocks\/[^/]+/.test(path)) return <PageSkeleton active="stocks" body="detail" />;
  if (path.startsWith("/stocks")) return <PageSkeleton active="stocks" body="table" />;
  if (path.startsWith("/dividends")) return <PageSkeleton active="dividends" body="cards" />;
  if (path.startsWith("/indices")) return <PageSkeleton active="indices" body="cards" />;
  if (path.startsWith("/shop")) return <PageSkeleton active="shop" body="cards" />;
  if (path.startsWith("/docs")) return <PageSkeleton active="docs" body="table" />;
  return <PageSkeleton body="table" />;
}
