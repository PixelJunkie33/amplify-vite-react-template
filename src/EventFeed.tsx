/**
 * The arena's log, turned into something a human can skim.
 *
 * The server writes terse lines — `tag agent_1 -> agent_2 in long-hall` —
 * because the log is a record, not prose. This rewrites them into English and
 * swaps agent ids for names, without changing what they say. Anything it does
 * not recognise is shown verbatim rather than hidden, so a watcher always sees
 * everything the arena recorded.
 */

import { Fragment, useMemo } from "react";
import type { AgentView, LogEntryView } from "./api.ts";

export function EventFeed({
  entries,
  agents,
  verified,
}: {
  entries: LogEntryView[];
  agents: AgentView[];
  verified: { ok: boolean; brokeAt?: number };
}) {
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const recent = [...entries].reverse();

  return (
    <section className="panel">
      <h2>What just happened</h2>

      {!verified.ok && (
        <div className="banner warn">
          The log's hash chain does not verify — it breaks at entry{" "}
          {verified.brokeAt}. Treat the record below as untrustworthy.
        </div>
      )}

      {recent.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <ul className="feed">
          {recent.map((entry) => (
            <li key={entry.hash}>
              <div className="when">
                round {entry.round.toLocaleString()} ·{" "}
                {new Date(entry.at).toLocaleTimeString()}
              </div>
              {entry.events.map((event, i) => (
                <div className="line" key={i}>
                  <Line event={event} names={names} />
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Line({ event, names }: { event: string; names: Map<string, string> }) {
  const who = (id: string) => names.get(id) ?? id;
  const parts = event.split(" ");

  // `tag <a> -> <b> in <room>` — the only event worth emphasising.
  if (parts[0] === "tag" && parts[2] === "->") {
    return (
      <>
        <b>{who(parts[1])}</b> <em>tagged</em> <b>{who(parts[3])}</b>
        {parts[4] === "in" ? ` in ${parts[5].replace(/-/g, " ")}` : ""} — {who(parts[3])} is it
      </>
    );
  }
  if (parts[0] === "move" && parts[2] === "->") {
    return (
      <>
        <b>{who(parts[1])}</b> went to {parts[3].replace(/-/g, " ")}
      </>
    );
  }
  if (parts[0] === "ack" && parts[2] === "->") {
    return (
      <>
        <b>{who(parts[1])}</b> greeted <b>{who(parts[3])}</b>
      </>
    );
  }
  if (parts[0] === "join") {
    return (
      <>
        <b>{who(parts[1])}</b> joined the arena
      </>
    );
  }
  if (parts[0] === "it") {
    return (
      <>
        <b>{who(parts[1])}</b> <em>is it</em> — the ratio needed another chaser
      </>
    );
  }
  if (parts[0] === "free") {
    return (
      <>
        <b>{who(parts[1])}</b> is no longer it — the arena shrank
      </>
    );
  }
  if (parts[0] === "swept") {
    return (
      <>
        <b>{who(parts[1])}</b> was swept out of Home
        {parts[5] ? ` to ${parts[5].replace(/-/g, " ")}` : ""} for lingering
      </>
    );
  }
  if (parts[0] === "refused") {
    return (
      <>
        <b>{who(parts[1])}</b> tried to re-enter Home too soon
      </>
    );
  }
  if (parts[0] === "quit" || parts[0] === "left") {
    return (
      <>
        <b>{who(parts[1])}</b> left{event.includes("(was it)") ? ", while it" : ""}
      </>
    );
  }
  if (parts[0] === "dropped") {
    return (
      <>
        <b>{who(parts[1])}</b> went quiet and was dropped
      </>
    );
  }
  if (event.startsWith("no it acknowledged")) {
    return (
      <>
        nobody greeted <b>{who(parts[3])}</b> in time
      </>
    );
  }
  if (event === "quiet round") {
    return <span className="quiet">a quiet round — nobody moved</span>;
  }
  if (event === "paused") {
    return <span className="quiet">the arena is paused</span>;
  }

  // Unrecognised: show it exactly as the arena wrote it.
  return <Fragment>{event}</Fragment>;
}
