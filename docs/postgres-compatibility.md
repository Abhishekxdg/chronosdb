---
title: Postgres compatibility
---

`chronos serve` speaks the Postgres wire protocol, so PostgreSQL clients and drivers connect to it: psql, the Rust `postgres` crate, psycopg, pgvector's Python helpers. Chronos is not Postgres. It has its own SQL parser and executor ([SQL](sql.md)), and the surface is what that page lists, no more. What it does cover is checked against a real Postgres by a differential suite, `tests/pgdiff.rs`. Its 43 scripts run statement by statement on a fresh Chronos database and on a fresh schema in Postgres, and each statement must give the same rows, or fail on both with the same SQLSTATE class. Cells compare as text, except that numbers compare as numbers and `t`/`f` as `true`/`false` (the numeric tests compare the text exactly). Three more suites work the same way:

- `tests/schemas.rs`: schemas, `regclass`, the catalog, and the reflection queries SQLAlchemy 2.0 and Prisma send.
- `tests/pgcompat.rs`: 240 random app-style queries over 4,000 users and 12,000 orders. They must return the same rows, and where Postgres reads a table through an index, Chronos must not scan all of it.
- `tests/copy.rs` `same_as_postgres`: psql scripts with COPY data inline must print the same on both.

**What that covers:** the SQL. On the Chronos side pgdiff and pgcompat run in process, so the wire protocol is checked by the client tests below, not by the diff. Worlds and concurrency aren't diffed, because Postgres has neither to compare against. The suites need a Postgres at `host=/tmp` and skip when there's none. CI doesn't start one, so they run on developers' machines; the project runs them against Postgres 17.

## Connecting

```bash
chronos serve mydb                                  # HTTP on 7070, Postgres protocol on 127.0.0.1:5433
psql postgres://127.0.0.1:5433/main               # the database name is the world
```

- **Address:** `--pg 127.0.0.1:5433` is the default, and `--pg off` turns the port off. Any address but loopback needs `--token` (or `CHRONOS_TOKEN`); the server won't start without one.
- **Database name = world.** `main`, or any live world's name: `postgres://127.0.0.1:5433/agent_7`. An empty name, or one equal to the user name, means `main`, so a bare `psql -h 127.0.0.1 -p 5433` lands on main. A world that doesn't exist fails with 3D000. `main@2026-09-20 10:00` (or `main@-1 hour`) is main as it was then, read only (25006 on writes): `psql "host=127.0.0.1 port=5433 dbname='main@-1 hour'"`. psql's `\l` lists the worlds as databases.
- **User and password:**

