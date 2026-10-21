import { describe, expect, it } from "vitest";
import { calendar, fold } from "./ics.js";
import { renderMarkdown, renderProject } from "./pages.js";

describe("shared pages", () => {
  it("renders Markdown without raw HTML or unsafe links", () => {
    const html = renderMarkdown('# Plan\n\n<script>alert(1)</script>\n\n[ok](https://example.com) [bad](javascript:alert(1)) [note](kern://note/abc)\n\n- [x] done\n- [ ] todo\n\n![logo](https://x/y.png)');
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    // Rejected links stay as plain text; they never become an href.
    expect(html).not.toMatch(/href="javascript/i);
    expect(html).not.toContain("kern://");
    expect(html).toContain("note");
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).not.toContain("<img");
    expect(html).toContain('<span class="img">logo</span>');
  });

  it("renders a project roadmap with escaped text", () => {
    const html = renderProject(
      {
        done: 1,
        total: 4,
        milestones: [{ title: "<b>Beta</b>", targetDate: "2030-01-01", status: "active", progress: 0.5 }],
        tasks: [
          { title: "Ship", status: "todo", dueDate: "2029-01-01" },
          { title: "Plan", status: "completed" },
        ],
      },
      "2030-06-01",
    );
    expect(html).toContain("1 of 4 tasks done · 25%");
    expect(html).toContain("&lt;b&gt;Beta&lt;/b&gt;");
    expect(html).toContain("late");
    expect(html).toContain("To do · 1");
    expect(html).toContain("done-title");
  });
});

describe("calendar feeds", () => {
  it("writes all-day and timed events with escaping", () => {
    const ics = calendar("Kern · Team", [
      { uid: "t1@kern", title: "Pay rent; today, please", start: "2030-12-31" },
      { uid: "t2@kern", title: "Call", start: "2030-02-01T23:45", minutes: 30, categories: "Ops" },
      { uid: "bad", title: "Skipped", start: "soon" },
    ], new Date("2030-01-01T00:00:00Z"));
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:Pay rent\\; today\\, please");
    expect(ics).toContain("DTSTART;VALUE=DATE:20301231\r\nDTEND;VALUE=DATE:20310101");
    expect(ics).toContain("DTSTART:20300201T234500\r\nDTEND:20300202T001500");
    expect(ics).toContain("X-WR-CALNAME:Kern · Team");
    expect(ics).not.toContain("Skipped");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });

  it("folds long lines at 75 octets without splitting characters", () => {
    const line = `SUMMARY:${"é".repeat(60)}`;
    const folded = fold(line);
    for (const part of folded.split("\r\n")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });
});
