/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Signing in to a server as yourself, rather than pasting a management token.
//
// This is the path for a server you manage but can't easily tunnel to: your
// own account, over the internet, reaching workspace keys and nothing else.
// The full management API still needs a token and still answers only the
// server's own machine, which is the whole reason there are two doors.
//
// The address is asked for first and probed before anything else, so somebody
// typing a wrong one is told it isn't a Kern server rather than being asked
// for a password by it.

import { useState } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Problem } from "@/components/ui/Controls";
import { toastOk } from "@/stores/toast";

/** Where most people's account is, so the field starts somewhere useful. */
const DEFAULT_URL = "https://api.relf.cc/kern/v1";

export function SignIn({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = url.trim() && email.trim() && password.length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { owner } = await api.account.signIn(url.trim(), email.trim(), password);
      toastOk(`Signed in to ${owner.instance} as ${owner.email}.`);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Sign in to a server"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={LogIn} busy={busy} disabled={!ready} onClick={() => void submit()}>
            Sign in
          </Button>
        </>
      }
    >
      <p className="field__hint">
        Your Kern account, on a server whose administrator has given it the right to manage workspace keys. This signs in over the
        internet and reaches <b>keys only</b> — health, people, logs and the SQL console still need a management token on the
        server&rsquo;s own machine.
      </p>

      {error && <Problem title="Couldn't sign in" detail={error} />}

      <Field label="Server address" hint="The API base, as people type it into Kern.">
        <input
          className="input mono"
          value={url}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>

      <Field label="Email">
        <input
          className="input"
          type="email"
          autoFocus
          value={email}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>

      <Field label="Password">
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
      </Field>

      <p className="field__hint">
        <KeyRound size={13} strokeWidth={1.75} style={{ verticalAlign: "-2px", marginRight: 5 }} />
        The session is kept in this computer&rsquo;s credential store, never in a file Kern Platform writes.
      </p>
    </Dialog>
  );
}
