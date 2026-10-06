/**
 * The arena map. Rooms are pages, doors are links.
 *
 * The graph is a ring with chords, so every room has three or four doors and
 * no room is a dead end. A dead end is a trap when 40% of the arena is
 * chasing you, and a trap makes for a short, dull game.
 *
 * Home is the first room and the only safe one.
 */

export const HOME = "home";

/**
 * Rooms are named, not numbered, so an agent reading its observation can tell
 * them apart without holding a map in its head.
 */
export const ROOM_NAMES = [
  "home",
  "long-hall",
  "glasshouse",
  "boiler-room",
  "the-stacks",
  "orchard",
  "cold-storage",
  "switchboard",
  "lantern-room",
  "undercroft",
  "weather-deck",
  "paper-mill",
  "dovecote",
  "quarry",
  "reading-room",
  "signal-hill",
  "foundry",
  "salt-flats",
  "greenway",
  "clocktower",
  "tannery",
  "lower-bridge",
  "aviary",
  "kiln",
] as const;

export interface Room {
  id: string;
  name: string;
  safe: boolean;
  doors: string[];
}

export class ArenaMap {
  readonly roomCount: number;
  readonly rooms: Map<string, Room>;
  private readonly order: string[];

  constructor(roomCount = 16) {
    if (roomCount < 4) throw new Error("an arena needs at least 4 rooms");
    if (roomCount > ROOM_NAMES.length) {
      throw new Error(`at most ${ROOM_NAMES.length} rooms are named`);
    }
    this.roomCount = roomCount;
    this.order = ROOM_NAMES.slice(0, roomCount) as unknown as string[];

    // Ring: every room joins its two neighbours. Chords: every room also
    // joins the room a third of the way around, which keeps the arena's
    // diameter low so a chase cannot run forever.
    const chord = Math.max(2, Math.floor(roomCount / 3));
    const doors = new Map<string, Set<string>>();
    for (const id of this.order) doors.set(id, new Set());

    this.order.forEach((id, i) => {
      const next = this.order[(i + 1) % roomCount];
      const prev = this.order[(i - 1 + roomCount) % roomCount];
      doors.get(id)!.add(next);
      doors.get(id)!.add(prev);
      const far = this.order[(i + chord) % roomCount];
      if (far !== id) {
        doors.get(id)!.add(far);
        doors.get(far)!.add(id);
      }
    });

    this.rooms = new Map(
      this.order.map((id) => [
        id,
        {
          id,
          name: id.replace(/-/g, " "),
          safe: id === HOME,
          doors: [...doors.get(id)!].sort(),
        },
      ]),
    );
  }

  has(id: string): boolean {
    return this.rooms.has(id);
  }

  get(id: string): Room {
    const room = this.rooms.get(id);
    if (!room) throw new Error(`no such room: ${id}`);
    return room;
  }

  ids(): string[] {
    return [...this.order];
  }

  doors(id: string): string[] {
    return this.get(id).doors;
  }

  isSafe(id: string): boolean {
    return this.get(id).safe;
  }

  adjacent(a: string, b: string): boolean {
    return this.has(a) && this.get(a).doors.includes(b);
  }
}
