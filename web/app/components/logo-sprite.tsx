/**
 * The same thirteen equity icons, declared once instead of once per row.
 *
 * WHY THIS EXISTS, measured rather than assumed. `/indices/all` renders 168 baskets, and the marks
 * inside them resolve to 264 `<img src>` attributes pointing at only 13 distinct URLs — Coinbase's
 * icons are 110-character content hashes, so that is 28.6 KB of page spent where 1.4 KB would do.
 * Next then serialises the same tree into the RSC payload beside the HTML, so every one of those
 * strings is paid for twice: 132 of the occurrences were in the inline `<script>` half.
 *
 * Declared as classes, an occurrence costs about twelve characters and disappears from the payload
 * entirely, because a class name is all that crosses. The network is unchanged either way — 13
 * distinct URLs are 13 requests whether they arrive as `src` or as `background-image`.
 */

/** Stable, collision-free for the symbols this repo sees, and safe to interpolate into CSS. */
export const spriteClass = (symbol: string) => `sl-${symbol.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

/**
 * Icons come from `contractURI()`, which is chain data — anyone can deploy a token and make it say
 * what they like. Putting that straight into a stylesheet is a CSS injection: a `url` containing a
 * quote and a brace closes the rule and opens another. So the URL is not escaped, it is REFUSED
 * unless it matches the shape a hosted icon has. A mark that fails falls back to an `<img>`, which
 * is inert, so a hostile token loses its sprite rather than gaining a stylesheet.
 */
const SAFE = /^https:\/\/[a-z0-9.-]+\/[a-z0-9/._-]*$/i;
export const spriteSafe = (url?: string) => Boolean(url && url.length < 300 && SAFE.test(url));

/**
 * One `<style>` for every distinct mark on the page. Render it once, above the rows that use it.
 */
export function LogoSprite({ marks }: { marks: Array<{ symbol: string; logo?: string }> }) {
  const rules = new Map<string, string>();
  for (const mark of marks) {
    if (!spriteSafe(mark.logo)) continue;
    const cls = spriteClass(mark.symbol);
    if (!rules.has(cls)) rules.set(cls, mark.logo as string);
  }
  if (rules.size === 0) return null;

  return (
    <style>
      {[...rules].map(([cls, url]) => `.${cls}{background-image:url("${url}")}`).join("")}
    </style>
  );
}
