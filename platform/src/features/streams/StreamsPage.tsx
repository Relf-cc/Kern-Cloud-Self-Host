/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Inbound stream endpoints, across every workspace on this instance.
//
// Streams are the one thing on a Kern server that anybody on the internet can
// post to, so this is the page to reach for when a server is being hammered:
// the switch here turns an endpoint off without touching its configuration or
// its delivery log, and whoever owns it can turn it back on in Kern.
//
// A stream's id is also its URL, which makes it a secret. The list shows a
// shortened form; the whole thing is behind a click, so a screenshot of this
// page doesn't hand out a working endpoint.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Radio } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { ago, count, day } from "@/lib/format";
import type { Stream } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, Empty, Loading, Panel, Stat, Switch } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { BarsChart } from "@/components/charts";
import { toastError, toastOk } from "@/stores/toast";

export function StreamsPage() {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const client = useQueryClient();
  const streams = useQuery({ queryKey: ["streams"], queryFn: api.admin.streams });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.admin.setStream(id, enabled),
    onSuccess: (r) => {
      toastOk(r.enabled ? "Stream enabled." : "Stream disabled. Submissions to it are refused.");
      void client.invalidateQueries({ queryKey: ["streams"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  const reveal = (id: string) =>
    setRevealed((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = streams.data?.streams ?? [];
  const failing = rows.filter((s) => s.failuresThisWeek > 0);

  const enabled = rows.filter((s) => s.enabled).length;

  return (
    <Page>
      <PageHeader
        icon={Radio}
        title="Streams"
        sub={rows.length ? `${enabled} of ${rows.length} on` : undefined}
        actions={
          <Button
            size="sm"
            onClick={() => {
              const on = rows.filter((s) => s.enabled);
              if (!on.length) return toastOk("Nothing is enabled.");
              for (const s of on) toggle.mutate({ id: s.fullId, enabled: false });
            }}
            disabled={!rows.some((s) => s.enabled)}
          >
            Disable every stream
          </Button>
        }
      />

      <PageBody>
        {failing.length > 0 && (
          <Panel title={`${failing.length} stream${failing.length === 1 ? " is" : "s are"} refusing submissions`} icon={Radio}>
            <p className="field__hint">
              A failure is a submission the server turned away: a wrong signature, a body that didn&rsquo;t fit the stream&rsquo;s shape, or
              a rate limit. The delivery log in Kern says which, per submission, for whoever owns the workspace.
            </p>
          </Panel>
        )}

        <Busiest streams={rows} />

        <Panel flush>
          {streams.isLoading ? (
            <Loading what="Asking the server" />
          ) : streams.error ? (
            <Empty title="Couldn't list streams">{describeError(streams.error)}</Empty>
          ) : !rows.length ? (
            <Empty icon={Radio} title="No streams yet">
              People create these in Kern, per workspace, to turn website forms and services into tasks.
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Stream</th>
                  <th className="right">Delivered</th>
                  <th>Last</th>
                  <th className="right">On</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.fullId}>
                    <td>
                      <div className="col" style={{ gap: 3 }}>
                        <span className="row" style={{ gap: 7 }}>
                          <span>{s.name}</span>
                          {s.failuresThisWeek > 0 && <Badge tone="warn">{s.failuresThisWeek} failed this week</Badge>}
                        </span>
                        <span className="table__sub">{s.workspace.name}</span>
                        <span className="row" style={{ gap: 6 }}>
                          <code className="mono table__sub selectable">{revealed.has(s.fullId) ? s.fullId : s.id}</code>
                          <IconButton
                            icon={revealed.has(s.fullId) ? EyeOff : Eye}
                            label={revealed.has(s.fullId) ? "Hide the endpoint id" : "Show the whole endpoint id"}
                            size="sm"
                            onClick={() => reveal(s.fullId)}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="right">{count(s.deliveries)}</td>
                    <td className="table__sub">{s.lastDeliveryAt ? ago(s.lastDeliveryAt) : `created ${day(s.createdAt)}`}</td>
                    <td className="right">
                      <Switch
                        checked={s.enabled}
                        label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                        disabled={toggle.isPending}
                        onChange={(enabled) => toggle.mutate({ id: s.fullId, enabled })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="If a stream is being abused">
          <p className="field__hint">
            Turning it off here refuses every submission immediately, which is the fastest thing you can do and costs the workspace
            nothing permanent — its configuration, its secret and its delivery log are untouched. For a rate problem across the whole
            instance rather than one endpoint, the ceilings are <code className="mono">STREAM_MAX_PER_HOUR</code> and{" "}
            <code className="mono">STREAM_MAX_BODY_BYTES</code> in <code className="mono">.env</code>, which need a restart. The switch for
            every endpoint at once is in this page&rsquo;s header.
          </p>
        </Panel>
      </PageBody>
    </Page>
  );
}

/**
 * Which endpoints are actually carrying the traffic, as a bar per endpoint.
 *
 * Deliveries are a lifetime count, so this is "who has been busiest", not
 * "who is busy now" - which is the question worth asking when deciding whether
 * an endpoint is worth the attention it is costing.
 */
function Busiest({ streams }: { streams: Stream[] }) {
  const top = useMemo(
    () =>
      [...streams]
        .filter((s) => s.deliveries > 0)
        .sort((a, b) => b.deliveries - a.deliveries)
        .slice(0, 8),
    [streams],
  );

  if (top.length < 2) return null;

  const delivered = streams.reduce((sum, s) => sum + s.deliveries, 0);
  const failures = streams.reduce((sum, s) => sum + s.failuresThisWeek, 0);
  const tip = (index: number) => {
    const s = top[index]!;
    const failed = s.failuresThisWeek ? ` · ${count(s.failuresThisWeek)} refused this week` : "";
    return `${count(s.deliveries)} delivered${failed} · ${s.workspace.name}`;
  };

  return (
    <Panel title="Busiest endpoints" icon={Radio}>
      <div className="stat-row">
        <Stat label="Delivered" value={count(delivered)} sub="since each was created" />
        <Stat label="Refused this week" value={count(failures)} />
        <Stat label="Endpoints" value={count(streams.length)} />
      </div>
      <BarsChart labels={top.map((s) => s.name)} values={top.map((s) => s.deliveries)} tip={tip} ariaLabel="Streams by deliveries" />
    </Panel>
  );
}
