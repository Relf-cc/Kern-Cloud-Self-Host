/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The small pieces every page uses: fields, a switch, badges, empty and
// loading states, and the panel everything sits in.

import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";

export function Panel({ title, icon: Icon, actions, children, flush, className = "" }: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`panel ${flush ? "panel--flush" : ""} ${className}`.trim()}>
      {title && (
        <h3 className={`panel__title ${flush ? "panel__pad" : ""}`.trim()}>
          {Icon && <Icon strokeWidth={1.75} />}
          <span>{title}</span>
          {actions && (
            <>
              <span className="spacer" />
              {actions}
            </>
          )}
        </h3>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-on={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Badge({ tone = "default", children }: { tone?: "default" | "ok" | "warn" | "danger" | "quiet"; children: ReactNode }) {
  return <span className={`badge ${tone !== "default" ? `badge--${tone}` : ""}`.trim()}>{children}</span>;
}

export function Dot({ tone }: { tone: "ok" | "warn" | "fail" | "live" | "idle" }) {
  return <span className={`dot ${tone !== "idle" ? `dot--${tone}` : ""}`.trim()} />;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {sub ? <span className="stat__sub">{sub}</span> : null}
    </div>
  );
}

export function Empty({ icon: Icon, title, children, compact }: { icon?: LucideIcon; title?: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty ${compact ? "empty--compact" : ""}`.trim()}>
      {Icon && <Icon strokeWidth={1.5} />}
      {title && <span className="empty__title">{title}</span>}
      {children}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="empty empty--compact">
      <span className="spinner" />
      <span>{what}…</span>
    </div>
  );
}

/** A whole page that can't be shown, with the reason as the server gave it. */
export function Problem({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="problem">
      <AlertTriangle strokeWidth={1.5} />
      <span className="problem__title">{title}</span>
      {detail ? <p className="problem__detail">{detail}</p> : null}
      {children}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} data-active={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
