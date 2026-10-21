/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The charts, lazily. Chart.js is the largest thing this app depends on and
// most pages draw nothing, so it is fetched when the first chart mounts rather
// than at startup - the same arrangement Kern uses for its storage ring.
//
// Each wrapper keeps the chart's own height while it loads, so a panel doesn't
// jump when the module lands.

import { lazy, Suspense, type ComponentProps } from "react";

const Trend = lazy(() => import("./TrendChart"));
const Bars = lazy(() => import("./BarsChart"));
const Donut = lazy(() => import("./DonutChart"));

export type { Slice } from "./DonutChart";

function Placeholder({ height }: { height: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden />;
}

export function TrendChart(props: ComponentProps<typeof Trend>) {
  return (
    <Suspense fallback={<Placeholder height={props.height ?? 92} />}>
      <Trend {...props} />
    </Suspense>
  );
}

export function BarsChart(props: ComponentProps<typeof Bars>) {
  return (
    <Suspense fallback={<Placeholder height={props.height ?? Math.max(80, props.labels.length * 26 + 28)} />}>
      <Bars {...props} />
    </Suspense>
  );
}

export function DonutChart(props: ComponentProps<typeof Donut>) {
  return (
    <Suspense fallback={<Placeholder height={props.size ?? 148} />}>
      <Donut {...props} />
    </Suspense>
  );
}
