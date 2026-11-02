/**
 * review server tools: ticket worktrees, PR opening and a non-blocking CI
 * snapshot. Review judgement lives in the `ship` skill and the independent
 * reviewer (bin/review.ts); nothing here waits on CI.
 */

import type { Host } from "../lib/host.ts";
import { Type } from "../lib/schema.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../lib/config.ts";
import { defaultBranch, gh, parsePrRef, prMeta, prRepoArgs, type ExecOpts } from "./github.ts";
import {
  canonicalPath,
  ensureTicketWorktree,
  removeTicketWorktree,
  repoIdentity,
  requireTicketWorktree,
  ticketWorktreePath,
} from "./worktrees.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], details: {} };
}

function err(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], details: {}, isError: true };
}

export function registerReviewTools(host: Host): void {
  // --- worktree_ensure ------------------------------------------------------
  host.registerTool({
    name: "worktree_ensure",
    label: "Ensure ticket worktree",
    description:
      "Create or reuse the dedicated linked git worktree for a ticket at <root>/<repo>/<TICKET> (<root> = NSTACK_WORKTREE_ROOT or ~/Developer/worktrees) and check out its <TICKET>-<description> branch there. All ticket edits, commands, commits, and pushes must use that absolute path, never the primary checkout. Idempotent: reuse never resets or discards existing work.",
    promptSnippet: "Create or reuse the dedicated ticket worktree",
    promptGuidelines: [
      "Call worktree_ensure before any ticket edit and use the returned absolute path for reads, edits, commands, commits, and pushes.",
      "Never implement, commit, or push ticket work in the primary checkout.",
    ],
    parameters: Type.Object({
      ticketId: Type.String({ description: "Ticket key: a Linear identifier (ABC-123) or GH-<n> for GitHub issue n" }),
      branch: Type.Optional(
        Type.String({
          description:
            "Branch to check out (<TICKET>-<description>). Defaults to the single existing matching branch; required when no matching branch exists yet.",
        }),
      ),
      base: Type.Optional(
        Type.String({ description: "Base branch for a newly created ticket branch. Defaults to the nstack config base, else the repository default branch." }),
      ),
      pr: Type.Optional(
        Type.String({
          description:
            "PR URL or owner/repo#N whose repository owns the ticket (e.g. an overlay PR from a monorepo session). Defaults to the session's repository.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const result = await ensureTicketWorktree(
          host,
          { cwd: ctx.cwd, signal },
          params.ticketId,
          params.branch,
          params.base ?? loadConfig(ctx.cwd).base ?? undefined,
          params.pr ? parsePrRef(params.pr).repo : undefined,
        );
        const { state, identity } = result;
        return text(
          `${result.created ? "Created" : "Reusing"} ticket worktree: ${state.path}\n` +
            `Branch: ${state.branch} @ ${state.head.slice(0, 12) || "(no commits yet)"}\n` +
            `Working tree: ${state.clean ? "clean" : `dirty (${state.dirty.length}): ${state.dirty.slice(0, 5).join("; ")}`}\n` +
            `Primary checkout (never use for ticket work): ${identity.primaryRoot}\n\n` +
            `Use absolute paths under ${state.path} for every read, edit, command, commit, and push (or git -C ${state.path} ...).`,
        );
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  });

  // --- worktree_remove ------------------------------------------------------
  host.registerTool({
    name: "worktree_remove",
    label: "Remove ticket worktree",
    description:
      "Remove the dedicated ticket worktree after merge/acceptance and prune stale worktree metadata. Refuses a dirty worktree unless force=true. The ticket branch is not deleted.",
    promptSnippet: "Remove the ticket worktree after acceptance",
    promptGuidelines: [
      "Remove the ticket worktree only after the ticket is done (merge/acceptance), never mid-implementation.",
    ],
    parameters: Type.Object({
      ticketId: Type.String({ description: "Ticket key: a Linear identifier (ABC-123) or GH-<n> for GitHub issue n" }),
      force: Type.Optional(
        Type.Boolean({ description: "Discard uncommitted changes in the worktree (default false)." }),
      ),
      pr: Type.Optional(
        Type.String({
          description: "PR URL or owner/repo#N whose repository owns the ticket. Defaults to the session's repository.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const result = await removeTicketWorktree(
          host,
          { cwd: ctx.cwd, signal },
          params.ticketId,
          params.force === true,
          params.pr ? parsePrRef(params.pr).repo : undefined,
        );
        return text(
          result.removed
            ? `Removed ticket worktree ${result.state.path} (branch ${result.state.branch} kept). Stale worktree metadata pruned.`
            : `No ticket worktree at ${result.state.path}; stale worktree metadata pruned.`,
        );
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  });

  // --- open_pr --------------------------------------------------------------
  host.registerTool({
    name: "open_pr",
    label: "Open PR",
    description:
      "Open a pull request (draft by default) from a ticket worktree branch. Pushes the branch and returns at once with the PR URL and head; it does NOT wait for CI (use bin/ci-wait.sh in background Bash, or ci_status). Does NOT merge.",
    promptSnippet: "Open a draft PR from the ticket worktree",
    promptGuidelines: ["Use open_pr (not raw gh pr create) when opening a PR for a ticket."],
    parameters: Type.Object({
      ticketId: Type.String({ description: "Ticket key: a Linear identifier (ABC-123) or GH-<n> for GitHub issue n" }),
      title: Type.String({ description: "Full PR title, in the repository's convention." }),
      body: Type.String({ description: "Full PR body (markdown), in the repository's convention and language." }),
      base: Type.Optional(Type.String({ description: "Base branch. Defaults to the repo default branch." })),
      push: Type.Optional(
        Type.Boolean({ description: "Push the worktree branch with -u origin HEAD when it differs from origin (default true)." }),
      ),
      worktree: Type.Optional(
        Type.String({ description: "Absolute ticket worktree path from worktree_ensure. Defaults to the convention path." }),
      ),
      draft: Type.Optional(Type.Boolean({ description: "Open as a draft (default true); `gh pr ready` at Ready." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      try {
        // Boundary: a PR is opened from the dedicated ticket worktree, never the
        // primary checkout. Its HEAD is the commit that must reach CI.
        const identity = await repoIdentity(host, { cwd, signal });
        const expectedWorktree = ticketWorktreePath(identity, params.ticketId);
        if (params.worktree && canonicalPath(params.worktree) !== expectedWorktree) {
          return err(
            `worktree='${params.worktree}' is not the convention path for ${params.ticketId}. Expected ${expectedWorktree}. ` +
              `Call worktree_ensure(ticketId="${params.ticketId}") and pass the path it returns.`,
          );
        }
        const { state: wt } = await requireTicketWorktree(host, { cwd, signal }, params.ticketId, {
          action: "open_pr",
          requireClean: true,
        });
        const repoOpts: ExecOpts = { cwd: wt.path, signal };
        const branch = wt.branch;
        const head = wt.head;

        const remoteHead = (
          await host.exec("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoOpts)
        ).stdout.trim();
        if (params.push !== false) {
          if (remoteHead !== head) {
            const pushRes = await host.exec("git", ["push", "-u", "origin", "HEAD"], {
              ...repoOpts,
              timeout: 60_000,
            });
            if (pushRes.code !== 0) return err(`git push failed: ${pushRes.stderr}`);
            const pushed = (
              await host.exec("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoOpts)
            ).stdout.trim();
            if (pushed !== head) {
              return err(
                `origin/${branch} is ${pushed.slice(0, 12) || "(missing)"} but the ticket worktree HEAD is ${head.slice(0, 12)}. ` +
                  `Push the worktree branch explicitly (git -C ${wt.path} push -u origin HEAD) and retry.`,
              );
            }
          }
        } else if (remoteHead !== head) {
          return err(
            `origin/${branch} is ${remoteHead.slice(0, 12) || "(missing)"} but the ticket worktree HEAD is ${head.slice(0, 12)}. ` +
              `Push it before opening the PR (push=true).`,
          );
        }

        const base = params.base ?? loadConfig(wt.path).base ?? (await defaultBranch(host, repoOpts));
        const title = params.title;
        const body = params.body;

        const dir = mkdtempSync(join(tmpdir(), "pi-rw-"));
        const file = join(dir, "body.md");
        writeFileSync(file, body);
        try {
          const res = await gh(host, repoOpts, [
            "pr",
            "create",
            "--base",
            base,
            "--head",
            branch,
            "--title",
            title,
            "--body-file",
            file,
            ...(params.draft === false ? [] : ["--draft"]),
          ]);
          if (res.code !== 0) return err(`gh pr create failed: ${res.stderr}`);
          const prUrl = res.stdout.trim();
          return {
            content: [
              {
                type: "text",
                text:
                  `Created PR: ${prUrl}\nTitle: ${title}\nBase: ${base} ← ${branch}\n` +
                  `Ticket worktree: ${wt.path} @ ${head.slice(0, 12)}\n` +
                  `Draft: ${params.draft !== false}. Head: ${head}\n\nNext: start CI in background Bash: bin/ci-wait.sh <pr> <owner/repo> ${head}.`,
              },
            ],
            details: { prUrl, head, worktree: wt.path },
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  });

  // --- ci_status ------------------------------------------------------------
  host.registerTool({
    name: "ci_status",
    label: "CI status",
    description:
      "One-shot, non-blocking snapshot of the checks on a PR's current head: pass / fail / pending counts and the failing or pending check names. Never waits; for a wait, run bin/ci-wait.sh with background Bash.",
    promptSnippet: "Snapshot CI on a PR head without waiting",
    parameters: Type.Object({
      pr: Type.String({ description: "PR URL, owner/repo#N, or a bare number in the session's repository." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const opts: ExecOpts = { cwd: ctx.cwd, signal };
        const meta = await prMeta(host, opts, params.pr);
        const res = await gh(host, { ...opts, timeout: 60_000 }, [
          "pr",
          "checks",
          String(meta.number),
          ...prRepoArgs(parsePrRef(params.pr)),
          "--json",
          "bucket,name,state,link",
        ]);
        let checks: Array<{ bucket: string; name: string; state: string; link?: string }> = [];
        if (res.stdout.trim()) checks = JSON.parse(res.stdout);
        else if (res.code !== 0 && !/no checks reported/i.test(res.stderr)) return err(`gh pr checks failed: ${res.stderr.trim()}`);
        const by = (b: string[]) => checks.filter((c) => b.includes(c.bucket));
        const failed = by(["fail", "cancel"]);
        const pending = by(["pending"]);
        const overall =
          checks.length === 0 ? "none" : failed.length ? "failed" : pending.length ? "pending" : "passed";
        return {
          content: [
            {
              type: "text",
              text:
                `PR #${meta.number} head ${meta.headRefOid.slice(0, 12)}: ${overall} ` +
                `(${by(["pass", "skipping"]).length} passed, ${failed.length} failed, ${pending.length} pending)` +
                (failed.length ? `\nFailed: ${failed.map((c) => `${c.name} ${c.link ?? ""}`).join("; ")}` : "") +
                (pending.length ? `\nPending: ${pending.map((c) => c.name).join(", ")}` : ""),
            },
          ],
          details: { head: meta.headRefOid, overall, checks },
        };
      } catch (e) {
        return err(String((e as Error).message ?? e));
      }
    },
  });
}
