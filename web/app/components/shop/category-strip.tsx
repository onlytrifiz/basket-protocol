import { categoryLabel } from "../../../lib/shop/countries";
import type { CategoryGroup } from "../../../lib/shop/types";

/* Drawn in the same fine-line engraving style as the marks in Brand.tsx, so
   nothing is fetched and nothing breaks when a third party moves its assets. */
const ICONS: Record<string, string> = {
  food: "M4 3v8a3 3 0 003 3v7M7 3v6M17 3c-1.5 2-2 4-2 7h4c0-3-.5-5-2-7zM17 10v11",
  games: "M7 12h4M9 10v4M15.5 11.5h.01M18 13.5h.01M2.5 8h19v8a4 4 0 01-4 4H6.5a4 4 0 01-4-4V8z",
  retail: "M3 7h18l-1.5 13H4.5L3 7zM8 7V5a4 4 0 018 0v2",
  "e-commerce": "M3 5h2l2.5 11h10L20 8H6.5M9 20h.01M17 20h.01",
  streaming: "M3.5 5.5h17v11h-17zM8 21h8M12 16.5V21M10 9l4 2.5-4 2.5V9z",
  travel_flights: "M2 13l20-7-7 20-3-8-10-5z",
  electronics: "M4 4h16v12H4zM2 20h20M9 8h6",
  home: "M3 11l9-7 9 7M6 10v10h12V10",
  apparel_clothing: "M8 3l4 2 4-2 4 4-3 2v12H7V9L4 7l4-4z",
  health_beauty: "M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10z",
  sports_fitness: "M4 12a8 8 0 1116 0 8 8 0 01-16 0zM4 12h16M12 4v16",
  groceries: "M6 8h12l-1 12H7L6 8zM9 8V6a3 3 0 016 0v2",
  "e-money": "M2.5 6h19v12h-19zM2.5 10h19M6 14h4",
  "e-sim": "M6 3h8l4 4v14H6V3zM9 12h6v5H9z",
  mobile_credits: "M7 2.5h10v19H7zM11 18.5h2",
  mobile_bundle: "M7 2.5h10v19H7zM11 18.5h2",
  charity_donations: "M12 21s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 11c0 5.5-7 10-7 10z",
  books_learning: "M4 4h7v16H4zM13 4h7v16h-7z",
  entertainment: "M4 4h16v16H4zM4 9h16M9 4v16",
};

/** The aisles, as one horizontal row under the hero. */
export function CategoryStrip({ categories }: { categories: CategoryGroup[] }) {
  const shown = categories.slice(0, 12);
  if (!shown.length) return null;

  return (
    <nav className="sh-cats" aria-label="Categories">
      <div className="wrap">
        <ul>
          {shown.map((c) => (
            <li key={c.category}>
              <a href={`/shop/brands?c=${encodeURIComponent(c.category)}`}>
                <span className="m">
                  <svg
                    width="21"
                    height="21"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d={ICONS[c.category] ?? "M4 6h16M4 12h16M4 18h16"} />
                  </svg>
                </span>
                <span className="t">{categoryLabel(c.category)}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
