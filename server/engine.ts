/**
 * The rules engine.
 *
 * The server owns every piece of state. An agent can only submit one action
 * per round and read what the arena tells it; it cannot move itself, decide
 * it is not it, or write to the log. Nothing in here touches HTTP, so the
 * whole game is testable in process.
 *
 * Round order, which matters:
 *   1. moves resolve        (so a chase is simultaneous, not first-come)
 *   2. tags resolve         (you may move and tag in the same action)
 *   3. the ratio is trued up
 *   4. Home is swept
 *   5. idle agents are dropped
 *   6. the round is written to the hash-chained log
 */

import { ArenaMap, HOME } from "./map.ts";
import {
  actualPercent,
  DEFAULT_RULES,
  mergeRules,
  requiredIt,
  type Rules,
} from "./rules.ts";
import { digest, intFrom, shuffled } from "./rand.ts";

// --- Actions -------------------------------------------------------------

export type ActionKind = "move" | "tag" | "ack" | "stay" | "quit";

export interface Action {
  kind: ActionKind;
  /** `move`: the room to walk into. Must share a door with your room. */
  to?: string;
  /** `tag`: the agent you are reaching for. Its only. */
  target?: string;
  /** `ack`: the newcomer you are acknowledging. */
  agent?: string;
  /**
   * `move` may carry a tag as well, so an it can chase and reach in one
   * round. Without this an it is always a step behind and chases never end.
   */
  tag?: string;
}

// --- Agents --------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  room: string;
  isIt: boolean;
  joinedRound: number;
  lastActionRound: number;
  /** Rounds until which this agent cannot be tagged, having just tagged. */
  immuneUntil: number;
  /** Consecutive rounds ending at Home. */
  homeStreak: number;
  /** Rounds until which this agent may not walk back into Home. */
  homeBlockedUntil: number;
  /** A newcomer is shielded until this round unless an it acknowledges them. */
  shieldUntil: number;
  /** Ids of the its that have acknowledged this agent. */
  ackedBy: string[];
  /** Last round this agent was it. -1 if never. Drives fair promotion. */
  lastItRound: number;
  becameItRound: number;
}

export interface Footprint {
  agent: string;
  round: number;
}

export interface LogEntry {
  round: number;
  at: string;
  events: string[];
  /** sha256 over the previous hash and this entry. Chains the whole log. */
  hash: string;
  prev: string;
}

export interface Observation {
  round: number;
  you: {
    id: string;
    name: string;
    isIt: boolean;
    immune: boolean;
    shielded: boolean;
    canEnterHome: boolean;
    homeStreak: number;
  };
  room: { id: string; name: string; safe: boolean };
  doors: { id: string; name: string; safe: boolean; footprints: Footprint[] }[];
  /** Everyone else standing where you are. */
  occupants: { id: string; name: string; isIt: boolean }[];
  /** Ids you may legally tag, this round, from this room. Its only. */
  taggable: string[];
  /** Newcomers you are expected to acknowledge. Its only. */
  awaitingAck: string[];
  /** How many its stand one room away. Null when the pulse rule is off. */
  pulse: number | null;
  ratio: ArenaRatio;
  paused: boolean;
  /** What happened to your last submitted action. */
  lastResult: string | null;
}

export interface ArenaRatio {
  population: number;
  it: number;
  free: number;
  requiredIt: number;
  /** The share the arena aims for, as a percentage. */
  targetPercent: number;
  /** The share actually in force, which rounding can nudge upward. */
  actualPercent: number;
  /** Human-readable, e.g. "40% of agents are it". */
  target: string;
}

interface Submission {
  agent: string;
  action: Action;
  seq: number;
}

export interface EngineSnapshot {
  round: number;
  rules: Rules;
  agents: Agent[];
  footprints: Record<string, Footprint[]>;
  pairCooldowns: Record<string, number>;
  log: LogEntry[];
  paused: boolean;
}

const GENESIS = "0".repeat(64);

export class Engine {
  readonly map: ArenaMap;
  rules: Rules;
  round = 0;
  paused = false;

  private agents = new Map<string, Agent>();
  private footprints = new Map<string, Footprint[]>();
  /** "a|b" (sorted) -> the first round this pair may tag again. */
  private pairCooldowns = new Map<string, number>();
  private pending = new Map<string, Submission>();
  private results = new Map<string, string>();
  private seq = 0;
  private log: LogEntry[] = [];

