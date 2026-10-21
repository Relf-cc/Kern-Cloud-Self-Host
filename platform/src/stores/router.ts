/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Which page is open. There is no history and no URL: Kern Platform is one
// window with a handful of pages, and a router would be ceremony.

import { create } from "zustand";

export type Page = "overview" | "health" | "people" | "spaces" | "streams" | "logs" | "console" | "settings" | "servers";

interface RouterState {
  page: Page;
  /** The row a page has open beside its list, if any. */
  selection: string | null;
  go: (page: Page, selection?: string | null) => void;
  open: (selection: string | null) => void;
}

export const useRouter = create<RouterState>((set) => ({
  page: "overview",
  selection: null,
  go: (page, selection = null) => set({ page, selection }),
  open: (selection) => set({ selection }),
}));
