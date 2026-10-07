/**
 * Engine self-tests. Run with `npm test`.
 *
 * Each test turns off the rules it is not about, so a pass means the named
 * rule did the work rather than some other rule happening to produce the
 * same outcome.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Engine, pairKey } from "./engine.ts";
import { DEFAULT_RULES, mergeRules, requiredIt } from "./rules.ts";
import { ArenaMap, HOME } from "./map.ts";

/** An engine with the clock and the housekeeping out of the way. */
function arena(overrides = {}) {
  return new Engine({ idleRounds: 10_000, newcomerShield: 0, ...overrides });
}

function populate(engine: Engine, count: number) {
  for (let i = 0; i < count; i++) engine.join(`a${i}`, `Agent ${i}`);
  return engine.roster();
}

/** Put two agents together in a room that is not safe. */
function gather(engine: Engine, ids: string[], room = "long-hall") {
  for (const id of ids) {
    const agent = engine.agent(id)!;
    agent.room = room;
    agent.shieldUntil = 0;
  }
}

// --- The ratio -----------------------------------------------------------

test("share: 40% asks for two its in a five-agent arena", () => {
  assert.equal(requiredIt(DEFAULT_RULES, 5), 2);
});

test("ratio: nobody is it in an empty or solo arena", () => {
  assert.equal(requiredIt(DEFAULT_RULES, 0), 0);
  assert.equal(requiredIt(DEFAULT_RULES, 1), 0);
});

test("share: two agents means exactly one it, the opening coin flip", () => {
  assert.equal(requiredIt(DEFAULT_RULES, 2), 1);
});

test("ratio: the required count never swallows the whole arena", () => {
  for (let n = 2; n < 60; n++) {
    const need = requiredIt(DEFAULT_RULES, n);
    assert.ok(need >= 1, `n=${n} must have an it`);
    assert.ok(need <= n - 1, `n=${n} must leave someone free`);
  }
});

test("share: the floor holds at every size", () => {
  for (let n = 2; n < 200; n++) {
    const it = requiredIt(DEFAULT_RULES, n);
    const free = n - it;
    assert.ok(
      3 * it >= 2 * free,
      `n=${n}: ${it} it vs ${free} free breaks the 40% share`,
    );
  }
});

test("ratio: it is the *smallest* count that satisfies the floor", () => {
  for (let n = 2; n < 200; n++) {
    const it = requiredIt(DEFAULT_RULES, n);
    if (it <= 1) continue;
    assert.ok(
      3 * (it - 1) < 2 * (n - it + 1),
      `n=${n}: ${it} its is one more than needed`,
    );
  }
});

test("share: a custom percentage is honoured", () => {
  const even = mergeRules({ itPercent: 50 });
  assert.equal(requiredIt(even, 10), 5);
  const sparse = mergeRules({ itPercent: 20 });
  assert.equal(requiredIt(sparse, 10), 2);
  const crowded = mergeRules({ itPercent: 75 });
  assert.equal(requiredIt(crowded, 8), 6);
});

test("share: 40% is a floor, so rounding never undershoots it", () => {
  for (let n = 2; n < 200; n++) {
    const it = requiredIt(DEFAULT_RULES, n);
    assert.ok(
      (it / n) * 100 >= DEFAULT_RULES.itPercent - 1e-9,
      `n=${n}: ${it} of ${n} is below the 40% floor`,
    );
  }
});

test("share: it is the smallest count that reaches the floor", () => {
  for (let n = 3; n < 200; n++) {
    const it = requiredIt(DEFAULT_RULES, n);
    if (it <= 1) continue;
    assert.ok(
      ((it - 1) / n) * 100 < DEFAULT_RULES.itPercent,
      `n=${n}: ${it} is one more it than the floor needs`,
    );
  }
});

