/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// What this instance is and how much is in it.
//
// The figures are aggregate on purpose: the management API counts records and
// measures spaces, and never returns what is in them. An administrator keeps
// a server running without reading the work people put in it.

import { useQuery } from "@tanstack/react-query";
import { Activity, Database, Mail, Radio, Share2, Users } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { bytes, count, duration, sentence, when } from "@/lib/format";
import { Badge, Dot, Empty, KeyValue, Loading, Panel, Stat } from "@/components/ui/Controls";
import { useRouter } from "@/stores/router";
import { Activity30 } from "./Activity30";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.admin.overview, refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ["health"], queryFn: api.admin.health, refetchInterval: 120_000 });
  const go = useRouter((s) => s.go);

  if (overview.isLoading) return <div className="page"><Loading what="Asking the server" /></div>;
  if (overview.error || !overview.data) {
    return (
      <div className="page">
        <Empty title="Couldn't read the overview">{describeError(overview.error)}</Empty>
      </div>
    );
  }

  const d = overview.data;
  const failing = health.data?.checks.filter((c) => c.status === "fail") ?? [];
  const warning = health.data?.checks.filter((c) => c.status === "warn") ?? [];

  return (
    <div className="page">
      <div className="page__inner">
        <div className="instance">
          <div className="instance__text">
            <span className="instance__name">{d.instance.name}</span>
            <span className="instance__url selectable">{d.instance.apiUrl}</span>
            <span className="instance__meta">
              <span>
                <Dot tone="live" /> up {duration(d.instance.uptimeSeconds)}
              </span>
              <span>version {d.instance.version}</span>
              <span>node {d.instance.nodeVersion}</span>
              <span>{d.instance.platform}</span>
            </span>
          </div>
          <Badge tone={d.instance.registration === "open" ? "warn" : "quiet"}>{sentence(d.instance.registration)} sign-ups</Badge>
        </div>

        {(failing.length > 0 || warning.length > 0) && (
          <Panel
            title={
              failing.length
                ? `${failing.length} check${failing.length === 1 ? "" : "s"} failing`
                : `${warning.length} check${warning.length === 1 ? "" : "s"} to look at`
            }
          >
            <ul className="col" style={{ gap: 6 }}>
              {[...failing, ...warning].slice(0, 4).map((c) => (
                <li key={c.id} className="row" style={{ alignItems: "flex-start", gap: 9 }}>
                  <Dot tone={c.status === "fail" ? "fail" : "warn"} />
                  <span className="grow" style={{ fontSize: "var(--fs-sm)" }}>
                    <b style={{ fontWeight: 550 }}>{c.title}.</b> <span className="muted">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <button className="btn btn--sm" style={{ alignSelf: "flex-start" }} onClick={() => go("health")}>
              Open Health
            </button>
          </Panel>
        )}

        <div className="stat-grid">
          <Stat
            label="Accounts"
            value={count(d.accounts.total)}
            sub={
              <>
                {d.accounts.verified} verified
                {d.accounts.held > 0 && <> · {d.accounts.held} suspended</>}
                {d.accounts.limit > 0 && <> · limit {d.accounts.limit}</>}
              </>
            }
          />
          <Stat
            label="Spaces"
            value={count(d.spaces.personal + d.spaces.workspaces)}
            sub={`${d.spaces.personal} personal · ${d.spaces.workspaces} shared`}
          />
          <Stat
            label="Records"
            value={count(d.spaces.records - d.spaces.tombstones)}
            sub={`${count(d.spaces.tombstones)} tombstones`}
          />
          <Stat label="Connected now" value={count(d.realtime.connections ?? 0)} sub={`in ${d.realtime.rooms ?? 0} space(s)`} />
          <Stat label="Database" value={bytes(d.storage.databaseBytes)} sub={`${bytes(d.storage.assetBytes)} of images`} />
          <Stat
            label="Deliveries today"
            value={count(d.streams.deliveriesToday)}
            sub={d.streams.failuresToday ? `${d.streams.failuresToday} failed` : `${d.streams.enabled} stream(s) on`}
          />
        </div>

        <Activity30 />

        <div className="detail">
          <Panel title="This instance" icon={Activity}>
            <KeyValue
              rows={[
                ["Address", <span className="mono selectable">{d.instance.publicUrl}</span>],
                ["Started", when(d.instance.startedAt)],
                ["Sign-ups", sentence(d.instance.registration)],
                [
                  "Email",
                  d.mail.configured ? (
                    <span className="mono">{d.mail.from}</span>
                  ) : (
                    <span style={{ color: "var(--warning)" }}>Not configured — codes go to the log</span>
                  ),
                ],
                ["Publishing", d.shares.enabled ? `${d.shares.links} links, ${d.shares.calendarFeeds} calendar feeds` : "Turned off"],
              ]}
            />
          </Panel>

          <div className="col" style={{ gap: 16 }}>
            <Panel title="People" icon={Users}>
              <KeyValue
                rows={[
                  ["Memberships", count(d.collaboration.members)],
                  ["Shared workspaces", count(d.collaboration.sharedWorkspaces)],
                  ["Open invitations", count(d.collaboration.openInvites)],
                  ["New this week", count(d.accounts.newThisWeek)],
                ]}
              />
            </Panel>
            <Panel title="Storage" icon={Database}>
              <KeyValue
                rows={[
                  ["Database", bytes(d.storage.databaseBytes)],
                  ["Shared images", `${bytes(d.storage.assetBytes)} in ${count(d.storage.assetCount)}`],
                  ["Share images", bytes(d.storage.shareImageBytes)],
                  ["Deleted spaces", count(d.spaces.deleted)],
                ]}
              />
            </Panel>
          </div>
        </div>

        <div className="stat-grid">
          <Panel title="Streams" icon={Radio}>
            <span className="field__hint">
              {d.streams.total === 0
                ? "No inbound endpoints yet. People create these in Kern, per workspace."
                : `${d.streams.enabled} of ${d.streams.total} enabled.`}
            </span>
          </Panel>
          <Panel title="Publishing" icon={Share2}>
            <span className="field__hint">
              {d.shares.enabled ? "Read-only share links and calendar feeds are on." : "Turned off: existing links stop resolving."}
            </span>
          </Panel>
          <Panel title="Mail" icon={Mail}>
            <span className="field__hint">
              {d.mail.configured
                ? "Verification codes and invitations are being sent."
                : "No SMTP, so nobody can finish signing up without you reading the log or marking them verified."}
            </span>
          </Panel>
        </div>
      </div>
    </div>
  );
}
