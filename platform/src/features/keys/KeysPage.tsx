/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Workspace keys: who may create a workspace on this instance.
//
// An instance run for other people has a particular problem. Accounts are
// cheap, but a workspace is what actually costs the host storage, mail and
// attention. Turning the gate on means creating one takes a key minted here
// and handed over; everybody else is told to run their own server, which
// needs no key at all.
//
// Two things this page is careful about. A key is shown exactly once, when it
// is minted, because only its hash is stored — so the dialog that shows it
// has to be worth reading before it is dismissed. And revoking a key never
// touches the workspaces already made with it: it only stops the next one.
//
// It is reachable two ways, and does the same four things either way. With a
// management token it goes through /admin/*, which answers only the server's
// own machine. Signed in as yourself it goes through /owner/*, which answers
// from anywhere and holds nothing else. `accountOnly` picks the client; the
// page below doesn't otherwise care which one it got.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { ago, day } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, Empty, Field, Loading, Panel, Progress, Stat, Switch } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "@/components/layout/Page";
import { Dialog } from "@/components/ui/Dialog";
import { toastError, toastOk } from "@/stores/toast";
import type { MintedWorkspaceKey, WorkspaceKey } from "@/lib/types";

function state(k: WorkspaceKey): { label: string; tone: "default" | "ok" | "warn" | "quiet" } {
  if (k.revokedAt) return { label: "revoked", tone: "quiet" };
  if (k.redeemedBy) return { label: "in use", tone: "ok" };
  return { label: "unused", tone: "default" };
}

