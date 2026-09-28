# Changelog

## Unreleased

**Vector search at 1M rows: 2.1× faster at the same recall, 3.5× at the new default beam, a third less memory to build**
- On 1M real OpenAI embeddings (1,536 dimensions) over SQL, at the same 99.3% recall@10 (`SET hnsw.ef_search = 1000`): 2.30 ms p50, from 4.75 ms. At the new default: 1.36 ms p50 and 1.71 ms p99 at 98.6% recall@10, from 4.75 ms and 6.75 ms at 99.3%; one user's search (1%) 1.16 ms, from 3.59 ms. The server peaks at 9.0 GB building the index, from 14.4 GB ([BENCHMARKS §6](BENCHMARKS.md#6-vector-search-vs-other-vector-databases-on-real-embeddings)).
- The HNSW graph's default beam is at most 400: it tunes itself to the narrowest beam that finds 99.5% of the true top 10, and on real embeddings none did, so it used 1,024. `SET hnsw.ef_search` still widens it (1,000: 99.3% at 1M, 2.30 ms).
- The graph walk loads a node's new neighbours before measuring any of them: 19% faster at the same beam.
- Building the search index holds each vector once: copied into one buffer per column as rows are read, rows unpacked a part at a time.
- Leaves of wide rows are smaller: a row of 1 KB or more can also end its leaf, so leaves hold about 16 KB instead of about 32 rows (200 KB for 6 KB vectors), and fetching a row by key reads that much. Narrower rows keep their leaves as they were. Databases written before read, diff and merge the same, and need no migration.
- A one-time cost in databases written before: the first edit to one of their wide leaves rewrites it whole (as before) but as several smaller leaves. On 20,000 rows of about 3 KB, 50 such edits wrote 323 pages where the old rule wrote 62, and 23% more bytes (94.6 KB against 77.1 KB); the same keys edited again wrote 49.7 KB, less than a tree built now (92.3 KB). A 1M-row table of 6 KB rows turns over once, leaf by leaf as it's edited: about its own size in writes, as before, in about twelve times the pages (about 2.5 rows a leaf instead of 32), after which an edit rewrites a 16 KB leaf instead of a 200 KB one. A diff between a fork made before and main after reads the rewritten leaves on main's side (323 pages, 94.6 KB here) and the old ones on the fork's (63 pages, 77.5 KB), where the old rule read 62 and 62 pages.

**Merge policies: `max_age`**
- `max_age = '1h'`: an agent's world forked longer ago than that doesn't merge on its own; it waits in `SHOW REVIEWS` with its age as the reason (`was forked 2 h 5 min ago (at most 1 h)`). It complements `check_reads`, which catches reads that changed, not ones that are merely old.

**Docs: start every agent with `max_deletes = 0`**
- The merge-policies guide opens with it (no delete merges without a person; loosen later with a bound, `max_deletes` and `deletes_per_hour`), its recipes keep it, and the security guide, concepts, README and MCP's policy-drafting instructions point to it.

**Merge policies: limits per agent over an hour**
- `rows_per_hour` and `deletes_per_hour` add up each agent's merges into `main` over the last hour, so a job split across several worlds is judged as a whole (`deletes_per_hour = 50`). Over the limit, the merge waits for a person. Merges between an agent's own worlds, and a person's merge approving one, don't count. The counts survive a restart.

**Effects that happen only on merge: `NOTIFY ON MERGE` and the outbox**
- `NOTIFY ON MERGE channel, 'payload'` in a world queues a notification that nobody hears while the world is worked on, that's dropped if the world is discarded or the transaction rolled back, and that's sent to `main`'s listeners when a merge (or a transaction's `COMMIT`) brings it into `main`.
- Landed effects wait in `main`'s outbox until a worker acknowledges them: `SHOW OUTBOX`, `ACK OUTBOX 'id', ...`. The database sends nothing out itself, so a worker that was down misses nothing. Merge policies don't count effects as changes.

**Merge policies: `review_columns`**
- `review_columns = 'users.email, accounts.owner'` sends any merge that changes one of those columns to a person, even for one row: an update changing it, an insert giving it a value, or a delete of a row that had one. Only the world's own changes count (not the parent's, combined in `BY COLUMNS`). Shown in `SHOW MERGE POLICIES`, and set over MCP with `set_merge_policy`.

**A run's declared scope: what a world may change, held to at its merge**
- `CREATE WORLD w WITH (may_change = 'leads.status, lists', tenant = 'org_id = 42', intent = '...', run = '...')` says, before the first write, which tables and columns the world is meant to change and which tenant's rows. A merge that changes anything else (another column, another tenant's row, a row moved out of the tenant, a view or a table's own definition) is refused (42501), or, for an agent keeping to a merge policy, queued for a person with what strayed. `MERGE ... DRY RUN` shows it.
- The scope is shown in `SHOW WORLDS`, `SHOW REVIEWS` and a world's JSON over HTTP and MCP. Only the database's own users and admins may change it (`ALTER WORLD w SET (may_change = ...)`).
- Merge policies have `require_scope`: its agents' forks must declare `may_change` or `tenant`.

## 0.1.2 (2026-09-28)

