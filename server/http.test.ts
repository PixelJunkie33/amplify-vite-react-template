/**
 * End-to-end tests over real HTTP. These start a server on an ephemeral port
 * and talk to it with fetch, so they cover routing, auth, rate limits and
 * status codes — the parts the engine tests cannot see.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { Arena } from "./store.ts";
import { createArenaServer } from "./http.ts";
import { BUDGETS } from "./ratelimit.ts";

/** A join budget loose enough to stand up a crowd inside one test. */
const MANY_JOINS = { join: { capacity: 200, refillPerSecond: 50 } };

/** Boot an arena on a throwaway port with a throwaway state file. */
async function boot(opts: { admin?: string; budgets?: Partial<typeof BUDGETS> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arena-test-"));
  const arena = new Arena({
    statePath: join(dir, "arena.json"),
    rules: { tickSeconds: 3600, idleRounds: 10_000, newcomerShield: 0 },
  });
  const server = createArenaServer({
    arena,
    adminToken: opts.admin,
    // The default join budget is deliberately tight; these tests need to
    // stand up a dozen agents in a second. The limiter itself is tested
    // separately, with the real budgets.
    budgets: opts.budgets,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    arena,
    base,
    async get(path: string, token?: string) {
      const res = await fetch(base + path, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch { /* an HTML page; keep the text */ }
      return { status: res.status, body, text, headers: res.headers };
    },
    async post(path: string, payload?: unknown, token?: string) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch { /* not JSON */ }
      return { status: res.status, body, text, headers: res.headers };
    },
    async close() {
      arena.stop();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Harness = Awaited<ReturnType<typeof boot>>;

async function joinAgent(h: Harness, name: string) {
  const res = await h.post("/api/join", { name });
  assert.equal(res.status, 201, `join ${name}: ${res.text}`);
  const body = res.body as { token: string; agent: { id: string } };
  return { token: body.token, id: body.agent.id };
}

// --- joining -------------------------------------------------------------

test("http: joining returns a token and an agent", async () => {
  const h = await boot();
  try {
    const res = await h.post("/api/join", { name: "Scout" });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, any>;
    assert.match(body.token, /^tag_/);
    assert.equal(body.agent.name, "Scout");
    assert.equal(body.agent.room, "home");
  } finally {
    await h.close();
  }
});

test("http: a name already in play is refused with 409", async () => {
  const h = await boot();
  try {
    await joinAgent(h, "Scout");
    const res = await h.post("/api/join", { name: "scout" });
    assert.equal(res.status, 409, "one agent, one identity — case-insensitively");
  } finally {
    await h.close();
  }
});

test("http: a nameless or oversized join is refused with 400", async () => {
  const h = await boot();
  try {
    assert.equal((await h.post("/api/join", {})).status, 400);
    assert.equal((await h.post("/api/join", { name: "x".repeat(41) })).status, 400);
    assert.equal((await h.post("/api/join", { name: "<script>" })).status, 400);
  } finally {
    await h.close();
  }
});

// --- authentication ------------------------------------------------------

test("http: the API refuses an unauthenticated caller with 401", async () => {
  const h = await boot();
  try {
    assert.equal((await h.get("/api/me")).status, 401);
    assert.equal((await h.post("/api/action", { kind: "stay" })).status, 401);
  } finally {
    await h.close();
  }
});

test("http: a wrong token is refused", async () => {
  const h = await boot();
  try {
    await joinAgent(h, "Scout");
    assert.equal((await h.get("/api/me", "tag_not_a_real_token")).status, 401);
  } finally {
    await h.close();
  }
});

test("http: one agent's token never speaks for another", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const b = await joinAgent(h, "Beta");
    const view = (await h.get("/api/me", a.token)).body as Record<string, any>;
    assert.equal(view.you.id, a.id);
    assert.notEqual(view.you.id, b.id);
  } finally {
    await h.close();
  }
});

// --- acting --------------------------------------------------------------

test("http: a legal move is accepted with 202", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const res = await h.post("/api/action", { kind: "move", to: "long-hall" }, a.token);
    assert.equal(res.status, 202);
    const body = res.body as Record<string, any>;
    assert.equal(body.accepted.to, "long-hall");
  } finally {
    await h.close();
  }
});

test("http: walking through a wall is refused with 422", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const res = await h.post("/api/action", { kind: "move", to: "kiln" }, a.token);
    assert.equal(res.status, 422);
    assert.match((res.body as any).error, /no door|no such room/);
  } finally {
    await h.close();
  }
});

