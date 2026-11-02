/**
 * SessionStart hook.
 *
 * - Fast-forwards the repository's primary checkout when it is clean and on its default branch
 *   (ff-only); warns when it is behind and cannot be.
 * - When the session runs in the primary checkout, says ticket work belongs in a worktree.
 * - Injects this repository's nstack context: tracker, base branch, language, proof, and the
 *   config's `context` file. Nothing at all for a repository without nstack config.
 *
 * Never blocks: any failure degrades to less context, not an error.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { findConfig, loadConfig, readOptional } from "../lib/config.ts";

let input: { hook_event_name?: string; cwd?: string } = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cwd = input.cwd ?? process.cwd();
const lines: string[] = [];
const notices: string[] = [];

function git(dir: string, args: string[], timeout = 5_000) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Fast-forward the primary checkout; returns a warning or null. */
function syncPrimary(): string | null {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const common = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return null;
  const commonDir = isAbsolute(common.out) ? common.out : resolve(top.out, common.out);
  if (!commonDir.endsWith("/.git")) return null; // bare or unusual layout
  const primary = dirname(commonDir);
  if (resolve(top.out) === resolve(primary)) {
    lines.push(
      `[nstack] cwd is the primary checkout (${primary}). Keep it on the default branch and read-only; ` +
        "ticket edits, commits and pushes belong in the ticket worktree from worktree_ensure.",
    );
  }
  const def = git(primary, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!def.ok) return null;
  const remoteRef = def.out;
  const defaultBranch = remoteRef.replace(/^origin\//, "");
  const branch = git(primary, ["branch", "--show-current"]).out;
  git(primary, ["fetch", "--quiet", "origin", defaultBranch], 8_000);
  const behind = Number(git(primary, ["rev-list", "--count", `HEAD..${remoteRef}`]).out || "0");
  if (!behind) return null;
  const name = primary.split("/").pop();
  if (branch !== defaultBranch) {
    return `${name}: the primary checkout is on ${branch || "a detached HEAD"}, not ${defaultBranch}, and ${remoteRef} is ${behind} commits ahead; not fast-forwarded.`;
  }
  if (git(primary, ["status", "--porcelain", "--untracked-files=no"]).out) {
    return `${name}: the primary checkout has local changes and is ${behind} commits behind ${remoteRef}; not fast-forwarded.`;
  }
  const ff = git(primary, ["merge", "--ff-only", "--quiet", remoteRef], 10_000);
  if (!ff.ok) return `${name}: ${defaultBranch} is ${behind} commits behind ${remoteRef} and cannot be fast-forwarded (${ff.err.split("\n")[0]}).`;
  lines.push(`[nstack] Fast-forwarded the ${name} primary checkout by ${behind} commits to ${remoteRef}.`);
  return null;
}

if (input.hook_event_name === "SessionStart") {
  try {
    const warn = syncPrimary();
    if (warn) notices.push(warn);
  } catch {
    /* never block session start */
  }
  try {
    const file = findConfig(cwd);
    if (file) {
      const c = loadConfig(cwd);
      lines.push(
        [
          `[nstack] Repository config: ${file}`,
          `- Tracker: ${c.tracker === "github" ? "GitHub issues (tickets are GH-<n>)" : `Linear (${c.ticketPrefix}-<n>)`}`,
          `- PRs target: ${c.base ?? "the default branch"}`,
          `- Language for commits, PR text and reviews: ${c.language}`,
          c.proof ? `- Every change proves itself: ${c.proof}` : "",
          c.data.length ? `- Private data, never in commits, PR text or the reviewer's copy: ${c.data.join(", ")}` : "",
          `- Independent review: ${c.review.backend}, at most ${c.review.maxRounds} rounds (/nstack:ship runs it)`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      const extra = readOptional(c.context);
      if (extra?.trim()) lines.push(extra.trim());
    }
  } catch (e) {
    notices.push(`nstack: ${(e as Error).message}`);
  }
}

const output: Record<string, unknown> = {};
if (lines.length) output.hookSpecificOutput = { hookEventName: input.hook_event_name, additionalContext: lines.join("\n\n") };
if (notices.length) output.systemMessage = notices.join("\n");
if (Object.keys(output).length) process.stdout.write(JSON.stringify(output));
