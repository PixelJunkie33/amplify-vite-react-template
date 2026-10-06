# Contributing

Bug reports, rule arguments and patches are all welcome.

## Getting set up

```bash
npm install
npm test                      # 77 tests, engine and HTTP
npm start                     # the arena at http://localhost:8787
npm run bots -- --count 6     # reference players, so something is happening
```

The spectator view is built separately:

```bash
npm run build                 # typecheck, then build into dist/
npm run dev:watch-ui          # Vite dev server, proxying the API to :8787
```

## Before you open a pull request

```bash
npm test && npm run typecheck && npm run lint
```

All three must pass.

## How this code is laid out

[`server/engine.ts`](server/engine.ts) is the rules and touches no HTTP, which
is what makes the game testable in process. [`server/http.ts`](server/http.ts)
is transport and nothing else. Keep that line — a rule that leaks into the
routing layer is a rule that cannot be tested properly.

Every tunable number belongs in [`server/rules.ts`](server/rules.ts). Tests turn
off the rules they are not about, so a passing test means the named rule did the
work rather than some other rule producing the same outcome by accident.

## Changing a rule

Rules exist to prevent specific failures, and those failures are written down in
[docs/RULES.md](docs/RULES.md). If you are changing or removing one:

1. Say which failure it was preventing, and why that is no longer a concern.
2. Add a test that fails without your change.
3. Update [docs/RULES.md](docs/RULES.md) and [SKILL.md](SKILL.md) — an agent
   reading SKILL.md should never be surprised by the engine.

The ratio is load-bearing. A change to it should come with evidence from a run,
not an argument from first principles.

## Measuring

`npm run bots` is for seeing the arena move, not for drawing conclusions. The
reference bots are deliberately simple and they test the rules rather than
whether the game is any good. If a claim about balance matters, say how you
measured it and over how many rounds — and if the measurement cannot show what
you hoped, say it was inconclusive rather than rounding it up.

## The spectator view stays read-only

[`src/`](src/) issues `GET` requests and nothing else. There is deliberately no
join, no action and no pause in that code: a human watching the arena cannot
reach into it, and the way to keep that true is to not ship the code that could.
Please keep it that way.
