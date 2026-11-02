/**
 * End-to-end boundary tests for the ticket worktree convention. These use a
 * scratch origin + clone and real git so the invariants (primary-checkout
 * refusal, branch ownership, cleanliness, exact head, removal) are verified
 * against git's own behavior rather than mocks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "../lib/host.ts";
import {
  ensureTicketWorktree,
  inspectWorktree,
  removeTicketWorktree,
  repoIdentity,
  repoIdentityFor,
  requireTicketWorktree,
  ticketWorktreePath,
} from "./worktrees.ts";

interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

const fakeHost = {
  exec: async (cmd: string, args: string[], opts?: ExecOptions) => {
    const res = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
    return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  },
} as unknown as Host;

const opts = (cwd: string) => ({ cwd } as { cwd: string; signal?: AbortSignal });

function git(args: string[], cwd: string): { code: number; stdout: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: (res.stdout ?? "").trim() };
}

let sandbox = "";
let primary = "";
let overlay = "";
let worktreeRoot = "";
let savedRoot: string | undefined;

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-it-")));
  worktreeRoot = join(sandbox, "worktrees");
  savedRoot = process.env.NSTACK_WORKTREE_ROOT;
  process.env.NSTACK_WORKTREE_ROOT = worktreeRoot;

  const origin = join(sandbox, "origin.git");
  git(["init", "--bare", "--initial-branch=master", origin], sandbox);

  primary = join(sandbox, "mono");
  git(["clone", origin, "mono"], sandbox);
  git(["config", "user.email", "test@example.com"], primary);
  git(["config", "user.name", "Test"], primary);
  writeFileSync(join(primary, "README.md"), "hello\n");
  git(["add", "-A"], primary);
  git(["commit", "-m", "init"], primary);
  git(["push", "-u", "origin", "master"], primary);
  // GitHub identities for PR-repository resolution; never fetched.
  git(["remote", "add", "github", "https://github.com/acme/mono.git"], primary);

  // A second repository checked out as a sibling of the session's primary checkout.
  const overlayOrigin = join(sandbox, "overlay.git");
  git(["init", "--bare", "--initial-branch=master", overlayOrigin], sandbox);
  overlay = join(sandbox, "overlay");
  git(["clone", overlayOrigin, "overlay"], sandbox);
  git(["config", "user.email", "test@example.com"], overlay);
  git(["config", "user.name", "Test"], overlay);
  writeFileSync(join(overlay, "README.md"), "overlay\n");
  git(["add", "-A"], overlay);
  git(["commit", "-m", "init"], overlay);
  git(["push", "-u", "origin", "master"], overlay);
  git(["remote", "add", "github", "git@github.com:acme/overlay.git"], overlay);
});

afterAll(() => {
  if (savedRoot === undefined) delete process.env.NSTACK_WORKTREE_ROOT;
  else process.env.NSTACK_WORKTREE_ROOT = savedRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("ticket worktree boundary", () => {
  test("identifies the primary checkout vs a linked worktree", async () => {
    const identity = await repoIdentity(fakeHost, opts(primary));
    expect(identity.isPrimaryCheckout).toBe(true);
    expect(identity.repo).toBe("mono");

    const created = await ensureTicketWorktree(fakeHost, opts(primary), "abc-1", "ABC-1-first-change");
    expect(created.created).toBe(true);
    expect(created.state.path).toBe(ticketWorktreePath(identity, "ABC-1"));
    expect(created.state.path.startsWith(worktreeRoot)).toBe(true);
    expect(created.state.linked).toBe(true);
    expect(created.state.branch).toBe("ABC-1-first-change");
    expect(created.state.clean).toBe(true);

    const inside = await repoIdentity(fakeHost, opts(created.state.path));
    expect(inside.isPrimaryCheckout).toBe(false);
    expect(inside.primaryRoot).toBe(primary);

    // Idempotent reuse: never resets the worktree or its branch.
    const reused = await ensureTicketWorktree(fakeHost, opts(primary), "ABC-1");
    expect(reused.created).toBe(false);
    expect(reused.state.branch).toBe("ABC-1-first-change");
  });

  test("git itself keeps the ticket branch out of the primary checkout", async () => {
    const switched = git(["switch", "ABC-1-first-change"], primary);
    expect(switched.code).not.toBe(0);
  });

  test("refuses a dirty worktree and an unexpected HEAD", async () => {
    const state = await inspectWorktree(fakeHost, opts(primary), await repoIdentity(fakeHost, opts(primary)), "ABC-1");

    await expect(
      requireTicketWorktree(fakeHost, opts(primary), "ABC-1", { action: "open_pr", requireHead: "0".repeat(40) }),
    ).rejects.toThrow(/is not the expected commit/);

    writeFileSync(join(state.path, "scratch.txt"), "uncommitted\n");
    await expect(
      requireTicketWorktree(fakeHost, opts(primary), "ABC-1", { action: "open_pr" }),
    ).rejects.toThrow(/uncommitted changes/);

    // force only discards on explicit removal; the gate never does.
    await expect(removeTicketWorktree(fakeHost, opts(primary), "ABC-1")).rejects.toThrow(/Refusing to remove/);
    const forced = await removeTicketWorktree(fakeHost, opts(primary), "ABC-1", true);
    expect(forced.removed).toBe(true);

    const cleared = await ensureTicketWorktree(fakeHost, opts(primary), "ABC-1", "ABC-1-first-change");
    expect(cleared.state.clean).toBe(true);
  });

  test("refuses to steal a branch that is checked out in the primary checkout", async () => {
    expect(git(["switch", "-c", "ABC-9-primary-held"], primary).code).toBe(0);
    await expect(
      ensureTicketWorktree(fakeHost, opts(primary), "ABC-9"),
    ).rejects.toThrow(/primary checkout.*switch master/s);
    git(["switch", "master"], primary);
  });

  test("refuses a branch that does not match the ticket", async () => {
    await expect(
      ensureTicketWorktree(fakeHost, opts(primary), "ABC-9", "ABC-1-first-change"),
    ).rejects.toThrow(/does not match ticket ABC-9/);
  });

  test("reports a missing worktree with the convention path", async () => {
    await expect(
      requireTicketWorktree(fakeHost, opts(primary), "ABC-42", { action: "review_post_reply" }),
    ).rejects.toThrow(/no ticket worktree exists.*worktree_ensure/s);
  });

  test("removal is idempotent, survives read-only tool downloads, and prunes metadata", async () => {
    // envtest-style downloads: ignored, inside a read-only directory.
    const wt = ticketWorktreePath(await repoIdentity(fakeHost, opts(primary)), "ABC-1");
    appendFileSync(join(primary, ".git", "info", "exclude"), "bin/\n");
    mkdirSync(join(wt, "bin", "k8s"), { recursive: true });
    writeFileSync(join(wt, "bin", "k8s", "etcd"), "binary\n");
    chmodSync(join(wt, "bin", "k8s", "etcd"), 0o555);
    chmodSync(join(wt, "bin", "k8s"), 0o555);
    const removed = await removeTicketWorktree(fakeHost, opts(primary), "ABC-1");
    expect(removed.removed).toBe(true);
    const again = await removeTicketWorktree(fakeHost, opts(primary), "ABC-1");
    expect(again.removed).toBe(false);
    expect(git(["worktree", "list"], primary).stdout).not.toContain("ABC-1");
  });
});

describe("ticket worktrees follow the PR's repository", () => {
  test("resolves the session repository or its GitHub sibling, never silently the session's", async () => {
    const own = await repoIdentityFor(fakeHost, opts(primary), "Acme/Mono");
    expect(own.primaryRoot).toBe(primary);
    expect((await repoIdentityFor(fakeHost, opts(primary))).primaryRoot).toBe(primary);

    const other = await repoIdentityFor(fakeHost, opts(primary), "acme/overlay");
    expect(other.primaryRoot).toBe(overlay);
    expect(other.repo).toBe("overlay");

    await expect(repoIdentityFor(fakeHost, opts(primary), "acme/missing")).rejects.toThrow(
      /belongs to acme\/missing.*no checkout of it exists/s,
    );
    await expect(repoIdentityFor(fakeHost, opts(primary), "someone-else/overlay")).rejects.toThrow(
      /has no remote for github.com\/someone-else\/overlay/,
    );
  });

  test("ensure, gate, and remove act on <root>/<pr-repo>/<TICKET> from the session's checkout", async () => {
    const created = await ensureTicketWorktree(
      fakeHost,
      opts(primary),
      "ABC-645",
      "ABC-645-overlay-change",
      undefined,
      "acme/overlay",
    );
    expect(created.created).toBe(true);
    expect(created.identity.primaryRoot).toBe(overlay);
    expect(created.state.path).toBe(join(worktreeRoot, "overlay", "ABC-645"));
    expect(created.state.linked).toBe(true);
    expect(git(["worktree", "list"], primary).stdout).not.toContain("ABC-645");

    const gated = await requireTicketWorktree(
      fakeHost,
      opts(primary),
      "ABC-645",
      { action: "review_post_reply", requireHead: created.state.head },
      "acme/overlay",
    );
    expect(gated.state.path).toBe(created.state.path);

    // Without the PR's repository the gate looks in the session's repository.
    await expect(
      requireTicketWorktree(fakeHost, opts(primary), "ABC-645", { action: "review_post_reply" }),
    ).rejects.toThrow(/no ticket worktree exists at .*mono\/ABC-645/);

    const removed = await removeTicketWorktree(fakeHost, opts(primary), "ABC-645", false, "acme/overlay");
    expect(removed.removed).toBe(true);
    expect(git(["worktree", "list"], overlay).stdout).not.toContain("ABC-645");
  });
});
