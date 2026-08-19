import Link from "next/link";

/**
 * A link to the updates channel.
 *
 * The handle is a default here rather than env-only because `.env.local` is gitignored: configured
 * there, the pill would work locally and quietly vanish in production. It is not a secret, and it
 * was verified before being hardcoded — t.me answers 200 with "Base Stocks Alerts · Powered by
 * Stockify", which matters because a header pill is the most trusted link on the page and an
 * unchecked t.me handle can resolve to a channel belonging to someone else entirely.
 *
 * `NEXT_PUBLIC_TELEGRAM_URL` still overrides, and setting it empty removes the pill.
 */
const DEFAULT_CHANNEL = "https://t.me/basestocksalerts";

export function UpdatesPill() {
  const href = process.env.NEXT_PUBLIC_TELEGRAM_URL ?? DEFAULT_CHANNEL;
  if (!href) return null;

  return (
    <Link className="updates-pill" href={href} rel="noreferrer" target="_blank">
      {/* On a filled Telegram-blue pill the mark is knocked out white rather than drawn on its own
          disc — a blue circle on a blue field reads as a smudge. */}
      <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
        <path
          d="M3.6 11.4l16.2-6.24c.75-.28 1.41.18 1.16 1.33l-2.75 12.98c-.21.93-.77 1.16-1.55.72l-4.27-3.15-2.06 1.99c-.23.23-.43.43-.86.43l.3-4.35 7.92-7.15c.34-.3-.08-.47-.53-.18l-9.79 6.17-4.22-1.32c-.92-.29-.94-.92.2-1.36z"
          fill="#fff"
        />
      </svg>
      <span>Receive updates about new B20 stocks, mint &amp; burns</span>
      <b aria-hidden="true">→</b>
    </Link>
  );
}
