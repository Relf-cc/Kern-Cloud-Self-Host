/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Which page is drawn, and what to do when the server can't be reached at all.
//
// A dead connection is handled once, here, rather than in every page: if the
// hello failed, every page would only be able to repeat the same message, and
// the two that can still be useful without it - Servers and Settings - are
// let through.

import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Problem } from "@/components/ui/Controls";
import { describeError, errorCode } from "@/lib/ipc";
import type { Server } from "@/lib/types";
import { useRouter, type Page } from "@/stores/router";
import { ConsolePage } from "@/features/console/ConsolePage";
import { HealthPage } from "@/features/health/HealthPage";
import { KeysPage } from "@/features/keys/KeysPage";
import { LogsPage } from "@/features/logs/LogsPage";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { PeoplePage } from "@/features/people/PeoplePage";
import { ServersPage } from "@/features/servers/ServersPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SpacesPage } from "@/features/spaces/SpacesPage";
import { StreamsPage } from "@/features/streams/StreamsPage";

export const PAGE_TITLES: Record<Page, string> = {
  overview: "Overview",
  health: "Health",
  people: "People",
  spaces: "Spaces",
  streams: "Streams",
  keys: "Workspace keys",
  logs: "Logs",
  console: "Console",
  settings: "Server settings",
  servers: "Servers",
};

/** Pages that still work with no connection, because they are how you fix it. */
const OFFLINE_OK: Page[] = ["servers"];

export function Routes({ server, pingError, accountOnly = false }: { server: Server; pingError: unknown; accountOnly?: boolean }) {
  const page = useRouter((s) => s.page);
  const go = useRouter((s) => s.go);
  const client = useQueryClient();

  if (pingError && !OFFLINE_OK.includes(page)) {
    const code = errorCode(pingError);
    const needsToken = code === "auth";
    return (
      <div className="page">
        <Problem
          title={needsToken ? `${server.name} didn't accept the token` : `Can't reach ${server.name}`}
          detail={describeError(pingError)}
        >
          <div className="row" style={{ marginTop: 6 }}>
            <Button icon={PlugZap} onClick={() => void client.invalidateQueries()}>
              Try again
            </Button>
            <Button icon={KeyRound} variant={needsToken ? "primary" : "default"} onClick={() => go("servers")}>
              {needsToken ? "Paste a new token" : "Server settings"}
            </Button>
          </div>
        </Problem>
      </div>
    );
  }

  switch (page) {
    case "overview":
      return <OverviewPage />;
    case "health":
      return <HealthPage />;
    case "people":
      return <PeoplePage />;
    case "spaces":
      return <SpacesPage />;
    case "streams":
      return <StreamsPage />;
    case "keys":
      return <KeysPage accountOnly={accountOnly} />;
    case "logs":
      return <LogsPage />;
    case "console":
      return <ConsolePage />;
    case "settings":
      return <SettingsPage />;
    case "servers":
      return <ServersPage current={server} />;
  }
}
