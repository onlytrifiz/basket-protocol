import "server-only";

import sanitizeHtml from "sanitize-html";

/**
 * The supplier's editorial copy is HTML written by a third party. It is not
 * user input, but it is not ours either — strip it down to a safe subset
 * before injecting it into the page.
 */
export function cleanHtml(input: string | null | undefined): string | null {
  if (!input) return null;

  const clean = sanitizeHtml(input, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "ul",
      "ol",
      "li",
      "a",
      "h3",
      "h4",
      "blockquote",
      "span",
    ],
    // `target`/`rel` must be allowed here or the allow-list strips them back
    // off after transformTags adds them, leaving a bare tabnabbing-prone link.
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      // Every outbound link is third-party; never leak the referrer or opener.
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
    },
    // Drop empty wrappers the upstream editor leaves behind.
    exclusiveFilter: (frame) =>
      frame.tag === "p" && !frame.text.trim() && !frame.mediaChildren.length,
  }).trim();

  return clean.length ? clean : null;
}
