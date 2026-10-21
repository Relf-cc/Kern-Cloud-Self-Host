/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// How this app looks, as opposed to how the server behaves.
//
// tokens.css already answers to data-theme, data-density, data-radius and
// data-motion on the document, because it is Kern's token file - the same
// attributes, the same values. Nothing new has to be styled for these to
// work; they only have to be set, and remembered. They are kept in
// localStorage rather than on the server: it is this window's preference, not
// a property of the instance, and it should hold even when no server answers.

import { create } from "zustand";

export type Theme = "dark" | "light";
export type Density = "compact" | "comfortable" | "relaxed";
export type Radius = "sharp" | "default" | "round";
export type Motion = "full" | "reduced" | "off";

export interface Appearance {
  theme: Theme;
  density: Density;
  radius: Radius;
  motion: Motion;
}

const DEFAULTS: Appearance = { theme: "dark", density: "comfortable", radius: "default", motion: "full" };
const KEY = "kern-platform:appearance";

function load(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<Appearance>;
    return { ...DEFAULTS, ...saved };
  } catch {
    // A corrupt or unreadable store is not a reason to fail to start.
    return DEFAULTS;
  }
}

/**
 * The attributes tokens.css reads. "comfortable", "default" and "full" are
 * what the token file already does with no attribute at all, so they are
 * removed rather than written - which keeps the DOM honest about what has
 * actually been chosen.
 */
export function apply(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  if (a.density === "comfortable") delete root.dataset.density;
  else root.dataset.density = a.density;
  if (a.radius === "default") delete root.dataset.radius;
  else root.dataset.radius = a.radius;
  if (a.motion === "full") delete root.dataset.motion;
  else root.dataset.motion = a.motion;
}

interface AppearanceState extends Appearance {
  set: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void;
  reset: () => void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...load(),
  set: (key, value) => {
    set({ [key]: value } as Partial<AppearanceState>);
    const { theme, density, radius, motion } = get();
    const next = { theme, density, radius, motion };
    apply(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Private mode, or a full store: the choice holds for this session.
    }
  },
  reset: () => {
    set(DEFAULTS);
    apply(DEFAULTS);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing worth saying */
    }
  },
}));

/** Called once before the first render, so nothing flashes in the wrong theme. */
export function initAppearance(): void {
  apply(load());
}
