import { COUNTRIES, countryFlag } from "./countries";

/**
 * Destinations the supplier actually sells eSIM data plans for, verified by
 * probing every country in the catalogue: 104 of 232 have plans.
 *
 * This is the *travel* destination and is deliberately independent of the
 * storefront country — you buy a Japan eSIM while shopping from Italy. Plans
 * and prices differ per destination, so the page still re-checks with the
 * supplier before offering anything.
 */
const ESIM_COUNTRY_CODES = [
  "AL",
  "DZ",
  "AD",
  "AR",
  "AM",
  "AU",
  "AT",
  "AZ",
  "BD",
  "BE",
  "BJ",
  "BO",
  "BA",
  "BR",
  "BG",
  "KH",
  "CA",
  "CL",
  "CN",
  "CO",
  "CG",
  "CR",
  "HR",
  "CY",
  "CZ",
  "DK",
  "DO",
  "EC",
  "EG",
  "SV",
  "EE",
  "FI",
  "FR",
  "GA",
  "GE",
  "DE",
  "GH",
  "GR",
  "GT",
  "HK",
  "HU",
  "IS",
  "IN",
  "ID",
  "IE",
  "IL",
  "IT",
  "JM",
  "JP",
  "JO",
  "KE",
  "KW",
  "KG",
  "LV",
  "LT",
  "MY",
  "MU",
  "MX",
  "MD",
  "ME",
  "MA",
  "MZ",
  "NP",
  "NL",
  "NZ",
  "NG",
  "NO",
  "OM",
  "PK",
  "PA",
  "PY",
  "PE",
  "PH",
  "PL",
  "PT",
  "QA",
  "RO",
  "RW",
  "SA",
  "SN",
  "RS",
  "SG",
  "SK",
  "SI",
  "ZA",
  "KR",
  "ES",
  "LK",
  "SE",
  "CH",
  "TW",
  "TJ",
  "TZ",
  "TH",
  "TT",
  "TN",
  "TR",
  "UG",
  "UA",
  "GB",
  "US",
  "UY",
  "UZ",
  "VN",
] as const;

export type Destination = { code: string; name: string; flag: string };

const CODE_SET = new Set<string>(ESIM_COUNTRY_CODES);

export const ESIM_DESTINATIONS: Destination[] = COUNTRIES.filter((c) =>
  CODE_SET.has(c.code),
).map((c) => ({ code: c.code, name: c.name, flag: countryFlag(c.code) }));

export function hasEsim(code: string): boolean {
  return CODE_SET.has(code);
}

export function destinationName(code: string): string {
  return ESIM_DESTINATIONS.find((d) => d.code === code)?.name ?? code;
}

export function destinationFlag(code: string): string {
  return countryFlag(code);
}
