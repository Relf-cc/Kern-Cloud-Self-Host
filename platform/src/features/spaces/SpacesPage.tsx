/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Personal spaces and shared workspaces: how big they are, who is in them,
// and what they are made of.
//
// Row counts per table are as close as this gets to the contents. That is the
// line the management API draws: an administrator can see that a workspace
// holds four thousand tasks and needs eight gigabytes, and cannot read one of
// those tasks.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Search, Trash2 } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { bytes, count, day, sentence } from "@/lib/format";
import type { Space } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Badge, Empty, KeyValue, Loading, Panel, Segmented } from "@/components/ui/Controls";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { toastError, toastOk } from "@/stores/toast";
import { useRouter } from "@/stores/router";

type Kind = "" | "personal" | "workspace";

export function SpacesPage() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind>("");
  const [showDeleted, setShowDeleted] = useState(false);
  const selection = useRouter((s) => s.selection);
  const open = useRouter((s) => s.open);

  const spaces = useQuery({
    queryKey: ["spaces", query, kind, showDeleted],
    queryFn: () => api.admin.spaces({ q: query, kind, deleted: showDeleted }),
  });

  const rows = spaces.data?.spaces ?? [];

  return (
    <div className="page">
      <div className="page__inner">
        <div className="toolbar">
          <div className="input-wrap">
            <Search strokeWidth={1.75} />
            <input className="input" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "", label: "All" },
              { value: "workspace", label: "Workspaces" },
              { value: "personal", label: "Personal" },
            ]}
          />
          <Button size="sm" variant={showDeleted ? "primary" : "default"} onClick={() => setShowDeleted((v) => !v)}>
            Include deleted
          </Button>
          <span className="spacer" />
          {spaces.data && <span className="field__hint">{rows.length} shown</span>}
        </div>

        <div className="detail">
          <Panel flush>
            {spaces.isLoading ? (
              <Loading what="Asking the server" />
            ) : spaces.error ? (
              <Empty title="Couldn't list spaces">{describeError(spaces.error)}</Empty>
            ) : !rows.length ? (
              <Empty icon={Database} title="Nothing matches" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Space</th>
                    <th className="right">Members</th>
                    <th className="right">Records</th>
                    <th className="right">Images</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} data-clickable="true" onClick={() => open(s.id)}>
                      <td>
                        <div className="col">
                          <span className="row" style={{ gap: 7 }}>
                            <span>{s.name}</span>
                            {s.deletedAt && <Badge tone="danger">deleted</Badge>}
                            {s.kind === "personal" && <Badge tone="quiet">personal</Badge>}
                          </span>
                          <span className="table__sub">{s.owner.email}</span>
                        </div>
                      </td>
                      <td className="right">{s.members}</td>
                      <td className="right">{count(s.records)}</td>
                      <td className="right table__sub">{s.assetBytes ? bytes(s.assetBytes) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {selection ? (
            <SpaceDetail id={selection} space={rows.find((s) => s.id === selection)} onClose={() => open(null)} />
          ) : (
            <Panel title="About spaces">
              <p className="field__hint">
                Every account has one personal space, made the first time they sync. A workspace is a space with more than one member, and
                the invitations that go with it. Both are replicated to each computer that opens them, so what is here is the copy everyone
                else merges against.
              </p>
              <p className="field__hint">
                A tombstone is a record someone deleted. They stay so other computers learn about the deletion, and clearing them early
                would let a stale copy bring the record back.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function SpaceDetail({ id, space, onClose }: { id: string; space?: Space; onClose: () => void }) {
  const [deleting, setDeleting] = useState<"soft" | "purge" | null>(null);
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["spaces", "one", id], queryFn: () => api.admin.space(id) });

  const remove = useMutation({
    mutationFn: ({ confirm, purge }: { confirm: string; purge: boolean }) => api.admin.deleteSpace(id, confirm, purge),
    onSuccess: (r) => {
      toastOk(r.purged ? `“${r.name}” is gone.` : `“${r.name}” is marked deleted.`);
      setDeleting(null);
      onClose();
      void client.invalidateQueries({ queryKey: ["spaces"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  if (detail.isLoading) return <Panel title="Space"><Loading /></Panel>;
  if (detail.error || !detail.data) {
    return (
      <Panel title="Space">
        <Empty title="Couldn't load that space">{describeError(detail.error)}</Empty>
      </Panel>
    );
  }

  const s = detail.data.space;
  const personal = s.kind === "personal";

  return (
    <>
      <Panel
        title={s.name}
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        <KeyValue
          rows={[
            ["Kind", sentence(s.kind)],
            ["Created", day(s.createdAt)],
            ["Change head", count(s.head)],
            ["Members", detail.data.members.length],
            ...(space ? ([["Images", space.assets ? `${bytes(space.assetBytes)} in ${space.assets}` : "none"]] as [string, string][]) : []),
            ...(s.deletedAt ? ([["Deleted", day(s.deletedAt)]] as [string, string][]) : []),
            ["Id", <span className="mono selectable">{s.id}</span>],
          ]}
        />
        {!personal && (
          <div className="row">
            <span className="spacer" />
            {!s.deletedAt && (
              <Button size="sm" onClick={() => setDeleting("soft")}>
                Mark deleted
              </Button>
            )}
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDeleting("purge")}>
              Purge
            </Button>
          </div>
        )}
        {personal && (
          <p className="field__hint">
            A personal space belongs to its account. To remove it, delete the account on the People page.
          </p>
        )}
      </Panel>

      <Panel title="Members" flush>
        <table className="table">
          <tbody>
            {detail.data.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="col">
                    <span>{m.email}</span>
                    {m.name && <span className="table__sub">{m.name}</span>}
                  </div>
                </td>
                <td className="right">
                  <Badge tone={m.role === "owner" ? "default" : "quiet"}>{m.role}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {detail.data.tables.length > 0 && (
        <Panel title="What is in it" flush>
          <table className="table">
            <tbody>
              {detail.data.tables.map((t) => (
                <tr key={t.table}>
                  <td className="mono">{t.table}</td>
                  <td className="right">{count(t.records)}</td>
                  <td className="right table__sub">{t.tombstones ? `+${count(t.tombstones)} deleted` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {deleting && (
        <ConfirmDialog
          title={deleting === "purge" ? `Purge “${s.name}”?` : `Mark “${s.name}” deleted?`}
          phrase={s.name}
          action={deleting === "purge" ? "Purge it" : "Mark deleted"}
          danger={deleting === "purge"}
          busy={remove.isPending}
          onConfirm={() => remove.mutate({ confirm: s.name, purge: deleting === "purge" })}
          onClose={() => setDeleting(null)}
          body={
            deleting === "purge" ? (
              <p className="field__hint">
                This removes the workspace and everything in it — records, shared images, streams and membership — for good. Its members
                keep their own copies on their computers, but nothing will sync again.
              </p>
            ) : (
              <p className="field__hint">
                Its members stop being able to open it, and it stops syncing. Nothing is destroyed: it can be brought back in the database,
                and Health purges workspaces that have been deleted for 30 days.
              </p>
            )
          }
        />
      )}
    </>
  );
}
