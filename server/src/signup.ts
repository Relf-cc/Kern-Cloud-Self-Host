// Who may have an account on this instance, and who may still sign in.
//
// A public server wants anyone to be able to sign up. A self-hosted one
// usually doesn't: it belongs to a team, a household or one person, and an
// open sign-up form on a machine with a public address collects strangers.
// So "invite" is the default and this module is the gate.
//
//   open    anyone may sign up, optionally limited to certain email domains
//   invite  only an address that holds a workspace invitation, or one an
//           administrator added to the allow list
//   closed  nobody; existing accounts keep working
//
// The very first account is always allowed, whatever the mode: somebody has to
// be able to start using a server they just installed, and an empty instance
// has nobody to invite them.
//
// A hold (kern_account_hold) is the gentler half of moderation: it refuses new
// sessions without deleting anything, so an account can be suspended and let
// back in. It is checked when a session is created, which covers every way in.

import { APIError } from "better-auth/api";
import { one, query } from "./db.js";
import { live } from "./live.js";

const normalise = (email: string) => email.trim().toLowerCase();

async function accountCount(): Promise<number> {
  const row = await one<{ n: string }>(`SELECT count(*) AS n FROM "user"`);
  return Number(row?.n ?? 0);
}

/** Is this address holding an open invitation to any workspace? */
async function hasInvite(email: string): Promise<boolean> {
  const row = await one(
    `SELECT 1 FROM kern_invite
     WHERE lower(email) = $1 AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     LIMIT 1`,
    [email],
  );
  return !!row;
}

/** Did an administrator add this address to the allow list? */
async function isAllowListed(email: string): Promise<boolean> {
  const row = await one("SELECT 1 FROM kern_signup_allow WHERE email = $1 LIMIT 1", [email]);
  return !!row;
}

export interface SignUpVerdict {
  ok: boolean;
  /** Why not, phrased for the person who just tried to sign up. */
  message?: string;
  /** True when this is the instance's first account. */
  first?: boolean;
}

/** The rule, as a value. Separated from the throwing guard so it can be tested. */
export async function maySignUp(rawEmail: string): Promise<SignUpVerdict> {
  const email = normalise(rawEmail);
  const total = await accountCount();
  if (total === 0) return { ok: true, first: true };

  if (live.maxUsers > 0 && total >= live.maxUsers) {
    return { ok: false, message: "This server has reached the number of accounts it's configured to hold. Ask its administrator for room." };
  }

  switch (live.registration) {
    case "closed":
      if (await hasInvite(email)) break;
      if (await isAllowListed(email)) break;
      return { ok: false, message: "This server isn't accepting new accounts." };
    case "invite":
      if (await hasInvite(email)) break;
      if (await isAllowListed(email)) break;
      return {
        ok: false,
        message: "This server is invitation-only. Ask someone with a workspace here to invite this email address, then sign up again.",
      };
    case "open": {
      const domains = live.allowedEmailDomains;
      if (domains.length) {
        const domain = email.split("@")[1] ?? "";
        if (!domains.includes(domain)) {
          return { ok: false, message: `Accounts on this server use an address at ${domains.length === 1 ? domains[0] : domains.join(", ")}.` };
        }
      }
      break;
    }
  }
  return { ok: true };
}

/** Refuses a sign-up that the policy doesn't allow. Used by a Better Auth hook. */
export async function assertMaySignUp(email: string): Promise<void> {
  const verdict = await maySignUp(email);
  if (!verdict.ok) throw new APIError("FORBIDDEN", { code: "REGISTRATION_CLOSED", message: verdict.message ?? "This server isn't accepting new accounts." });
}

/** Notes that an allow-list entry has been used, so an administrator can see it worked. */
export async function markAllowUsed(email: string): Promise<void> {
  await query("UPDATE kern_signup_allow SET used_at = now() WHERE email = $1 AND used_at IS NULL", [normalise(email)]).catch(() => undefined);
}

export async function heldReason(userId: string): Promise<string | null> {
  const row = await one<{ reason: string }>("SELECT reason FROM kern_account_hold WHERE user_id = $1", [userId]);
  return row ? row.reason : null;
}

/** Refuses a new session for a held account. Used by a Better Auth hook. */
export async function assertNotHeld(userId: string): Promise<void> {
  const reason = await heldReason(userId);
  if (reason === null) return;
  throw new APIError("FORBIDDEN", {
    code: "ACCOUNT_SUSPENDED",
    message: reason ? `This account is suspended: ${reason}` : "This account is suspended. Ask the administrator of this server about it.",
  });
}
