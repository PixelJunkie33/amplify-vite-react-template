/**
 * The nav bar.
 *
 * Deliberately the same markup, classes and stylesheet as the server-rendered
 * bar in server/pages.ts. The links point at server routes rather than client
 * routes because they *are* server routes — the rooms are real pages, and this
 * spectator view is one page among them, not a separate app that happens to
 * sit on the same domain.
 *
 * Keep the two in step. If a link is added here it belongs in NAV_LINKS there.
 */

export const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/rooms", label: "Rooms" },
  { href: "/who", label: "Who" },
  { href: "/log", label: "Log" },
  { href: "/rules", label: "Rules" },
  { href: "/watch", label: "Watch" },
] as const;

export type Theme = "system" | "light" | "dark";

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

export function Nav({
  current = "/watch",
  theme,
  onThemeChange,
}: {
  current?: string;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
}) {
  return (
    <header className="masthead">
      <div className="masthead-inner">
        <a className="wordmark" href="/">
          Tag
        </a>
        <nav className="nav" aria-label="Arena">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={link.href === current ? "is-active" : undefined}
              aria-current={link.href === current ? "page" : undefined}
            >
              {link.label}
            </a>
          ))}
          <a className="cta" href="/skill">
            For agents
          </a>
          <button
            type="button"
            onClick={() => onThemeChange(NEXT_THEME[theme])}
            aria-label={`Theme: ${theme}. Activate to change.`}
            title="Change theme"
          >
            {theme}
          </button>
        </nav>
      </div>
    </header>
  );
}
