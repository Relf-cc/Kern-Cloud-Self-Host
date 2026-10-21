/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Every check the server runs on itself, and the repairs that go with them.
//
// A check with a repair is safe to run at any time and safe to run twice: it
// removes expired rows, reclaims space, or restores a row that should always
// have been there. Nothing here deletes anybody's work - that lives on the
// pages for the thing being deleted, behind a typed confirmation.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Minus, RefreshCw, Stethoscope, TriangleAlert, Wrench, X } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { invalidateServerState } from "@/lib/query";
import { css } from "@/components/charts/theme";
import type { CheckStatus, Check as CheckRow } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Badge, Empty, Loading, Panel } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { DonutChart, type Slice } from "@/components/charts";
import { toastError, toastOk } from "@/stores/toast";

const MARKS: Record<CheckStatus, typeof Check> = { ok: Check, warn: TriangleAlert, fail: X, skip: Minus };
const GROUP_NAMES: Record<string, string> = {
  config: "Configuration",
  database: "Database",
  storage: "Storage",
  security: "Security",
  mail: "Email",
};

export function HealthPage({ readOnly = false }: { readOnly?: boolean }) {
  const [running, setRunning] = useState<string | null>(null);
  const client = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: api.admin.health, refetchInterval: 60_000 });

  const fix = useMutation({
    mutationFn: (id: string | "all") => (id === "all" ? api.admin.fixAll() : api.admin.fix(id)),
    onSuccess: (reply) => {
      const failed = reply.results.filter((r) => r.failed);
      const done = reply.results.filter((r) => !r.failed && r.done);
      if (done.length) toastOk(done.length === 1 ? done[0]!.done : `${done.length} repairs run.`);
      for (const f of failed) toastError(`${f.id}: ${f.failed}`);
      // A repair can move almost any figure on any page.
      invalidateServerState();
      void client.invalidateQueries({ queryKey: ["health"] });
    },
    onError: (e) => toastError(describeError(e)),
    onSettled: () => setRunning(null),
  });

  const run = (id: string | "all") => {
    setRunning(id);
    fix.mutate(id);
  };

  const checks = health.data?.checks ?? [];
  const tally = useMemo(() => {
    const of = (status: CheckStatus) => checks.filter((c) => c.status === status).length;
    return { ok: of("ok"), warn: of("warn"), fail: of("fail"), skip: of("skip") };
  }, [checks]);

  // A ring of states, so these take the reserved status tones rather than the
  // greyscale ramp - and every one of them is named in the legend beside it,
  // with its count, because a colour alone must never be the signal.
  const composition: Slice[] = [
    { label: "Passing", value: tally.ok, display: String(tally.ok) },
    { label: "To look at", value: tally.warn, display: String(tally.warn) },
    { label: "Failing", value: tally.fail, display: String(tally.fail) },
    { label: "Not applicable", value: tally.skip, display: String(tally.skip) },
  ];
  const statusTones = [css("--hue-2", "#82b48f"), css("--warning", "#cfae74"), css("--danger", "#e0716f"), css("--text-4", "#5e5e5e")];

  if (health.isLoading) {
    return (
      <Page>
        <PageHeader icon={Stethoscope} title="Health" />
        <PageBody>
          <Loading what="Running the checks" />
        </PageBody>
      </Page>
    );
  }
  if (health.error || !health.data) {
    return (
      <Page>
        <PageHeader icon={Stethoscope} title="Health" />
        <PageBody narrow>
          <Empty title="Couldn't run the checks">{describeError(health.error)}</Empty>
        </PageBody>
      </Page>
    );
  }

  const repairable = checks.filter((c) => c.fix && c.status !== "ok").length;

  // Group in the order the server sent them, so related checks stay together.
  const groups: { name: string; checks: CheckRow[] }[] = [];
  for (const c of checks) {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.checks.push(c);
    else groups.push({ name: c.group, checks: [c] });
  }

  const headline = tally.fail ? `${tally.fail} failing` : tally.warn ? `${tally.warn} to look at` : "All good";

  return (
    <Page>
      <PageHeader
        icon={Stethoscope}
        title="Health"
        sub={`${headline} · ${checks.length} checks`}
        actions={
          <>
            <Button size="sm" icon={RefreshCw} onClick={() => void client.invalidateQueries({ queryKey: ["health"] })} busy={health.isFetching}>
              Run again
            </Button>
            <Button
              size="sm"
              icon={Wrench}
              variant="primary"
              busy={running === "all"}
              disabled={fix.isPending || readOnly || repairable === 0}
              title={readOnly ? "This token is read-only" : repairable === 0 ? "Nothing to repair" : undefined}
              onClick={() => run("all")}
            >
              Repair everything
            </Button>
          </>
        }
      />

      <PageBody>
        <Panel title="Where this instance stands" icon={Stethoscope}>
          <DonutChart
            slices={composition}
            tones={statusTones}
            centre={headline}
            caption={`of ${checks.length}`}
            ariaLabel="Checks by state"
          />
          <p className="field__hint">
            {repairable > 0
              ? `${repairable} of these the server can repair itself. A repair removes expired rows, reclaims space or restores a row that should always have been there — it is safe to run twice, and it never touches anybody's work.`
              : "Nothing here needs a repair. The ones marked not applicable are checks for features this instance doesn't have turned on."}
          </p>
        </Panel>

        <Panel flush>
          {groups.map((g) => (
            <div key={g.name}>
              <div className="check__group">{GROUP_NAMES[g.name] ?? g.name}</div>
              {g.checks.map((c) => (
                <div className="check" key={c.id}>
                  <span className="check__mark" data-status={c.status}>
                    {(() => {
                      const Mark = MARKS[c.status];
                      return <Mark strokeWidth={2.5} />;
                    })()}
                  </span>
                  <div className="check__body">
                    <span className="check__title">{c.title}</span>
                    <span className="check__detail">{c.detail}</span>
                    {c.facts && Object.keys(c.facts).length > 0 && (
                      <span className="check__facts">
                        {Object.entries(c.facts).map(([k, v]) => (
                          <span key={k}>
                            <span className="faint">{k}</span> {String(v)}
                          </span>
                        ))}
                      </span>
                    )}
                    {c.fix && (
                      <div className="check__fix">
                        <Button
                          size="sm"
                          icon={Wrench}
                          busy={running === c.id}
                          disabled={fix.isPending || readOnly}
                          title={readOnly ? "This token is read-only" : undefined}
                          onClick={() => run(c.id)}
                        >
                          Repair
                        </Button>
                        <span className="check__fix-text">{c.fix}</span>
                      </div>
                    )}
                  </div>
                  {c.status === "skip" && <Badge tone="quiet">not applicable</Badge>}
                </div>
              ))}
            </div>
          ))}
        </Panel>

        <Panel title="The same from a terminal" icon={Stethoscope}>
          <p className="field__hint">
            Everything on this page is <code className="mono">kernctl health</code>, and &ldquo;Repair everything&rdquo; is{" "}
            <code className="mono">kernctl heal</code>. <code className="mono">kernctl health</code> exits 4 when a check is failing, so it
            works as a monitoring check; <code className="mono">kernctl doctor</code> looks at the machine and the path to the server
            instead, which is the one to reach for when nothing answers at all.
          </p>
        </Panel>
      </PageBody>
    </Page>
  );
}