test("ratio: the arena promotes as agents join", () => {
  const engine = arena();
  const expected = [0, 1, 2, 2, 2, 3, 3, 4, 4, 4];
  for (let n = 1; n <= 10; n++) {
    engine.join(`a${n}`, `Agent ${n}`);
    assert.equal(engine.ratio().it, expected[n - 1], `at ${n} agents`);
    assert.equal(engine.ratio().it, requiredIt(engine.rules, n));
  }
});

test("ratio: the arena demotes when agents leave", () => {
  const engine = arena();
  populate(engine, 10);
  assert.equal(engine.ratio().it, 4);
  for (const id of ["a0", "a1", "a2", "a3", "a4"]) engine.leave(id);
  assert.equal(engine.population(), 5);
  assert.equal(engine.ratio().it, 2);
});

test("ratio: losing an it refills the slot from the free agents", () => {
  const engine = arena();
  populate(engine, 5);
  const anIt = engine.roster().find((a) => a.isIt)!;
  engine.leave(anIt.id);
  assert.equal(engine.population(), 4);
  assert.equal(engine.ratio().it, requiredIt(engine.rules, 4));
});

test("ratio: promotion prefers whoever has been free longest", () => {
  const engine = arena();
  populate(engine, 5);
  // Hand-set the histories so there is a clear "longest free" agent.
  const free = engine.roster().filter((a) => !a.isIt);
  free.forEach((agent, i) => {
    agent.lastItRound = 100 + i;
  });
  const stalest = free[0].id;
  // Drop an it; the stalest free agent should be the one promoted.
  const anIt = engine.roster().find((a) => a.isIt)!;
  anIt.lastItRound = 0;
  engine.leave(anIt.id);
  assert.equal(engine.agent(stalest)!.isIt, true);
});

// --- Tagging -------------------------------------------------------------

