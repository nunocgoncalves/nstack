---
name: ship
description: "Take one ticket (a GitHub issue or a Linear issue) from start to merge-ready in a single session: plan, build, prove, open a draft PR, background CI, independent review by a second model (blocking findings must be proven), acceptance check, one summary comment, Ready. After a human merges, clean up. Also resumes an open PR. Use for /ship 12, /ship GH-12, /ship ABC-123, 'ship issue 12', or 'get PR #N ready'."
argument-hint: "<issue number | ABC-123 | PR number>"
---

# Ship

One session owns the ticket until a human merges it. The human touches it at most three times:
starting it, answering a blocking question, merging. Everything else is yours.

## Repository settings

Read the repository's nstack config first (the SessionStart context names it; otherwise
`.nstack/config.json`, or `~/.config/nstack/repos/<owner>/<repo>/config.json`). It sets:

- **tracker**: `github` (the ticket is a GitHub issue; its key is `GH-<n>`) or `linear` (`<PREFIX>-<n>`).
- **base**: the branch PRs target. Unset: the default branch.
- **language**: for commits, PR titles and bodies, and review findings.
- **proof**: how a change proves itself here (a command, a comparison, a table in the PR).
- **data**: private paths. Their content never goes into commits, PR text, issues or comments.
- **review**: backend, model and round limit for `bin/review.ts`.
- **ship.md** next to the config: extra steps for this repository. They override this skill where
  they conflict. Read it now.

No config: GitHub issues, the default branch, English, review by Pi with its default model.

## Rules

- **Proceed on reversible choices; stop only on blocking questions.** A blocking question is an
  architecture decision the repository's docs don't settle, a scope change, or a conflict where
  both sides' intents disagree. Ask it once, with your recommendation, then keep working on what
  it doesn't affect. Answer discoverable questions yourself.
- **Never** merge, approve, push to the base or default branch, force-push someone else's branch,
  or dispatch a release. The `guard-gh` hook blocks most of these; don't look for ways around it.
- **No tool call waits on CI or the reviewer.** Start them with background Bash
  (`run_in_background: true`) and keep working; you are notified when they exit.
- **Work only in the ticket worktree** (`worktree_ensure`), with absolute paths. The primary
  checkout stays on its default branch, read-only. After `worktree_ensure`, move the session there:
  `EnterWorktree path=<worktree>`. Leave with `ExitWorktree action=keep` before `worktree_remove`.
- Branch `<KEY>-<short-description>` (`GH-12-fix-parser`, `ABC-123-add-export`). Commit and PR title
  conventions: follow the repository's history and docs. Write commit messages and PR text to a
  file (`git commit -F`, `--body-file`).
- **Bring the base in by merging** (`git merge origin/<base>`), never rebase. Regenerate generated
  files instead of hand-merging them.
- Post to the PR only: the draft body, review rounds when the config posts them, at most one reply
  per human comment, and **one** summary comment at Ready.

## Plugin pieces

| Piece | Use |
| --- | --- |
| `worktree_ensure`, `worktree_remove`, `open_pr`, `ci_status` | the `review` MCP server. `open_pr` pushes and opens a draft PR at once; `ci_status` is a snapshot |
| `${CLAUDE_PLUGIN_ROOT}/bin/ci-wait.sh <pr> <owner/repo> <head>` | background CI wait. 0 pass, 1 failed, 2 head moved or no checks, 3 timeout |
| `${CLAUDE_PLUGIN_ROOT}/bin/review.ts --pr <n>` | background independent review. 0 done (verdict inside), 1 usage, 2 reviewer failed, 3 round limit |
| `${CLAUDE_PLUGIN_ROOT}/bin/pr-wait.sh <pr> <owner/repo>` | background wait after Ready. 0 merged, 1 closed, 4 ejected from the merge queue, 5 unreadable |

## Workflow

### 1. Resolve

- **GitHub tracker:** `gh issue view <n> --json number,title,body,comments`. Key `GH-<n>`.
- **Linear tracker:** fetch the issue with the Linear tools you have (description, relations,
  comments). Save its description to `~/.local/state/nstack/tickets/<KEY>.md`; the reviewer gets it
  through `--spec`.
