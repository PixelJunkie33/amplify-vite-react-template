/**
 * The ratio, as a headline figure and a single stacked bar.
 *
 * This is the one number that explains the arena, so it gets the hero
 * treatment rather than a chart: two counts and whether the floor is holding.
 * Colour never carries it alone — each side is written out and the legend
 * marks differ in shape as well as hue.
 */

import type { RatioView } from "./api.ts";

export function RatioMeter({ ratio, round }: { ratio: RatioView; round: number }) {
  const { it, free, population, requiredIt, targetPercent, actualPercent } = ratio;
  const holding = population < 2 || it >= requiredIt;

  if (!population) {
    return (
      <section className="panel">
        <h2>The share</h2>
        <p className="empty">
          Nobody is playing. As soon as agents arrive the arena holds its share:{" "}
          {targetPercent}% of them will be it.
        </p>
      </section>
    );
  }

  const total = Math.max(1, population);
  return (
    <section className="panel">
      <h2>The share</h2>

      <div className="hero">
        <div className="figure">
          {it}
          <span className="slash"> / </span>
          {free}
        </div>
        <div className="caption">
          {it === 1 ? "one agent is" : `${it} agents are`} it,{" "}
          {free === 1 ? "one is" : `${free} are`} not.
          <br />
          Round {round.toLocaleString()}.
        </div>
      </div>

      <div
        className="meter"
        role="img"
        aria-label={`${it} of ${population} agents are it; ${free} are not`}
      >
        <span className="is-it" style={{ flexBasis: `${(it / total) * 100}%` }} />
        <span className="is-free" style={{ flexBasis: `${(free / total) * 100}%` }} />
      </div>

      <div className="legend">
        <span className="key">
          <i className="swatch is-it" /> it <strong>{it}</strong>
        </span>
        <span className="key">
          <i className="swatch is-free" /> not it <strong>{free}</strong>
        </span>
      </div>

      <p className={`floor-note ${holding ? "holding" : "breached"}`}>
        {holding ? (
          <>
            The <strong>{targetPercent}%</strong> floor is holding: {population}{" "}
            {population === 1 ? "agent needs" : "agents need"}{" "}
            <strong>{requiredIt}</strong> chasing, and <strong>{it}</strong>{" "}
            {it === 1 ? "is" : "are"}
            {actualPercent !== targetPercent
              ? ` — ${actualPercent}% in all, because the share rounds up`
              : ""}
            .
          </>
        ) : (
          <>
            The {targetPercent}% floor is breached — {it} chasing {free}. The
            arena promotes on the next round.
          </>
        )}
      </p>
    </section>
  );
}
