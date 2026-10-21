/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// A read-only window on the database, for the question a built-in page never
// anticipated.
//
// The server does the refusing, not this page: one statement, it must start
// with SELECT or WITH, and it runs inside a read-only transaction with a
// statement timeout, which is rolled back. That last part is what actually
// holds - a clever SELECT can still call a function that writes, and only
// Postgres can refuse that reliably. The rules are repeated here because
// somebody typing SQL deserves to know them before they press the button,
// not after.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play, Table2 } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { count } from "@/lib/format";
import type { QueryReply } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Empty, Panel } from "@/components/ui/Controls";

const EXAMPLES: { label: string; sql: string }[] = [
  { label: "Accounts by month", sql: `SELECT to_char("createdAt", 'YYYY-MM') AS month, count(*) AS accounts\nFROM "user" GROUP BY 1 ORDER BY 1 DESC` },
  { label: "Biggest workspaces", sql: `SELECT s.name, count(r.id) AS records\nFROM kern_space s LEFT JOIN kern_record r ON r.space_id = s.id\nWHERE s.kind = 'workspace' AND s.deleted_at IS NULL\nGROUP BY s.id, s.name ORDER BY records DESC LIMIT 20` },
  { label: "Records by table", sql: `SELECT tbl, count(*) FILTER (WHERE NOT deleted) AS live, count(*) FILTER (WHERE deleted) AS tombstones\nFROM kern_record GROUP BY tbl ORDER BY live DESC` },
  { label: "Stream failures this week", sql: `SELECT s.name, e.status, e.code, count(*) AS n\nFROM kern_stream_event e JOIN kern_stream s ON s.id = e.stream_id\nWHERE e.received_at > now() - interval '7 days' AND e.status IN ('failed','rejected')\nGROUP BY 1,2,3 ORDER BY n DESC` },
  { label: "Who hasn't verified", sql: `SELECT email, "createdAt" FROM "user" WHERE "emailVerified" = false ORDER BY "createdAt" DESC` },
];

export function ConsolePage() {
  const [sql, setSql] = useState(EXAMPLES[0]!.sql);
  const [result, setResult] = useState<QueryReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => api.admin.query(sql),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e) => {
      setResult(null);
      setError(describeError(e, "The database refused that."));
    },
  });

  return (
    <div className="page">
      <div className="page__inner">
        <Panel title="Query">
          <textarea
            className="textarea textarea--mono"
            rows={7}
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && sql.trim()) run.mutate();
            }}
          />
          <div className="toolbar">
            <Button variant="primary" icon={Play} busy={run.isPending} disabled={!sql.trim()} onClick={() => run.mutate()}>
              Run
            </Button>
            <span className="field__hint">Ctrl+Enter · one SELECT, read-only, 10 second limit, 200 rows</span>
            <span className="spacer" />
            <select
              className="select"
              style={{ width: 200 }}
              value=""
              onChange={(e) => {
                const found = EXAMPLES.find((x) => x.label === e.target.value);
                if (found) {
                  setSql(found.sql);
                  setResult(null);
                  setError(null);
                }
              }}
            >
              <option value="">Examples…</option>
              {EXAMPLES.map((x) => (
                <option key={x.label} value={x.label}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="field__error">{error}</p>}
        </Panel>

        {result && (
          <Panel
            title={`${count(result.rowCount)} row${result.rowCount === 1 ? "" : "s"}${result.truncated ? " — truncated at 200" : ""}`}
            flush
          >
            {!result.rows.length ? (
              <Empty icon={Table2} title="No rows" compact />
            ) : (
              <div className="console__out">
                <table className="table">
                  <thead>
                    <tr>
                      {result.fields.map((f) => (
                        <th key={f}>{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {result.fields.map((f) => (
                          <td key={f} className="selectable">
                            {cell(row[f])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        <Panel title="What this will and won't do">
          <p className="field__hint">
            The server accepts one statement, beginning <code className="mono">SELECT</code> or <code className="mono">WITH</code>, and runs
            it in a read-only transaction that is rolled back whatever happens, with a ten-second timeout. Nothing typed here can change
            anything. Every query is recorded in the audit trail with the token that ran it.
          </p>
          <p className="field__hint">
            To change something, use the pages that know what a change means — they keep the sequence numbers, membership rows and realtime
            notifications consistent, which hand-written SQL would not. The same window is{" "}
            <code className="mono">kernctl query &quot;SELECT …&quot;</code>.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