test("tag: a successful tag swaps the two roles and keeps the count", () => {
  const engine = arena({ pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  gather(engine, [it.id, free.id]);
  const before = engine.ratio().it;

  engine.submit(it.id, { kind: "tag", target: free.id });
  engine.tick();

  assert.equal(engine.agent(it.id)!.isIt, false, "the tagger is released");
  assert.equal(engine.agent(free.id)!.isIt, true, "the target takes it on");
  assert.equal(engine.ratio().it, before, "the ratio is undisturbed");
});

test("tag: a free agent cannot tag", () => {
  const engine = arena();
  populate(engine, 5);
  const free = engine.roster().filter((a) => !a.isIt);
  gather(engine, [free[0].id, free[1].id]);
  assert.throws(
    () => engine.submit(free[0].id, { kind: "tag", target: free[1].id }),
    /only an it may tag/,
  );
});

test("tag: no reach across rooms", () => {
  const engine = arena();
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  it.room = "long-hall";
  free.room = "orchard";
  free.shieldUntil = 0;

  engine.submit(it.id, { kind: "tag", target: free.id });
  engine.tick();
  assert.equal(engine.agent(free.id)!.isIt, false);
});

test("tag: Home is safe", () => {
  const engine = arena();
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  gather(engine, [it.id, free.id], HOME);

  engine.submit(it.id, { kind: "tag", target: free.id });
  engine.tick();
  assert.equal(engine.agent(free.id)!.isIt, false, "nobody is tagged at Home");
});

test("tag: you may move and tag in the same round", () => {
  const engine = arena({ pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  it.room = HOME;
  free.room = "long-hall";
  free.shieldUntil = 0;
  assert.ok(engine.map.adjacent(HOME, "long-hall"));

  engine.submit(it.id, { kind: "move", to: "long-hall", tag: free.id });
  engine.tick();
  assert.equal(engine.agent(free.id)!.isIt, true, "the chase lands in one round");
});

test("tag: immunity protects an agent for a round after they tag", () => {
  const engine = arena({ pairCooldown: 0, immunity: 1 });
  populate(engine, 5);
  const [x, y, z] = engine.roster().map((a) => a.id);
  // x and z are its, y is free.
  for (const id of [x, y, z]) engine.agent(id)!.isIt = false;
  engine.agent(x)!.isIt = true;
  engine.agent(z)!.isIt = true;
  gather(engine, [x, y, z]);

  engine.submit(x, { kind: "tag", target: y });
  engine.tick();
  assert.equal(engine.agent(y)!.isIt, true);
  assert.equal(engine.agent(x)!.isIt, false);
  assert.ok(engine.agent(x)!.immuneUntil > engine.round - 1);

  // z should not be able to immediately tag the freshly-released x.
  engine.submit(z, { kind: "tag", target: x });
  engine.tick();
  assert.equal(engine.agent(x)!.isIt, false, "immunity held");
});

test("tag: a pair cannot trade it back and forth inside the cooldown", () => {
  const engine = arena({ pairCooldown: 15, immunity: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  gather(engine, [it.id, free.id]);

  engine.submit(it.id, { kind: "tag", target: free.id });
  engine.tick();
  assert.equal(engine.agent(free.id)!.isIt, true);

  // Now the roles are reversed; the new it tries to tag straight back.
  gather(engine, [it.id, free.id]);
  engine.submit(free.id, { kind: "tag", target: it.id });
  engine.tick();
  assert.equal(engine.agent(it.id)!.isIt, false, "the tag-back is refused");

  const until = engine.observe(free.id).round;
  assert.ok(until < 15 + 2, "sanity: still inside the cooldown window");
});

test("tag: two its cannot both claim the same target in one round", () => {
  const engine = arena({ pairCooldown: 0, immunity: 0 });
  populate(engine, 5);
  const its = engine.roster().filter((a) => a.isIt);
  assert.equal(its.length, 2, "a 40% share gives us two its to work with");
  const free = engine.roster().find((a) => !a.isIt)!;
  gather(engine, [its[0].id, its[1].id, free.id]);

  engine.submit(its[0].id, { kind: "tag", target: free.id });
  engine.submit(its[1].id, { kind: "tag", target: free.id });
  engine.tick();

  assert.equal(engine.agent(free.id)!.isIt, true);
  const stillIt = [its[0].id, its[1].id].filter((id) => engine.agent(id)!.isIt);
  assert.equal(stillIt.length, 1, "only the first reach counts");
});

test("tag: an it is never tagged into being it twice", () => {
  const engine = arena({ pairCooldown: 0 });
  populate(engine, 5);
  const its = engine.roster().filter((a) => a.isIt);
  gather(engine, [its[0].id, its[1].id]);
  engine.submit(its[0].id, { kind: "tag", target: its[1].id });
  engine.tick();
  assert.equal(engine.agent(its[0].id)!.isIt, true, "the pointless tag changed nothing");
});

// --- Newcomers -----------------------------------------------------------

test("newcomer: cannot be tagged before an it acknowledges them", () => {
  const engine = new Engine({ idleRounds: 10_000, newcomerShield: 5 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  engine.join("new", "Newcomer");
  const newcomer = engine.agent("new")!;
  if (newcomer.isIt) {
    newcomer.isIt = false; // the ratio may have drafted them; this test is about the shield
  }
  it.isIt = true;
  it.room = "long-hall";
  newcomer.room = "long-hall";

  engine.submit(it.id, { kind: "tag", target: "new" });
  engine.tick();
  assert.equal(engine.agent("new")!.isIt, false, "the shield held");
});

test("newcomer: acknowledgement drops the shield and opens them to a tag", () => {
  const engine = new Engine({ idleRounds: 10_000, newcomerShield: 5, pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  engine.join("new", "Newcomer");
  const newcomer = engine.agent("new")!;
  newcomer.isIt = false;
  it.isIt = true;
  it.room = "long-hall";
  newcomer.room = "long-hall";

  engine.submit(it.id, { kind: "ack", agent: "new" });
  engine.tick();
  assert.ok(engine.agent("new")!.ackedBy.includes(it.id));

  engine.submit(it.id, { kind: "tag", target: "new" });
  engine.tick();
  assert.equal(engine.agent("new")!.isIt, true, "greeted, then tagged");
});

test("newcomer: the shield expires on its own, so stalling buys nothing", () => {
  const engine = new Engine({ idleRounds: 10_000, newcomerShield: 2, pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  engine.join("new", "Newcomer");
  const newcomer = engine.agent("new")!;
  newcomer.isIt = false;
  it.isIt = true;

  engine.tick();
  engine.tick();
  it.room = "long-hall";
  engine.agent("new")!.room = "long-hall";
  engine.submit(it.id, { kind: "tag", target: "new" });
  engine.tick();
  assert.equal(engine.agent("new")!.isIt, true, "shield lapsed without an ack");
});

test("newcomer: an unanswered greeting is written to the log", () => {
  const engine = new Engine({ idleRounds: 10_000, ackGrace: 2, newcomerShield: 0 });
  populate(engine, 5);
  engine.join("new", "Newcomer");
  engine.tick();
  engine.tick();
  const text = engine.tail(20).flatMap((e) => e.events).join("\n");
  assert.match(text, /no it acknowledged new/);
});

// --- Home ----------------------------------------------------------------

test("home: standing there too long gets you swept out", () => {
  const engine = arena({ maxHomeStay: 2 });
  populate(engine, 5);
  const runner = engine.roster().find((a) => !a.isIt)!;
  runner.room = HOME;

  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  assert.equal(engine.agent(runner.id)!.room, HOME, "two rounds is allowed");

  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  assert.notEqual(engine.agent(runner.id)!.room, HOME, "the third round sweeps you");
});

test("home: after a sweep you cannot walk straight back in", () => {
  const engine = arena({ maxHomeStay: 1, homeCooldown: 3 });
  populate(engine, 5);
  const runner = engine.roster().find((a) => !a.isIt)!;
  runner.room = HOME;

  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  const after = engine.agent(runner.id)!;
  assert.notEqual(after.room, HOME);
  assert.ok(after.homeBlockedUntil > engine.round, "the door is shut for a few rounds");

  engine.submit(runner.id, { kind: "move", to: HOME });
  engine.tick();
  assert.notEqual(engine.agent(runner.id)!.room, HOME, "re-entry refused");
  assert.equal(engine.observe(runner.id).you.canEnterHome, false);
});

test("home: the cooldown does lapse", () => {
  const engine = arena({ maxHomeStay: 1, homeCooldown: 2 });
  populate(engine, 5);
  const runner = engine.roster().find((a) => !a.isIt)!;
  runner.room = HOME;
  engine.submit(runner.id, { kind: "stay" });
  engine.tick();
  engine.submit(runner.id, { kind: "stay" });
  engine.tick();

  for (let i = 0; i < 3; i++) engine.tick();
  assert.equal(engine.observe(runner.id).you.canEnterHome, true);
});

// --- Moving --------------------------------------------------------------

test("move: you can only walk through a door", () => {
  const engine = arena();
  populate(engine, 2);
  const agent = engine.roster()[0];
  const notAdjacent = engine.map
    .ids()
    .find((id) => id !== agent.room && !engine.map.adjacent(agent.room, id))!;
  assert.throws(() => engine.submit(agent.id, { kind: "move", to: notAdjacent }), /no door/);
});

test("move: footprints appear where someone has just been", () => {
  const engine = arena({ footprintTtl: 2 });
  populate(engine, 2);
  const agent = engine.roster()[0];
  engine.submit(agent.id, { kind: "move", to: "long-hall" });
  engine.tick();
  assert.ok(
    engine.footprintsIn(HOME).some((f) => f.agent === agent.id),
    "a footprint is left behind, not carried along",
  );
});

test("move: footprints fade", () => {
  const engine = arena({ footprintTtl: 1 });
  populate(engine, 2);
  const agent = engine.roster()[0];
  engine.submit(agent.id, { kind: "move", to: "long-hall" });
  engine.tick();
  for (let i = 0; i < 4; i++) engine.tick();
  assert.equal(engine.footprintsIn(HOME).length, 0);
});

// --- Leaving -------------------------------------------------------------

test("quit: an it that quits has its slot refilled by the ratio", () => {
  const engine = arena();
  populate(engine, 6);
  const it = engine.roster().find((a) => a.isIt)!;
  engine.submit(it.id, { kind: "quit" });
  engine.tick();
  assert.equal(engine.agent(it.id), undefined);
  assert.equal(engine.ratio().it, requiredIt(engine.rules, engine.population()));
});

test("quit: quitting does not dodge a tag already reached for", () => {
  const engine = arena({ pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  gather(engine, [it.id, free.id]);
  engine.submit(it.id, { kind: "tag", target: free.id });
  engine.submit(free.id, { kind: "quit" });
  engine.tick();
  // The target is gone, but they left as it, and the ratio has refilled.
  assert.equal(engine.agent(free.id), undefined);
  assert.equal(engine.agent(it.id)!.isIt, false, "the tag counted");
  assert.equal(engine.ratio().it, requiredIt(engine.rules, engine.population()));
});

test("idle: an agent that stops submitting is dropped", () => {
  const engine = new Engine({ idleRounds: 3, newcomerShield: 0 });
  populate(engine, 5);
  const quiet = engine.roster()[0].id;
  for (let i = 0; i < 5; i++) {
    for (const agent of engine.roster()) {
      if (agent.id !== quiet) engine.submit(agent.id, { kind: "stay" });
    }
    engine.tick();
  }
  assert.equal(engine.agent(quiet), undefined);
  assert.equal(engine.ratio().it, requiredIt(engine.rules, engine.population()));
});

// --- Observations --------------------------------------------------------

test("observe: taggable lists exactly who you may reach", () => {
  const engine = arena({ pairCooldown: 0 });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const frees = engine.roster().filter((a) => !a.isIt);
  gather(engine, [it.id, frees[0].id]);
  const view = engine.observe(it.id);
  assert.deepEqual(view.taggable, [frees[0].id]);

  const runnerView = engine.observe(frees[0].id);
  assert.deepEqual(runnerView.taggable, [], "a runner has nobody to tag");
});

test("observe: the pulse counts its one room away", () => {
  const engine = arena({ pulse: true });
  populate(engine, 5);
  const it = engine.roster().find((a) => a.isIt)!;
  const free = engine.roster().find((a) => !a.isIt)!;
  free.room = "long-hall";
  it.room = HOME;
  assert.ok(engine.map.adjacent("long-hall", HOME));
  assert.ok(engine.observe(free.id).pulse! >= 1);
});

test("observe: the pulse can be switched off", () => {
  const engine = arena({ pulse: false });
  populate(engine, 5);
  const free = engine.roster().find((a) => !a.isIt)!;
  assert.equal(engine.observe(free.id).pulse, null);
});

test("observe: the ratio is reported honestly", () => {
  const engine = arena();
  populate(engine, 7);
  const view = engine.observe("a0");
  assert.equal(view.ratio.population, 7);
  assert.equal(view.ratio.it + view.ratio.free, 7);
  assert.equal(view.ratio.requiredIt, requiredIt(engine.rules, 7));
  assert.equal(view.ratio.target, "40% of agents are it");
  assert.equal(view.ratio.targetPercent, 40);
});

// --- The log -------------------------------------------------------------

test("log: the chain verifies", () => {
  const engine = arena();
  populate(engine, 5);
  for (let i = 0; i < 10; i++) {
    for (const agent of engine.roster()) engine.submit(agent.id, { kind: "stay" });
    engine.tick();
  }
  assert.deepEqual(engine.verifyLog(), { ok: true });
});

test("log: an edited entry is caught", () => {
  const engine = arena();
  populate(engine, 3);
  engine.tick();
  const snapshot = engine.snapshot();
  snapshot.log[1].events = ["something that never happened"];
  const tampered = Engine.restore(snapshot);
  const result = tampered.verifyLog();
  assert.equal(result.ok, false);
  assert.equal(result.brokeAt, 1);
});

// --- Save and resume -----------------------------------------------------

test("state: an arena resumes identically", () => {
  const engine = arena();
  populate(engine, 6);
  for (let i = 0; i < 5; i++) {
    for (const agent of engine.roster()) engine.submit(agent.id, { kind: "stay" });
    engine.tick();
  }
  const resumed = Engine.restore(JSON.parse(JSON.stringify(engine.snapshot())));
  assert.equal(resumed.round, engine.round);
  assert.equal(resumed.head, engine.head);
  assert.deepEqual(resumed.roster(), engine.roster());
  assert.deepEqual(resumed.verifyLog(), { ok: true });
});

test("state: a paused arena refuses actions and does not advance play", () => {
  const engine = arena();
  populate(engine, 5);
  engine.paused = true;
  assert.throws(() => engine.submit("a0", { kind: "stay" }), /paused/);
  const before = engine.roster().map((a) => `${a.id}:${a.isIt}:${a.room}`);
  engine.tick();
  assert.deepEqual(engine.roster().map((a) => `${a.id}:${a.isIt}:${a.room}`), before);
});

// --- The map -------------------------------------------------------------

test("map: every room has at least three doors and none is a dead end", () => {
  const map = new ArenaMap(16);
  for (const id of map.ids()) {
    assert.ok(map.doors(id).length >= 3, `${id} has too few doors`);
    assert.ok(!map.doors(id).includes(id), `${id} loops to itself`);
  }
});

test("map: doors are mutual", () => {
  const map = new ArenaMap(16);
  for (const a of map.ids()) {
    for (const b of map.doors(a)) {
      assert.ok(map.adjacent(b, a), `${a}->${b} is one-way`);
    }
  }
});

test("map: the whole arena is reachable from Home", () => {
  const map = new ArenaMap(16);
  const seen = new Set([HOME]);
  const queue = [HOME];
  while (queue.length) {
    for (const door of map.doors(queue.shift()!)) {
      if (!seen.has(door)) {
        seen.add(door);
        queue.push(door);
      }
    }
  }
  assert.equal(seen.size, map.roomCount);
});

test("map: Home is the only safe room", () => {
  const map = new ArenaMap(16);
  assert.deepEqual(map.ids().filter((id) => map.isSafe(id)), [HOME]);
});

// --- Odds and ends -------------------------------------------------------

test("pairKey is order-independent", () => {
  assert.equal(pairKey("b", "a"), pairKey("a", "b"));
});

test("join: the same id cannot join twice", () => {
  const engine = arena();
  engine.join("a", "A");
  assert.throws(() => engine.join("a", "A again"), /already here/);
});

test("a long game keeps the ratio satisfied every single round", () => {
  const engine = new Engine({ idleRounds: 10_000, newcomerShield: 1 });
  let next = 0;
  for (let round = 0; round < 400; round++) {
    // Churn: somebody joins or leaves now and then.
    if (round % 7 === 0) engine.join(`p${next++}`, `Player ${next}`);
    if (round % 23 === 0 && engine.population() > 3) {
      engine.leave(engine.roster()[0].id);
    }

    for (const agent of engine.roster()) {
      const view = engine.observe(agent.id);
      if (view.awaitingAck.length) {
        engine.submit(agent.id, { kind: "ack", agent: view.awaitingAck[0] });
      } else if (view.taggable.length) {
        engine.submit(agent.id, { kind: "tag", target: view.taggable[0] });
      } else {
        const doors = view.doors.filter((d) => d.id !== "home" || view.you.canEnterHome);
        const door = doors[round % doors.length];
        engine.submit(agent.id, { kind: "move", to: door.id });
      }
    }
    engine.tick();

    const r = engine.ratio();
    assert.equal(r.it, r.requiredIt, `round ${round}: ${r.it} its, needed ${r.requiredIt}`);
    assert.ok(
      r.population < 2 || 3 * r.it >= 2 * r.free,
      `round ${round}: ${r.it}:${r.free} breaks the 40% share`,
    );
  }
  assert.deepEqual(engine.verifyLog(), { ok: true });
});
