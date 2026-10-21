/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Which server this window is looking at, at the top of the sidebar.
//
// It shows the instance's own name rather than the label typed when it was
// added, so a server renamed from Kern Platform or kernctl is renamed here
// too. The dot is the connection, not the health: green means this app is
// talking to it, which is a different question from whether its checks pass.

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { host } from "@/lib/format";
import type { Server } from "@/lib/types";
import { Dot } from "@/components/ui/Controls";
import { toastError } from "@/stores/toast";
import { useRouter } from "@/stores/router";
import { AddServer } from "./AddServer";

export function ServerPicker({ servers, current, online, collapsed = false }: {
  servers: Server[];
  current: Server;
  online: boolean;
  /** On the collapsed rail only the dot is left, so the whole button is the dot. */
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const go = useRouter((s) => s.go);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = async (id: string) => {
    setOpen(false);
    if (id === current.id) return;
    try {
      await api.servers.select(id);
      // Nothing in the cache belongs to the new server.
      await client.invalidateQueries();
      go("overview");
    } catch (e) {
      toastError(describeError(e, "Couldn't switch server."));
    }
  };

  const label = current.instanceName ?? current.name;

  return (
    <div className="picker" ref={ref}>
      <button
        className="picker__button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={collapsed ? `${label} — ${host(current.url)}` : undefined}
      >
        <Dot tone={online ? "live" : "idle"} />
        <span className="picker__text">
          <span className="picker__name">{label}</span>
          <span className="picker__url">{host(current.url)}</span>
        </span>
        <ChevronsUpDown strokeWidth={1.75} />
      </button>

      {open && (
        <div className="picker__menu" role="listbox">
          {servers.map((s) => (
            <button key={s.id} className="picker__item" role="option" aria-selected={s.id === current.id} onClick={() => void choose(s.id)}>
              {s.id === current.id ? <Check strokeWidth={2} /> : <span style={{ width: "var(--icon-sm)" }} />}
              <span className="truncate grow">{s.instanceName ?? s.name}</span>
              {!s.hasToken && <span className="faint" style={{ fontSize: "var(--fs-2xs)" }}>no token</span>}
            </button>
          ))}
          <div className="picker__sep" />
          <button
            className="picker__item"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
          >
            <Plus strokeWidth={1.75} />
            <span>Add a server…</span>
          </button>
        </div>
      )}

      {adding && <AddServer onClose={() => setAdding(false)} />}
    </div>
  );
}
