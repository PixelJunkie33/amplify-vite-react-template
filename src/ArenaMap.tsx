/**
 * The arena as a node-link diagram.
 *
 * A node-link form is right here because the thing a watcher wants to see is
 * adjacency — who is one door away from whom. A grid of room tiles would lose
 * exactly that.
 *
 * Rooms sit on a ring in the order the server lists them, which is the order
 * the ring was built in, so the ring edges land on the circle and only the
 * chords cross the middle. Agents are drawn as pips around their room:
 * a square if it, a circle if not, so role survives greyscale and colourblind
 * vision alike.
 */

import { useMemo, useState } from "react";
import type { AgentView, RoomView } from "./api.ts";

// The viewBox is wider than it is tall, and the ring sits well inside it, so
// every room label is drawn *within* the box. Labels that spill outside do not
// merely look clipped — they widen the whole page, because overflowing SVG
// content still counts toward the document's scrollable area.
const WIDTH = 580;
const HEIGHT = 460;
const CENTRE_X = WIDTH / 2;
const CENTRE_Y = HEIGHT / 2;
const RING = HEIGHT / 2 - 58;

interface Placed extends RoomView {
  x: number;
  y: number;
  radius: number;
  agents: AgentView[];
}

interface Hover {
  x: number;
  y: number;
  room: Placed;
}

