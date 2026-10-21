/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The frame every page in this app is built in, which is the frame every page
// in Kern is built in: a 46px header carrying the page's name, what is worth
// knowing about it, and its own actions - then one scrolling body underneath.
//
// Kern Platform used to put the page's name in a bar belonging to the window
// and leave each page to lay its own controls out wherever. That is the one
// thing that made the two apps look unrelated, because in Kern the title and
// the actions are part of the page, so the header changes when the page does.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function Page({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>;
}

export function PageHeader({ icon: Icon, title, sub, actions, children }: {
  icon?: LucideIcon;
  title: ReactNode;
  /** A quiet line beside the title: a count, a state, a warning. */
  sub?: ReactNode;
  actions?: ReactNode;
  /** Tabs, which sit against the header's bottom edge. */
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <h1 className="page-header__title">
        {Icon && <Icon strokeWidth={1.75} />}
        <span className="truncate">{title}</span>
      </h1>
      {sub ? <span className="page-header__sub truncate">{sub}</span> : null}
      {children}
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function PageBody({ children, narrow, flush }: {
  children: ReactNode;
  /** A readable column, for pages that are prose and forms rather than tables. */
  narrow?: boolean;
  /** No padding and no stack: the page owns its own scrolling layout. */
  flush?: boolean;
}) {
  if (flush) return <div className="page-body">{children}</div>;
  return (
    <div className="page-body page-body--pad">
      <div className={`stack ${narrow ? "stack--narrow" : ""}`.trim()}>{children}</div>
    </div>
  );
}

/** Underline tabs for a page's own sections, against the header's edge. */
export function Tabs<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string; icon?: LucideIcon }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className="tab"
          data-active={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <o.icon strokeWidth={1.75} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}
