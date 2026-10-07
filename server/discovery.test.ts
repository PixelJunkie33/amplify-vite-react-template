/**
 * Tests for the two things that bring agents in: being findable, and being
 * invitable. Both run over real HTTP, because both are about what a stranger
 * sees when they arrive knowing nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { Arena } from "./store.ts";
import { createArenaServer } from "./http.ts";

const MANY_JOINS = { join: { capacity: 200, refillPerSecond: 50 } };

async function boot(opts: { admin?: string; inviteOnly?: boolean; manyJoins?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arena-disc-"));
  const arena = new Arena({
    statePath: join(dir, "arena.json"),
    inviteOnly: opts.inviteOnly ?? false,
    rules: { tickSeconds: 3600, idleRounds: 10_000, newcomerShield: 0 },
  });
  const server = createArenaServer({
    arena,
    adminToken: opts.admin,
    budgets: opts.manyJoins ? MANY_JOINS : undefined,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const read = async (res: Response) => {
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* HTML or plain text; keep the text */
    }
    return { status: res.status, body, text, headers: res.headers };
  };

  return {
    arena,
    base,
    get: (path: string, token?: string) =>
      fetch(base + path, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }).then(read),
    post: (path: string, payload?: unknown, token?: string) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }).then(read),
    async close() {
      arena.stop();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- discovery -----------------------------------------------------------

test("discovery: every discovery document answers", async () => {
  const h = await boot();
  try {
    for (const path of [
      "/.well-known/agent.json",
      "/.well-known/ai-plugin.json",
      "/llms.txt",
      "/robots.txt",
      "/sitemap.xml",
      "/invite.json",
    ]) {
      const res = await h.get(path);
      assert.equal(res.status, 200, `${path} answered ${res.status}`);
    }
  } finally {
    await h.close();
  }
});

test("discovery: the manifest says how to join and what the share is", async () => {
  const h = await boot();
  try {
    const m = (await h.get("/.well-known/agent.json")).body as Record<string, any>;
    assert.equal(m.audience, "autonomous agents");
    assert.equal(m.humansCanPlay, false);
    assert.equal(m.game.itPercent, 40);
    assert.match(m.game.share, /40% of the agents/);
    assert.match(m.joining.endpoint, /\/api\/join$/);
    assert.match(m.joining.instructions, /\/skill$/);
    assert.equal(m.joining.policy, "open");
    assert.equal(m.openToAgents, true);
  } finally {
    await h.close();
  }
});

test("discovery: the manifest reports an invite-only arena honestly", async () => {
  const h = await boot({ inviteOnly: true });
  try {
    const m = (await h.get("/.well-known/agent.json")).body as Record<string, any>;
    assert.equal(m.openToAgents, false);
    assert.equal(m.joining.policy, "invite-only");
    assert.ok("invite" in m.joining.body, "the example body asks for a code");
  } finally {
    await h.close();
  }
});

test("discovery: URLs follow the scheme and host the request arrived on", async () => {
  const h = await boot();
  try {
    // Plain http, no proxy headers.
    const plain = (await h.get("/.well-known/agent.json")).body as Record<string, any>;
    assert.match(plain.url, /^http:\/\/127\.0\.0\.1:/);

    // Behind a TLS-terminating proxy.
    const res = await fetch(h.base + "/.well-known/agent.json", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "tag.example.com" },
    });
    const proxied = (await res.json()) as Record<string, any>;
    assert.equal(proxied.url, "https://tag.example.com");
    assert.equal(proxied.joining.endpoint, "https://tag.example.com/api/join");
    assert.equal(proxied.api.observe.url, "https://tag.example.com/api/me");
  } finally {
    await h.close();
  }
});

test("discovery: llms.txt is https-correct behind a proxy too", async () => {
  const h = await boot();
  try {
    const res = await fetch(h.base + "/llms.txt", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "tag.example.com" },
    });
    const text = await res.text();
    assert.match(text, /https:\/\/tag\.example\.com\/api\/join/);
    assert.ok(!text.includes("http://tag.example.com"), "no http URLs leaked through");
  } finally {
    await h.close();
  }
});

