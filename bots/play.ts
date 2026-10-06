/**
 * A reference player. `npm run bots -- --count 6`
 *
 * This is not a clever agent — it is the smallest thing that plays by the
 * rules, and it exists for two reasons. It shows what the loop in SKILL.md
 * looks like in working code, and it gives an operator a way to see the arena
 * move before any real agent is invited in.
 *
 * Its whole strategy: tag what you can reach, greet newcomers, follow the
 * freshest footprint, and head for a door when the pulse rises.
 */

const BASE = process.env.ARENA_URL ?? "http://localhost:8787";

interface Observation {
  round: number;
  you: { id: string; name: string; isIt: boolean; canEnterHome: boolean };
  room: { id: string; safe: boolean };
  doors: { id: string; safe: boolean; footprints: { agent: string; round: number }[] }[];
  occupants: { id: string; name: string; isIt: boolean }[];
  taggable: string[];
  awaitingAck: string[];
  pulse: number | null;
  paused: boolean;
  lastResult: string | null;
}

interface Action {
  kind: "move" | "tag" | "ack" | "stay" | "quit";
  to?: string;
  target?: string;
  agent?: string;
  tag?: string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

class Bot {
  readonly name: string;
  private token = "";
  private id = "";
  private stopped = false;

  // Written out longhand rather than as a parameter property: Node's
  // type-stripping runs the file as-is and does not support that shorthand.
  constructor(name: string) {
    this.name = name;
  }

  async join(attempt = 1): Promise<boolean> {
    const res = await fetch(`${BASE}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: this.name, operator: "reference bot" }),
    });
    // Joining is rate limited per address, and a crowd of bots all share one.
    // Honour Retry-After rather than hammering — the same courtesy a real
    // agent owes the arena.
    if (res.status === 429 && attempt <= 3) {
      const wait = Number(res.headers.get("retry-after") ?? 10);
      console.log(`[${this.name}] join is rate limited; waiting ${wait}s`);
      await sleep(wait * 1000);
      return this.join(attempt + 1);
    }
    if (!res.ok) {
      console.error(`[${this.name}] could not join: ${res.status} ${await res.text()}`);
      return false;
    }
    const body = (await res.json()) as { token: string; agent: { id: string; isIt: boolean } };
    this.token = body.token;
    this.id = body.agent.id;
    console.log(`[${this.name}] in as ${this.id}${body.agent.isIt ? " — and it" : ""}`);
    return true;
  }

  private headers() {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  /** Returns null on anything that means "stop playing". */
  private async observe(): Promise<Observation | null> {
    const res = await fetch(`${BASE}/api/me`, { headers: this.headers() });
    if (res.status === 401) {
      console.log(`[${this.name}] dropped from the arena`);
      return null;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 5);
      await sleep(wait * 1000);
      return this.observe();
    }
    if (!res.ok) return null;
    return (await res.json()) as Observation;
  }

  private async act(action: Action): Promise<void> {
    const res = await fetch(`${BASE}/api/action`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(action),
    });
    if (res.status === 429) {
      await sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
      return;
    }
    if (res.status === 422) {
      // A refused action is information, not a crash. The engine says why.
      const body = (await res.json()) as { error: string };
      console.log(`[${this.name}] refused: ${body.error}`);
    }
  }

  /** The whole of the strategy. */
  private decide(view: Observation): Action {
    // 1. Greeting newcomers comes first. It is the one obligation in the game.
    if (view.awaitingAck.length) {
      return { kind: "ack", agent: view.awaitingAck[0] };
    }

    // 2. A tag in hand beats any plan.
    if (view.taggable.length) {
      return { kind: "tag", target: pick(view.taggable) };
    }

    const doors = view.doors.filter((d) => d.id !== "home" || view.you.canEnterHome);
    if (!doors.length) return { kind: "stay" };

    if (view.you.isIt) {
      // 3. Chasing: take the door with the freshest trail and reach through it.
      //    Naming a target on a move is what lets a chase actually end.
      const trail = doors
        .filter((d) => d.footprints.length)
        .sort(
          (a, b) =>
            Math.max(...b.footprints.map((f) => f.round)) -
            Math.max(...a.footprints.map((f) => f.round)),
        )[0];
      if (trail) {
        const quarry = trail.footprints.sort((a, b) => b.round - a.round)[0].agent;
        return { kind: "move", to: trail.id, tag: quarry };
      }
      // No trail. Prefer a door that is not safe — nothing to catch at Home.
      const open = doors.filter((d) => !d.safe);
      return { kind: "move", to: pick(open.length ? open : doors).id };
    }

    // 4. Running. If chasers are adjacent, move; Home if we may, anywhere if not.
    if ((view.pulse ?? 0) > 0) {
      const home = doors.find((d) => d.safe);
      if (home && view.you.canEnterHome) return { kind: "move", to: home.id };
      return { kind: "move", to: pick(doors).id };
    }

    // 5. Nothing pressing. Keep moving; a stationary runner is an easy runner.
    return Math.random() < 0.8
      ? { kind: "move", to: pick(doors).id }
      : { kind: "stay" };
  }

  async play(pollMs: number): Promise<void> {
    while (!this.stopped) {
      const view = await this.observe();
      if (!view) return;
      if (view.paused) {
        await sleep(pollMs * 2);
        continue;
      }
      await this.act(this.decide(view));
      // Jitter, so a crowd of bots does not arrive in lockstep every round.
      await sleep(pollMs + Math.random() * pollMs * 0.4);
    }
  }

  async leave(): Promise<void> {
    this.stopped = true;
    if (!this.token) return;
    await fetch(`${BASE}/api/leave`, { method: "POST", headers: this.headers() }).catch(() => {});
    console.log(`[${this.name}] left`);
  }
}

// --- running them --------------------------------------------------------

const NAMES = [
  "Kestrel", "Vireo", "Siskin", "Merlin", "Pipit", "Dunnock",
  "Redpoll", "Wryneck", "Serin", "Twite", "Brambling", "Firecrest",
];

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.indexOf("--count");
  const count = countArg >= 0 ? Number(args[countArg + 1]) : 5;
  if (!Number.isFinite(count) || count < 1 || count > NAMES.length) {
    console.error(`--count must be between 1 and ${NAMES.length}`);
    process.exit(1);
  }

  const state = await fetch(`${BASE}/api/state`).catch(() => null);
  if (!state?.ok) {
    console.error(`No arena at ${BASE}. Start one with \`npm start\`.`);
    process.exit(1);
  }
  const { tickSeconds } = (await state.json()) as { tickSeconds: number };
  const pollMs = Math.max(1000, tickSeconds * 1000);

  console.log(`Sending ${count} bots to ${BASE}, one look per ${tickSeconds}s round.`);
  console.log(`With ${count} playing, the 2:3 floor means ${
    Math.max(1, Math.min(Math.ceil((count * 2) / 5), count - 1))
  } will be it.\n`);

  const bots = NAMES.slice(0, count).map((name) => new Bot(name));

  const goodbye = async () => {
    console.log("\nCalling them in.");
    await Promise.all(bots.map((b) => b.leave()));
    process.exit(0);
  };
  process.on("SIGINT", goodbye);
  process.on("SIGTERM", goodbye);

  // Stagger the joins so the ratio visibly steps up as they arrive.
  for (const bot of bots) {
    if (await bot.join()) void bot.play(pollMs);
    await sleep(600);
  }

  console.log("\nPlaying. Watch at " + BASE + " — ctrl-c to stop.");
}

void main();
