/**
 * The HTTP surface: a JSON API for agents, plain HTML pages for everyone.
 *
 * Built on node:http with no dependencies. Every state-changing route is a
 * POST behind a bearer token — a GET never changes anything, because a
 * state-changing GET is something a crawler, a link preview or a prefetcher
 * will trip over by accident.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { Arena } from "./store.ts";
import { type Action } from "./engine.ts";
import { BUDGETS, RateLimiter } from "./ratelimit.ts";
import {
  renderHome,
  renderLog,
  renderNotFound,
  renderRoom,
  renderRooms,
  renderRules,
  renderWho,
} from "./pages.ts";

const MAX_BODY = 8 * 1024; // an action is tiny; anything larger is a mistake

/** An error that already knows which status code it deserves. */
interface HttpError extends Error {
  status: number;
}

function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  return err;
}

export interface ServerOptions {
  arena: Arena;
  /** Shared secret for the operator routes. Unset disables them entirely. */
  adminToken?: string;
  /** Directory of built spectator assets (Vite output). Optional. */
  staticDir?: string;
  /** Path to SKILL.md, served at /skill. */
  skillPath?: string;
  /**
   * Rate-limit budgets. Defaults are in ratelimit.ts. An operator running a
   * private arena for a handful of invited agents will want the join budget
   * loosened; the tests loosen it too.
   */
  budgets?: Partial<typeof BUDGETS>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
};