test("discovery: robots.txt invites agents in rather than keeping them out", async () => {
  const h = await boot();
  try {
    const res = await h.get("/robots.txt");
    assert.match(res.text, /Allow: \//);
    assert.match(res.text, /\/skill/);
    assert.match(res.text, /Sitemap:/);
  } finally {
    await h.close();
  }
});

test("discovery: llms.txt states the share as a percentage", async () => {
  const h = await boot();
  try {
    const res = await h.get("/llms.txt");
    assert.match(res.text, /40% of the agents in the arena are it/);
    assert.match(res.text, /this is an invitation/i);
  } finally {
    await h.close();
  }
});

test("discovery: the sitemap lists every room", async () => {
  const h = await boot();
  try {
    const res = await h.get("/sitemap.xml");
    for (const room of h.arena.engine.map.ids()) {
      if (room === "home") continue;
      assert.match(res.text, new RegExp(`/room/${room}<`), `${room} missing`);
    }
  } finally {
    await h.close();
  }
});

test("discovery: every response carries a Link header to the manifest", async () => {
  const h = await boot();
  try {
    for (const path of ["/", "/api/state", "/rooms"]) {
      const link = (await h.get(path)).headers.get("link") ?? "";
      assert.match(link, /service-desc/, path);
      assert.match(link, /\/skill/, path);
    }
  } finally {
    await h.close();
  }
});

test("discovery: the pages link to the manifest in their markup", async () => {
  const h = await boot();
  try {
    const res = await h.get("/");
    assert.match(res.text, /rel="service-desc"/);
    assert.match(res.text, /href="\/llms\.txt"/);
    assert.match(res.text, /href="\/arena\.css"/);
  } finally {
    await h.close();
  }
});

test("discovery: the shared stylesheet is served", async () => {
  const h = await boot();
  try {
    const res = await h.get("/arena.css");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
    assert.match(res.text, /--it:/, "the design tokens are there");
  } finally {
    await h.close();
  }
});

// --- invitations ---------------------------------------------------------

test("invite: an open arena lets anyone in without a code", async () => {
  const h = await boot();
  try {
    assert.equal((await h.post("/api/join", { name: "Uninvited" })).status, 201);
  } finally {
    await h.close();
  }
});

test("invite: an invite-only arena refuses a join with no code", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    const res = await h.post("/api/join", { name: "Uninvited" });
    assert.equal(res.status, 403);
    assert.match((res.body as Record<string, any>).hint, /invite-only/);
  } finally {
    await h.close();
  }
});

test("invite: a minted code admits exactly one agent", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    const minted = await h.post("/api/admin/invite", { label: "a friend" }, "op");
    assert.equal(minted.status, 201);
    const code = (minted.body as Record<string, any>).code as string;
    assert.match(code, /^inv_/);

    assert.equal((await h.post("/api/join", { name: "Guest", invite: code })).status, 201);
    const second = await h.post("/api/join", { name: "Gatecrasher", invite: code });
    assert.equal(second.status, 403);
    assert.match((second.body as Record<string, any>).error, /used up/);
  } finally {
    await h.close();
  }
});

test("invite: a multi-use code admits exactly as many as it says", async () => {
  const h = await boot({ admin: "op", inviteOnly: true, manyJoins: true });
  try {
    const minted = await h.post("/api/admin/invite", { label: "a lab", uses: 3 }, "op");
    const code = (minted.body as Record<string, any>).code as string;
    for (let i = 0; i < 3; i++) {
      assert.equal(
        (await h.post("/api/join", { name: `Guest ${i}`, invite: code })).status,
        201,
        `join ${i}`,
      );
    }
    assert.equal(
      (await h.post("/api/join", { name: "One too many", invite: code })).status,
      403,
    );
  } finally {
    await h.close();
  }
});

test("invite: a revoked code stops working", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    const minted = await h.post("/api/admin/invite", { uses: 5 }, "op");
    const code = (minted.body as Record<string, any>).code as string;
    const prefix = (minted.body as Record<string, any>).invite.prefix as string;

    assert.equal((await h.post("/api/admin/invite/revoke", { prefix }, "op")).status, 200);
    const res = await h.post("/api/join", { name: "Revoked", invite: code });
    assert.equal(res.status, 403);
    assert.match((res.body as Record<string, any>).error, /revoked/);
  } finally {
    await h.close();
  }
});

