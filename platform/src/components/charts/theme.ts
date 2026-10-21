/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// What every chart in this app shares: the tones, the axes, and the rule that
// the canvas follows the theme.
//
// Kern's palette is deliberately low-chroma, which is right for a quiet
// interface and wrong for telling series apart by hue. So nothing here encodes
// anything in hue: a single series is drawn in ink, and where slices have to be
// told apart they take fixed greyscale tones that alternate light and dark
// around the ring. Adjacent tones are separated by ΔE ≥ 25 for normal,
// deuteranopic and tritanopic vision, which is what actually makes a ring
// readable - and because two of the tones sit under 3:1 against the surface,
// every ring here ships a legend listing each slice with its exact figure. The
// legend, not the tone, is what identifies a slice.

import { useEffect, useState } from "react";

/** A CSS custom property off the document, so a chart matches the theme. */
export function css(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Fixed tone per slot, so a slice keeps its tone as figures move. Light and
 * dark alternate, which is what separates adjacent slices on a ring.
 */
export const TONES = {
  dark: ["#e6e6e6", "#5c5c5c", "#a8a8a8", "#3a3a3a", "#c9c9c9", "#808080"],
  light: ["#262626", "#a3a3a3", "#555555", "#cfcfcf", "#3d3d3d", "#7a7a7a"],
} as const;

export type Theme = "light" | "dark";

const readTheme = (): Theme => (typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** Follows `data-theme` on the document, which is how the theme is switched. */
export function useChartTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Honours the motion setting: off means charts appear rather than animate. */
export function animationMs(ms = 280): number {
  if (typeof document === "undefined") return 0;
  const motion = document.documentElement.dataset.motion;
  if (motion === "off") return 0;
  return motion === "reduced" ? Math.round(ms * 0.5) : ms;
}

/** Recessive axes: the figures matter, the furniture doesn't. */
export function axisTicks() {
  return { color: css("--text-3", "#808080"), font: { size: 11, family: css("--font-sans", "Inter, sans-serif") } };
}

export function gridColour(): string {
  return css("--divider", "rgba(255,255,255,.06)");
}

/**
 * Chart.js's own tooltip, dressed as Kern's. One definition, so a hover reads
 * the same whichever chart it is over.
 */
export function tooltipStyle() {
  return {
    backgroundColor: css("--surface-3", "#222"),
    titleColor: css("--text-2", "#a9a9a9"),
    bodyColor: css("--text", "#ededed"),
    borderColor: css("--border", "#282828"),
    borderWidth: 1,
    cornerRadius: 6,
    padding: 8,
    displayColors: false,
    titleFont: { size: 11, weight: 400 as const, family: css("--font-sans", "Inter, sans-serif") },
    bodyFont: { size: 12, weight: 600 as const, family: css("--font-sans", "Inter, sans-serif") },
  };
}
