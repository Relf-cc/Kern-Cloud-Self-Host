/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Thirty days of activity.
//
// Three measures, three charts. Sign-ups run 0-3 a day, deliveries in the
// tens, record changes in the thousands: on one pair of axes the first two
// would be a flat line along the bottom, and giving them a second y-scale
// would make the crossings mean nothing. Small multiples keep each on its own
// scale and let the shapes be compared honestly.
//
// One series per chart, so there is no legend and no colour coding - the
// heading names the series, and the mark is ink. Kern's palette is
// deliberately low-chroma, which is right for a quiet interface and wrong for
// telling series apart by hue; since nothing here needs that, nothing here
// pretends to.
//
// Hovering anywhere moves a crosshair through all three at the same day, so
// "the day deliveries spiked" and "the day nobody signed up" line up.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { count } from "@/lib/format";
import { Panel } from "@/components/ui/Controls";
import type { ActivityDay } from "@/lib/types";

const SERIES: { key: keyof Omit<ActivityDay, "day">; label: string; unit: string }[] = [
  { key: "signUps", label: "Sign-ups", unit: "account" },
  { key: "deliveries", label: "Stream deliveries", unit: "delivery" },
  { key: "changes", label: "Records changed", unit: "record" },
];

const W = 560;
const H = 44;
const PAD = 2;

export function Activity30() {
  const activity = useQuery({ queryKey: ["overview", "activity"], queryFn: () => api.admin.activity(30), staleTime: 60_000 });
  const [hover, setHover] = useState<number | null>(null);
  const series = activity.data?.series ?? [];

  if (!series.length) return null;

  return (
    <Panel title="The last 30 days">
      <div
        className="col"
        style={{ gap: 14 }}
        onMouseLeave={() => setHover(null)}
      >
        {SERIES.map((s) => (
          <Spark key={s.key} days={series} field={s.key} label={s.label} unit={s.unit} hover={hover} onHover={setHover} />
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-2xs)", color: "var(--text-4)" }}>
        <span>{series[0]?.day}</span>
        <span>{series[series.length - 1]?.day}</span>
      </div>
    </Panel>
  );
}

function Spark({ days, field, label, unit, hover, onHover }: {
  days: ActivityDay[];
  field: keyof Omit<ActivityDay, "day">;
  label: string;
  unit: string;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const values = useMemo(() => days.map((d) => Number(d[field]) || 0), [days, field]);
  const total = values.reduce((a, b) => a + b, 0);
  const peak = Math.max(...values, 1);
  const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;

  const point = (i: number) => {
    const x = PAD + i * step;
    // A flat zero series still draws on the baseline rather than off the top.
    const y = H - PAD - (values[i]! / peak) * (H - PAD * 2);
    return [x, y] as const;
  };

  const line = values.map((_, i) => point(i).join(",")).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${PAD + (values.length - 1) * step},${H - PAD}`;

  const active = hover !== null && hover >= 0 && hover < values.length ? hover : null;
  const shown = active ?? values.length - 1;

  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-2)" }}>{label}</span>
        <span className="tabular" style={{ fontSize: "var(--fs-sm)" }}>
          {active === null ? (
            <>
              {count(total)} <span className="faint">in 30 days</span>
            </>
          ) : (
            <>
              {count(values[shown]!)} <span className="faint">{unit}{values[shown] === 1 ? "" : "s"} on {days[shown]!.day}</span>
            </>
          )}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${count(total)} over the last 30 days, peaking at ${count(peak)} in a day.`}
        style={{ display: "block", overflow: "visible", color: "var(--text-3)" }}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - box.left) / box.width;
          const i = Math.round(ratio * (values.length - 1));
          onHover(Math.min(values.length - 1, Math.max(0, i)));
        }}
      >
        {/* Baseline, recessive: the zero line matters, the grid doesn't. */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polygon points={area} fill="currentColor" opacity={0.12} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {active !== null && (
          <>
            <line
              x1={point(active)[0]}
              y1={0}
              x2={point(active)[0]}
              y2={H - PAD}
              stroke="var(--border-strong)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {/* A 2px ring in the surface colour keeps the dot readable
                wherever on the area it lands. */}
            <circle cx={point(active)[0]} cy={point(active)[1]} r={3.5} fill="var(--text)" stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  );
}
