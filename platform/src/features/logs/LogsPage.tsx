/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Two records, side by side: what the server has been saying, and what
// management tokens have been doing to it.
//
// The log is a window on a running process, not an archive. It lives in the
// server's memory and is empty after a restart - which is worth saying on the
// page, so an empty log doesn't read as a broken one. The audit trail is in
// the database and does survive.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { FileText, Megaphone, Pause, Play } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { ago, when } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Empty, Field, Loading, Panel, Segmented } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { Dialog } from "@/components/ui/Dialog";
import { toastError, toastOk } from "@/stores/toast";

type Level = "" | "warn" | "error";

export function LogsPage() {
  const [level, setLevel] = useState<Level>("");
  const [following, setFollowing] = useState(true);
  const [announcing, setAnnouncing] = useState(false);

  // Always asked for from the start of what the server still holds: the
  // buffer is small, and a scrollback that jumps about is worse than one that
  // simply redraws.
  const logs = useQuery({
    queryKey: ["logs", level],
    queryFn: () => api.admin.logs(0, level || undefined),
    refetchInterval: following ? 3000 : false,
  });

  const audit = useQuery({ queryKey: ["audit"], queryFn: api.admin.audit });

  return (
    <Page>
      <PageHeader
        icon={FileText}
        title="Logs"
        sub={following ? "following" : "paused"}
        actions={
          <>
            <Segmented
              size="sm"
              ariaLabel="Which lines"
              value={level}
              onChange={setLevel}
              options={[
                { value: "", label: "Everything" },
                { value: "warn", label: "Warnings" },
                { value: "error", label: "Errors" },
              ]}
            />
            <Button size="sm" icon={following ? Pause : Play} onClick={() => setFollowing((v) => !v)}>
              {following ? "Pause" : "Follow"}
            </Button>
            <Button size="sm" icon={Megaphone} onClick={() => setAnnouncing(true)}>
              Tell everyone something
            </Button>
          </>
        }
      />

      <PageBody>
        <Panel
          title={logs.data ? `Server log · ${logs.data.held} line${logs.data.held === 1 ? "" : "s"} held` : "Server log"}
        >
          {logs.isLoading ? (
            <Loading what="Reading the log" />
          ) : logs.error ? (
            <Empty title="Couldn't read the log">{describeError(logs.error)}</Empty>
          ) : !logs.data?.lines.length ? (
            <Empty title="Nothing here">
              The log lives in the server&rsquo;s memory and is empty after a restart. Your init system has the full one:{" "}
              <code className="mono">kernctl service logs</code>.
            </Empty>
          ) : (
            <div className="log">
              {logs.data.lines.map((l) => (
                <div className="log__line" key={l.n} data-level={l.level}>
                  <span className="log__time">{l.at.slice(11, 19)}</span>
                  <span className="log__text">{l.text}</span>
                </div>
              ))}
            </div>
          )}
          <p className="field__hint">
            Tokens, database passwords and one-time codes are stripped before a line is kept, so this is safe to paste into a bug report.
          </p>
        </Panel>

        <Panel title="What management tokens have done" flush>
          {audit.isLoading ? (
            <Loading />
          ) : !audit.data?.entries.length ? (
            <Empty compact>Nothing yet.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>On</th>
                  <th>By</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.action}</td>
                    <td>
                      <div className="col">
                        <span className="mono table__sub">{e.target ?? "—"}</span>
                        {Object.keys(e.detail ?? {}).length > 0 && (
                          <span className="table__sub">
                            {Object.entries(e.detail)
                              .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                              .join(" · ")
                              .slice(0, 120)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="table__sub">
                      {e.by ?? "—"}
                      {e.ip ? <span className="faint"> from {e.ip}</span> : null}
                    </td>
                    <td className="table__sub" title={when(e.at)}>
                      {ago(e.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </PageBody>

      {announcing && <NoticeDialog onClose={() => setAnnouncing(false)} />}
    </Page>
  );
}

/** An instance-wide message to everyone with Kern open right now. */
function NoticeDialog({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [level, setLevel] = useState<"info" | "warn">("info");

  const send = useMutation({
    mutationFn: () => api.admin.notice(message.trim(), level),
    onSuccess: (r) => {
      toastOk(`Sent to ${r.to}.`);
      onClose();
    },
    onError: (e) => toastError(describeError(e)),
  });

  return (
    <Dialog
      title="Tell everyone something"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={send.isPending} disabled={!message.trim()} onClick={() => send.mutate()}>
            Send
          </Button>
        </>
      }
    >
      <p className="field__hint">
        This goes down the realtime connection to everyone with Kern open against this server, right now. People who are offline will never
        see it, so it is for &ldquo;restarting in five minutes&rdquo; rather than anything that has to arrive.
      </p>
      <Field label="Message">
        <textarea
          className="textarea"
          rows={3}
          maxLength={300}
          value={message}
          placeholder="Restarting in five minutes for an upgrade."
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>
      <Field label="Tone">
        <select className="select" value={level} onChange={(e) => setLevel(e.target.value as "info" | "warn")}>
          <option value="info">Ordinary</option>
          <option value="warn">Something to act on</option>
        </select>
      </Field>
    </Dialog>
  );
}
