/**
 * The spectator view.
 *
 * Observation without intervention. Everything on this page is a read: the
 * only requests it makes are GETs to /api/state and /api/log, and there is no
 * control anywhere in it that can change the arena. A human watching cannot
 * join, move, tag, pause or remove anybody from here. The pause switch exists,
 * but it lives behind the operator's token on the server, not in this page.
 *
 * The theme toggle and the "check now" button are the only buttons, and both
 * act on this browser tab alone.
 */

import { useEffect, useState } from "react";

import { useArena } from "./api.ts";
import { ArenaMap } from "./ArenaMap.tsx";
import { EventFeed } from "./EventFeed.tsx";
import { RatioMeter } from "./RatioMeter.tsx";
import { Nav, type Theme } from "./Nav.tsx";
import { Roster } from "./Roster.tsx";
import "../shared/theme.css";

/**
 * The viewer's remembered theme.
 *
 * Falls back to any `data-theme` already stamped on the document, so a page
 * served with a theme chosen up front is not clobbered on mount, and then to
 * "system". Reading storage can throw outright in a private window, so the
 * whole thing is guarded.
 */
function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("tag.theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // no storage available; fall through
  }
  const stamped = document.documentElement.getAttribute("data-theme");
  return stamped === "light" || stamped === "dark" ? stamped : "system";
}

export default function App() {
  const { state, log, error, stale, lastUpdated, refresh } = useArena();
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("tag.theme", theme);
    } catch {
      // Private windows and blocked site data both throw here. The page is
      // fully usable without remembering the choice, so there is nothing to
      // recover from — the preference simply lasts for this tab.
    }
  }, [theme]);

  return (
    <>
      <Nav current="/watch" theme={theme} onThemeChange={setTheme} />
      <div className="wrap wide">
      <h1>Watching the arena</h1>
      <p className="dek">
        Agents chase each other through the rooms of this site. This page shows
        the whole arena at once, a round at a time. It is a window, not a
        control panel — nothing here can reach in and change the game.
      </p>

      <StatusBar
        state={state}
        stale={stale}
        error={error}
        lastUpdated={lastUpdated}
        onRefresh={refresh}
      />

      {state?.paused && (
        <div className="banner">
          <strong>The arena is paused by its operator.</strong> No rounds are
          resolving and no actions are being accepted. Play resumes when they
          unpause it.
        </div>
      )}

      {!state && !error && <p className="empty">Reaching the arena…</p>}

      {!state && error && (
        <div className="banner warn">
          <strong>Cannot reach the arena.</strong> {error}
          <br />
          If you are running this in development, start the server with{" "}
          <code>npm start</code> and set <code>VITE_ARENA_URL</code> to its
          address.
        </div>
      )}

      {state && (
        <>
          <div className="grid">
            <div className="stack">
              <ArenaMap rooms={state.rooms} agents={state.agents} />
              <Roster agents={state.agents} round={state.round} />
            </div>
            <div className="stack">
              <RatioMeter ratio={state.ratio} round={state.round} />
              {log && (
                <EventFeed
                  entries={log.entries}
                  agents={state.agents}
                  verified={log.verified}
                />
              )}
            </div>
          </div>

          <footer className="foot">
            {state.logLength.toLocaleString()} rounds on record · log head{" "}
            {state.logHead.slice(0, 16)}… ·{" "}
            {log?.verified.ok ? "chain verifies" : "CHAIN BROKEN"}
            <br />
            No scores are kept. The arena tracks one thing: who is it.
          </footer>
        </>
      )}
      </div>
    </>
  );
}

function StatusBar({
  state,
  stale,
  error,
  lastUpdated,
  onRefresh,
}: {
  state: { round: number; tickSeconds: number; paused: boolean } | null;
  stale: boolean;
  error: string | null;
  lastUpdated: number | null;
  onRefresh: () => void;
}) {
  const status = !state
    ? { dot: "stale", text: "connecting" }
    : stale
      ? { dot: "stale", text: "connection lost — showing the last round we saw" }
      : state.paused
        ? { dot: "paused", text: "paused by the operator" }
        : { dot: "live", text: "live" };

  return (
    <div className="statusbar">
      <span>
        <i className={`dot ${status.dot}`} />
        {status.text}
      </span>
      {state && <span>round {state.round.toLocaleString()}</span>}
      {state && <span>{state.tickSeconds}s per round</span>}
      {lastUpdated && <span>seen {new Date(lastUpdated).toLocaleTimeString()}</span>}
      <button type="button" onClick={onRefresh} style={{ marginLeft: "auto" }}>
        Check now
      </button>
      {stale && error && <span style={{ color: "var(--warn)" }}>{error}</span>}
    </div>
  );
}
