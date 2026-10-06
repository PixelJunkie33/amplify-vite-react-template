/**
 * The spectator's read-only client.
 *
 * Every function here is a GET. There is deliberately no join, no action and
 * no pause in this module — a human watching the arena cannot reach into it,
 * and the way to guarantee that is to not ship the code that could.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface RatioView {
  population: number;
  it: number;
  free: number;
  requiredIt: number;
  target: string;
}

export interface AgentView {
  id: string;
  name: string;
  isIt: boolean;
  room: string;
  joinedRound: number;
}

export interface RoomView {
  id: string;
  safe: boolean;
  doors: string[];
  occupants: number;
  its: number;
}

export interface StateView {
  round: number;
  paused: boolean;
  ratio: RatioView;
  tickSeconds: number;
  logHead: string;
  logLength: number;
  agents: AgentView[];
  rooms: RoomView[];
}

export interface LogEntryView {
  round: number;
  at: string;
  events: string[];
  hash: string;
  prev: string;
}

export interface LogView {
  head: string;
  length: number;
  verified: { ok: boolean; brokeAt?: number };
  entries: LogEntryView[];
}

/** Where the arena lives. Same origin when served by it; override for dev. */
export const ARENA_BASE =
  (import.meta.env?.VITE_ARENA_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${ARENA_BASE}${path}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export interface Live {
  state: StateView | null;
  log: LogView | null;
  error: string | null;
  /** True once a poll has failed and we are still retrying. */
  stale: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

/**
 * Poll the arena on its own round clock.
 *
 * The interval comes from the arena's `tickSeconds`, so the view updates once
 * per round rather than at some arbitrary rate of our own — polling faster
 * would show nothing new and cost the arena requests it should spend on
 * players.
 */
export function useArena(): Live {
  const [state, setState] = useState<StateView | null>(null);
  const [log, setLog] = useState<LogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const period = useRef(10_000);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    let timer: number | undefined;

    const poll = async () => {
      try {
        const [nextState, nextLog] = await Promise.all([
          getJSON<StateView>("/api/state", controller.signal),
          getJSON<LogView>("/api/log?limit=40", controller.signal),
        ]);
        if (!alive) return;
        setState(nextState);
        setLog(nextLog);
        setError(null);
        setStale(false);
        setLastUpdated(Date.now());
        period.current = Math.max(2000, (nextState.tickSeconds || 10) * 1000);
      } catch (err) {
        if (!alive || controller.signal.aborted) return;
        // Keep showing the last good frame rather than blanking the page.
        // A watcher would rather see slightly old truth than nothing.
        setError((err as Error).message);
        setStale(true);
      } finally {
        if (alive) timer = window.setTimeout(poll, period.current);
      }
    };

    void poll();
    return () => {
      alive = false;
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [nonce]);

  return { state, log, error, stale, lastUpdated, refresh };
}
