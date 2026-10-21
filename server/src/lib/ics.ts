// A small ICS (iCalendar) writer for calendar feeds: tasks with due dates
// and milestones with target dates, as calendar apps expect them.

export interface IcsEvent {
  uid: string;
  title: string;
  description?: string;
  categories?: string;
  /** All day: "YYYY-MM-DD". Timed (floating local time): "YYYY-MM-DDTHH:MM". */
  start: string;
  /** Minutes, for timed events (default 30). */
  minutes?: number;
  url?: string;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Folds a content line at 75 octets, never inside a UTF-8 character. */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let len = 0;
  for (const ch of line) {
    const w = Buffer.byteLength(ch);
    if (len + w > 75) {
      out.push(cur);
      cur = " ";
      len = 1;
    }
    cur += ch;
    len += w;
  }
  out.push(cur);
  return out.join("\r\n");
}

const pad = (n: number) => String(n).padStart(2, "0");
const compact = (d: string) => d.replace(/[-:]/g, "");

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
}

function addMinutes(dateTime: string, minutes: number): string {
  const [date, time] = dateTime.split("T");
  const [y, mo, d] = date!.split("-").map(Number);
  const [h, mi] = time!.split(":").map(Number);
  const t = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi! + minutes));
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function calendar(name: string, events: IcsEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kern//Cloud//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", fold(`X-WR-CALNAME:${esc(name)}`), "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const e of events) {
    let when: string[];
    if (DATE_TIME.test(e.start)) {
      when = [`DTSTART:${compact(e.start)}00`, `DTEND:${addMinutes(e.start, Math.max(5, Math.min(24 * 60, e.minutes ?? 30)))}`];
    } else if (DATE.test(e.start)) {
      when = [`DTSTART;VALUE=DATE:${compact(e.start)}`, `DTEND;VALUE=DATE:${addDays(e.start, 1)}`];
    } else {
      continue;
    }
    lines.push("BEGIN:VEVENT", fold(`UID:${e.uid}`), `DTSTAMP:${stamp}`, ...when, fold(`SUMMARY:${esc(e.title)}`));
    if (e.description?.trim()) lines.push(fold(`DESCRIPTION:${esc(e.description.slice(0, 2000))}`));
    if (e.categories) lines.push(fold(`CATEGORIES:${esc(e.categories)}`));
    if (e.url) lines.push(fold(`URL:${e.url}`));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
