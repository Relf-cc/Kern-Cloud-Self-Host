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

export function Stat({ label, value, sub, icon: Icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="stat">
      <span className="stat__label">
        {Icon && <Icon strokeWidth={1.75} />}
        {label}
      </span>
      <span className="stat__value">{value}</span>
      {sub ? <span className="stat__sub">{sub}</span> : null}
    </div>
  );
}

/** How far through something is: keys used of keys issued, a quota. */
export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span className="progress__bar" style={{ width: `${share}%` }} />
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

export function Segmented<T extends string>({ value, options, onChange, size = "md", ariaLabel }: {
  value: T;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (next: T) => void;
  size?: "md" | "sm";
  ariaLabel?: string;
}) {
  return (
    <div className={`segmented ${size === "sm" ? "segmented--sm" : ""}`.trim()} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} data-active={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon && <o.icon strokeWidth={1.75} />}
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
