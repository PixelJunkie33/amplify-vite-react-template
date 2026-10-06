/**
 * Tunable rules for the arena.
 *
 * Every number an operator can change lives here. The engine reads these and
 * never hardcodes a constant, so a test can build an arena with one rule
 * turned off and check that the rule was the thing doing the work.
 */

export interface Rules {
  /**
   * The ratio. For every `ratioFree` agents that are not it, at least
   * `ratioIt` agents must be it. 2:3 means a five-agent arena has two
   * chasers and three runners.
   */
  ratioIt: number;
  ratioFree: number;

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
  ratioIt: 2,
  ratioFree: 3,
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
 * Solves `it / free >= ratioIt / ratioFree` for the smallest whole number of
 * its, which is `ceil(population * ratioIt / (ratioIt + ratioFree))`. Always
 * leaves at least one agent free, so there is somebody to chase.
 */
export function requiredIt(rules: Rules, population: number): number {
  if (population < 2) return 0;
  const share = rules.ratioIt + rules.ratioFree;
  const needed = Math.ceil((population * rules.ratioIt) / share);
  return Math.max(1, Math.min(needed, population - 1));
}

export function mergeRules(patch: Partial<Rules> = {}): Rules {
  return { ...DEFAULT_RULES, ...patch };
}