export function ArenaMap({ rooms, agents }: { rooms: RoomView[]; agents: AgentView[] }) {
  const [hover, setHover] = useState<Hover | null>(null);

  const placed = useMemo<Placed[]>(() => {
    const byRoom = new Map<string, AgentView[]>();
    for (const agent of agents) {
      const list = byRoom.get(agent.room) ?? [];
      list.push(agent);
      byRoom.set(agent.room, list);
    }
    return rooms.map((room, i) => {
      const angle = (i / rooms.length) * Math.PI * 2 - Math.PI / 2;
      const here = byRoom.get(room.id) ?? [];
      return {
        ...room,
        x: CENTRE_X + Math.cos(angle) * RING,
        y: CENTRE_Y + Math.sin(angle) * RING,
        // Area grows with occupancy, but gently — a crowded room should read
        // as busier, not swallow its neighbours.
        radius: 13 + Math.min(9, Math.sqrt(here.length) * 4.5),
        agents: here,
      };
    });
  }, [rooms, agents]);

  const index = useMemo(
    () => new Map(placed.map((room) => [room.id, room])),
    [placed],
  );

  // One line per pair, not two. Sorting the pair key dedupes the mutual doors.
  const doors = useMemo(() => {
    const seen = new Set<string>();
    const lines: { a: Placed; b: Placed; key: string }[] = [];
    for (const room of placed) {
      for (const door of room.doors) {
        const other = index.get(door);
        if (!other) continue;
        const key = [room.id, door].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({ a: room, b: other, key });
      }
    }
    return lines;
  }, [placed, index]);

  if (!rooms.length) {
    return (
      <section className="panel">
        <h2>The arena</h2>
        <p className="empty">Waiting for the arena to describe itself.</p>
      </section>
    );
  }

  return (
    <section className="panel map-wrap">
      <h2>The arena</h2>

      <svg
        className="map"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${rooms.length} rooms joined by doors, with ${agents.length} agents placed in them`}
        onMouseLeave={() => setHover(null)}
      >
        <g>
          {doors.map((door) => (
            <line
              key={door.key}
              className="door"
              x1={door.a.x}
              y1={door.a.y}
              x2={door.b.x}
              y2={door.b.y}
            />
          ))}
        </g>

        {placed.map((room) => {
          const label = room.id.replace(/-/g, " ");
          const angle = Math.atan2(room.y - CENTRE_Y, room.x - CENTRE_X);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          // Push the label clear of the node *and* of its ring of pips, then
          // anchor it away from the centre of the ring. Centring every label
          // makes the ones at three and nine o'clock sit on top of their own
          // circle; anchoring by side keeps text outside the mark.
          const clearance = room.radius + (room.agents.length ? 13 : 7) + 6;
          const anchor = Math.abs(cos) < 0.35 ? "middle" : cos > 0 ? "start" : "end";
          const labelAt = {
            x: room.x + cos * clearance,
            y: room.y + sin * clearance + (anchor === "middle" ? (sin < 0 ? -3 : 9) : 3),
          };
          return (
            <g
              className="room"
              key={room.id}
              onMouseMove={(event) => {
                const svg = event.currentTarget.ownerSVGElement!;
                const box = svg.getBoundingClientRect();
                setHover({
                  x: ((event.clientX - box.left) / box.width) * 100,
                  y: ((event.clientY - box.top) / box.height) * 100,
                  room,
                });
              }}
            >
              <circle
                className={[
                  "room-body",
                  room.safe ? "safe" : "",
                  room.occupants ? "busy" : "",
                ].join(" ")}
                cx={room.x}
                cy={room.y}
                r={room.radius}
              />
              {/* A hit area larger than the mark, per the interaction spec. */}
              <circle className="room-hit" cx={room.x} cy={room.y} r={room.radius + 10} />
              <text
                className="room-label"
                x={labelAt.x}
                y={labelAt.y}
                textAnchor={anchor}
              >
                {label}
              </text>
              <AgentPips room={room} />
            </g>
          );
        })}
      </svg>

      <div className="legend" style={{ marginTop: ".5rem" }}>
        <span className="key">
          <i className="swatch is-it" /> it
        </span>
        <span className="key">
          <i className="swatch is-free" /> not it
        </span>
        <span className="key" style={{ color: "var(--safe)" }}>
          <i
            className="swatch"
            style={{
              border: "1.5px dashed var(--safe)",
              borderRadius: "50%",
              background: "none",
            }}
          />{" "}
          safe room
        </span>
      </div>

      {hover && <RoomTip hover={hover} />}
    </section>
  );
}

/** Agents as pips ringed around their room. Shape carries the role. */
function AgentPips({ room }: { room: Placed }) {
  const count = room.agents.length;
  if (!count) return null;
  const spread = room.radius + 7.5;
  return (
    <g>
      {room.agents.map((agent, i) => {
        const angle = (i / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
        const x = room.x + Math.cos(angle) * spread;
        const y = room.y + Math.sin(angle) * spread;
        return agent.isIt ? (
          <rect
            key={agent.id}
            className="pip-it pip-ring"
            x={x - 3.6}
            y={y - 3.6}
            width={7.2}
            height={7.2}
            rx={1}
          />
        ) : (
          <circle key={agent.id} className="pip-free pip-ring" cx={x} cy={y} r={3.8} />
        );
      })}
    </g>
  );
}

function RoomTip({ hover }: { hover: Hover }) {
  const { room } = hover;
  // Flip the tooltip to whichever side has room, so it never leaves the panel.
  const flipX = hover.x > 60;
  const flipY = hover.y > 65;
  return (
    <div
      className="tip"
      style={{
        left: `${hover.x}%`,
        top: `${hover.y}%`,
        transform: `translate(${flipX ? "-108%" : "12px"}, ${flipY ? "-108%" : "12px"})`,
      }}
    >
      <div className="tip-title">
        {room.id.replace(/-/g, " ")}
        {room.safe ? " · safe" : ""}
      </div>
      <div className="tip-row">
        {room.occupants
          ? `${room.occupants} here · ${room.its} it`
          : "empty"}
      </div>
      <div className="tip-row">{room.doors.length} doors</div>
      {room.agents.slice(0, 6).map((agent) => (
        <div className="tip-row" key={agent.id}>
          {agent.isIt ? "▪" : "•"} {agent.name}
        </div>
      ))}
      {room.agents.length > 6 && (
        <div className="tip-row">+{room.agents.length - 6} more</div>
      )}
    </div>
  );
}
