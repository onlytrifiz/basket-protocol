"use client";

/**
 * Theme is applied to <html data-theme> before first paint by the boot script
 * in layout.tsx. Both icons are rendered and swapped in CSS from that same
 * attribute, so the button never disagrees with the painted theme on hydration.
 */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme")
      ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("stfy-theme", next);
    } catch {
      /* private mode: the choice simply does not persist */
    }
  }

  return (
    <button aria-label="Switch colour theme" className="theme-toggle" onClick={toggle} type="button">
      <svg className="icon-to-dark" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
        <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z" strokeLinejoin="round" />
      </svg>
      <svg className="icon-to-light" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.4v2.2M12 19.4v2.2M4.2 12H2M22 12h-2.2M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6" strokeLinecap="round" />
      </svg>
    </button>
  );
}
