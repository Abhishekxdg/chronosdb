# Benchmarks

> The numbers and methods are public; the harness code that produced them lives with the engine's source, which is private.

**Hardware.** Sections 1–7 come from one machine: an Apple M2 (8 cores) with 8 GB of RAM, running macOS 26. Section 8 reruns the losses on a Linux server (4 vCPUs, 32 GB). Sections 9–12 are on the same M2, while other sessions were building and benchmarking on it, so each gives its load average. The data is synthetic and deterministic, and every run uses the same seeds, except the real embeddings of sections 6 and 8.

**What that means for the numbers.** Disk timings on macOS vary a lot from run to run, because `fsync` (`F_FULLFSYNC`) takes a variable amount of time. Wherever runs differed, a range is given. The 8 GB of RAM also limited how big the search tests could get. These are laptop numbers, not published results; the plan is to rerun them on a machine with 16 GB or more before quoting them.

**Rerunning them.** Every harness is in `examples/`, so anyone can rerun them. Losses are reported here along with the wins.

## 1. Forks and concurrent writes (Phase 1 kill gate: 10× Postgres)

`cargo run --release --example bench -- 10 100 1000`, with 100k seed rows in main. Each agent forks main, writes 1,000 rows and merges back.

| agents | system | fork p50 | merge p50 | total time | agent rows/s |
|---|---|---|---|---|---|
| 10 | Chronos (memory) | 0.002 ms | 4.3 ms | 0.01 s | 938k |
| 10 | SQLite (file copy) | 0.6 ms | 308 ms | 0.56 s | 17.8k |
| 10 | Postgres (template DB) | 9,662 ms | 246 ms | 10.6 s | 945 |
| 100 | Chronos (memory) | 0.001 ms | 45 ms | 0.11 s | 892k |
| 100 | SQLite | 2.2 ms | 2,335 ms | 10.3 s | 9.7k |
| 100 | Postgres | 9,482 ms | 332 ms | 44.5 s | 2.2k |
| 1,000 | Chronos (memory) | 0.001 ms | 736 ms | 1.6 s | 631k |
| 1,000 | SQLite | 12,097 ms | 14,703 ms | 730 s | 1.4k |
| 1,000 | Postgres | 10,388 ms | 348 ms | 533 s | 1.9k |

With durability on (`chronos-disk` in the same harness: write-ahead log, fsync on merge, background checkpoints), three runs after the final Phase 2 changes gave:
- **10 agents:** 268k–477k rows/s.
- **100 agents:** 666k–787k rows/s.
- **1,000 agents:** 365k–646k rows/s.

**Verdict:** even on disk, Chronos is about 190–340× Postgres at 1,000 agents. The gate passes.

**How the baselines were set up:**
- **SQLite:** a branch is a file copy, and the merge is a full-table `EXCEPT`, because file copies don't track changes. It's capped at 64 workers by the macOS file-descriptor limit.
- **Postgres:** a branch is `CREATE DATABASE … TEMPLATE`. The template can't have connections, so agents fork a frozen copy rather than live main. The merge replays the agent's known writes, which is a generous shortcut. It's capped at 25 workers because `max_connections` is 100.

**Losses and caveats:**
- **Merge queueing:** Chronos's median merge at 1,000 agents is slower than Postgres's (736 ms vs 348 ms), because merges into `main` queue behind each other. A single merge takes about 4 ms. **Unfair setup:** the Chronos run had one thread per agent (1,000 merges queued at once), while Postgres was capped at 25 workers. At the same 25 workers (`WORKERS=25`), the Chronos median is 39–46 ms. See section 8.
- **Forks under heavy load:** fork p99 at 1,000 agents reaches about 190 ms, from scheduling 1,000 OS threads on 8 cores.

## 2. Vector search vs Postgres + pgvector (Phase 1 kill gate: 5× pgvector)

`N=500000 OVERSAMPLE=100 EF=300 cargo run --release --example search`: 500k × 384-dimension synthetic clustered vectors, top 10, 500 queries per filter mix.

Postgres got one documented tuning pass:
- `shared_buffers = 2GB`, with the table and index prewarmed.
- HNSW with `ef_search = 300`.
- `hnsw.iterative_scan = relaxed_order`.

| filter | Chronos p50 | pgvector p50 | Chronos recall@10 | pgvector recall@10 |
|---|---|---|---|---|
| none | 2.0 ms | 47.7 ms | 100% | 97.2% |
| 10% | 1.5 ms | 93.1 ms | 100% | 97.0% |
| 1% | 0.50 ms | 20.2 ms | 97.3% | 80.0% |
| 0.1% | 0.17 ms | 9.2 ms | 100% | 100% |

**Verdict:** 24–64× pgvector at p50. The gate passes.

**Rerun after the vector search changes of section 6** (Chronos DB alone, `N=500000 ONLY=chronos OVERSAMPLE=100 Q=300`): no filter 0.41 ms at 99.8%, 10% 0.83 ms at 100%, 1% 0.50 ms at 100% (was 97.3%), 0.1% 0.12 ms at 100%. The graph tested itself at 99.5% of the scan's top 10, so unfiltered searches walk it.

**Losses and caveats:**
- **Noisy worst cases on both sides:** p99 was unreliable, because 8 GB of RAM with both engines loaded caused swapping. Chronos p99 ranged from 0.8 to 9.8 ms, pgvector from 1 to 3 s.
- **Untuned Postgres was disk-bound:** before tuning, with its default 128 MB `shared_buffers`, it took over 1.5 s per query at the 1% filter.
- **1M rows untested here:** the run at 1M × 384 didn't fit in 8 GB, so it still needs a bigger machine.

## 3. Hybrid search inside branches (Phase 3 targets: p99 < 5 ms at 1M, fork within 10% of main)

`N=1000000 cargo run --release --example find`: 1M rows, 64-dimension vectors, and a fork with 500 changed rows.

| query | main p50 | main p99 | fork / main (p50) |
|---|---|---|---|
| filter (1%) | 0.02 ms | 0.03–0.12 ms | 0.92–1.09× |
| text | 0.27 ms | 0.7–1.2 ms | ~0.8× |
| vector + filter (20%) | 0.7–0.8 ms | 1.2–4.3 ms | 0.83–1.05× |
| vector, no filter | 1.5–2.0 ms | 2.1–5.6 ms | 0.76–0.99× |
| filter + text + vector | 0.85–1.0 ms | 1.7–2.2 ms | 0.88–1.17× |
| repeated query | 0.003 ms | 0.003 ms | 1.0× |

**Verdict:** hybrid search p99 is about 2 ms at 1M rows, and forks search as fast as main. Both targets are met, within run-to-run noise of about ±15%.

**Caveats:**
- **Unfiltered vector search** reached 5.6 ms p99 in one run, over the 5 ms target. The other runs were 2–3 ms.
- **Only 64 dimensions tested at 1M;** 384 dimensions at 1M needs a bigger machine.
- **Rerun after the vector search changes of section 6:** vector + filter 0.89 ms (p99 1.2 ms), vector alone 2.15 ms (p99 3.0 ms), filter + text + vector 2.28 ms (p99 3.7 ms), forks within 7% of main. Still under the 5 ms target, but the hybrid median rose from about 0.9 ms: 64-dimension searches now rescore 8× more candidates, which took unfiltered recall@10 at 1M from 91.2% to 99.4% (`N=1000000 DIM=64 ONLY=chronos cargo run --release --example search`).

