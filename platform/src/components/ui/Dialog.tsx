/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// One dialog component, and a confirm built on it.
//
// Destructive management actions ask for the thing's own name typed out,
// matching the management API, which wants the same string in the body. Two
// gates for one mistake: the API refuses a wrong name even if the interface
// somehow sent one.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button, IconButton } from "./Button";
import { Field } from "./Controls";

export function Dialog({ title, onClose, children, footer, wide }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // Focus the first thing worth typing into, or the dialog itself.
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button");
    first?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="dialog__backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "dialog--wide" : ""}`.trim()} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog__head">
          <h2 className="dialog__title">{title}</h2>
          <span className="spacer" />
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="dialog__body">{children}</div>
        {footer ? <div className="dialog__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A confirmation that has to be typed. `phrase` is what the person must
 * enter - the account's address, the workspace's name - and it is also what
 * gets sent to the server as `confirm`.
 */
export function ConfirmDialog({ title, phrase, body, action, danger = true, busy, onConfirm, onClose }: {
  title: string;
  phrase: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === phrase.trim().toLowerCase();
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!matches} busy={busy} onClick={onConfirm}>
            {action}
          </Button>
        </>
      }
    >
      {body}
      <Field label={`Type ${phrase} to confirm`}>
        <input
          className="input"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          placeholder={phrase}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches && !busy) onConfirm();
          }}
        />
      </Field>
    </Dialog>
  );
}
