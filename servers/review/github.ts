/** Thin helpers over the GitHub CLI (`gh`) via host.exec. */

import type { Host } from "../lib/host.ts";

export interface ExecOpts {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function gh(host: Host, opts: ExecOpts, args: string[]): Promise<GhResult> {
  const res = await host.exec("gh", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 90_000,
    signal: opts.signal,
  });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr };
}

async function ghJson<T>(host: Host, opts: ExecOpts, args: string[]): Promise<T> {
  const res = await gh(host, opts, args);
  if (res.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (code ${res.code}): ${(res.stderr || res.stdout).trim()}`);
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new Error(`gh ${args.join(" ")} returned non-JSON output: ${res.stdout.slice(0, 500)}`);
  }
}

export async function repoSlug(host: Host, opts: ExecOpts): Promise<string> {
  const r = await ghJson<{ nameWithOwner: string }>(host, opts, ["repo", "view", "--json", "nameWithOwner"]);
  return r.nameWithOwner;
}

export async function defaultBranch(host: Host, opts: ExecOpts): Promise<string> {
  const r = await ghJson<{ defaultBranchRef: { name: string } }>(host, opts, [
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
  ]);
  return r.defaultBranchRef.name;
}

/**
 * A parsed PR reference. `repo` ("owner/name") is set when the reference names
 * its repository; a bare number leaves it unset and resolves against the
 * working directory's repository, as `gh` does by default.
 */
export interface PrRef {
  repo?: string;
  number: string;
}

const GITHUB_PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const OWNER_REPO_PR = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const BARE_PR = /^#?(\d+)$/;

/**
 * Parse `https://github.com/o/r/pull/N[/…|?…|#…]`, `o/r#N`, or a bare `N`.
 * Anything else — including a URL whose repository cannot be read — is an
 * error, never a silent fallback to the working directory's repository.
 */
export function parsePrRef(pr: string | number): PrRef {
  const s = String(pr).trim();
  const bare = s.match(BARE_PR);
  if (bare) return { number: bare[1] };
  const m = s.match(GITHUB_PR_URL) ?? s.match(OWNER_REPO_PR);
  if (m) return { repo: `${m[1]}/${m[2].replace(/\.git$/i, "")}`, number: m[3] };
  throw new Error(
    `Could not resolve the repository and number of PR "${s}". ` +
      `Pass https://github.com/<owner>/<repo>/pull/<n>, <owner>/<repo>#<n>, or a bare PR number for the session's repository.`,
  );
}

/** `-R owner/name` for `gh pr …` when the reference names its repository. */
export function prRepoArgs(ref: PrRef): string[] {
  return ref.repo ? ["-R", ref.repo] : [];
}

/** The PR's repository slug: the one it names, else the working directory's. */
export async function prRepoSlug(host: Host, opts: ExecOpts, pr: string | number): Promise<string> {
  return parsePrRef(pr).repo ?? (await repoSlug(host, opts));
}

export interface PRMeta {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url: string;
  state: string;
  commits: Array<{ oid: string; messageHeadline: string }>;
}

export async function prMeta(host: Host, opts: ExecOpts, pr: string | number): Promise<PRMeta> {
  const ref = parsePrRef(pr);
  return ghJson<PRMeta>(host, opts, [
    "pr",
    "view",
    ref.number,
    ...prRepoArgs(ref),
    "--json",
    "number,title,body,headRefName,baseRefName,headRefOid,url,state,commits",
  ]);
}
