/**
 * PreToolUse(Bash) guard for the GitHub CLI.
 *
 * Allows reads (pr view/diff/checks/list, run view/log, issue view, `gh api`
 * GETs and GraphQL queries) and the writes the `ship` flow owns (pr create,
 * pr edit, pr ready, pr comment, run rerun). Blocks writes that bypass the
 * human: merging, reviews/approvals, release dispatch and releases, repo,
 * secret and variable changes, and any `gh api` write (POST/PUT/PATCH/DELETE,
 * implicit POST via fields, GraphQL mutations, deployment approvals).
 *
 * Fails closed: unparseable hook input blocks the call. Exit code 2 blocks the
 * call and feeds stderr back to the model.
 */

import { readFileSync } from "node:fs";

function block(reason: string): never {
  process.stderr.write(`guard-gh: ${reason}\n`);
  process.exit(2);
}

let cmd: string;
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as { tool_input?: { command?: unknown } };
  if (typeof input.tool_input?.command !== "string") throw new Error("no command");
  cmd = input.tool_input.command;
} catch (e) {
  block(`could not parse the hook input (${(e as Error).message}); refusing the call.`);
}

/** The reason a single `gh …` invocation is refused, or null. */
function refusal(segment: string): string | null {
  const m = segment.match(/(?:^|[\s/(`$])gh\s+(.*)$/s);
  if (!m) return null;
  const rest = m[1];
  const [group = "", sub = ""] = rest.trim().split(/\s+/);

  if (group === "pr" && sub === "merge") return "merging is a human's action; ship stops at Ready.";
  if (group === "pr" && sub === "review") return "no GitHub reviews or approvals from agents; review findings go in the summary comment.";
  if (group === "workflow" && sub === "run" && /release/i.test(rest)) return "release dispatch is a human's action.";
  if (group === "workflow" && ["enable", "disable"].includes(sub)) return "workflow enablement changes need a human.";
  if (group === "release" && !["list", "view", "download"].includes(sub)) return "GitHub Releases are written only by a release workflow.";
  if (group === "repo" && ["edit", "delete", "rename", "archive", "unarchive"].includes(sub)) return "repository settings changes need a human.";
  if (["secret", "variable", "ruleset"].includes(group) && !["list", "view", "check"].includes(sub)) return `${group} changes need a human.`;

  if (group === "api") {
    // gh uses the last method flag, so judge every one of them.
    const methods = [...rest.matchAll(/(?:-X|--method)[\s=]*['"]?(GET|HEAD|POST|PUT|PATCH|DELETE)\b/gi)].map((m) => m[1].toUpperCase());
    const method = methods.find((m) => m !== "GET" && m !== "HEAD") ?? methods.at(-1);
    const hasFields = /(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[\s=]|$)/.test(rest);
    const isGraphql = sub === "graphql";
    if (/pending_deployments|\/environments\/[^/\s]+\/deployment|deployment_protection/.test(rest) && method !== "GET") {
      return "environment and deployment approvals are a human's action.";
    }
    if (isGraphql) {
      return /\bmutation\b/.test(rest) ? "GraphQL mutations bypass the PR tools; use gh pr commands or ask a human." : null;
    }
    if (method && method !== "GET" && method !== "HEAD") return `gh api ${method} writes bypass the PR tools; use gh pr commands or ask a human.`;
    if (!method && hasFields) return "gh api with fields is an implicit POST; add -X GET for a read, or use gh pr commands.";
  }
  return null;
}

/** Split on unquoted ; & | and newlines so quoted jq filters stay whole. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      if (c === "\\" && quote === '"') cur += c + (command[++i] ?? "");
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // Heredoc: its body is data (file content, a PR body), not commands.
      const m = command.slice(i).match(/^<<-?\s*(['"]?)([\w.-]+)\1[^\n]*\n/);
      if (!m) {
        cur += c;
        continue;
      }
      cur += command.slice(i, i + m[0].length - 1);
      const bodyStart = i + m[0].length;
      const end = command.slice(bodyStart).search(new RegExp(`^\\s*${m[2].replace(/[.]/g, "\\.")}\\s*$`, "m"));
      if (end < 0) break; // body runs to the end of the command
      const closing = command.indexOf("\n", bodyStart + end);
      i = closing < 0 ? command.length : closing - 1;
    } else if (c === "\\") {
      cur += c + (command[++i] ?? "");
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  // Heredoc prose can hold a lone apostrophe; only a gh command must parse.
  if (quote && /(?:^|[\s/(`$])gh\s/.test(command)) block("unbalanced quotes in a gh command; refusing to guess what it runs.");
  out.push(cur);
  return out;
}

for (const segment of segments(cmd)) {
  const reason = refusal(segment);
  if (reason) block(reason);
}
