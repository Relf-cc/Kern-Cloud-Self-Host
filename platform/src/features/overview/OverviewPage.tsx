/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// What this instance is and how much is in it.
//
// The figures are aggregate on purpose: the management API counts records and
// measures spaces, and never returns what is in them. An administrator keeps
// a server running without reading the work people put in it.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  Database,
  HardDrive,
  Mail,
  Radio,
  RefreshCw,
  Share2,
  Stethoscope,
  Users,
  Zap,
} from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { bytes, count, duration, sentence, when } from "@/lib/format";
import { Badge, Dot, Empty, KeyValue, Loading, Panel, Stat } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { DonutChart, type Slice } from "@/components/charts";
import { BrandMark } from "@/app/BrandMark";
import { useRouter } from "@/stores/router";
import { Activity30 } from "./Activity30";

export function OverviewPage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.admin.overview, refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ["health"], queryFn: api.admin.health, refetchInterval: 120_000 });
  const client = useQueryClient();
  const go = useRouter((s) => s.go);

  if (overview.isLoading) {
    return (
      <Page>
        <PageHeader icon={Activity} title="Overview" />
        <PageBody>
          <Loading what="Asking the server" />
        </PageBody>
      </Page>
    );
  }
  if (overview.error || !overview.data) {
    return (
      <Page>
        <PageHeader icon={Activity} title="Overview" />
        <PageBody narrow>
          <Empty title="Couldn't read the overview">{describeError(overview.error)}</Empty>
        </PageBody>
      </Page>
    );
  }

  const d = overview.data;
  const failing = health.data?.checks.filter((c) => c.status === "fail") ?? [];
  const warning = health.data?.checks.filter((c) => c.status === "warn") ?? [];

  // Three measured figures, so three slices. Anything the server doesn't
  // measure is absent rather than lumped into an "other" that would be a
  // guess.
  const storage: Slice[] = [
    { label: "Database", value: d.storage.databaseBytes, display: bytes(d.storage.databaseBytes) },
    { label: "Shared images", value: d.storage.assetBytes, display: bytes(d.storage.assetBytes) },
    { label: "Share images", value: d.storage.shareImageBytes, display: bytes(d.storage.shareImageBytes) },
  ];
  const storageTotal = storage.reduce((sum, s) => sum + s.value, 0);

  // Live records against the tombstones left behind by deletions. The ratio is
  // the thing worth seeing: tombstones have to stay so other computers learn
  // about a deletion, but a space that is mostly tombstones is one Health
  // should be asked about.
  const live = Math.max(0, d.spaces.records - d.spaces.tombstones);
  const records: Slice[] = [
    { label: "Live records", value: live, display: count(live) },
    { label: "Tombstones", value: d.spaces.tombstones, display: count(d.spaces.tombstones) },
  ];

  return (
    <Page>
      <PageHeader
        icon={Activity}
        title="Overview"
        sub={`version ${d.instance.version}`}
        actions={
          <Button
            size="sm"
            icon={RefreshCw}
            busy={overview.isFetching}
            onClick={() => {
              void client.invalidateQueries({ queryKey: ["overview"] });
              void client.invalidateQueries({ queryKey: ["health"] });
            }}
          >
            Refresh
          </Button>
        }
      />

      <PageBody>
        <div className="instance">
          <BrandMark className="instance__mark" size={40} />
          <div className="instance__text">
            <span className="instance__name">{d.instance.name}</span>
            <span className="instance__url selectable">{d.instance.apiUrl}</span>
            <span className="instance__meta">
              <span>
                <Dot tone="live" /> up {duration(d.instance.uptimeSeconds)}
              </span>
              <span>node {d.instance.nodeVersion}</span>
              <span>{d.instance.platform}</span>
            </span>
          </div>
          <span className="instance__side">
            <Badge tone={d.instance.registration === "open" ? "warn" : "quiet"}>{sentence(d.instance.registration)} sign-ups</Badge>
            {!d.mail.configured && <Badge tone="warn">no email</Badge>}
          </span>
        </div>

        {(failing.length > 0 || warning.length > 0) && (
          <Panel
            icon={Stethoscope}
            title={
              failing.length
                ? `${failing.length} check${failing.length === 1 ? "" : "s"} failing`
                : `${warning.length} check${warning.length === 1 ? "" : "s"} to look at`
            }
            actions={
              <Button size="sm" onClick={() => go("health")}>
                Open Health
              </Button>
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
          </Panel>
        )}

        <div className="stat-grid">
          <Stat
            icon={Users}
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
            icon={Database}
            label="Spaces"
            value={count(d.spaces.personal + d.spaces.workspaces)}
            sub={`${d.spaces.personal} personal · ${d.spaces.workspaces} shared`}
          />
          <Stat icon={Database} label="Records" value={count(live)} sub={`${count(d.spaces.tombstones)} tombstones`} />
          <Stat
            icon={Zap}
            label="Connected now"
            value={count(d.realtime.connections ?? 0)}
            sub={`in ${count(d.realtime.rooms ?? 0)} space${(d.realtime.rooms ?? 0) === 1 ? "" : "s"}`}
          />
          <Stat icon={HardDrive} label="Storage" value={bytes(storageTotal)} sub={`${bytes(d.storage.databaseBytes)} of it database`} />
          <Stat
            icon={Radio}
            label="Deliveries today"
            value={count(d.streams.deliveriesToday)}
            sub={
              d.streams.failuresToday
                ? `${count(d.streams.failuresToday)} failed`
                : `${d.streams.enabled} of ${d.streams.total} stream${d.streams.total === 1 ? "" : "s"} on`
            }
          />
        </div>

        <Activity30 />

        <div className="panel-pair">
          <Panel title="What the storage is" icon={HardDrive}>
            <DonutChart
              slices={storage}
              centre={bytes(storageTotal)}
              caption="measured"
              ariaLabel="Storage by kind"
            />
            <p className="field__hint">
              The database figure is the whole database, so it carries the records, the membership and the delivery logs together. Images
              are counted separately because they are the part that grows without anybody deciding to let it.
            </p>
          </Panel>

          <Panel title="Records and tombstones" icon={Database}>
            <DonutChart slices={records} centre={count(d.spaces.records)} caption="rows" ariaLabel="Live records against tombstones" />
            <p className="field__hint">
              A tombstone is a record someone deleted. They stay so other computers learn about the deletion; clearing them early would
              let a stale copy bring the record back. Health purges the ones that are old enough to be safe.
            </p>
          </Panel>
        </div>

        <div className="panel-pair">
          <Panel title="This instance" icon={Activity}>
            <KeyValue
              rows={[
                ["Address", <span className="mono selectable">{d.instance.publicUrl}</span>],
                ["Started", when(d.instance.startedAt)],
                ["Uptime", duration(d.instance.uptimeSeconds)],
                ["Sign-ups", sentence(d.instance.registration)],
                [
                  "Email",
                  d.mail.configured ? (
                    <span className="mono">{d.mail.from}</span>
                  ) : (
                    <span style={{ color: "var(--warning)" }}>Not configured — codes go to the log</span>
                  ),
                ],
              ]}
            />
          </Panel>

          <Panel title="People" icon={Users}>
            <KeyValue
              rows={[
                ["Memberships", count(d.collaboration.members)],
                ["Shared workspaces", count(d.collaboration.sharedWorkspaces)],
                ["Open invitations", count(d.collaboration.openInvites)],
                ["New this week", count(d.accounts.newThisWeek)],
                ["Deleted spaces", count(d.spaces.deleted)],
              ]}
            />
          </Panel>
        </div>

        <div className="panel-pair">
          <Panel title="Streams" icon={Radio}>
            <p className="field__hint">
              {d.streams.total === 0
                ? "No inbound endpoints yet. People create these in Kern, per workspace, to turn a form or a webhook into a task."
                : `${d.streams.enabled} of ${d.streams.total} enabled. ${count(d.streams.deliveriesToday)} delivered today${
                    d.streams.failuresToday ? `, ${count(d.streams.failuresToday)} refused` : ""
                  }.`}
            </p>
          </Panel>
          <Panel title="Publishing" icon={Share2}>
            <p className="field__hint">
              {d.shares.enabled
                ? `Read-only share links and calendar feeds are on: ${count(d.shares.links)} link${
                    d.shares.links === 1 ? "" : "s"
                  } and ${count(d.shares.calendarFeeds)} calendar feed${d.shares.calendarFeeds === 1 ? "" : "s"}.`
                : "Turned off: existing links stop resolving as well as new ones."}
            </p>
          </Panel>
          <Panel title="Mail" icon={Mail}>
            <p className="field__hint">
              {d.mail.configured
                ? "Verification codes and invitations are being sent."
                : "No SMTP, so nobody can finish signing up without you reading the log or marking them verified."}
            </p>
          </Panel>
        </div>

        <p className="field__hint row" style={{ gap: 6 }}>
          <Clock strokeWidth={1.75} style={{ width: 13, height: 13 }} />
          These figures are counts and sizes. The management API never returns what is inside a space, so nothing on this page can.
        </p>
      </PageBody>
    </Page>
  );
}
