import Image from "next/image";

export type Step = {
  number: string;
  title: string;
  copy: string;
  /** A 3D mark from `public/icons/`, generated to match the site's coin renders. */
  art: string;
  /** The step where value reaches a holder; the only one allowed the payout colour. */
  lit?: boolean;
};

/**
 * A short sequence as a horizontal rail: each step a column with its 3D mark, its number, a title
 * and one line of copy, joined by a line that runs behind the marks. Used for the payout sequence
 * on /dividends and the cycle on /indices; the homepage's three-step loop is a vertical timeline
 * instead, so the two shapes do not repeat one another across pages.
 */
export function StepsRail({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps-rail" style={{ "--steps": steps.length } as React.CSSProperties}>
      {steps.map((step) => (
        <li className={`steps-rail-item reveal${step.lit ? " is-lit" : ""}`} key={step.number}>
          <span aria-hidden="true" className="steps-rail-art">
            <Image alt="" height={120} sizes="120px" src={step.art} width={120} />
          </span>
          <span className="steps-rail-number">{step.number}</span>
          <h3>{step.title}</h3>
          <p>{step.copy}</p>
        </li>
      ))}
    </ol>
  );
}
