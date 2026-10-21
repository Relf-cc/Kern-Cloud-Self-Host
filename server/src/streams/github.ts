// The small part of GitHub's REST API streams use: checking that a token can
// reach a repository, and opening issues. Tokens are fine-grained personal
// access tokens with "Issues: read and write" on the chosen repository.

import { config } from "../config.js";

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.githubApi}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kern-cloud-streams",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new GithubError(0, (e as Error).name === "TimeoutError" ? "GitHub didn't answer within 10 seconds." : "Couldn't reach GitHub.");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const detail = (json as { message?: string } | null)?.message;
    const msg =
      res.status === 401
        ? "GitHub rejected the token. It may have expired or been revoked."
        : res.status === 404
          ? "GitHub couldn't find that repository, or the token can't see it."
          : res.status === 410
            ? "Issues are turned off for that repository."
            : res.status === 403 && /rate limit/i.test(detail ?? "")
              ? "GitHub's rate limit was reached. Try again later."
              : res.status === 403
                ? `The token isn't allowed to do that${detail ? ` (${detail})` : ""}. Give it "Issues: read and write" on the repository.`
                : `GitHub answered ${res.status}${detail ? `: ${detail}` : ""}.`;
    throw new GithubError(res.status, msg);
  }
  return json as T;
}

export interface RepoCheck {
  fullName: string;
  private: boolean;
  hasIssues: boolean;
  htmlUrl: string;
}

export async function checkRepo(token: string, repo: string): Promise<RepoCheck> {
  const r = await call<{ full_name: string; private: boolean; has_issues: boolean; html_url: string }>(token, "GET", `/repos/${repo}`);
  if (!r.has_issues) throw new GithubError(410, "Issues are turned off for that repository.");
  return { fullName: r.full_name, private: r.private, hasIssues: r.has_issues, htmlUrl: r.html_url };
}

export interface CreatedIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  updatedAt: string | null;
  notes: string[];
}

interface IssueJson {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  labels: ({ name?: string } | string)[];
  updated_at?: string;
}

/**
 * Opens an issue. If GitHub refuses the labels or assignees (unknown
 * assignee, or labels the token can't create), it tries again without them
 * and says so in `notes`.
 */
export async function createIssue(token: string, repo: string, input: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<CreatedIssue> {
  const notes: string[] = [];
  let issue: IssueJson;
  const payload = { title: input.title, body: input.body, ...(input.labels.length ? { labels: input.labels } : {}), ...(input.assignees.length ? { assignees: input.assignees } : {}) };
  try {
    issue = await call<IssueJson>(token, "POST", `/repos/${repo}/issues`, payload);
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 422 || (!input.labels.length && !input.assignees.length)) throw e;
    notes.push(`GitHub refused the labels or assignees (${e.message}), so the issue was opened without them.`);
    issue = await call<IssueJson>(token, "POST", `/repos/${repo}/issues`, { title: input.title, body: input.body });
  }
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: (issue.body ?? "").replace(/\r\n/g, "\n"),
    labels: issue.labels
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter(Boolean)
      .sort(),
    updatedAt: issue.updated_at ?? null,
    notes,
  };
}
