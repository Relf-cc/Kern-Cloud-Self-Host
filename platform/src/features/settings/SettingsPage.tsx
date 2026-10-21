/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The instance's own settings.
//
// Two kinds, and the difference is the point of the page. The top half can be
// changed from here and takes effect at once, because it lives in the
// database. The bottom half comes from .env and needs the server restarting,
// so it is shown but not editable - an interface that pretended to change an
// address and then didn't would be worse than one that says where to go.
//
// Each editable row says where its value came from: "from .env" means nothing
// has been stored, so the environment is still in charge. Clearing a stored
// value hands it back.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, RotateCcw, Save, Server } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import type { Registration, SettingKey, SettingsReply } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Badge, Empty, Loading, Panel, Switch } from "@/components/ui/Controls";
import { toastError, toastOk } from "@/stores/toast";

export function SettingsPage() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.admin.settings });

  const save = useMutation({
    mutationFn: (patch: Partial<Record<SettingKey, unknown>>) => api.admin.setSettings(patch),
    onSuccess: () => {
      toastOk("Saved. It is in effect now.");
      void client.invalidateQueries({ queryKey: ["settings"] });
      void client.invalidateQueries({ queryKey: ["overview"] });
      void client.invalidateQueries({ queryKey: ["allow"] });
      void client.invalidateQueries({ queryKey: ["ping"] });
    },
    onError: (e) => toastError(describeError(e)),
  });

  if (settings.isLoading) return <div className="page"><Loading what="Asking the server" /></div>;
  if (settings.error || !settings.data) {
    return (
      <div className="page">
        <Empty title="Couldn't read the settings">{describeError(settings.error)}</Empty>
      </div>
    );
  }

  const d = settings.data;
  const set = (patch: Partial<Record<SettingKey, unknown>>) => save.mutate(patch);

  return (
    <div className="page">
      <div className="page__inner">
        <Panel title="Changeable here" flush>
          <TextRow
            label="Instance name"
            hint="What this server calls itself: in its emails, on its invite pages, and in the sidebar here."
            value={d.settings.instanceName.value}
            source={d.settings.instanceName.source}
            busy={save.isPending}
            onSave={(v) => set({ instanceName: v })}
            onClear={() => set({ instanceName: null })}
          />

          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">
                Who may sign up
                <Source source={d.settings.registration.source} />
              </span>
              <span className="set-row__hint">
                The first account is always allowed, whatever this says — otherwise nobody could start using a new server.
              </span>
            </div>
            <div className="set-row__control">
              <select
                className="select"
                value={d.settings.registration.value}
                disabled={save.isPending}
                onChange={(e) => set({ registration: e.target.value as Registration })}
              >
                <option value="open">Open — anyone who can reach it</option>
                <option value="invite">Invitation only</option>
                <option value="closed">Closed — nobody new</option>
              </select>
            </div>
          </div>

          {d.settings.registration.value === "open" && (
            <TextRow
              label="Limit sign-ups to these domains"
              hint="Comma separated, without the @. Empty means any address."
              value={d.settings.allowedEmailDomains.value.join(", ")}
              source={d.settings.allowedEmailDomains.source}
              placeholder="example.com, example.org"
              busy={save.isPending}
              onSave={(v) => set({ allowedEmailDomains: v })}
              onClear={() => set({ allowedEmailDomains: null })}
            />
          )}

          <TextRow
            label="Most accounts"
            hint="A ceiling on how many this instance will hold. 0 for no limit."
            value={String(d.settings.maxUsers.value)}
            source={d.settings.maxUsers.source}
            numeric
            busy={save.isPending}
            onSave={(v) => set({ maxUsers: Number(v) || 0 })}
            onClear={() => set({ maxUsers: null })}
          />

          <TextRow
            label="Support address"
            hint="Shown in this instance's emails, so people know who to ask. Empty leaves it out."
            value={d.settings.supportEmail.value}
            source={d.settings.supportEmail.source}
            placeholder="admin@example.com"
            busy={save.isPending}
            onSave={(v) => set({ supportEmail: v })}
            onClear={() => set({ supportEmail: null })}
          />

          <TextRow
            label="Notice on the sign-in screen"
            hint="A line the Kern app shows people before they sign in. Empty for none."
            value={d.settings.motd.value}
            source={d.settings.motd.source}
            placeholder="Maintenance on Sunday morning."
            busy={save.isPending}
            onSave={(v) => set({ motd: v })}
            onClear={() => set({ motd: null })}
          />

          <div className="set-row">
            <div className="set-row__text">
              <span className="set-row__label">
                Public share links and calendar feeds
                <Source source={d.settings.sharesEnabled.source} />
              </span>
              <span className="set-row__hint">
                Turning this off stops serving pages that are already published, as well as new ones.
              </span>
            </div>
            <div className="set-row__control">
              <Switch
                checked={d.settings.sharesEnabled.value}
                label="Allow publishing"
                disabled={save.isPending}
                onChange={(v) => set({ sharesEnabled: v })}
              />
            </div>
          </div>
        </Panel>

        <Panel title="From .env — needs a restart" icon={Lock} flush>
          <EnvRow label="Public address" value={d.environment.publicUrl} hint="What invite links and stream endpoints are built from." mono />
          <EnvRow label="What people type into Kern" value={d.environment.apiUrl} mono />
          {d.environment.linkUrl !== d.environment.publicUrl && <EnvRow label="Invite links" value={d.environment.linkUrl} mono />}
          {d.environment.streamsUrl !== d.environment.publicUrl && <EnvRow label="Stream endpoints" value={d.environment.streamsUrl} mono />}
          <EnvRow label="Listening on" value={`${d.environment.host}:${d.environment.port}`} mono />
          <EnvRow
            label="Outgoing mail"
            value={d.environment.mail.configured ? `${d.environment.mail.host}:${d.environment.mail.port} as ${d.environment.mail.from}` : "Not configured"}
            hint={
              d.environment.mail.configured
                ? undefined
                : "Verification codes and invitations are printed to the server log instead of sent. Nobody else can finish signing up until this is set."
            }
            warn={!d.environment.mail.configured}
          />
          <EnvRow
            label="Email into streams"
            value={d.environment.inboundEmail.enabled ? d.environment.inboundEmail.domain || "on" : "Off"}
          />
          <EnvRow
            label="Management API"
            value={d.environment.admin.localOnly ? "This machine only" : `Also ${d.environment.admin.allowFrom.join(", ") || "nothing listed"}`}
            hint={
              d.environment.admin.localOnly
                ? "Which is why Kern Platform connects over 127.0.0.1 or an SSH tunnel."
                : "ADMIN_LOCAL_ONLY is off. Keep ADMIN_ALLOW_FROM as narrow as you can."
            }
            warn={!d.environment.admin.localOnly && !d.environment.admin.allowFrom.length}
          />
          <EnvRow
            label="Stream encryption key"
            value={d.environment.streamsKeySet ? "Set" : "Derived from the session secret"}
            hint={
              d.environment.streamsKeySet
                ? undefined
                : "Set STREAMS_ENCRYPTION_KEY. Without it, rotating BETTER_AUTH_SECRET makes every stored stream credential unreadable."
            }
            warn={!d.environment.streamsKeySet}
          />
          <EnvRow label="Invitations expire after" value={`${d.environment.inviteDays} days`} />
          <EnvRow label="App URL scheme" value={`${d.environment.appScheme}://`} mono />
          {d.environment.admin.tokenFile && <EnvRow label="Management token file" value={d.environment.admin.tokenFile} mono />}
        </Panel>

        <Panel title="Changing what is above" icon={Server}>
          <p className="field__hint">
            Edit <code className="mono">.env</code> next to the <code className="mono">docker-compose.yml</code>, then{" "}
            <code className="mono">kernctl service restart</code>. The ceilings that aren&rsquo;t listed here — upload sizes, per-space
            limits, stream rates — are documented in <code className="mono">.env.example</code> and{" "}
            <code className="mono">kernctl settings</code> prints the live values.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function Source({ source }: { source: SettingsReply["settings"][SettingKey]["source"] }) {
  if (source === "stored") return null;
  return <Badge tone="quiet">from .env</Badge>;
}

/** A row with its own draft, saved on blur or Enter rather than per keystroke. */
function TextRow({ label, hint, value, source, placeholder, numeric, busy, onSave, onClear }: {
  label: string;
  hint: string;
  value: string;
  source: "stored" | "env";
  placeholder?: string;
  numeric?: boolean;
  busy?: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow the server when it changes underneath us (another admin, kernctl).
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;

  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">
          {label}
          <Source source={source} />
        </span>
        <span className="set-row__hint">{hint}</span>
      </div>
      <div className="set-row__control">
        {source === "stored" && !dirty && (
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={onClear} title="Fall back to .env">
            Reset
          </Button>
        )}
        {dirty && (
          <Button size="sm" variant="primary" icon={Save} busy={busy} onClick={() => onSave(draft)}>
            Save
          </Button>
        )}
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          inputMode={numeric ? "numeric" : undefined}
          disabled={busy}
          onChange={(e) => setDraft(numeric ? e.target.value.replace(/\D/g, "") : e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) onSave(draft);
            if (e.key === "Escape") setDraft(value);
          }}
        />
      </div>
    </div>
  );
}

function EnvRow({ label, value, hint, mono, warn }: { label: string; value: string; hint?: string; mono?: boolean; warn?: boolean }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint" style={warn ? { color: "var(--warning)" } : undefined}>{hint}</span>}
      </div>
      <div className="set-row__control">
        <span className={`${mono ? "mono " : ""}selectable`} style={{ fontSize: "var(--fs-sm)", color: warn ? "var(--warning)" : "var(--text-2)", textAlign: "right" }}>
          {value}
        </span>
      </div>
    </div>
  );
}