## 4. SQL over the Postgres protocol

`chronos serve` on one side and Postgres 16 on the other, both over TCP on the same laptop, with the Rust `postgres` driver (binary values) and `N=10000 cargo run --release --example sql`. The workload:
- 10,000 single-row inserts, each its own commit.
- 10,000 more rows in 1,000-row statements.
- 10,000 lookups by primary key.
- 1,000 updates by key.
- 50 queries of `age = $1 AND name LIKE $2` over 20,000 rows. Chronos answers these from its search index; Postgres has no index on `age`.

| system | inserts/s | batch rows/s | lookup p50 | lookup p99 | update p50 | filtered query p50 |
|---|---|---|---|---|---|---|
| Chronos | 341 | 125k | 40 µs | 85 µs | 3.0 ms | <1 ms |
| Postgres, flushing to disk like Chronos (`wal_sync_method=fsync_writethrough`) | 322 | 130k | 40 µs | 86 µs | 4.5 ms | 1 ms |
| Postgres, macOS default (`open_datasync`) | 9,275 | 484k | 40 µs | 54 µs | 0.12 ms | 1 ms |

**Verdict:** at equal safety, Chronos matches Postgres on writes and lookups and is faster on updates and on filtered queries.

**Joins and grouping.** Run over the same 20,000 rows, plus a 20,000-row `sql_orders` table pointing at them. These are reads, so the durability setting doesn't matter.

| query | Chronos (JSON rows) | Chronos, one core | Chronos now | Postgres |
|---|---|---|---|---|
| one order joined to its row by primary key | 62 µs | 62 µs | 62 µs | 56 µs |
| `count(*)` of orders joined to rows `WHERE age = $1` | 8.4 ms | 1.1 ms (with join ordering) | 1.1 ms | 2.6 ms |
| `GROUP BY age` with `count(*)`, `max(name)` | 10.0 ms | 5.5 ms | 2.2 ms | 8.1 ms |
| join of both tables, then `GROUP BY` with `sum` | 24.5 ms | 11.7 ms | 3.9 ms | 6.9 ms |

