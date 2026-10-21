// Shared HTTP plumbing: typed errors rendered as { code, message }, the
// signed-in-user guard and body validation.

import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { userFromHeaders, type SessionUser } from "../auth.js";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "invalid") => new HttpError(400, code, message);
export const forbidden = (message = "You don't have permission to do that.") => new HttpError(403, "forbidden", message);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} wasn't found.`);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

export type Env = { Variables: { user: SessionUser } };

/** Requires a valid session; the user is available as c.get("user"). */
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  // Several routers share a prefix (/spaces); resolve the session once.
  if (c.get("user")) return next();
  const user = await userFromHeaders(c.req.raw.headers);
  if (!user) throw new HttpError(401, "unauthorized", "Your session has ended. Sign in again.");
  c.set("user", user);
  await next();
};

/** Requires a verified email (invites, workspaces). */
export function requireVerified(user: SessionUser) {
  if (!user.emailVerified) throw new HttpError(403, "unverified", "Confirm your email address first.");
}

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("The request body isn't valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw badRequest(`${where}${first?.message ?? "Invalid input."}`);
  }
  return parsed.data;
}

export function errorResponse(e: unknown, c: Context) {
  if (e instanceof HttpError) return c.json({ code: e.code, message: e.message }, e.status);
  const status = (e as { status?: number; statusCode?: number })?.statusCode ?? (e as { status?: number })?.status;
  if (status === 413) return c.json({ code: "too_large", message: "That request is too large." }, 413);
  console.error("[http] unhandled error", e);
  return c.json({ code: "server", message: "Something went wrong on the server. Try again in a moment." }, 500);
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