**Move from Postgres in one command: `chronos import <folder> postgres://...`**
- Reads a live Postgres's catalog and brings over schemas, enum types, sequences (continued past the rows), tables with their columns, defaults, keys, `UNIQUE` and `CHECK`, every row (COPY, text format, a table at a time), then foreign keys, indexes, views and materialized views. Extensions, functions, triggers, row-level security, roles, and anything Chronos refuses are listed in a report instead of stopping the import. `--dry-run` tries every definition on an empty in-memory database and writes nothing.
- A small Postgres client of its own (TLS as libpq's `sslmode`, SCRAM-SHA-256), so the binary gains no dependency.

**Stale-read check: merges that relied on rows that changed since the fork**
- A world forked `WITH (check_reads = true)` keeps what it reads (keys, a scan's range, index lookups, and whole tables for searches, bounded per table), and its merge is refused (40001) when any of it changed in the world it merges into since the fork, though it never wrote it. For an agent under a merge policy it's a reason like any rule, and the world is queued in `SHOW REVIEWS`; a policy with `check_reads = true` turns it on for all its agents' worlds, and they can't turn it off. Reads in a transaction count for its world. After a restart earlier reads are unknown, so such a merge is held.

**Merging by columns, per table**
- `ALTER TABLE t SET (merge_by_columns = true)` makes every merge into a world with the setting combine a row both sides changed when they changed different columns, as `MERGE ... BY COLUMNS` does; `RESET (merge_by_columns)` goes back to whole rows, still the default. The same column changed on both sides always conflicts. The setting is a change to the table: in `DIFF` (`merge: by columns`), in `DIFF ... AS SQL`, and a schema change under merge policies.
- A conflict whose rows all had different columns changed says so, and names `BY COLUMNS` and the table setting.

**Merge policies**
- `ALTER MERGE POLICY` and `CREATE MERGE POLICY` read, change and write in one step: two changes at once both land, a policy dropped meanwhile isn't written back, and two creates of one name can't both succeed.
- `DROP MERGE POLICY name CASCADE` takes the policy from its agents and drops it in one step; MCP's `drop_merge_policy` with `release_agents` uses it, so agents are never released without the drop.
- `SHOW REVIEWS`: after a partial merge (`ONLY TABLES`, `ONLY KEYS`) of a queued world, `changed_since` is true. The world's version doesn't move, so clients' merges at the version they had still work.

**What a change affects: readers of every changed column**
- `DIFF WORLD w [TO b] READERS` lists what in the database reads each column the diff changes: views and materialized views (traced column by column through their queries, views on views included), merge checks, triggers (by event and `UPDATE OF`), functions (where their text names the table and column), primary keys, unique constraints, foreign keys (both directions), CHECK constraints and indexes (expressions and `WHERE` included). Rows added or deleted reach every reader of their table.
- Clients seen reading: SQL over the Postgres protocol records which columns each client reads (by role, and `application_name`), and over HTTP by agent; a change's readers name them with when they last read. `REGISTER READER name ON table (cols)` names readers outside SQL (exports, sync tools), kept in the world; `UNREGISTER READER`, `SHOW READERS`.
- Critical readers: `MARK READER billing CRITICAL` / `UNMARK READER` mark a reader of any kind, in the world (forks carry it, `DIFF` shows it, `SHOW READERS` keeps who and when). `DIFF ... READERS` lists critical readers first, then by blast radius, with a `critical` column; merge policies get a `critical` rule (default `false`) that holds an agent's merge changing a column a critical reader reads.
- Every answer ends with what was covered: since when reads have been recorded and through which doors, and that `EXECUTE` strings aren't followed, so "no readers" is never read as "nothing reads this".
- Over HTTP, `diff` with `readers: true` and every merge `dry_run` return `readers` and `coverage`; over MCP, `diff` takes `readers` and `merge_preview` appends them; the Studio's Changes view shows them.

**Merge checks: rules every merge's result must keep**
- `CREATE [OR REPLACE] MERGE CHECK name [ON TABLES (...)] [WITH (timeout = '2s')] AS SELECT ...`, `DROP MERGE CHECK`, `SHOW MERGE CHECKS`. A check is a query that must find nothing in what a merge would make. Every merge runs the checks for the tables it changes, on the world it merges into as the merge would leave it (partial merges and `INTO` included), inside the merge and under its locks, so two changes that are each fine but break a rule together are caught. Rows found refuse the merge (23514, HTTP 409) with the rows as the reason; an agent keeping to a merge policy is queued in `SHOW REVIEWS` instead. No one merges past a check, people included; only `admin` creates or drops one.
- A check is one `SELECT` that changes nothing, run read only within its timeout (default 1 second; a merge it doesn't finish in is refused), stopping at the 11th row. `MERGE ... DRY RUN` names the checks that would fail and their rows in `blocked`.
- Over MCP: `merge_checks`, `set_merge_check`, `drop_merge_check`; in safe mode the last two answer with the SQL for a person to run. See [docs/guides/merge-checks.md](docs/guides/merge-checks.md).

**Column defaults**
- **A default Postgres works out afresh for each row is refused (0A000) instead of being evaluated once.** `DEFAULT random()`, `DEFAULT (nextval('q') + 100)` or `DEFAULT now() + interval '7 days'` gave every row the same value; now `CREATE TABLE`, `ADD COLUMN` and `SET DEFAULT` refuse them, naming the column and the expression. Sequences, `serial` and identity columns, `gen_random_uuid()`, `now()` (and `CURRENT_TIMESTAMP`, `transaction_timestamp()`, `statement_timestamp()`, `clock_timestamp()`) and `current_date` are worked out per row, as before, and constant expressions still work. A subquery in a default is 0A000, as in Postgres.
- `DEFAULT` reads arithmetic and `||` (`DEFAULT 60 * 60`, `DEFAULT 'a' || 'b'`); `DEFAULT nextval('s') + 1` was a syntax error.
- **`nextval('s'::regclass)` defaults use the sequence.** pg_dump and Postgres's catalog write serial and identity columns that way, and it was taken as a constant, so every insert got the same id. `ALTER TABLE ... SET DEFAULT nextval('s'[::regclass])` on an integer column numbers it from the sequence, as the `CREATE TABLE` form does.
- `chronos import postgres://` brings a column with a refused default over without the default, and reports it (Supabase's `timezone('utc'::text, now())` is one), instead of skipping the table.

**Speed on many cores** (a 32-core server, c2d-standard-32; [BENCHMARKS.md](BENCHMARKS.md) was rerun on it against 13 rivals)
- **Joins and grouping over the protocol:** the 20,000-row join + `GROUP BY` went from 11.5 ms to 4.4 ms (Postgres 17: 6.9 ms). Linux builds use mimalloc on glibc too (11.5 to 8.1 ms: glibc gave each query's big batches back to the kernel, and the next query faulted them in again); helper threads wait between queries instead of starting afresh for each step (8.5 to 7.4 ms; in process, a 200k `count(*)` 5.0 to 2.8 ms); tables of 8,192 rows or more split into up to 16 parts, so a 20,000-row table uses more than 4 cores (7.2 to 4.4 ms).
- **Agents writing on disk:** 1,000 agents, each forking main, writing 1,000 rows one by one and merging, on one thread each: 5.0 s to 1.76–1.80 s. A world other than main logs its writes in batches (one lock taken per batch, not per row), and a thread finds its world without the branch map's lock. Merges on disk at 1,000 threads are still slow: p50 714–718 ms against Postgres's 128 ms at 25 workers.
- **Vector search p99:** a vector graph counts as built only once its self-test has run. Before, the first searches ran beside 128 exact probe scans on every core: p99 8.6 ms, now 2.1–2.7 ms.

**Durability**
- `main` and merges are synced as before. New: a crash can lose an open world's writes even after a later `main` commit was synced (they're logged in batches). After a crash each open world comes back as some prefix of its own writes, and it's flagged. See [versions and crashes](docs/concepts.md#versions-and-crashes) and [operations](docs/operations.md).

## 0.1.1 (2026-09-27)

**Merge policies: agents merge on their own within rules, the rest wait for a person**
- `CREATE / ALTER / DROP MERGE POLICY` with `max_rows`, `max_deletes`, `tables`, `review_tables`, `schema` and `overwrite`, and `ALTER AGENT ... SET (policy = ...)`. The rules are checked inside the merge, on the rows it applies, under its locks, so what is checked is what merges. A refused merge keeps its world and waits in `SHOW REVIEWS` for a person to merge or drop it.
- Over MCP: `merge_policies`, `check_merge_policy` (try rules on a branch's real changes), `set_merge_policy`, `drop_merge_policy`, `reviews`; in safe mode the agent drafts rules and gets the SQL for a person to run. An agent under a policy changes main only by merging, and may not `UNDO MERGE` or `UNDO AGENT`. See [docs/guides/merge-policies.md](docs/guides/merge-policies.md).

**Correctness, measured: SQLite's sqllogictest over the Postgres protocol**
- 622 files, 5,675,180 records, the same runner on Chronos DB and Postgres 17: Chronos passes 99.912%, Postgres 99.796%, and there's no record Postgres answers right and Chronos wrong. The 63 that fail only on Chronos are division by zero beside a NULL constant. Method, gaps and results: [BENCHMARKS.md §13](BENCHMARKS.md#13-correctness-sqlites-sqllogictest-over-the-postgres-protocol) and `bench/slt`. What the run found is fixed:
- **String literals are read as the type they meet when the statement is planned**, as Postgres does: `'hello' = int_col`, `x IN (1, 'hello')`, `'hello' IN (SELECT x ...)` and `SET x = 'hello'` fail with 22P02 even when no row is compared or changed (they were only checked row by row, so an empty table let them pass).
- A column set twice in one `SET` is 42601, `multiple assignments to same column`.
- Aggregates take `ALL`, the default, as in `sum(ALL x)` and `string_agg(ALL s, ',')` (it was a syntax error).
- An `OR` or `AND` inside each of many nested parentheses, as generated queries write them, is counted by the tree it makes: each such level counted 16 toward the limit of 400, so `(a OR (a OR (...)))` was refused (54001) at 25 levels; now it's about 3 a level, and 60 levels run.
- **Parenthesized joins in FROM:** `FROM (a JOIN b ON ...)`, `((a CROSS JOIN b))`, and after an inner or cross join `a JOIN (b JOIN c ON ...) ON ...` (it was a syntax error, `expected SELECT`); one after an outer join or USING, or with an alias of its own, is refused (0A000) for now. Both found by SQLite's sqllogictest.

**SQL**
- **A `WITH` query used more than once is computed once**, as in Postgres: every use reads the same rows, so `nextval()` or `random()` in it gives one value to all its uses.
- **`INSERT INTO t VALUES (1)` into a wider table** fills the first columns and gives the rest their defaults (serials included), as Postgres does.

**Fixes from the fourth code review**
- A `COPY FROM STDIN` whose client sends nothing for `CHRONOS_COPY_IDLE` (60 s) is dropped and undone, instead of holding its world's writers for good; one huge CopyData message is read a part at a time.
- After a power cut, a page left half-written at the end of the pack is checked before it's taken as stored, and written again whole.
- A big statement committed by its log note is reported done even if the rest of that checkpoint fails (retried later), so a client isn't told to insert twice.
- Replaying history (`UNDO`, `AS OF`, `HISTORY`) errors when a log segment it needs was cleaned up, instead of replaying without it.
- `UNDO MERGE` and `UNDO AGENT` need the right to write the world they change, as `RESTORE` does.

**Integer keys in number order**
- **Tables made from now on store an integer primary key in number order,** so a range of ids is one read of the tree: `WHERE id > 1000` no longer scans the table, and `BETWEEN` no longer looks keys up one by one (it did for ranges under 100,000 keys). Rows without `ORDER BY` come back in id order (1, 2, 10), not as text (1, 10, 2). Tables made before keep their keys as they are.
- People still see and type `t/7` everywhere: diffs, conflicts, `UNDO` messages, `ONLY KEYS`, the shell, the HTTP API, MCP, `search()` and the key-value API (`db.get("t/7")`; a key is written as its number, so `t/007` is refused, as before).
- **A big statement's parts in key order go straight into the new tree**, instead of through sorted spill files first: a load in id order, and an `UPDATE` of values (it reads in key order). A binary COPY of 76,424 × 1,536 embeddings writes 526 MB instead of 1,057 MB (1,816 MB before 0.1.0's streaming COPY), with 6–8 s of server CPU instead of 9–22 s, in 8–15 s instead of 13–23 s (four runs each on a cloud VM whose disk varies).

## 0.1.0 (2026-09-27)

The first release: signed binaries for macOS and Linux (x86_64 and arm64), installed by
`curl -fsSL https://github.com/Abhishekxdg/chronosdb/releases/latest/download/install.sh | sh`.

**Getting started**
- Prebuilt binaries with SHA-256 sums and keyless cosign signatures (`CHRONOS_VERIFY=1` checks them), published at [github.com/Abhishekxdg/chronosdb](https://github.com/Abhishekxdg/chronosdb) with the Studio's source (MIT), the clients and the docs; the docs lead with the one-line install.
- **A misspelled column suggests the nearest one:** `column "nme" does not exist; did you mean "name"?` (one or two edits away).
- `chronos studio`, `serve`, `mcp` and `import` without a folder say so and how to give one, and a file given as the folder says it's a file (it was `File exists (os error 17)`).
- The shell and its help say worlds throughout; `worlds` lists them (`branches` still works).
- Issue and pull request templates, CONTRIBUTING.md, and Report a problem in the Studio's Help menu.

**Bulk loads**
- **`COPY ... FROM STDIN (FORMAT binary)`**, as bulk loaders send it: every type binary parameters take, pgvector's vectors included (psycopg: `cur.copy("copy items from stdin (format binary)")`). `COPY ... TO` in binary is still refused.
- **COPY streams into its INSERT:** the rows go in a part at a time (16,384 rows or 32 MB) as the client sends them, instead of all being kept (on disk past a quarter of `CHRONOS_WORK_MEM`) until the data ends. The data is written once fewer, and a COPY holds one part.
- **Vectors are stored 7 bits to a character** instead of base64's 6: a 1,536-dimension vector takes 7,022 characters instead of 8,192. Rows written before still read.
- Measured on 76,424 × 1,536 embeddings: a binary COPY writes 1,057 MB instead of 1,816 MB, with 8–9 s of server CPU instead of 14–26 s, into a 536 MB database instead of 625 MB; an INSERT load writes 1,323 MB instead of 1,477 MB.
- Loading them on a cloud VM is bound by its disk, not by the protocol (binary COPY reads and decodes them all in 0.7 s). `bench/ingest.py` times INSERT and binary COPY on Chronos DB and Postgres, and LanceDB, whose ~2 s load doesn't wait for the disk (no fsync).

**Scans stay small at any table size**
- Scans split a table into parts of about 4,096 rows however big it is. They were cut at the tree level with at least 256 subtrees, so each time a table outgrew a level (the tree fans out 32 ways) every part became 32 times bigger: a `count(*)` over 10 million rows needed +63 MB of heap, now +8 MB (1 and 4 million rows: +5 and +6 MB, as before), and RSS went from 250 MB to 107 MB. What still grows with a database is the page directory it keeps open, about 3 MB per million narrow rows. `examples/scanmem.rs` measures it.

**Chronos Studio**
- **The layout of a desktop data tool:** menus, a search that opens the command palette, an icon rail, a sidebar with the folder, worlds, tables opening to their columns, a timeline and an outline (it collapses: ⌘B), pill tabs, and a status bar; floating panels on a quiet ground, Schibsted Grotesk and Martian Mono.
- **The worldline:** every world drawn as a lane off its parent at the moment it was forked; click a lane to switch world, drag across it to read the tables as they were.
- **Search:** words, filters and nearness to a row's vector in one `find` call, beside a map of the table's vectors (PCA, coloured by a field with few values). Vectors show as a strip of bars in the grid and the inspector, with Find similar rows.
- **Diagram:** a card per table with its columns and types, foreign keys drawn between columns, drag, pan, zoom and fit.
- **Settings** (⌘,): theme, density, sidebar, worldline, times in the local zone or UTC, the session's key, the database's facts and an integrity check.
- **Checkpoints** (save one, view as of it, restore to it), Export CSV of a table's rows in view, CSV downloads of SQL results, and SQL colouring in the editor.
- **Edit a cell in place:** double-click (or F2), Enter saves, Esc cancels; one `UPDATE ... RETURNING`, and the grid shows the stored row without reloading. On main it asks first.
- **Import rows** from CSV, JSON or NDJSON: checked against the table's columns, previewed, and written all at once or not at all.
- **Simulations:** fork N worlds, run the same SQL in each, score them, keep the best; open, review, replay or discard what's kept.
- **Merges on the worldline:** a merge into main rejoins it, and a world merged and gone is drawn from its fork to its merge.
- **`chronos studio <folder> [--port N] [--no-open]`: a web UI for the whole database, built into the binary** (a React + TypeScript app in `studio/`, built by Vite and embedded by `build.rs`; without a build, a page says how to make one, so `cargo build` needs no Node). Worlds as lineage (each world's color down the page edge, amber for main), tables and schemas (JSON tables too), a virtualized row grid that pages through 250,000 rows with filters, sorting and time travel, a row inspector with editing that defaults to a new world on main, a SQL console (SQLSTATE errors, `EXPLAIN`, history), the Changes view (the paged diff with only changed columns, a merge preview settling conflicts row by row, merge, discard, undo), history with restore, agents and the audit log, status, a ⌘K command palette and keyboard shortcuts, light and dark themes, and phone layouts. See [docs/studio.md](docs/studio.md).
- It listens on 127.0.0.1 only, on its own port, and works beside a running `chronos serve`, `mcp` or shell on the same folder by running its calls in that process over the local socket (a new `api` session mode). The API needs a per-run 256-bit key carried in the link's `#` (never sent to a server) and sent back as `X-Studio-Token`; Host must be `127.0.0.1:<port>` and any Origin `http://127.0.0.1:<port>`, exactly. Responses are `no-store` with a strict CSP (no inline script), no framing and no referrer. It offers no backups (a path on the machine). `chronos serve`'s own API is unchanged.

**`DISTINCT` aggregates bounded**
- **`count(DISTINCT x)` and every other `DISTINCT` aggregate on one table no longer hold the table or all their values.** They were kept off the part-by-part grouping (two parts' distinct values couldn't be merged), so the whole table was read into memory first, and each group kept every value it had seen: `count(DISTINCT k)` over 10 million rows peaked at 4.0 GB. A DISTINCT state now keeps its values so two parts' states merge, the values count against `CHRONOS_WORK_MEM`, and past it rows spill by group and argument (see [operations](docs/operations.md#memory-and-spilling-to-disk)). On the VM, 100,000 distinct values over 4 and 10 million rows took 94 and 295 MB (main: 1.5 and 3.3 GB) with a 32 MB cache and 64 MB budget, and at the defaults `count(DISTINCT k)` of 10 million values 672 MB (main: 4.0 GB). Same answers and speed while they fit (1 million rows: 2.1 s on both).
- A grouping's next wave of parts is sized by what one part's groups hold, not only by the merged groups: parts sharing groups or distinct values had let a whole table's parts be held at once.

**Statements bigger than memory**
- **A big `INSERT` (`VALUES`, `SELECT`, `COPY`), `UPDATE` or `DELETE` no longer holds its writes.** Past half of `CHRONOS_WORK_MEM` it goes on in parts: each part is checked against the table as the statement found it, and its rows and index entries go to sorted, lz4-compressed run files in `<database>/spill` (sealed when the database is encrypted), with marks for keys and unique values that depend on other parts. At the end the runs are merged: a key or unique value two rows take, or one the table holds for a row the statement leaves alone, fails the statement (23505) and nothing is written, as before. The merged changes are written into a new tree beside the world's, and one checkpoint makes it the world's state: all of the statement or none of it, for readers and after a crash (the manifest is the commit record; a new `Op::Bulk` log note, manifest format 7, records it for history and replay). Worlds, merges, history and time travel see one write, and nothing is left in memory afterwards.
- Under a 30 GB cap on the 31 GB VM, `INSERT ... SELECT`s of 540-byte rows into a table with two indexes peaked at 61, 67 and 78 MB for 200,000, 1 million and 2 million rows with `CHRONOS_WORK_MEM=32MB` (before: 439 MB, 2.3 GB, 4.5 GB), and at 405, 406 and 411 MB for 1, 5 and 10 million rows with the defaults (main at 3 million: 6.8 GB). They were also faster (1 million rows: 56 s against 79–86 s), and small statements weren't slower. An `UPDATE` of all 5 million rows peaked at 548 MB, and `COPY`s of 0.5, 2 and 4 million rows at 433, 440 and 419 MB. A kill -9 while one spills, or while its commit writes pages, leaves the table as it was and no spill files; one after its checkpoint keeps all of it.
- `COPY ... FROM` is one statement however big (it went in as a transaction of 20,000-row inserts), taking its rows a part at a time as they arrive.
- `INSERT ... SELECT` reads a one-table or `generate_series` `SELECT` a part at a time (a function in `FROM` counted as `LATERAL`, so every `generate_series` was computed whole first).
- **Still held in memory:** `ON CONFLICT`, `RETURNING`, tables with triggers or a foreign key to themselves, a `DELETE` or key-changing `UPDATE` of a table others' foreign keys cascade or set null from, statements run by functions or triggers, schemaless and temporary tables, and databases in memory. `COMMIT` of a transaction holding a big statement, like any merge, moves its changes in memory.

**Schemas, search_path, regclass and the constraint catalogs**
- **Schemas:** `CREATE SCHEMA [IF NOT EXISTS]`, `DROP SCHEMA [IF EXISTS] ... [CASCADE | RESTRICT]`, and `schema.name` for tables, views, sequences, types, functions and indexes everywhere (DDL, DML, `FROM`, joins, foreign keys). Objects outside `public` are stored under their qualified name and schemas are rows of the world, so they fork, merge, diff (`DIFF ... AS SQL` too), travel in time and replay; `public` objects keep their keys, so existing databases open unchanged.
- **`SET search_path` / `RESET` / `SHOW`**, resolving names without a schema as Postgres does (and `CREATE` into the first existing schema), with `current_schema()` and `current_schemas()` following it; psql's `\dn`, `\dt app.*` and `\d app.t`.
- **`'name'::regclass`** (schema-qualified or not), `::regclass::oid` and `::regclass::text`, `to_regclass()`, with oids matching `pg_class`.
- **Catalogs:** `pg_index`, `pg_constraint`, `pg_indexes`, `pg_am`, `information_schema.schemata`, `table_constraints`, `key_column_usage`, `referential_constraints`, `constraint_column_usage` and `check_constraints`, from the real primary keys, unique constraints, foreign keys, checks and indexes, with `pg_get_constraintdef` and `pg_get_indexdef`; checked against Postgres 17 with the reflection queries SQLAlchemy and Prisma send.
- `WITH` inside any subquery (in `FROM`, `IN`, `EXISTS`, `ANY`, a scalar subquery, `INSERT ... WITH ... SELECT`); `unnest` and `generate_subscripts` in the select list; `array_length`, `cardinality`, `array_lower`, `array_upper`; bitwise `&` and `|`.

**PL/pgSQL catches errors, runs dynamic SQL; enums change**
- **`EXCEPTION` blocks:** `BEGIN ... EXCEPTION WHEN division_by_zero OR unique_violation THEN ... WHEN SQLSTATE '22023' THEN ... WHEN OTHERS THEN ... END`, with `SQLSTATE`, `SQLERRM`, `GET STACKED DIAGNOSTICS` (message, code, detail, hint, context) and `RAISE;` to raise it again. A caught error takes back what the block wrote (its triggers' writes included), and keeps the handler's, as Postgres's implicit savepoint does; it works inside triggers (a handler can turn a `unique_violation` into another write), transactions and savepoints, and a restart replays only what stayed. Statement timeouts and cancels (57014) and failed `ASSERT`s aren't caught by `OTHERS`, as in Postgres, so a timeout still stops a loop inside a block.
- **`EXECUTE`** (dynamic SQL) `[INTO [STRICT] ...] [USING ...]`, `FOR ... IN EXECUTE` and `RETURN QUERY EXECUTE`, with `format()` (`%s`, `%I`, `%L`), `quote_ident`, `quote_literal` and `quote_nullable`.
- **`ALTER TYPE ... ADD VALUE [IF NOT EXISTS] ... [BEFORE | AFTER ...]`, `RENAME VALUE` and `RENAME TO`**, `DROP TYPE ... CASCADE` (the type's columns and functions go too), and `enum_first`, `enum_last`, `enum_range`. Enums can be functions' arguments and results and PL/pgSQL variables, and compare by their labels' order there. Changes fork, merge, travel in time and replay with the rows.
- Comparing an enum with a string that isn't one of its labels is 22P02, as in Postgres (it found no rows).

**Fixes from the capability audit**
- `select count(*) || 'x'` (an aggregate inside an operator) and `ORDER BY v <-> NULL` on an HNSW-indexed column no longer crash the connection.
- `SET statement_timeout` works (it was accepted and ignored), Postgres cancel requests stop the running statement, and a statement whose client disconnected stops.
- `column = value` on a big table without a B-tree index no longer builds the table's search index in memory (a 1 GB table grew the server to 10 GB): queries build it only for tables under `CHRONOS_WORK_MEM / 8`, and scan otherwise.
- A range on an integer primary key (`BETWEEN`, `<`, `>`) reads by key instead of scanning, up to 100,000 keys wide.
- **Databases bigger than memory** (`examples/big.rs`: 811 MB with a 32 MB cache stays under 200 MB of footprint):
  - `ON CONFLICT` on a `UNIQUE` column no longer builds the table's search index to find the clashing row (an 811 MB database passed 2 GB on one upsert). It reads the constraint's own entry: 2 ms.
  - A range on a text primary key reads only its rows, at any width (a 1/256 range went from 223–537 ms to 28 ms cold, 2–3 ms warm).
  - The page cache counts the memory pages take once decoded, so `CHRONOS_CACHE_MB` is a real cap. It had counted their size on disk, which undercounts small rows by up to 2.5 times. `SHOW METRICS` adds `cache_bytes`, `cache_hits` and `cache_misses`.
  - **`CREATE INDEX` on a table bigger than memory** (and `CREATE UNIQUE INDEX`, `ADD CONSTRAINT ... UNIQUE`) held every entry several times over in one write: on a 9.3 GB table the server passed 7.8 GB and was killed. It now sorts the entries within `CHRONOS_WORK_MEM`, spilling to disk, finds any duplicate before writing, and writes the entries in parts with checkpoints between, the index appearing only with the last part: a crash mid-build leaves no index. Writes and merges to the world wait for it; reads and forks don't. On 7 million rows of 540 bytes under a 2 GB memory cap, `CREATE INDEX` took 65 s at 548 MB and `CREATE UNIQUE INDEX` on two columns 206 s at 767 MB; before, both were killed at the cap.
  - B-tree index reads hold the row ids they find (up to `CHRONOS_WORK_MEM` of them) and read each row as the query reaches it, instead of holding up to a fifth of the table's rows.
  - Big writes copy their rows fewer times: a log record of a MB or more is written straight to the file (the log's buffer had grown to the biggest record and kept that memory), the record is encoded into a buffer sized once, and `INSERT ... SELECT` lets go of the selected rows as it goes and keeps the rows it made only for `RETURNING` or `AFTER` triggers. A 250,000-row `INSERT ... SELECT` into that indexed table peaked at 1,022 MB instead of 1,608 MB, and a 1,000,000-row one at 3.5 GB instead of 6.2 GB. (A single statement no longer holds its rows at all past `CHRONOS_WORK_MEM`: see Statements bigger than memory.)
  - Text search corrects typos only in words of up to 32 letters: every longer word (a hash, an id) added its length squared in bytes to the index, and a 19 MB table's index passed 2.5 GB.
- Without a server token, an HTTP bearer token that matches no agent (a disabled agent's included) gets 401 instead of acting as the database's owner.
- `SHOW HISTORY` lists merges settled by columns or row picks.
- `chronos --version` prints the version (it created a database folder named `--version`), and unknown `--options` are refused.
- **Worlds no longer write main to number rows.** `serial`, identity and `CREATE SEQUENCE` counters were rows of main, so a fork's inserts (or `nextval`, `setval`, `RESTART` in a fork) changed main's rows and version. They now belong to the database: logged as their own record and kept in each checkpoint's manifest (format 6), so numbers stay unique across merges, restarts and crashes while no world's data moves. Main may see gaps where forks took numbers, as Postgres does after a rolled-back insert. Time travel and restore don't rewind counters. Databases from before open and carry on numbering (their counters are taken over from main's rows once).

**Postgres compatibility: views, sequences, NOTIFY, the catalog**
- **Views:** `CREATE [OR REPLACE] VIEW name [(columns)] AS query` and `DROP VIEW [IF EXISTS] ... [CASCADE]`. Readable anywhere a table is; kept as rows of the world, so forks, `DIFF` (and `DIFF ... AS SQL`), merges, restarts and AS OF (the definition and its tables as they were then) see them. Dropping a table or view a view reads fails with 2BP01 unless `CASCADE`. Simple views (one table's columns, no grouping) take `INSERT`, `UPDATE` and `DELETE`, as Postgres's automatically updatable views; others get Postgres's error. psql's `\dv` and `\d[+] view` work.
- **Materialized views:** `CREATE MATERIALIZED VIEW ... [WITH [NO] DATA]`, `REFRESH MATERIALIZED VIEW`, `DROP MATERIALIZED VIEW`: a table holding its query's rows, per world; a REFRESH that finds the same rows changes nothing. `\dm` works.
- **Sequences:** `CREATE SEQUENCE [IF NOT EXISTS]` (`AS`, `INCREMENT`, `MINVALUE`, `MAXVALUE`, `START`, `CYCLE`), `ALTER SEQUENCE ... RESTART`, `DROP SEQUENCE`, `nextval`, `currval`, `setval`, `lastval`, and `DEFAULT nextval('name')` columns. Definitions live in the world; counters are shared by every world holding the sequence, as `serial` counters are, so ids made in forks don't collide on merge. `\ds` and `\d sequence` work.
- **LISTEN / NOTIFY / UNLISTEN** and `pg_notify()`: delivered at COMMIT (or at once outside a transaction), once per channel and payload per transaction, to connections listening in the same world, as NotificationResponse messages; idle connections get them at once.
- **`TRUNCATE`** (several tables, `RESTART IDENTITY`, `CASCADE`), **`UPDATE t AS x` / `DELETE FROM t x`** (target aliases), and **`DROP TABLE a, b [CASCADE]`**.
- **The catalog:** `information_schema.columns`, `.views` and `.sequences` beside `.tables`, and `pg_catalog`'s `pg_class`, `pg_attribute`, `pg_namespace`, `pg_type`, `pg_attrdef`, `pg_sequence`, `pg_tables`, `pg_views`, `pg_matviews` and `pg_sequences`, with `format_type`, `pg_table_is_visible`, `current_schema` and `current_database`; catalog queries psql doesn't send go to the SQL engine instead of failing.

**Simulations**
- **`SIMULATE n WORLDS FROM base AS prefix RUN $$...$$ SCORE $$...$$ [ASC] [KEEP k | ALL] [SEED s] [THREADS t]`** (and `Db::simulate`, `simulate` over HTTP and MCP, `simulate()` in both clients): forks n worlds from one moment of the base, runs the script in each on every core (`$1` the world's index, `$2` its seed), scores each, keeps the best k and discards the rest. A world that fails is reported with its error; the rest carry on. Agents' worlds are their own and fit their `max_worlds` (run in batches, or refused up front). 10,000 one-row worlds take 0.4 s.
- **The same inputs give the same worlds:** in a simulation, `random()`, `gen_random_uuid()` and keys of keyless tables are seeded per world, and `now()` is the base moment, on any number of threads. Before, two forks running the same `UPDATE ... random()` differed in 999 of 1,000 rows.
- **`REPLAY WORLD w [AS name]`** (and `Db::replay`, `replay` over HTTP and MCP, `replay()` in the clients): kept worlds record their inputs (metadata `sim`); a replay forks the base as it was then from history, reruns the script and says whether the rows and score are identical.
- **`setseed(x)`** seeds a session's `random()`, as in Postgres.
- **Dollar-quoted strings** (`$$...$$`, `$tag$...$tag$`), as in Postgres.
- `SHOW METRICS` times `simulate`.

**Limits and cleanup**
- **Per-agent limits:** `max_query_ms` (its statements' timeout, which it can lower but not raise), `max_concurrent` (statements at once; SQLSTATE 53300, HTTP 429) and `max_memory_mb` (a statement holding more rows stops with 53200, HTTP 413, instead of growing the server; its spilling starts at a quarter of it). `CREATE`/`ALTER AGENT`, HTTP `create_agent`/`alter_agent`, `SHOW AGENTS`.
- **Database-wide:** `ALTER SYSTEM SET statement_timeout` (every session's default), `max_worlds` (forks past it are refused with 53400) and `world_idle_ttl` (worlds unused that long are discarded by the background worker, unless pinned with `ALTER WORLD w SET PINNED` or forked from). Kept in the folder; a world's last activity (`active` in `SHOW WORLDS`) survives restarts. Expired and idle worlds' discards are logged and audited as `system`.
- **Space comes back on its own:** after 1,000 worlds, or worlds that changed 100,000 rows, are discarded, the background worker checkpoints and cleans up (before, only a doubling of the page files did). `SHOW DISK` (and `Db::disk_usage`) splits page bytes into in use, kept only for history, and reclaimable.
- **`DROP WORLD w CASCADE`** drops a world and every world forked from it, deepest first, each in the log and audit trail; HTTP and MCP `discard` take `cascade`.
- **Discarding no longer scans every world.** Each world keeps its live fork count, worlds are found by ID directly, and `Db::discard_many` drops many at once under one lock (deepest first); `DROP WORLD ... CASCADE`, `SIMULATE`'s losers and the expiry and idle sweeps use it. Dropping 99,000 of 100,000 worlds went from 54.8 s to 0.93 s one by one (0.51 s in one call), the expiry sweep from 675 µs to 12.6 µs per world, and finding a world by ID from 8.7 ms to under a microsecond (in the 10,000-world simulation, whose worlds hold many rows, the discard phase didn't get faster: 0.7–1.1 s per round). Retired worlds leave the search caches, and checkpoints hand freed memory back to the system on glibc. See BENCHMARKS.md section 9.
- **`chronos serve --safe`:** HTTP and Postgres clients without an agent's token act as the agent `guest` (MCP's safe mode: fork and change only their own worlds); `--admin-token` is the owner. The names `guest` and `system` are reserved for agents.
- `SET statement_timeout` and `SHOW statement_timeout` no longer need admin rights for agents (or break MCP's safe mode): they change only the session.

**Branches**
- **Worlds:** branches with IDs that are never reused, creation times, depth and JSON metadata (owner, task, tags...). `CREATE`/`FORK`/`SWITCH`/`ALTER`/`DROP WORLD` and `SHOW WORLDS` in SQL; `fork` with `meta`, `world` and `set_meta` over HTTP, MCP and both clients; kept in the log and the checkpoint. 100,000 worlds on disk: 0.46 µs per fork, 2 KB of memory each, and queries 1,000 forks deep run as fast as on main. Worlds with few changes keep them as a list in the checkpoint instead of pages of their own: at 100,000 one-row worlds, checkpoints went from 19 s to 1.2 s, reopening from 8.8 s to 1.0 s, and the folder from 429 MB to 24 MB.
- **O(1) copy-on-write forks.**
- **One writer per branch, and readers never wait.**
- **Merges:** three-way, row by row. Conflicts come back as data and are resolved with `ours` or `theirs`, and any row both sides wrote is a conflict (first merge wins).
- **Versions:** every write returns the branch version, and `merge_at` refuses a branch that isn't at the expected version.

- **Storage per world:** `SHOW STORAGE [FOR WORLD w]` (and `Db::usage`) gives each world's rows changed since its fork and the pages and bytes only it holds; a fresh fork costs 0 bytes.
- **Any world can expire:** `ALTER WORLD w SET TTL '2 hours'` / `RESET TTL` (and `Db::expire`); the background worker discards it when its time is up.

**Agents**
- **Undo any agent, for 30 days:** `UNDO AGENT name SINCE <time> [SKIP CHANGED]` (and `Db::undo_agent`) puts back every row the agent changed in a world since then, whether it wrote directly, committed transactions or merged its own worlds, and leaves everyone else's changes. Rows changed by someone after the agent are named, or skipped. Index entries are rebuilt for the rows put back, and unique and foreign keys are checked as in a merge. History is now kept 30 days by default (was a day).
- **MCP tools for reviewing and undoing:** `merge_preview` (the dry run: per row, clean or conflicting and why), `merge` with `by_columns` and per-row decisions (`rows`), `undo_merge`, `diff` with `as_sql`, and `checkpoint`/`rollback`. Safe mode stays as strict: previews and checkpoints on the agent's own worlds only, no approvals. A merge conflict now tells agents which tool calls resolve it.
- **Agents** with names, IDs and secret tokens (only hashes kept), made with `CREATE AGENT` or over HTTP; an agent's token acts as it over HTTP.
- **What each may do:** read, fork, change its own worlds, change any world or main, merge its own or any world, restore, admin. New agents work on their own worlds; a person merges.
- **Owned worlds** (the owner can't be changed), **world TTLs** (expired worlds are discarded in the background), and **quotas**: live worlds, rows changed per world, writes per minute.
- **Audit trail:** everything an agent writes is logged as its; `SHOW AUDIT` lists it.
- **Checkpoints:** `CHECKPOINT WORLD w AS 'name'` and `RESTORE WORLD w TO CHECKPOINT 'name'`.
- **Agents everywhere:** an agent logs in over the Postgres protocol with its name and token, and `chronos mcp --agent NAME` makes an MCP session act as it; SQL is checked statement by statement, and CREATE WORLD makes a world the agent owns.

**Merges**
- **Dry run:** what a merge would do to every row, and why rows conflict, changing nothing (`MERGE ... DRY RUN`, `dry_run`, `preview()`).
- **Settling conflicts:** row by row (ours, theirs, a given row, or delete) and by columns (rows where the two sides changed different columns are combined); settled rows are logged as what they became, so replay is exact.
- **Conflicts explained:** each says what each side did and which columns it changed.
- **Merge part of a world:** `MERGE WORLD x ONLY TABLES (t, ...)` or `ONLY KEYS ('t/1', ...)` (`only_tables`, `only_keys` over HTTP, MCP and both clients) merges just those rows; x stays open with the rest. Rows merged this way aren't merged or flagged again later, but a later change to them by either side still conflicts. A table goes whole (schema, rows, unique, reference and index rows); a row takes its own unique and reference rows, and is refused if it shares one with a row left out or its table's schema changed.
- **Merge into any world:** `MERGE WORLD x INTO y` (`into`) applies x's changes to y, three-way against x's fork point; x stays open. Agents need the right to merge x and to change y.
- **Undo a merge:** `UNDO MERGE OF WORLD x [SKIP CHANGED]` (and `undo_merge` over HTTP and in the clients) puts back what x's latest merge changed, rebuilt from history; rows changed again since are named, or left alone.
- **Schema conflicts:** both sides changing one table differently is refused even with `USING OURS`/`THEIRS`, which would have misread one side's rows.

**Diffs**
- **Column by column:** every changed row lists the columns that changed, and changes to tables themselves come as `create table`, `alter table` (columns added, dropped, renamed or retyped, keys, indexes, constraints) or `drop table`.
- **`DIFF ... AS SQL`** (and `"sql": true` over HTTP): the statements that make the change, from `CREATE TABLE` and `ALTER TABLE` to row `INSERT`/`UPDATE`/`DELETE` by key. Run on the world the diff starts from, they give the one it ends at.

**Time travel**
- **Any world as it was:** `name@when` wherever a world is read (SQL, psql's database name, HTTP, MCP, clients), and `AS OF` / `FOR SYSTEM_TIME AS OF` on any table in SQL, joins of now and then included, with each table's schema as it was. Kept for a retention window (30 days by default; `alter system set history_retention`).
- **`RESTORE WORLD`**, forking a world as it was, `DIFF WORLD a TO b` between any two worlds or moments, and `SHOW HISTORY` (forks, writes, commits, merges); `history` and `restore` over HTTP, MCP and both clients.
- **How:** checkpoints are kept with their log for the window, the log records the time, and cleanup keeps pages only history uses. A moment is rebuilt once (6–60 ms here) and cached; a query `AS OF` a fixed time runs as fast as now.
- **`INSERT ... SELECT`.**

**Storage**
- **Write-ahead log:** checksummed, with group commit.
- **Page trees:** content-addressed prolly trees of LZ4 pages, with incremental checkpoints and background checkpointing.
- **Cleanup** of pages nothing uses.
- **Durability:** safe on merge. Writes to `main` and merges are fsynced. After a crash, branches that were open are flagged until a merge confirms them.
- **Cloud storage** (feature `s3`): any S3-compatible bucket, a single-writer lease with takeover and fencing, and scale to zero.

**Search**
- **One query plan:** equality filters (bitmaps), BM25 text with one-typo correction, and vector search (1-bit scan with exact rescoring), fused with reciprocal rank fusion.
- **Paging.**
- **Search inside branches** through shared indexes plus each branch's own changes, and an answer cache.

**SQL**
- **Functions and triggers:** `CREATE [OR REPLACE] FUNCTION` in `LANGUAGE sql` (`AS $$...$$`, `RETURN expr`, `BEGIN ATOMIC`) and `LANGUAGE plpgsql` (a documented subset; anything outside it is refused with 0A000 when the function is made), scalar or set-returning (`SETOF`, `RETURNS TABLE`) in `FROM`, `$1` or named parameters, `STRICT`, overloading, `DROP FUNCTION`; `CREATE [OR REPLACE] TRIGGER` `BEFORE`/`AFTER` `INSERT`/`UPDATE [OF]`/`DELETE`, `FOR EACH ROW`/`STATEMENT`, `WHEN`, `DROP TRIGGER`, `ALTER TABLE ... ENABLE/DISABLE TRIGGER`. Both are rows of the world, so they fork, merge, diff (`DIFF ... AS SQL` included) and travel in time with the data. What functions and triggers write commits with the statement that ran them, and a restart replays those rows without firing anything again. `RAISE NOTICE` reaches psql; `\d` lists triggers. Checked against Postgres in `tests/pgdiff.rs`.
- **`COPY`:** `COPY ... FROM STDIN` and `TO STDOUT` over the Postgres copy protocol (psql's `\copy`, pg_dump-style scripts, drivers' copy APIs), text and CSV with `HEADER`, `DELIMITER`, `NULL`, `QUOTE`, `ESCAPE` and the `FORCE_*` options, checked byte for byte against Postgres. A COPY is all or nothing (bad rows, CopyFail and dropped connections leave nothing), names the line and column of a bad value, and loads without parsing SQL: about 1.7x the rows per second of 1,000-row `INSERT`s. Files and programs on the server are refused.
- **`PREPARE` / `EXECUTE` / `DEALLOCATE`** in SQL, sharing names with the protocol's prepared statements as in Postgres.
- **Enum types:** `CREATE TYPE ... AS ENUM` and `DROP TYPE`, columns of them checked on every write and compared, sorted, `min`/`max`'d in label order; types are rows, so they fork and merge. Checked against Postgres.
- **Temporary tables:** `CREATE TEMP TABLE` in a database of the session's own, in memory: never logged, diffed or merged, gone with the connection, readable and fillable alongside the world's tables, and rolled back with `ROLLBACK`.
- **`public.` names** wherever a table goes, and `CREATE SCHEMA IF NOT EXISTS public`; other schemas are refused with Postgres's errors.
- **Primary keys of several columns:** `PRIMARY KEY (a, b)` (and `ALTER TABLE ... ADD PRIMARY KEY (a, b)`), stored in an order-keeping key form, so rows sort by key, full-key equality reads one row and a leading-column equality reads a key range. `ON CONFLICT` on them, and foreign keys of several columns referencing them (cascade, set null, restrict). Shown and typed as `(1,abc)` in DIFF, merges, the shell and the HTTP API. One-column keys keep their stored form: a folder written before reads the same (checked on a fixture written by the previous binary). `chronos import` takes tables whose key has several columns.
- **Spilling to disk:** one-table `GROUP BY` and `ORDER BY` stay within `CHRONOS_WORK_MEM` (256 MB by default), spilling to `CHRONOS_SPILL_DIR`: groups are hashed into files grouped one at a time, sorts write runs and merge them, and `ORDER BY ... LIMIT k` holds only k rows. Hash joins spill too (grace hash join: both sides to files by the joined value's hash, each pair joined alone), at any step of a join. Same answers and order as in memory; `spilled_bytes` in `SHOW METRICS`.
- **`ON CONFLICT` on several columns** and `ON CONFLICT ON CONSTRAINT name`.
- **`ANY` / `SOME` / `ALL`** with any comparison, over subqueries, `ARRAY[...]`, array literals and JSON arrays, with SQL's NULL logic.
- **`RIGHT` and `FULL` joins, and `USING`** (the column shown once, as Postgres does), and **`NULLS FIRST` / `LAST`**.
- **Regular expressions:** `~`, `~*`, `!~`, `!~*`, `regexp_replace`, `regexp_match(es)`, `regexp_like`, `regexp_count`, `regexp_substr`, `regexp_split_to_array/table`, with a built-in matcher that stops runaway patterns.
- **Full-text search as in Postgres:** `tsvector`/`tsquery`, `to_tsvector`, `to_tsquery`, `plainto_`/`phraseto_`/`websearch_to_tsquery`, `@@`, `ts_rank`, `setweight`, `strip`, `||`, with Postgres's `english` stemmer and stop words (identical on 20,000 dictionary words) and `simple`. Floats now print as Postgres prints them (`1e-20`, `1.5e+20`). Array columns (`text[]`, ...), subscripts on arrays and jsonb (`tags[1]`, `doc['a'][0]`) and `string_to_array`. `search('table', 'words' [, k])` in FROM ranks rows with the built-in BM25 index. GIN indexes on a tsvector (`USING gin (to_tsvector('english', body))`) serve `@@`: 12x faster than a scan at 100,000 rows.
- **PostGIS points:** `geometry`/`geography`, `ST_MakePoint`, `ST_Distance` (the exact WGS84 geodesic, matching PostGIS to the printed digit), `ST_DWithin`, `ST_AsText`/`ST_AsGeoJSON` and the other point functions, printed as PostGIS prints them. `USING gist` on a point column makes `ST_DWithin` read only the latitude band it can reach: about 100x faster than a scan at 200,000 points. `<->` and nearest-first `ORDER BY ... LIMIT` from that index (the nearest 10 of 200,000 in about 1 ms), and `CREATE EXTENSION postgis`. An index's second column's range is now checked on each entry before the row is read.
- **Graph traversals use indexes:** a join starts from a subquery's, CTE's or `WITH RECURSIVE` round's rows when they're fewest, so each round looks edges up by index instead of scanning: a 4-round traversal of 200,000 edges went from 30 ms to 1 ms. The shell now runs `WITH`, `EXPLAIN`, `VALUES`, `SET`, `SAVEPOINT` and `RELEASE` as SQL.
- **`SIMILAR TO`** (with `ESCAPE`), `to_char` for numbers (`9 0 . , D G S MI PL SG PR FM`), **unique indexes on expressions or with `WHERE`**, `RANGE` window frames with offsets (numbers and intervals) and `FILTER` on window aggregates, all checked against Postgres.
- **Set-returning functions in FROM:** `generate_series`, `unnest`, `jsonb_array_elements(_text)`, `jsonb_each(_text)`, `jsonb_object_keys`; `ARRAY[...]` and `type[]` casts.
- **`LATERAL` subqueries** (`, lateral (...)`, `CROSS JOIN LATERAL`, `LEFT JOIN LATERAL ... ON`).
- **`WITH` before `INSERT`/`UPDATE`/`DELETE`**, **`UPDATE ... FROM`** and **`DELETE ... USING`**.
- **`FILTER (WHERE ...)`** on aggregates, **`age()`**, **`to_char()`** for dates and times, **`md5()`**.
- **`ALTER TABLE ... ADD PRIMARY KEY`:** rows move to their keys in one step, with constraints and indexes rebuilt.
- **Array parameters** for `= ANY($1)` / `<> ALL($1)`, typed as drivers expect (`int8[]`, `text[]`, ...), in text or binary.
- **pgvector's SQL:** the `vector` type, `<=>`, `<->` and `<#>`, and `CREATE EXTENSION vector` and `USING hnsw` indexes accepted, plus `information_schema.tables`, `public.` names and `DEALLOCATE`, so Mem0's pgvector store runs unchanged (psycopg 2 and 3). With a `USING hnsw` index, `ORDER BY <distance> LIMIT k` gets its candidates from the search index (filters on columns and `jsonb ->> 'key'` included) and re-ranks them exactly.
- **Vectors stored as 4-byte floats** (`Value::Vector`): rows with 1,536-dimension vectors shrink from about 17 KB to 8 KB and read back without parsing numbers; vectors print as pgvector prints them.
- **Vector search puts recall first:** exact scans (1-bit codes with rescoring, more of it below 512 dimensions, or whole vectors for small candidate sets and up to 32 dimensions) on the free cores; HNSW graphs test themselves against the scan when built and are used early only if they find at least 99% of its top 10, otherwise past 8.4M code words (`CHRONOS_SCAN_WORDS`). From 512 dimensions graphs are walked on 1-bit codes (about 6× faster). Vector-only searches no longer fetch 4× the results they return. On real OpenAI embeddings: 99.98% recall@10; on synthetic 500k × 384: 99.8–100% in 0.12–0.83 ms.
- **HNSW graphs link every node:** a pass after building links nodes nothing pointed to (about 0.7% of 76,000 real embeddings were unreachable).
- **`SET hnsw.ef_search`** in SQL and `ef` in `find` set the graph's beam.
- **`CHRONOS_CACHE_MB`** sets the page cache (default 256 MB).
- **Faster Linux and Intel Mac binaries:** the static musl builds use mimalloc instead of musl's malloc, which took most of a vector search's time on Linux, and x86-64 builds assume x86-64-v2, so 1-bit scans count bits with POPCNT rather than a software routine. The vector loops (dot products, 1-bit distances) also come in an AVX2 build, picked at run time on CPUs that have it.
- **Search filters on `field->>key`:** a key of an object field, as SQL's `->>` reads it.
- **`chronos_search_graphs_building` metric:** 1 while an HNSW graph builds in the background.
- **Exact `numeric`:** 38 digits, `numeric(p, s)`, decimal literals typed numeric as in Postgres, Postgres's division scale, exact `sum`/`avg`, order-keeping index keys and the binary wire format. The Postgres importer keeps numeric columns exact.
- **Indexes on expressions** (`lower(email)`, `(doc ->> 'k')`) and **partial indexes** (`WHERE`), kept up by every write, merge, rename and drop.
- **Aggregates:** `string_agg`, `jsonb_agg`, `jsonb_object_agg`, `array_agg` (with their own `ORDER BY`), `bool_and`, `bool_or`, `every`.
- **jsonb operators and functions:** `->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `||`, `jsonb_build_object`, `jsonb_set`, ...; jsonb prints in Postgres's form.
- **40 more functions:** text (`concat`, `substring ... from ... for`, `position ... in`, `trim(leading ... from ...)`, `split_part`, `lpad`, `initcap`, ...), math (`ceil`, `floor`, `trunc`, `power`, `sqrt`, `ln`, `log`, `mod`, `greatest`, `least`, `random`, ...), `nullif`, `make_date`, `to_timestamp`. All checked against Postgres.
- **Named windows:** `WINDOW w AS (...)` and `OVER w` / `OVER (w ORDER BY ...)`.
- **`time`**, with its arithmetic, casts, `extract`, indexes and the Postgres binary format.
- **Checked against Postgres:** tests/pgdiff.rs runs each new feature's statements on Chronos and on a real Postgres and compares every result.

**Interfaces**
- **HNSW graph for vector search:** fields with 50,000+ vectors get a graph index, built in the background. Unfiltered and broad searches walk it (about 18× faster than the scan at 500k × 384: 0.25 ms vs 4.6 ms, 98.6% recall@10), and narrow filters keep the exact scan. It works inside branches.
- **B-tree indexes:** `CREATE [UNIQUE] INDEX` and `DROP INDEX`, one or more columns. They answer `=`, ranges, `BETWEEN`, `IN`, `IS NULL` and `LIKE 'prefix%'`, and `ORDER BY ... LIMIT` reads them in order, forwards or backwards (the latest 20 of 100,000 rows: 230 ms to 0.04 ms). Entries are rows, so forks share them and crashes recover them; merges rebuild them for the rows they change.
- **`EXPLAIN [ANALYZE]`** in Postgres's layout: which index or key each table is read through, with row counts and time under `ANALYZE`.
- **`CHECK` constraints,** kept on every write and merge.
- **Savepoints:** `SAVEPOINT`, `RELEASE` and `ROLLBACK TO`, as forks of the transaction.
- **Postgres comparison suite:** 1,000 random app-style queries return the same rows as Postgres, and none reads a whole table where Postgres uses an index.
- **SQL, with our own engine:** `CREATE TABLE`, `INSERT`, `SELECT` on one table, `UPDATE`, `DELETE`, `RETURNING` and `$n` parameters.
- **Big reports use every core:** scans, hash joins and `GROUP BY` over more than about 8,000 rows split across all the cores the machine (or container) allows, with the same answers on any machine; `CHRONOS_THREADS` overrides. Scans also no longer copy each key, and `LIKE` no longer allocates. Hash-join tables are built on every core too, and scans drop columns only their own filters read. A 200,000-row join with `GROUP BY` went from 214 ms to 34 ms on 8 cores (Postgres: 45 ms), and all five report benchmarks beat Postgres. Two-table joins then join each part of the first table as it is read, and group it there for exact aggregates, so neither the table nor the joined rows are held in full (join + `GROUP BY` 33.9 → 29.4 ms). Integer `sum`/`avg` add in 128 bits: only the total has to fit.
- **JSON writes follow SQL's rules:** `put`/`delete`/`batch` into SQL tables check columns, types, `NOT NULL`, keys, `UNIQUE` and foreign keys, fill in defaults, and store rows packed; `_sonos_` keys are reserved.
- **Window functions and WITH RECURSIVE:** ranking, `lag`/`lead`, `first`/`last`/`nth_value` and aggregates over partitions and frames; recursive queries for trees and graphs, with a guard against runaway loops.
- **Subqueries and set operations:** scalar, `IN` and `EXISTS` subqueries (correlated too), `UNION` / `INTERSECT` / `EXCEPT` [`ALL`], subqueries in `FROM`, and `WITH`.
- **UNIQUE constraints and foreign keys:** `ON DELETE CASCADE` / `SET NULL` / `RESTRICT`, kept with index rows. Checked on every statement and every merge, so branches can't combine into a violation. Upserts can target unique columns, and psql's `\d` shows them.
- **Upserts and CASE:** `INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` with `EXCLUDED`, and `CASE` expressions.
- **App features in SQL:**
  - `ALTER TABLE` (add, drop, rename, retype columns, rename tables, defaults, `NOT NULL`), with versioned row layouts, so no rows are rewritten and branches merge across schema changes.
  - `serial` and identity columns on a sequence shared by all branches, and `gen_random_uuid()`.
  - `date`, `timestamp`, `timestamptz` and `interval`, with calendar arithmetic, `now()`, `date_trunc` and `extract`.
  - psql's `\d`, `\dt` and `\l`.
- **Batch execution:** rows flow through queries in flat batches, decoded into reused buffers, with fast hash tables for joins and grouping.
- **Join ordering:** inner joins start from the most selective table, and small driving sides look matches up by key or index.
- **Packed rows:** SQL tables store rows packed instead of as JSON (about 2× faster column reads, half the size). They're shown as JSON everywhere outside SQL.
- **Joins and grouping in SQL:** inner, left and cross joins (primary-key lookup and hash joins), `GROUP BY`, `HAVING`, `DISTINCT`, `count`/`sum`/`avg`/`min`/`max`, and `coalesce`, `lower`, `upper`, `length`, `abs`, `round`.
- **Branches and transactions in SQL:** `CREATE BRANCH`, `USE BRANCH`, `DIFF`, `MERGE BRANCH`, `DROP BRANCH` and `SHOW BRANCHES`. `BEGIN`/`COMMIT`/`ROLLBACK` run on hidden branches: snapshot reads, and a conflicting commit fails with 40001.
- **The Postgres protocol:** `psql` and Postgres drivers connect to `chronos serve` on port 5433; the database name is the branch.
- **The `chronos` shell.**
- **`chronos mcp`** for Claude Code and other MCP agents.
- **`chronos serve`,** an HTTP JSON API with a token for non-local listening.
- **One-file TypeScript and Python clients.**

**Operations**
- **Encryption at rest:** `chronos keygen`, then `CHRONOS_KEY` (or `CHRONOS_KEY_FILE`, or `Db::open_encrypted`) encrypts a new database: log records, manifests, history and pages (with keyed page names), so backups and cloud copies are encrypted too. ChaCha20-Poly1305; tampering is refused; a wrong or missing key fails on open.
- **TLS** on both ports of `chronos serve` (`--tls-cert`, `--tls-key`): HTTPS, and TLS required on the Postgres protocol. The HTTP server is now Chronos's own (keep-alive, `Expect: 100-continue`), replacing tiny_http.
- **Migrations:** `chronos mydb migrate migrations/` applies new `.sql` files in name order, each in one transaction with a record and checksum. Applied files are skipped, and edited applied files are refused. `-b world` tries them on a world first.
- **Backups while running:** `BACKUP DATABASE TO`, the `backup` HTTP op or `backup` in the shell. A backup is a consistent copy with worlds and history, written into a new folder and renamed into place when done. `chronos restore` starts a database from one and verifies it. `VERIFY DATABASE` reads every page and log record and checks each one.
- **Metrics:** count and p50/p95/p99/max latency of every kind of statement, commit, log sync, fork, diff, merge, search, checkpoint and cleanup, plus rows written, errors, conflicts, worlds and bytes on disk. `SHOW METRICS` in SQL, `GET /metrics` for Prometheus.

**Tests**
- **Crash suite:** 10,000 runs.
- **Crashes during checkpoints and cleanup:** a child process is killed at each of 232 steps. Every time, the folder reopens with the same rows and verifies.
- **Crashes during schema changes:** the log is cut at every record and at random bytes, and the database comes back as it was after a whole number of statements.
- **Deterministic simulation** with shuttle.
- **Jepsen-style `kill -9` test.**
- **Brute-force checks** for search.
- **End-to-end tests** of both clients and the agent examples.
- **A search latency budget in CI.**

**Fixed before release, both found by the Jepsen-style test**
- **Lost updates:** a merge that skipped rows the parent had changed to the same value lost updates (two debits became one).
- **Silent crash loss:** merging a branch whose writes died in a crash reported success.

**Fixed before release, found writing the crash tests**
- **History files after a power cut:** a history manifest was renamed into place before it reached the disk, so a power cut could leave an empty one, and cleanup would then fail every time. Each one is now written and synced before its rename.

**Fixed before release, found while adding UPDATE ... FROM**
- **A subquery could get another's answers:** subquery results were cached by where the subquery sat in memory, and a later one can reuse that spot in the same statement (UPDATE drops its WHERE's before binding its SET's). They're now cached by what the query is.

**Fixed before release, found by an independent review**
- **Agents could make themselves admin:** SQL could update `_sonos_agents` in an agent's own world, and merging that world granted the rights. It also hid from `DIFF`. SQL now can't reach any `_sonos` table.
- **Row quotas undercounted:** SQL statements, transactions, restores and merges into a world were checked as zero rows. `max_changes` is now enforced where rows are written, so every row counts. A restart used to reset the count; a world's earlier changes now count after one.
- **The database's own tables over HTTP, MCP and the shell:** `get`, `put` and `find` on `_sonos` tables are refused, as in SQL.
- **ADD COLUMN dropped its constraints:** `REFERENCES`, `UNIQUE` and `CHECK` on an added column were silently ignored; they're now added as `ADD CONSTRAINT` adds them.
- **Diffs showed agents' token hashes:** a diff of main (over HTTP, MCP or the shell) listed `_sonos_agents` rows. Diffs now leave out the database's own rows, except table schemas.
- **Stopping `chronos serve` lost writes:** SIGTERM or Ctrl-C killed it like a crash, losing a world's acknowledged, unsynced writes and marking it crashed. It now closes the database cleanly first.
- **A merge dry run hid the crash mark:** it now says the merge will need CONFIRM.
- **Agents over MCP and HTTP were checked more strictly than over Postgres** (UNDO MERGE needed admin). Their SQL now runs in a session acting as the agent, checked the same way everywhere.
- **Agents rebuilt the past wrong:** time travel and UNDO MERGE run by an agent re-checked the replayed writes against its quota and skipped them. Replay now runs as nobody.