**Packed rows.** SQL tables now store rows packed (see [SQL](docs/sql.md#storage)) instead of as JSON, which cut the cost of reading a column by more than half. `GROUP BY` now beats Postgres.

**Join ordering.** The filtered join now starts from the 222 rows `age = $1` picks through the index, then looks their orders up through the index on `ref`, so it never reads all 20,000 orders. That makes it 2.4× faster than Postgres.

**Batches.** Rows move through a query in flat batches (one buffer for many rows), each stored row is decoded into one reused buffer, and join and group tables use a fast hash. Whole-table joins went from 16.1 ms to 11.7 ms, and `GROUP BY` from 6.5 ms to 5.5 ms.

**Every core.** Big scans, hash-join probes and `GROUP BY` now split across the machine's cores (see [SQL](docs/sql.md#speed)). Whole-table joins went from 11.7 ms to 4.4 ms and now beat Postgres, and `GROUP BY` went from 5.5 ms to 2.4 ms.

**Bigger reports.** `cargo run --release --example report`: 200,000 rows in each table, Chronos in process against the same tables in Postgres 16 over local TCP (Postgres with its default of 2 parallel workers per query). Milliseconds per query, M2 with 8 cores (4 fast, 4 efficiency):

| query | Chronos, one core | Chronos, 8 cores | Postgres |
|---|---|---|---|
| `count(*)` of orders | 15.9 | 4.8 | 6.8 |
| `count(*)` of orders `WHERE amount > 500` | 30.0 | 6.6 | 8.4 |
| `GROUP BY age` with `count(*)`, `max(name)` | 55.5 | 15.1 | 45.6 |
| join of both tables, then `GROUP BY` with `sum` | 123.9 | 29.4 | 47.8 |
| `count(*)` of the join `WHERE name LIKE 'user 1%'` (111,111 users) | 107.1 | 22.5 | 29.4 |

Before this round, on one core, those were 26, 37, 63, 214 and 217 ms. Walking the table without copying each key, a hash index with no list per value, and `LIKE` without allocating account for the one-core gains; the cores do the rest. The join's hash table is also built on every core (rows split by hash into partitions, each indexed on its own), and a scan drops columns only its own filter reads (here `name`, once `LIKE` has passed it).

**Joining while reading.** A two-table join no longer reads its first table whole before joining: each core reads a part of it, joins that part through the other table's hash index, and, for `GROUP BY` with exact aggregates, groups it right there. Neither the first table nor the joined rows are ever held in full. Join + `GROUP BY` went from 33.9 ms to 29.4 ms and the filtered join from 26.3 ms to 22.5 ms. Queries whose first table filters down to 1,000 rows or fewer still look their matches up by key (the 1.1 ms filtered join over the protocol is unchanged).

**Where the time goes now:** about a third of these joins is reading and indexing the other table (200,000 users), which joining while reading doesn't change.

**Why the macOS default is so much faster at commits:** it doesn't flush the drive's cache, so a power cut can lose commits it acknowledged. By default Chronos flushes the drive's cache (`F_FULLFSYNC`); `alter system set synchronous_commit = normal` makes it do what Postgres does there (a plain `fsync`), and `off` stops waiting for the disk at all. The Linux comparison is in section 8: it found a real gap (Chronos's log file grew on every commit), now closed.

**Other caveats:**
- **The protocol itself** costs about 31 µs per round trip over TCP for Chronos, and about 35 µs for Postgres over TCP (25 µs over a Unix socket, which Chronos doesn't offer yet).
- **Engine-only timings** are 2.8 µs for a lookup by key and about 1.4 µs per inserted row, plus about 0.4 µs per row to parse a long `VALUES` list.

## 5. Crash safety

These are correctness checks, not speed, but they belong on the record.

| Test | What it does | Result |
|---|---|---|
| Crash suite (`CRASH_RUNS=10000`) | Cuts the log at random bytes, with torn-write garbage and cleanup, then recovers | 10,000/10,000 recover exactly the operations that reached disk |
| Deterministic simulation (`--features shuttle`) | Agents, direct writes, checkpoints and cleanup, all interleaved under controlled schedules | Passes. Found a planted ordering bug within about 3,000 schedules. |
| Jepsen-style (`JEPSEN_KILLS=20`) | `kill -9` the server during concurrent fork/merge bank transfers | See below |

**What the Jepsen-style test found.** It found two real bugs before this release, and both are fixed:
1. **Money created from nothing.** A merge treated "both sides wrote the same value" as no conflict. Two transfers that each debited an account from 100 to 90 became one, so money appeared. Merges now use first-merge-wins for rows both sides wrote.
2. **Silent loss after a crash.** A branch's last write died with the process, the server restarted in milliseconds, and the client's merge of the now-empty branch returned success. Writes now return versions, merges check them, and branches open during a crash are flagged until confirmed.

After the fixes, 15 runs of 20 kills each passed with no failures: 300 `kill -9`s and 108,178 confirmed transfers checked, none lost, and every balance matched the ledger.

## 6. Vector search vs other vector databases, on real embeddings

`python bench/vector_dbs.py` (see its header). **Data:** 76,924 real OpenAI embeddings (1,536 dimensions) of DBpedia entities, from Hugging Face's `KShivendu/dbpedia-entities-openai-1M` (its first two files). The last 500 are the queries and the other 76,424 are stored. **Filter:** each stored row gets a user (row % 100), so "one user" keeps 1% of the rows, as a memory layer such as Mem0 filters every search. **Method:** one client, one query at a time, query inputs prepared before timing, 20 warm-up queries, top 10, each system at its defaults. Recall@10 is measured against exact brute force over the same rows.

Chronos DB is queried through SQL over the Postgres protocol, exactly as Mem0's pgvector store queries it (`ORDER BY embedding <=> $1::vector LIMIT 10`, with `payload->>'user_id' = $2` for one user), after `CREATE INDEX ... USING hnsw`.

| system | load | index | all rows: p50 | p99 | recall@10 | one user: p50 | p99 | recall@10 |
|---|---|---|---|---|---|---|---|---|
| **Chronos DB** (SQL) | 42.0 s | 35.7 s | **1.00 ms** | 4.89 ms | **99.98%** | **0.75 ms** | 5.62 ms | 100% |
| LanceDB (embedded, IVF_HNSW_SQ) | 1.2 s | 23.9 s | 1.71 ms | 3.20 ms | 85.4% | 2.44 ms | 3.89 ms | 97.1% |
| Chroma (embedded) | 85.9 s | (in load) | 3.44 ms | 9.35 ms | 93.3% | 75.5 ms | 136 ms | 100% |
| Postgres 17 + pgvector 0.8.4 | 75.0 s | 252.0 s | 4.06 ms | 6.89 ms | 82.5% | 10.1 ms | 14.8 ms | 100% |
| Qdrant 1.19 (Docker) | 144.7 s | 14.5 s | 5.14 ms | 17.9 ms | 93.6% | 4.22 ms | 11.3 ms | 100% |

**Verdict:** the fastest median and the best recall of the five, over all rows and for one user.

**How it got here** (all on this data, same laptop):

| Chronos DB change | all rows: p50 | recall@10 |
|---|---|---|
| pgvector SQL, comparing every row | ~350 ms (at 20k × 768) | 100% |
| `ORDER BY` through the search index's graph | 15.3 ms | 95.6% |
| reading only the rows returned, by key | 4.7 ms | 94.0% |
| vectors stored as 4-byte floats, not JSON | 1.3 ms | 91.0% |
| exact 1-bit scan unless the graph proves itself (it scored 97%) | **1.0 ms** | **99.98%** |

**Why not the graph on this data:** the graph walked on 1-bit codes answers in about 0.35 ms at a beam of 400, but finds only 92.8% of the true top 10: DBpedia holds many near-duplicate entities, and a graph navigates poorly among them. The 1-bit scan with full-precision rescoring finds 99.98% in about 0.6 ms (`examples/walk.rs`). Chronos DB measures its graph when it's built and uses it only if it scores at least 98% against the scan; on synthetic clustered vectors (section 2) it scores 99.5% and is used.

**Losses and caveats:**
- **One run on a loaded laptop.** 8 GB of RAM with about 9–10 GB of swap in use from other programs, so p99s are noisy (Chronos DB's worse p99 than LanceDB's likely includes that; it hasn't been separated). On a 32 GB Linux machine (section 8), Chronos DB's p99 is 6.38 ms against LanceDB's 17.07 ms.
- **Defaults, not tuned to equal recall.** pgvector's `ef_search` is 40 and LanceDB's IVF index scans few partitions by default; raising them buys recall with time. A recall-versus-latency curve per system is the fairer comparison and hasn't been run.
- **In-process vs over the network:** LanceDB and Chroma answer in the benchmark's own process; Chronos DB, Postgres and Qdrant answer over TCP.
- **Loading** differs by client: Chronos DB and Postgres get `INSERT`s of 1,000 rows per transaction with vectors as text, Qdrant batched upserts over HTTP, Chroma and LanceDB in-process writes. Chronos DB's "index" time includes building its search index and graph and the graph's self-test.
- **The load times above include Python** turning every float into text: at 20,000 rows that alone took 18.4 s, more than the database's own work. The harness now leaves each client's row conversion out of load time, and sends 100 rows per `INSERT` (section 8).
- **Chronos DB's memory:** the server held about 830 MB after the run.
- **What only Chronos DB was asked to do:** every row is also in a world that can fork in about a microsecond (section 1); no other system here can branch.

## 7. Undoing an agent

`ROWS=500000 AGENT=100000 OTHERS=50000 cargo run --release --example undo_agent`: 500k rows in main. An agent changes 100k of them straight in main (no world, no approval), in ten 10k-row statements. Then a person changes 50k other rows and 100 of the agent's.

| step | time |
|---|---|
| load 500k rows | 12.0 s |
| the agent's 100k changes | 12.6 s |
| `UNDO AGENT bot SINCE ... SKIP CHANGED` | 6.2 s |

**Result:** 99,900 rows put back and 100 left as the person changed them. None of the agent's values remain, and all 50,100 of the person's changes are kept.

**Where the time goes:** the undo rebuilds history from the checkpoint before the moment named, then replays the log up to now. Its cost grows with how much was written since that checkpoint, not with the size of the database. Undoing something from weeks ago with a busy log in between will take longer; indexing changes by agent would fix that.

## 8. The losses, rerun on Linux

**Machine:** GCP e2-highmem-4 (4 vCPUs, 32 GB, x86-64, Ubuntu 24.04, balanced persistent disk), glibc builds, no swap in use. **Before** is `main` at `0b4f867`; **after** is the `losses` branch at `b5ae045`. Each harness ran against both builds back to back, under the machine's shared benchmark lock, starting with a load average under 1. **Others:** Postgres 17.11 and pgvector 0.8.6 at their defaults (on Linux, `fdatasync` on commit, which flushes like Chronos), and LanceDB 0.39 embedded.

**Where each loss stands:**

| loss (from sections 1, 4, 6) | cause found | now |
|---|---|---|
| merge median at 1,000 agents: 736 ms vs 348 ms | the setup: 1,000 Chronos threads merging at once against 25 Postgres workers | at 25 workers each: Chronos 46 ms, Postgres 1,157 ms |
| vector p99: 4.89 ms vs LanceDB 3.20 ms | swap on an 8 GB laptop; the x86 build had no `POPCNT` (a software bit count) | Chronos 6.38 ms, LanceDB 17.07 ms |
| load + index: 77.7 s vs LanceDB 25.1 s | Python formatting floats inside the timed load; the index turning every vector into text and back | load 20.0 s + index 44.8 s = 64.8 s; LanceDB 2.0 s + 86.2 s = 88.2 s |
| commits: 341/s vs Postgres's 9,275/s (macOS) | macOS: Postgres doesn't flush the drive's cache. Linux: Chronos's log file grew on every commit | Linux: Chronos 644–806/s, Postgres 591–656/s |
| single-key join: 62 µs vs 56 µs | per-query planning and schema work, more than the join itself | Chronos 71 µs, Postgres 92 µs (medians of 5 interleaved rounds) |

**Merges.** `examples/bench.rs`, 1,000 agents each writing 1,000 rows over 100k seed rows. `WORKERS=25` caps Chronos at the Postgres run's 25 workers.

| setup | before p50 | after p50 | after p99 |
|---|---|---|---|
| Chronos in memory, one thread per agent | 1,788 ms | 1,486 ms | 2,702 ms |
| Chronos in memory, 25 workers | 49.8 ms | 45.8 ms | 126 ms |
| Chronos on disk, 25 workers | 68.3 ms | 68.1 ms | 172 ms |
| Postgres 17, 25 workers | | 1,157 ms | 2,077 ms |

A merge now reads both values of each changed row from the overlays' own diff instead of looking every key up twice. That halved a 1,000-row merge on the M2 (3.9 to 2.0 ms), but moved it much less here. What merges still hold the lock for is setting each row in main's map and checking it hasn't changed: about 2 µs a row, in order. Postgres is slower on this machine than on the M2 (its merge replays 1,000 upserts in one transaction, then commits on a network disk).

**Commits.** `examples/sql.rs`, one client, 10,000 single-row inserts, each its own commit.

| | inserts/s | update p50 |
|---|---|---|
| Chronos before | 258 | 3.4 ms |
| Chronos after | 614 | 1.8 ms |
| Postgres 17 (`fdatasync`) | 638 | 1.3 ms |
| Chronos after, `synchronous_commit = off` | 11,812 | 0.08 ms |

**Why Chronos was slow at commits on Linux:** each commit did exactly one `fdatasync` (checked with `strace`), but on a log file that had just grown. The file system then also has to commit the new file size to its journal. On this disk, 4 KB writes each followed by `fdatasync` ran at 351/s when appending and 1,311/s when overwriting space already written. Postgres fills its WAL segments with zeros ahead of time for this reason. The live log segment now does the same, 4 MiB ahead (see `disk.rs`).

**Caveat:** another job shared the CPU during this section. Chronos's reads here were about twice as slow as in the runs before and after, while its commits are bound by the disk rather than the CPU. In a first run with the machine busy (load average 9), before the change, Chronos did 384–392/s and Postgres 965/s.

**Rerun of this section:** before, after and Postgres back to back, twice. The machine was busier in the first round, so compare within a round.

| round | Chronos before | Chronos after | Postgres 17 |
|---|---|---|---|
| 1: inserts/s | 229 | 644 | 591 |
| 1: update p50 | 4.4 ms | 1.7 ms | 1.6 ms |
| 2: inserts/s | 342 | 806 | 656 |
| 2: update p50 | 2.8 ms | 1.6 ms | 1.4 ms |

**Joins.** One order joined to its row by key, prepared once, with the Rust `postgres` driver. The three ran interleaved: 5 rounds of 8 seconds each, over 20,000 rows in each table. The "after" build is `461e896`.

| | p50 per round | median | best |
|---|---|---|---|
| Chronos before | 163, 91, 126, 109, 97 µs | 109 µs | 91 µs |
| **Chronos after** | 73, 70, 71, 66, 71 µs | **71 µs** | **66 µs** |
| Postgres 17 | 92, 69, 69, 92, 125 µs | 92 µs | 69 µs |

**What changed.** A profile of this query showed the server spending more time planning than joining: loading and cloning each table's schema, building the plan, and copying the whole query to fold vector literals it didn't have. Now:
- **A prepared plain `SELECT` plans once.** "Plain" means tables with schemas, no subqueries, and no `AS OF`, set-returning functions or `WITH` in `FROM`. It keeps its tables and plan between executions. Each execution checks that the tables' stored schemas, the world and the parameter types are the ones it planned with, so a column added, a table made again or another world's schema plans afresh (`tests/sql.rs`, `prepared_plan_follows_schema_changes`).
- **Queries without a distance operator skip the vector-folding copy.**
- **Statements and bound parameters are shared**, not copied on every execute, and trace text is built only when tracing is on.

What remains in the profile is the two key lookups the join needs.

**Not done:** clients that describe every execution (psycopg does; the Rust driver doesn't) still have the result's columns worked out each time, which costs about as much as the query itself.

**Vectors.** `bench/vector_dbs.py`, the section 6 data (76,424 × 1,536). Each client's conversion of rows is now left out of load time, and SQL rows go 100 per `INSERT`.

| system | load | index | all rows: p50 | p99 | recall@10 | one user: p50 | p99 | recall@10 |
|---|---|---|---|---|---|---|---|---|
| Chronos DB before | 20.9 s | 92.0 s | 3.46 ms | 8.37 ms | 96.3% | 2.24 ms | 8.82 ms | 100% |
| **Chronos DB after** | 20.0 s | **44.8 s** | **3.38 ms** | **6.38 ms** | **96.8%** | **2.41 ms** | **7.57 ms** | 100% |
| LanceDB 0.39 (embedded) | **2.0 s** | 86.2 s | 12.04 ms | 17.07 ms | 86.4% | 16.01 ms | 20.96 ms | 97.0% |
| Postgres 17 + pgvector 0.8.6 | 35.4 s | 159.1 s | 3.80 ms | 7.22 ms | 83.9% | 29.17 ms | 37.35 ms | 100% |

**Index build:** the search index used to get every row as JSON, with each vector written out as decimal text and parsed back (about 117 million floats each way here). It now takes vectors as stored. The build halved, and at 20,000 rows it went from 10.1 s to 2.8 s.

**Still losing:**
- **Loading:** LanceDB takes an Arrow table in its own process, while Chronos DB gets rows over the Postgres protocol. These runs sent vectors as text; the harness now sends them in binary (pgvector's `register_vector`), which hasn't been rerun here. `COPY` would be next.

**Other caveats:**
- **Recall in these runs was 96–97%**, against 99.98% on the M2. On this data the graph passed its self-test here, and then served searches it was worse at. Since `62620e2` the self-test uses probes close to, but not on, stored vectors, and the bar is 99%. The graph no longer passes it here, and the latest build finds 100% of the top 10, the same as with the graph turned off (`CHRONOS_VECTOR=flat`), in three runs.
- **Same machine, back to back:** the old and new builds share this machine and harness. This machine is slower per core than the M2, so compare across rows, not with the M2's tables above.

## 9. Many worlds: 10 to 100,000

`SWEEP=1 ROWS=100000 cargo run --release --example worlds`: for each size, a fresh database on disk with 100,000 rows in main, then that many worlds forked from main, each writing one row of its own. Same M2 with 8 GB, but shared: other sessions were compiling and benchmarking, so the load average was 70–90 during this run (8 cores) with about 6 GB of swap in use. Memory is the process's physical footprint (what `top` shows, swapped pages included); CPU is user + system time for the forks and writes.

| worlds | fork p50 | fork p99 | first write p50 | write p99 | point query, main / world | aggregate, main / world | disk after checkpoint | disk per world | memory added | per world | CPU | checkpoint | reopen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 2.1 µs | 65 µs | 12 µs | 371 µs | 160 / 16 µs | 15.5 / 22.7 ms | 6.1 MB | 447 B | 0.1 MB | — | 0.00 s | 88 ms | 12 ms |
| 100 | 2.0 µs | 19 µs | 10 µs | 269 µs | 43 / 27 µs | 10.9 / 13.5 ms | 6.2 MB | 437 B | 0.0 MB | — | 0.00 s | 31 ms | 4 ms |
| 1,000 | 2.1 µs | 10 µs | 11 µs | 87 µs | 30 / 20 µs | 11.1 / 13.9 ms | 6.6 MB | 442 B | 2.5 MB | 2.5 KB | 0.01 s | 39 ms | 7 ms |
| 10,000 | 2.1 µs | 7 µs | 12 µs | 99 µs | 21 / 31 µs | 17.5 / 16.3 ms | 10.6 MB | 449 B | 32 MB | 3.2 KB | 0.15 s | 245 ms | 71 ms |
| 100,000 | 2.2 µs | 9 µs | 12 µs | 137 µs | 17 / 16 µs | 15.8 / 16.9 ms | 51.7 MB | 456 B | 380 MB | 3.8 KB | 1.48 s | 8.3 s | 3.5 s |

The point query is `select name from t where id = 5`; the aggregate is `select n, count(*), sum(id) from t group by n` over all 100,000 rows. Both are averages of 20 runs after one warm-up.

**Verdict:** a fork costs about 2 µs at every size, and a world with one changed row costs about 450 bytes on disk and 3–4 KB of memory. A query in one of 100,000 worlds is as fast as in main.

**Losses and caveats:**
- **Checkpoint and reopen grow faster than linearly.** 100,000 worlds took 8.3 s to checkpoint and 3.5 s to reopen, against 245 ms and 71 ms at 10,000 (34× and 49× for 10× the worlds). [Concepts](docs/concepts.md#worlds) says about a second each for 100,000; this run had the machine at a load of 70, so the two numbers can't be separated here, but they need a rerun on a quiet machine.
- **Small sizes are noise.** At 10 and 100 worlds the memory added is below what the footprint can resolve, and the first query in main (160 µs) includes a cold cache.
- **One row per world.** Worlds that change more pay for what they change (section 10).

### Discarding 99,000 of 100,000 worlds

`DISCARD=one|many|expire ROWS=10000 cargo run --release --example worlds`: 100,000 worlds forked from main (10,000 rows), each writing one row, then all but 1,000 discarded: one by one (`discard`), in one call (`discard_many`), or by the expiry sweep after `expire` on each. On the GCP VM (e2-highmem-4: 4 vCPUs, 32 GB, x86-64), quiet (load 0.2–1.1). Before is main just before the change; after is the change as merged (`b1d9c18`).

| | before | after |
|---|---|---|
| one by one | 54.8 s (554 µs each, 85.5 s CPU) | **0.93 s** (9.4 µs each, 1.3 s CPU) |
| in one call | — | **0.51 s** (5.1 µs each) |
| expiry sweep | 37.9 s for 56,181 (675 µs each; the background sweep had taken the rest) | **1.25 s** for 99,000 (12.6 µs each) |
| `world(id)` lookup | 8.7–21.5 ms | under 1 µs |
| memory after, then after a checkpoint | 1,305 MB, 1,305 MB | 985 MB, 888 MB, then 47–59 MB after `malloc_trim` |

**Why:** each discard used to scan every live world for forks under the branch map's write lock, and finding a world by ID scanned them all too. Each world now keeps its live fork count and depth, the map indexes worlds by ID, and `discard_many` drops a batch under one hold of the map and the log (deepest first, one Discard record each). `DROP WORLD ... CASCADE`, `SIMULATE`'s losers and the expiry and idle sweeps go through it. Retired worlds leave the search caches, and a checkpoint hands freed memory back to the system on glibc.

**Loss: the 10,000-world simulation didn't get faster at discarding.** On the VM (`SEED=42`, same winner and scores as before), dropping each round's 9,900–9,999 losers took 709, 1,102 and 1,130 ms, against 288, 439 and 1,149 ms before the change. The cause hasn't been found. Those worlds hold many rows each, unlike the one-row worlds above, so per-world cleanup rather than the scan may dominate there. The 100,000-world runs in section 10, made before the change, spent 27–116 s per round discarding; they haven't been rerun.

## 10. The ultimate test: one real state, 100,000 worlds, a learning loop, one merge

`examples/simulate.rs` is a supply-chain optimization. **Main holds the real state:** warehouses, products (price, cost, lost-sale penalty, ordering cost, lead time of 1–5 days), stock, a seasonal, trending, noisy demand forecast from a seeded generator, and the reorder policy in use today (reorder at lead-time demand, order a week's worth).

**Round 1:** fork WORLDS worlds from main. Each gets its own policy, derived from its index and the seed: safety stock in days of demand for fast and for slow movers, and order size in days of demand. Each world runs the simulation in SQL inside itself. One `WITH RECURSIVE` query steps every SKU through DAYS days (morning order if stock plus pipeline is at or below the reorder point, arrivals, demand sold or lost, pipeline moving up); its results are written as orders and as the end-of-round stock. So every world really diverges. A SQL score (margin on units sold, minus lost sales, holding and ordering costs, in cents) evaluates it, the best 1% are kept and the rest are discarded.

**Rounds 2 and 3, the learning loop:** 100 children are forked from each winner (worlds of worlds). Child 0 keeps the winner's policy and the others move each knob at random by up to 12.5% of its range in round 2 and 8.3% in round 3. Each simulates the next DAYS days from its parent's own stock and pipeline, and the best 1% are kept again. Ancestors left with no living descendant are dropped, leaves first. **Finally** the best world's policy table is merged into main for real.

Worlds run on 8 threads (`std::thread::scope`), on disk, with history retention set to 0. Phases are timed one after another, each across all the round's worlds. Same M2, shared with other sessions' builds and benchmarks; the load average is given per round.

**10,000 worlds:** `cargo run --release --example simulate`. 4 warehouses × 10 products = 40 SKUs, 3 rounds of 30 days, keep 100.

| round | worlds | alive after | fork | compute | eval | discard | CPU (all phases) | memory after compute | disk | best score | median | load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10,000 | 100 | 23 ms | 100 s | 6.0 s | 0.4 s | 321 s | 360 MB | 117 MB | 37,140,360 | 36,607,070 | 24 |
| 2 | 10,000 | 120 | 30 ms | 90 s | 6.5 s | 0.2 s | 369 s | 976 MB | 205 MB | 77,234,392 | 77,137,748 | 23 |
| 3 | 10,000 | 121 | 22 ms | 74 s | 12.2 s | 0.3 s | 422 s | 924 MB | 94 MB | 119,896,685 | 119,401,998 | 17 |

That was the second of two runs, with the machine quieter (5 minutes in all). The first, at a load of 45–131, took 135, 251 and 310 s to compute, 6.9, 64.9 and 60.2 s to evaluate, and 415–462 s of CPU per round, and found exactly the same scores.

**100,000 worlds, the ultimate test:** `ULTIMATE=1 cargo run --release --example simulate`. To fit 8 GB it runs smaller worlds: 3 warehouses × 4 products = 12 SKUs, 3 rounds of 10 days, keep 1,000 (100 children each). Each world writes its policy (12 rows), its orders and 12 stock rows per round. In all, 300,000 worlds were forked, simulated and scored, in about 21 minutes.

| round | worlds | alive after | fork | compute | eval | discard | CPU (all phases) | memory after compute | disk | best score | median | load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 100,000 | 1,000 | 293 ms | 389 s | 32.2 s | 26.8 s | 811 s | 1,290 MB | 291 MB | 4,298,031 | 4,240,222 | 76 |
| 2 | 100,000 | 1,175 | 214 ms | 223 s | 69.0 s | 90.7 s | 790 s | 1,861 MB | 367 MB | 8,065,892 | 8,054,717 | 26 |
| 3 | 100,000 | 1,055 | 209 ms | 237 s | 59.9 s | 115.9 s | 874 s | 2,356 MB | 695 MB | 11,552,511 | 11,535,203 | 19 |

**What the search found**, over the whole horizon from main's real state (each fixed policy rerun in a fresh world from main):

| | 10,000 worlds (90 days) | 100,000 worlds (30 days) |
|---|---|---|
| main's policy today | 80,756,358 | 8,741,200 |
| round 1's best policy, kept for the whole horizon | 118,543,085 (+46.8%) | 11,515,264 (+31.7%) |
| the final policy, from day 0 | 119,493,894 (+48.0%) | 11,305,117 (+29.3%) |
| **the winning lineage** (its policy changed each round) | **119,896,685 (+48.5%, +1.1% over round 1)** | **11,552,511 (+32.2%, +0.3% over round 1)** |

**The merge:** the winner's 40 (or 12) policy rows went into main in 9–12 ms, and a check compares main's policy with the winner's row for row. Main's stock, orders and forecast are untouched. **Determinism:** the winner is chosen by score, with ties broken by name, and the policies come from the seed, so thread timing can't change it. Both runs of the 10,000-world test with `SEED=42` picked the same winner (`r3_66_26`, lineage `r1_4492 > r2_28_27 > r3_66_26`), with the same score in every round and the same policy in main afterwards.

**Losses and caveats:**
- **The learning loop adds little here.** After round 1's random search over 10,000 or 100,000 policies, the loop gained 1.1% and 0.3%. At 100,000 worlds, the final round's policy run alone from day 0 did 1.8% worse than round 1's best: it was selected for days 20–30, from its parents' stock. The policies are tuned to one forecast; a fairer test would score each on several demand samples.
- **No selective merge yet.** The winner also holds its simulated stock and orders, which must not reach main. So its policy rows are copied into a fresh world forked from main, and that world is merged. Merging only some tables of a world is being built on another branch.
- **Two recursive queries per world per round.** `UPDATE ... FROM` a `WITH RECURSIVE` query took about 4.7 s for 40 rows (the same query as an `INSERT ... SELECT` takes about 10 ms), so the stock is appended as a snapshot per round instead of updated, and the orders and the stock each run the recursion. About 40 ms of CPU per 40-SKU world per round goes to SQL expression evaluation.
- **Discarding was O(live worlds)** when these runs were made: each discard scanned every world for children under the map's write lock, so dropping 99,000 of 100,000 worlds took 27–116 s per round. Fixed since: 0.5–1.3 s for 99,000 (section 9, "Discarding 99,000 of 100,000 worlds").
- **Memory wasn't given back after discards** in these runs. With about 120 worlds alive after each 10,000-world round, the footprint stayed at 0.5–1.2 GB; at 100,000 worlds it peaked at 2.36 GB. Since the fix, retired worlds leave the search caches and a checkpoint returns freed memory to the system on glibc (47–59 MB left after dropping 99,000 worlds); macOS keeps it for reuse.
- **Disk until `gc`:** with every world dropped and main checkpointed, the 10,000-world folder still held 82.6 MB, and 567 MB after the 100,000-world run. `gc` then freed 85,800 pages (76.8 MB) in 374 ms, leaving 2.3 MB (measured in the second 10,000-world run; the 100,000-world run predates the `gc` step).
- **A loaded machine.** Other sessions kept the load average between 17 and 131, so wall times are noisy: the same 10,000-world work took 90 s or 251 s to compute in round 2. Treat the CPU column as the steadier number.

## 11. Monte Carlo Tree Search over worlds

`GAMES=20 ITERS=200 cargo run --release --example mcts`: Connect Four, where every node of the search tree is a world holding the board in a table (`cells`, one row per piece). An in-memory database.
- **Expansion** forks the parent's world and plays the move with SQL (`insert into cells select ... count(*) ... where col = $c`); a SQL query then checks for four in a row.
- **Rollouts** fork a throwaway world from the leaf, fill the board with random moves in one `INSERT`, let SQL find who completed four in a row first (a four-way self-join ordered by move number), then discard the world. A Rust check of every rollout agrees with SQL.
- **Selection** is UCT (c = 1.4), and visit and win counts are backed up in the search's own memory.
- **After each real move** (MCTS's or the opponent's), every subtree that can no longer be reached is dropped, leaves first. The game's own path stays until the game ends, since each position is a fork of the one before.

| games | iterations per move | MCTS won | lost | drawn | worlds created | discarded | peak alive | per iteration | total | CPU | peak memory | load |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20 | 200 | 20 | 0 | 0 | 49,402 | 49,402 | 230 | 1.09 ms | 28.8 s | 20.7 s | 47 MB | 20 |

MCTS played first in half the games and second in the rest, and won all 20 in 7 to 26 moves. An iteration (select, fork and move, fork, rollout, discard, back up) takes about 1 ms, and a game creates 1,400 to 4,900 worlds.

**Losses and caveats:**
- **A random opponent is weak.** It shows the search works, not how strong it is; an MCTS-versus-MCTS or solver comparison hasn't been run.
- **The tree's statistics live in Rust,** not in the worlds; only positions do.

## 12. A database bigger than its cache

`CHRONOS_CACHE_MB=32 MB=500 KEEP=1 cargo run --release --example big` on the M2 (8 GB): 1.31 million rows of 256 hex characters each (which barely compress), with a unique column and a B-tree index, plus 328,000 rows with text keys. That's 811 MB of pages, 25 times the cache. The database is built once, then queried in a new process. The footprint is `top`'s MEM after each step, which is the true figure (RSS under-reports once pages swap). Each cell is two runs, "before" being `453e46f`. Cold is the first run of a query, warm the second.

| step | before: cold / warm ms | before: footprint | after: cold / warm ms | after: footprint |
|---|---|---|---|---|
| open | 458, 138 | 59, 31 MB | 122, 84 | 65, 90 MB |
| 1,000 lookups by key, p50 | 0.52, 0.42 / 0.028, 0.011 | 63, 64 MB | 0.40, 0.53 / 0.019, 0.014 | 63, 63 MB |
| 1,000 lookups by B-tree index, p50 | 0.52, 0.43 / 0.043, 0.027 | 83, 87 MB | 0.76, 0.86 / 0.20, 0.10 | 75, 70 MB |
| primary-key range, 1,000 keys | 6.8, 9.7 / 2.5, 1.0 | 84, 88 MB | 10.9, 8.2 / 2.8, 2.5 | 76, 66 MB |
| **text-key range, 1/256 of the table** | 537, 223 / 288, 128 | 84, 111 MB | **28, 31 / 3.1, 2.1** | 73, 67 MB |
| `count(*), sum, max` over everything | 2,221, 993 / 1,959, 992 | 88, 156 MB | 3,121, 2,079 / 1,021, 2,389 | 97, 91 MB |
| `GROUP BY`, 50 groups | 1,877, 555 | 89, 237 MB | 851, 1,477 | 128, 91 MB |
| join + `GROUP BY` | 1,891, 474 | 107, 297 MB | 817, 1,650 | 188, 78 MB |
| `tag = ...`, no index | 2,530, 655 | 89, 211 MB | 978, 1,346 | 195, 92 MB |
| the same in a fork with 100 changed rows | 2,884, 463 | 105, 183 MB | 1,404, 1,274 | 108, 83 MB |
| **`ON CONFLICT (email) DO NOTHING`** | **killed past 2 GB, both runs** | 2,134+ MB | **2.1, 3.2 / 0.0, 0.1** | 98, 83 MB |
| `ON CONFLICT (email) DO UPDATE` | not reached | | 13.6, 8.9 / 1.7, 2.2 | 85, 79 MB |

After the fixes, the highest footprint seen in a run (sampled every 2–3 seconds as well as after each step) was 188 MB and 118 MB, and `cache_bytes` finished at 33.5 MB against a cap of 33.55 MB.

**What changed:**
- **Unique checks:** `ON CONFLICT` on a `UNIQUE` column found the clashing row through the table's search index, which it built whole with no budget. On a 1.67 GB build of this database it reached 5 GB of footprint in 6.5 minutes without finishing. It now reads the constraint's own entry, which the insert's check already used.
- **Text-key ranges** read just the keys in the range, where they used to scan the table.
- **The page cache** counts pages by the memory they take decoded. Counting their size on disk undercounted small rows about 2.5 times, so a "32 MB" cache could hold up to 2.5 times that. With the true count, the same setting holds fewer pages, and warm B-tree lookups, whose index and row pages no longer all fit, went from 0.03 to 0.1–0.2 ms. With `CHRONOS_CACHE_MB=64` (a footprint of 98 MB at that step, about what "32" had before) they took 0.017 ms.
- **The search index** kept every one-letter deletion of every word for typo correction. That's 64 KB for each 256-character hash, so a 19 MB table's index grew past 2.5 GB before it was killed (`MB=20`, a table small enough for `column = value` to build one). Words over 32 letters are no longer corrected. The same query now peaks at 244 MB, about ten times the table (see the [operations guide](docs/operations.md#databases-bigger-than-memory)).

**Caveats:**
- **The timings are noisy:** the load average was 23 to 58 on 8 cores, since other builds were running. Scans varied twofold between identical runs, so only the text-key range and `ON CONFLICT` rows show real changes.
- **Cold means a new process, not a cold disk.** macOS kept the files in its page cache, so cold reads cost decompression and hashing, not the disk.
- **What still grows with the database:** the page directory, about 90 bytes per page (30 MB for these 330,000 pages, more while opening). Wide integer-key ranges and B-tree reads over up to a fifth of the table hold the rows they find.

### Building indexes and loading, under a 2 GB cap

On the 4-core, 32 GB Linux VM, each step a new `chronos` process in a `systemd-run` scope with `MemoryMax=2G` and no swap, `CHRONOS_CACHE_MB=64`, `history_retention` 0. The table: `big (id bigint primary key, grp bigint, body text)`, 7 million rows of 540 bytes (3.8 GB of rows; 664 MB of pages, as the bodies are hex of neighbouring hashes and compress well), loaded in 100,000-row `INSERT ... SELECT` statements. "Anon" is the process's own memory at its highest, sampled every half second; the cgroup total adds the kernel's file cache, which it gives back under pressure. Before is main at `ddf74a0`, after is branch `fx-index-memory`.

| step | before: result, time, anon | after: result, time, anon (cgroup) |
|---|---|---|
| load, 70 statements of 100,000 rows (no cap) | | done, 421 s, 454 MB (1,157 MB) |
| `create index big_grp on big (grp)` | killed at the cap after 91 s | done, 65 s, 548 MB (1,266 MB) |
| `create unique index big_gid on big (grp, id)` | killed at the cap after 98 s | done, 206 s, 767 MB (2,048 MB) |
| `INSERT ... SELECT`, 250,000 rows | done, 66 s, 1,608 MB | done, 63 s, 1,022 MB (1,603 MB) |
| `INSERT ... SELECT`, 1,000,000 rows | killed at the cap after 52 s | killed at the cap after 96 s |
| the same, no cap | done, 208 s, 6,159 MB | done, 276 s, 3,508 MB |

- **Index builds** sort their entries within `CHRONOS_WORK_MEM` (256 MB), spilling to disk, and write them in parts with checkpoints between, so they no longer grow with the table. Before, one write held every entry in several maps, the log record and the in-memory changes at once (7.8 GB on a 9.3 GB table in the audit on the 8 GB Mac).
- **A big single statement is still unbounded.** It commits as one write, so it holds its rows about six times over at 1 million rows: the `SELECT`'s rows, the packed rows, a copy the constraint checks make, the index entries, the log record and the rows kept until the next checkpoint. The changes here remove some of those copies (6.2 GB to 3.5 GB). Loads in statements of 100,000 rows stayed at 454 MB. (Bounded since: see the next section.)

### One statement bigger than memory, under a 30 GB cap

The same VM (4 cores, 31 GB), each statement in a new `chronos <db> < file.sql` process in a `systemd-run` scope with `MemoryMax=30G` (the whole VM less 1 GB for the system) and no swap, one run at a time. The table: `t (id int primary key, k int, body text)` with an index on `k`, filled by one `INSERT INTO t SELECT g, (g*7919) % 1000003, md5(g::text) || ... || md5((g+15)::text) FROM generate_series(1, n) g` (540-byte rows). "Anon" is the process's own memory at its highest, sampled every half second; the cgroup figure adds the kernel's file cache, which it gives back under pressure. Main is `70ebcde`; the branch is `fx-bulk-spill` (source as of `d9798eb`).

**Flat, with a small budget** (`CHRONOS_WORK_MEM=32MB`, `CHRONOS_CACHE_MB=64`):

| rows | main: time, anon (cgroup) | branch: time, anon (cgroup) |
|---|---|---|
| 200,000 | 14.4 s, 439 MB (566 MB) | 10.9 s, **61 MB** (98 MB) |
| 1,000,000 | 81.8 s, 2,251 MB (2,858 MB) | 54.8 s, **67 MB** (271 MB) |
| 2,000,000 | 186.1 s, 4,531 MB (5,741 MB) | 113.2 s, **78 MB** (491 MB) |

**The record runs, default settings** (256 MB work memory, 256 MB cache):

| statement | time | anon (cgroup) |
|---|---|---|
| branch, `INSERT ... SELECT` 1,000,000 rows | 58.4 s | 405 MB (523 MB) |
| branch, 5,000,000 rows | 369.6 s | 406 MB (1,335 MB) |
| branch, 10,000,000 rows (1.2 GB on disk) | 589.4 s | 411 MB (2,458 MB) |
| main, 3,000,000 rows | 325.7 s | 6,811 MB (8,633 MB) |

Main grows by about 2.25 KB of memory per row (2.25 GB per million rows at 1, 2 and 3 million), so 10 million rows would need about 23 GB: it would fit under this cap, but main also logs every row (700 MB of disk per million rows), and 10 million didn't fit on the VM's 8 GB of free disk, so main stopped at 3 million. The branch's database at 10 million rows took 1.2 GB.

**Other big statements** (branch, default settings; the first three on a 5-million-row table, the `COPY`s each into a new database):

| statement | result | time | anon (cgroup) |
|---|---|---|---|
| `UPDATE t SET k = k + 1, body = upper(body)`, every row | UPDATE 5000000 | 308.6 s | 548 MB (1,921 MB) |
| 5 million new rows, the 4-millionth taking an id the table has | 23505, nothing written | 236.3 s | 613 MB (1,005 MB) |
| 5 million new rows, the 1st and the 4-millionth taking one id (found as the runs merge) | 23505, nothing written | 305.5 s | 617 MB (1,105 MB) |
| `\copy` of 500,000 / 2,000,000 / 4,000,000 rows into a new table, through the server | COPY n | 24.6 / 94.9 / 192.8 s | 433 / 440 / 419 MB |
| the same with the small budget, 500,000 / 2,000,000 rows | COPY n | 21.2 / 112.7 s | 83 / 123 MB |

After each failed statement the table had its 5 million rows, `VERIFY DATABASE` passed and the spill folder was empty. The inserts into the 5-million-row table peak higher than into an empty one because their key checks read the table through the page cache: what grows is the database's share (the cache, up to its cap, and the page directory, about 90 bytes a page), not the statement's. With the small budget, 200,000 rows into an empty table peaked at 62 MB, and into one holding 2 million rows at 154 MB; a 500,000-row `COPY` at 67 and 97 MB. (A 2-million-row `COPY` into the 5-million-row database, whose server held a 646,000-page directory and a full cache, peaked at 1,043 MB.)

**Crashes** (kill -9, then reopen twice, `VERIFY DATABASE`, count the rows): a table of 1,000 rows and a 4,999,000-row insert killed at 90 s (140 MB of runs in the spill folder) and 200 s (309 MB): 1,000 rows each time, spill folder emptied. A 2,999,000-row insert killed during its commit: as the new tree's pages began (+20 MB of pages) and late in them (+240 MB of 346): 1,000 rows; as soon as the log's new segment appeared, and as soon as the manifest changed: 3,000,000 rows (the checkpoint had landed). Never a count in between, and verify passed every time.

**Small statements aren't slower** (default settings, fresh database each, three rounds; the first round was slower for both and is in brackets):

| rows | main | branch |
|---|---|---|
| 100,000 (held in memory on both) | 7.3, 6.8 s (15.1) | 6.8, 6.2 s (11.6) |
| 1,000,000 | 79.1, 86.3 s (91.0) | 56.8, 56.3 s (92.6) |

- **What held the memory before** (the branch's own first cut too): a statement is one atomic write, so it held its rows several times over (the SELECT's rows, packed rows, index entries, constraint checks, the log record, then the rows until the next checkpoint). The first version of this branch spilled writes past `CHRONOS_WORK_MEM` but still grew linearly on these runs: `generate_series` in `FROM` is parsed as a `LATERAL` source, and the code that reads an `INSERT ... SELECT` a part at a time refused `LATERAL` sources, so every series was computed whole and handed over as one part.
- **Where the branch's memory goes:** a part of the statement, whose writes are held until their estimated size passes half of `CHRONOS_WORK_MEM` (a quarter after the first part) and take about three times that estimate with their index entries and marks (so about 400 MB at the default 256 MB, 60 MB at 32 MB); a block of each run being merged (at most 16); and a batch of 8 MB of changes as the merged runs go into the tree.

### Checked through the Postgres server (the item 23 audit, main `ae51cf7`)

The merged build as a server (`chronos serve`, 30 GB cap), driven by psql like an application, a fresh database per size; the server's own memory (anon) sampled every 0.2 s, one phase at a time. Table `t (id bigint primary key, k bigint, body text)` with an index on `k`, 540-byte rows, one `INSERT ... SELECT` of n rows.

| phase | 1,000,000 rows | 4,000,000 rows |
|---|---|---|
| the `INSERT` of n rows | 58 s, **397 MB** | 247 s, **397 MB** |
| idle after the insert | 96 MB | 156 MB |
| `select count(*) from t` | 336 MB | 378 MB |
| `select count(distinct k) from t` | 667 MB | **1,364 MB** |
| idle after the queries | 483 MB | 698 MB |

All rows were there, `VERIFY DATABASE` passed and the spill folder was empty. The insert is flat and gives its memory back. The idle figure after the queries is the page cache (up to its cap) and the page directory, which grow with the database. `count(distinct k)` was not bounded: see the next section.

### `DISTINCT` aggregates

The same VM, 30 GB cap, each query in a new `chronos <db> < query.sql` process, the query's own peak `RssAnon`. Tables `t (id bigint primary key, k, j, g)`: `k` all distinct, `j` and `g` 100,000 values. Main is `5722d58`; the branch is `fx-distinct-spill` with its wave fix.

| query | 1M rows: main / branch | 4M: main / branch | 10M: main / branch |
|---|---|---|---|
| `count(distinct k)`, all distinct, defaults | 603 / 452 MB | 2,054 / 555 MB | 3,998 / 672 MB |
| `count(distinct j)`, 100,000 values, defaults | 554 / 370 MB | 1,738 / 345 MB | 3,503 / 572 MB |
| `group by g`, 100,000 groups, `count(distinct k)`, defaults | 616 / 441 MB | 1,816 / 737 MB | 3,650 / 817 MB |
| `count(distinct j)`, 32 MB cache, 64 MB budget | – / 76 MB | 1,488 / 94 MB | 3,271 / 295 MB |
| `count(*)`, 32 MB cache (the scan alone) | – | 70 / 70 MB | 210 / 195 MB |

Main reads the whole table into memory before grouping a DISTINCT aggregate; the branch holds the groups, their distinct values up to the budget, then spills. What still grows at 10 million rows is the scan's own share, the same with `count(*)` on main (70 MB at 4 million rows, 210 MB at 10 million), and at the defaults the page cache filling to 256 MB. Grouped DISTINCT spilling to disk is slower than holding it: 23.5 s against 8.0 s at 4 million rows, 52 s against 19 s at 10 million. While it fits, it's as fast: `count(distinct j)` over 1 million rows took 2.1 s on both builds, five runs each.

## Rerun everything

```bash
cargo run --release --example bench -- 10 100 1000                 # needs Postgres at host=/tmp
WORKERS=25 cargo run --release --example bench -- 1000             # Chronos at Postgres's 25 workers
N=500000 OVERSAMPLE=100 EF=300 cargo run --release --example search  # needs pgvector
N=1000000 cargo run --release --example find
CRASH_RUNS=10000 cargo test --release --test durability crash_suite
SIM_ITERS=3000 cargo test --release --features shuttle --test sim
JEPSEN_KILLS=20 cargo test --release --test jepsen -- --nocapture
chronos serve /tmp/sqlbench & N=10000 cargo run --release --example sql   # needs Postgres on 127.0.0.1:5432
N=200000 cargo run --release --example report                       # PG=off runs Chronos alone
CHRONOS_CACHE_MB=32 MB=500 cargo run --release --example big            # builds ~800 MB in a temp folder
python bench/vector_dbs.py                                          # needs chronos serve, Postgres, Qdrant; see its header
SWEEP=1 ROWS=100000 cargo run --release --example worlds            # 10 .. 100,000 worlds
cargo run --release --example simulate                              # 10,000 worlds x 3 rounds
ULTIMATE=1 cargo run --release --example simulate                   # the ultimate test: 100,000 worlds x 3 rounds
GAMES=20 ITERS=200 cargo run --release --example mcts               # MCTS over worlds vs a random player
```