export function KeysPage({ accountOnly = false }: { accountOnly?: boolean }) {
  const client = useQueryClient();
  // The same four operations, over whichever surface this server is reached by.
  const keysApi = accountOnly
    ? {
        list: api.account.keys,
        mint: api.account.mintKey,
        revoke: api.account.revokeKey,
        setRequired: async (on: boolean): Promise<void> => void (await api.account.setRequired(on)),
      }
    : {
        list: api.admin.workspaceKeys,
        mint: api.admin.mintWorkspaceKey,
        revoke: api.admin.revokeWorkspaceKey,
        setRequired: async (on: boolean): Promise<void> => void (await api.admin.setSettings({ workspaceKeys: on ? "required" : "off" })),
      };
  const [minted, setMinted] = useState<MintedWorkspaceKey | null>(null);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  const keys = useQuery({ queryKey: ["workspace-keys", accountOnly], queryFn: keysApi.list });
  // The gate's current value comes with the key list on both surfaces; the
  // settings endpoint is only consulted when there's a token to consult it
  // with, so an account-only session doesn't ask for something it can't have.
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.admin.settings, enabled: !accountOnly });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["workspace-keys"] });
    void client.invalidateQueries({ queryKey: ["settings"] });
  };

  const gate = useMutation({
    mutationFn: (on: boolean) => keysApi.setRequired(on),
    onSuccess: (_r, on) => {
      toastOk(on ? "A key is now needed to create a workspace here." : "Anybody with an account may create a workspace again.");
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const mint = useMutation({
    mutationFn: () => keysApi.mint(note.trim()),
    onSuccess: (key) => {
      setMinted(key);
      setCopied(false);
      setNote("");
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => keysApi.revoke(id),
    onSuccess: () => {
      toastOk("Revoked. Workspaces already created with it keep working.");
      refresh();
    },
    onError: (e) => toastError(describeError(e)),
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toastOk("Copied.");
    } catch {
      toastError("Couldn't reach the clipboard. Select the key and copy it.");
    }
  };

  const rows = keys.data?.keys ?? [];
  const counts = keys.data?.counts;
  // /workspace-keys reports it on both surfaces, so it works either way;
  // settings is the fallback for a token session that has it cached.
  const required = keys.data?.required ?? settings.data?.settings.workspaceKeys.value === "required";

  return (
    <Page>
      <PageHeader
        icon={KeyRound}
        title="Workspace keys"
        sub={required ? "a key is needed to create a workspace" : "anybody with an account may create one"}
        actions={
          <>
            <span className="field__hint">{required ? "Required" : "Not required"}</span>
            <Switch
              checked={required}
              label={required ? "Stop requiring a key" : "Require a key"}
              disabled={gate.isPending || keys.isLoading}
              onChange={(on) => gate.mutate(on)}
            />
          </>
        }
      />

      <PageBody narrow>
        <Panel title="Creating a workspace" icon={KeyRound}>
          <p className="field__hint">
            {required ? (
              <>
                Creating a workspace on this server takes a key you have minted and handed over. Joining somebody else&rsquo;s workspace
                by invitation never does, nor does anything inside a workspace once somebody is in it, and every account still gets its
                own personal space.
              </>
            ) : (
              <>
                Anybody with an account on this server may create a workspace. Turn this on to run it for a known group instead: you
                mint a key per person, and everybody else is pointed at Kern Platform to run a server of their own.
              </>
            )}
          </p>
          {counts && (
            <>
              <div className="stat-row">
                <Stat label="Issued" value={counts.total} />
                <Stat label="Usable" value={counts.usable} sub="not revoked" />
                <Stat label="Taken" value={counts.redeemed} sub="claimed by an account" />
                <Stat label="Revoked" value={counts.revoked} />
              </div>
              {counts.total > 0 && (
                <>
                  <Progress value={counts.redeemed} max={counts.total} label="Keys claimed, of keys issued" />
                  <span className="field__hint">
                    {counts.redeemed} of {counts.total} issued {counts.total === 1 ? "key has" : "keys have"} been claimed.
                  </span>
                </>
              )}
            </>
          )}
        </Panel>

        <Panel title="Mint a key">
          <p className="field__hint">
            A key is claimed by the first account that uses it and refused to every other one afterwards, so give each one to a single
            person. It is shown once, here, and only its hash is kept.
          </p>
          <Field label="What is it for" hint="A note for you — a name, a team, a reason. Never shown to whoever uses the key.">
            <input
              className="input"
              value={note}
              maxLength={120}
              placeholder="e.g. Acme pilot, or alice@"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !mint.isPending && mint.mutate()}
            />
          </Field>
          <div className="row">
            <Button icon={Plus} variant="primary" busy={mint.isPending} onClick={() => mint.mutate()}>
              Mint a key
            </Button>
          </div>
        </Panel>

        <Panel flush>
          {keys.isLoading ? (
            <Loading what="Asking the server" />
          ) : keys.error ? (
            <Empty title="Couldn't list keys">{describeError(keys.error)}</Empty>
          ) : !rows.length ? (
            <Empty icon={KeyRound} title="No keys yet">
              Mint one above and give it to whoever should be able to create a workspace here.
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Claimed by</th>
                  <th className="right">Used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => {
                  const s = state(k);
                  return (
                    <tr key={k.id}>
                      <td>
                        <div className="col" style={{ gap: 3 }}>
                          <span className="row" style={{ gap: 7 }}>
                            <code className="mono selectable">k_{k.id}…</code>
                            <Badge tone={s.tone}>{s.label}</Badge>
                          </span>
                          {k.note && <span className="table__sub">{k.note}</span>}
                          <span className="table__sub">minted {day(k.createdAt)}</span>
                        </div>
                      </td>
                      <td>
                        {k.redeemedBy ? (
                          <div className="col" style={{ gap: 3 }}>
                            <span>{k.redeemedEmail ?? "(deleted account)"}</span>
                            <span className="table__sub">{ago(k.redeemedAt)}</span>
                          </div>
                        ) : (
                          <span className="table__sub">nobody yet</span>
                        )}
                      </td>
                      <td className="right">
                        <div className="col" style={{ gap: 3 }}>
                          <span>{k.uses}</span>
                          {k.lastUsedAt && <span className="table__sub">{ago(k.lastUsedAt)}</span>}
                        </div>
                      </td>
                      <td className="right">
                        {!k.revokedAt && (
                          <IconButton
                            icon={Trash2}
                            label={`Revoke the key ending ${k.id}`}
                            size="sm"
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(k.id)}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {minted && (
          <Dialog
            title="Your new workspace key"
            onClose={() => setMinted(null)}
            footer={
              <Button variant="primary" onClick={() => setMinted(null)}>
                Done
              </Button>
            }
          >
            <p className="field__hint">
              Copy it now. Only its hash is stored, so this is the one time it can be shown — if it is lost, revoke it and mint another.
            </p>
            <div className="row" style={{ gap: 8, marginTop: 10, marginBottom: 10 }}>
              <code className="mono selectable" style={{ flex: 1, wordBreak: "break-all" }}>
                {minted.key}
              </code>
              <Button icon={copied ? Check : Copy} size="sm" onClick={() => void copy(minted.key)}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {minted.note && <p className="field__hint">Noted as “{minted.note}”.</p>}
            <p className="field__hint">
              Whoever you give it to enters it in Kern when they create a workspace. It is theirs from the first time they use it, and
              refused to anyone else after that.
            </p>
          </Dialog>
        )}
      </PageBody>
    </Page>
  );
}
