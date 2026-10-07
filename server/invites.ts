/**
 * Invitations.
 *
 * An invitation is how a human says "this agent may play". It is a code, a
 * number of uses, and an expiry. The operator mints one, hands the link to
 * whoever runs an agent, and that agent redeems it on join.
 *
 * Two modes, set by the operator:
 *
 *   open         — anybody may join; invitations still work and are recorded,
 *                  so you can tell who came from where.
 *   invite-only  — a valid, unexpired, unexhausted code is required to join.
 *
 * Codes are stored hashed, exactly like bearer tokens, so a leaked state file
 * does not hand out the ability to join a closed arena. The label and counts
 * stay in the clear, because the operator needs to read their own list.
 */

import { createHash, randomBytes } from "node:crypto";

export interface Invite {
  /** sha256 of the code. The code itself is shown once, when minted. */
  hash: string;
  /** A short, public prefix so the operator can tell invitations apart. */
  prefix: string;
  /** What this invitation is for — "Anthropic's research agents", say. */
  label: string;
  /** How many joins it allows in total. */
  uses: number;
  /** How many of those are left. */
  remaining: number;
  createdAt: string;
  /** ISO timestamp, or null to never expire. */
  expiresAt: string | null;
  revoked: boolean;
  /** Agent ids that have redeemed it. */
  redeemedBy: string[];
}

export interface MintedInvite {
  /** The code. Shown once. */
  code: string;
  invite: Invite;
}

export type InviteProblem = "unknown" | "revoked" | "expired" | "exhausted";

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export class Invites {
  private byHash = new Map<string, Invite>();

  /** Mint an invitation. The code is returned once and never stored. */
  mint(options: { label?: string; uses?: number; expiresInHours?: number } = {}): MintedInvite {
    const code = `inv_${randomBytes(12).toString("base64url")}`;
    const uses = Math.max(1, Math.floor(options.uses ?? 1));
    const invite: Invite = {
      hash: hashCode(code),
      prefix: code.slice(0, 8),
      label: (options.label ?? "").slice(0, 120) || "unlabelled",
      uses,
      remaining: uses,
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresInHours
        ? new Date(Date.now() + options.expiresInHours * 3600_000).toISOString()
        : null,
      revoked: false,
      redeemedBy: [],
    };
    this.byHash.set(invite.hash, invite);
    return { code, invite };
  }

  /** Why this code cannot be used, or null if it can. */
  check(code: string | undefined | null, now = Date.now()): InviteProblem | null {
    if (!code) return "unknown";
    const invite = this.byHash.get(hashCode(code));
    if (!invite) return "unknown";
    if (invite.revoked) return "revoked";
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) return "expired";
    if (invite.remaining <= 0) return "exhausted";
    return null;
  }

  /**
   * Spend one use. Returns the invitation, or null if it was not usable —
   * callers must treat null as a refusal, not as "join anyway".
   */
  redeem(code: string, agentId: string, now = Date.now()): Invite | null {
    if (this.check(code, now)) return null;
    const invite = this.byHash.get(hashCode(code))!;
    invite.remaining -= 1;
    invite.redeemedBy.push(agentId);
    return invite;
  }

  revoke(prefix: string): boolean {
    for (const invite of this.byHash.values()) {
      if (invite.prefix === prefix) {
        invite.revoked = true;
        return true;
      }
    }
    return false;
  }

  /** The operator's view. Never includes anything that could be redeemed. */
  list(): Invite[] {
    return [...this.byHash.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Public description of one code, for the agent holding it. */
  describe(code: string, now = Date.now()): {
    valid: boolean;
    problem: InviteProblem | null;
    label?: string;
    remaining?: number;
    expiresAt?: string | null;
  } {
    const problem = this.check(code, now);
    if (problem) return { valid: false, problem };
    const invite = this.byHash.get(hashCode(code))!;
    return {
      valid: true,
      problem: null,
      label: invite.label,
      remaining: invite.remaining,
      expiresAt: invite.expiresAt,
    };
  }

  // --- persistence ------------------------------------------------------

  snapshot(): Invite[] {
    return this.list().map((invite) => ({ ...invite, redeemedBy: [...invite.redeemedBy] }));
  }

  static restore(rows: Invite[] = []): Invites {
    const invites = new Invites();
    for (const row of rows) invites.byHash.set(row.hash, { ...row });
    return invites;
  }
}
