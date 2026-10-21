// GET /kern/v1/instance - how a Kern app finds out what it's connecting to.
//
// This is the first request the desktop app makes when somebody types in a
// server address, before any account exists and before any token is sent. It
// answers three questions:
//
//   Is this a Kern server?       `service: "kern-cloud"` and a protocol number
//   What will it let me do?      registration mode, which features are on
//   What should I call it?       the instance name, shown on the sign-in screen
//
// It is deliberately public and deliberately thin. An unauthenticated endpoint
// is a free description of the host to anyone who asks, so it holds no counts,
// no versions of anything that could steer an exploit, and nothing about who
// has an account here. `protocol` is the contract: an app refuses a server
// whose protocol it doesn't implement, rather than failing later in a way
// nobody can diagnose.

import { Hono } from "hono";
import { config } from "../config.js";
import { live } from "../live.js";

/**
 * The sync and realtime protocol this server speaks. Raise it only for a
 * change that would break an older app; adding an endpoint doesn't count.
 */
export const PROTOCOL = 1;

export const instance = new Hono();

instance.get(`${config.basePath}/instance`, (c) =>
  c.json({
    service: "kern-cloud",
    protocol: PROTOCOL,
    name: live.instanceName,
    /** Where this server expects apps to talk to it, in full. */
    apiUrl: `${config.publicUrl}${config.basePath}`,
    /** open | invite | closed - the app's sign-up screen adapts to this. */
    registration: live.registration,
    /** Present only when sign-ups are limited to certain email domains. */
    emailDomains: live.registration === "open" && live.allowedEmailDomains.length ? live.allowedEmailDomains : undefined,
    /** A note from the administrator, shown on the sign-in screen. */
    notice: live.motd || undefined,
    contact: live.supportEmail || undefined,
    features: {
      /** Shared workspaces with invitations. */
      workspaces: true,
      /** Shared whiteboard images. */
      assets: true,
      /** Inbound stream endpoints. */
      streams: true,
      /** Public share links and subscribable calendar feeds. */
      shares: live.sharesEnabled,
      /** Email addresses that deliver into a stream. */
      inboundEmail: !!config.inboundEmail.secret,
      /** Whether this server can actually send a verification code. */
      email: !config.mailToConsole,
    },
  }),
);
