# Quickstart

## Install

```bash
curl -fsSL https://github.com/Abhishekxdg/chronosdb/releases/latest/download/install.sh | sh
chronos --version
```

That's a prebuilt binary for macOS or Linux (x86_64 or arm64), checked against the release's SHA-256 sums, in `~/.local/bin` (set `CHRONOS_INSTALL_DIR` for another place; `CHRONOS_VERIFY=1` also checks its signature with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/): proof Chronos DB's release workflow built it).

## Five minutes in the shell

```
$ chronos mydb
chronos:main> put users 1 {"name": "Ada", "role": "admin"}
chronos:main> put users 2 {"name": "Linus", "role": "user"}
chronos:main> describe users
users (2 rows)
  name  string  e.g. "Ada"
  role  string  e.g. "admin"
chronos:main> fork agent-7                       # instant private copy
chronos:agent-7> put users 1 {"name": "Ada L.", "role": "admin"}
chronos:agent-7> diff
1 change on agent-7
~ users/1  name: "Ada" -> "Ada L."
chronos:agent-7> merge
merged 1 change from agent-7 into main; now on main
chronos:main> find users where role = admin match ada
```

`help` lists every command. `chronos mydb <command>` runs one command and exits, and `chronos mydb < script.txt` runs a file.

## From TypeScript or Python

Start the server:

```bash
chronos serve mydb            # http://127.0.0.1:7070
```

Copy the client you need. Each is one file with no dependencies.

```ts
// clients/typescript/chronos.ts
import { Chronos } from "./chronos";

const db = new Chronos("http://127.0.0.1:7070");
const agent = await db.fork("agent-7");
await agent.put("users", "1", { name: "Ada L.", role: "admin" });
console.log(await agent.diff());
await agent.merge(); // throws ChronosError 409 on conflicts, or if a crash lost writes
```

```python
# clients/python/chronos.py
from chronos import Chronos

agent = Chronos("http://127.0.0.1:7070").fork("agent-7")
agent.put("users", "1", {"name": "Ada L.", "role": "admin"})
agent.merge()
```

## From Claude Code (MCP)

```bash
claude mcp add chronos -- chronos mcp /path/to/mydb
```

The agent gets `describe`, `find`, `sql`, `get`, `put`, `delete`, `fork`, `set_meta`, `branches`, `diff` (rows, or with `as_sql` the SQL statements that make the change), `history`, `merge_preview` (what a merge would do, row by row and why), `checkpoint` and `rollback` (name a moment of its world and go back to it), `simulate` and `replay`, and `discard`, plus instructions for the safe workflow: describe, fork, edit, diff, then a person merges. Every tool and its parameters: [MCP reference](reference/mcp.md).

By default (safe mode) the agent changes only worlds it forked, and approving is left to a person: `merge` (with `resolve`, `by_columns`, per-row decisions in `rows`, and `only_tables`, `only_keys` or `into` to merge part of a world or into another world), `restore` and `undo_merge` appear only with `--allow-merge`, or for an agent (`--agent NAME`) with those rights.

## From Rust

```rust
use chronos::{Db, Query, Resolve};

let db = Db::open("mydb")?;
db.fork("main", "agent-7")?;
let v = db.put("agent-7", "users/1", r#"{"name":"Ada L."}"#)?;
db.merge_at("agent-7", Resolve::Fail, Some(v))?;
```

## One process per folder

A database folder is opened by one process at a time: the shell, `chronos serve`, `chronos mcp` or your program. Close one before opening another, or run `chronos serve` and point everything at it.

Next: [concepts](concepts.md).