test("http: an action with no kind is refused with 400", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    assert.equal((await h.post("/api/action", {}, a.token)).status, 400);
  } finally {
    await h.close();
  }
});

test("http: a runner trying to tag is refused with 422", async () => {
  const h = await boot();
  try {
    await joinAgent(h, "Alpha");
    await joinAgent(h, "Beta");
    const c = await joinAgent(h, "Gamma");
    // Find an agent that is definitely not it and have it reach for a tag.
    const runner = h.arena.engine.roster().find((x) => !x.isIt)!;
    const token = runner.id === c.id ? c.token : null;
    if (token) {
      const res = await h.post("/api/action", { kind: "tag", target: "whoever" }, token);
      assert.equal(res.status, 422);
      assert.match((res.body as any).error, /only an it may tag/);
    }
  } finally {
    await h.close();
  }
});

test("http: malformed JSON is refused with 400", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const res = await fetch(h.base + "/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    await h.close();
  }
});

test("http: leaving revokes the token", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    assert.equal((await h.post("/api/leave", {}, a.token)).status, 200);
    assert.equal((await h.get("/api/me", a.token)).status, 401);
  } finally {
    await h.close();
  }
});

// --- the ratio, over the wire -------------------------------------------

test("http: the reported ratio holds the 2:3 floor as agents join", async () => {
  const h = await boot({ budgets: MANY_JOINS });
  try {
    for (let i = 1; i <= 8; i++) {
      await joinAgent(h, `Agent ${i}`);
      const state = (await h.get("/api/state")).body as Record<string, any>;
      assert.equal(state.ratio.population, i);
      assert.equal(state.ratio.it, state.ratio.requiredIt, `at ${i} agents`);
      if (i >= 2) {
        assert.ok(
          3 * state.ratio.it >= 2 * state.ratio.free,
          `at ${i} agents the floor broke`,
        );
      }
    }
  } finally {
    await h.close();
  }
});

// --- public reads --------------------------------------------------------

test("http: state, rules, log and health all answer", async () => {
  const h = await boot();
  try {
    await joinAgent(h, "Alpha");
    for (const path of ["/api/state", "/api/rules", "/api/log", "/api/health"]) {
      const res = await h.get(path);
      assert.equal(res.status, 200, path);
    }
    const health = (await h.get("/api/health")).body as Record<string, any>;
    assert.equal(health.ok, true);
    assert.equal(health.log.ok, true);
  } finally {
    await h.close();
  }
});

test("http: the pages render", async () => {
  const h = await boot();
  try {
    await joinAgent(h, "Alpha");
    for (const path of ["/", "/rooms", "/who", "/rules", "/log", "/room/long-hall"]) {
      const res = await h.get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.match(res.text, /<\/html>/, path);
    }
  } finally {
    await h.close();
  }
});

test("http: the front page states the ratio in words", async () => {
  const h = await boot();
  try {
    const res = await h.get("/");
    assert.match(res.text, /for every three agents that are\s*\n?\s*not it, at least two must be it/i);
  } finally {
    await h.close();
  }
});

test("http: an unknown room is a 404 page, not a crash", async () => {
  const h = await boot();
  try {
    const res = await h.get("/room/atlantis");
    assert.equal(res.status, 404);
    assert.match(res.text, /No such room/);
  } finally {
    await h.close();
  }
});