export function createArenaServer(options: ServerOptions) {
  const { arena } = options;
  const budgets = { ...BUDGETS, ...options.budgets };
  const limiter = new RateLimiter();
  setInterval(() => limiter.sweep(), 5 * 60 * 1000).unref?.();

  // --- helpers ----------------------------------------------------------

  const send = (
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    type = "text/plain; charset=utf-8",
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      "content-type": type,
      "content-length": Buffer.byteLength(body),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    res.end(body);
  };

  const json = (
    res: ServerResponse,
    status: number,
    payload: unknown,
    extra: Record<string, string> = {},
  ) => send(res, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8", extra);

  const html = (res: ServerResponse, status: number, markup: string) =>
    send(res, status, markup, "text/html; charset=utf-8");

  const fail = (res: ServerResponse, status: number, message: string, hint?: string) =>
    json(res, status, { error: message, ...(hint ? { hint } : {}) });

  const bearer = (req: IncomingMessage): string | null => {
    const header = req.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && value ? value.trim() : null;
  };

  const clientKey = (req: IncomingMessage): string => {
    // Behind a reverse proxy, trust its forwarded address; see docs/DEPLOY.md
    // for why the proxy must overwrite rather than append this header.
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return (first?.split(",")[0].trim() || req.socket.remoteAddress || "unknown");
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolveBody, rejectBody) => {
      let size = 0;
      let over = false;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          // Stop collecting but keep draining, so the client actually
          // receives the response instead of a dropped socket. Only a
          // genuinely abusive body gets the connection cut.
          over = true;
          chunks.length = 0;
          if (size > 1_000_000) req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (over) return rejectBody(httpError(413, "the request body is too large"));
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolveBody({});
        try {
          resolveBody(JSON.parse(raw));
        } catch {
          rejectBody(httpError(400, "the request body is not valid JSON"));
        }
      });
      req.on("error", rejectBody);
    });

  /** Spend a rate-limit token, or answer 429 and return false. */
  const spend = (
    res: ServerResponse,
    budget: (typeof BUDGETS)[keyof typeof BUDGETS],
    key: string,
    hint = "",
  ): boolean => {
    const result = limiter.take(key, budget);
    if (result.ok) return true;
    json(
      res,
      429,
      {
        error: "slow down",
        hint: `Wait ${result.retryAfter}s.${hint ? ` ${hint}` : ""}`,
        retryAfter: result.retryAfter,
      },
      { "retry-after": String(result.retryAfter) },
    );
    return false;
  };

  /** Resolve the caller's agent, or answer 401. */
  const authed = (req: IncomingMessage, res: ServerResponse): string | null => {
    const agentId = arena.resolveToken(bearer(req));
    if (!agentId) {
      fail(
        res,
        401,
        "a bearer token is required",
        "POST /api/join to get one. Send it as `Authorization: Bearer <token>`.",
      );
      return null;
    }
    if (!arena.engine.agent(agentId)) {
      fail(res, 401, "you are no longer in the arena", "POST /api/join to come back.");
      return null;
    }
    return agentId;
  };

  const isAdmin = (req: IncomingMessage): boolean =>
    Boolean(options.adminToken) && bearer(req) === options.adminToken;

  // --- static assets ----------------------------------------------------

  const serveStatic = (res: ServerResponse, urlPath: string): boolean => {
    if (!options.staticDir) return false;
    const root = resolve(options.staticDir);
    const target = resolve(join(root, normalize(urlPath)));
    // Containment check: never serve a path that escapes the asset root.
    if (target !== root && !target.startsWith(root + sep)) return false;
    if (!existsSync(target) || !statSync(target).isFile()) return false;
    const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=300" });
    createReadStream(target).pipe(res);
    return true;
  };

  // --- the server -------------------------------------------------------

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const ip = clientKey(req);
    const engine = arena.engine;

    // CORS: read-only, so a browser-based spectator page can be hosted apart
    // from the arena. No credentials, so a token never rides along.
    res.setHeader("access-control-allow-origin", "*");
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      });
      return res.end();
    }

    try {
      // === agent API ====================================================

      if (path === "/api/join" && method === "POST") {
        if (!spend(res, budgets.join, `join:${ip}`,
            "Joining is rate limited per address. Retry once; do not loop.")) return;
        const body = (await readBody(req)) as { name?: string; operator?: string };
        const name = String(body.name ?? "").trim();
        if (!name || name.length > 40) {
          return fail(res, 400, "a `name` of 1 to 40 characters is required");
        }
        if (!/^[\w .'-]+$/u.test(name)) {
          return fail(res, 400, "a name may use letters, numbers, spaces, . ' - and _");
        }
        if (arena.nameTaken(name)) {
          return fail(res, 409, `the name "${name}" is already in play`, "One agent, one identity.");
        }
        if (engine.paused) {
          return fail(res, 503, "the arena is paused", "Try again shortly.");
        }

        const id = `agent_${randomUUID().slice(0, 8)}`;
        const agent = engine.join(id, name);
        const token = arena.issueToken(id, body.operator ? String(body.operator) : undefined);
        arena.save();
        return json(res, 201, {
          agent: { id: agent.id, name: agent.name, isIt: agent.isIt, room: agent.room },
          token,
          tokenNote: "Shown once. Keep it; it is how the arena knows you.",
          round: engine.round,
          ratio: engine.ratio(),
          next: {
            observe: "GET /api/me",
            act: "POST /api/action",
            rules: "GET /api/rules",
          },
          welcome: agent.isIt
            ? "The ratio made you it on arrival. Go and chase."
            : "You are not it. Keep it that way.",
        });
      }

      if (path === "/api/me" && method === "GET") {
        const agentId = authed(req, res);
        if (!agentId) return;
        if (!spend(res, budgets.read, `read:${agentId}`,
            "Read once per round; the round clock is the only thing that moves.")) return;
        return json(res, 200, engine.observe(agentId));
      }

      if (path === "/api/action" && method === "POST") {
        const agentId = authed(req, res);
        if (!agentId) return;
        if (!spend(res, budgets.write, `write:${agentId}`,
            "One action per round is all the arena accepts.")) return;
        if (engine.paused) return fail(res, 503, "the arena is paused");

        const body = (await readBody(req)) as Partial<Action> & { kind?: string };
        if (!body.kind) {
          return fail(
            res,
            400,
            "an action needs a `kind`",
            'One of "move", "tag", "ack", "stay", "quit".',
          );
        }
        try {
          engine.submit(agentId, body as Action);
        } catch (err) {
          return fail(res, 422, (err as Error).message);
        }
        return json(res, 202, {
          accepted: body,
          note: "Queued for this round. Resolution lands when the round ticks.",
          round: engine.round,
          resolvesInSeconds: engine.rules.tickSeconds,
          observation: engine.observe(agentId),
        });
      }

      if (path === "/api/leave" && method === "POST") {
        const agentId = authed(req, res);
        if (!agentId) return;
        if (!spend(res, budgets.write, `write:${agentId}`,
            "One action per round is all the arena accepts.")) return;
        engine.leave(agentId, "left");
        arena.revokeToken(agentId);
        arena.save();
        return json(res, 200, { left: true, ratio: engine.ratio() });
      }

      // === public reads =================================================

      if (path === "/api/state" && method === "GET") {
        if (!spend(res, budgets.read, `read:${ip}`,
            "Read once per round; the round clock is the only thing that moves.")) return;
        return json(res, 200, {
          round: engine.round,
          paused: engine.paused,
          ratio: engine.ratio(),
          tickSeconds: engine.rules.tickSeconds,
          logHead: engine.head,
          logLength: engine.logLength(),
          agents: engine.roster().map((a) => ({
            id: a.id,
            name: a.name,
            isIt: a.isIt,
            room: a.room,
            joinedRound: a.joinedRound,
          })),
          rooms: engine.map.ids().map((id) => ({
            id,
            safe: engine.map.isSafe(id),
            doors: engine.map.doors(id),
            occupants: engine.occupantsOf(id).length,
            its: engine.occupantsOf(id).filter((a) => a.isIt).length,
          })),
        });
      }

      if (path === "/api/rules" && method === "GET") {
        if (!spend(res, budgets.read, `read:${ip}`,
            "Read once per round; the round clock is the only thing that moves.")) return;
        return json(res, 200, {
          rules: engine.rules,
          ratio: {
            statement:
              `For every ${engine.rules.ratioFree} agents that are not it, ` +
              `at least ${engine.rules.ratioIt} must be it.`,
            formula: "requiredIt = max(1, min(ceil(n * 2 / 5), n - 1))",
            table: [2, 3, 4, 5, 6, 8, 10, 12, 20].map((n) => ({
              agents: n,
              it: Math.max(1, Math.min(Math.ceil((n * engine.rules.ratioIt) /
                (engine.rules.ratioIt + engine.rules.ratioFree)), n - 1)),
            })),
          },
          map: engine.map.ids().map((id) => ({
            id,
            safe: engine.map.isSafe(id),
            doors: engine.map.doors(id),
          })),
        });
      }

      if (path === "/api/log" && method === "GET") {
        if (!spend(res, budgets.read, `read:${ip}`,
            "Read once per round; the round clock is the only thing that moves.")) return;
        const asked = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 1000) : 0;
        return json(res, 200, {
          head: engine.head,
          length: engine.logLength(),
          verified: engine.verifyLog(),
          entries: limit ? engine.tail(limit) : engine.tail(engine.logLength()),
        });
      }

      if (path === "/api/health" && method === "GET") {
        return json(res, 200, {
          ok: true,
          round: engine.round,
          agents: engine.population(),
          paused: engine.paused,
          log: engine.verifyLog(),
        });
      }

      // === operator =====================================================

      if (path.startsWith("/api/admin/")) {
        if (!options.adminToken) {
          return fail(res, 404, "no operator routes are enabled on this arena");
        }
        if (!isAdmin(req)) return fail(res, 403, "the operator token does not match");

        if (path === "/api/admin/pause" && method === "POST") {
          const body = (await readBody(req)) as { paused?: boolean };
          engine.paused = body.paused !== false;
          arena.save();
          return json(res, 200, { paused: engine.paused });
        }
        if (path === "/api/admin/kick" && method === "POST") {
          const body = (await readBody(req)) as { agent?: string; reason?: string };
          if (!body.agent) return fail(res, 400, "`agent` is required");
          engine.leave(body.agent, body.reason ?? "removed by the operator");
          arena.revokeToken(body.agent);
          arena.save();
          return json(res, 200, { removed: body.agent, ratio: engine.ratio() });
        }
        return fail(res, 404, `no such operator route: ${path}`);
      }

      // === pages ========================================================

      if (method === "GET") {
        if (path === "/") return html(res, 200, renderHome(engine));
        if (path === "/rooms") return html(res, 200, renderRooms(engine));
        if (path === "/who") return html(res, 200, renderWho(engine));
        if (path === "/rules") return html(res, 200, renderRules(engine));
        if (path === "/log") return html(res, 200, renderLog(engine, engine.tail(100)));

        if (path.startsWith("/room/")) {
          const roomId = decodeURIComponent(path.slice("/room/".length));
          if (roomId === "home") {
            res.writeHead(302, { location: "/" });
            return res.end();
          }
          if (!engine.map.has(roomId)) return html(res, 404, renderNotFound(path));
          return html(res, 200, renderRoom(engine, roomId));
        }

        if (path === "/skill" || path === "/skill.md" || path === "/SKILL.md") {
          const skillPath = options.skillPath ?? join(process.cwd(), "SKILL.md");
          if (!existsSync(skillPath)) return fail(res, 404, "SKILL.md is not installed");
          return send(res, 200, readFileSync(skillPath), "text/markdown; charset=utf-8");
        }

        // The spectator view, and its assets.
        if (path === "/watch" && options.staticDir) {
          if (serveStatic(res, "index.html")) return;
        }
        if (serveStatic(res, path)) return;
        if (path === "/watch") {
          return html(
            res,
            200,
            renderNotFound("/watch").replace(
              "No such room",
              "The live view is not built yet",
            ),
          );
        }

        return html(res, 404, renderNotFound(path));
      }

      return fail(res, 405, `${method} is not allowed on ${path}`);
    } catch (err) {
      const status = (err as HttpError).status;
      if (status) return fail(res, status, (err as Error).message);
      // Anything unlabelled is our bug, not the caller's. Log it here and
      // tell the caller nothing about our internals.
      console.error("[arena]", err);
      return fail(res, 500, "the arena stumbled", "The operator has been shown the details.");
    }
  });
}
