// @vitest-environment jsdom

/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The charts, rendered.
//
// A typecheck says the options are the right shape; it does not say Chart.js
// will accept them. An unregistered controller, a scriptable callback that
// throws on the first frame, an update against a chart React has already torn
// down - all of those are runtime faults, and this is what catches them.
//
// It also pins the one rule the ring must never lose: every slice keeps a
// legend row carrying its exact figure, including the slices that are empty.
// The tones are greyscale, so that legend is what identifies a slice, and a
// refactor that dropped it would make the ring unreadable rather than untidy.

import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import TrendChart from "./TrendChart";
import BarsChart from "./BarsChart";
import DonutChart from "./DonutChart";

/**
 * Chart.js needs a 2d context, which jsdom has not got. Every call is a no-op
 * except the few whose return value it actually reads back.
 */
function stubCanvas() {
  const gradient = { addColorStop: vi.fn(), toString: () => "[object CanvasGradient]" };
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    // Chart.js refuses a context whose .canvas is not the element it asked
    // about, so this back-reference is required, not decoration.
    const base: Record<string, unknown> = {
      canvas: this,
      measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      createLinearGradient: () => gradient,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
    return new Proxy(base, {
      get: (target, prop) => (prop in target ? target[prop as string] : () => undefined),
      set: (target, prop, value) => {
        target[prop as string] = value;
        return true;
      },
    });
  } as never;
}

beforeAll(() => {
  stubCanvas();
  // Chart.js watches its container when responsive; a webview has this.
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  // Run them as a reduced-motion machine does: animationMs() reads this, so
  // there are no animation frames left in flight when a test ends.
  document.documentElement.dataset.motion = "off";
});

afterEach(() => cleanup());

const labels = ["1 Oct", "2 Oct", "3 Oct", "4 Oct"];

test("a trend draws a flat zero series without falling off the axis", () => {
  const { container } = render(<TrendChart labels={labels} values={[0, 0, 0, 0]} tip={() => "0"} ariaLabel="zeros" />);
  expect(container.querySelector("canvas")).toBeTruthy();
});

test("a trend accepts a crosshair index from outside", () => {
  const { container } = render(
    <TrendChart labels={labels} values={[3, 0, 12, 7]} hover={2} showDates tip={(i) => `point ${i}`} ariaLabel="with data" />,
  );
  expect(container.querySelector("canvas")).toBeTruthy();
});

test("a trend survives a crosshair index that is out of range", () => {
  // The index is shared by a stack of charts, so it can outlive a shorter one.
  const { container } = render(<TrendChart labels={labels} values={[1, 2]} hover={29} tip={() => "x"} ariaLabel="short" />);
  expect(container.querySelector("canvas")).toBeTruthy();
});

test("bars render, including a label long enough to need cutting", () => {
  const { container } = render(
    <BarsChart labels={["A workspace with a very long name indeed", "B"]} values={[10, 4]} tip={() => "x"} ariaLabel="bars" />,
  );
  expect(container.querySelector("canvas")).toBeTruthy();
});

test("a ring lists every slice with its figure, empty ones included", () => {
  const slices = [
    { label: "Database", value: 900, display: "900 B" },
    { label: "Shared images", value: 100, display: "100 B" },
    { label: "Share images", value: 0, display: "0 B" },
  ];
  const { container } = render(<DonutChart slices={slices} centre="1 KB" caption="measured" ariaLabel="storage" />);

  expect(container.querySelector("canvas")).toBeTruthy();
  // The legend is the reading surface: a category that has emptied keeps its
  // row, and so keeps its tone, rather than repainting the ones that remain.
  expect(container.querySelectorAll(".donut-legend__row").length).toBe(3);
  expect(container.textContent).toContain("Share images");
  expect(container.textContent).toContain("90%");
  expect(container.textContent).toContain("900 B");
  // An empty slice shows a dash rather than a misleading 0%.
  expect(container.textContent).toContain("—");
});

test("a ring with nothing measured draws no arc but still legends", () => {
  const { container } = render(
    <DonutChart slices={[{ label: "Database", value: 0, display: "0 B" }]} centre="0 B" ariaLabel="empty" />,
  );
  expect(container.querySelector("canvas")).toBeNull();
  expect(container.querySelector(".donut__empty")).toBeTruthy();
  expect(container.querySelectorAll(".donut-legend__row").length).toBe(1);
});

test("a ring of states takes the tones it is given, not the greyscale ramp", () => {
  const { container } = render(
    <DonutChart
      slices={[
        { label: "Passing", value: 8, display: "8" },
        { label: "Failing", value: 2, display: "2" },
      ]}
      tones={["#82b48f", "#e0716f"]}
      centre="2 failing"
      ariaLabel="checks"
    />,
  );
  const keys = Array.from(container.querySelectorAll<HTMLElement>(".donut-legend__key"));
  expect(keys.map((k) => k.style.background)).toEqual(["rgb(130, 180, 143)", "rgb(224, 113, 111)"]);
});
