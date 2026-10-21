/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

import { AlertCircle, Check, Info } from "lucide-react";
import { useToasts, type Tone } from "@/stores/toast";

const ICONS = { ok: Check, error: AlertCircle, info: Info } as const;

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.tone as Tone];
        return (
          <div key={t.id} className={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
            <Icon strokeWidth={1.75} />
            <span className="toast__text">{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
