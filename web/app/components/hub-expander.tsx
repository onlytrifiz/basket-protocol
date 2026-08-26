"use client";

import { useState, type ReactNode } from "react";

/**
 * The fold under the hub table's minted rows.
 *
 * Most B20s exist as an address and nothing else, and thirteen rows of "not issued" were burying
 * the four the page is actually about — plus everything below the table, which nobody reached.
 * The unminted rows stay in the document exactly as the server rendered them (they arrive here as
 * `children`, so this component knows nothing about what a row is); this is only the hinge.
 *
 * A button, not a link: the fold is view state, not an address. Collapsing again keeps the reader
 * where they are rather than snapping to an anchor.
 */
export function HubExpander({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && children}
      <button aria-expanded={open} className="hub-more" onClick={() => setOpen((o) => !o)} type="button">
        {open ? "Hide" : "Show"} {count} not-yet-minted stock{count === 1 ? "" : "s"}
        <i aria-hidden="true">{open ? "↑" : "↓"}</i>
      </button>
    </>
  );
}
