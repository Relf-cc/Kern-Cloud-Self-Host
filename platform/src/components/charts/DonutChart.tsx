/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// What something is made of: storage by kind, accounts by state.
//
// The ring is the shape; the legend beside it is the reading surface, and it
// is always there. That is deliberate rather than decorative. These tones are
// greyscale, so two of them sit under 3:1 against the surface and none of them
// carries a hue - a ring alone would be unreadable. With every slice listed
// with its exact figure, the tone only has to say "this slice is that row",
// which ΔE ≥ 25 between neighbours does comfortably for normal and
// colour-blind vision alike.
//
// Because the legend holds the figures, there is no canvas tooltip: hovering
// either the ring or a row lights up the pair. A tooltip on a canvas this
// small would be clipped by it anyway.

import { useMemo, useRef, useState } from "react";
import { ArcElement, Chart as ChartJS, DoughnutController, type Chart, type ChartOptions } from "chart.js";
import { Doughnut } from "react-chartjs-2";
import { animationMs, css, TONES, useChartTheme } from "./theme";

ChartJS.register(DoughnutController, ArcElement);

export interface Slice {
  label: string;
  value: number;
  /** The figure as a person reads it: "1.4 GB", "12 accounts". */
  display: string;
}

export default function DonutChart({
  slices,
  size = 148,
  centre,
  caption,
  ariaLabel,
  tones: override,
}: {
  slices: Slice[];
  size?: number;
  /** The headline in the hole, usually the total. */
  centre?: string;
  caption?: string;
  ariaLabel: string;
  /**
   * One colour per slice, for the one case the greyscale ramp is wrong: a ring
   * of states, where good, warning and failing have reserved tones of their
   * own and must not be dressed as "slice 1, 2, 3". Those tones are never
   * borrowed back for an ordinary category, and the legend still names every
   * state, so the colour is never carrying the meaning by itself.
   */
  tones?: string[];
}) {
  const theme = useChartTheme();
  const tones = override ?? TONES[theme];
  const ref = useRef<Chart<"doughnut"> | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Nothing with no value gets a slice, but it keeps its legend row and its
  // tone, so a category that empties doesn't repaint the ones that remain.
  const drawn = useMemo(() => slices.map((s, i) => ({ ...s, slot: i })).filter((s) => s.value > 0), [slices]);
  const total = useMemo(() => slices.reduce((sum, s) => sum + s.value, 0), [slices]);

  const data = useMemo(() => {
    const surface = css("--surface", theme === "light" ? "#ffffff" : "#161616");
    return {
      labels: drawn.map((s) => s.label),
      datasets: [
        {
          data: drawn.map((s) => s.value),
          backgroundColor: drawn.map((s) => tones[s.slot % tones.length]!),
          hoverBackgroundColor: drawn.map((s) => tones[s.slot % tones.length]!),
          // A 2px gap in the surface colour between segments, so neighbours
          // never touch.
          borderColor: surface,
          hoverBorderColor: surface,
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    };
  }, [drawn, tones, theme]);

  const options = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: false,
      maintainAspectRatio: false,
      cutout: "70%",
      animation: { duration: animationMs() },
      layout: { padding: 4 },
      onHover: (_event, elements) => setHover(elements[0]?.index ?? null),
      plugins: { tooltip: { enabled: false } },
    }),
    [],
  );

  /** Hovering a legend row lights its segment, and the other way round. */
  const focus = (index: number | null) => {
    setHover(index);
    const chart = ref.current;
    // Guarded for the same reason TrendChart's is: no canvas, no chart to poke.
    if (!chart?.canvas) return;
    chart.setActiveElements(index === null ? [] : [{ datasetIndex: 0, index }]);
    chart.update("none");
  };

  return (
    <div className="donut">
      <div className="donut__ring" style={{ width: size, height: size }} onMouseLeave={() => focus(null)}>
        {total > 0 ? (
          <Doughnut ref={ref} data={data} options={options} width={size} height={size} aria-label={ariaLabel} role="img" />
        ) : (
          <div className="donut__empty" style={{ width: size, height: size }} />
        )}
        {centre && (
          <div className="donut__centre" aria-hidden>
            <span className="donut__total tabular">{centre}</span>
            {caption && <span className="donut__caption">{caption}</span>}
          </div>
        )}
      </div>

      <ul className="donut-legend" aria-label={ariaLabel}>
        {slices.map((s, i) => {
          const drawnIndex = drawn.findIndex((d) => d.slot === i);
          const share = total ? (s.value / total) * 100 : 0;
          return (
            <li
              key={s.label}
              className="donut-legend__row"
              data-active={(hover !== null && hover === drawnIndex) || undefined}
              data-dim={(hover !== null && drawnIndex >= 0 && hover !== drawnIndex) || undefined}
              onMouseEnter={() => drawnIndex >= 0 && focus(drawnIndex)}
              onMouseLeave={() => focus(null)}
            >
              <span className="donut-legend__key" style={{ background: tones[i % tones.length] }} aria-hidden />
              <span className="grow truncate">{s.label}</span>
              <span className="donut-legend__share tabular">
                {s.value > 0 ? `${share < 0.1 ? "<0.1" : share.toFixed(share < 10 ? 1 : 0)}%` : ""}
              </span>
              <span className="donut-legend__value tabular">{s.value > 0 ? s.display : "—"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
