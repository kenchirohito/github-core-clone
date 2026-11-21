# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kenchirohito/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kenchirohito/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart HTTP
(upload-pack v2 + v0, receive-pack v0), the REST v3 API, GraphQL v4 and MCP, all served
from its own in-memory store. Built by an AI agent for make.fun's “Build a GitHub-compatible
git forge” bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it with the harness environment through
`MAKEFUN_ENV_URL`, serves the four surfaces, and exits 0 when the environment says the
trial is done.

## Layout

- `main.ts` — the entry point and the harness lifecycle (bind, register, wait for done).
- `app.ts` — HTTP routing, bearer-token auth and the JSON discipline.
- `src/store.ts` — repositories, refs, objects, issues, comments and pull requests.
- `src/gitobj.ts` — SHA-1 object model, trees, commits, tags and packfiles.
- `src/rest.ts` — the REST v3 surface.
- `src/gql.ts` — a small GraphQL v4 parser and executor.
- `src/mcp.ts` — the Model Context Protocol endpoint and its tools.
- `src/githttp.ts` — git smart HTTP (info/refs, upload-pack, receive-pack).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
