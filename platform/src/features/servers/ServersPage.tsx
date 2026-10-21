/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The connection itself: the servers this app knows, and the management
// tokens the selected one has issued.
//
// This is the one page that still works when the server can't be reached,
// because it is where a broken connection gets fixed.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, LogOut, Plus, Server as ServerIcon, Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { ago, day, host } from "@/lib/format";
import type { MintedToken, Scope, Server } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, Empty, Field, KeyValue, Loading, Panel } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { ConfirmDialog, Dialog } from "@/components/ui/Dialog";
import { toastError, toastOk } from "@/stores/toast";
import { AddServer } from "./AddServer";

export function ServersPage({ current }: { current: Server }) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Server | null>(null);
  const [retoken, setRetoken] = useState<Server | null>(null);
  const [minting, setMinting] = useState(false);
  const client = useQueryClient();

  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers.list, staleTime: 0 });
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: api.admin.tokens, retry: false });

  const signOut = useMutation({
    mutationFn: (id: string) => api.account.signOut(id),
    onSuccess: () => {
      toastOk("Signed out. The server stays in the list; its management token, if it has one, is untouched.");
      void client.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.servers.remove(id),
    onSuccess: () => {
      setRemoving(null);
      toastOk("Server removed, and its token forgotten.");
      void client.invalidateQueries();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.admin.revokeToken(id),
    onSuccess: () => {
      toastOk("Token revoked.");
      void client.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  return (
    <Page>
      <PageHeader
        icon={ServerIcon}
        title="Servers"
        sub={servers.data ? `${servers.data.length} known` : undefined}
        actions={
          <Button size="sm" icon={Plus} variant="primary" onClick={() => setAdding(true)}>
            Add a server
          </Button>
        }
      />

      <PageBody>
        <Panel title="Servers" flush>
          {servers.isLoading ? (
            <Loading what="Reading the list" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Token</th>
                  <th>Last reached</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(servers.data ?? []).map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="col">
                        <span>{s.instanceName ?? s.name}</span>
                        {s.warning && (
                          <span className="table__sub" style={{ color: "var(--warning)" }}>
                            <AlertTriangle size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                            not encrypted
                          </span>
                        )}
                        {s.selected && <span className="table__sub">selected</span>}
                      </div>
                    </td>
                    <td className="mono">{host(s.url)}</td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        {s.hasToken ? <Badge tone="ok">token</Badge> : null}
                        {s.hasSession ? <Badge tone="ok">signed in</Badge> : null}
                        {!s.hasToken && !s.hasSession ? <Badge tone="warn">missing</Badge> : null}
                      </div>
                    </td>
                    <td className="table__sub">{ago(s.lastConnectedAt ? new Date(s.lastConnectedAt).toISOString() : null)}</td>
                    <td className="right">
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <IconButton icon={KeyRound} label="Replace the token" size="sm" onClick={() => setRetoken(s)} />
                        {s.hasSession && (
                          <IconButton
                            icon={LogOut}
                            label={`Sign out of ${s.instanceName ?? s.name}`}
                            size="sm"
                            disabled={signOut.isPending}
                            onClick={() => signOut.mutate(s.id)}
                          />
                        )}
                        <IconButton icon={Trash2} label="Remove this server" size="sm" onClick={() => setRemoving(s)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {servers.data?.some((s) => s.warning) && (
          <Panel title="About those unencrypted addresses" icon={AlertTriangle}>
            <p className="field__hint">
              A management token is the whole instance: it can suspend accounts, delete workspaces and read the server log. Kern Platform
              refuses plain HTTP to a public address outright, and warns about a private one. The quiet fix is an SSH tunnel, which makes
              the server local: <code className="mono">ssh -L 8787:127.0.0.1:8787 you@server</code>
            </p>
          </Panel>
        )}

        <Panel
          title={`Management tokens on ${current.instanceName ?? current.name}`}
          flush
          actions={
            <Button size="sm" icon={Plus} onClick={() => setMinting(true)}>
              New token
            </Button>
          }
        >
          {tokens.isLoading ? (
            <Loading what="Asking the server" />
          ) : tokens.error ? (
            <Empty title="Can't list tokens">{describeError(tokens.error)}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Last used</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(tokens.data?.tokens ?? []).map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="col">
                        <span>
                          {t.name} {t.current && <span className="faint">· this app</span>}
                        </span>
                        <span className="table__sub mono">{t.id}</span>
                      </div>
                    </td>
                    <td>{t.scope === "read" ? <Badge tone="quiet">read</Badge> : <Badge>full</Badge>}</td>
                    <td className="table__sub">{t.lastUsedAt ? `${ago(t.lastUsedAt)}${t.lastUsedIp ? ` from ${t.lastUsedIp}` : ""}` : "never"}</td>
                    <td className="table__sub">{day(t.createdAt)}</td>
                    <td className="right">
                      {t.revokedAt ? (
                        <Badge tone="quiet">revoked</Badge>
                      ) : (
                        <IconButton
                          icon={Trash2}
                          label={t.current ? "Revoke the token this app is using" : "Revoke this token"}
                          size="sm"
                          onClick={() => revoke.mutate(t.id)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </PageBody>

      {adding && <AddServer onClose={() => setAdding(false)} />}
      {minting && <MintToken onClose={() => setMinting(false)} />}
      {retoken && <ReplaceToken server={retoken} onClose={() => setRetoken(null)} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.instanceName ?? removing.name}?`}
          phrase={removing.instanceName ?? removing.name}
          action="Remove"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(removing.id)}
          onClose={() => setRemoving(null)}
          body={
            <p className="field__hint">
              This removes the server from this app and forgets its token from the credential store. Nothing on the server changes — the
              token stays valid until you revoke it there.
            </p>
          }
        />
      )}
    </Page>
  );
}

/** Mints a token on the server and shows it the one time it exists. */
function MintToken({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("full");
  const [days, setDays] = useState("");
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const client = useQueryClient();

  const mint = useMutation({
    mutationFn: () => api.admin.mintToken(name.trim(), scope, days.trim() ? Number(days) : null),
    onSuccess: (t) => {
      setMinted(t);
      void client.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  if (minted) {
    return (
      <Dialog
        title="Your new token"
        onClose={onClose}
        footer={
          <>
            <span className="spacer" />
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard.writeText(minted.token).then(() => toastOk("Copied."));
              }}
            >
              Copy
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <p className="field__hint">This is the only time it is shown. The server keeps a hash, not the token.</p>
        <div className="panel">
          <code className="mono wrap selectable">{minted.token}</code>
        </div>
        <KeyValue
          rows={[
            ["Name", minted.name],
            ["Scope", minted.scope === "read" ? "Read-only" : "Full"],
            ["Expires", minted.expiresAt ? day(minted.expiresAt) : "never"],
          ]}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New management token"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={mint.isPending} disabled={!name.trim()} onClick={() => mint.mutate()}>
            Mint
          </Button>
        </>
      }
    >
      <Field label="What is it for?" hint="Shown in the token list and in the server's audit trail.">
        <input className="input" value={name} placeholder="Backup script" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Scope" hint="A read-only token can look at everything and change nothing.">
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          <option value="full">Full — manage everything</option>
          <option value="read">Read-only</option>
        </select>
      </Field>
      <Field label="Expires after" hint="Leave empty for a token that doesn't expire.">
        <input className="input" value={days} inputMode="numeric" placeholder="days" onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} />
      </Field>
    </Dialog>
  );
}

function ReplaceToken({ server, onClose }: { server: Server; onClose: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();

  const save = useMutation({
    mutationFn: () => api.servers.setToken(server.id, token.trim()),
    onSuccess: () => {
      toastOk("Token saved.");
      void client.invalidateQueries();
      onClose();
    },
    onError: (e) => setError(describeError(e, "That token wasn't accepted.")),
  });

  return (
    <Dialog
      title={`Token for ${server.instanceName ?? server.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!token.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <p className="field__hint">
        On the server: <code className="mono">kernctl token new &quot;Kern Platform&quot;</code>. It replaces what is in this computer&rsquo;s
        credential store; the old token stays valid on the server until you revoke it.
      </p>
      <Field label="Management token" error={error}>
        <input
          className="input mono"
          value={token}
          spellCheck={false}
          autoComplete="off"
          placeholder="kern_…"
          onChange={(e) => {
            setToken(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && token.trim() && save.mutate()}
        />
      </Field>
    </Dialog>
  );
}
