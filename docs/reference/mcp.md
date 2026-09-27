---
title: MCP
---

`chronos mcp <folder> [--allow-merge | --agent NAME] [-b branch]`

Serves a database folder to an AI agent as MCP tools, over stdio. Why worlds work the way they do: [concepts](../concepts.md#worlds). Who may do what: [security](../security.md).

```bash
claude mcp add chronos -- chronos mcp /path/to/mydb
```

## Modes

| Command | Acts as | Tools listed | Changes |
|---|---|---|---|
| `chronos mcp mydb` | [safe mode](#safe-mode) (the default) | 17: all but `merge`, `restore`, `undo_merge` | only worlds forked in this session |
| `chronos mcp mydb --agent bot` | the agent `bot` | those `bot` has the rights for ([below](#as-an-agent)) | what `bot` may change; its forks stay its own across sessions |
| `chronos mcp mydb --allow-merge` | the database's own user | all 20 | everything |

- **`--agent` wins:** with both `--agent` and `--allow-merge`, the session acts as the agent.
- **`--agent` takes a name, not a token:** an unknown or disabled agent is refused at start (`chronos: ...`, exit 1). Anyone who can run `chronos mcp` on the folder can name any agent; see [security](../security.md).
- **`-b branch`:** the branch must exist or the command exits 1. Tools don't use it: each call names its own `branch` (default `main`).
- **The folder already open:** if `chronos serve`, the shell or another `chronos mcp` has the folder open, `chronos mcp` joins that process over its Unix socket and gets the same modes. `--token`, `--safe` and `--admin-token` don't apply to it.

## Adding it to a client

Claude Code:

```bash
claude mcp add chronos -- chronos mcp /path/to/mydb
claude mcp add chronos -- chronos mcp /path/to/mydb --agent bot
```

Any client that starts stdio servers from a JSON config (`mcpServers`):

```json
{
  "mcpServers": {
    "chronos": { "command": "chronos", "args": ["mcp", "/path/to/mydb"] }
  }
}
```

Use an absolute folder path: the client picks the working directory.

## Protocol

- **Transport:** stdio, JSON-RPC 2.0, one message per line. stdout carries only protocol messages; blank lines are skipped.
- **Protocol version:** the server answers `initialize` with the client's `protocolVersion`, or `2025-06-18` if it sends none.
- **Capabilities:** `tools` only. No resources, no prompts.
- **Methods:** `initialize`, `ping` (replies `{}`), `tools/list`, `tools/call`. A message without an `id` (a notification such as `notifications/initialized`) gets no reply.
- **Server info:** `{"name": "chronos", "version": "<chronos version>"}`, plus `instructions` that teach the workflow: `describe`, `fork`, change your branch, `diff`, then `merge` or `discard`. In safe mode and for `--agent`, the instructions say a person merges with `chronos <database folder> merge <branch>`, and to report the branch name.
- **State:** none between calls, except the worlds a safe-mode session forked. Each `sql` call is its own session: a transaction must `BEGIN` and `COMMIT` within one call.

## Errors

A tool that fails replies with a normal result, `isError: true`, and a message saying how to fix the call:

```json
{"jsonrpc":"2.0","id":8,"result":{"content":[{"type":"text","text":"'id' is required: a non-empty string without spaces"}],"isError":true}}
```

Refusals (safe mode, an agent's rights), unknown tools (`unknown tool 'x'; see tools/list`), SQL errors and merge conflicts all come back this way. Protocol errors use JSON-RPC `error`:

| Code | When |
|---|---|
| -32700 | the line isn't JSON (`id` is null) |
| -32601 | unknown method, `resources/list` and `prompts/list` included |

- **Names:** `table`, `id`, `name`, `branch` (where required) and `world` must be non-empty strings without spaces.
- **Results** are text: the shell's output for the same command, SQL results as a psql-style table (` name\n--------\n Ada L.\n(1 row)`).

## Tools

Every tool that reads or writes rows takes `branch` (string, default `main`). A branch as it was, `name@when`, works wherever a branch is read (see [worlds](worlds.md#names-and-moments)).

| Tool | Does | Safe mode |
|---|---|---|
| [`describe`](#describe) | tables, fields, a sample row | yes |
| [`find`](#find) | filter, text and vector search | yes |
| [`sql`](#sql) | run SQL | reads; writes on its own worlds |
| [`get`](#get) | read one row | yes |
| [`put`](#put) | create or replace one row | on its own worlds |
| [`delete`](#delete) | delete one row | on its own worlds |
| [`fork`](#fork) | create a branch | yes |
| [`set_meta`](#set_meta) | set a branch's notes | on its own worlds |
| [`branches`](#branches) | list branches | yes |
| [`diff`](#diff) | what changed | yes |
| [`history`](#history) | recent events of a branch | yes |
| [`restore`](#restore) | put a branch back to a moment | not listed |
| [`merge`](#merge) | apply a branch to its parent | not listed |
| [`merge_preview`](#merge_preview) | what a merge would do | yes |
| [`undo_merge`](#undo_merge) | undo a branch's latest merge | not listed |
| [`checkpoint`](#checkpoint) | name a moment of a branch | on its own worlds |
| [`rollback`](#rollback) | go back to a checkpoint | on its own worlds |
| [`discard`](#discard) | throw a branch away | on its own worlds |
| [`simulate`](#simulate) | fork, run and score many worlds | yes; kept worlds are its own |
| [`replay`](#replay) | re-run a simulated world | yes |

### describe

Tables with row counts, their fields with types and example or allowed values, and a sample row. Call first.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `table` | string | no | all tables |
| `branch` | string | no | `main` |

### find

Exact filters, plus optional text search (BM25) and/or vector similarity, best first. Returns the match count (`1 match`, `3 matches`), then up to `limit` rows with scores. With neither `text` nor `vector`, lists matching rows in key order. See [search](../search.md).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `table` | string | yes | |
| `where` | object | no | none; `{"field": value, ...}`, all must match |
| `text` | string | no | words to find in the rows' string fields |
| `vector` | array of numbers | with `vector_field` | ranks by dot product |
| `vector_field` | string | with `vector` | the field holding stored vectors |
| `limit` | integer | no | 20 |
| `offset` | integer | no | 0 |
| `ef` | integer | no | 0: chosen automatically; the vector graph's beam |
| `branch` | string | no | `main` |

`vector` without `vector_field` (or the reverse) fails: `give both 'vector' and 'vector_field' ...`.

### sql

Runs SQL on a branch, as its own session. `$1`, `$2`, ... take `params`. See [SQL](../sql.md) and [worlds](worlds.md).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `sql` | string | yes | one or more statements; `BEGIN ... COMMIT` within the call |
| `params` | array | no | none; JSON values for `$1`, `$2`, ... |
| `branch` | string | no | `main` |

Returns each result as a table, or a statement's tag.

### get

Reads one row.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `table` | string | yes | |
| `id` | string | yes | |
| `branch` | string | no | `main` |

### put

Creates or replaces one row (the whole row).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `table` | string | yes | |
| `id` | string | yes | |
| `record` | object | yes | the row as a JSON object |
| `branch` | string | no | `main` |

### delete

Deletes one row.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `table` | string | yes | |
| `id` | string | yes | |
| `branch` | string | no | `main` |

### fork

Creates a branch: an instant private copy. In safe mode it becomes one of the session's own worlds.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `name` | string | yes | e.g. your task id |
| `from` | string | no | `main`; a branch, or `name@when` |
| `meta` | object | no | none; notes, e.g. `{"owner": "you", "task": "..."}` |

Returns `created branch task-1 (world id <id>) from main; pass branch="task-1" to work on it`.

### set_meta

Merges a JSON object into a branch's metadata; a `null` value removes a key. Returns `<branch>: <metadata>`.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `meta` | object | yes | |

### branches

Lists branches with their parent and number of changes. No parameters.

### diff

What changed on a branch since it was forked, row by row and field by field: the count first, then a page of changes.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `to` | string | no | none: compare with the fork point. Else from `branch` to `to`; either can be `name@when` |
| `as_sql` | boolean | no | `false`; `true`: the change as SQL statements (`INSERT`, `UPDATE`, `DELETE`, `CREATE`/`ALTER TABLE`) |
| `limit` | integer | no | 20 |
| `offset` | integer | no | 0 |

Without `to`: `2 changes on task-1`, then one line per change, `+ table/id  {row}`, `- table/id`, or `~ table/id  field: old -> new`. With `to`, the table from [`DIFF ... TO`](worlds.md#diff). A longer diff ends with `(showing changes 1-20 of 57; call diff again with offset=20 for the next ones)`.

### history

What happened to a branch recently, newest first: forks, writes, commits, merges. Runs [`SHOW HISTORY`](worlds.md#show-history).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `limit` | integer | no | 30 |

### restore

Puts a branch back as it was at a moment, as an ordinary write. Runs [`RESTORE WORLD`](worlds.md#restore-world).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `at` | string | yes | a time (`2026-09-20 10:00`) or a time ago (`-10 minutes`) |

### merge

Applies a branch's changes to its parent and deletes the branch. If rows both sides changed, nothing is merged and the conflicts come back (`isError: true`), with a hint naming `resolve`, `by_columns`, `rows` and `merge_preview`. With `only_tables`, `only_keys` or `into`, just those rows merge (or go to another branch) and the branch stays. See [MERGE](worlds.md#merge).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `into` | string | no | the parent; another branch to merge into (the branch stays) |
| `only_tables` | array of strings | no | all tables; non-empty (the branch stays with the rest) |
| `only_keys` | array of strings | no | all rows; `"table/id"`, non-empty (the branch stays with the rest) |
| `by_columns` | boolean | no | `false`; `true`: only a column both sides changed conflicts |
| `rows` | object | no | none; `{"table/id": "ours" \| "theirs" \| "delete" \| {row to keep}}` |
| `resolve` | string | no | `fail`; `ours` (this branch's values) or `theirs` (the parent's) |
| `confirm` | boolean | no | `false`; after a crash, merge the flagged branch as it is now (check its `diff` first) |

Returns `merged 1 change from task-1 into main`. `confirm` applies to a plain merge only: it's ignored when `into`, `only_tables`, `only_keys`, `by_columns` or `rows` is given.

### merge_preview

What `merge` would do with the same parameters, without doing it: per row, whether it applies or conflicts and why, with the fork point's, the branch's and the parent's versions. Runs [`MERGE ... DRY RUN`](worlds.md#merge-dry-run); its columns are `table`, `id`, `outcome`, `detail`, `base`, `ours`, `theirs`, `result`.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `into`, `only_tables`, `only_keys`, `by_columns`, `resolve`, `rows` | | no | as for [`merge`](#merge) |
| `limit` | integer | no | 20 |
| `offset` | integer | no | 0 |

### undo_merge

Puts back, in the parent, every row the branch's latest merge changed. Refuses if some were changed since, naming them. Runs [`UNDO MERGE`](worlds.md#undo-merge).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | the merged branch (it's gone; its name still works) |
| `skip_changed` | boolean | no | `false`; `true` leaves rows changed since the merge alone |

### checkpoint

Names this moment of a branch. Runs [`CHECKPOINT WORLD`](worlds.md#checkpoint-world).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `name` | string | yes | e.g. `before-migration` |

### rollback

Puts a branch back as it was at one of its checkpoints, as an ordinary write (its history keeps the rest).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `checkpoint` | string | yes | a name given to `checkpoint` |

### discard

Throws a branch and its changes away.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `branch` | string | yes | |
| `cascade` | boolean | no | `false`; `true` also discards every branch forked from it, and from those |

### simulate

Forks `worlds` branches from one moment of `from`, runs `script` in each in parallel (`$1` is the world's index 0, 1, ..., `$2` its seed), scores each with `score`, keeps the best `keep` and discards the rest. `random()` is seeded per world, so the same call gives the same worlds. Kept worlds are the session's own. See [`SIMULATE`](worlds.md#simulate).

| Parameter | Type | Required | Default |
|---|---|---|---|
| `worlds` | integer | yes | more than 0 |
| `prefix` | string | yes | world `i` is named `<prefix>_<i>` |
| `script` | string | yes | SQL run in each world |
| `score` | string | yes | a `SELECT` giving one number per world |
| `from` | string | no | `main`; or `name@when` |
| `keep` | integer or `"all"` | no | all |
| `order` | string | no | `desc` (highest score best); or `asc` |
| `seed` | integer | no | 0 |
| `threads` | integer | no | 0: all free cores |

Returns `<n> worlds from <base> in <ms> ms, best first; <f> failed; kept: <names>`, then up to 20 lines `<name> (index <i>): score <s>[, kept]` (or `failed: <why>`), then `(<n> more)`.

### replay

Makes a simulated world again from its recorded inputs and says whether it comes out identical, rows and score.

| Parameter | Type | Required | Default |
|---|---|---|---|
| `world` | string | yes | a world a simulation kept |
| `as` | string | no | none; keep the replay under this name |

Returns `<world>: identical (0 rows differ; score <s> now, <s> recorded)`, with `; failed: <why>` and `; kept as <name>` when they apply.

## Safe mode

The default, without `--allow-merge` or `--agent`. The agent reads every world and forks; a person approves.

- **Not listed, and refused if called:** `merge`, `restore`, `undo_merge` (`safe mode: agents can't merge. A person reviews your diff and runs ...`).
- **Writes need one of its own worlds:** `put`, `delete`, `set_meta`, `discard`, `checkpoint`, `rollback`, and `sql` that writes (`BEGIN`/`COMMIT`, `EXPLAIN ANALYZE` of a write, and a `SELECT` calling a function that writes included) need `branch` set to a world forked in this session (by `fork`, or kept by `simulate` or `replay`). No `branch`: `safe mode: changes need branch="<a branch you forked>". Call fork first`. `main` or another world: `... and 'main' isn't one`.
- **`discard` with `cascade`:** refused if any world forked from it wasn't forked in this session.
- **World statements in `sql`** are refused on any branch: forking, merging, restoring, dropping or switching worlds, and changing system settings (`safe mode: agents can't fork, merge, restore, drop or switch worlds in SQL, ...`). Reads such as `SHOW WORLDS`, `DIFF`, `MERGE ... DRY RUN` and `AS OF` work. Use the `fork` tool to fork.
- **Session-scoped:** "its own worlds" lasts as long as the process. A new `chronos mcp` can't change worlds an earlier one forked; use `--agent` for forks that stay the agent's.
- **Merging:** a person runs `chronos <folder> merge <branch>` in a terminal, or `MERGE WORLD` from psql.
- **Not the same as `chronos serve --safe`:** that makes HTTP and Postgres clients without an agent's token act as the agent `guest` (see [HTTP API](../http-api.md#auth-and-exposure)). It doesn't change `chronos mcp`.

### As an agent

With `--agent NAME`, each call is checked against that agent's rights and quotas (see [concepts](../concepts.md#agents)), and what it writes is in the audit trail. Tools it can't use aren't listed:

| Tool | Listed when the agent has |
|---|---|
| `merge` | `merge` or `merge_own` |
| `restore`, `rollback` | `restore` |
| `undo_merge` | `admin`, or `restore` and `merge` |

- **Checked per call:** `put` and `delete` as writes to `branch`; `merge` as a merge of `branch` (or into `into`); `restore`; `set_meta` and `discard` as managing that world (`cascade`: its whole tree); `sql`, `checkpoint`, `rollback` and `undo_merge` statement by statement, as the Postgres port checks them; `fork`, `simulate` and `replay` as they run; everything else as a read of `branch`.
- **Refused calls** come back with `isError: true` and the reason.

## Example session

Safe mode, one JSON-RPC message per line (replies shortened to their text):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fork","arguments":{"name":"task-1","meta":{"task":"fix names"}}}}
```
```
created branch task-1 (world id ...) from main; pass branch="task-1" to work on it
```
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"put","arguments":{"table":"users","id":"1","record":{"name":"Ada L."},"branch":"task-1"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"diff","arguments":{"branch":"task-1"}}}
```
```
1 change on task-1
~ users/1  name: "Ada" -> "Ada L."
```
```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"merge_preview","arguments":{"branch":"task-1"}}}
```

The preview shows `users/1` with outcome `apply`. The agent reports `task-1`, and a person merges:

```bash
chronos /path/to/mydb merge task-1
```
