// Better Auth: email + password accounts with emailed one-time codes for
// verification, sign-in and recovery. The desktop app authenticates with a
// bearer token (no cookies), so there are no web pages or redirects.

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { emailOTP } from "better-auth/plugins/email-otp";
import { config } from "./config.js";
import { pool } from "./db.js";
import { otpMail, passwordChangedMail, sendLater, welcomeMail } from "./mail.js";
import { assertMaySignUp, assertNotHeld, markAllowUsed } from "./signup.js";

export const authOptions = {
  appName: config.instanceName,
  baseURL: config.publicUrl,
  basePath: `${config.basePath}/auth`,
  secret: config.authSecret,
  database: pool,
  trustedOrigins: [config.publicUrl, `${config.appScheme}://app`],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: false,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      sendLater(passwordChangedMail(user.email));
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    afterEmailVerification: async (user) => {
      sendLater(welcomeMail(user.email, user.name));
    },
  },
  user: {
    changeEmail: { enabled: true },
    deleteUser: {
      enabled: true,
      // Deleting an account would delete the workspaces it owns; refuse while
      // other people still depend on one.
      beforeDelete: async (user) => {
        const shared = await pool.query<{ name: string }>(
          `SELECT s.name FROM kern_space s WHERE s.owner_id = $1 AND s.kind = 'workspace' AND s.deleted_at IS NULL
             AND (SELECT count(*) FROM kern_member m WHERE m.space_id = s.id) > 1 LIMIT 1`,
          [user.id],
        );
        if (shared.rows[0]) {
          throw new APIError("BAD_REQUEST", { message: `Transfer or delete the workspace "${shared.rows[0].name}" first - other members still use it.` });
        }
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // The gate for this instance's registration policy (see signup.ts).
        // Refusing here covers every route that could create an account.
        before: async (user) => {
          await assertMaySignUp(user.email);
        },
        after: async (user) => {
          await markAllowUsed(user.email);
        },
      },
    },
    session: {
      create: {
        // A suspended account keeps its data and its password but gets no new
        // session, whichever way it tries to sign in.
        before: async (session) => {
          await assertNotHeld(session.userId);
        },
      },
    },
  },
  session: {
    // Desktop sessions are long-lived and refreshed while in use.
    expiresIn: 60 * 60 * 24 * 60,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/email-otp/send-verification-otp": { window: 60, max: 4 },
      "/email-otp/request-password-reset": { window: 60, max: 4 },
      "/forget-password/email-otp": { window: 60, max: 4 },
    },
  },
  advanced: {
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    useSecureCookies: config.publicUrl.startsWith("https://"),
  },
  plugins: [
    bearer(),
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "hashed",
      sendVerificationOnSignUp: true,
      overrideDefaultEmailVerification: true,
      // Never create accounts from a code request; sign-up is explicit.
      disableSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        sendLater(otpMail(email, otp, type));
      },
    }),
  ],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null;
}

/** Resolves the signed-in user from a request's bearer token, if any. */
export async function userFromHeaders(headers: Headers): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers });
  if (!s) return null;
  return { id: s.user.id, name: s.user.name, email: s.user.email, emailVerified: s.user.emailVerified, image: s.user.image };
}