- A PR number: take the key from its branch, `worktree_ensure`, `EnterWorktree`, and go to step 4.
- Read the repository's `AGENTS.md`/`CLAUDE.md` and the docs the ticket links.

### 2. Plan and build

- `worktree_ensure ticketId=<KEY> branch=<KEY>-<desc>` (its base defaults to the config's), then
  `EnterWorktree path=<worktree>`. Linear: move the issue to In Progress.
- Map each acceptance criterion to the change and the evidence that will show it. Write a short
  plan in the session.
- Build the smallest change that meets the ticket, with tests.

### 3. Prove it locally

Formatter, lint and type checks first, then the tests, then the repository's **proof**. Fix
failures before opening the PR. Any validation you couldn't run: say which and why.

### 4. Open (or refresh) the PR

- New PR: `open_pr` with `draft=true`, a title in the repository's convention, and a body in its
  language with: what changed and why, the proof (output, comparison or table the config asks for),
  what you could not validate, and the closing line (`Closes #<n>` for GitHub issues).
  Keep private data out of it: counts, file ids and synthetic examples only.
- Existing PR: `git fetch origin && git merge origin/<base>`, re-run step 3, push.
- Start CI in the background (`ci-wait.sh`) and the review (step 5) at the same time.

### 5. Independent review (the config's round limit, 3 by default)

Run in the background from the worktree:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/review.ts --pr <n> [--spec ~/.local/state/nstack/tickets/<KEY>.md]
```

Blocking findings arrive with proof: a command the reviewer ran that exits non-zero because of
the defect (re-run by the tool), or a quote for a leak or an unmet criterion. The reviewer's repro
files are in `round-<k>.proof.patch` next to the round's JSON; apply it in a scratch copy to see
them.

When it finishes:

- **blocking**: reproduce it (`git apply` the patch in a scratch copy and run the command), fix,
  re-prove, commit, push, restart CI. Then run the next round.
- **should-fix**: fix it when it is a real defect in your change. Otherwise decline it: write
  `round-<k>.declined.json` next to the round (`[{"id": "F2", "reason": "…"}]`). The next round
  gets your reasons and accepts them unless it can prove the finding blocking.
- **nit**: don't fix by hand. Add the proposed lint rule when it is cheap and in scope; otherwise
  list it in the summary.
- **Every fix gets reviewed.** Review is done when a round on the current head has no blocking
  finding and every should-fix is fixed or declined. After that clean round, only base merges and
  regenerated files may land without another round.
- Exit 3 (round limit) or blocking findings left on the last round: stop and ask the human, with
  the findings and your recommendation. Don't go Ready without that answer.
- Exit 2: retry once; if it fails again, say so in the summary and continue.

### 6. CI

When `ci-wait.sh` exits non-zero: read the failing log (`gh run view <id> --log-failed`), fix, push,
restart the wait. A flaky infrastructure failure gets one rerun (`gh run rerun <id> --failed`); a
second failure is real. Exit 2 (head moved): restart the wait on the new head.

### 7. Ready

When CI is green on the final head and its review round is clean:

1. `git fetch origin`; if the base moved, merge it in, re-prove and wait for CI again.
2. Check every acceptance criterion against the diff and the evidence. An unmet criterion is
   fixed or becomes a blocking question; never hand it over silently.
3. Post **one** summary comment (`gh pr comment <n> --body-file <file>`): acceptance criteria with
   evidence, review rounds and how each finding was handled (fixed, declined and why), proposed
   lint rules, the proof, anything left for the human.
4. `gh pr ready <n>`. Linear: move the issue to In Review.
5. Push notification: `Ready to merge: <KEY> — <PR URL>`.
6. Start `pr-wait.sh <n> <owner/repo>` in the background.

### 8. After merge (pr-wait exit 0)

`ExitWorktree action=keep`, then `worktree_remove ticketId=<KEY>`. Linear: make sure the issue is
Done. Report one line and end.

**Ejected from the merge queue (exit 4)** or new human comments: go to step 4, run a review round
on any code fix (a base merge alone needs none), then step 7 again. **Closed (exit 1):** report and
stop. **Unreadable (exit 5):** check the PR yourself; merged → step 8, otherwise restart the wait.

## Completion

The session ends after step 8, or at a blocking question (asked once). The final message names
the PR and its merge commit.
