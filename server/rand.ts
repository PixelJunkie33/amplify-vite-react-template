/**
 * Deterministic, auditable randomness.
 *
 * Every choice the arena makes for itself — the opening coin flip, which free
 * agent gets promoted when the ratio demands another chaser — is derived from
 * the head of the public hash chain. That makes the choice unpredictable
 * before the round and checkable afterwards: anyone holding the log can
 * recompute it. No hidden seed, nothing the operator can quietly lean on.
 */

import { createHash } from "node:crypto";

export function digest(...parts: (string | number)[]): string {
  const hash = createHash("sha256");
  hash.update(parts.map(String).join("\u0000"));
  return hash.digest("hex");
}

/** A stable number in [0, 1) derived from the given material. */
export function unitFrom(...parts: (string | number)[]): number {
  const hex = digest(...parts).slice(0, 13); // 52 bits, exact in a double
  return parseInt(hex, 16) / 2 ** 52;
}

/** A stable integer in [0, bound) derived from the given material. */
export function intFrom(bound: number, ...parts: (string | number)[]): number {
  if (bound <= 0) throw new Error("bound must be positive");
  return Math.floor(unitFrom(...parts) * bound) % bound;
}

/**
 * Order `items` stably but unpredictably, by hashing each key with the seed.
 * Used wherever the arena must pick "some of these" without favouring
 * whoever happens to sort first alphabetically.
 */
export function shuffled<T>(items: T[], key: (item: T) => string, seed: string): T[] {
  return [...items]
    .map((item) => ({ item, rank: digest(seed, key(item)) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.item);
}
