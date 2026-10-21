/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// One measure over time, as a filled area.
//
// A single series, so there is no legend and no colour coding: the heading
// names it and the mark is ink. The crosshair index is passed in rather than
// held here, which is what lets a stack of these line up on the same day - the
// whole point of showing three measures as small multiples instead of putting
// them on one pair of axes, where the two small ones would be a flat line
// along the bottom.

import { useEffect, useMemo, useRef } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type Chart,
  type ChartOptions,
  type Plugin,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { animationMs, axisTicks, css, gridColour, tooltipStyle, useChartTheme } from "./theme";

ChartJS.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip);

/** The vertical line under the hovered day. Chart.js has no crosshair of its own. */
const crosshair: Plugin<"line"> = {
  id: "kern-crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.getActiveElements();
    if (!active.length) return;
    const { x } = active[0]!.element;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = css("--border-strong", "#3a3a3a");
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

export default function TrendChart({
  labels,
  values,
  height = 92,
  hover,
  onHover,
  showDates = false,
  ariaLabel,
  tip,
}: {
  /** One label per point, shown on the axis and in the tooltip. */
  labels: string[];
  values: number[];
  height?: number;
  /** The day every chart in the stack is showing, or null for none. */
  hover?: number | null;
  onHover?: (index: number | null) => void;
  /** Only the last chart in a stack carries the dates. */
  showDates?: boolean;
  ariaLabel: string;
  /** The tooltip body for a point, e.g. "4 accounts". */
  tip: (index: number) => string;
}) {
  const theme = useChartTheme();
  const ref = useRef<Chart<"line"> | null>(null);

  // The hovered day comes from outside, so a hover on any chart in the stack
  // moves the crosshair on all of them.
  useEffect(() => {
    const chart = ref.current;
    // A chart whose canvas has gone is one React has already taken down -
    // under StrictMode the effect runs either side of that - and updating it
    // would reach through a null canvas for its size.
    if (!chart?.canvas) return;
    const next = hover === null || hover === undefined || hover < 0 || hover >= values.length ? [] : [{ datasetIndex: 0, index: hover }];
    chart.setActiveElements(next);
    chart.update("none");
  }, [hover, values.length]);

  const data = useMemo(() => {
    const ink = css("--text-2", "#a9a9a9");
    return {
      labels,
      datasets: [
        {
          data: values,
          borderColor: ink,
          borderWidth: 2,
          // A fill rather than a second line: it reads as volume, and keeps a
          // flat zero series visible on the baseline. Flat rather than graded,
          // which is both what Kern's own charts do and one less thing to go
          // wrong - a scriptable gradient has to be rebuilt against the canvas
          // on every resize and theme change.
          fill: true,
          backgroundColor: theme === "light" ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.10)",
          tension: 0.25,
          pointRadius: 0,
          // Big enough to hit without aiming, per the hover rules.
          pointHitRadius: 14,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: css("--text", "#ededed"),
          // A 2px ring in the surface colour keeps the dot readable wherever
          // on the fill it lands.
          pointHoverBorderColor: css("--surface", "#161616"),
          pointHoverBorderWidth: 2,
        },
      ],
    };
  }, [labels, values, theme]);

  const options = useMemo<ChartOptions<"line">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: animationMs() },
      // Pick the nearest day along x, so anywhere in the column counts.
      interaction: { mode: "index", intersect: false },
      onHover: (_event, elements) => onHover?.(elements[0]?.index ?? null),
      layout: { padding: { top: 4, right: 2, left: 2 } },
      plugins: {
        tooltip: {
          ...tooltipStyle(),
          callbacks: { title: (items) => String(items[0]?.label ?? ""), label: (item) => tip(item.dataIndex) },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: css("--border", "#282828") },
          ticks: showDates
            ? { ...axisTicks(), maxRotation: 0, autoSkipPadding: 18 }
            : { display: false },
        },
        y: {
          beginAtZero: true,
          grid: { color: gridColour() },
          border: { display: false },
          // Two ticks: zero and the peak. A sparkline's scale is context, not
          // a reading surface.
          ticks: { ...axisTicks(), maxTicksLimit: 3, precision: 0 },
        },
      },
    }),
    [onHover, showDates, tip, theme],
  );

  return (
    <div className="chart" style={{ height }} onMouseLeave={() => onHover?.(null)}>
      <Line ref={ref} data={data} options={options} plugins={[crosshair]} aria-label={ariaLabel} role="img" />
    </div>
  );
}
