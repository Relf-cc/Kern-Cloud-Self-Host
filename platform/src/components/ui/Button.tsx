/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: LucideIcon;
  block?: boolean;
  /** Shows a spinner in place of the icon and stops further clicks. */
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "default", size = "md", icon: Icon, block, busy, className = "", children, type = "button", disabled, ...rest },
  ref,
) {
  const cls = ["btn", variant !== "default" && `btn--${variant}`, size === "sm" && "btn--sm", block && "btn--block", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" /> : Icon ? <Icon strokeWidth={1.75} /> : null}
      {children}
    </button>
  );
});

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: "md" | "sm";
  active?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton(
  { icon: Icon, label, size = "md", active, className = "", type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      data-active={active || undefined}
      className={`icon-btn ${size === "sm" ? "icon-btn--sm" : ""} ${className}`.trim()}
      {...rest}
    >
      <Icon strokeWidth={1.75} />
    </button>
  );
});
