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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Minus, RefreshCw, Stethoscope, TriangleAlert, Wrench, X } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { invalidateServerState } from "@/lib/query";
import type { CheckStatus, Check as CheckRow } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Badge, Empty, Loading, Panel } from "@/components/ui/Controls";
import { toastError, toastOk } from "@/stores/toast";

const MARKS: Record<CheckStatus, typeof Check> = { ok: Check, warn: TriangleAlert, fail: X, skip: Minus };
const GROUP_NAMES: Record<string, string> = {
  config: "Configuration",
  database: "Database",
  storage: "Storage",
  security: "Security",
  mail: "Email",
};

export function HealthPage() {
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

  if (health.isLoading) return <div className="page"><Loading what="Running the checks" /></div>;
  if (health.error || !health.data) {
    return (
      <div className="page">
        <Empty title="Couldn't run the checks">{describeError(health.error)}</Empty>
      </div>
    );
  }

  const checks = health.data.checks;
  const failing = checks.filter((c) => c.status === "fail").length;
  const warning = checks.filter((c) => c.status === "warn").length;
  const repairable = checks.filter((c) => c.fix && c.status !== "ok").length;

  // Group in the order the server sent them, so related checks stay together.
  const groups: { name: string; checks: CheckRow[] }[] = [];
  for (const c of checks) {
    const last = groups[groups.length - 1];
    if (last && last.name === c.group) last.checks.push(c);
    else groups.push({ name: c.group, checks: [c] });
  }

  return (
    <div className="page">
      <div className="page__inner">
        <div className="toolbar">
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>
              {failing ? `${failing} failing` : warning ? `${warning} to look at` : "All good"}
            </span>
            <span className="field__hint">
              {checks.length} checks{repairable > 0 && `, ${repairable} of which the server can repair itself`}
            </span>
          </div>
          <span className="spacer" />
          <Button icon={RefreshCw} onClick={() => void client.invalidateQueries({ queryKey: ["health"] })} busy={health.isFetching}>
            Run again
          </Button>
          <Button icon={Wrench} variant="primary" busy={running === "all"} disabled={fix.isPending} onClick={() => run("all")}>
            Repair everything
          </Button>
        </div>

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
                        <Button size="sm" icon={Wrench} busy={running === c.id} disabled={fix.isPending} onClick={() => run(c.id)}>
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
      </div>
    </div>
  );
}
