// A stream's preferences, stored as JSON on the stream and validated on every
// write. Parsing `{}` gives the defaults, so older streams pick up new
// settings automatically. Updates are deep-merged into the current config and
// parsed again as a whole.

import { z } from "zod";
import { DEFAULT_MAX, validCidr, validOriginPattern } from "./kit.js";

export const ACTIONS = ["task", "inbox", "issue", "task_issue"] as const;
export const AUTH_MODES = ["public", "token", "signature"] as const;
export const FIELD_TYPES = ["text", "long_text", "email", "url", "number", "boolean", "choice"] as const;
export const TASK_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const priority = z.number().int().min(0).max(4);

const field = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, "Field keys use letters, numbers, - and _, with dots for nesting."),
    label: z.string().trim().max(80).default(""),
    type: z.enum(FIELD_TYPES).default("text"),
    required: z.boolean().default(false),
    /** 0 means the type's default. */
    maxLength: z.number().int().min(0).max(20_000).default(0),
    options: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    /** Validated and available to templates, but left out of {{_fields}}. */
    hidden: z.boolean().default(false),
  })
  .refine((f) => f.type !== "choice" || f.options.length > 0, { message: "Choice fields need at least one option.", path: ["options"] });

export const streamConfig = z.object({
  /** What a submission becomes. */
  action: z.enum(ACTIONS).default("task"),

  task: z
    .object({
      projectId: id.nullable().default(null),
      columnId: id.nullable().default(null),
      status: z.enum(TASK_STATUSES).default("inbox"),
      priority: priority.default(0),
      /** A submitted field whose value picks the priority through priorityMap. */
      priorityField: z.string().max(64).nullable().default(null),
      priorityMap: z.record(z.string().max(60), priority).default({}),
      labelIds: z.array(id).max(20).default([]),
      /** Due date this many days after the submission (in the workspace's time zone). */
      dueInDays: z.number().int().min(0).max(365).nullable().default(null),
    })
    .prefault({}),

  templates: z
    .object({
      title: z.string().max(300).default("{{title}}"),
      /** Used when the title renders empty. */
      titleFallback: z.string().max(300).default("New submission via {{_stream.name}}"),
      body: z.string().max(10_000).default("{{_fields}}"),
      /** Appends where and when it arrived (page, time, sender). */
      footer: z.boolean().default(true),
      /** Appends the whole submission as a JSON code block. */
      includeJson: z.boolean().default(false),
    })
    .prefault({}),

  fields: z
    .object({
      /** strict: reject fields that aren't listed. lenient: keep them. */
      mode: z.enum(["lenient", "strict"]).default("lenient"),
      list: z.array(field).max(40).default([]),
    })
    .prefault({})
    .refine((f) => new Set(f.list.map((x) => x.key)).size === f.list.length, { message: "Two fields have the same key.", path: ["list"] }),

  github: z
    .object({
      /** owner/name */
      repo: z
        .string()
        .max(140)
        .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "Use owner/repository.")
        .nullable()
        .default(null),
      labels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
      assignees: z.array(z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/, "That isn't a GitHub username.")).max(10).default([]),
      /** Link the issue to the task when the task's project is connected to the same repository. */
      linkToTask: z.boolean().default(true),
      /** Stop submissions from @-mentioning people or cross-referencing issues. */
      neutralizeMentions: z.boolean().default(true),
    })
    .prefault({}),

  security: z
    .object({
      auth: z.enum(AUTH_MODES).default("public"),
      allowedOrigins: z
        .array(z.string().trim().max(200).refine(validOriginPattern, "Origins look like https://example.com or https://*.example.com."))
        .max(20)
        .default([]),
      /** Public streams: refuse requests that don't come from a browser page (no Origin header). */
      requireOrigin: z.boolean().default(true),
      ipAllowlist: z.array(z.string().trim().max(64).refine(validCidr, "Use an IP address or a CIDR range such as 203.0.113.0/24.")).max(50).default([]),
      /** Hashed senders whose submissions are silently dropped. */
      blockedSenders: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(500).default([]),
      /** A hidden form field that people leave empty and bots fill in. */
      honeypotField: z
        .string()
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/)
        .nullable()
        .default("_hp"),
      turnstile: z.boolean().default(false),
      turnstileSiteKey: z.string().max(100).nullable().default(null),
      signatureToleranceSec: z.number().int().min(30).max(3600).default(300),
      maxBodyKb: z.number().int().min(1).max(256).default(32),
      allowFormPosts: z.boolean().default(true),
      rateLimit: z
        .object({
          /** Per sender. */
          perMinute: z.number().int().min(1).max(600).default(5),
          perHour: z.number().int().min(1).max(5000).default(30),
          /** For the whole stream. */
          streamPerHour: z.number().int().min(1).max(10_000).default(200),
        })
        .prefault({}),
      /** Identical submissions within this many minutes are recorded once. 0 turns it off. */
      dedupeMinutes: z.number().int().min(0).max(1440).default(10),
      /** Escape Markdown in submitted text so it can't add links, images or formatting. */
      escapeMarkdown: z.boolean().default(true),
    })
    .prefault({}),

  responses: z
    .object({
      successMessage: z.string().trim().max(300).default("Thanks! We've received it."),
      /** HTML form posts are redirected here afterwards (with ?kern=ok or ?kern=error). */
      redirectUrl: z.union([z.url().max(500).refine((u) => /^https?:/i.test(u), "Use an http(s) link."), z.null()]).default(null),
      /** Include the task id and issue link in responses (token and signature streams only). */
      returnIds: z.boolean().default(false),
    })
    .prefault({}),

  notify: z
    .object({
      /** Show a notification in Kern for people with the space open. */
      app: z.boolean().default(true),
      email: z.enum(["off", "each", "failures"]).default("off"),
      emailTo: z.enum(["creator", "admins"]).default("creator"),
    })
    .prefault({}),

  email: z
    .object({
      /** Accept emails sent to <alias>@<INBOUND_EMAIL_DOMAIN>. */
      enabled: z.boolean().default(false),
      /** The address's private local part; chosen by the server. */
      alias: z.string().regex(/^[a-z0-9]{20}$/).nullable().default(null),
      /** Only accept mail from these addresses (empty: anyone with the address). */
      allowedSenders: z
        .array(z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "That isn't an email address."))
        .max(20)
        .default([]),
    })
    .prefault({}),

  log: z
    .object({
      /** Keep the submitted data in the delivery log (needed to redeliver). */
      storePayloads: z.boolean().default(true),
      retentionDays: z.number().int().min(1).max(90).default(30),
    })
    .prefault({}),
});