| Server started with | User | Password |
|---|---|---|
| no `--token` (loopback only) | any name | none asked |
| `--token T` | any name | `T` (28P01 otherwise) |
| any | an agent's name | that agent's token: the session acts as the agent ([agents](concepts.md#agents)) |
| `--safe` | not an agent | anything: the session is the agent `guest` (reads, forks, changes only its own worlds) |
| `--safe --admin-token A` | not an agent | `A`: the database's own user |

- **Authentication method:** cleartext password only (AuthenticationCleartextPassword). No MD5, no SCRAM-SHA-256, no GSSAPI, no client certificates. Without TLS the password crosses the network in the clear, so use TLS off loopback.
- **TLS:** `chronos serve mydb --tls-cert cert.pem --tls-key key.pem` makes every Postgres connection use TLS (1.2 or 1.3). `sslmode=prefer` (psql's default), `require`, `verify-ca` and `verify-full` use it (tested with `verify-full`): `psql "postgres://localhost:5433/main?sslmode=verify-full&sslrootcert=cert.pem"`. `sslmode=disable` is refused with 28000 (`this server requires TLS`). Without the flags the server declines TLS, so `prefer` carries on in plain text and `require` fails. TLS starts only through the usual SSLRequest; Postgres 17's `sslnegotiation=direct` isn't supported. See [operations](operations.md#tls).
- **Worlds inside a connection:** `SWITCH WORLD name` (or `USE WORLD`, `USE BRANCH`, or `USE WORLD '<id>'`) moves this connection to another world. `current_database()` names the world the session is in. See [Chronos-only SQL](#chronos-only-sql).

## Clients

Evidence levels used below:

- **Tested:** run by the repo's test suite against a real `chronos serve`.
- **Harness:** run end to end by a benchmark harness in the repo, not by the tests.
- **Queries tested:** the library's own SQL is replayed in the tests, but the library itself wasn't run.
- **Reported:** the [CHANGELOG](https://github.com/Abhishekxdg/chronosdb/blob/main/CHANGELOG.md) says it ran, and nothing in the repo runs it.
- **Protocol only:** should work, given the protocol features below. Not tried.

### psql

**Tested:** `tests/pg.rs` `psql`, `psql_shows_views_and_sequences`, `a_query_stops_when_its_client_disconnects`; `tests/copy.rs` `psql_round_trip_is_byte_identical`, `a_failed_copy_leaves_nothing`, `same_as_postgres`; `tests/tls.rs` `https_and_postgres_over_tls`.

```bash
psql postgres://127.0.0.1:5433/main
```

```sql
create table t (id int primary key, note text);
insert into t values (1, 'one'), (2, 'two');
\dt
\d t
\copy t to 't.csv' csv header
create world trial;
switch world trial;           -- this connection now works on trial
update t set note = 'uno' where id = 1;
diff;
merge world trial;           -- into main; the connection moves back to main
```

`\d`, `\dt`, `\dv`, `\dm`, `\ds`, `\dn`, `\d name`, `\d+ view` and `\l` work: Chronos recognises the catalog queries psql 16 sends ([psql's commands](sql.md#psqls-commands)). Ctrl-C sends a cancel request, which stops the statement (57014).

### Rust: `postgres` crate

**Tested:** `tests/pg.rs` `postgres_driver` (extended protocol, binary parameters and results, prepared statements, SQLSTATEs), `transactions_and_branches_over_the_wire`, `dates_over_the_wire`, `arrays_numeric_and_time_over_the_wire`, `token_is_the_password`, `agents_log_in_with_their_token`, `timeouts_and_cancel_requests_stop_a_query`, `listen_and_notify_over_the_wire`; `tests/copy.rs` `driver_copy_in_and_out`; `tests/safe.rs` `safe_mode_over_http_and_postgres`. The benchmarks in [examples/sql.rs](https://github.com/Abhishekxdg/chronosdb/blob/main/examples/sql.rs) use it too.

```rust
use postgres::{Client, NoTls};

let mut c = Client::connect("host=127.0.0.1 port=5433 user=me dbname=main", NoTls)?;
c.batch_execute("create table kv (k text primary key, v bigint)")?;
c.execute("insert into kv values ($1, $2)", &[&"x", &1i64])?;
let ids = c.query("select v from kv where k = any($1)", &[&vec!["x", "y"]])?;

// a world: switch this connection, or connect to it by name
c.batch_execute("create world trial; switch world trial; update kv set v = 99")?;
let mut on_trial = Client::connect("host=127.0.0.1 port=5433 user=me dbname=trial", NoTls)?;
let changes = c.query("diff", &[])?;          // table, id, change, before, after
c.batch_execute("merge world trial")?;
```

`tokio-postgres` is the same protocol code under the `postgres` crate, but only the `postgres` crate is tested.

### Python: psycopg 3 with pgvector

**Harness:** `bench/vector_dbs.py` loads and queries 76,424 OpenAI embeddings through psycopg 3, with vectors sent in binary through pgvector's `register_vector` (the [benchmarks](https://github.com/Abhishekxdg/chronosdb/blob/main/BENCHMARKS.md)). Not in the test suite.

```python
import json, numpy as np, psycopg
from pgvector.psycopg import register_vector

conn = psycopg.connect("postgresql://me@127.0.0.1:5433/main", autocommit=True)
conn.execute("create extension if not exists vector")    # accepted: vectors are built in
register_vector(conn)                                     # vectors travel in binary

conn.execute("create table if not exists items (id int primary key, embedding vector(3), payload jsonb)")
conn.execute("create index on items using hnsw (embedding vector_cosine_ops)")
conn.execute("insert into items values (%s, %s, %s)",
             (1, np.array([1, 0, 0], dtype=np.float32), json.dumps({"user_id": "u1"})))
rows = conn.execute(
    "select id from items where payload->>'user_id' = %s order by embedding <=> %s::vector limit 5",
    ("u1", np.array([1, 0.1, 0], dtype=np.float32))).fetchall()

conn.execute("create world trial")
conn.execute("switch world trial")                        # needs autocommit: see below
```

`autocommit=True` matters: without it psycopg opens a transaction before the first statement, and world statements are refused inside one (25001). `register_vector` looks the `vector` type up in `pg_type`, and Chronos answers that lookup (the type's id is 90000).

### Mem0's pgvector store (psycopg 2 or 3)

**Reported and queries tested:** the CHANGELOG says Mem0's `pgvector` store runs unchanged with psycopg 2 and 3. `tests/sql.rs` `pgvector` replays the SQL it sends (`information_schema.tables`, `CREATE EXTENSION`, `USING hnsw`, `ARRAY[...]` vectors as psycopg2 inlines them, `payload->>'user_id'` filters), but nothing in the repo runs Mem0 itself.

```python
from mem0 import Memory

memory = Memory.from_config({
    "vector_store": {
        "provider": "pgvector",
        "config": {"host": "127.0.0.1", "port": 5433, "dbname": "main", "user": "mem0",
                   "password": "", "collection_name": "memories", "embedding_model_dims": 1536, "hnsw": True},
    },
    # plus Mem0's own llm and embedder settings
})
```

Point `dbname` at a world to give each agent run its own memory. With `hnsw`, searches come from Chronos's search index ([Vectors](sql.md#vectors-pgvector)).

### SQLAlchemy and Prisma

**Queries tested:** `tests/schemas.rs` `sqlalchemy_introspection` runs SQLAlchemy 2.0's Postgres reflection queries (tables, primary keys, unique constraints, foreign keys, checks, indexes, columns), and `prisma_introspection` runs Prisma's schema describer (namespaces, tables, constraints, columns, foreign keys, indexes, sequences, views). Both are diffed against Postgres. Neither ORM has been run against Chronos, so its connection setup, migrations and generated queries are unchecked.

```python
from sqlalchemy import create_engine, inspect, text

engine = create_engine("postgresql+psycopg://me@127.0.0.1:5433/main")
with engine.connect() as c:
    print(inspect(c).get_table_names())
    c.execute(text("select * from orders where id = :id"), {"id": 1})
```

```prisma
datasource db {
  provider = "postgresql"
  url      = "postgresql://me@127.0.0.1:5433/main"
}
```

Watch out for: `SHOW` of Postgres settings (only [Chronos's own](#known-gaps) are known), `SELECT ... FOR UPDATE` (fails the later `COMMIT` rather than waiting, see [Differences that bite](#differences-that-bite)), shared advisory locks, `CREATE EXTENSION` other than `vector` and `postgis`, and `pg_get_serial_sequence` (returns NULL).

### Node: `pg` (node-postgres)

**Protocol only:** not tested. The repo's TypeScript client ([clients/typescript](https://github.com/Abhishekxdg/chronosdb/blob/main/clients/typescript)) uses the HTTP API, not the Postgres port.

```js
import pg from "pg";

const client = new pg.Client("postgres://me@127.0.0.1:5433/main");
await client.connect();
const { rows } = await client.query("select id, name from users where id = any($1)", [[1, 2]]);
await client.query("create world trial");
await client.query("switch world trial");
```

node-postgres sends arrays as array text (`'{1,2}'`), which `= ANY($1)` takes ([ANY, SOME and ALL](sql.md#subqueries-union-and-with)).

### Others

JDBC, Go (`pgx`, `lib/pq`), asyncpg, .NET and GUI tools: no evidence either way. Check the table below against what the client needs (cleartext password authentication, the queries it sends on connect).

## Protocol features

| Feature | Status | Evidence |
|---|---|---|
| Simple query | Yes, text results | tests/pg.rs `psql` |
| Several statements in one simple Query | Yes, but each commits on its own: no implicit transaction (see [Differences](#differences-that-bite)) | `src/pg.rs` `simple` |
| Extended query (Parse, Bind, Describe, Execute, Close, Sync, Flush) | Yes; named statements and portals | tests/pg.rs `postgres_driver` |
| Several statements in one Parse | Refused with 42601, as in Postgres | `src/pg.rs` `parse` |
| Parameter types | Inferred from use, or taken from Parse's type ids | tests/pg.rs `postgres_driver` |
| Binary values | Parameters and results: `int2/4/8`, `float4/8`, `bool`, `text`, `json`/`jsonb`, `date`, `time`, `timestamp(tz)`, `interval`, `numeric`, `vector`, and 1-D arrays of those, in both directions (an array of arrays is sent as text). `tsvector`/`tsquery` results in binary, parameters as text only | tests/pg.rs `postgres_driver`, `dates_over_the_wire`, `arrays_numeric_and_time_over_the_wire` |
| Execute's row limit | Yes: that many rows, then PortalSuspended; the next Execute goes on ([Cursors](sql.md#cursors)) | tests/cursors.rs |
| SQL cursors: `DECLARE`, `FETCH`, `MOVE`, `CLOSE` | Yes, over a snapshot kept in memory; psql's `FETCH_COUNT` and psycopg's named cursors use them | tests/pgdiff.rs `cursors`, tests/cursors.rs |
| SQL `PREPARE` / `EXECUTE` / `DEALLOCATE` | Yes, sharing names with the protocol's statements | tests/copy.rs `driver_copy_in_and_out` |
| `COPY ... FROM STDIN` / `TO STDOUT` | Text and CSV; `FORMAT binary` refused (0A000), server files and programs refused (42501) | tests/copy.rs |
| LISTEN / NOTIFY | Yes; idle connections are told at once | tests/pg.rs `listen_and_notify_over_the_wire` |
| Cancel requests | Yes, 57014 | tests/pg.rs `timeouts_and_cancel_requests_stop_a_query` |
| Client disconnects mid-query | The statement stops | tests/pg.rs `a_query_stops_when_its_client_disconnects` |
| TLS (SSLRequest) | Yes, required on every connection once configured | tests/tls.rs |
| GSSAPI encryption | Declined; the client carries on in plain text | `src/pg.rs` `startup` |
| Authentication | Cleartext password only; none on loopback without a token | tests/pg.rs `token_is_the_password`, `agents_log_in_with_their_token` |
| Transactions and savepoints | `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`; ReadyForQuery reports idle, in a transaction and failed | tests/pg.rs `transactions_and_branches_over_the_wire` |
| ParameterStatus | Sent once at startup: `server_version` 16.0, `server_encoding` and `client_encoding` UTF8, `DateStyle` ISO, MDY, `TimeZone` (UTC, or the zone the client asked for), `integer_datetimes` on, `standard_conforming_strings` on. `TimeZone` is sent again after a `SET TIME ZONE` changes it; the others aren't sent again | `src/pg.rs` `startup` |
| BackendKeyData | Yes, used by cancel requests | `src/pg.rs` `startup` |
| Errors and notices | ErrorResponse carries severity, SQLSTATE, message and, where there is one, DETAIL, HINT, POSITION (a syntax error's, so psql draws its caret) and the schema, table, column and constraint a violation names; notices carry severity, code and message | tests/pg.rs `syntax_errors_carry_their_position`, `constraint_violations_carry_their_fields` |
| RowDescription | Column name and type; table oid, column number and type modifier are always 0, 0 and -1 | `src/pg.rs` `row_description` |
| FunctionCall | Not supported (08P01) | `src/pg.rs` `serve` |
| Replication, CopyBoth | Not supported | `src/pg.rs` `serve` |

## SQL surface

| Area | Status | See |
|---|---|---|
| `SELECT`, joins (inner, left, right, full, cross, `USING`), `GROUP BY`/`HAVING`, `DISTINCT`, `ORDER BY`/`LIMIT`/`OFFSET` | Supported | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| Subqueries, `UNION`/`INTERSECT`/`EXCEPT`, `WITH`, `WITH RECURSIVE`, `LATERAL`, `ANY`/`ALL` | Supported | [Subqueries, UNION and WITH](sql.md#subqueries-union-and-with) |
| Window functions | Partial: no `DISTINCT` in window aggregates | [Window functions](sql.md#window-functions) |
| `INSERT`/`UPDATE`/`DELETE`, `RETURNING`, `ON CONFLICT`, `UPDATE ... FROM`, `DELETE ... USING`, `MERGE INTO` (Postgres 16's), `TRUNCATE` | Supported (`MERGE` needs a primary key on the target) | [Upserts and CASE](sql.md#upserts-and-case) |
| Types | Partial: see [Known gaps](#known-gaps) | [What works now](sql.md#what-works-now) |
| Constraints: primary keys (one or several columns), `UNIQUE`, `CHECK`, `NOT NULL`, foreign keys | Partial: foreign keys to primary keys and `UNIQUE` columns (they can be deferrable, with every `ON DELETE` / `ON UPDATE` action), no `MATCH FULL`, no deferrable `UNIQUE`, no `EXCLUDE` | [Unique constraints and foreign keys](sql.md#unique-constraints-and-foreign-keys) |
| Inheritance and partitioning | Supported: `INHERITS`, `ONLY`, `PARTITION BY RANGE/LIST/HASH`, `PARTITION OF`, routing, row moves, `ATTACH`/`DETACH`, keys and indexes on the parent, `pg_dump` round trip; compared with Postgres 16 | [Inheritance and partitioning](sql.md#inheritance-and-partitioning), tests/partitions.rs, tests/pgdiff.rs `partitions_*` |
| `ALTER TABLE` | Supported for columns, defaults, `NOT NULL`, constraints, renames, adding a primary key | [Changing tables](sql.md#changing-tables) |
| Indexes | Partial: btree (expressions, partial, unique, operator classes that only compare, `INCLUDE`; `hash` and `brin` as btrees), GIN on tsvector, GiST on points, `hnsw`/`ivfflat` accepted | [Indexes](sql.md#indexes) |
| Schemas and `search_path` | Supported, without owners or privileges | [Schemas](sql.md#schemas) |
| Views, materialized views | Partial: no `WITH CHECK OPTION`, no `ON CONFLICT` through a view | [Views](sql.md#views) |
| Sequences, `serial`, identity | Supported; counters shared by every world | [Sequences](sql.md#sequences) |
| Generated columns | `STORED` supported (no `VIRTUAL`, which is Postgres 18's) | [Numbering rows](sql.md#numbering-rows) |
| Enums | Supported, except in primary keys | [Enum types](sql.md#enum-types) |
| Temporary tables | Partial: no `ON COMMIT DROP`/`DELETE ROWS` | [Temporary tables](sql.md#temporary-tables) |
| Functions and triggers, `LANGUAGE sql` and `plpgsql` | Partial | [Functions and triggers](sql.md#functions-and-triggers) |
| Full-text search (`tsvector`, `@@`, `ts_rank`) | Supported, but not `ts_headline` or `ts_rank_cd` | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| pgvector | Supported: `vector(n)`, `<=>`, `<->`, `<#>`, `USING hnsw` | [Vectors](sql.md#vectors-pgvector) |
| PostGIS | Points only | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| `information_schema` and `pg_catalog` | Partial: the tables introspection reads | [The catalog](sql.md#the-catalog-information_schema-and-pg_catalog) |
| Transactions | Snapshot isolation, whatever level is asked for | [Transactions](sql.md#transactions) |
| `EXPLAIN [ANALYZE]` | Text only, no costs | [EXPLAIN](sql.md#explain) |
| `CREATE DATABASE`, `DROP DATABASE` | A database is a world: `CREATE DATABASE` makes an empty one, `TEMPLATE` forks one | [Databases](sql.md#databases) |
| Roles, `GRANT`/`REVOKE`, row-level security | Not supported: permissions are [agents](concepts.md#agents) | |

### Known gaps

Each is an error (0A000 for known features, 42601 for statements Chronos doesn't parse), not a wrong answer.

- **Partitioning:** no partition pruning in `EXPLAIN` (a scan reads every partition; the answer is the same) and no foreign tables as partitions.
- **Statements not parsed:** `GRANT`, `REVOKE`, `CREATE ROLE`/`USER`, `ALTER DATABASE` other than `OWNER TO` (0A000).
- **Clauses:** `FOR UPDATE ... SKIP LOCKED`, `GROUPING SETS` together with `DISTINCT` or a window function, hypothetical-set aggregates (`rank(x) WITHIN GROUP`), `COPY ... WHERE`, `DISTINCT ON` together with `GROUP BY`, aggregates or window functions. `^` on numbers with decimals (`2.5 ^ 2`) is refused; on integers and doubles it works, as double precision.
- **Types:** no composite types you can declare or range types (domains work: `CREATE DOMAIN`, expanded into the column; a record exists as the type of what a function giving several columns gives, read with `(expr).field`, see [sql.md](sql.md#records)), no `time with time zone`, `money`, `bit`, `hstore`, `citext` or `xml`. Some types are stored as others and reach clients that way: `varchar(n)` and `char` as `text` (oid 25), `smallint` as `integer` (in query results and parameters: the column itself is a smallint, see below), `real` as `double precision`, `json` as `jsonb`, enums and PostGIS types as `text`.
- **`SHOW`, `current_setting()` and `pg_settings`:** all 363 of Postgres 16's settings (`src/sql/settings.tsv`, made from a real Postgres 16: type, unit, range, allowed values, context, description), each at Postgres's default unless Chronos has its own value: `server_version` 16.0, `server_version_num` 160000, `TimeZone` (the session's, UTC unless set), `transaction_isolation` repeatable read (snapshot isolation), `lc_collate` C (text sorts by bytes), `max_connections`. Values are written as Postgres writes them (`64MB`, `5min`, `on`). `pg_settings` and `SHOW ALL` list them all (except `is_superuser`, `lc_collate` and `lc_ctype`, which Postgres does not list either) with `setting` in the base unit, `source` (`default` or `session`), `boot_val` and `reset_val`. Chronos's own settings have their own `SHOW`s (`SHOW synchronous_commit` is the database's mode: full, normal or off). Any other name is 42704, as Postgres says of one it doesn't know; `current_setting(name, true)` gives NULL instead.
- **`SET`:** every setting is checked as Postgres checks it: a boolean in any of its spellings (`on`, `t`, `yes`, `0`), an integer or real in its unit (`'64MB'`, `'1.5s'`, a bare number in the base unit) and range, an enum by its allowed values; an invalid value is 22023, a name nobody has is 42704, and a setting a session may not change (`max_connections`, `server_version`, `wal_level`, ...) is 55P02. `SET`, `SET LOCAL`, `set_config(name, value, is_local)`, `RESET name`, `RESET ALL` and `SET name TO DEFAULT` keep what was set for the session (or its transaction) and read it back with `SHOW`, `current_setting()` and `pg_settings`; a `SET` is undone by `ROLLBACK`, `ROLLBACK TO SAVEPOINT` and a failed transaction, as in Postgres, and a custom setting (`app.org_id`) that was set once stays, empty, as in Postgres. `search_path`, `statement_timeout`, `TIME ZONE` / `TimeZone`, `IntervalStyle` (all four styles), `hnsw.ef_search`, `application_name` and `client_min_messages` take effect. The settings with nothing to act on here (`work_mem`, `enable_seqscan`, `jit`, `random_page_cost`, the autovacuum, WAL and logging settings, ...) are kept and read back and change nothing. Those Postgres honors and Chronos does not, where a silent no-op would change an answer, take only the value Chronos implements and refuse the rest with 0A000: `DateStyle` (ISO, MDY), `standard_conforming_strings` and `array_nulls` (on), `quote_all_identifiers` and `transform_null_equals` (off), `bytea_output` (hex), `extra_float_digits` (1 to 3), `client_encoding` (UTF8), `session_replication_role` (origin), `default_transaction_read_only` (off), `lc_monetary`/`lc_numeric`/`lc_time` (C) and `default_text_search_config` (english, simple). `SERIALIZABLE`, asked for in `SET TRANSACTION`, `SET SESSION CHARACTERISTICS` or `SET default_transaction_isolation`, is 0A000; the other isolation levels are accepted and ignored. `set_config('search_path' | 'statement_timeout' | 'TimeZone', ...)` returns the value and does not change the session's (use `SET`).
- **Functions:** no shared advisory locks (`pg_advisory_lock_shared` and the like, 0A000), no write-ahead-log functions (`pg_current_wal_lsn` and the like) or `txid_current_snapshot`. `pg_cancel_backend` and `pg_terminate_backend` stop (or close) another connection by its `pid`; an agent can't (42501). `has_table_privilege` and the other `has_*_privilege` functions answer true for a database user (after checking the object and privilege names as Postgres does) and are refused with 0A000 in an agent's session, whose rights are capabilities that depend on the world.
- **Extensions:** `CREATE EXTENSION` (and `DROP EXTENSION`) accepts `vector` and `postgis` (built in), `plpgsql` (in every database, as in Postgres), `pg_trgm`, `fuzzystrmatch` and `unaccent` (their functions and operators are built in, in every database: `similarity`, `word_similarity`, `show_trgm`, `%`, `<%`, `<->`, `levenshtein`, `soundex`, `dmetaphone`, `unaccent`, ...; a `gin` or `gist` index with `gin_trgm_ops` or `gist_trgm_ops` is accepted and kept as a btree, so `%` and `LIKE` scan; the statement doesn't have to come first, and `DROP EXTENSION` of one doesn't remove the functions or care about an index that uses its operator class), and `uuid-ossp` and `pgcrypto`, which only give what's built in: `uuid_generate_v4()` and `gen_random_uuid()` (a notice says so). Any other, `citext` among them, is 0A000: it would change what SQL means, and not having it is better than a quiet difference.
- **Maintenance statements:** `VACUUM`, `ANALYZE`, `REINDEX` and `CLUSTER` succeed and do nothing (no dead rows to reclaim, indexes always current, no statistics kept), after checking their names and where they may run as Postgres does. `COMMENT ON` on a function, type, extension, trigger or database says the comment isn't kept (tables, views, sequences, indexes, columns, constraints and schemas keep theirs: [Comments](sql.md#comments)). `LOCK TABLE` and `DISCARD` are described under [Maintenance, DISCARD and LOCK](sql.md#maintenance-discard-and-lock).
- **Catalog:** the tables listed in [the catalog](sql.md#the-catalog-information_schema-and-pg_catalog) have rows, the world's functions, enum types, triggers and dependencies among them; every other Postgres 16 catalog table exists with its columns and is empty (the built-in functions and operators aren't listed in `pg_proc` and `pg_operator`). `pg_stat_activity` lists the open connections (who, which world, what they are running or ran last, in a transaction or not) and `pg_stat_database` each world's connection count; Chronos keeps no other statistics: the per-table, per-index and per-transaction statistics views (`pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_statio_*`, `pg_stat_xact_*`) list the tables and indexes with their counters at 0, `pg_stat_database_conflicts` has a row per world, and the views Postgres always has one row of (`pg_stat_bgwriter`, `pg_stat_wal`, `pg_stat_archiver`, `pg_stat_recovery_prefetch`) have it, counters 0; every other `pg_stat*` view of Postgres 16 exists with its columns and is empty (one node: no replication, WAL receiver, subscriptions or SSL). `pg_prepared_statements` lists the session's prepared statements (SQL `PREPARE`'s and a driver's named ones, with `parameter_types` and `result_types` as `regtype[]`; a type Chronos keeps as a wider one shows as that one: `smallint` and `real` as `integer` and `double precision`, `varchar` as `text`; Chronos has no regtype values of its own, `'integer'::regtype` being the oid `23`, so an element is its type's name as text: comparing one with a regtype (`'integer'::regtype = any (parameter_types)`), `parameter_types[1]::oid`, `format_type(parameter_types[1], null)` and `parameter_types::oid[]` don't give Postgres's answers, where `parameter_types::text[]` compares by name as Postgres does; read in binary, a `regtype[]` is an array of type oids as Postgres sends it, except that an element naming a type dropped since the value was stored is 0, where Postgres keeps the dropped type's oid; a `regtype[]` column of a table made from them reads each type name written to it as regtype does and keeps it as regtype shows it, `'{int4}'` as `{integer}` and a name of no type 42704, but takes a `text[]` too, where Postgres refuses one with 42804), `pg_cursors` its open cursors (`statement` is the query string each came in: a simple query's whole text, or the text of a driver's Parse; a cursor's own query sees it), read directly, through a view or in a function's body, and `pg_locks` the advisory locks held and waited for in the database it is asked in (Chronos takes no other locks a client can see), each with the `pid` of the connection holding or waiting for it, as `pg_stat_activity` numbers it (a session of a program embedding Chronos is no connection: other sessions see its locks with a null `pid`). `pg_roles` and `pg_user` have `chronos` and the name the session logged in as (a superuser, as every login is). `pg_database` lists the worlds (and `postgres`, `template0`, `template1` unless a world is named so), with the columns tools read. `NOT NULL` constraints aren't rows of `table_constraints`, and `pg_opclass` is empty.
- **regproc and regprocedure:** both are types (`pg_typeof` says so, a column can be declared one, and a driver gets them as type 24 and 2202, in binary as oids). A regproc is its function's oid, and each value knows it is a regproc, so it is shown as its name when a result leaves the statement and wherever it is made text inside one (`::text`, `::varchar(n)`, `||`, a function of any type such as `concat`, `format` or `quote_literal`, json, ARRAY[...], a row, a column or PL/pgSQL variable of text it is written to by any statement, VALUES, a default, RETURNING, a LATERAL subquery, a window function's result, a function returning text or rows of text, a PL/pgSQL `$1`, a value EXECUTE ... USING passes, RAISE's `%` and options), as the session's search_path shows it: bare where its name finds it alone, else with its schema (`pg_catalog.sum`, and `pg_catalog.array_in` when a function `array_in` is made on the path). A function of text or numbers (`lower`, `substr`, `md5`, `abs`, `hashtext`), one made here whose parameter is text or a number, an aggregate of numbers, booleans or text (`sum`, `avg`, `string_agg`), arithmetic, `||` with anything but text, and LIKE, ILIKE, SIMILAR TO and `~` take no regproc (42883); it casts only to oid, integer, bigint, text (and varchar or char) and regprocedure, any other cast being 42846; and PL/pgSQL's RETURN QUERY of a regproc for a column of another type is 42804, as in Postgres. `ALTER COLUMN ... TYPE` of a regproc column converts its values as it runs, by USING's casts (`using p::oid::text` writes the oids' digits, plain `type text` the names), and rebuilds its indexes and unique constraints from them. A string is read as an oid only when it is all digits, as Postgres's oidin reads one (`'00042'` is octal, `namein`; `'-1'` and `' 42'` are names, 42883; past 32 bits is 22003), and an integer cast to a regproc is an oid (a negative int4 wraps around, `(-1)::regproc::oid` is 4294967295; past 32 bits is 22003). A foreign key on a regproc column refers by the oid, so a reference written under one search_path holds its parent under another. A built-in function's name or oid reads both ways from the oids of Postgres 16.13's 3,286 built-in functions (`src/sql/builtin_procs.tsv`): `'now'::regproc::oid` is 1299, `42::regproc` is `int4in`, `'substring(text,int,int)'::regprocedure` is `"substring"(text,integer,integer)`, a name several have is 42725, and an overload stays the one it is (`'abs(int)'::regprocedure::regproc::oid` is 1397). pg_catalog is searched first unless the search_path names it later, so a function made here with a built-in one's name and argument types is hidden behind it, as in Postgres. The catalog's regproc columns (`typinput`, `amhandler`, ...) are regprocs, and regprocs compare with numbers and each other, and order (ORDER BY, windows, an aggregate's ORDER BY, GROUP BY, DISTINCT, UNION, min and max), by oid; comparing one with a string literal (`typinput = 'int4in'`) reads the string as an oid and fails (22P02), and with text (`p = '1299'::text`, a text column or PL/pgSQL variable) is 42883, as in Postgres. CASE and COALESCE of a regproc and an integer sort by oid with the integer among them. Beside a string literal or an integer in CASE, COALESCE, GREATEST, LEAST, UNION or VALUES a regproc stays one (the literal read as one, the integer an oid), and beside text it is 42804, as in Postgres. A table's schema keeps a regproc default, ADD COLUMN value and partition bound as the oid, as its rows and unique keys do, so they read back without the catalog and an overload stays the one it is. EXECUTE's arguments and a driver's text parameters (Bind) are read in the session's world, so a regproc parameter names a function made here. A function made here gets an oid of its own when it is made (OR REPLACE keeps it), from a counter every world shares (from 2^31 up), and keeps it, so a regproc kept in a table names the same function after other objects are made or dropped, in every world and after worlds merge (a merge and `DIFF ... AS SQL`, which writes the oid, carry it); one made before oids were kept has one worked out from its name and argument types (from 2^30 up). Differences: `pg_proc` has no rows for the built-in functions, so joining a regproc to `pg_proc.oid` finds only functions made here; `hnsw`'s `amhandler` (pgvector's `hnswhandler`) has an oid of Chronos's own, 16301; extensions' functions (pg_trgm's, pgvector's) and `information_schema`'s aren't among the built-in ones; `ARRAY[...]` and `array_agg` of regprocs are `text[]` of their names, where Postgres has `regproc[]` (so PL/pgSQL's RETURN QUERY takes text for a regproc column, read as one, where Postgres takes only a regproc); a function made here with an `oid` parameter has a bigint one (an oid here is a bigint), so a regproc given to it is 42883, where Postgres converts it; `min` and `max` of regprocs are bigints (an oid here is a bigint), where Postgres's are oids; a string written to a regproc column is read along the search_path when it is written (a name found in no way at that point is 42883), as Postgres does; `regproc[]` and `regprocedure[]` are refused as types (0A000); and `pg_type` lists `regproc`, `regprocedure`, `_regproc` and `_regprocedure`, though no value here has an array type of them.
- **void:** a function returning void (`pg_sleep`, `pg_notify`, `pg_advisory_lock`, `pg_advisory_xact_lock`, `pg_advisory_unlock_all`, `setseed`, a PL/pgSQL function `RETURNS void`) gives the void value, as in Postgres: shown as nothing, not NULL (`IS NULL` is false), `pg_typeof` says `void`, and a driver gets type 2278 with an empty value (in binary too). A SQL-language function returning void gives NULL, as Postgres's does when it runs one, and what its body gives (the void value of the function it calls) where Postgres inlines it, as it does a body that is one SELECT of one void value with no FROM, WHERE, WITH, subquery or other clause (`select pg_notify('c', m)`, `select pg_sleep(0)`), no more volatile than the function, strict throughout and reading every parameter if the function is STRICT, and not an IMMUTABLE one called with constants. Differences: a SECURITY DEFINER one is inlined, where Postgres runs it (NULL); an IMMUTABLE one in FROM is taken as called with constants (NULL) even beside the columns of a table before it, where Postgres inlines it; and an argument a body reads twice is not looked at, where Postgres runs the function (NULL) when that argument is volatile or costly. void has no operators but `||` with text, and nothing groups, sorts, tells apart (DISTINCT, or DISTINCT ON a void expression: a void column beside the ON expressions is fine) or combines (but UNION ALL) by it (42883); a table or view can't have a void column (42P16), though CREATE TABLE AS or CREATE MATERIALIZED VIEW IF NOT EXISTS over a relation already there skips before looking at its columns, as in Postgres. `''::void` and a column or parameter declared void aren't read (42704).
- **Indexes:** GIN only on a tsvector, GiST only on a point column, no index on a whole `jsonb` column, no `ON CONFLICT (expression)`.
- **Functions and triggers:** only `LANGUAGE sql` and `plpgsql`. No `INSTEAD OF`, `TRUNCATE` or constraint triggers, and no transition tables. PL/pgSQL has no cursors, `FOREACH`, labels, `%TYPE`/`%ROWTYPE`, `OUT`/`INOUT`/`VARIADIC` parameters, `RETURNS record`, DDL or transaction control ([PL/pgSQL](sql.md#plpgsql)).
- **Overloaded functions:** a call's plain name means every function of that name on the `search_path`, chosen among by argument types as Postgres chooses: those the arguments fit (as they are or converted implicitly), then the most exact matches, then the most conversions to the preferred type (double precision, timestamptz), then for unknown arguments (a quoted literal, NULL) the category each such place takes against all the candidates at once (text's if any takes text there), so `m('1', '1')` between `m(int, text)` and `m(text, int)` is 42725; a function in an earlier schema hides only a later one whose parameters taking the call's arguments have the same types (whatever defaults either takes for the rest, as Postgres decides, so `f(x int)` first hides `f(x int, y int default 0)` for `f(1)`), so `f(int)` in the first schema doesn't hide `f(text)` in the second; named arguments, a parameter (`$1` of its declared type, a SQL or PL/pgSQL function's parameter), a window function's result and a cast in INSERT's VALUES choose by their types too; a tie is 42725 and nothing that fits 42883. `CALL` and `DROP FUNCTION` find them the same way, and a function's body finds them when it runs, so an overload made after it is called from it. A function made here with a built-in's name (`abs(text)`, `lower(int)`, `length(text)` before `pg_catalog` on the path) is called where it fits the arguments better than every built-in of that name, or as well from a schema before `pg_catalog`, in a query and wherever else a call is (VALUES, LIMIT, a default, a generated column, PL/pgSQL); COALESCE, NULLIF, GREATEST and LEAST are syntax, always the built-in. Differences: smallint and real are integer and double precision here, so `f(1::smallint)` between `f(int)` and `f(bigint)` takes `f(int)` where Postgres finds it ambiguous, and varchar is text: a function of `varchar` is the same as one of `text` (making both in one schema is 42723), so one in an earlier schema hides the other in a later one where Postgres keeps both and takes the `text` one for `'x'`; a built-in with a parameter Chronos can't weigh (an array, `oid`, a reg type) and one Chronos implements with syntax of its own (aggregates, window functions) is always called over a function made here; and with the default `search_path` a function made in public with a built-in's name is never called by its plain name.
- **Column defaults:** a default Postgres works out afresh for each row is refused (0A000), except a sequence's `nextval`, `gen_random_uuid()`, `now()` and `current_date` on their own: `random()`, `now() + interval '7 days'`, `timezone('utc', now())` and functions of your own among them. `chronos import postgres://` brings such a column over without its default and reports it.
- **Temporary tables:** `ROLLBACK TO SAVEPOINT` doesn't take back their changes; `CREATE TEMP TABLE (LIKE ...)`, partitioned or inheriting temp tables, `MERGE` and writable `WITH` on one are 0A000.
- **Views:** `WITH CHECK OPTION` works on automatically updatable views; no `ON CONFLICT` through a view, no `ALTER VIEW ... RENAME COLUMN`, and a table or view another view reads can't be renamed (0A000: views name what they read).
- **Also:** `to_char`'s `EEEE`, `RN`, `TH` and `V`, PostGIS lines, polygons and `ST_Transform`, and enums in primary keys ([Not yet](sql.md#not-yet)).

### Tools that work

- **pg_dump** (plain scripts, `--schema-only`, `--data-only`, tables and schemas by name, and the directory format in parallel, `-Fd -j N`) reads the catalog and writes a script that restores, into Postgres and into Chronos, to the same database ([Dumping with pg_dump](sql.md#dumping-with-pg_dump)). Parallel dumps rely on `pg_export_snapshot()` and `SET TRANSACTION SNAPSHOT`: a transaction that imports another's snapshot reads exactly what that one reads (rows committed before it began, not its own writes), until it ends. One difference from Postgres: such a transaction only reads (a write, `nextval` or `NOTIFY` in it is 25006, as in a READ ONLY one), and its COMMIT changes nothing.
- **pgbench** (`-i`, the TPC-B transaction, `-S`, `-N`, in simple, extended and prepared mode) runs; with several clients on the same rows, retry with `--max-tries` ([Transactions](sql.md#transactions)).

## Chronos-only SQL

Worlds, time travel, agents and simulations are SQL statements too ([Branches in SQL](sql.md#branches-in-sql), [Time travel](sql.md#time-travel), [Agents](sql.md#agents), [Simulations](sql.md#simulations)):

```sql
create world agent_7 with (owner = 'claude', task = 42);
switch world agent_7;
show worlds;                               -- name, id, parent, depth, created, version, meta, ...
diff world agent_7;                        -- table, id, change, before, after, columns
merge world agent_7 dry run;
merge world agent_7;
select * from orders as of '-1 hour';
create agent bot with (can = 'read,fork,write_own');   -- one row: its token
```

- **To a driver they're ordinary statements.** Send them through the simple or the extended protocol (tests/pg.rs runs `diff` and `create agent` through the driver's `query`). The ones that answer (`SHOW WORLDS`, `DIFF`, `MERGE ... DRY RUN`, `SHOW AUDIT`, `SIMULATE`, `CREATE AGENT`) return an ordinary result set, with `jsonb` columns for metadata and rows (`meta`, `before`, `after`). The others return a command tag.
- **Parameters work where a value goes:** `select * from orders for system_time as of $1`.
- **Not inside a transaction:** world statements fail with 25001 inside `BEGIN`. Drivers that open a transaction for you (psycopg and psycopg2 by default, JDBC with autocommit off) need autocommit for them.
- **Names:** world names with dashes need double quotes (`create world "agent-7"`), as identifiers do.

## Differences that bite

- **A multi-statement simple Query isn't atomic.** Postgres runs `insert ...; insert ...;` sent as one Query as one implicit transaction. Chronos commits each statement as it runs, so when the second fails, the first stays. Wrap them in `BEGIN ... COMMIT`.
- **Isolation is always snapshot.** A transaction reads the database as it was at `BEGIN`, plus its own writes. Only rows it wrote or locked are checked for conflicts, so write skew can happen, as under Postgres's `REPEATABLE READ`. `READ COMMITTED`, `REPEATABLE READ` and `READ ONLY` are accepted and give snapshot isolation. `SERIALIZABLE` is refused with 0A000 rather than quietly giving less.
- **Row locks don't wait; the later `COMMIT` fails.** `SELECT ... FOR UPDATE` (or `NO KEY UPDATE`) in a transaction locks the rows of each table it reads, or of those named in `OF`. Its `COMMIT` fails with 40001 if another commit changed one of them, or locked one `FOR UPDATE`, since its `BEGIN`. `FOR SHARE` / `FOR KEY SHARE` rows fail the same way, but two shared locks don't clash. So "lock the unit, check it's free, hold it" lets one of two racing transactions through, and the other retries and sees the unit taken. Postgres would make the second one wait; under `READ COMMITTED` it then reads the first one's hold and says "taken" without an error. Chronos's snapshot can't take in a commit made after `BEGIN`, so it fails the transaction instead. Code that expects to wait must retry on 40001. Outside a transaction `FOR UPDATE` just reads. `NOWAIT` is accepted; `SKIP LOCKED` is 0A000; locked tables need a primary key.
- **Conflicts surface at COMMIT.** Postgres fails the second `UPDATE` of a row; Chronos fails the `COMMIT` with 40001. A `COMMIT` can also fail with 23505 or 23503, because constraints are checked again when the transaction merges. Retry loops must wrap the whole transaction, `COMMIT` included ([Transactions](sql.md#transactions)).
- **The world is connection state.** After `SWITCH WORLD`, the connection stays there until it switches back, so a pooled connection hands the next borrower whatever world it was left in. Put the world in the connection string (one pool per world), or switch back before returning the connection.
- **Number counters belong to the database, not the world.** `serial`, identity columns and sequences share one counter across all worlds, so numbers taken in a fork never collide at merge. main sees gaps where forks took numbers, `setval` and `RESTART` move the counter for every world, and time travel and `RESTORE` don't rewind it ([Numbering rows](sql.md#numbering-rows)). A transaction that restarts a serial counter (its table dropped and made again, or `TRUNCATE ... RESTART IDENTITY`) numbers its own rows from the start, as Postgres's new sequence does, and the counter moves past them at `COMMIT`; `ROLLBACK` leaves the old counter as it was.
- **NOTIFY stays in its world.** Only listeners in the same world hear it, a merge sends nothing, and a `LISTEN` inside a transaction takes effect at once, not at `COMMIT` ([LISTEN and NOTIFY](sql.md#listen-and-notify)).
- **Time zones need a tz database.** Named zones with daylight saving time (`America/New_York`, `Europe/London`) work as in Postgres, read at runtime from the system's tz database (`/usr/share/zoneinfo`, or `TZDIR`; install `tzdata` in a minimal container). Without one, only UTC, fixed offsets and zones with one offset all year (`Asia/Kolkata`) are known, and another name fails with 22023, at `SET` or when a client asks for it at connect (JDBC sends the JVM's zone). Zone data is the OS's, so a few old dates can differ from Postgres's own copy of tzdata (the legacy `CET`, `EET`, `MET` and `WET` zones before 1980, for one). Not built: `timetz` and `time AT TIME ZONE`, `SET timezone_abbreviations`, `datestyle`'s DMY input order ([Dates and times](sql.md#dates-and-times)).
- **Text sorts by bytes**, as `COLLATE "C"` does. A Postgres database with `en_US.UTF-8` orders text differently ([Text order](sql.md#text-order)).
- **Types arrive narrowed.** A `smallint` column reaches clients as `int4`, `real` as `float8`, `varchar(n)` as `text` (`uuid` is its own type). A `smallint` column is one all the same: it refuses what doesn't fit 16 bits (22003), `x::smallint` checks the range, and the catalogs, `pg_dump` and psql's `\d` show it as `smallint` (arithmetic on it, `a + b`, is an integer and is not range-checked until it is written to a column or cast). A table made by `CREATE TABLE ... AS` or `SELECT INTO`, or a view, takes its columns' types as Chronos types them: a smallint column is an integer there, a `varchar(n)` text. RowDescription carries no table oid or type modifier, so tools that map result columns back to tables, or read `varchar(n)` and `numeric(p, s)` from it, get nothing.
- **Errors carry a code, a message, a position and a hint**, but no DETAIL or constraint, table or column name, so code that parses a unique violation's constraint out of the error gets nothing.
- **`server_version` says 16.0.** Clients that switch behavior on the version see 16. The differential suite runs against 17.
- **Views look names up when they're read**, along the reading session's `search_path`, and `select *` in a view picks up columns added later ([Views](sql.md#views)).

- **Network address types:** `inet`, `cidr`, `macaddr` and `macaddr8` work as columns, literals, casts and in the operators and functions Postgres has for them (`<<`, `>>=`, `host()`, `netmask()`, `set_masklen()`, ...); see [sql.md](sql.md#network-address-types).

- **SQL/JSON path:** `jsonb_path_*` and `@?`/`@@` work as Postgres 16's do (see [sql.md](sql.md#sqljson-path)); `jsonpath` is not a distinct type (text).

- **Partitioning and inheritance, known gaps:** index names are database-wide rather than per schema (so `\di`, `regclass` of an index, and `DROP INDEX` on a partition's index differ outside `public`); `ADD CONSTRAINT name PRIMARY KEY` ignores the name (the key is `<table>_pkey`); `PARTITION OF` column lists take only `NOT NULL` and `CHECK`; `pg_partitioned_table.partclass`/`partcollation` are 0; temporary partitioned tables and children, `ALTER TABLE ... SET (fillfactor)` on a partitioned table, `ON CONFLICT ON CONSTRAINT <parent key>` on a partitioned table, and `COPY` error `CONTEXT` lines are not supported; `pg_depend` lacks the partition-to-parent row. SQLSTATEs match Postgres in the cases compared; some message wording differs.

- **Refused, and not listed above (0A000 unless noted):** `CREATE CONSTRAINT TRIGGER` and `CREATE EVENT TRIGGER`; `EXCLUDE` constraints; `CREATE SCHEMA ... <objects>`; `EXPLAIN` with `FORMAT json`, `xml` or `yaml`, and `EXPLAIN` of `MERGE` or `EXECUTE`; `MERGE` with `INSERT ... OVERRIDING`, on a view or a temp table, or without a primary key; `DECLARE BINARY` cursors; `COLLATE` other than `C`, `POSIX` or `default`; `array_fill` with lower bounds or several dimensions; `ADD COLUMN serial` on a table with rows; `ALTER TABLE ... TYPE ... USING` an expression other than the column or a cast of it; `ALTER TYPE` and `CREATE TYPE` beyond enums; a parenthesized join after an outer join or `USING`; ordered-set aggregates with several `ORDER BY` keys or `OVER`; `DISTINCT` in a two-argument aggregate. These are 42601 (not parsed): `CREATE`, `ALTER` and `DROP` of `AGGREGATE`, `CAST`, `COLLATION`, `CONVERSION`, `FOREIGN TABLE`, `FOREIGN DATA WRAPPER`, `SERVER`, `LANGUAGE`, `OPERATOR`, `POLICY`, `PUBLICATION`, `SUBSCRIPTION`, `RULE`, `TABLESPACE`, `TEXT SEARCH ...`, `STATISTICS`, `ALTER DOMAIN`, `ALTER EXTENSION`, `SECURITY LABEL`, `REASSIGN OWNED`, `DROP OWNED`, `LOAD` and a bare `CHECKPOINT`. `SET ROLE` and `SET SESSION AUTHORIZATION` are accepted and do nothing.