  constructor(rules: Partial<Rules> = {}) {
    this.rules = mergeRules(rules);
    this.map = new ArenaMap(this.rules.roomCount);
  }

  // --- Reading the arena -------------------------------------------------

  get head(): string {
    return this.log.length ? this.log[this.log.length - 1].hash : GENESIS;
  }

  population(): number {
    return this.agents.size;
  }

  roster(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.joinedRound - b.joinedRound);
  }

  agent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  tail(limit = 50): LogEntry[] {
    return this.log.slice(-limit);
  }

  logLength(): number {
    return this.log.length;
  }

  ratio(): ArenaRatio {
    const population = this.agents.size;
    const it = [...this.agents.values()].filter((a) => a.isIt).length;
    return {
      population,
      it,
      free: population - it,
      requiredIt: requiredIt(this.rules, population),
      targetPercent: this.rules.itPercent,
      actualPercent: actualPercent(it, population),
      target: `${this.rules.itPercent}% of agents are it`,
    };
  }

  occupantsOf(room: string): Agent[] {
    return this.roster().filter((a) => a.room === room);
  }

  footprintsIn(room: string): Footprint[] {
    const seen = this.footprints.get(room) ?? [];
    return seen.filter((f) => this.round - f.round <= this.rules.footprintTtl);
  }

  // --- Joining and leaving ----------------------------------------------

  /**
   * Add an agent. They start at Home, shielded, and the ratio decides
   * straight away whether the arena needs them to be it.
   *
   * The user's opening rule — the first two agents flip a coin, the winner is
   * not it — falls out of this for free: with two agents the ratio asks for
   * exactly one it, and the arena picks which one by hashing the log head, so
   * the flip is verifiable rather than trusted.
   */
  join(id: string, name: string): Agent {
    if (this.agents.has(id)) throw new Error(`agent already here: ${id}`);
    const agent: Agent = {
      id,
      name,
      room: HOME,
      isIt: false,
      joinedRound: this.round,
      lastActionRound: this.round,
      immuneUntil: 0,
      homeStreak: 0,
      homeBlockedUntil: 0,
      shieldUntil: this.round + this.rules.newcomerShield,
      ackedBy: [],
      lastItRound: -1,
      becameItRound: -1,
    };
    this.agents.set(id, agent);
    const events = [`join ${id} (${name}) at ${HOME}`];
    events.push(...this.enforceRatio(`join:${id}`));
    this.append(events);
    return agent;
  }

  /** Remove an agent. The ratio refills their slot if they were it. */
  leave(id: string, why = "left"): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.agents.delete(id);
    this.pending.delete(id);
    const events = [`${why} ${id}${agent.isIt ? " (was it)" : ""}`];
    events.push(...this.enforceRatio(`leave:${id}`));
    this.append(events);
  }

  // --- Submitting an action ---------------------------------------------

  /**
   * Queue this agent's action for the current round. Submitting twice
   * replaces the earlier action — an agent is allowed to change its mind
   * before the round resolves, but never to act twice.
   */
  submit(id: string, action: Action): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`not in the arena: ${id}`);
    if (this.paused) throw new Error("the arena is paused");
    this.validate(agent, action);
    this.pending.set(id, { agent: id, action, seq: this.seq++ });
    agent.lastActionRound = this.round;
  }

  /** Cheap up-front checks, so an agent learns about a typo immediately. */
  private validate(agent: Agent, action: Action): void {
    switch (action.kind) {
      case "move": {
        if (!action.to) throw new Error("move needs a `to` room");
        if (!this.map.has(action.to)) throw new Error(`no such room: ${action.to}`);
        if (!this.map.adjacent(agent.room, action.to)) {
          throw new Error(`no door from ${agent.room} to ${action.to}`);
        }
        if (action.tag && !agent.isIt) throw new Error("only an it may tag");
        break;
      }
      case "tag": {
        if (!agent.isIt) throw new Error("only an it may tag");
        if (!action.target) throw new Error("tag needs a `target` agent");
        break;
      }
      case "ack": {
        if (!agent.isIt) throw new Error("only an it acknowledges newcomers");
        if (!action.agent) throw new Error("ack needs an `agent`");
        break;
      }
      case "stay":
      case "quit":
        break;
      default:
        throw new Error(`unknown action: ${(action as Action).kind}`);
    }
  }

  // --- The round --------------------------------------------------------

  /** Resolve the pending actions and advance one round. */
  tick(): LogEntry {
    if (this.paused) return this.append(["paused"]);

    const events: string[] = [];
    const submissions = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
    this.pending.clear();
    this.results.clear();

    const quitting: string[] = [];
    const tagAttempts: { tagger: string; target: string }[] = [];

    // 1. Moves, acknowledgements and quits.
    for (const { agent: id, action } of submissions) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      if (action.kind === "quit") {
        quitting.push(id);
        continue;
      }

      if (action.kind === "ack") {
        const target = this.agents.get(action.agent!);
        if (!target) {
          this.results.set(id, `ack failed: no agent ${action.agent}`);
          continue;
        }
        if (!target.ackedBy.includes(id)) target.ackedBy.push(id);
        // Acknowledgement drops the newcomer's shield: it is a greeting and
        // an opening move at once, exactly as the house rules intend.
        target.shieldUntil = this.round;
        events.push(`ack ${id} -> ${target.id}`);
        this.results.set(id, `acknowledged ${target.id}`);
        continue;
      }

      if (action.kind === "move") {
        const to = action.to!;
        if (to === HOME && agent.homeBlockedUntil > this.round) {
          this.results.set(
            id,
            `move refused: Home is closed to you until round ${agent.homeBlockedUntil}`,
          );
          events.push(`refused ${id} -> home (cooldown)`);
        } else if (!this.map.adjacent(agent.room, to)) {
          this.results.set(id, `move refused: no door from ${agent.room} to ${to}`);
        } else {
          this.leaveFootprint(agent);
          agent.room = to;
          events.push(`move ${id} -> ${to}`);
          this.results.set(id, `moved to ${to}`);
        }
        if (action.tag) tagAttempts.push({ tagger: id, target: action.tag });
        continue;
      }

      if (action.kind === "tag") {
        tagAttempts.push({ tagger: id, target: action.target! });
        continue;
      }

      // stay
      this.results.set(id, "stayed");
    }

    // 2. Tags, after every move has landed.
    const tagged = new Set<string>();
    for (const attempt of tagAttempts) {
      const outcome = this.resolveTag(attempt.tagger, attempt.target, tagged);
      this.results.set(attempt.tagger, outcome.message);
      if (outcome.event) events.push(outcome.event);
    }

    // 3. Quits, after tags — quitting does not dodge a reach already made.
    for (const id of quitting) {
      const agent = this.agents.get(id);
      if (!agent) continue;
      this.agents.delete(id);
      events.push(`quit ${id}${agent.isIt ? " (was it)" : ""}`);
    }

    this.round += 1;

    // 4. Home streaks and the sweep.
    events.push(...this.sweepHome());

    // 5. Agents that have gone quiet.
    for (const agent of [...this.agents.values()]) {
      if (this.round - agent.lastActionRound >= this.rules.idleRounds) {
        this.agents.delete(agent.id);
        events.push(`dropped ${agent.id} (silent ${this.rules.idleRounds} rounds)`);
      }
    }

    // 6. Newcomers nobody greeted.
    for (const agent of this.agents.values()) {
      const due = agent.joinedRound + this.rules.ackGrace;
      if (agent.ackedBy.length === 0 && this.round === due && this.ratio().it > 0) {
        events.push(`no it acknowledged ${agent.id} within ${this.rules.ackGrace} rounds`);
      }
    }

    // 7. True up the ratio last, so it reflects every departure above.
    events.push(...this.enforceRatio(`tick:${this.round}`));

    return this.append(events.length ? events : ["quiet round"]);
  }

  private resolveTag(
    taggerId: string,
    targetId: string,
    tagged: Set<string>,
  ): { message: string; event?: string } {
    const tagger = this.agents.get(taggerId);
    if (!tagger) return { message: "tag failed: you are not in the arena" };
    if (!tagger.isIt) return { message: "tag failed: you are not it" };

    const target = this.agents.get(targetId);
    if (!target) return { message: `tag failed: no agent ${targetId}` };
    if (target.id === tagger.id) return { message: "tag failed: you cannot tag yourself" };
    if (target.isIt) return { message: `tag failed: ${targetId} is already it` };
    if (target.room !== tagger.room) {
      return { message: `tag failed: ${targetId} is not in ${tagger.room}` };
    }
    if (this.map.isSafe(tagger.room)) {
      return { message: `tag failed: ${tagger.room} is safe` };
    }
    if (target.immuneUntil > this.round) {
      return { message: `tag failed: ${targetId} is immune until round ${target.immuneUntil}` };
    }
    if (target.shieldUntil > this.round && !target.ackedBy.includes(tagger.id)) {
      return { message: `tag failed: ${targetId} is a newcomer you have not acknowledged` };
    }
    const key = pairKey(tagger.id, target.id);
    const until = this.pairCooldowns.get(key) ?? 0;
    if (until > this.round) {
      return { message: `tag failed: you two cannot tag again until round ${until}` };
    }
    if (tagged.has(target.id)) {
      return { message: `tag failed: ${targetId} was already tagged this round` };
    }

    // The swap. One agent stops being it, one starts, so the count the ratio
    // works so hard to hold is untouched by an ordinary tag.
    //
    // Deadlines count from the *next* round, not this one. Tags resolve
    // before `this.round` advances, so `this.round + immunity` would lapse
    // before it ever covered a round of play.
    const nextRound = this.round + 1;
    tagged.add(target.id);
    tagger.isIt = false;
    tagger.lastItRound = this.round;
    tagger.immuneUntil = nextRound + this.rules.immunity;
    target.isIt = true;
    target.becameItRound = this.round;
    target.shieldUntil = this.round;
    this.pairCooldowns.set(key, nextRound + this.rules.pairCooldown);

    return {
      message: `tagged ${target.id} — you are not it`,
      event: `tag ${tagger.id} -> ${target.id} in ${tagger.room}`,
    };
  }

  /**
   * Hold the share: itPercent of the arena is it, rounded up.
   *
   * Promotion prefers whoever has been free longest, so a run of joins and
   * quits cannot keep landing on the same agent. Ties break on the log head,
   * which no one can predict in advance. Demotion is the mirror: whoever has
   * been it longest is let go first.
   */
  private enforceRatio(reason: string): string[] {
    const events: string[] = [];
    const population = this.agents.size;
    const need = requiredIt(this.rules, population);
    const its = [...this.agents.values()].filter((a) => a.isIt);
    const free = [...this.agents.values()].filter((a) => !a.isIt);

    if (its.length < need) {
      const shortfall = need - its.length;
      const queue = shuffled(free, (a) => a.id, digest(this.head, reason)).sort(
        (a, b) => a.lastItRound - b.lastItRound,
      );
      for (const agent of queue.slice(0, shortfall)) {
        agent.isIt = true;
        agent.becameItRound = this.round;
        agent.shieldUntil = this.round;
        agent.immuneUntil = 0;
        events.push(`it ${agent.id} (ratio needs ${need} of ${population})`);
      }
    } else if (its.length > need) {
      const surplus = its.length - need;
      const queue = shuffled(its, (a) => a.id, digest(this.head, reason)).sort(
        (a, b) => a.becameItRound - b.becameItRound,
      );
      for (const agent of queue.slice(0, surplus)) {
        agent.isIt = false;
        agent.lastItRound = this.round;
        events.push(`free ${agent.id} (ratio needs ${need} of ${population})`);
      }
    }
    return events;
  }

  private sweepHome(): string[] {
    const events: string[] = [];
    for (const agent of this.agents.values()) {
      if (agent.room !== HOME) {
        agent.homeStreak = 0;
        continue;
      }
      agent.homeStreak += 1;
      if (agent.homeStreak > this.rules.maxHomeStay) {
        const doors = this.map.doors(HOME);
        const exit = doors[intFrom(doors.length, this.head, agent.id, this.round)];
        this.leaveFootprint(agent);
        agent.room = exit;
        agent.homeStreak = 0;
        agent.homeBlockedUntil = this.round + this.rules.homeCooldown;
        events.push(`swept ${agent.id} out of home -> ${exit}`);
      }
    }
    return events;
  }

  private leaveFootprint(agent: Agent): void {
    const prints = this.footprints.get(agent.room) ?? [];
    prints.push({ agent: agent.id, round: this.round });
    this.footprints.set(
      agent.room,
      prints.filter((f) => this.round - f.round <= this.rules.footprintTtl),
    );
  }

  // --- Observations -----------------------------------------------------

  observe(id: string): Observation {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`not in the arena: ${id}`);
    const room = this.map.get(agent.room);
    const here = this.occupantsOf(agent.room).filter((a) => a.id !== id);

    const taggable = agent.isIt && !room.safe
      ? here
          .filter((other) => !other.isIt)
          .filter((other) => other.immuneUntil <= this.round)
          .filter(
            (other) => other.shieldUntil <= this.round || other.ackedBy.includes(agent.id),
          )
          .filter((other) => (this.pairCooldowns.get(pairKey(id, other.id)) ?? 0) <= this.round)
          .map((other) => other.id)
      : [];

    const awaitingAck = agent.isIt
      ? this.roster()
          .filter((other) => other.id !== id)
          .filter((other) => other.joinedRound + this.rules.ackGrace > this.round)
          .filter((other) => !other.ackedBy.includes(id))
          .map((other) => other.id)
      : [];

    let pulse: number | null = null;
    if (this.rules.pulse && !agent.isIt) {
      pulse = room.doors.reduce(
        (count, door) => count + this.occupantsOf(door).filter((a) => a.isIt).length,
        0,
      );
    }

    return {
      round: this.round,
      you: {
        id: agent.id,
        name: agent.name,
        isIt: agent.isIt,
        immune: agent.immuneUntil > this.round,
        shielded: agent.shieldUntil > this.round,
        canEnterHome: agent.homeBlockedUntil <= this.round,
        homeStreak: agent.homeStreak,
      },
      room: { id: room.id, name: room.name, safe: room.safe },
      doors: room.doors.map((door) => {
        const next = this.map.get(door);
        return {
          id: next.id,
          name: next.name,
          safe: next.safe,
          footprints: this.footprintsIn(door).filter((f) => f.agent !== id),
        };
      }),
      occupants: here.map((other) => ({
        id: other.id,
        name: other.name,
        isIt: other.isIt,
      })),
      taggable,
      awaitingAck,
      pulse,
      ratio: this.ratio(),
      paused: this.paused,
      lastResult: this.results.get(id) ?? null,
    };
  }

  // --- The log ----------------------------------------------------------

  private append(events: string[]): LogEntry {
    const prev = this.head;
    const at = new Date().toISOString();
    const body = JSON.stringify({ round: this.round, events });
    const entry: LogEntry = {
      round: this.round,
      at,
      events,
      prev,
      hash: digest(prev, body),
    };
    this.log.push(entry);
    return entry;
  }

  /** Walk the chain and confirm nothing has been edited after the fact. */
  verifyLog(): { ok: boolean; brokeAt?: number } {
    let prev = GENESIS;
    for (let i = 0; i < this.log.length; i++) {
      const entry = this.log[i];
      const body = JSON.stringify({ round: entry.round, events: entry.events });
      if (entry.prev !== prev || entry.hash !== digest(prev, body)) {
        return { ok: false, brokeAt: i };
      }
      prev = entry.hash;
    }
    return { ok: true };
  }

  // --- Save and resume --------------------------------------------------

  snapshot(): EngineSnapshot {
    return {
      round: this.round,
      rules: this.rules,
      agents: this.roster().map((a) => ({ ...a, ackedBy: [...a.ackedBy] })),
      footprints: Object.fromEntries(this.footprints),
      pairCooldowns: Object.fromEntries(this.pairCooldowns),
      log: this.log,
      paused: this.paused,
    };
  }

  static restore(snapshot: EngineSnapshot): Engine {
    const engine = new Engine(snapshot.rules ?? DEFAULT_RULES);
    engine.round = snapshot.round;
    engine.paused = snapshot.paused;
    engine.log = snapshot.log ?? [];
    for (const agent of snapshot.agents ?? []) engine.agents.set(agent.id, { ...agent });
    for (const [room, prints] of Object.entries(snapshot.footprints ?? {})) {
      engine.footprints.set(room, prints);
    }
    for (const [key, until] of Object.entries(snapshot.pairCooldowns ?? {})) {
      engine.pairCooldowns.set(key, until);
    }
    return engine;
  }
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}
