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
// "the day deliveries spiked" and "the day nobody signed up" line up. That is
// why the hovered index lives here rather than in the charts.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { api } from "@/lib/ipc";
import { count, shortDay } from "@/lib/format";
import { Empty, Panel } from "@/components/ui/Controls";
import { TrendChart } from "@/components/charts";
import type { ActivityDay } from "@/lib/types";

const SERIES: { key: keyof Omit<ActivityDay, "day">; label: string; unit: string }[] = [
  { key: "signUps", label: "Sign-ups", unit: "account" },
  { key: "deliveries", label: "Stream deliveries", unit: "delivery" },
  { key: "changes", label: "Records changed", unit: "record" },
];

export function Activity30() {
  const activity = useQuery({ queryKey: ["overview", "activity"], queryFn: () => api.admin.activity(30), staleTime: 60_000 });
  const [hover, setHover] = useState<number | null>(null);
  const series = activity.data?.series ?? [];
  const labels = useMemo(() => series.map((d) => shortDay(d.day)), [series]);

  if (activity.isLoading) return null;
  if (!series.length) {
    return (
      <Panel title="The last 30 days" icon={TrendingUp}>
        <Empty compact>Nothing has happened on this instance yet.</Empty>
      </Panel>
    );
  }

  return (
    <Panel title="The last 30 days" icon={TrendingUp}>
      <div className="chart-stack">
        {SERIES.map((s, i) => (
          <Measure
            key={s.key}
            days={series}
            labels={labels}
            field={s.key}
            label={s.label}
            unit={s.unit}
            hover={hover}
            onHover={setHover}
            showDates={i === SERIES.length - 1}
          />
        ))}
      </div>
    </Panel>
  );
}

function Measure({ days, labels, field, label, unit, hover, onHover, showDates }: {
  days: ActivityDay[];
  labels: string[];
  field: keyof Omit<ActivityDay, "day">;
  label: string;
  unit: string;
  hover: number | null;
  onHover: (index: number | null) => void;
  showDates: boolean;
}) {
  const values = useMemo(() => days.map((d) => Number(d[field]) || 0), [days, field]);
  const total = useMemo(() => values.reduce((a, b) => a + b, 0), [values]);
  const peak = useMemo(() => Math.max(...values, 0), [values]);

  const active = hover !== null && hover >= 0 && hover < values.length ? hover : null;
  const plural = (n: number) => `${unit}${n === 1 ? "" : "s"}`;
  const tip = useMemo(() => (index: number) => `${count(values[index] ?? 0)} ${plural(values[index] ?? 0)}`, [values, unit]);

  return (
    <div className="chart-stack__item">
      {/* The heading is the legend: one series, named here, so the chart needs
          no key of its own. On a hover it becomes the readout for that day. */}
      <div className="chart-head">
        <span className="chart-head__label">{label}</span>
        <span className="chart-head__value tabular">
          {active === null ? (
            <>
              {count(total)} <span className="faint">in 30 days</span>
            </>
          ) : (
            <>
              {count(values[active]!)} <span className="faint">{plural(values[active]!)} on {days[active]!.day}</span>
            </>
          )}
        </span>
      </div>
      <TrendChart
        labels={labels}
        values={values}
        hover={hover}
        onHover={onHover}
        showDates={showDates}
        tip={tip}
        ariaLabel={`${label}: ${count(total)} over the last 30 days, peaking at ${count(peak)} in a day.`}
      />
    </div>
  );
}