export type StreamConfig = z.infer<typeof streamConfig>;
export type FieldConfig = StreamConfig["fields"]["list"][number];

export const defaultConfig = (): StreamConfig => streamConfig.parse({});

/** Starting points offered when creating a stream. */
export const PRESETS: Record<string, { description: string; config: Record<string, unknown> }> = {
  bug_report: {
    description: "A bug report form on your website. Submissions become tasks with a severity-based priority.",
    config: {
      action: "task",
      task: { status: "inbox", priorityField: "severity", priorityMap: { low: 1, medium: 2, high: 3, critical: 4 } },
      templates: { title: "{{title}}", titleFallback: "Bug report via {{_stream.name}}", body: "{{_fields}}" },
      fields: {
        mode: "lenient",
        list: [
          { key: "title", label: "Summary", type: "text", required: true, maxLength: 200 },
          { key: "description", label: "What happened", type: "long_text", required: true },
          { key: "steps", label: "Steps to reproduce", type: "long_text" },
          { key: "severity", label: "Severity", type: "choice", options: ["low", "medium", "high", "critical"] },
          { key: "email", label: "Contact email", type: "email" },
          { key: "page", label: "Page", type: "url" },
          { key: "browser", label: "Browser", type: "text" },
        ],
      },
    },
  },
  feedback: {
    description: "Ideas and feedback land in the Inbox, ready to sort.",
    config: {
      action: "inbox",
      templates: { title: "{{message | default:\"Feedback\"}}" },
      fields: { list: [{ key: "message", label: "Message", type: "long_text", required: true, maxLength: 4000 }, { key: "email", label: "Email", type: "email" }] },
    },
  },
  github_issue: {
    description: "Server-to-server: signed requests open a GitHub issue and a linked task.",
    config: {
      action: "task_issue",
      security: { auth: "signature", requireOrigin: false, rateLimit: { perMinute: 60, perHour: 1000, streamPerHour: 1000 } },
      fields: { list: [{ key: "title", label: "Title", type: "text", required: true, maxLength: 250 }, { key: "body", label: "Details", type: "long_text" }] },
      templates: { body: "{{body}}" },
    },
  },
  capture: {
    description: "Capture from your phone: a private page (add it to your home screen) that sends notes to the Inbox.",
    config: {
      action: "inbox",
      templates: { title: "{{title}}", titleFallback: "Captured note", body: "{{details}}", footer: false },
      fields: {
        mode: "strict",
        list: [
          { key: "title", label: "Note", type: "text", required: true, maxLength: 300 },
          { key: "details", label: "Details", type: "long_text", maxLength: 10000 },
        ],
      },
      security: { auth: "token", requireOrigin: false, allowFormPosts: false, honeypotField: null, escapeMarkdown: false, dedupeMinutes: 1, rateLimit: { perMinute: 30, perHour: 500, streamPerHour: 500 } },
      notify: { app: false },
    },
  },
  email: {
    description: "A private email address: forward or send emails to it and each one lands in the Inbox.",
    config: {
      action: "inbox",
      email: { enabled: true },
      templates: { title: "{{subject}}", titleFallback: "Email from {{from}}", body: "{{text}}\n\n_From {{from}}_", footer: false },
      fields: {
        mode: "lenient",
        list: [
          { key: "subject", label: "Subject", type: "text", maxLength: 300 },
          { key: "text", label: "Message", type: "long_text", maxLength: 20000 },
          { key: "from", label: "From", type: "email" },
        ],
      },
      security: { auth: "token", requireOrigin: false, allowFormPosts: false, honeypotField: null, dedupeMinutes: 0 },
      notify: { app: false },
    },
  },
  webhook: {
    description: "A general webhook for your own services, authenticated with a bearer token.",
    config: { action: "task", security: { auth: "token", requireOrigin: false, rateLimit: { perMinute: 120, perHour: 2000, streamPerHour: 2000 } } },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Merges a partial update into a config; lists and records are replaced, not merged. */
export function mergeConfig(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // priorityMap is a record whose keys are data, so replace it whole.
    out[k] = k === "priorityMap" ? v : mergeConfig(base[k], v);
  }
  return out;
}

/** Field keys that a payload may carry besides the declared fields. */
export function reservedKeys(cfg: StreamConfig): string[] {
  return [cfg.security.honeypotField, "cf-turnstile-response"].filter((k): k is string => !!k);
}

export function maxLengthOf(f: FieldConfig) {
  return f.maxLength || DEFAULT_MAX[f.type];
}
