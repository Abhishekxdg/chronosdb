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

Watch out for: `SHOW` of Postgres settings (only [Chronos's own](#known-gaps) are known), `SELECT ... FOR UPDATE` (fails the later `COMMIT` rather than waiting, see [Differences that bite](#differences-that-bite)), advisory locks, `CREATE EXTENSION` other than `vector` and `postgis`, and `pg_get_serial_sequence` (returns NULL).

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
| Binary values | Parameters and results: `int2/4/8`, `float4/8`, `bool`, `text`, `json`/`jsonb`, `date`, `time`, `timestamp(tz)`, `interval`, `numeric`, `vector`, and 1-D arrays as parameters. `tsvector`/`tsquery` results in binary, parameters as text only | tests/pg.rs `postgres_driver`, `dates_over_the_wire`, `arrays_numeric_and_time_over_the_wire` |
| Execute's row limit | Ignored: every row comes back, never PortalSuspended | `src/pg.rs` header |
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
| Errors and notices | Severity, SQLSTATE and message only: no DETAIL, HINT, position or constraint/table/column names | `src/pg.rs` `error` |
| RowDescription | Column name and type; table oid, column number and type modifier are always 0, 0 and -1 | `src/pg.rs` `row_description` |
| FunctionCall | Not supported (08P01) | `src/pg.rs` `serve` |
| Replication, CopyBoth | Not supported | `src/pg.rs` `serve` |

## SQL surface

| Area | Status | See |
|---|---|---|
| `SELECT`, joins (inner, left, right, full, cross, `USING`), `GROUP BY`/`HAVING`, `DISTINCT`, `ORDER BY`/`LIMIT`/`OFFSET` | Supported | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| Subqueries, `UNION`/`INTERSECT`/`EXCEPT`, `WITH`, `WITH RECURSIVE`, `LATERAL`, `ANY`/`ALL` | Supported | [Subqueries, UNION and WITH](sql.md#subqueries-union-and-with) |
| Window functions | Partial: no `DISTINCT` in window aggregates, no `GROUPS` or `EXCLUDE` | [Window functions](sql.md#window-functions) |
| `INSERT`/`UPDATE`/`DELETE`, `RETURNING`, `ON CONFLICT`, `UPDATE ... FROM`, `DELETE ... USING`, `TRUNCATE` | Supported | [Upserts and CASE](sql.md#upserts-and-case) |
| Types | Partial: see [Known gaps](#known-gaps) | [What works now](sql.md#what-works-now) |
| Constraints: primary keys (one or several columns), `UNIQUE`, `CHECK`, `NOT NULL`, foreign keys | Partial: foreign keys only to primary keys, no `ON UPDATE CASCADE`, nothing deferrable, no `EXCLUDE` | [Unique constraints and foreign keys](sql.md#unique-constraints-and-foreign-keys) |
| `ALTER TABLE` | Supported for columns, defaults, `NOT NULL`, constraints, renames, adding a primary key | [Changing tables](sql.md#changing-tables) |
| Indexes | Partial: btree (expressions, partial, unique), GIN on tsvector, GiST on points, `hnsw`/`ivfflat` accepted. No hash indexes | [Indexes](sql.md#indexes) |
| Schemas and `search_path` | Supported, without owners or privileges | [Schemas](sql.md#schemas) |
| Views, materialized views | Partial: no `WITH CHECK OPTION`, no `ON CONFLICT` through a view | [Views](sql.md#views) |
| Sequences, `serial`, identity | Supported; counters shared by every world | [Sequences](sql.md#sequences) |
| Enums | Supported, except in primary keys | [Enum types](sql.md#enum-types) |
| Temporary tables | Partial: no `ON COMMIT DROP`/`DELETE ROWS` | [Temporary tables](sql.md#temporary-tables) |
| Functions and triggers, `LANGUAGE sql` and `plpgsql` | Partial | [Functions and triggers](sql.md#functions-and-triggers) |
| Full-text search (`tsvector`, `@@`, `ts_rank`) | Supported, but not `ts_headline` or `ts_rank_cd` | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| pgvector | Supported: `vector(n)`, `<=>`, `<->`, `<#>`, `USING hnsw` | [Vectors](sql.md#vectors-pgvector) |
| PostGIS | Points only | [Joins, grouping and functions](sql.md#joins-grouping-and-functions) |
| `information_schema` and `pg_catalog` | Partial: the tables introspection reads | [The catalog](sql.md#the-catalog-information_schema-and-pg_catalog) |
| Transactions | Snapshot isolation, whatever level is asked for | [Transactions](sql.md#transactions) |
| `EXPLAIN [ANALYZE]` | Text only, no costs | [EXPLAIN](sql.md#explain) |
| Roles, `GRANT`/`REVOKE`, row-level security | Not supported: permissions are [agents](concepts.md#agents) | |

### Known gaps

Each is an error (0A000 for known features, 42601 for statements Chronos doesn't parse), not a wrong answer.

- **Statements not parsed:** `GRANT`, `REVOKE`, `CREATE ROLE`/`USER`, `CREATE DATABASE` (use `CREATE WORLD`), `DECLARE`/`FETCH`/`CLOSE` cursors (so psycopg's named server-side cursors fail), `LOCK`, `VACUUM`, `ANALYZE`, `COMMENT ON`, `DO`, `CALL`, `DISCARD`, `RESET ALL`, standalone `VALUES`, and SQL's `MERGE INTO` (`MERGE` is Chronos's world merge).
- **Clauses:** `FOR UPDATE ... SKIP LOCKED`, `DISTINCT ON`, `FETCH FIRST n ROWS`, `GROUPING SETS`, `ROLLUP`, `CUBE`, `COPY ... WHERE`.
- **Types:** no `bytea`, composite, domain or range types, no `time with time zone`, `money`, `inet` or `xml`. Some types are stored as others and reach clients that way: `uuid`, `varchar(n)` and `char` as `text` (oid 25, so drivers return strings, not UUID objects), `smallint` as `integer`, `real` as `double precision`, `json` as `jsonb`, enums and PostGIS types as `text`.
- **`SHOW`:** only `search_path`, `statement_timeout`, `synchronous_commit`, `history_retention`, `max_worlds`, `world_idle_ttl` and Chronos's own `SHOW` statements. `SHOW server_version`, `SHOW transaction_isolation` and other Postgres settings are 42601.
- **`SET`:** `search_path`, `statement_timeout`, `TIME ZONE` / `TimeZone` and `hnsw.ef_search` take effect. `SERIALIZABLE`, asked for in `SET TRANSACTION`, `SET SESSION CHARACTERISTICS` or `SET default_transaction_isolation`, is 0A000. Every other `SET` (`application_name`, `TRANSACTION ISOLATION LEVEL READ COMMITTED`, ...) is accepted and ignored.
- **Functions:** no `version()`, `current_user`, `session_user`, `pg_backend_pid()` or advisory locks. `pg_get_serial_sequence`, `obj_description` and `col_description` return NULL.
- **Extensions:** `CREATE EXTENSION` accepts only `vector` and `postgis` (both built in). Others, `uuid-ossp`, `pgcrypto` and `pg_trgm` among them, are 0A000. `gen_random_uuid()` and `uuid_generate_v4()` are built in.
- **Catalog:** only the tables listed in [the catalog](sql.md#the-catalog-information_schema-and-pg_catalog). No `pg_enum`, `pg_proc`, `pg_roles`, `pg_settings`, `pg_stat_*` or `pg_relation_size`. `pg_database` is answered only for psql's `\l`. `NOT NULL` constraints aren't rows of `table_constraints`, and `pg_opclass` and `pg_description` are empty.
- **Indexes:** no hash indexes, GIN only on a tsvector, GiST only on a point column, no index on a whole `jsonb` column, no `ON CONFLICT (expression)`.
- **Functions and triggers:** only `LANGUAGE sql` and `plpgsql`. No `INSTEAD OF`, `TRUNCATE` or constraint triggers, and no transition tables. PL/pgSQL has no cursors, `FOREACH`, labels, `%TYPE`/`%ROWTYPE`, `OUT`/`INOUT`/`VARIADIC` parameters, parameter defaults, `RETURNS record`, DDL or transaction control ([PL/pgSQL](sql.md#plpgsql)).
- **Column defaults:** a default Postgres works out afresh for each row is refused (0A000), except a sequence's `nextval`, `gen_random_uuid()`, `now()` and `current_date` on their own: `random()`, `now() + interval '7 days'`, `timezone('utc', now())` and functions of your own among them. `chronos import postgres://` brings such a column over without its default and reports it.
- **Temporary tables:** `ON COMMIT DROP` and `DELETE ROWS` aren't supported, and `ROLLBACK TO SAVEPOINT` doesn't take back their changes.
- **Views:** no `WITH CHECK OPTION` or `ON CONFLICT` through a view, and a table a view reads can't be renamed.
- **Also:** regular expression lookaround, `to_char`'s `EEEE`, `RN`, `TH` and `V`, PostGIS lines, polygons and `ST_Transform`, and enums in primary keys ([Not yet](sql.md#not-yet)).

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
- **Number counters belong to the database, not the world.** `serial`, identity columns and sequences share one counter across all worlds, so numbers taken in a fork never collide at merge. main sees gaps where forks took numbers, `setval` and `RESTART` move the counter for every world, and time travel and `RESTORE` don't rewind it ([Numbering rows](sql.md#numbering-rows)).
- **NOTIFY stays in its world.** Only listeners in the same world hear it, a merge sends nothing, and a `LISTEN` inside a transaction takes effect at once, not at `COMMIT` ([LISTEN and NOTIFY](sql.md#listen-and-notify)).
- **Time zones have one offset all year.** `SET TIME ZONE 'Asia/Kolkata'` works as in Postgres, but a zone with daylight saving time (`America/New_York`, `Europe/London`) fails with 22023, at `SET` or when a client asks for it at connect (JDBC sends the JVM's zone: run it with `-Duser.timezone=UTC` or a fixed zone). A fixed zone uses its current offset for every date, where Postgres's zone data knows older ones ([Dates and times](sql.md#dates-and-times)).
- **Text sorts by bytes**, as `COLLATE "C"` does. A Postgres database with `en_US.UTF-8` orders text differently ([Text order](sql.md#text-order)).
- **Types arrive narrowed.** A `uuid` column reaches clients as `text`, `smallint` as `int4`, `real` as `float8`. RowDescription carries no table oid or type modifier, so tools that map result columns back to tables, or read `varchar(n)` and `numeric(p, s)` from it, get nothing.
- **Errors carry a code and a message only.** No DETAIL, HINT or constraint name, so code that parses a unique violation's constraint out of the error gets nothing.
- **No cursors or row limits:** Execute's row limit is ignored and `DECLARE` isn't parsed, so a driver's streaming or server-side cursor gets every row at once, or fails.
- **`server_version` says 16.0.** Clients that switch behavior on the version see 16. The differential suite runs against 17.
- **Views look names up when they're read**, along the reading session's `search_path`, and `select *` in a view picks up columns added later ([Views](sql.md#views)).
