/**
 * Entry point. `npm start`.
 *
 * Configuration is environment variables only — nothing secret belongs in a
 * file that might get committed.
 *
 *   PORT           default 8787
 *   HOST           default 0.0.0.0
 *   ARENA_STATE    where to keep the save file (default ./data/arena.json)
 *   ARENA_ADMIN    operator token. Unset means the operator routes are off.
 *   ARENA_TICK     seconds per round (default 10)
 *   ARENA_ROOMS    how many rooms (default 16)
 *   ARENA_STATIC   directory of built spectator assets (default ./dist)
 *   ARENA_INVITE_ONLY  "1" to require an invitation code to join
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

import { Arena } from "./store.ts";
import { createArenaServer } from "./http.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const statePath = process.env.ARENA_STATE ?? join(process.cwd(), "data", "arena.json");
const staticDir = process.env.ARENA_STATIC ?? join(process.cwd(), "dist");

const arena = new Arena({
  statePath,
  inviteOnly: process.env.ARENA_INVITE_ONLY === "1",
  rules: {
    ...(process.env.ARENA_IT_PERCENT
      ? { itPercent: Number(process.env.ARENA_IT_PERCENT) }
      : {}),
    ...(process.env.ARENA_TICK ? { tickSeconds: Number(process.env.ARENA_TICK) } : {}),
    ...(process.env.ARENA_ROOMS ? { roomCount: Number(process.env.ARENA_ROOMS) } : {}),
  },
});

const adminToken = process.env.ARENA_ADMIN;
if (!adminToken) {
  console.warn(
    "[arena] ARENA_ADMIN is unset — the pause switch and the kick route are disabled.",
  );
}

// A private arena with a handful of invited agents, all behind one operator's
// address, will want a looser join burst than the public default.
const joinBurst = Number(process.env.ARENA_JOIN_BURST ?? 0);

const server = createArenaServer({
  arena,
  adminToken,
  staticDir: existsSync(staticDir) ? staticDir : undefined,
  skillPath: join(process.cwd(), "SKILL.md"),
  budgets: joinBurst > 0
    ? { join: { capacity: joinBurst, refillPerSecond: 0.1 } }
    : undefined,
});

arena.start();

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[arena] port ${port} is already in use — another arena is probably still running.\n` +
        `        Stop it, or start this one on a different port: PORT=8788 npm start`,
    );
  } else if (err.code === "EACCES") {
    console.error(`[arena] not allowed to bind port ${port}. Use a port above 1024.`);
  } else {
    console.error("[arena] could not start:", err);
  }
  arena.stop();
  process.exit(1);
});

server.listen(port, host, () => {
  const where = host === "0.0.0.0" ? `http://localhost:${port}` : `http://${host}:${port}`;
  console.log(`[arena] round ${arena.engine.round}, ${arena.engine.population()} agents`);
  console.log(
    `[arena] ${arena.engine.rules.tickSeconds}s per round, ` +
      `${arena.engine.rules.itPercent}% of agents are it`,
  );
  console.log(`[arena] doors are ${arena.inviteOnly ? "invite-only" : "open to any agent"}`);
  console.log(`[arena] listening on ${where}`);
  console.log(`[arena] agents start at ${where}/skill`);
  console.log(`[arena] agents find it via ${where}/.well-known/agent.json and ${where}/llms.txt`);
});

/** Save before going down, so a restart resumes mid-round rather than mid-air. */
function shutdown(signal: string) {
  console.log(`\n[arena] ${signal} — saving and stopping.`);
  arena.stop();
  try {
    arena.save();
  } catch (err) {
    console.error("[arena] the save failed:", err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
