/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Short confirmations and failures, bottom right.
//
// An administration app says "done" far more often than it shows a dialog, so
// this is deliberately plain: a line of text, a tone, and it goes away. A
// failure stays longer, because it is usually something to read twice.

import { create } from "zustand";

export type Tone = "ok" | "error" | "info";

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: Tone, text: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, text) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, tone, text }].slice(-4) });
    // Failures are usually a sentence to read; confirmations are a word.
    const life = tone === "error" ? 9000 : 3500;
    setTimeout(() => get().dismiss(id), life);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toastOk = (text: string) => useToasts.getState().push("ok", text);
export const toastError = (text: string) => useToasts.getState().push("error", text);
export const toastInfo = (text: string) => useToasts.getState().push("info", text);
