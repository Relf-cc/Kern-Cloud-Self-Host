/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Adding a server, two ways.
//
// Paste: the one line `kernctl pair` prints carries the address, a freshly
// minted token and the instance's name. That is the path to take - nothing to
// type, nothing to get wrong.
//
// By hand: an address, checked against the server's /instance endpoint before
// a token is asked for. Probing first means the usual mistakes (wrong port,
// not a Kern server, a tunnel that isn't up) are caught while there is still
// something useful to say about them, rather than surfacing later as "didn't
// accept the token".

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardPaste, Plug } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import type { InstanceProbe } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Field, Segmented } from "@/components/ui/Controls";
import { Dialog } from "@/components/ui/Dialog";
import { toastOk } from "@/stores/toast";

type Mode = "paste" | "manual";

export function AddServer({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("paste");
  const [line, setLine] = useState("");
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [probe, setProbe] = useState<InstanceProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();

  const done = (what: string) => {
    void client.invalidateQueries();
    toastOk(what);
    onClose();
  };

  const addFromLine = async () => {
    setBusy(true);
    setError(null);
    try {
      const server = await api.servers.pair(line.trim());
      done(`${server.name} added.`);
    } catch (e) {
      setError(describeError(e, "That pairing line didn't work."));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      const found = await api.servers.probe(url);
      setProbe(found);
      if (!name.trim()) setName(found.name);
    } catch (e) {
      setError(describeError(e, "Couldn't reach that address."));
    } finally {
      setBusy(false);
    }
  };

  const addManually = async () => {
    setBusy(true);
    setError(null);
    try {
      const server = await api.servers.add(name || probe?.name || url, url, token.trim() || undefined);
      done(`${server.name} added.`);
    } catch (e) {
      setError(describeError(e, "Couldn't add that server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Add a server"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          {mode === "paste" ? (
            <Button variant="primary" icon={ClipboardPaste} busy={busy} disabled={!line.trim()} onClick={() => void addFromLine()}>
              Add
            </Button>
          ) : probe ? (
            <Button variant="primary" icon={Plug} busy={busy} disabled={!token.trim()} onClick={() => void addManually()}>
              Add
            </Button>
          ) : (
            <Button variant="primary" busy={busy} disabled={!url.trim()} onClick={() => void check()}>
              Check address
            </Button>
          )}
        </>
      }
    >
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        options={[
          { value: "paste", label: "Paste from kernctl" },
          { value: "manual", label: "Enter it myself" },
        ]}
      />

      {mode === "paste" ? (
        <>
          <p className="field__hint">
            On the server, run <code className="mono">kernctl pair</code>. It mints a token for this app and prints one line beginning{" "}
            <code className="mono">kern-platform:</code> — paste the whole of it here.
          </p>
          <Field label="Pairing line" error={error}>
            <textarea
              className="textarea textarea--mono"
              rows={3}
              value={line}
              spellCheck={false}
              placeholder="kern-platform:eyJ1cmwiOi…"
              onChange={(e) => setLine(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Address"
            hint="The server's own address. Kern Platform adds /kern/v1 if you leave it off."
            error={!probe ? error : null}
          >
            <input
              className="input mono"
              value={url}
              spellCheck={false}
              autoComplete="off"
              placeholder="http://127.0.0.1:8787"
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && !probe && void check()}
            />
          </Field>

          {probe && (
            <div className="panel">
              <span className="panel__title">
                <Check strokeWidth={2} /> {probe.name}
              </span>
              <span className="field__hint">
                A Kern server, protocol {probe.protocol}. Sign-ups are {probe.registration}.
                {probe.features.email ? "" : " It has no mail configured, so verification codes go to its log."}
              </span>
            </div>
          )}

          {probe && (
            <>
              <Field label="Name it" hint="What this server is called in the sidebar.">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={probe.name} />
              </Field>
              <Field
                label="Management token"
                hint="On the server: kernctl token new “Kern Platform”. It is shown once."
                error={error}
              >
                <input
                  className="input mono"
                  value={token}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="kern_…"
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && token.trim() && void addManually()}
                />
              </Field>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
