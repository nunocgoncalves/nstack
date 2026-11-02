/**
 * Per-repository nstack configuration.
 *
 * Looked up, first match wins:
 *   1. <repo root>/.nstack/config.json            (committed with the repository)
 *   2. $NSTACK_HOME/repos/<owner>/<name>/config.json   (kept outside it; NSTACK_HOME defaults to ~/.config/nstack)
 *   3. $NSTACK_HOME/repos/<owner>/config.json          (every repository of that owner)
 *
 * Paths inside the file (context, rubric, ship) are relative to the folder that holds it; when
 * unset, context.md, rubric.md and ship.md next to config.json are used if present.
 * Every field is optional; a repository with no config gets the defaults below.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Backend = "pi" | "claude" | "codex";

export type Config = {
  /** Where the folder holding config.json is; null when the defaults apply. */
  dir: string | null;
  /** Issue tracker: GitHub issues ("Closes #N" in the PR body) or Linear (the ship skill fetches the ticket). */
  tracker: "github" | "linear";
  /** Ticket key prefix for branches and worktrees, e.g. ABC (ABC-123). GitHub issues use GH (GH-12). */
  ticketPrefix: string;
  /** Branch PRs target. null = the repository's default branch. */
  base: string | null;
  /** Language for commits, PR text and review findings, e.g. "English" or "European Portuguese (PT-PT)". */
  language: string;
  /** Text injected into every session in this repository (absolute path or null). */
  context: string | null;
  /** Repository section appended to the base review rubric (absolute path or null). */
  rubric: string | null;
  /** Repository-specific ship steps (absolute path or null). */
  ship: string | null;
  /** How a change proves itself here: shown to the author and the reviewer. */
  proof: string | null;
  /** Path prefixes whose content never goes to the reviewer (client data, fixtures with real data). */
  data: string[];
  review: {
    backend: Backend;
    model: string | null;
    maxRounds: number;
    /** The reviewer may run commands in its own copy of the tree to prove findings. */
    run: boolean;
    /** Extra folders the sandboxed reviewer may read (a virtualenv, a toolchain). Repo-relative or absolute. */
    readPaths: string[];
    /** Post each round on the PR as a comment, or keep it local for the ship summary. */
    post: "comment" | "none";
  };
};

export const DEFAULT_MODELS: Record<Backend, string> = {
  pi: "openai-codex/gpt-6.1-sol",
  claude: "claude-opus-5-5",
  codex: "gpt-6.1-sol",
};

export function nstackHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.NSTACK_HOME?.trim() || join(homedir(), ".config", "nstack");
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The primary checkout's root (a linked worktree resolves to the repository it belongs to). */
export function repoRoot(cwd: string): string | null {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  return top;
}

/** owner/name of the origin remote on GitHub, or null. */
export function originSlug(cwd: string): string | null {
  const url = git(cwd, ["remote", "get-url", "origin"]);
  const m = url?.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function str(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.trim()) throw new Error(`nstack config: ${field} must be a non-empty string`);
  return v;
}

function strList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
    throw new Error(`nstack config: ${field} must be a list of non-empty strings`);
  }
  return v;
}

/** Parse and validate a config object. `dir` resolves relative paths. Throws on a bad field. */
export function parseConfig(raw: any, dir: string | null): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("nstack config: not a JSON object");
  const known = ["tracker", "ticketPrefix", "base", "language", "context", "rubric", "ship", "proof", "data", "review", "$schema"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw new Error(`nstack config: unknown field "${k}"`);
  const at = (p: string | null) => (p === null ? null : isAbsolute(p) || dir === null ? p : resolve(dir, p));
  // context.md, rubric.md and ship.md next to config.json are picked up without being named.
  const named = (field: string) => at(str(raw[field], field)) ?? (dir && existsSync(join(dir, `${field}.md`)) ? join(dir, `${field}.md`) : null);

  const tracker = raw.tracker ?? "github";
  if (!["github", "linear"].includes(tracker)) throw new Error('nstack config: tracker must be "github" or "linear"');
  const r = raw.review ?? {};
  if (typeof r !== "object" || Array.isArray(r)) throw new Error("nstack config: review must be an object");
  for (const k of Object.keys(r)) {
    if (!["backend", "model", "maxRounds", "run", "readPaths", "post"].includes(k)) throw new Error(`nstack config: unknown field "review.${k}"`);
  }
  const backend = r.backend ?? "pi";
  if (!["pi", "claude", "codex"].includes(backend)) throw new Error('nstack config: review.backend must be "pi", "claude" or "codex"');
  const maxRounds = r.maxRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("nstack config: review.maxRounds must be a positive integer");
  if (r.run !== undefined && typeof r.run !== "boolean") throw new Error("nstack config: review.run must be true or false");
  const post = r.post ?? "comment";
  if (!["comment", "none"].includes(post)) throw new Error('nstack config: review.post must be "comment" or "none"');
  const prefix = str(raw.ticketPrefix, "ticketPrefix") ?? (tracker === "github" ? "GH" : null);
  if (!prefix || !/^[A-Z][A-Z0-9]*$/.test(prefix)) throw new Error("nstack config: ticketPrefix must be upper-case letters/digits (required for Linear)");

  return {
    dir,
    tracker,
    ticketPrefix: prefix,
    base: str(raw.base, "base"),
    language: str(raw.language, "language") ?? "English",
    context: named("context"),
    rubric: named("rubric"),
    ship: named("ship"),
    proof: str(raw.proof, "proof"),
    data: strList(raw.data, "data"),
    review: {
      backend,
      model: str(r.model, "review.model"),
      maxRounds,
      run: r.run ?? true,
      readPaths: strList(r.readPaths, "review.readPaths"),
      post,
    },
  };
}

/** Where this repository's config lives, or null. */
export function findConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = repoRoot(cwd);
  if (!root) return null;
  const inRepo = join(root, ".nstack", "config.json");
  if (existsSync(inRepo)) return inRepo;
  const slug = originSlug(root);
  if (slug) {
    for (const dir of [slug, slug.split("/")[0]]) {
      const outside = join(nstackHome(env), "repos", dir, "config.json");
      if (existsSync(outside)) return outside;
    }
  }
  return null;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = findConfig(cwd, env);
  if (!file) return parseConfig({}, null);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`nstack config ${file}: ${(e as Error).message}`);
  }
  return parseConfig(raw, dirname(file));
}

/** Read an optional text file named by the config; null when unset or missing. */
export function readOptional(path: string | null): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
