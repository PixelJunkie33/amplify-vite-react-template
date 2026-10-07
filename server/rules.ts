/**
 * Tunable rules for the arena.
 *
 * Every number an operator can change lives here. The engine reads these and
 * never hardcodes a constant, so a test can build an arena with one rule
 * turned off and check that the rule was the thing doing the work.
 */

export interface Rules {
  /**
   * What share of the arena is it, as a percentage. 40 means a ten-agent
   * arena has four chasers and six runners.
   *
   * This is the rule the whole game rests on. Tag with a single chaser and a
   * safe room has a dominant strategy — hide — and the familiar failure that
   * follows: long stretches where nobody is caught. At 40% there is no corner
   * of the map reliably clear, so standing still stops being free.
   */
  itPercent: number;

  /** Seconds per round. Every agent gets one action per round. */
  tickSeconds: number;

  /**
   * Home is the only safe room. You may stand there this many rounds in a
   * row before the arena sweeps you out, and then you may not come back
   * for `homeCooldown` rounds. The cooldown is the part that actually
   * stops camping; the stay cap alone does not.
   */
  maxHomeStay: number;
  homeCooldown: number;

  /** Rounds you cannot be tagged for, right after you tag somebody. */
  immunity: number;

  /**
   * Rounds before the same two agents may tag each other again. Blunts two
   * agents pairing off and passing it back and forth between them.
   */
  pairCooldown: number;

  /**
   * A newcomer cannot be tagged until an it acknowledges them, or until
   * this many rounds pass, whichever comes first. Stalling the
   * acknowledgement therefore buys an it nothing.
   */
  newcomerShield: number;

  /** Rounds an it has to acknowledge a newcomer before the log notes a miss. */
  ackGrace: number;

  /** How long a footprint lingers in a room after someone passes through. */
  footprintTtl: number;

  /** Tell non-its how many its stand one room away. False plays blind. */
  pulse: boolean;

  /** Submit nothing for this many rounds and the arena drops you. */
  idleRounds: number;

  /** How many rooms the arena has. */
  roomCount: number;
}

export const DEFAULT_RULES: Rules = {
  itPercent: 40,
  tickSeconds: 10,
  maxHomeStay: 2,
  homeCooldown: 3,
  immunity: 1,
  pairCooldown: 15,
  newcomerShield: 3,
  ackGrace: 5,
  footprintTtl: 2,
  pulse: true,
  idleRounds: 30,
  roomCount: 16,
};

/**
 * How many agents must be it, for a given population.
 *
 * The smallest whole number that reaches the share, so the floor is never
 * undershot by rounding. Always at least one — otherwise nobody is chasing —
 * and never everyone, so there is always somebody left to chase.
 */
export function requiredIt(rules: Rules, population: number): number {
  if (population < 2) return 0;
  const needed = Math.ceil((population * rules.itPercent) / 100);
  return Math.max(1, Math.min(needed, population - 1));
}

/** The share actually in force right now, which rounding can nudge upward. */
export function actualPercent(it: number, population: number): number {
  if (!population) return 0;
  return Math.round((it / population) * 1000) / 10;
}

export function mergeRules(patch: Partial<Rules> = {}): Rules {
  return { ...DEFAULT_RULES, ...patch };
}
