/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The mark, straight from assets/icon.svg - the same file scripts/icons.py
// renders the application icons from, so every mark in the interface matches
// the one on the taskbar.
import iconUrl from "../../assets/icon.svg";

export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <img
      className={className}
      src={iconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
