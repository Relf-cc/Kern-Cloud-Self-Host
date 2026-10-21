/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Accounts, who may make one, and the invitations in flight.
//
// The strong tool here is the hold: it refuses new sessions and closes open
// sockets without touching a single record, and it is reversible. Deleting an
// account is the other end of the scale - it takes their personal space and
// any workspace they own with it, so it asks for the address to be typed and
// refuses outright while other people are still using a workspace they own.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, MailCheck, Plus, Search, ShieldCheck, Trash2, UserRoundX, Users } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { ago, count, day, sentence, shortDay } from "@/lib/format";
import type { User } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, Empty, Field, KeyValue, Loading, Panel, Segmented, Stat } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { TrendChart } from "@/components/charts";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { toastError, toastOk } from "@/stores/toast";
import { useRouter } from "@/stores/router";

type Filter = "" | "held" | "unverified";

export function PeoplePage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("");
  const selection = useRouter((s) => s.selection);
  const open = useRouter((s) => s.open);

  const users = useQuery({ queryKey: ["users", query, filter], queryFn: () => api.admin.users({ q: query, filter }) });

  return (
    <Page>
      <PageHeader
        icon={Users}
        title="People"
        sub={users.data ? `${count(users.data.total)} account${users.data.total === 1 ? "" : "s"}` : undefined}
        actions={
          <>
            <div className="input-wrap" style={{ width: 240 }}>
              <Search strokeWidth={1.75} />
              <input className="input" placeholder="Search by name or address" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Segmented
              size="sm"
              ariaLabel="Which accounts"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "", label: "Everyone" },
                { value: "unverified", label: "Unverified" },
                { value: "held", label: "Suspended" },
              ]}
            />
          </>
        }
      />

      <PageBody>
        <SignUps />

        <div className="detail">
          <Panel flush>
            {users.isLoading ? (
              <Loading what="Asking the server" />
            ) : users.error ? (
              <Empty title="Couldn't list accounts">{describeError(users.error)}</Empty>
            ) : !users.data?.users.length ? (
              <Empty icon={Users} title="Nobody matches" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="right">Spaces</th>
                    <th className="right">Sessions</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.users.map((u) => (
                    <tr
                      key={u.id}
                      data-clickable="true"
                      data-selected={u.id === selection || undefined}
                      onClick={() => open(u.id)}
                      style={{ cursor: "default" }}
                    >
                      <td>
                        <div className="col">
                          <span className="row" style={{ gap: 7 }}>
                            <span>{u.email}</span>
                            {u.held && <Badge tone="danger">suspended</Badge>}
                            {!u.emailVerified && !u.held && <Badge tone="warn">unverified</Badge>}
                          </span>
                          {u.name && <span className="table__sub">{u.name}</span>}
                        </div>
                      </td>
                      <td className="right">{u.spaces}</td>
                      <td className="right">{u.activeSessions}</td>
                      <td className="table__sub">{day(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <div className="detail__side">
            {selection ? <UserDetail id={selection} onClose={() => open(null)} /> : <AllowList />}
            <Invites />
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

/**
 * Who has an account, and the thirty days of sign-ups behind it.
 *
 * The figures come from /overview rather than from the list beside them: the
 * list is searched, filtered and capped at 200, so counting it would quietly
 * change the instance's totals every time somebody typed in the search box.
 */
function SignUps() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.admin.overview, staleTime: 30_000 });
  const activity = useQuery({ queryKey: ["overview", "activity"], queryFn: () => api.admin.activity(30), staleTime: 60_000 });

  const series = activity.data?.series ?? [];
  const labels = useMemo(() => series.map((d) => shortDay(d.day)), [series]);
  const values = useMemo(() => series.map((d) => d.signUps), [series]);
  const joined = useMemo(() => values.reduce((a, b) => a + b, 0), [values]);
  const tip = useMemo(
    () => (index: number) => `${count(values[index] ?? 0)} sign-up${values[index] === 1 ? "" : "s"}`,
    [values],
  );

  const a = overview.data?.accounts;

  return (
    <Panel title="Accounts" icon={Users}>
      <div className="stat-row">
        <Stat label="Total" value={a ? count(a.total) : "–"} sub={a && a.limit > 0 ? `limit ${count(a.limit)}` : undefined} />
        <Stat label="Verified" value={a ? count(a.verified) : "–"} />
        <Stat label="Not verified" value={a ? count(Math.max(0, a.total - a.verified)) : "–"} />
        <Stat label="Suspended" value={a ? count(a.held) : "–"} />
        <Stat label="New this week" value={a ? count(a.newThisWeek) : "–"} />
      </div>
      {series.length > 0 && (
        <div className="chart-stack__item">
          <div className="chart-head">
            <span className="chart-head__label">Sign-ups</span>
            <span className="chart-head__value tabular">
              {count(joined)} <span className="faint">in 30 days</span>
            </span>
          </div>
          <TrendChart labels={labels} values={values} showDates tip={tip} ariaLabel={`Sign-ups per day: ${count(joined)} over the last 30 days.`} />
        </div>
      )}
    </Panel>
  );
}

function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [holding, setHolding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["users", "one", id], queryFn: () => api.admin.user(id) });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["users"] });
    void client.invalidateQueries({ queryKey: ["overview"] });
  };

  const release = useMutation({
    mutationFn: () => api.admin.release(id),
    onSuccess: () => {
      toastOk("They can sign in again.");
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const verify = useMutation({
    mutationFn: () => api.admin.verify(id),
    onSuccess: () => {
      toastOk("Marked verified.");
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const revoke = useMutation({
    mutationFn: () => api.admin.revokeSessions(id),
    onSuccess: (r) => {
      toastOk(`Signed out of ${r.revoked} session(s).`);
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const remove = useMutation({
    mutationFn: ({ confirm, withWorkspaces }: { confirm: string; withWorkspaces: boolean }) => api.admin.deleteUser(id, confirm, withWorkspaces),
    onSuccess: (r) => {
      toastOk(`Deleted ${r.email} and ${r.spacesRemoved} space(s).`);
      setDeleting(false);
      onClose();
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  if (detail.isLoading) return <Panel title="Account"><Loading /></Panel>;
  if (detail.error || !detail.data) {
    return (
      <Panel title="Account">
        <Empty title="Couldn't load that account">{describeError(detail.error)}</Empty>
      </Panel>
    );
  }

  const u = detail.data.user;
  return (
    <>
      <Panel
        title={u.email}
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        <KeyValue
          rows={[
            ["Name", u.name || <span className="faint">none given</span>],
            ["Joined", day(u.createdAt)],
            ["Email", u.emailVerified ? "Verified" : <span style={{ color: "var(--warning)" }}>Not verified</span>],
            [
              "State",
              u.held ? (
                <span style={{ color: "var(--danger)" }}>Suspended{u.holdReason ? ` — ${u.holdReason}` : ""}</span>
              ) : (
                "Active"
              ),
            ],
            ["Sessions", `${u.activeSessions} active`],
            ["Id", <span className="mono selectable">{u.id}</span>],
          ]}
        />

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {u.held ? (
            <Button size="sm" icon={ShieldCheck} busy={release.isPending} onClick={() => release.mutate()}>
              Let them back in
            </Button>
          ) : (
            <Button size="sm" icon={Ban} onClick={() => setHolding(true)}>
              Suspend
            </Button>
          )}
          {!u.emailVerified && (
            <Button size="sm" icon={MailCheck} busy={verify.isPending} onClick={() => verify.mutate()}>
              Mark verified
            </Button>
          )}
          {u.activeSessions > 0 && (
            <Button size="sm" icon={UserRoundX} busy={revoke.isPending} onClick={() => revoke.mutate()}>
              Sign out everywhere
            </Button>
          )}
          <span className="spacer" />
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </Panel>

      {detail.data.spaces.length > 0 && (
        <Panel title="Their spaces" flush>
          <table className="table">
            <tbody>
              {detail.data.spaces.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="col">
                      <span>{s.name}</span>
                      <span className="table__sub">
                        {sentence(s.role)} · {s.kind}
                      </span>
                    </div>
                  </td>
                  <td className="right table__sub">{count(s.records)} records</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {detail.data.sessions.length > 0 && (
        <Panel title="Where they are signed in" flush>
          <table className="table">
            <tbody>
              {detail.data.sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="col">
                      <span className="table__sub">{s.client ?? "unknown client"}</span>
                      <span className="table__sub mono">{s.ip ?? "no address"}</span>
                    </div>
                  </td>
                  <td className="right table__sub">{ago(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {holding && <HoldDialog user={u} onClose={() => setHolding(false)} onDone={refresh} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${u.email}?`}
          phrase={u.email}
          action="Delete the account"
          busy={remove.isPending}
          onConfirm={() => remove.mutate({ confirm: u.email, withWorkspaces: true })}
          onClose={() => setDeleting(false)}
          body={
            <p className="field__hint">
              This removes the account, its personal space and every workspace it owns, with their records, images and streams. It cannot
              be undone. If you only want to stop them signing in, suspend them instead — that keeps everything.
            </p>
          }
        />
      )}
    </>
  );
}

function HoldDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const hold = useMutation({
    mutationFn: () => api.admin.hold(user.id, reason.trim()),
    onSuccess: () => {
      toastOk(`${user.email} is suspended.`);
      onDone();
      onClose();
    },
    onError: (e) => toastError(describeError(e)),
  });

  return (
    <Dialog
      title={`Suspend ${user.email}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={hold.isPending} onClick={() => hold.mutate()}>
            Suspend
          </Button>
        </>
      }
    >
      <p className="field__hint">
        Their sessions end immediately and their open connections are closed. Nothing they have made is touched, and letting them back in
        is one click.
      </p>
      <Field label="Reason" hint="Shown to them when they try to sign in. Leave it empty for none.">
        <input className="input" value={reason} placeholder="Left the company" onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function AllowList() {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const client = useQueryClient();
  const allow = useQuery({ queryKey: ["allow"], queryFn: api.admin.allow });

  const add = useMutation({
    mutationFn: () => api.admin.addAllow(email.trim(), note.trim()),
    onSuccess: () => {
      toastOk(`${email} may sign up.`);
      setEmail("");
      setNote("");
      setAdding(false);
      void client.invalidateQueries({ queryKey: ["allow"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  const remove = useMutation({
    mutationFn: (address: string) => api.admin.removeAllow(address),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["allow"] }),
    onError: (e) => toastError(describeError(e)),
  });

  const mode = allow.data?.registration;

  return (
    <Panel
      title="Who may sign up"
      actions={
        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
          Allow an address
        </Button>
      }
    >
      <p className="field__hint">
        {mode === "open"
          ? "Sign-ups are open: anyone who can reach this server can make an account. The list below is not consulted."
          : mode === "closed"
            ? "Sign-ups are closed. Only an address with a workspace invitation, or one on this list, can still make an account."
            : "Invitation only: an address needs a workspace invitation, or a place on this list."}
      </p>

      {allow.data && allow.data.allowed.length > 0 ? (
        <table className="table">
          <tbody>
            {allow.data.allowed.map((a) => (
              <tr key={a.email}>
                <td>
                  <div className="col">
                    <span>{a.email}</span>
                    {a.note && <span className="table__sub">{a.note}</span>}
                  </div>
                </td>
                <td className="right table__sub">{a.usedAt ? `used ${ago(a.usedAt)}` : "unused"}</td>
                <td className="right">
                  <IconButton icon={Trash2} label={`Remove ${a.email}`} size="sm" onClick={() => remove.mutate(a.email)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty compact>Nobody is pre-authorised.</Empty>
      )}

      {adding && (
        <Dialog
          title="Allow an address to sign up"
          onClose={() => setAdding(false)}
          footer={
            <>
              <span className="spacer" />
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" busy={add.isPending} disabled={!email.includes("@")} onClick={() => add.mutate()}>
                Allow
              </Button>
            </>
          }
        >
          <Field label="Email address" hint="They can make an account with this address even while sign-ups are invitation only.">
            <input className="input" value={email} autoComplete="off" placeholder="person@example.com" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Note" hint="For you, in this list. Nobody else sees it.">
            <input className="input" value={note} placeholder="New starter, joins Monday" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </Dialog>
      )}
    </Panel>
  );
}

function Invites() {
  const client = useQueryClient();
  const invites = useQuery({ queryKey: ["invites"], queryFn: api.admin.invites });
  const revoke = useMutation({
    mutationFn: (id: string) => api.admin.revokeInvite(id),
    onSuccess: () => {
      toastOk("Invitation revoked.");
      void client.invalidateQueries({ queryKey: ["invites"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  const pending = (invites.data?.invites ?? []).filter((i) => i.status === "pending");

  return (
    <Panel title={`Open invitations${pending.length ? ` · ${pending.length}` : ""}`}>
      {invites.isLoading ? (
        <Loading />
      ) : !pending.length ? (
        <Empty compact>No invitations are waiting.</Empty>
      ) : (
        <table className="table">
          <tbody>
            {pending.map((i) => (
              <tr key={i.id}>
                <td>
                  <div className="col">
                    <span>{i.email}</span>
                    <span className="table__sub">
                      {i.workspace.name} · {i.role}
                    </span>
                  </div>
                </td>
                <td className="right table__sub">expires {ago(i.expiresAt)}</td>
                <td className="right">
                  <IconButton icon={Trash2} label={`Revoke the invitation for ${i.email}`} size="sm" onClick={() => revoke.mutate(i.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
