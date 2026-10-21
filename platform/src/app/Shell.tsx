/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The window: a server picker and navigation down the left, one page on the
// right. Kern's shell, with a server where Kern has a workspace.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Database, FileText, Radio, Server, Settings, Stethoscope, Terminal, Users } from "lucide-react";
import { api } from "@/lib/ipc";
import { useRouter, type Page } from "@/stores/router";
import type { Server as ServerProfile } from "@/lib/types";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { ServerPicker } from "@/features/servers/ServerPicker";
import { BrandMark } from "./BrandMark";
import { Routes, PAGE_TITLES } from "./Routes";

const NAV: { id: Page; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "health", label: "Health", icon: Stethoscope },
  { id: "people", label: "People", icon: Users },
  { id: "spaces", label: "Spaces", icon: Database },
  { id: "streams", label: "Streams", icon: Radio },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "console", label: "Console", icon: Terminal },
];

export function Shell({ servers }: { servers: ServerProfile[] }) {
  const page = useRouter((s) => s.page);
  const go = useRouter((s) => s.go);
  const current = servers.find((s) => s.selected) ?? servers[0]!;

  // Say hello to whichever server is selected. It answers with the instance's
  // own name and version, which the picker shows and the back end remembers
  // so the list still reads properly next time, before any request is made.
  const ping = useQuery({
    queryKey: ["ping", current.id],
    queryFn: api.admin.ping,
    retry: false,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!ping.data) return;
    const stale = ping.data.instance !== current.instanceName || ping.data.version !== current.version;
    if (stale) void api.servers.note(current.id, ping.data.instance, ping.data.version);
  }, [ping.data, current.id, current.instanceName, current.version]);

  const readOnly = ping.data?.token.scope === "read";

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="sidebar__top">
          <span className="brand">
            <BrandMark className="brand__mark" size={20} />
            <span className="truncate">Kern Platform</span>
          </span>
        </div>

        <ServerPicker servers={servers} current={current} online={ping.isSuccess} />

        <div className="sidebar__scroll">
          {NAV.map((item) => (
            <button key={item.id} className="nav-item" data-active={page === item.id} onClick={() => go(item.id)}>
              <item.icon strokeWidth={1.75} />
              <span className="nav-item__label">{item.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar__bottom">
          <button className="nav-item" data-active={page === "settings"} onClick={() => go("settings")}>
            <Settings strokeWidth={1.75} />
            <span className="nav-item__label">Settings</span>
          </button>
          <button className="nav-item" data-active={page === "servers"} onClick={() => go("servers")}>
            <Server strokeWidth={1.75} />
            <span className="nav-item__label">Servers</span>
            <span className="nav-item__count">{servers.length}</span>
          </button>
        </div>
      </nav>

      <main className="workspace">
        <header className="topbar">
          <h1 className="topbar__title">{PAGE_TITLES[page]}</h1>
          <span className="spacer" />
          {readOnly && <span className="topbar__sub">Read-only token</span>}
        </header>
        <ErrorBoundary resetKey={`${current.id}:${page}`}>
          <Routes server={current} pingError={ping.error} />
        </ErrorBoundary>
      </main>
    </div>
  );
}
