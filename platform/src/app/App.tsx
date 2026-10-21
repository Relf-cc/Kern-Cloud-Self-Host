/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The top of the app.
//
// One decision gets made here: is there a server to manage? With none, the
// whole window is the welcome, because every other page would only be able to
// say "no server". With one, the shell takes over.

import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query";
import { api } from "@/lib/ipc";
import { Loading } from "@/components/ui/Controls";
import { Toaster } from "@/components/ui/Toaster";
import { Welcome } from "@/features/servers/Welcome";
import { Shell } from "./Shell";

function Root() {
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers.list, staleTime: 0 });

  if (servers.isLoading) {
    return (
      <div className="welcome">
        <Loading what="Looking for your servers" />
      </div>
    );
  }
  // A failure to read the list is itself a reason to show the welcome: it
  // offers the one action that can fix anything here, which is adding a server.
  const list = servers.data ?? [];
  if (!list.length) return <Welcome />;
  return <Shell servers={list} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
      <Toaster />
    </QueryClientProvider>
  );
}
