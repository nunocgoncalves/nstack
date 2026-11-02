# nstack

A Claude Code plugin that takes one ticket to a merge-ready pull request in a single session, and
has a second model review it, with one rule: **a blocking finding must be proven**.

Reviews by a second model catch real bugs, and a lot of noise with them: edge cases no input
reaches, hardening of a debug log, "consider" findings. Each one costs a round. nstack's reviewer
works in its own sandboxed copy of the repository and may run code there. A finding blocks only
when the reviewer shows a command that fails because of the defect. nstack re-runs that command
after the review, or the finding is downgraded. A leak or an unmet acceptance criterion is proven
by quoting it. Everything else is should-fix at most, and the author can decline it with a reason.

## What's in it

| Piece | What |
| --- | --- |
| `/nstack:ship` | ticket → plan → build → prove → draft PR → CI and review in the background → Ready. A human merges |
| `bin/review.ts` | the independent review: Pi, Claude Code or Codex in a macOS sandbox, proof-gated |
| `review/rubric.md` | the base rubric; each repository appends its own section |
| `servers/review` | MCP: one git worktree per ticket, draft PR opening, CI snapshot |
| `bin/ci-wait.sh`, `bin/pr-wait.sh` | background waits for CI and for the merge |
| `hooks/guard-gh.ts` | blocks agent merges, approvals, releases and `gh api` writes |
| `hooks/context.ts` | keeps the primary checkout current and tells each session its repository's settings |
| `/nstack:grill-me` | interview you about a plan until every decision is explicit |

## Install

```text
/plugin marketplace add nunocgoncalves/nstack
/plugin install nstack@nstack
```

Needs Node ≥ 23.6, an authenticated `gh`, and at least one reviewer CLI: [Pi](https://github.com/badlogic/pi-mono)
(default, with `openai-codex` signed in), `claude` or `codex`. The review sandbox uses macOS
`sandbox-exec`; elsewhere it refuses to run unless `NSTACK_REVIEW_UNSANDBOXED=1`.

## Configure a repository

Add `.nstack/config.json` to the repository, or keep it outside at
`~/.config/nstack/repos/<owner>/<repo>/config.json`, or once for every repository of an owner at
`~/.config/nstack/repos/<owner>/config.json` (first found wins, in that order). Every field is
optional:

```json
{
  "tracker": "github",
  "base": "dev",
  "language": "English",
  "proof": "Tests pass and the e2e comparison is in the PR body.",
  "data": ["fixtures/customer/", "exports/"],
  "review": {
    "backend": "pi",
    "model": "openai-codex/gpt-6.1-sol",
    "maxRounds": 3,
    "run": true,
    "readPaths": [".venv"],
    "post": "comment"
  }
}
```

| Field | Meaning |
| --- | --- |
| `tracker` | `github` (tickets are issues, keys `GH-<n>`) or `linear` (with `ticketPrefix`, keys `ABC-<n>`) |
| `base` | the branch PRs target; default: the repository's default branch |
| `language` | commits, PR text and review findings |
| `proof` | how a change proves itself here; the author and the reviewer both see it |
| `data` | path prefixes whose content never reaches the reviewer, commits or PR text |
| `review.backend` | `pi`, `claude` or `codex` |
| `review.run` | the reviewer may run commands in its copy (needed for run proofs) |
| `review.readPaths` | extra folders the sandboxed reviewer may read, such as a virtualenv |
| `review.post` | `comment` posts each round on the PR; `none` keeps rounds for the ship summary |

Next to `config.json`, these files are picked up when present:

- `context.md`: injected into every session in the repository;
- `rubric.md`: the repository's section of the review rubric (domain rules, what counts as proof);
- `ship.md`: extra ship steps (CI labels, release notes, conventions).

See [`examples/`](examples/).

## Review by hand

```sh
node ~/.claude/plugins/…/nstack/bin/review.ts --pr 42            # next round
node …/bin/review.ts --pr 42 --spec ticket.md --no-post         # with a Linear ticket, kept local
```

Rounds are saved under `~/.local/state/nstack/review/<owner>/<repo>/pr-<n>/`: the request sent,
the reply, the comment, and `round-<k>.proof.patch` with the reviewer's repro files. To decline a
should-fix, write `round-<k>.declined.json` there (`[{"id": "F2", "reason": "…"}]`); the next round
gets it.

### What the reviewer can see

The PR head exported with `git archive` (nothing gitignored, no `.git`), minus `data` paths,
binaries and files over 300 KB. They are named to it, never sent. Inside the sandbox it can read
that copy, its own installation and `readPaths`; nothing else under your home folder, the temp
folders or external volumes. It writes only in its copy. The network stays open, since the model is
remote. A reply containing the backend's credentials is never saved or posted.

## Tests

```sh
npm test
```

## Credits

The "prove it or drop it" rule is borrowed from the `interrogate` skill in Lauren Tan's
[pstack](https://github.com/cursor/plugins/tree/main/pstack).

## License

MIT
