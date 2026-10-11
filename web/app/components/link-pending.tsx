"use client";

import { useLinkStatus } from "next/link";

/**
 * Lights the link that was just pressed while its page is on the way. Most of the time the
 * prefetched loading page appears at once and this never shows; it is for the first tap on a slow
 * connection, before that prefetch has landed, when the link would otherwise look dead.
 * Delayed in CSS by 120ms, so a fast navigation never flickers it.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return <i aria-hidden="true" className={`link-pending${pending ? " is-pending" : ""}`} />;
}
