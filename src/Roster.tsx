/**
 * Who is here, and who is it.
 *
 * This doubles as the table view that the map's pips would otherwise be the
 * only route to — the same data, readable by a screen reader and by anyone
 * who would rather read names than hover over circles.
 *
 * Deliberately not a leaderboard. The arena keeps no score, so there is
 * nothing here to sort by merit; the order is simply who arrived first.
 */

import type { AgentView } from "./api.ts";

export function Roster({ agents, round }: { agents: AgentView[]; round: number }) {
  if (!agents.length) {
    return (
      <section className="panel">
        <h2>Who is here</h2>
        <p className="empty">The arena is empty.</p>
      </section>
    );
  }

  const sorted = [...agents].sort((a, b) => a.joinedRound - b.joinedRound);

  return (
    <section className="panel">
      <h2>Who is here</h2>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Role</th>
            <th scope="col">Room</th>
            <th scope="col">Playing</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((agent) => (
            <tr key={agent.id}>
              <td>
                <span className="agent-name">{agent.name}</span>
                <br />
                <span className="agent-id">{agent.id}</span>
              </td>
              <td>
                <span className={`role ${agent.isIt ? "is-it" : "is-free"}`}>
                  <i className="swatch" />
                  {agent.isIt ? "it" : "not it"}
                </span>
              </td>
              <td>{agent.room.replace(/-/g, " ")}</td>
              <td className="num">
                {Math.max(0, round - agent.joinedRound).toLocaleString()} rounds
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
