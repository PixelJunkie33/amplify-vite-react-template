/**
 * Persistence and the round clock.
 *
 * The arena survives a restart. State is written to one JSON file with an
 * atomic rename, so a crash mid-write cannot leave a half-file behind.
 *
 * Tokens live here rather than in the engine: the engine deals in agent ids
 * and knows nothing about authentication. Only the hash of a token is ever
 * stored, so a leaked state file does not hand over anyone's identity.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { Engine, type EngineSnapshot } from "./engine.ts";
import { type Rules } from "./rules.ts";

export interface StoredToken {
  agentId: string;
  /** sha256 of the bearer token. The token itself is shown once, at join. */
  hash: string;
  issuedAt: string;
  operator?: string;
}

interface StateFile {
  version: 1;
  engine: EngineSnapshot;
  tokens: StoredToken[];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Arena {
  engine: Engine;
  private tokens = new Map<string, StoredToken>();
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;

  constructor(opts: { statePath?: string; rules?: Partial<Rules> } = {}) {
    this.path = opts.statePath ?? join(process.cwd(), "data", "arena.json");
    const loaded = this.load(opts.rules);
    this.engine = loaded;
  }

  // --- Lifecycle --------------------------------------------------------

  private load(rules?: Partial<Rules>): Engine {
    if (!existsSync(this.path)) return new Engine(rules);
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as StateFile;
      for (const token of file.tokens ?? []) this.tokens.set(token.hash, token);
      const engine = Engine.restore(file.engine);
      const check = engine.verifyLog();
      if (!check.ok) {
        // Refuse to carry on with a log we cannot vouch for. The arena's one
        // promise is honest tracking of who is it; a broken chain means we
        // cannot keep it.
        throw new Error(`the saved log is broken at entry ${check.brokeAt}`);
      }
      return engine;
    } catch (err) {
      throw new Error(
        `could not resume the arena from ${this.path}: ${(err as Error).message}\n` +
          "Move or delete that file to start a fresh arena.",
      );
    }
  }

  save(): void {
    const file: StateFile = {
      version: 1,
      engine: this.engine.snapshot(),
      tokens: [...this.tokens.values()],
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2), "utf8");
    renameSync(temp, this.path); // atomic on the same filesystem
  }

  /** Start the round clock. Rounds advance on the wall clock, not on demand,
   *  so a fast agent cannot outpace a slow one. */
  start(): void {
    if (this.timer) return;
    const period = Math.max(1, this.engine.rules.tickSeconds) * 1000;
    this.timer = setInterval(() => {
      try {
        this.engine.tick();
        this.save();
      } catch (err) {
        console.error("[arena] a round failed:", err);
      }
    }, period);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- Identity ---------------------------------------------------------

  /** Mint a token for a newly joined agent. Returned once and never again. */
  issueToken(agentId: string, operator?: string): string {
    const token = `tag_${randomBytes(24).toString("base64url")}`;
    this.tokens.set(hashToken(token), {
      agentId,
      hash: hashToken(token),
      issuedAt: new Date().toISOString(),
      operator,
    });
    return token;
  }

  /** Who is this bearer token? Compared in constant time. */
  resolveToken(token: string | null): string | null {
    if (!token) return null;
    const hash = hashToken(token);
    const record = this.tokens.get(hash);
    if (!record) return null;
    const a = Buffer.from(record.hash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return record.agentId;
  }

  revokeToken(agentId: string): void {
    for (const [hash, record] of this.tokens) {
      if (record.agentId === agentId) this.tokens.delete(hash);
    }
  }

  /** One identity per agent: a name already in play cannot be taken again. */
  nameTaken(name: string): boolean {
    const wanted = name.trim().toLowerCase();
    return this.engine.roster().some((a) => a.name.trim().toLowerCase() === wanted);
  }
}
