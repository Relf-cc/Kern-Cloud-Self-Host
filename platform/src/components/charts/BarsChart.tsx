/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Magnitude across a handful of named things: the busiest streams, the
// biggest workspaces.
//
// Horizontal, because the names are workspace names rather than dates and
// reading them rotated is worse than scrolling. One series, so the bars are
// ink; rank is not identity, so nothing is coloured by position.

import { useMemo } from "react";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  Tooltip,
  type ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { animationMs, axisTicks, css, gridColour, tooltipStyle, useChartTheme } from "./theme";

ChartJS.register(CategoryScale, LinearScale, BarController, BarElement, Tooltip);

export default function BarsChart({
  labels,
  values,
  height,
  ariaLabel,
  tip,
}: {
  labels: string[];
  values: number[];
  /** Left to the caller: one row per bar, so the height follows the data. */
  height?: number;
  ariaLabel: string;
  tip: (index: number) => string;
}) {
  // The colours below are read out of the stylesheet, so they are only correct
  // for the theme they were read in. Both memos depend on this for that
  // reason: without it a theme switch would leave the canvas in the old one.
  const theme = useChartTheme();

  const data = useMemo(
    () => ({
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: css("--text-2", "#a9a9a9"),
          hoverBackgroundColor: css("--text", "#ededed"),
          // Rounded at the data end only, anchored to the baseline.
          borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
          borderSkipped: false,
          maxBarThickness: 18,
        },
      ],
    }),
    [labels, values, theme],
  );

  const options = useMemo<ChartOptions<"bar">>(
    () => ({
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: animationMs() },
      interaction: { mode: "nearest", axis: "y" as const, intersect: false },
      layout: { padding: { right: 4 } },
      plugins: {
        tooltip: {
          ...tooltipStyle(),
          callbacks: { title: (items) => String(items[0]?.label ?? ""), label: (item) => tip(item.dataIndex) },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: gridColour() },
          border: { display: false },
          ticks: { ...axisTicks(), maxTicksLimit: 5, precision: 0 },
        },
        y: {
          grid: { display: false },
          border: { color: css("--border", "#282828") },
          // Long workspace names get cut rather than allowed to eat the plot.
          ticks: {
            ...axisTicks(),
            callback(value) {
              const label = String(this.getLabelForValue(Number(value)));
              return label.length > 22 ? `${label.slice(0, 21)}…` : label;
            },
          },
        },
      },
    }),
    [tip, theme],
  );

  return (
    <div className="chart" style={{ height: height ?? Math.max(80, labels.length * 26 + 28) }}>
      <Bar data={data} options={options} aria-label={ariaLabel} role="img" />
    </div>
  );
}