test("invite: an expired code stops working", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    const minted = await h.post("/api/admin/invite", { expiresInHours: -1 }, "op");
    const code = (minted.body as Record<string, any>).code as string;
    const res = await h.post("/api/join", { name: "Late", invite: code });
    assert.equal(res.status, 403);
    assert.match((res.body as Record<string, any>).error, /expired/);
  } finally {
    await h.close();
  }
});

test("invite: a refused join creates nobody and spends nothing", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    const before = h.arena.engine.population();
    await h.post("/api/join", { name: "Nope", invite: "inv_madeup" });
    assert.equal(h.arena.engine.population(), before, "no agent was created");

    const minted = await h.post("/api/admin/invite", {}, "op");
    const code = (minted.body as Record<string, any>).code as string;
    assert.equal((await h.post("/api/join", { name: "Real", invite: code })).status, 201);
  } finally {
    await h.close();
  }
});

test("invite: the raw code never appears in the operator's listing", async () => {
  const h = await boot({ admin: "op" });
  try {
    const code = ((await h.post("/api/admin/invite", {}, "op")).body as Record<string, any>)
      .code as string;
    const listing = await h.get("/api/admin/invites", "op");
    assert.equal(listing.status, 200);
    assert.ok(!listing.text.includes(code), "the raw code leaked into the listing");
  } finally {
    await h.close();
  }
});

test("invite: minting needs the operator token", async () => {
  const h = await boot({ admin: "op" });
  try {
    assert.equal((await h.post("/api/admin/invite", {})).status, 403);
    assert.equal((await h.post("/api/admin/invite", {}, "wrong")).status, 403);
  } finally {
    await h.close();
  }
});

test("invite: checking a code needs no token", async () => {
  const h = await boot({ admin: "op" });
  try {
    const code = (
      (await h.post("/api/admin/invite", { label: "open day" }, "op")).body as Record<string, any>
    ).code as string;
    const res = await h.get(`/api/invite/${encodeURIComponent(code)}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as Record<string, any>).valid, true);
    assert.equal((res.body as Record<string, any>).label, "open day");

    const bogus = await h.get("/api/invite/inv_nonsense");
    assert.equal(bogus.status, 404);
    assert.equal((bogus.body as Record<string, any>).valid, false);
  } finally {
    await h.close();
  }
});

test("invite: the invitation page renders for a good code and a bad one", async () => {
  const h = await boot({ admin: "op" });
  try {
    const code = ((await h.post("/api/admin/invite", {}, "op")).body as Record<string, any>)
      .code as string;
    const good = await h.get(`/invite/${encodeURIComponent(code)}`);
    assert.equal(good.status, 200);
    assert.match(good.text, /You are invited to play tag/);
    assert.match(good.text, /api\/join/);

    const bad = await h.get("/invite/inv_nope");
    assert.equal(bad.status, 404);
    assert.match(bad.text, /cannot be used/);
  } finally {
    await h.close();
  }
});

test("invite: the operator can open and close the doors", async () => {
  const h = await boot({ admin: "op", inviteOnly: true });
  try {
    assert.equal((await h.post("/api/join", { name: "Early" })).status, 403);
    const opened = await h.post("/api/admin/doors", { inviteOnly: false }, "op");
    assert.equal((opened.body as Record<string, any>).policy, "open");
    assert.equal((await h.post("/api/join", { name: "Early" })).status, 201);
  } finally {
    await h.close();
  }
});

test("invite: invitations survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-invite-"));
  const statePath = join(dir, "arena.json");
  try {
    const first = new Arena({ statePath, inviteOnly: true, rules: { tickSeconds: 3600 } });
    const { code } = first.invites.mint({ label: "persisted", uses: 2 });
    first.save();

    const second = new Arena({ statePath, inviteOnly: true });
    assert.equal(second.invites.check(code), null, "the code still works after a restart");
    assert.equal(second.invites.list()[0].label, "persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
