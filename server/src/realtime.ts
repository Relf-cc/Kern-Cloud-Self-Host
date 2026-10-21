// Realtime hub over WebSockets.
//
// The app opens one socket (authenticated with a short-lived, single-use
// ticket from POST /realtime/ticket) and subscribes to the spaces it has open.
// The server pushes:
//   - "changes": records committed by a sync push (durable data),
//   - "presence": who is where, cursors and selections (ephemeral),
//   - "ephemeral": relayed live interactions such as whiteboard drags,
//   - "space": workspace events (updated, members changed, removed, deleted),
//   - "invite": a new invitation for the signed-in user,
//   - "stream": a stream delivered a submission into the space,
//   - "notice": a message from this server's administrator,
//   - "signed_out": this session has been ended (suspended, revoked, deleted).
// Ephemeral messages are never stored. State is per process, which suits a
// single home server; several instances would need a shared pub/sub.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { membership } from "./lib/spaces.js";

interface Ticket {
  userId: string;
  name: string;
  image: string | null;
  expires: number;
}

interface Conn {
  id: string;
  ws: WebSocket;
  userId: string;
  name: string;
  image: string | null;
  color: string;
  spaces: Set<string>;
  /** Last presence state per space, replayed to newcomers. */
  presence: Map<string, unknown>;
  alive: boolean;
  /** Simple token bucket for ephemeral traffic. */
  tokens: number;
  refilled: number;
}

const tickets = new Map<string, Ticket>();
const rooms = new Map<string, Set<Conn>>();
const byUser = new Map<string, Set<Conn>>();

const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#ad7f58"];
function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function issueTicket(user: { id: string; name: string; image?: string | null }): { ticket: string; expiresIn: number } {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { userId: user.id, name: user.name, image: user.image ?? null, expires: now + 60_000 });
  return { ticket, expiresIn: 60 };
}

function send(c: Conn, msg: unknown) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function who(c: Conn) {
  return { conn: c.id, userId: c.userId, name: c.name, image: c.image, color: c.color };
}

/** Sends to every connection subscribed to a space, optionally skipping one. */
export function broadcastSpace(spaceId: string, msg: unknown, exceptConn?: string) {
  const room = rooms.get(spaceId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const c of room) if (c.id !== exceptConn && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

/** Sends to all of a user's connections (any device). */
export function notifyUser(userId: string, msg: unknown) {
  for (const c of byUser.get(userId) ?? []) send(c, msg);
}

/**
 * Sends to every open connection. Used by the management API for an
 * instance-wide notice ("restarting in five minutes"); the app shows these as
 * a toast and ignores anything it doesn't recognise.
 */
export function broadcastAll(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const set of byUser.values()) for (const c of set) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

/**
 * Closes every connection a user holds, telling them why first. Suspending an
 * account or revoking its sessions has to take hold now: the HTTP session is
 * already gone, but an open socket would otherwise keep receiving changes
 * until it happened to drop.
 */
export function disconnectUser(userId: string, reason: string) {
  for (const c of [...(byUser.get(userId) ?? [])]) {
    send(c, { type: "signed_out", reason });
    for (const s of [...c.spaces]) leave(c, s);
    // 1008 (policy violation) tells the client not to reconnect on its own.
    c.ws.close(1008, "Session ended");
  }
}

/** Removes a user from a space's room (after removal or deletion). */
export function evict(spaceId: string, userId?: string) {
  const room = rooms.get(spaceId);
  if (!room) return;
  for (const c of [...room]) {
    if (userId && c.userId !== userId) continue;
    leave(c, spaceId);
  }
}

function leave(c: Conn, spaceId: string) {
  c.spaces.delete(spaceId);
  c.presence.delete(spaceId);
  const room = rooms.get(spaceId);
  if (!room) return;
  room.delete(c);
  if (!room.size) rooms.delete(spaceId);
  broadcastSpace(spaceId, { type: "leave", space: spaceId, conn: c.id, userId: c.userId });
}

async function onMessage(c: Conn, raw: string) {
  let msg: { type?: string; space?: string; state?: unknown; data?: unknown; ref?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const space = typeof msg.space === "string" ? msg.space : "";
  switch (msg.type) {
    case "ping":
      return send(c, { type: "pong", t: Date.now() });
    case "subscribe": {
      try {
        const m = await membership(c.userId, space);
        let room = rooms.get(space);
        if (!room) rooms.set(space, (room = new Set()));
        room.add(c);
        c.spaces.add(space);
        const peers = [...room].filter((p) => p.id !== c.id).map((p) => ({ ...who(p), state: p.presence.get(space) ?? null }));
        send(c, { type: "subscribed", space, head: m.space.seq, role: m.role, self: who(c), peers, ref: msg.ref });
      } catch (e) {
        send(c, { type: "error", space, code: "subscribe_failed", message: (e as Error).message, ref: msg.ref });
      }
      return;
    }
    case "unsubscribe":
      if (c.spaces.has(space)) leave(c, space);
      return;
    case "presence":
    case "ephemeral": {
      if (!c.spaces.has(space)) return;
      // At most ~40 messages a second per connection.
      const now = Date.now();
      c.tokens = Math.min(80, c.tokens + ((now - c.refilled) / 1000) * 40);
      c.refilled = now;
      if (c.tokens < 1) return;
      c.tokens -= 1;
      if (msg.type === "presence") {
        c.presence.set(space, msg.state ?? null);
        broadcastSpace(space, { type: "presence", space, ...who(c), state: msg.state ?? null }, c.id);
      } else {
        broadcastSpace(space, { type: "ephemeral", space, ...who(c), data: msg.data ?? null }, c.id);
      }
      return;
    }
  }
}

export function attachRealtime(server: { on(event: "upgrade", cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const path = `${config.basePath}/realtime`;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    const ticket = tickets.get(url.searchParams.get("ticket") ?? "");
    if (ticket) tickets.delete(url.searchParams.get("ticket")!);
    if (!ticket || ticket.expires < Date.now()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Conn = {
        id: randomBytes(8).toString("hex"),
        ws,
        userId: ticket.userId,
        name: ticket.name,
        image: ticket.image,
        color: colorFor(ticket.userId),
        spaces: new Set(),
        presence: new Map(),
        alive: true,
        tokens: 80,
        refilled: Date.now(),
      };
      let mine = byUser.get(c.userId);
      if (!mine) byUser.set(c.userId, (mine = new Set()));
      mine.add(c);
      send(c, { type: "hello", self: who(c) });
      ws.on("pong", () => (c.alive = true));
      ws.on("message", (data) => void onMessage(c, data.toString()));
      ws.on("close", () => {
        for (const s of [...c.spaces]) leave(c, s);
        const set = byUser.get(c.userId);
        set?.delete(c);
        if (set && !set.size) byUser.delete(c.userId);
      });
    });
  });

  // Drop connections that stop answering pings (sleep, network loss).
  const heartbeat = setInterval(() => {
    for (const set of byUser.values())
      for (const c of set) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
  }, 30_000);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      for (const set of byUser.values()) for (const c of set) c.ws.close(1001, "Server restarting");
      wss.close();
    },
    stats() {
      return { connections: [...byUser.values()].reduce((n, s) => n + s.size, 0), rooms: rooms.size };
    },
  };
}
