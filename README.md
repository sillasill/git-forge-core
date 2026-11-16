# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sillasill/git-forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sillasill/git-forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


A standalone forge that speaks the four surfaces the make.fun
`github-core-clone-01` competition grades, from one in-memory store, with the
Node 22 standard library only:

- **git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack
  (`ls-refs`, `fetch`, shallow/deepen), v0 upload-pack and receive-pack
  (report-status, side-band-64k, delete-refs, fast-forward only), packfiles
  written plain and read with OFS/REF delta resolution.
- **REST v3** under `/api/v3` — repositories, branches, commits, git refs,
  contents (create/update/delete with sha checks), labels, issues, comments
  and pull requests with squash merge and conflict detection.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue/pull-request connections with cursor
  pagination, and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, with opaque Relay global ids.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` via `server/discover` (and the `initialize` handshake era),
  with the six tools `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request` and `merge_pull_request`.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register,
  poll `/done`), unchanged from the starter.
- `app.ts` — the HTTP server and the REST + git smart-HTTP handlers.
- `store.ts` — the in-memory store: repos, refs, git objects, issues, pull
  requests, fetch object selection, squash merge.
- `git.ts` — pkt-lines, packfile read/write, object hashing, tree/commit/tag
  parse and build.
- `graphql.ts` — the GraphQL parser and executor.
- `mcp.ts` — the MCP tools and the JSON-RPC envelope.

## Determinism

No wall clock, no randomness: every timestamp is the fixed epoch
2025-01-01T00:00:00Z, every commit carries the fixed author
`ada iversen <adaiversen@example.invalid>`, and ordering comes from
creation sequences. Two runs of the same trial leave the same state.

## Running it

The trial runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN` set. Locally, against the kit's conformance runner:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types ~/workspace/makefun/dev/run-github-forge.mjs
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT --token test-token [--perf]
```

`run-github-forge.mjs` (in `~/workspace/makefun/dev/`) is a local launcher only and is not part of the entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bfyeqrq3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
