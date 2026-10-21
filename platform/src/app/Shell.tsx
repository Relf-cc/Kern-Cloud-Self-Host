/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The window: a server picker and navigation down the left, one page on the
// right. Kern's shell, with a server where Kern has a workspace - the same
// 236px rail, grouped the same way, collapsing to the same icon strip.
//
// The window owns no title bar of its own. Each page carries its own header,
// because that is how Kern does it and because a page's actions belong next to
// its name rather than in furniture that never changes.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Database,
  Eye,
  FileText,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Server,
  Settings,
  Stethoscope,
  Terminal,
  Users,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { useRouter, type Page } from "@/stores/router";
import type { Server as ServerProfile } from "@/lib/types";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { IconButton } from "@/components/ui/Button";
import { ServerPicker } from "@/features/servers/ServerPicker";
import { BrandMark } from "./BrandMark";
import { Routes } from "./Routes";

interface NavItem {
  id: Page;
  label: string;
  icon: typeof Activity;
}

/** Grouped as Kern groups its sidebar: what it is, who is in it, what it says. */
const SECTIONS: { name: string; items: NavItem[] }[] = [
  {
    name: "Instance",
    items: [
      { id: "overview", label: "Overview", icon: Activity },
      { id: "health", label: "Health", icon: Stethoscope },
    ],
  },
  {
    name: "People and their work",
    items: [
      { id: "people", label: "People", icon: Users },
      { id: "spaces", label: "Spaces", icon: Database },
      { id: "streams", label: "Streams", icon: Radio },
      { id: "keys", label: "Workspace keys", icon: KeyRound },
    ],
  },
  {
    name: "What it says",
    items: [
      { id: "logs", label: "Logs", icon: FileText },
      { id: "console", label: "Console", icon: Terminal },
    ],
  },
];

const COLLAPSE_KEY = "kern-platform:sidebar-collapsed";

export function Shell({ servers }: { servers: ServerProfile[] }) {
  const page = useRouter((s) => s.page);
  const go = useRouter((s) => s.go);
  const current = servers.find((s) => s.selected) ?? servers[0]!;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggleRail = () => {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        // The rail just won't be remembered; it still collapses.
      }
      return next;
    });
  };

  // Two ways to reach a server, and they see different amounts of it. With a
  // management token this is the whole management API. With only an account
  // session it is workspace keys and nothing else, because that is all the
  // server will answer over the internet - so the pages that would only be
  // able to say "no token" are not offered at all.
  const accountOnly = current.hasSession && !current.hasToken;

  // Say hello to whichever server is selected. It answers with the instance's
  // own name and version, which the picker shows and the back end remembers
  // so the list still reads properly next time, before any request is made.
  const ping = useQuery({
    queryKey: ["ping", current.id],
    queryFn: api.admin.ping,
    retry: false,
    refetchInterval: 60_000,
    // /admin/ping needs a management token, so there is nothing to ask for
    // on a server reached with an account.
    enabled: !accountOnly,
  });

  // Health drives the one dot in the sidebar. It is the only figure worth
  // interrupting someone with, so it is the only one that gets a mark.
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.admin.health,
    enabled: !accountOnly && ping.isSuccess,
    refetchInterval: 120_000,
    retry: false,
  });
  const failing = health.data?.checks.filter((c) => c.status === "fail").length ?? 0;
  const warning = health.data?.checks.filter((c) => c.status === "warn").length ?? 0;

  // Keep the page sensible when the selected server changes to one that only
  // offers keys, or the other way.
  useEffect(() => {
    if (accountOnly && page !== "keys" && page !== "servers" && page !== "settings") go("keys");
  }, [accountOnly, page, go]);

  useEffect(() => {
    if (!ping.data) return;
    const stale = ping.data.instance !== current.instanceName || ping.data.version !== current.version;
    if (stale) void api.servers.note(current.id, ping.data.instance, ping.data.version);
  }, [ping.data, current.id, current.instanceName, current.version]);

  const readOnly = ping.data?.token.scope === "read";
  const sections = accountOnly
    ? [{ name: "Instance", items: SECTIONS[1]!.items.filter((item) => item.id === "keys") }]
    : SECTIONS;

  return (
    <div className="shell">
      <nav className="sidebar" data-collapsed={collapsed}>
        <div className="sidebar__top">
          <span className="brand">
            <BrandMark className="brand__mark" size={20} />
            <span className="truncate">Kern Platform</span>
          </span>
          {!collapsed && <IconButton icon={PanelLeftClose} label="Collapse the sidebar" size="sm" onClick={toggleRail} />}
        </div>

        <ServerPicker servers={servers} current={current} online={ping.isSuccess} collapsed={collapsed} />

        {!collapsed && (accountOnly || readOnly) && (
          <p className="sidebar__note">
            <Eye strokeWidth={1.75} />
            {accountOnly ? (
              <span>
                Signed in as <b>yourself</b>. Workspace keys are all this reaches; everything else needs a management token on the
                server&rsquo;s own machine.
              </span>
            ) : (
              <span>
                This token is <b>read-only</b>. Every page lists what it lists; nothing here will change anything.
              </span>
            )}
          </p>
        )}

        <div className="sidebar__scroll">
          {sections.map((section) => (
            <div className="sidebar__section" key={section.name}>
              <div className="sidebar__section-head">{section.name}</div>
              {section.items.map((item) => (
                <button key={item.id} className="nav-item" data-active={page === item.id} onClick={() => go(item.id)}>
                  <item.icon strokeWidth={1.75} />
                  <span className="nav-item__label">{item.label}</span>
                  {item.id === "health" && (failing > 0 || warning > 0) && (
                    <span
                      className={`nav-item__dot dot ${failing ? "dot--fail" : "dot--warn"}`}
                      title={failing ? `${failing} failing` : `${warning} to look at`}
                    />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar__bottom">
          {collapsed && <IconButton icon={PanelLeftOpen} label="Expand the sidebar" size="sm" onClick={toggleRail} />}
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
        <ErrorBoundary resetKey={`${current.id}:${page}`}>
          <Routes server={current} pingError={accountOnly ? null : ping.error} accountOnly={accountOnly} readOnly={readOnly} />
        </ErrorBoundary>
      </main>
    </div>
  );
}
