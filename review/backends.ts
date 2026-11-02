/**
 * Reviewer backends. Each turns one review request into a headless command line and reads the
 * final reply back. The runner wraps the command in the sandbox; backends only say which of their
 * own files must stay readable (credentials, installation) and writable (session state).
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../lib/config.ts";
import { ReviewError, secretsIn } from "./core.ts";

export type Request = {
  /** The reviewer's working copy of the tree (cwd). */
  tree: string;
  /** Scratch folder the backend may use for its own state; writable in the sandbox. */
  scratch: string;
  /** Full rubric text: base plus the repository section. */
  rubric: string;
  /** The request with every attachment inlined (diff, spec, previous round). */
  prompt: string;
  /** Path of a file holding `prompt`. */
  promptFile: string;
  model: string;
  /** The reviewer may run commands and write files in `tree`. */
  run: boolean;
};

export type Invocation = {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Real paths the backend must read inside the sandbox. */
  read: string[];
  /** Real paths the backend must write inside the sandbox. */
  write: string[];
  /** Reads the final reply; throws ReviewError(2) when the run failed or ended abnormally. */
  reply(stdout: string): string;
  /** Strings that must never appear in a review (the backend's credentials). */
  secrets(): string[];
};

function real(p: string): string[] {
  return existsSync(p) ? [realpathSync(p)] : [];
}

/** Real paths of the symlinks directly inside `dirs` (settings kept in a dotfiles folder). */
function linkTargets(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      try {
        if (lstatSync(p).isSymbolicLink()) out.push(realpathSync(p));
      } catch {
        // dangling link
      }
    }
  }
  return out;
}

function fileSecrets(path: string): string[] {
  try {
    return secretsIn(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

// --- Pi --------------------------------------------------------------------------------------

/** The final assistant message of Pi's JSON event stream, only when it stopped normally. */
export function piReply(stdout: string): string {
  let last: any = null;
  let aborted = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") last = ev.message;
    if (ev.type === "agent_settled" && ev.aborted) aborted = true;
  }
  if (aborted) throw new ReviewError(2, "pi aborted the run");
  if (!last) throw new ReviewError(2, "no final reviewer message");
  if (last.stopReason !== "stop") throw new ReviewError(2, `the last message ended with ${last.stopReason}`);
  const text = (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  if (!text.trim()) throw new ReviewError(2, "the last reviewer message has no text");
  return text;
}

function pi(q: Request): Invocation {
  const bin = process.env.NSTACK_PI ?? (existsSync(join(homedir(), ".pi/agent/bin/pi")) ? join(homedir(), ".pi/agent/bin/pi") : "pi");
  const dir = join(homedir(), ".pi");
  return {
    cmd: bin,
    args: [
      "-p", "--mode", "json", "--model", q.model,
      // Nothing is discovered: no AGENTS.md/CLAUDE.md, skills, templates, extensions or MCP servers.
      "--no-extensions", "--no-skills", "--no-mcp", "--no-context-files", "--no-prompt-templates", "--no-session",
      "--tools", q.run ? "read,grep,find,ls,bash,write" : "read,grep,find,ls",
      "--system-prompt", q.rubric,
      `@${q.promptFile}`,
      "Follow the rubric. The attached file is the request. Reply with the single JSON object only.",
    ],
    read: [...real(dir), ...linkTargets([dir, join(dir, "agent")]), ...real(bin)],
    write: real(dir),
    reply: piReply,
    secrets: () => fileSecrets(join(dir, "agent/auth.json")),
  };
}

// --- Claude Code -----------------------------------------------------------------------------

export function claudeReply(stdout: string): string {
  let r: any;
  try {
    r = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "");
  } catch {
    throw new ReviewError(2, `claude printed no JSON result: ${stdout.slice(0, 300)}`);
  }
  if (r.is_error || r.subtype !== "success") throw new ReviewError(2, `claude ended with ${r.subtype ?? "an error"}: ${String(r.result ?? "").slice(0, 300)}`);
  if (typeof r.result !== "string" || !r.result.trim()) throw new ReviewError(2, "claude returned no text");
  return r.result;
}

function claude(q: Request): Invocation {
  const bin = process.env.NSTACK_CLAUDE ?? "claude";
  const tools = q.run ? "Read,Grep,Glob,Bash,Write" : "Read,Grep,Glob";
  // A fresh config folder: no plugins, hooks, memory or user CLAUDE.md. Sign-in comes from the keychain.
  const config = join(q.scratch, "claude-config");
  return {
    cmd: bin,
    args: [
      "-p", "--output-format", "json", "--model", q.model,
      "--system-prompt", q.rubric,
      "--tools", tools, "--allowedTools", tools,
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "local", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ],
    env: { CLAUDE_CONFIG_DIR: config },
    stdin: q.prompt,
    read: [...real(bin), ...real(join(homedir(), ".local/share/claude"))],
    write: [],
    reply: claudeReply,
    secrets: () => [],
  };
}

// --- Codex -----------------------------------------------------------------------------------

function codex(q: Request): Invocation {
  const bin = process.env.NSTACK_CODEX ?? "codex";
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const last = join(q.scratch, "codex-last.md");
  return {
    cmd: bin,
    args: [
      "exec", "--json", "-m", q.model,
      // The outer sandbox confines it; a sandbox cannot be nested inside another on macOS.
      "-s", "danger-full-access",
      "-C", q.tree, "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "-o", last, "-",
    ],
    stdin: `${q.rubric}\n\n---\n\n${q.prompt}${q.run ? "" : "\n\nDo not run commands or write files: read only."}`,
    read: [...real(home), ...linkTargets([home]), ...real(bin)],
    write: real(home),
    reply: () => {
      let text = "";
      try {
        text = readFileSync(last, "utf8");
      } catch {
        throw new ReviewError(2, "codex wrote no final message");
      }
      if (!text.trim()) throw new ReviewError(2, "codex's final message is empty");
      return text;
    },
    secrets: () => fileSecrets(join(home, "auth.json")),
  };
}

export const BACKENDS: Record<Backend, (q: Request) => Invocation> = { pi, claude, codex };