test("http: /room/home redirects to the front page", async () => {
  const h = await boot();
  try {
    const res = await fetch(h.base + "/room/home", { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
  } finally {
    await h.close();
  }
});

// --- the operator switch -------------------------------------------------

test("http: operator routes are absent unless a token is configured", async () => {
  const h = await boot();
  try {
    assert.equal((await h.post("/api/admin/pause", { paused: true })).status, 404);
  } finally {
    await h.close();
  }
});

test("http: the operator token is required and enforced", async () => {
  const h = await boot({ admin: "secret-operator-token" });
  try {
    assert.equal((await h.post("/api/admin/pause", { paused: true }, "wrong")).status, 403);
    const ok = await h.post("/api/admin/pause", { paused: true }, "secret-operator-token");
    assert.equal(ok.status, 200);
    assert.equal((ok.body as any).paused, true);
  } finally {
    await h.close();
  }
});

test("http: a paused arena refuses joins and actions", async () => {
  const h = await boot({ admin: "op" });
  try {
    const a = await joinAgent(h, "Alpha");
    await h.post("/api/admin/pause", { paused: true }, "op");
    assert.equal((await h.post("/api/join", { name: "Beta" })).status, 503);
    assert.equal((await h.post("/api/action", { kind: "stay" }, a.token)).status, 503);
    // Reading is still allowed while paused — watching is never blocked.
    assert.equal((await h.get("/api/state")).status, 200);
  } finally {
    await h.close();
  }
});

test("http: the operator can remove an agent and the ratio recovers", async () => {
  const h = await boot({ admin: "op", budgets: MANY_JOINS });
  try {
    for (let i = 0; i < 6; i++) await joinAgent(h, `Agent ${i}`);
    const anIt = h.arena.engine.roster().find((a) => a.isIt)!;
    const res = await h.post("/api/admin/kick", { agent: anIt.id }, "op");
    assert.equal(res.status, 200);
    const state = (await h.get("/api/state")).body as Record<string, any>;
    assert.equal(state.ratio.population, 5);
    assert.equal(state.ratio.it, state.ratio.requiredIt);
  } finally {
    await h.close();
  }
});

// --- rate limits ---------------------------------------------------------

test("http: hammering writes earns a 429 with Retry-After", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    let limited: { status: number; headers: Headers } | null = null;
    for (let i = 0; i < 40; i++) {
      const res = await h.post("/api/action", { kind: "stay" }, a.token);
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, "the write budget should run out");
    assert.ok(Number(limited!.headers.get("retry-after")) >= 1);
  } finally {
    await h.close();
  }
});

test("http: joining is rate limited hardest", async () => {
  const h = await boot();
  try {
    let saw429 = false;
    for (let i = 0; i < 10; i++) {
      const res = await h.post("/api/join", { name: `Agent ${i}` });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.ok(saw429, "the join budget should run out quickly");
  } finally {
    await h.close();
  }
});

test("http: an oversized body is refused, not swallowed", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const res = await fetch(h.base + "/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ kind: "stay", junk: "x".repeat(20_000) }),
    });
    assert.ok(res.status === 400 || res.status === 413, `got ${res.status}`);
  } finally {
    await h.close();
  }
});

// --- odds and ends -------------------------------------------------------

test("http: a GET never changes the arena", async () => {
  const h = await boot();
  try {
    const a = await joinAgent(h, "Alpha");
    const before = h.arena.engine.head;
    const round = h.arena.engine.round;
    for (const path of ["/", "/api/state", "/api/me", "/who", "/log", "/api/rules"]) {
      await h.get(path, a.token);
    }
    assert.equal(h.arena.engine.head, before, "the log did not move");
    assert.equal(h.arena.engine.round, round, "the round did not move");
  } finally {
    await h.close();
  }
});

test("http: a wrong method gets 405, not 404", async () => {
  const h = await boot();
  try {
    const res = await fetch(h.base + "/api/state", { method: "POST" });
    assert.equal(res.status, 405);
  } finally {
    await h.close();
  }
});

test("http: an arena resumes from its state file with the same log head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-resume-"));
  const statePath = join(dir, "arena.json");
  try {
    const first = new Arena({ statePath, rules: { tickSeconds: 3600 } });
    first.engine.join("agent_a", "Alpha");
    first.engine.join("agent_b", "Beta");
    first.engine.tick();
    const head = first.engine.head;
    const round = first.engine.round;
    first.save();

    const second = new Arena({ statePath });
    assert.equal(second.engine.head, head);
    assert.equal(second.engine.round, round);
    assert.equal(second.engine.population(), 2);
    assert.deepEqual(second.engine.verifyLog(), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http: a tampered state file is refused rather than trusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-tamper-"));
  const statePath = join(dir, "arena.json");
  try {
    const first = new Arena({ statePath, rules: { tickSeconds: 3600 } });
    first.engine.join("agent_a", "Alpha");
    first.engine.tick();
    first.save();

    const { readFileSync, writeFileSync } = await import("node:fs");
    const file = JSON.parse(readFileSync(statePath, "utf8"));
    file.engine.log[0].events = ["a round that never happened"];
    writeFileSync(statePath, JSON.stringify(file));

    assert.throws(() => new Arena({ statePath }), /log is broken|could not resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
