// Public, read-only pages for share links. Content comes from the app as
// structured data and is rendered here with everything escaped: Markdown
// without raw HTML, links only to web and mail addresses, and no scripts.

import MarkdownIt from "markdown-it";

// Kept here (not imported from mail.ts) so rendering has no configuration
// or database dependencies.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
// Only web and mail links survive; everything else (javascript:, data:,
// kern://, file:) becomes plain text.
md.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("rel", "noopener noreferrer nofollow");
  tokens[idx]!.attrSet("target", "_blank");
  return defaultLink(tokens, idx, options, env, self);
};
// Images become their description (shared pages load nothing remote).
md.renderer.rules.image = (tokens, idx) => {
  const alt = tokens[idx]!.content.trim();
  return alt ? `<span class="img">${escapeHtml(alt)}</span>` : "";
};

/** Task-list items ("- [x] done") as read-only checkboxes. */
function checkboxes(html: string): string {
  return html.replace(/<li>(\s*(?:<p>)?)\[( |x|X)\]\s+/g, (_m, lead: string, mark: string) => `<li class="check">${lead}<input type="checkbox" disabled${mark === " " ? "" : " checked"}> `);
}

/** Kern's internal links (kern://note/…) can't open here: keep their text. */
function internalLinks(source: string): string {
  return source.replace(/\[([^\]]*)\]\(kern:\/\/[^)]*\)/g, "$1");
}

export function renderMarkdown(source: string): string {
  return checkboxes(md.render(internalLinks(source)));
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f6;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--soft:#f4f4f5;--accent:#4f46e5;--ok:#16a34a;--warn:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#181818;--text:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2a;--soft:#1f1f1f;--accent:#818cf8}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}
header{margin-bottom:24px}h1.title{font-size:28px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;overflow-wrap:anywhere}
.prose h1,.prose h2,.prose h3{line-height:1.3;margin:1.4em 0 .5em}.prose h1{font-size:22px}.prose h2{font-size:19px}.prose h3{font-size:16px}
.prose>:first-child{margin-top:0}.prose p{margin:.6em 0}.prose a{color:var(--accent)}
.prose pre{background:var(--soft);padding:12px 14px;border-radius:8px;overflow-x:auto;font-size:13px}
.prose code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--soft);padding:1px 5px;border-radius:4px}.prose pre code{background:none;padding:0}
.prose blockquote{margin:.8em 0;padding:2px 0 2px 14px;border-left:3px solid var(--line);color:var(--muted)}
.prose hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}.prose li.check{list-style:none;margin-left:-1.3em}.prose li.check input{margin-right:6px}
.prose table{border-collapse:collapse;display:block;overflow-x:auto}.prose td,.prose th{border:1px solid var(--line);padding:6px 10px}
.img{color:var(--muted);font-style:italic}
.board{display:block;width:100%;height:auto;border-radius:10px;border:1px solid var(--line);background:#fff}
.bar{height:6px;background:var(--soft);border-radius:999px;overflow:hidden;margin:8px 0 2px}.bar>span{display:block;height:100%;background:var(--accent)}
.section{margin-top:28px}.section h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.row{display:flex;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}
.row .grow{flex:1;min-width:0}.row .when{color:var(--muted);font-size:13px;white-space:nowrap}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--muted)}
.pill.done{color:var(--ok)}.pill.late{color:var(--warn)}
.done-title{text-decoration:line-through;color:var(--muted)}
footer{margin-top:32px;color:var(--muted);font-size:12px;text-align:center}footer a{color:inherit}
`;

/** Pages run no scripts and load nothing from elsewhere. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function page(title: string, body: string, opts: { description?: string } = {}): string {
  const desc = opts.description ? `<meta name="description" content="${escapeHtml(opts.description.slice(0, 200))}">` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${desc}
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}<footer>Shared from Kern · read-only</footer></main></body></html>`;
}

export const fmtDate = (d: string | null | undefined) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export interface ProjectShare {
  description?: string;
  targetDate?: string | null;
  done?: number;
  total?: number;
  milestones?: { title: string; targetDate?: string | null; status?: string; progress?: number }[];
  tasks?: { title: string; status?: string; dueDate?: string | null; group?: string | null }[];
}

const STATUS: Record<string, string> = { todo: "To do", in_progress: "In progress", blocked: "Blocked", completed: "Done", inbox: "Inbox", planned: "Planned", active: "Active", cancelled: "Cancelled" };

export function renderProject(p: ProjectShare, today: string): string {
  const parts: string[] = [];
  if (p.description?.trim()) parts.push(`<div class="prose">${renderMarkdown(p.description)}</div>`);
  if (p.total) {
    const pct = Math.round(((p.done ?? 0) / p.total) * 100);
    parts.push(`<div class="meta">${p.done ?? 0} of ${p.total} tasks done · ${pct}%</div><div class="bar"><span style="width:${pct}%"></span></div>`);
  }
  if (p.milestones?.length) {
    const rows = p.milestones
      .slice(0, 100)
      .map((m) => {
        const late = m.status !== "completed" && m.targetDate && m.targetDate < today;
        const pill = `<span class="pill ${m.status === "completed" ? "done" : late ? "late" : ""}">${escapeHtml(STATUS[m.status ?? ""] ?? "Planned")}${typeof m.progress === "number" && m.status !== "completed" ? ` · ${Math.round(m.progress * 100)}%` : ""}</span>`;
        return `<div class="row"><span class="grow">${escapeHtml(m.title)}</span>${pill}<span class="when">${escapeHtml(fmtDate(m.targetDate))}</span></div>`;
      })
      .join("");
    parts.push(`<div class="section"><h2>Milestones</h2>${rows}</div>`);
  }
  if (p.tasks?.length) {
    const groups = new Map<string, NonNullable<ProjectShare["tasks"]>>();
    for (const t of p.tasks.slice(0, 500)) {
      const g = t.group ?? STATUS[t.status ?? ""] ?? "Tasks";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(t);
    }
    for (const [g, list] of groups) {
      const rows = list
        .map((t) => {
          const done = t.status === "completed";
          const late = !done && t.dueDate && t.dueDate < today;
          return `<div class="row"><span class="grow${done ? " done-title" : ""}">${escapeHtml(t.title)}</span><span class="when"${late ? ' style="color:var(--warn)"' : ""}>${escapeHtml(fmtDate(t.dueDate))}</span></div>`;
        })
        .join("");
      parts.push(`<div class="section"><h2>${escapeHtml(g)} · ${list.length}</h2>${rows}</div>`);
    }
  }
  return parts.join("") || `<p class="meta">Nothing to show yet.</p>`;
}
