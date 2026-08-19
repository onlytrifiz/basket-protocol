import Link from "next/link";

/**
 * A link to the updates channel, shown only when there is one to link to.
 *
 * Gated on `NEXT_PUBLIC_TELEGRAM_URL` rather than shipped with a guessed handle: `t.me/<something>`
 * that we did not verify either 404s or, worse, resolves to a channel belonging to someone else,
 * and a header pill is the most trusted link on the page. No URL configured, no pill.
 */
export function UpdatesPill() {
  const href = process.env.NEXT_PUBLIC_TELEGRAM_URL;
  if (!href) return null;

  return (
    <Link className="updates-pill" href={href} rel="noreferrer" target="_blank">
      <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <circle cx="12" cy="12" r="12" fill="#229ED9" />
        <path
          d="M5.5 11.7l11-4.24c.51-.19.96.12.79.9l-1.87 8.82c-.14.63-.52.79-1.05.49l-2.9-2.14-1.4 1.35c-.16.15-.29.29-.58.29l.2-2.95 5.38-4.86c.23-.2-.05-.32-.36-.12l-6.65 4.19-2.87-.9c-.62-.2-.63-.62.13-.92z"
          fill="#fff"
        />
      </svg>
      <span>Receive updates about new B20 stocks, mint &amp; burns</span>
      <b aria-hidden="true">→</b>
    </Link>
  );
}
