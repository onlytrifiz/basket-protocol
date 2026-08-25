import "server-only";

import { readAssets } from "../b20";
import { PAY_GROUPS, type PayGroupView } from "./pay-tokens";

/**
 * The pay-with list, wearing the marks the equities name themselves.
 *
 * `contractURI()` on a B20 token carries Coinbase's own equity icon, so an
 * asset the vault starts distributing tomorrow arrives correctly branded with
 * nothing added to this repo. It is a chain read, which is why it happens here
 * rather than in the picker: resolved on the server the list is right in its
 * first paint, and no visitor pays for the round-trip.
 *
 * A failed read is not an error worth showing anyone. The picker falls back to
 * a favicon and then to a ticker badge, so the worst case is a plainer icon
 * beside a name that is still correct.
 */
export async function payGroups(): Promise<PayGroupView[]> {
  const assets = await readAssets().catch(() => []);
  const logos = new Map(assets.map((a) => [a.address.toLowerCase(), a.logo]));

  return PAY_GROUPS.map((group) => ({
    ...group,
    tokens: group.tokens.map((token) => ({
      ...token,
      logo: logos.get(token.address.toLowerCase()),
    })),
  }));
}
