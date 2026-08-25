import "server-only";

import { dialCode } from "./countries";

/**
 * The supplier attributes orders using the end user's IP and user agent, so we
 * forward the real buyer's context rather than our server's.
 */
export function endUserContext(req: Request) {
  const h = req.headers;
  const forwarded = h.get("x-forwarded-for");
  const ip =
    forwarded?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip") ||
    undefined;
  return {
    endUserIp: ip,
    endUserAgent: h.get("user-agent") ?? undefined,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL.test(value.trim());
}

/**
 * The supplier only accepts E.164 for top-ups — a leading `+`, country code,
 * digits, no spaces or punctuation. Anything else comes back as
 * "The format of the given phone number is not valid".
 */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Well-formed E.164, ignoring which country it belongs to. */
export function isPhoneShape(value: unknown): value is string {
  return typeof value === "string" && E164.test(value.trim());
}

/**
 * A number that can actually receive this top-up.
 *
 * E.164 shape alone is not enough, and neither is "starts with some known dial
 * code": a real order went out to "+3290626384", an Italian number missing its
 * 39, which reads as a valid Belgian number. What makes it wrong is the
 * mismatch with the product — a WindTre Italy top-up only credits an Italian
 * number, and a direct top-up cannot be reversed once sent.
 */
export function isPhoneForCountry(
  value: unknown,
  countryCode: string,
): value is string {
  if (!isPhoneShape(value)) return false;
  const dial = dialCode(countryCode);
  const trimmed = (value as string).trim();
  return trimmed.startsWith(dial) && trimmed.length > dial.length;
}

/** Strips formatting a shopper is likely to paste, without inventing a prefix. */
export function normalisePhone(value: string): string {
  const trimmed = value.trim().replace(/[\s()\-.]/g, "");
  return trimmed.startsWith("00") ? `+${trimmed.slice(2)}` : trimmed;
}

export function jsonError(message: string, status = 400, extra?: unknown) {
  return Response.json({ error: message, details: extra }, { status });
}
