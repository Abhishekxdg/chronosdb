# SQL

Chronos runs SQL itself (its own parser and executor) and speaks the Postgres protocol, so `psql`, GUI tools and Postgres drivers connect as they would to Postgres.

```bash
chronos serve mydb                            # HTTP on 7070, Postgres protocol on 5433
psql postgres://127.0.0.1:5433/main         # the database name is the branch
```

SQL also works in the shell (`chronos mydb`, end statements with `;` to spread them over lines), over HTTP (`POST /v1/sql` with `{"sql": "...", "params": [...]}`), through the clients (`db.sql(...)`), and as the MCP tool `sql`.

```sql
create table users (id bigint primary key, name text not null, age integer, admin boolean default false);
insert into users (id, name, age) values (1, 'Ada', 36), (2, 'Alan', 41) returning id;
select name, age from users where age > 30 and name like 'A%' order by age desc limit 10;
update users set admin = true where id = 1;
delete from users where age is null;
```

## Tables are the same data

A table made with `CREATE TABLE` stores each row as a JSON object keyed by its primary key, so `get users 1`, `find`, `diff` and merges see it too. A table made by writing JSON rows (`put notes a {...}`) has no schema: SQL sees its key as the text column `id`, plus every field any row has.

## What works now

- **Statements:** `CREATE TABLE [IF NOT EXISTS]`, `DROP TABLE [IF EXISTS] a, b [CASCADE]`, `CREATE [UNIQUE] INDEX`, `DROP INDEX`, `INSERT` (several rows, or `INSERT ... SELECT`), `SELECT` (joins and grouping below), `UPDATE [AS alias]`, `DELETE [AS alias]`, `TRUNCATE`, `RETURNING`, `EXPLAIN [ANALYZE]`, `COPY` (see [Loading and unloading](#loading-and-unloading-copy)), `PREPARE` / `EXECUTE` / `DEALLOCATE` (see [Prepared statements](#prepared-statements)), `CREATE TYPE ... AS ENUM` / `DROP TYPE` (see [Enum types](#enum-types)), `CREATE TEMP TABLE` (see [Temporary tables](#temporary-tables)), `CREATE SCHEMA` / `DROP SCHEMA` and `SET search_path` (see [Schemas](#schemas)), and [views](#views), [materialized views](#materialized-views), [sequences](#sequences), [LISTEN / NOTIFY](#listen-and-notify), and `CREATE FUNCTION` / `CREATE TRIGGER` (see [Functions and triggers](#functions-and-triggers)).
- **Clauses:** `WHERE`, `ORDER BY` (by expression, name or position, `ASC`/`DESC`, `NULLS FIRST`/`LAST`; nulls sort last going up by default, as in Postgres), `LIMIT`, `OFFSET`.
- **Expressions:** `= <> < <= > >=`, `AND OR NOT`, `IS [NOT] NULL`, `[NOT] IN`, `[NOT] LIKE / ILIKE`, `BETWEEN`, `+ - * / %`, `||`, `CAST` and `::`.
- **Types:** `integer`, `bigint`, `double precision` (also `real`), `numeric` (also `decimal`), `text` (also `varchar` and `uuid`), `boolean`, `jsonb`, `date`, `time`, `timestamp`, `timestamptz`, `interval`, pgvector's `vector` (see [Vectors](#vectors-pgvector)), and enums (see [Enum types](#enum-types)). Any other type name is an error (42704) naming these.
- **`numeric` is exact:** up to 38 digits, with `numeric(p, s)` rounding to its scale on every write (22003 past its precision). As in Postgres, a literal like `1.5` is numeric, so `0.1 + 0.2 = 0.3`; numeric with a float gives a float. Division keeps at least 16 significant digits (`1/3.0` is `0.33333333333333333333`), and `sum`/`avg` of numeric stay exact. Over the Postgres port it travels exactly, in text or binary; in JSON (the HTTP API, `get`) it's a number, so past about 15 digits the JSON view rounds.
- **Constraints:** `PRIMARY KEY` (one column: integer, bigint or text; or several, see [Keys of several columns](#keys-of-several-columns)), `NOT NULL`, `DEFAULT`, `CHECK`, `UNIQUE` (one or more columns), and foreign keys (`REFERENCES`, `FOREIGN KEY`) with `ON DELETE CASCADE`, `SET NULL` or `RESTRICT` / `NO ACTION`.
- **Generated values:** `serial`, `bigserial` and `GENERATED ... AS IDENTITY` columns, and `DEFAULT gen_random_uuid()`, `DEFAULT now()` or `DEFAULT current_date`. `DEFAULT` can also go in a `VALUES` list.
- **Changing tables:** `ALTER TABLE` can add, drop and rename columns, rename the table, change a column's type, and set or drop its default or `NOT NULL`, several changes in one statement.
- **Parameters:** `$1, $2, ...`, with types inferred from use as Postgres does.
- **Errors:** Postgres SQLSTATE codes (23505 duplicate key, 42P01 no such table, ...).

Outside a transaction each statement commits on its own, durably on `main` (see [concepts](concepts.md)).

## Joins, grouping and functions

```sql
select c.name, count(o.id) as orders, sum(o.total)
from customers c left join orders o on o.customer = c.id and o.status = 'paid'
where c.city = 'London'
group by c.name
having count(o.id) > 0
order by orders desc;
```

- **Joins:** `[INNER] JOIN`, `LEFT`, `RIGHT` and `FULL [OUTER] JOIN`, each `ON ...` or `USING (cols)`, `CROSS JOIN`, and `FROM a, b`. Tables can have aliases (`orders o`), columns can be qualified (`o.total`), and `t.*` selects one table's columns.
  - **`USING`:** as in Postgres, `*` shows each USING column once and first, and a bare name means the joined value (for `FULL`, the first non-null of the two sides). `a.x` and `b.x` still name each side.
  - **`RIGHT` and `FULL`:** every row of the right table appears, matched or padded with nulls (and for `FULL`, every left row too). Chronos reads the right table whole and hashes it on an equality in `ON`; without one, it compares every pair.
  - **Join order:** with only inner joins, Chronos starts from the table its conditions narrow most (a key lookup, or the fewest index matches), then joins linked tables, key links first. Outer joins keep the written order.
  - **Few rows so far (up to 1,000):** a join on the next table's primary key reads just the matching rows. A join on another integer, text or boolean column looks each value up in that table's index.
  - **Otherwise,** equality joins use a hash join, and joins on anything else compare every pair.
  - **Conditions on one table** are applied, and use its index, as it's read.
- **Aggregates** (each can take `FILTER (WHERE ...)`): `count(*)`, `count(x)`, `count(distinct x)`, `sum`, `avg`, `min`, `max`, `bool_and`/`every`, `bool_or`, and `string_agg(x, sep)`, `jsonb_agg`, `jsonb_object_agg(k, v)`, `array_agg` (as Postgres's array text, `{1,2}`), each with its own `ORDER BY` (`string_agg(name, ', ' order by name)`) and `DISTINCT`, with `GROUP BY` (expressions, output names or positions), `HAVING` and `SELECT DISTINCT`. A column that's neither grouped nor aggregated is an error (42803), as in Postgres.
- **Functions**, with Postgres's names, NULL rules and edge cases:
  - **Text:** `lower`, `upper`, `length`/`char_length`, `octet_length`, `concat`, `concat_ws`, `substring` (also `substring(s from a for b)`) and `substr`, `position(a in s)` and `strpos`, `replace`, `trim` (also `trim(leading 'x' from s)`), `btrim`, `ltrim`, `rtrim`, `left`, `right`, `lpad`, `rpad`, `repeat`, `reverse`, `split_part`, `initcap`, `ascii`, `chr`, `starts_with`.
  - **Math:** `abs`, `round(x[, places])`, `ceil`, `floor`, `trunc(x[, places])`, `sign`, `mod`, `power`, `sqrt`, `exp`, `ln`, `log(x)` / `log(b, x)`, `pi`, `random`, `setseed` (see [Simulations](#simulations)), `greatest`, `least`.
  - **NULLs:** `coalesce`, `nullif`.
  - **Dates:** see below, plus `make_date(y, m, d)`, `to_timestamp(epoch seconds)`, `age(a[, b])` (years, months and days by the calendar, as Postgres counts them) and `to_char(ts, 'YYYY-MM-DD HH24:MI')` (Postgres's date and time patterns: `YYYY`, `MM`, `Mon`, `Month`, `DD`, `Day`, `Dy`, `HH12`, `AM`, `MI`, `SS`, `MS`, `US`, `Q`, `DDD`, `FM`, `"literal"`).
  - **Numbers as text:** `to_char(n, 'FM9,999.00')` with Postgres's number patterns: `9`, `0`, `.`/`D`, `,`/`G`, `S`, `MI`, `PL`, `SG`, `PR`, `FM` and `"literal"`.
  - **Regular expressions:** `s ~ 'pattern'` (`~*` ignoring case, `!~` and `!~*` negated), `regexp_replace(s, pattern, replacement[, 'gi'])` (with `\1` and `\&`), `regexp_match`, `regexp_like`, `regexp_count`, `regexp_substr`, `regexp_split_to_array`, and in FROM `regexp_split_to_table` and `regexp_matches`. `s SIMILAR TO 'pattern' [ESCAPE 'c']` (and `NOT SIMILAR TO`), with `%`, `_`, `|`, `*`, `+`, `?`, `{n,m}`, `()` and `[...]`. Postgres's common syntax: classes (`[a-z]`, `[[:alpha:]]`, `\d \w \s`), anchors, groups, alternation, and greedy and lazy quantifiers. No lookaround. A pattern that would backtrack for too long stops with 54001.
  - **Arrays:** `text[]`, `integer[]` and other array columns (stored as Postgres's array text), `ARRAY[...]`, `a[i]` (from 1; outside the array: null), `string_to_array`, `unnest`, `= ANY(...)`. `jsonb` takes subscripts too: `doc['key']`, `doc['list'][0]`.
  - **Ranked search:** `search('table', 'words' [, k])` in FROM: the built-in text index's best k rows (BM25, typo-tolerant), as `id`, `score`, `row` (jsonb). See [search](search.md).
  - **Full-text search, as Postgres does it:** `to_tsvector([config,] text)`, `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`, `websearch_to_tsquery`, `@@`, `ts_rank([weights,] vector, query [, normalization])`, `setweight`, `strip`, `tsvector || tsvector`, and `tsvector`/`tsquery` columns and casts. The `english` (the default) and `simple` configurations match Postgres's: its parser, stop words and Snowball stemmer, checked word for word on 20,000 dictionary words. `text @@ text` and `text @@ tsquery` work as in Postgres. `CREATE INDEX ... USING gin (to_tsvector('english', body))` (or on a `tsvector` column) keeps an entry per lexeme: `@@` with the same expression reads the rows its query's lexemes allow (`&` intersects, `|` unites, `:*` reads a range) and checks just those, 12 times faster than a scan at 100,000 rows. As in Postgres, the index's expression must match the query's (config included). Without one, `@@` computes each row's vector as it scans. Not yet: `ts_headline`, `ts_rank_cd`, and the parser's file-path and version tokens.
  - **Points, as PostGIS does them:** `geometry` and `geography` columns and casts (hex EWKB, WKT or `SRID=4326;POINT(lon lat)`), `ST_MakePoint`, `ST_Point`, `ST_SetSRID`, `ST_SRID`, `ST_GeomFromText`, `ST_GeogFromText`, `ST_GeomFromGeoJSON`, `ST_AsText`, `ST_AsEWKT`, `ST_AsGeoJSON`, `ST_X`, `ST_Y`, `ST_Distance` (meters on the WGS84 ellipsoid for geography, the exact geodesic, or on PostGIS's sphere with `false`), `ST_DWithin` and `ST_DistanceSphere`, checked against PostGIS 3.6. Values print as PostGIS prints them, and clients receive them as text. `CREATE INDEX ON places USING gist (location)` makes `ST_DWithin(location, point, distance)` read only the band of latitudes (or y) the distance can reach, then check those rows: a 1 km search among 200,000 points worldwide reads about 20 rows. `a <-> b` is PostGIS's distance operator (planar for geometry, on the sphere for geography), and `ORDER BY location <-> point LIMIT k` (or `ORDER BY ST_Distance(location, point)`) reads nearest first from the index, widening its search until the LIMIT fills: the nearest 10 of 200,000 points take about 1 ms. `CREATE EXTENSION postgis` is accepted. Not yet: lines and polygons, and `ST_Transform`.
  - **Other:** `md5(text)`, `format(fmt, ...)` (`%s`, `%I` for identifiers, `%L` for literals, `%%`, positions `%2$s`, widths `%-10s` and `%*s`), `quote_ident`, `quote_literal` and `quote_nullable`, as Postgres writes them.
  - **jsonb:** `->` and `->>` (a field or array element, as jsonb or text), `#>` and `#>>` (a path, `'{a,b,0}'`), `@>` and `<@` (containment), `?`, `?|`, `?&` (keys), `||` (merge), and `jsonb_build_object`, `jsonb_build_array`, `to_jsonb`, `jsonb_typeof`, `jsonb_array_length`, `jsonb_extract_path(_text)`, `jsonb_set`, `jsonb_strip_nulls` (`json_` names too). jsonb prints as Postgres prints it: `{"a": 1, "bb": [1, 2]}`, shorter keys first.
  - Functions made with `CREATE FUNCTION` too: see [Functions and triggers](#functions-and-triggers).
  - An unknown function is error 42883, as in Postgres, and the message lists the functions there are.

## Unique constraints and foreign keys

```sql
create table users (id serial primary key, email text unique, org int references orgs on delete cascade);
alter table posts add constraint posts_author_fkey foreign key (author) references users on delete set null;
```

- **When they're checked:** at every statement, and again at every merge, including a transaction's `COMMIT`. Two branches can each be valid and still clash together: the same email on both, or one side deleting a row the other side's new row references. The merge then fails with 23505 or 23503, merges nothing, and says which rows clash. That holds even when you force a side with `USING OURS` / `THEIRS`.
- **How they're stored:** each unique value and each reference is a small index row, so a check is one lookup (about 1 µs), not a scan. Those rows don't show in `DIFF`.
- **Changing them:** `ALTER TABLE ... ADD CONSTRAINT` checks existing rows first. `DROP CONSTRAINT` removes one. Constraints follow renamed tables and columns, and a table others reference can't be dropped.
- **Several columns:** `FOREIGN KEY (a, b) REFERENCES t` references a primary key of several columns (naming its columns in any order), with `MATCH SIMPLE`'s rule: a row with a null among them references nothing.
- **Not yet:** foreign keys to anything but the primary key, `ON UPDATE CASCADE`, and deferrable constraints.
- **JSON writes too:** agents' `put`, `delete` and `batch` (shell, HTTP, MCP, Rust) on a SQL table are checked like an `INSERT`. See [JSON writes into SQL tables](#json-writes-into-sql-tables).

## JSON writes into SQL tables

Agents writing JSON rows (`put`, `delete`, `batch`, over the shell, HTTP, MCP or Rust) into a table made with `CREATE TABLE` get the same rules as SQL, in the same transaction-like batch:

- **Columns:** the row must be a JSON object of the table's columns (an unknown column is 42703) with values that fit their types (22P02). A missing column gets its default, a `serial` number or a UUID. `NOT NULL` holds (23502).
- **Keys:** the key names the row. `put users/5` sets `id` to 5, and an `id` that disagrees with the key is refused (23514).
- **Constraints:** `UNIQUE` and foreign keys hold (23505, 23503), and a delete follows `ON DELETE`.
- **Storage:** the row is stored packed, and read back as JSON.
- **HTTP status:** a row that doesn't fit is a 400; a clash is a 409.
- **Reserved names:** keys and tables starting with `_sonos` are the database's own bookkeeping (schemas, constraint indexes, agents). Nobody can read or write them with SQL or JSON writes, or create or rename a table to such a name.

Tables made by writing JSON (no `CREATE TABLE`) stay free-form. Until a SQL table exists, JSON writes skip these checks entirely.

- **Triggers:** JSON writes to a table with triggers turned on are refused (0A000): triggers fire for SQL's `INSERT`, `UPDATE` and `DELETE` only, and a write that skipped them would leave their work undone. `ALTER TABLE ... DISABLE TRIGGER` lets JSON writes in again.

## Upserts and CASE

```sql
insert into stock (sku, qty) values ('a', 3)
on conflict (sku) do update set qty = stock.qty + excluded.qty
returning *;

select name, case when total >= 100 then 'big' when total >= 10 then 'mid' else 'small' end
from orders;
```

- **`ON CONFLICT`:** `DO NOTHING`, or `DO UPDATE SET ... [WHERE ...]`, on the primary key or any `UNIQUE` constraint: named by its columns in any order, `ON CONFLICT (room, num)`, or by its name, `ON CONFLICT ON CONSTRAINT seat_room_num_key`. `DO NOTHING` without a target skips any clash.
  - `excluded.col` is the row that was to be inserted, and bare column names mean the existing row.
  - `INSERT INTO t AS alias` works.
  - Columns `SET` doesn't name keep their values.
- **`CASE`:** both the `CASE WHEN ...` and `CASE value WHEN ...` forms, anywhere an expression goes, including inside and around aggregates.

## Numbering rows

A `serial` column (and `GENERATED ... AS IDENTITY`) takes the next number from a counter that belongs to the database, not to any branch, so rows inserted on two branches at once never collide when they merge. Taking a number writes nothing to any branch: inserts in a fork leave main's rows and version as they were. As with Postgres sequences:
- **Not taken back:** a rollback or a failed insert still uses its number.
- **Gaps:** a restart can skip numbers, because numbers are reserved 64 at a time. A branch sees gaps where other branches took numbers too: after a fork inserts 3 rows, main's next row may be 5, not 2.
- **Never twice:** the counters are logged and kept in every checkpoint, so a restart or a crash never hands a number out again. Time travel doesn't rewind them: restoring a world to the past leaves the counters where they are.

`CREATE SEQUENCE` makes a named one, and `DEFAULT nextval('name')` numbers a column from it (see [Sequences](#sequences)).

`gen_random_uuid()` gives version-4 UUIDs, a good fit for rows made on branches.

## Dates and times

```sql
create table events (id serial primary key, at timestamptz default now(), day date, lasts interval);
select * from events where at > now() - interval '7 days' order by at desc;
select date_trunc('month', at) as m, count(*) from events group by m order by m;
select day + 7, extract(dow from day), at - '2024-01-01'::timestamptz from events;
```

- **Time zone:** timestamps are stored in UTC, and the session zone is always UTC.
- **Values:** `date '2024-03-10'`, `timestamp '...'` and `interval '1 day 02:00'` literals, or plain text where a date is expected, and `now()`, `current_date` and `current_timestamp`.
- **Arithmetic:** timestamp ± interval (months by the calendar: Jan 31 + 1 month is the end of February), timestamp − timestamp, date ± days, and date − date.
- **Functions:** `date_trunc(unit, …)`, `extract(field from …)` and `date_part(field, …)`.
- **Times of day:** `time` (`time without time zone`), e.g. `'09:30'`, `time '17:00:00.5'`, `localtime`.
  - time ± interval moves the clock and wraps past midnight, time − time is an interval, date + time is a timestamp, `ts::time` takes a timestamp's time of day, and `extract(hour | minute | second from t)` works.
  - `current_time` is the time now in UTC, with no zone. There's no `time with time zone`: use `timestamptz`.
- **Outside SQL:** JSON shows ISO 8601.

## Changing tables

Rows aren't rewritten when a table changes. Each packed row records the column layout it was written with, so:
- **Old rows keep working:** after columns are added, dropped, renamed or retyped, old rows read through their own layout.
- **Across branches:** a branch that changed a table merges cleanly with rows another branch wrote under the old layout.
- **Type changes:** changing a type checks every value converts first, and refuses if one doesn't.
- **Renaming a table** moves its rows.
- **Limit:** rows stored as JSON (through the JSON commands) are matched by name, so a renamed column doesn't find their old field.

- **A primary key later:** `alter table t add primary key (col)`, or `(a, b)` (or a new column declared `primary key` on an empty table). Every row moves to its key in one step: the key must be unique and never null (23505, 23502), and its columns become `NOT NULL`.

## Keys of several columns

```sql
create table order_lines (ord int, line int, sku text, qty int, primary key (ord, line));
select * from order_lines where ord = 7 and line = 2;   -- one row, read by its key
select * from order_lines where ord = 7;                 -- the rows whose keys start with 7
create table shipments (id int primary key, ord int, line int,
                        foreign key (ord, line) references order_lines on delete cascade);
insert into order_lines values (7, 2, 'a', 5) on conflict (line, ord) do update set qty = excluded.qty;
```

- **Types:** each column integer, bigint, text, date, boolean, timestamp or timestamptz. The columns are `NOT NULL`.
- **Stored in order:** a row's key holds its key's values in a form that sorts as they do (numbers as numbers, text by its bytes, one column after another) and can't be mistaken for another row's. So a table's rows come out in key order, equality on all the key's columns reads one row, and equality on its first columns reads just the rows that start with them (`EXPLAIN` shows `Index Scan using order_lines_pkey`). Other conditions scan or use indexes as usual; joins on the key's columns hash-join.
- **Shown and typed as rows:** `DIFF`, `MERGE ... DRY RUN`, merge conflicts, error messages, the shell and the HTTP API show such a key as Postgres writes a row, `order_lines/(7,2)`, and take it that way: `get order_lines (7,2)` in the shell, `{"table": "order_lines", "id": "(7,2)"}` over HTTP, and `RESOLVE ('order_lines/(7,2)' = ours)`. JSON writes (`put order_lines (7,2) {...}`) fill the key's columns from the key.
- **`ON CONFLICT`** names the key's columns in any order, or `ON CONFLICT ON CONSTRAINT order_lines_pkey`.
- **Keys of one column** are stored as before (`users/42`), so databases made before read the same.
- **Not allowed:** dropping a key column (2BP01), or changing its type (0A000) other than between integer and bigint.

## Loading and unloading: COPY

```sql
copy orders from stdin (format csv, header);          -- then the rows, as Postgres clients send them
copy orders (id, total) from stdin;                   -- text format: tab-separated, \N for NULL
copy orders to stdout (format csv, header);
copy (select id, total from orders where total > 100) to stdout with csv;
```

```bash
psql postgres://127.0.0.1:5433/main -c "\copy orders from 'orders.csv' csv header"   # a file on your side
psql postgres://127.0.0.1:5433/main -c "\copy orders to 'orders.csv' csv header"
```

- **Over the Postgres protocol:** `COPY ... FROM STDIN` and `COPY ... TO STDOUT` use Postgres's copy messages, so psql's `\copy`, `pg_dump`-style scripts with the data inline, and drivers' copy support (psycopg's `cursor.copy`, the `postgres` crate's `copy_in` / `copy_out`, ...) work. Through the simple or the extended protocol.
- **Formats:** `text` (the default), `csv`, and (FROM only) `binary`, Postgres's binary format as bulk loaders send it, with every type binary parameters take, pgvector's vectors included (psycopg: `cur.copy("copy items from stdin (format binary)")`). Text and CSV take Postgres's options: `HEADER`, `DELIMITER`, `NULL`, `QUOTE`, `ESCAPE`, `FORCE_QUOTE (cols)` or `*`, `FORCE_NOT_NULL`, `FORCE_NULL` and `ENCODING 'UTF8'`, in the `WITH (...)` form or the older one psql writes (`csv header delimiter ';'`). Values are written as Postgres writes them (`t`/`f`, `\N`, quoting only where needed), so a table copied out and in again comes back byte for byte.
- **All or nothing:** a bad value, a missing or extra column, a duplicate key, or a client that cancels (CopyFail) or disconnects leaves nothing behind. Inside `BEGIN`, a failed COPY fails the transaction, as in Postgres. Errors name the line and column: `invalid input syntax for type integer: "x" (COPY t, line 45000, column v)`.
- **Fast, and one statement however big:** rows are parsed to their columns' types as they arrive and go in as one insert of values (no SQL to parse), a part at a time (16,384 rows or 32 MB) while the client is still sending. A COPY too big to hold goes on in parts, as any big `INSERT` does, so memory doesn't grow with it (see [operations](operations.md#databases-bigger-than-memory)). In process, 100,000 three-column rows load at about 280,000-390,000 rows a second, against about 170,000-200,000 for `INSERT`s of 1,000 rows each. Over the network with psql, psql itself sets the pace.
- **Checked on insert:** `NOT NULL`, `CHECK`, `UNIQUE`, foreign keys and indexes, and defaults for columns the COPY leaves out, exactly as `INSERT` does.
- **Triggers:** a COPY FROM fires `INSERT` triggers as an `INSERT` does: row triggers for each row, and statement triggers once for the whole COPY. A table with triggers takes the COPY in memory.
- **Refused:** files and programs on the server (`COPY t FROM '/path'`, `PROGRAM`): 42501. The client reads and writes its own files (`\copy`). Also `COPY ... TO` in binary and `COPY ... WHERE` (0A000). Over HTTP and in the shell, COPY needs a Postgres connection.
- **Loading a lot:** use COPY, or one `INSERT ... SELECT` or big multi-row `INSERT`. A statement bigger than half of `CHRONOS_WORK_MEM` skips the log: its rows are written once, into the table's tree, and parts in key order (ids as they come) go straight there. Many small transactions (`INSERT`s of 100 rows, 1,000 per `COMMIT`) write each row twice, to the log at commit and into the tree at the next checkpoint, as Postgres writes its WAL and then its tables. On 76,424 OpenAI embeddings: a binary COPY wrote 526 MB, the small-transaction load 1.27 GB.

## Enum types

```sql
create type mood as enum ('sad', 'ok', 'happy');
create table people (id int primary key, name text, feeling mood default 'ok');
select name from people where feeling > 'sad' order by feeling desc;
alter type mood add value 'meh' before 'ok';
alter type mood rename value 'sad' to 'down';
select enum_range(null::mood);   -- {down,meh,ok,happy}
drop type mood;                  -- once nothing uses it (or CASCADE)
```

- **As in Postgres:** a value must be one of the labels (22P02 otherwise), and enums compare, sort (`ORDER BY`), `min` and `max` in the order the labels were given, not as text. `'happy'::mood` casts and checks; `feeling::text` is the label.
- **Types are rows of the world:** a type made on a branch arrives with its merge, and forks share it. A table's schema keeps its enum's labels too.
- **Everywhere a column goes:** defaults, `ALTER TABLE ... ADD COLUMN` and `TYPE`, indexes (for `=`), `UNIQUE`, COPY and JSON writes (checked the same). Clients receive labels as text.
- **Changing a type:** `ALTER TYPE t ADD VALUE [IF NOT EXISTS] 'v' [BEFORE | AFTER 'w']`, `ALTER TYPE t RENAME VALUE 'a' TO 'b'` and `ALTER TYPE t RENAME TO u`, as in Postgres: existing rows keep their labels, in the new order, and a renamed label is renamed in every row, index and column default that holds it (Chronos keeps labels as text, so the rows holding it are rewritten, in the same write). A change on a branch arrives with its merge, and `AS OF` sees the type as it was. Renaming a type that a view's column has is refused (0A000): drop the view, rename, make it again.
- **`DROP TYPE ... CASCADE`** drops the columns of the type (as `ALTER TABLE ... DROP COLUMN`) and the functions taking or returning it, with Postgres's notices; without `CASCADE`, any of those stops it (2BP01).
- **Functions:** `enum_first(x)`, `enum_last(x)` and `enum_range(x [, y])` (a text array, `{sad,ok}`), taking the type from their argument (`null::mood`, a column). Enums can be a function's arguments and result, `RETURNS SETOF` / `TABLE` columns, and PL/pgSQL variables, checked (22P02) and compared by their labels' order.
- **Errors:** a type that exists (42710), a label given twice (23505) or added twice (42710), a label that isn't one (22023 in `ALTER TYPE`, 22P02 elsewhere), `DROP TYPE` of a type something uses (2BP01), an unknown type (42704).
- **Not yet:** enums in primary keys, and `CHECK` conditions or partial indexes that name a renamed label (they keep the old one). `DIFF` doesn't list types (the tables using one show its labels).

## Schemas

```sql
create schema app;
create table app.orders (id int primary key, customer int references public.customers);
set search_path to app, public;      -- now `orders` is app.orders, `customers` public.customers
select * from orders join customers c on c.id = orders.customer;
drop schema app cascade;             -- and everything in it
```

- **Names:** `schema.name` works for tables, views, materialized views, sequences, enum types, functions, triggers' tables and indexes, anywhere they're named (DDL, `INSERT`/`UPDATE`/`DELETE`, `FROM`, joins, `REFERENCES`, `COPY`, `nextval('app.s')`, `'app.t'::regclass`). A table in another schema is called by its own name in the query (`select t.id from app.t`), as in Postgres. Default constraint and index names don't carry the schema (`t_pkey`); an index is in its table's schema (`drop index app.t_v_idx`).
- **`search_path`:** `SET search_path TO a, public` (or `= 'a, public'`, `SET SCHEMA 'a'`), `RESET search_path` and `SHOW search_path`, per session. A name without a schema is the first of its kind along the path (a temporary table first); `CREATE` without a schema makes it in the path's first schema that exists (3F000 if none). `current_schema()` and `current_schemas(bool)` follow it. The default is `"$user", public`; `$user` schemas aren't looked for. In a script of several statements, each sees the path and objects the ones before it left, as in Postgres.
- **`CREATE SCHEMA [IF NOT EXISTS] name [AUTHORIZATION role]`** (42P06 if it exists; names starting `pg_` are 42939), and **`DROP SCHEMA [IF EXISTS] a, b [CASCADE | RESTRICT]`**: without `CASCADE`, a schema holding anything is 2BP01; with it, its views, tables (and foreign keys and views elsewhere that depend on them), sequences, functions and types go too, in one step. `public` can't be dropped.
- **World data:** a schema is a row of the world, like a table's schema, and objects in it are stored under their qualified name (`app.orders/7`); objects in `public` keep their plain names, so databases made before schemas read the same. Forks, `DIFF` (and `DIFF ... AS SQL`, as `create schema app;`), merges (the same schema made on both sides merges as one), `AS OF` and restarts all carry them.
- **psql:** `\dn` lists schemas, `\dt app.*` a schema's tables, `\dt` the ones the search_path shows, and `\d app.t` a table in one.
- **Differences from Postgres:** a view's names are looked up along the search_path of the session reading it (Postgres fixes them when the view is made); a prepared statement keeps the tables its names meant when it was prepared; schemas have no owners or privileges; `CREATE SCHEMA ... CREATE TABLE ...` (objects inside the statement) is 0A000.

## Temporary tables

```sql
create temp table picks (id int primary key, score float8);
insert into picks select id, random() from products where stock > 0;
select p.name from products p join picks using (id) order by score limit 10;
```

- **The session's own:** `CREATE TEMP` (or `TEMPORARY`) `TABLE` makes a table only this connection sees, in memory: it's never written to the log, never in a `DIFF`, never merged, and it's gone when the connection ends (or `DROP TABLE`). A temporary table hides a world's table of the same name, as in Postgres.
- **With everything else:** it can be read alongside the world's tables (joins, subqueries, `INSERT INTO world_table SELECT ... FROM temp_table`), and filled from them (`INSERT INTO temp_table SELECT ... FROM world_table`), with the usual constraints, defaults and indexes. `BEGIN ... ROLLBACK` takes back its changes too.
- **Not yet:** `ON COMMIT DROP` / `DELETE ROWS` (0A000; `PRESERVE ROWS` is what it does), savepoints (`ROLLBACK TO` leaves a temporary table's changes), subqueries on the world's tables inside an `UPDATE` or `DELETE` of a temporary table, foreign keys between temporary and other tables, and psql's `\d` for them.

## Prepared statements

```sql
prepare by_customer (int) as select * from orders where customer = $1 order by id;
execute by_customer(42);
deallocate by_customer;          -- or: deallocate all
```

- **As in Postgres:** parameter types given in parentheses or inferred from use, `EXECUTE name(values)` with the values converted to those types, and Postgres's errors (42P05 a name already used, 26000 no such statement, 42601 the wrong number of values). `SELECT`, `INSERT`, `UPDATE` and `DELETE` can be prepared.
- **One namespace with the protocol's:** a statement a driver prepares (Parse) and one `PREPARE` makes share names on a connection, so `EXECUTE` runs either and `DEALLOCATE` frees either, as in Postgres.
- **Per session:** they last until the connection ends (or, over HTTP, until the request ends).

## psql's commands

`\dt`, `\dv`, `\dm`, `\ds`, `\d`, `\d name` (tables with their triggers, views, materialized views and sequences), `\d+ view` (with its definition) and `\l` (which lists branches as databases) work in psql. Chronos recognises the catalog queries psql 16 sends and answers them from its own tables. Other queries on the catalog go to the SQL engine, which knows [these catalog tables](#the-catalog-information_schema-and-pg_catalog).

## Views

```sql
create view paid (id, who, total) as select id, customer, total from orders where status = 'paid';
create or replace view paid as select id, customer, total, placed from orders where status = 'paid';
select who, sum(total) from paid group by who;
update paid set total = total * 0.9 where who = 'ada';   -- writes orders, only its paid rows
drop view paid;                                          -- or: drop table orders cascade
```

- **Anywhere a table is read:** `FROM`, joins, subqueries, `INSERT ... SELECT`, other views. A view's query runs as part of the query that reads it.
- **In the world:** a view's definition is a row of the world, like a table's schema. A fork has its own views, `DIFF` shows them made, changed and dropped (`DIFF ... AS SQL` as `CREATE OR REPLACE VIEW`), a merge brings them, and they survive restarts.
- **AS OF:** `select * from v as of '-1 hour'` reads the view's definition as it was then, over its tables as they were then.
- **`CREATE OR REPLACE`:** as in Postgres, the new query keeps the old columns (names and types) first and may add more (42P16 otherwise).
- **Dependencies:** dropping a table or view another view reads fails with 2BP01 unless it's `DROP ... CASCADE`, which drops the views too (and, for a table, the foreign keys referencing it).
- **Writing through a view:** `INSERT`, `UPDATE` and `DELETE` work on views that select columns of one table (or of such a view), without `DISTINCT`, `GROUP BY`, aggregates, window functions, `LIMIT` or `UNION`, as Postgres's automatically updatable views: they write the table, `UPDATE` and `DELETE` only the rows the view shows, and `RETURNING` gives the view's columns. Other views are refused (55000), and so is writing a view column that's an expression (0A000). `WITH CHECK OPTION` isn't supported.
- **Tables, views, materialized views and sequences share names** (42P07).
- **Differences from Postgres:** a view is kept as its SQL and read by name each time, so `select *` in a view picks up columns added to its table later, renaming a table a view reads is refused (drop the view, rename, make it again), and a view reading a dropped or renamed column fails when it's read.

## Materialized views

```sql
create materialized view daily as select date_trunc('day', at) as day, sum(total) from orders group by 1;
refresh materialized view daily;
create materialized view later as select ... with no data;  -- reading it fails until a REFRESH
drop materialized view daily;
```

- **A table holding its query's rows,** made by `CREATE MATERIALIZED VIEW [IF NOT EXISTS] name [(columns)] AS query [WITH [NO] DATA]`. It reads like a table, takes indexes, and is written only by `REFRESH MATERIALIZED VIEW name [WITH [NO] DATA]` (42809 for `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER TABLE`).
- **Per world:** a REFRESH in a fork changes only the fork until it merges. Rows are kept by their place in the answer, so a REFRESH that finds the same rows changes nothing, and `DIFF` shows only the rows that did change (`DIFF ... AS SQL` as a `REFRESH`).
- `CONCURRENTLY` is accepted: a REFRESH never blocks readers anyway.

## Sequences

```sql
create sequence order_no start 1000 increment by 10;
select nextval('order_no'), currval('order_no'), lastval();
select setval('order_no', 5000);            -- or setval('order_no', 5000, false): 5000 comes next
alter sequence order_no restart with 1;     -- also INCREMENT, MINVALUE, MAXVALUE, CYCLE, ...
create table orders (id bigint primary key default nextval('order_no'), total numeric);
drop sequence order_no;
```

- **Options:** `AS smallint | integer | bigint`, `INCREMENT [BY]` (negative counts down), `MINVALUE` / `NO MINVALUE`, `MAXVALUE` / `NO MAXVALUE`, `START [WITH]`, `[NO] CYCLE`, and `ALTER SEQUENCE ... RESTART [WITH n]`, checked as Postgres checks them. `CACHE` and `OWNED BY` are accepted and change nothing. Past the end without `CYCLE`, `nextval` fails with 2200H.
- **Across worlds:** the definition is a row of the world, like a table's schema (a fork, `DIFF`, a merge and AS OF see it), but its counter belongs to the database, shared by every world holding that sequence, as `serial` columns' are, and isn't rolled back: rows numbered in two forks never collide when they merge. `nextval` in a world writes no world's rows (main's version doesn't move). A sequence created separately in two worlds under one name has two counters, and merging both definitions is a conflict. `setval` and `RESTART` move the shared counter for every world (from any world, without writing main), and `TRUNCATE ... RESTART IDENTITY` restarts its tables' `serial` counters for every world too. Restoring or reading the past doesn't move a counter back.
- **In a session:** `currval` and `lastval` are this session's last values (55000 before any), as in Postgres; a `DEFAULT nextval(...)` sets them too.
- **Differences from Postgres:** `setval` works in `SELECT` (not inside `INSERT`, `UPDATE` or `DELETE`); a write taking many values at once may skip some (it reserves more when it runs out). `serial` columns don't show as sequences in `\ds`.

## LISTEN and NOTIFY

```sql
listen jobs;                               -- this connection hears the channel
notify jobs, 'order 42 paid';              -- or: select pg_notify('jobs', 'order 42 paid')
unlisten jobs;                             -- or: unlisten *
```

- **When:** at `COMMIT` (or at once outside a transaction); a `ROLLBACK`, a failed statement or a `ROLLBACK TO SAVEPOINT` drops the notifications it made. The same channel and payload twice in one transaction arrive once. Payloads are shorter than 8000 bytes (22023).
- **Who hears it:** connections that LISTEN on the channel in the same world, the sender included; each gets Postgres's NotificationResponse with the sender's backend id. An idle connection gets it at once, without sending a query (psql shows it at its next command); a connection inside a transaction gets it when the transaction ends.
- **Worlds:** a world's notifications reach its own listeners only: a NOTIFY in a fork doesn't reach main, and a merge sends nothing (notifications are messages at commit time, not rows). A LISTEN is for the world the connection is in when it runs, and stays with that world if the connection switches.
- **Differences from Postgres:** a LISTEN inside a transaction takes effect at once, not at COMMIT.

## TRUNCATE

`TRUNCATE [TABLE] a, b [RESTART IDENTITY | CONTINUE IDENTITY] [CASCADE | RESTRICT]` deletes every row of the tables in one write. A table other tables' foreign keys reference must be truncated with them, or with `CASCADE` (which truncates them too); else 0A000. `RESTART IDENTITY` restarts the tables' `serial` counters, which every world shares.

## The catalog (information_schema and pg_catalog)

Tools and ORMs introspect a database by querying its catalog. These tables answer from the world's schemas, tables, views, sequences, constraints and indexes, and join, filter and sort like any table:

- `information_schema.schemata`, `.tables`, `.columns`, `.views`, `.sequences`, `.table_constraints`, `.key_column_usage`, `.referential_constraints`, `.constraint_column_usage` and `.check_constraints`.
- `pg_catalog.pg_namespace`, `pg_class` (indexes too), `pg_attribute`, `pg_type`, `pg_attrdef`, `pg_index`, `pg_constraint`, `pg_indexes`, `pg_am`, `pg_opclass` (empty), `pg_description` (empty), `pg_sequence`, `pg_tables`, `pg_views`, `pg_matviews` and `pg_sequences` (with or without `pg_catalog.`; columns named as in Postgres, the ones introspection reads).
- **Constraints and indexes** come from the real ones: primary keys (of one or several columns), `UNIQUE` constraints, foreign keys (several columns too, with `confkey`, `confrelid` and `confdeltype`), `CHECK`s, and indexes (`CREATE [UNIQUE] INDEX`, on expressions, partial, gin, hnsw). `pg_constraint.conindid` is the index behind a key (a foreign key's: its parent's primary key), `pg_index.indkey` counts from 0 as Postgres's int2vector does, and `pg_get_constraintdef(oid[, pretty])` and `pg_get_indexdef(oid[, column, pretty])` write them as Postgres does (`CHECK ((qty > 0))`, `FOREIGN KEY (org) REFERENCES orgs(id) ON DELETE CASCADE`, `CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)`).
- **`regclass`:** `'orders'::regclass` (or `'app.orders'`, or an oid) is the relation, shown by name (schema-qualified when the search_path doesn't show it); `::regclass::oid` is its `pg_class.oid`, `oid = 'orders'::regclass` compares oids, and `to_regclass('x')` is null for a relation that doesn't exist (the cast is 42P01).
- Functions: `current_schema()`, `current_schemas(bool)`, `current_database()`, `pg_table_is_visible(oid)` (along the search_path), `format_type(type oid, typmod)`, `pg_get_expr(expr, relid)`, `pg_get_userbyid`, `obj_description` and `col_description` (null), `pg_catalog.`-qualified or not.
- **Array helpers the introspection queries use:** `unnest(a)` and `generate_subscripts(a, 1)` in the select list (a row per element, side by side, as Postgres runs them; not with `GROUP BY`), `array_length`, `cardinality`, `array_lower`, `array_upper`, and bitwise `&` and `|` on integers.
- Oids: a relation's is 16384 plus its place in name order, then come the indexes', the constraints' and the schemas' (`public` is 2200); types have Postgres's oids.
- An enum column's `data_type` is `USER-DEFINED` and its `udt_schema` and `udt_name` the enum's, as in Postgres. A primary key of several columns makes each of its columns `NOT NULL` here. Temporary tables aren't listed.
- **Checked against Postgres 17** (tests/pgdiff.rs, tests/schemas.rs): listing schemas, tables, views and sequences; columns with their types, nullability and defaults; constraints and indexes through each table and view above; and the reflection queries SQLAlchemy 2.0 sends (tables, primary keys, unique constraints, foreign keys, checks, indexes with expressions and `WHERE`, columns) and Prisma's schema describer (namespaces, tables, constraints, columns, foreign keys, indexes, sequences, views), written into the tests. The ORMs themselves weren't run against it.
- **Not yet:** `NOT NULL` constraints as rows of `table_constraints` (Postgres 17 lists them), operator classes in `pg_opclass`, `pg_enum`, `pg_proc` and the other catalog tables, and `pg_relation_size`.
## Storage

Tables made with `CREATE TABLE` store rows packed: each column's value in schema order, length-prefixed, with no names to match and no numbers to parse, about half the size of JSON. Everything outside SQL still sees JSON objects: `get`, `scan`, `find`, `diff`, merge conflicts, the HTTP API, the shell and the search index. Rows written as JSON through those (`put`) are read by SQL too. Tables made by writing JSON rows stay JSON.

## Subqueries, UNION and WITH

```sql
select name from customers c
where exists (select 1 from orders o where o.customer = c.id and o.total > 50);

select c.name, (select count(*) from orders o where o.customer = c.id) from customers c;

with paid as (select * from orders where status = 'paid')
select customer, sum(total) from paid group by customer
union all
select null, sum(total) from paid;
```

- **Subqueries:** as a value (`(select max(x) from t)`), in `IN (select ...)`, and in `EXISTS`, anywhere an expression goes, including `UPDATE` and `DELETE`.
  - **Correlated subqueries** (ones that read the outer row) run once per distinct set of outer values they read.
  - **Parameters inside them** get their types from the subquery's own tables.
- **Set operations:** `UNION`, `INTERSECT` and `EXCEPT`, each with or without `ALL`, parts in parentheses allowed. `ORDER BY` / `LIMIT` apply to the whole and name output columns. Result types widen as in Postgres (`1` and `2.5` give double precision).
- **Subqueries in FROM:** `(select ...) as t` or `as t(a, b)`, joined, filtered and grouped like tables.
- **`WITH`:** `WITH name [(columns)] AS (select ...)` names queries for the main query, later `WITH` queries, and subqueries. A statement runs each once, however many times it's used, and every use reads the same rows (as Postgres does for a query used more than once: `nextval()` or `random()` in it gives one value to all its uses). A subquery run for each outer row, correlated or `LATERAL`, runs its own `WITH` queries each time.
- **`WITH RECURSIVE`:** `name AS (base UNION [ALL] step)`, for trees and graphs. The step reads the rows the last round added, and rounds stop when a round adds nothing new. `UNION` drops rows already seen, which ends cycles. A query that never stops is refused after 10,000 rounds or 1,000,000 rows. Each round joins from the rows the last round added, looking the next ones up by index (with an index on the edge column, a small traversal of a 200,000-edge graph takes about 1 ms).
- **`ANY`, `SOME` and `ALL`:** `x op ANY (select ...)`, `ALL (...)` with any comparison, over a subquery, `ARRAY[1, 2]`, a Postgres array literal `'{1,2}'`, or a JSON array. `= ANY` and `<> ALL` are `IN` and `NOT IN` and share their index lookups. NULLs make the answer unknown, as in Postgres, and over nothing `ANY` is false and `ALL` true.
  - **From drivers:** `where id = any($1)` takes a list however the driver sends it: a typed array, text or binary (`int8[]`, `text[]`: psycopg 3, asyncpg, pgx, Rust's `postgres`), array text (`'{1,2,3}'`, node-postgres), or JSON (over HTTP). Chronos tells drivers that `$1` is an array of the column's type.
- **`WITH` before `INSERT`, `UPDATE` and `DELETE`:** the names reach the statement's query and its subqueries.
- **`UPDATE ... FROM` and `DELETE ... USING`:** other tables to match against, as in Postgres. With several matching rows, `UPDATE` takes the first one's values.
- **Set-returning functions in FROM:** `generate_series(from, to[, step])` (numbers, or timestamps and dates with an interval step), `unnest(array)`, `jsonb_array_elements(_text)`, `jsonb_each(_text)` and `jsonb_object_keys`. They can read the tables before them, as `LATERAL` (`from orders o, jsonb_array_elements(o.items) item`), and a one-column function's name is its column (`select g from generate_series(1, 5) g`).
- **Arrays** are kept as Postgres array text, in values and in array columns: `ARRAY[1, 2]`, `'{a,b}'::text[]`, `array_agg`, for `ANY` and `unnest` (see Arrays above).
- **`LATERAL`:** `from customers c, lateral (select ... where o.customer = c.id order by at desc limit 3) recent`, or `[LEFT] JOIN LATERAL (...) x ON ...`. The subquery reads the tables before it and runs once for each distinct set of values it reads from them.

## Window functions

```sql
select name, dept, pay,
       rank() over (partition by dept order by pay desc),
       sum(pay) over (partition by dept order by hired),                       -- running total
       avg(pay) over (order by hired rows between 6 preceding and current row) -- moving average
from staff;
```

- **Functions:**
  - `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`.
  - `lag` and `lead` (with offset and default), `first_value`, `last_value`, `nth_value`.
  - `count`, `sum`, `avg`, `min`, `max`, with `OVER (PARTITION BY ... ORDER BY ...)`.
- **Frames:**
  - **Default, as in Postgres:** with `ORDER BY`, from the partition's start to the current row's last tie; without it, the whole partition.
  - **Explicit:** `ROWS BETWEEN n PRECEDING / UNBOUNDED ... AND CURRENT ROW / n FOLLOWING / UNBOUNDED`, and `RANGE` with `UNBOUNDED`, `CURRENT ROW` or an offset in the one `ORDER BY` column's units (`RANGE BETWEEN 5 PRECEDING AND CURRENT ROW`, `interval '7 days' PRECEDING` on dates and timestamps).
- **With `GROUP BY`:** windows run over the groups, e.g. `rank() over (order by sum(x))` or `sum(sum(x)) over ()`.
- **Where they can go:** only in the select list and `ORDER BY` (42P20 elsewhere).
- **Named windows:** `WINDOW w AS (partition by ... order by ...)`, then `OVER w`, or `OVER (w ORDER BY ...)` to add an order, as in Postgres.
- **`FILTER (WHERE ...)`** works on window aggregates too.
- **Not yet:** `DISTINCT` inside a window aggregate, `GROUPS` frames and `EXCLUDE`.

## Branches in SQL

```sql
create branch agent_7;                 -- instant copy of the current branch (or: from main)
use branch agent_7;                    -- this connection now works on it
update people set age = 37 where id = 1;
diff;                                  -- table, id, change, before, after (jsonb)
merge branch agent_7;                  -- into its parent; you move back to the parent
show branches;                         -- name, parent, changes
drop branch agent_7;                   -- throw it away
```

- **Connecting to a branch:** it's a database, so `psql postgres://127.0.0.1:5433/agent_7` works.
- **Branch names with dashes** need quotes: `create branch "agent-7"`.
- **Merge conflicts:** if both sides changed a row, `MERGE BRANCH` fails with SQLSTATE 40001, lists the rows and merges nothing. Check `DIFF`, then choose:
  - `MERGE BRANCH agent_7 USING OURS` keeps the branch's rows.
  - `USING THEIRS` keeps the parent's rows.
- **After a crash:** a branch that was open needs `MERGE BRANCH agent_7 CONFIRM`, once you've checked its `DIFF`.

### Worlds

The same statements with `WORLD`, plus metadata and IDs (see [concepts](concepts.md#worlds)):

```sql
create world agent_7 with (owner = 'claude', task = 42);   -- from the current world (or: from main)
fork world agent_7 as agent_7b meta '{"tags": ["retry"]}'; -- from a named world
switch world agent_7b;                                     -- or: use world '<its id>'
alter world agent_7 set (task = null, reviewer = 'ada');   -- null removes a key
alter world agent_7 set ttl '2 hours';  -- discarded 2 hours from now (unless it has forks then)
alter world agent_7 reset ttl;          -- never expires (agents need admin for either)
alter world agent_7 set pinned;         -- never discarded for being idle (see world_idle_ttl); reset pinned undoes it
show worlds;                  -- name, id, parent, depth, created, version, meta (jsonb), owner, expires, active, pinned
show storage;                 -- per world: rows changed since its fork, and the pages and bytes only it holds
show storage for world agent_7;
show disk;                    -- bytes of pages in use, kept only for history, reclaimable; and the log's
diff world agent_7b;          -- table, id, change, before, after, columns (what changed)
diff world agent_7b as sql;   -- the same as statements: run them on main to make the change
diff world agent_7b readers;  -- what reads each changed column (views, checks, keys, clients seen reading...), and what that can't see
register reader nightly_export on orders (status, total);   -- a reader outside SQL, named by hand
show readers;                 -- registered readers, and the clients seen reading which columns
diff world a to b;            -- between any two worlds, or moments (a@-1 hour)
merge world agent_7b dry run;  -- what the merge would do, row by row, and why rows conflict
merge world agent_7b by columns resolve ('orders/7' = theirs, 'orders/9' = '{"id": 9, "status": "paid"}');
merge world agent_7b only tables (orders);           -- just these; agent_7b stays open with the rest
merge world agent_7b only keys ('orders/7', 'orders/9');
merge world agent_7b into agent_7;  -- into another world, three-way against agent_7b's fork point; it stays open
merge world agent_7b;
drop world agent_7;           -- or: delete world agent_7; refused while it has forks
drop world agent_7 cascade;   -- it and every world forked from it, deepest first
```

- **Partial merges:** rows merged with `ONLY` aren't merged again, but a later change to one by either side conflicts. A row whose unique value or reference is tied to a row left out, or whose table the world changed, is refused (SQLSTATE 22023). See [concepts](concepts.md#merging-part-of-a-world-or-into-another-world).
- **`INTO`:** any live world but the one merged. Into its own parent, it's the ordinary merge.
- **Merge checks:** queries a merge's result must find nothing in, run inside every merge (SQLSTATE 23514 when one finds rows, with the rows). See [merge checks](reference/worlds.md#merge-checks) and the [guide](guides/merge-checks.md).

```sql
create merge check lists_keep_leads on tables (leads, lists) with (timeout = '2s') as
  select id from lists where id not in (select list from leads);
show merge checks;            -- name, tables, timeout_ms, query, created
drop merge check lists_keep_leads;
```

## Time travel

Any table can be read as it was at a moment in the retention window (30 days unless you change it):

```sql
select * from orders as of '2026-09-20 10:00';            -- UTC unless the time says otherwise
select * from orders for system_time as of $1;            -- the SQL:2011 spelling, with a parameter
select * from orders as of '-15 minutes';                 -- a time ago

-- now against then, in one query
select now.id, now.status, old.status
from orders now join orders as of '-1 hour' old on old.id = now.id
where old.status <> now.status;

insert into orders select * from orders as of '-1 hour' where id = 42;  -- bring a row back
restore world main to '-1 hour';        -- put a whole world back (an ordinary write: history keeps what it replaced)
fork world 'main@-1 hour' as check_it;  -- a world holding main as it was: diff it, or merge it to restore
diff world 'main@-1 hour' to main;      -- what changed since
undo merge of world agent_7;           -- put back every row its latest merge changed
undo merge of world agent_7 skip changed;  -- ...except rows changed again since (else they're named)
undo agent bot since '-2 hours';        -- put back every row agent bot changed in this world since then
undo agent bot since '-2 hours' skip changed;  -- ...except rows someone changed after it (else they're named)
show history limit 20;                  -- at, world, event (write, commit, forked ..., merged ...), rows
alter system set history_retention = '7 days';  -- or '0' to keep none (the default is 30 days)
show history_retention;
alter system set synchronous_commit = normal;  -- full (default), normal or off
show synchronous_commit;
```

- **A table AS OF** comes with its schema as it was then, and tables dropped since can still be read.
- **A whole session in the past:** `use world 'main@2026-09-20 10:00'`, or connect to the database `main@2026-09-20 10:00` with psql. It's read only (SQLSTATE 25006 on writes).
- **Times:** a fixed time is rebuilt from history once, then cached; a time ago (`-15 minutes`) is a new moment each time it's run. See [concepts](concepts.md#time-travel).

## Simulations

```sql
simulate 1000 worlds from main as trial
  run $$update prices set p = p * (0.9 + random() * 0.2) where sku % 100 = $1 % 100$$
  score $$select sum(p * sold) from prices$$
  keep 10 seed 42;                         -- world, id, index, seed, score, error, kept: best first
replay world trial_17;                     -- world, replay, identical, rows_differing, score, recorded_score, error
replay world trial_17 as trial_17_again;   -- ...and keep the replay
select setseed(0.42); select random();     -- a repeatable random() for this session
```

- **What it does:** forks n worlds (`trial_0`, `trial_1`, ...) from one moment of the base, runs the script in each on every core, then the score query in each, keeps the best `KEEP k` and discards the rest.
  - **Base:** `FROM world`, or the session's world; `FROM 'main@-1 hour'` starts from the past.
  - **Best:** the highest score first; `ASC` for the lowest. `KEEP ALL`, the default, keeps every world.
  - **Parameters:** in the script and the score query, `$1` is the world's index and `$2` its seed.
  - **Strings:** the script and score can be dollar-quoted, `$$...$$` or `$tag$...$tag$`, as in Postgres.
- **Failures:** a world whose script or score fails is reported with its error and SQLSTATE, and the rest carry on. It's discarded, unless `KEEP ALL`. The score query must be one SELECT whose first value is a number.
- **The same every time:** in each world, `random()`, `gen_random_uuid()` and the keys of tables without one follow `SEED` (0 unless given) and the world's index, and `now()` (with `current_timestamp`, `current_date`, ...) is the base moment. So the same statement from the same moment gives the same worlds and scores on any machine, with any number of threads (`THREADS n`; every free core by default).
  - A seeded statement runs on one core; the worlds run side by side.
  - Not covered: `serial` numbers, which come from the database's counters that every world shares (so merged worlds never collide), and so differ between runs. Use `$1` or `gen_random_uuid()` for keys.
- **What a script can't do:** fork, merge, restore, switch or drop worlds, or change settings (0A000). Transactions are fine.
- **Replay:** each kept world holds its inputs in its metadata, `sim`: the seed, index, script, score query, score, and the base world and exact moment.
  - `REPLAY WORLD w` forks the base as it was then (time travel), runs the script and score again, and says whether the rows and the score are identical.
  - The replay is thrown away, unless `AS name` keeps it.
  - It needs history back to that moment: not an in-memory database, nor past the retention window.
- **Agents:** the worlds are the agent's own and count toward its `max_worlds`. They run in batches that fit, keeping the best so far; a `KEEP` that can't fit is refused before anything runs (42501). Each world's statements are checked as the agent's, and its row quota applies in each world.
- **Size:** worlds are forked 1,024 at a time, and the losers go after each batch, so about `KEEP` + 1,024 worlds are alive at once. 10,000 worlds that each insert a row take 0.4 s; 10,000 that each update 1,000 rows take about 30 s (8-core laptop busy with other work, release build).
- **`setseed(x)`** (x from -1 to 1) seeds the session's `random()` and `gen_random_uuid()`, as in Postgres, until the session ends or it's called again.

## Metrics

`SHOW METRICS` lists each kind of operation since the database opened, with its count and latency in milliseconds (`total_ms`, `p50_ms`, `p95_ms`, `p99_ms`, `max_ms`), then counters (`rows_written`, `errors`, `conflicts`, `worlds`, bytes on disk) with only a count. See docs/operations.md.


## Backups

```sql
backup database to '/backups/db-1';   -- files, bytes: a copy of the running database in a new folder
verify database;                      -- pages, bytes, log_records: every page and log record read and checked
```

See docs/operations.md for restoring (`chronos restore`).
## Agents

```sql
create agent bot with (can = 'read,fork,write_own', max_worlds = 10, world_ttl = '1 day');  -- returns its token, once
alter agent bot set (writes_per_minute = 600, disabled = false);
alter agent bot set (max_query_ms = 30000, max_concurrent = 4, max_memory_mb = 512);
show agents;                              -- name, id, can, quotas, world_ttl, created, disabled, limits
show audit for agent bot limit 20;        -- at, agent, world, action, rows
checkpoint world bot_task as 'before';    -- name a moment of a world...
restore world bot_task to checkpoint 'before';  -- ...and go back to it
drop agent bot;                           -- its token stops working; its worlds stay
```

See [concepts](concepts.md#agents) for what agents may do. The names `guest` and `system` are the database's own.

## Limits for the whole database

```sql
alter system set statement_timeout = '30s';   -- every session starts with it (0: none, the default)
alter system set max_worlds = 10000;          -- live worlds besides main (0: no limit, the default)
alter system set world_idle_ttl = '7 days';   -- unused worlds are discarded (0: never, the default)
show max_worlds;
show world_idle_ttl;
```

They're kept in the folder across restarts, as `synchronous_commit` is. Past `max_worlds`, a fork is refused with SQLSTATE 53400. See [operations](operations.md#limits-and-cleanup).

## Transactions

`BEGIN`, then statements, then `COMMIT` or `ROLLBACK`. Drivers' transaction APIs work as they do with Postgres.

- **How it works:** a transaction is a hidden branch.
- **Snapshot:** it reads the database as it was at `BEGIN`, plus its own writes.
- **Invisible until COMMIT:** nobody else sees its writes before `COMMIT`.
- **COMMIT is durable,** like a merge.
- **Conflicts:** if another transaction committed a change to a row this one also wrote, `COMMIT` fails with SQLSTATE 40001 (`could not serialize access`) and rolls back. Retry the transaction, as you would for a Postgres serialization failure. Rows that were only read aren't checked, as with Postgres's `REPEATABLE READ`.
- **Savepoints:** `SAVEPOINT name`, `RELEASE [SAVEPOINT] name` and `ROLLBACK TO [SAVEPOINT] name`, nested as deep as you like. Each is a fork of the level before it: `RELEASE` merges it back, and `ROLLBACK TO` throws its changes away and keeps the savepoint open. `COMMIT` releases any still open.
- **After an error:** only `ROLLBACK`, `ROLLBACK TO SAVEPOINT` (which makes the transaction usable again) or `COMMIT` (which rolls back) is accepted, as in Postgres.
- **Not allowed inside a transaction:** branch statements.
- **Ending without COMMIT:** a transaction still open when its connection or HTTP request ends is rolled back.

## Stopping a statement

- **`SET statement_timeout = 5000`** (ms, or a string like `'5s'`, `'500ms'`, `'1min'`) stops any statement of this session that runs longer, with SQLSTATE 57014, as Postgres does. `0` turns it off; `RESET statement_timeout` (or `DEFAULT`) goes back to the database's (`ALTER SYSTEM SET statement_timeout`, none unless set); `SHOW statement_timeout` shows it.
- **An agent's `max_query_ms`** caps its sessions' timeout: it may set a lower one, never a higher one or none.
- **An agent's `max_memory_mb`:** a statement holding more rows than that is stopped with SQLSTATE 53200 (out of memory), and its sorts, groups and joins spill to disk at a quarter of it.
- **An agent's `max_concurrent`:** a statement past that many of its statements running at once is refused with SQLSTATE 53300.
- **Cancel requests** (psql's Ctrl-C, a driver's cancel) stop the statement running on that connection, also with 57014.
- **A client that disconnects** stops its running statement too: nobody is waiting for the answer.
- **How soon:** statements check every few thousand rows, so they stop within milliseconds of the limit.

## CHECK constraints

`CHECK (condition)` on a column or the table, with Postgres's default names (`items_price_check`, `items_check`, `items_check1`) or your own (`CONSTRAINT name CHECK (...)`).

- **When they're checked:** every insert and update, SQL or JSON, and every merge. A merge that brings in a `CHECK` added on a branch tests every row of the table, so rows the other side added meanwhile must pass too.
- **Null passes:** a condition that comes out null (`price >= 0` with a null price) doesn't stop the row, as in SQL.
- **Changing them:** `ALTER TABLE ... ADD CONSTRAINT ... CHECK` tests existing rows first; `DROP CONSTRAINT` removes one. Renaming a column renames it inside its checks; dropping a column drops the checks that use it.
- **Not allowed:** subqueries in a check (0A000), as in Postgres.

## Functions and triggers

```sql
create function add1(int) returns int language sql as 'select $1 + 1';
create function mul(a int, b int) returns int language sql immutable return a * b;
create function recent(n int) returns setof orders language sql as $$
  select * from orders order by at desc limit n
$$;
select add1(41), mul(6, 7);
select * from recent(5);

create function log_change() returns trigger language plpgsql as $$
begin
  insert into audit (op, tbl, row_id) values (tg_op, tg_table_name, coalesce(new.id, old.id));
  return null;                     -- an AFTER trigger's result is ignored
end $$;
create trigger orders_audit after insert or update or delete on orders
  for each row execute function log_change();
```

- **Functions:** `CREATE [OR REPLACE] FUNCTION name([name] type, ...) RETURNS type | SETOF type | SETOF table | TABLE (name type, ...) | trigger | void` (types include enums), `LANGUAGE sql` or `plpgsql`, `IMMUTABLE` / `STABLE` / `VOLATILE`, `STRICT` (also `RETURNS NULL ON NULL INPUT`, `CALLED ON NULL INPUT`), and the body `AS $$ ... $$` (or `'...'`), `RETURN expression` or `BEGIN ATOMIC ...; END`. `SECURITY`, `PARALLEL`, `LEAKPROOF`, `COST` and `ROWS` are accepted and change nothing.
  - **Calling:** a function returning a value goes in any expression; one returning rows goes in `FROM` (`select * from recent(5) r`), where it can read the tables before it, as `LATERAL`. `public.name(...)` works too.
  - **Parameters:** `$1`, `$2`, ... or their names. In a `LANGUAGE sql` body a column of the same name wins, as in Postgres.
  - **Overloading:** several functions may share a name with different argument types. A call picks the one whose types fit best (exact types, then numbers widening, then `text` for a quoted literal or NULL), as Postgres does in the common cases; one it can't choose is 42725. `DROP FUNCTION [IF EXISTS] name [(types)], ... [CASCADE]` (`CASCADE` drops the triggers that call it; without it they stop the drop, 2BP01).
  - **SQL bodies:** `SELECT`, `INSERT`, `UPDATE` and `DELETE` statements; the last one's first row (first column) is the result, or all its rows for a set. A body that's one `SELECT expression` is folded into the calling query, as Postgres inlines it.
  - **Writes:** a `VOLATILE` function (the default) may write; a `STABLE` or `IMMUTABLE` one that tries gets 0A000. What a function writes commits with the statement that called it, or not at all.
  - **Depth:** functions and triggers calling one another more than 40 deep stop with 54001 (endless recursion, or near the end of a server thread's stack).
- **Triggers:** `CREATE [OR REPLACE] TRIGGER name BEFORE | AFTER INSERT | UPDATE [OF col, ...] | DELETE [OR ...] ON table [FOR EACH ROW | STATEMENT] [WHEN (condition)] EXECUTE FUNCTION f(['arg', ...])` (`PROCEDURE` too), `DROP TRIGGER [IF EXISTS] name ON table`, and `ALTER TABLE t ENABLE | DISABLE TRIGGER name | ALL | USER`. As in Postgres, the default is `FOR EACH STATEMENT`, triggers of one kind fire in name order, and `WHEN` reads `NEW.col` and `OLD.col`.
  - **BEFORE ROW** triggers can change `NEW` (the row then written, and what `RETURNING` shows), or skip the row by returning NULL; `NOT NULL`, `CHECK`, unique and foreign keys are checked after them.
  - **AFTER ROW** triggers fire once the statement's rows are written and checked, one row after another, and see the final rows. Statement triggers fire before and after them.
  - **Errors:** `RAISE EXCEPTION` (or any error) in a trigger stops the statement: nothing it or its triggers wrote is kept, and in a transaction the transaction fails, as in Postgres.
  - **Where they fire:** SQL's `INSERT`, `UPDATE` and `DELETE`, on the world the statement runs on. They don't fire when a merge brings rows in (those rows are what the triggers already did on the branch; firing again would do it twice), or when a restart replays the log (it holds the rows triggers wrote). JSON writes to a table with triggers are refused (see [JSON writes into SQL tables](#json-writes-into-sql-tables)).
  - **Not yet:** `INSTEAD OF`, `TRUNCATE`, `REFERENCING` (transition tables) and constraint triggers; `INSERT ... ON CONFLICT DO UPDATE` on a table with row triggers, and `ON DELETE CASCADE` / `SET NULL` into one (each refused with 0A000 rather than skipping its triggers).
- **In worlds:** a function is a row (`_sonos_functions`), and a table's triggers are part of its schema, so both fork, merge, travel in time (`use world 'main@...'` calls the function as it was) and show in `DIFF` (`create function`, `+trigger name`) and `DIFF ... AS SQL`. Running `DIFF ... AS SQL`'s statements fires the triggers where they run.
- **Speed:** a call of a PL/pgSQL function costs about 1 µs; a row trigger that writes a row adds about 20 µs to each row written (an audit trigger on a 20,000-row `INSERT`: 0.4 s).

### PL/pgSQL

What Chronos runs, parsed when the function is made; anything else is refused then with 0A000 naming it, never guessed at when the function runs.

- **Blocks:** `[DECLARE ...] BEGIN ... END`, nested blocks. Declarations `name [CONSTANT] type [NOT NULL] [:= | = | DEFAULT expression]` and `name RECORD`; an inner block's variable hides an outer one of the same name.
- **Statements:** `name := expression` (also `=`, and `rec.field :=`, `NEW.col :=`), `IF ... THEN ... ELSIF | ELSEIF ... ELSE ... END IF`, `CASE [x] WHEN ... THEN ... ELSE ... END CASE` (no match and no `ELSE`: 20000), `LOOP`, `WHILE cond LOOP`, `FOR i IN [REVERSE] a..b [BY n] LOOP`, `FOR rec | a, b IN SELECT ... LOOP`, `EXIT [WHEN cond]`, `CONTINUE [WHEN cond]`, `RETURN [expression]`, `RETURN NEXT [expression]`, `RETURN QUERY SELECT ...`, `PERFORM ...`, `NULL`, `ASSERT cond [, message]`, `GET [CURRENT] DIAGNOSTICS v = ROW_COUNT [, ...]`.
- **Catching errors:** `BEGIN ... EXCEPTION WHEN condition [OR condition ...] THEN ... [WHEN ...] END`, as in Postgres. A condition is a name (`division_by_zero`, `unique_violation`, `check_violation`, `no_data_found`, ... Postgres's names for the errors Chronos raises, and their classes such as `data_exception` and `integrity_constraint_violation`, which catch every code of the class), `SQLSTATE 'xxxxx'` (a code, or a class's `xx000`), or `OTHERS`. An unknown name is 42704 when the function is made.
  - **The block's writes go back:** when a handler catches an error, what the block's statements wrote (its functions and triggers included) is taken back, as Postgres's implicit savepoint does; what the handler then writes stays, and commits with the statement. Variables keep the values the block gave them. An error no handler catches goes on out, as before. The block's declarations are outside its handlers, as in Postgres.
  - **In the handler:** `SQLSTATE` and `SQLERRM` hold the error's code and message; `GET STACKED DIAGNOSTICS v = RETURNED_SQLSTATE | MESSAGE_TEXT | PG_EXCEPTION_DETAIL | PG_EXCEPTION_HINT | PG_EXCEPTION_CONTEXT [, ...]` reads them (detail and hint from `RAISE ... USING`; `PG_EXCEPTION_CONTEXT` names the function, without Postgres's line and statement; `COLUMN_NAME`, `CONSTRAINT_NAME`, `TABLE_NAME` and the like are empty); `RAISE;` raises the error again. Outside a handler, both are 0Z002.
  - **Timeouts and cancels stay fatal:** `OTHERS` doesn't catch a statement timeout or cancel (57014) or a failed `ASSERT` (P0004), as in Postgres. Naming `query_canceled` catches one, but the statement is stopped again at its next check, within milliseconds, so a loop in the handler can't outlive the timeout.
  - **Cost:** a block with handlers costs nothing extra until an error is caught (the savepoint is where the statement's writes stand, and a copy of the branch that costs O(1)).
- **Dynamic SQL:** `EXECUTE string [INTO [STRICT] targets] [USING expression, ...]` runs a `SELECT`, `INSERT`, `UPDATE` or `DELETE` made at run time, with `$1`, `$2`, ... the `USING` values (build names with `format('%I', ...)` or `quote_ident`); `FOR target IN EXECUTE string [USING ...] LOOP` and `RETURN QUERY EXECUTE string [USING ...]` too. As in Postgres, `EXECUTE` sets `ROW_COUNT` and leaves `FOUND` alone, a null string is 22004, and without `STRICT`, `INTO` takes the first row. Other statements (DDL) in `EXECUTE` are refused with 0A000.
- **SQL:** `SELECT`, `INSERT`, `UPDATE` and `DELETE` (and `WITH`), with `INTO [STRICT] targets` (variables, a record, or `rec.field`s) after a `SELECT`'s list or a `RETURNING`. Without `STRICT`, no row sets the targets to NULL; with it, no row is P0002 and several P0003 (several rows from `INSERT/UPDATE/DELETE ... RETURNING ... INTO` too). A `SELECT` without `INTO` is 42601, as in Postgres: use `PERFORM`.
- **Variables in SQL:** statements and expressions read the variables; a name that is both a variable and a column of the statement's tables is 42702, as Postgres's default `plpgsql.variable_conflict = error` makes it.
- **`FOUND`** after `SELECT INTO`, `PERFORM`, `INSERT`/`UPDATE`/`DELETE`, `FOR` loops and `RETURN QUERY`.
- **`RAISE [DEBUG | LOG | INFO | NOTICE | WARNING | EXCEPTION] 'format %', args [USING MESSAGE | ERRCODE | DETAIL | HINT = ...]`**, or `RAISE SQLSTATE 'xxxxx'` or `RAISE condition_name`. `%` takes the next argument (`<NULL>` for null), `%%` is `%`. `EXCEPTION` stops with its SQLSTATE (P0001 by default; `ERRCODE` takes a code or a condition name such as `unique_violation`). `NOTICE`, `WARNING` and `INFO` go to the client as notices (psql shows them); `DEBUG` and `LOG` go nowhere. `DETAIL` and `HINT` reach a handler's `GET STACKED DIAGNOSTICS`, and aren't sent to clients yet.
- **Triggers:** `NEW` and `OLD` (NULL where there is none, as `OLD` in an `INSERT`), `TG_OP`, `TG_NAME`, `TG_WHEN`, `TG_LEVEL`, `TG_TABLE_NAME`, `TG_RELNAME`, `TG_TABLE_SCHEMA` (`public`), `TG_NARGS` and `TG_ARGV[i]` (from 0). `RETURN NEW`, `RETURN OLD`, another record, or `RETURN NULL`.
- **Ends:** a function reaching `END` without `RETURN` is 2F005, except one returning `void` or a set.
- **Statement timeouts:** `SET statement_timeout` and cancel requests stop a looping function (loops check, as scans do).
- **Not yet:** cursors (`OPEN`, `FETCH`, `FOR ... IN cursor`), `FOREACH`, labels, `%TYPE` / `%ROWTYPE`, `ALIAS`, `OUT` / `INOUT` / `VARIADIC` parameters and defaults, `RETURNS record`, a whole record in an expression (`NEW IS DISTINCT FROM OLD`: compare fields), array element assignment, `GET DIAGNOSTICS ... PG_CONTEXT`, transaction control, DDL inside a function (`EXECUTE` included), and taking back a temporary table's changes when a handler catches an error (as with `ROLLBACK TO`).

## Indexes

`CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON table [USING btree] (column [ASC|DESC], ...)` and `DROP INDEX [IF EXISTS] name`.

- **What they speed up:** `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, `IN (...)`, `IN (SELECT ...)`, `IS NULL` and `LIKE 'prefix%'` on an index's first columns (equal values on the first columns, then a list or a range on the next), with the constant on either side and constant expressions such as `now() - interval '7 days'`.
- **Two ranges:** with a range on an index's first column and another on its second (`a BETWEEN 1 AND 5 AND b > 0` on an index on `(a, b)`), the second is checked on each index entry, so rows outside it are never read.
- **Reading in order:** `ORDER BY` on an index's columns with a `LIMIT` reads the index in order, forwards or backwards, and stops when it has enough rows: the latest 20 of 100,000 rows takes about 0.04 ms instead of 230 ms. Equal values on the first columns can come first (`WHERE owner = $1 ORDER BY at DESC LIMIT 20` uses an index on `(owner, at)`), and more `ORDER BY` keys after the indexed ones are fine.
- **Wide ranges:** a range that holds more than about a fifth of the table reads the table instead, which is faster. So does one whose row ids outgrow `CHRONOS_WORK_MEM` (about 4 million rows at the default 256 MB): an index read holds the ids it finds, then reads each row as the query reaches it.
- **Building one on a big table** reads the table once and sorts the entries within `CHRONOS_WORK_MEM`, spilling to disk past it (as `ORDER BY` does), so memory doesn't grow with the table. A `UNIQUE` index (or `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`) finds any duplicate before it writes anything. The entries are then written in parts with a checkpoint every `CHRONOS_WORK_MEM` of them, and the index exists only once the last part is in: after a crash mid-build there is no index, and the entries written so far are unused rows until an index of that name is made again (which deletes them first) or the table is dropped. Writes and merges to the world wait while it builds; reads and forks don't. Inside `BEGIN ... COMMIT`, or made on a world and then merged, the merge builds the entries in memory.
- **Kept up by every write:** SQL and JSON writes, `ON DELETE` cascades, `ALTER TABLE` and merges. An index made on a branch arrives with the merge, built for every row.
- **Branches and crashes:** entries are rows like any other, so forks share them for free and crash recovery rebuilds them. `DIFF` doesn't show them.
- **Unique indexes** enforce uniqueness, like a `UNIQUE` constraint of the same name. On expressions (`create unique index on users (lower(email))`) they compare the expressions' values; partial ones (`... where active`) only compare rows their `WHERE` holds for.
- **Names** share one namespace across tables, as in Postgres. With no name, one is made up (`users_email_idx`).
- **On expressions:** `create index on users (lower(email))` or `((doc ->> 'status'))` serves conditions on that same expression, like `where lower(email) = $1`. The expression can't use subqueries, aggregates, or functions whose value changes (`now()`, `random()`).
- **Partial:** `create index on orders (placed) where not archived` holds entries only for rows its `WHERE` is true for, so it stays small. A query uses it when its own conditions include that `WHERE`.
- **Renames and drops:** an index's expression or `WHERE` follows a renamed column, and goes when a column it reads is dropped, as in Postgres.
- **Not yet:** `ON CONFLICT (lower(email))` naming a unique index by its expressions (use `ON CONFLICT DO NOTHING` without a target), and hash indexes, GIN on anything but a tsvector, or GiST on anything but a point column (pgvector's `hnsw` and `ivfflat` are accepted, see [Vectors](#vectors-pgvector); text and vector search are built in instead). A `jsonb` column can't be indexed as a whole; index an expression on it.

## Vectors (pgvector)

pgvector's SQL works as it is, so tools written for Postgres with pgvector (Mem0's `pgvector` store, LangChain, LlamaIndex) run unchanged. Mem0's store is checked against it with psycopg 2 and 3.

```sql
create extension if not exists vector;           -- accepted: vectors are built in
create table items (id uuid primary key, embedding vector(3), payload jsonb);
create index on items using hnsw (embedding vector_cosine_ops);   -- accepted, nothing to build
insert into items values ('a', '[1,0,0]', '{"user_id": "u1"}');
select id, embedding <=> '[1,0.1,0]' as distance from items
where payload->>'user_id' = 'u1' order by distance limit 5;
```

- **The type:** `vector` or `vector(n)`. Values are written `'[1,2,3]'`, as an array (`'{1,2,3}'`, `ARRAY[1,2,3]`: how drivers send lists) or as a JSON array. `vector(n)` refuses other lengths (22000); a vector has 1 to 16,000 numbers.
- **Distances:** `<=>` (cosine distance), `<->` (Euclidean), `<#>` (the negative inner product). Vectors of different lengths are an error (22000). A zero vector's cosine distance is NaN, as in pgvector.
- **Stored as 4-byte floats,** as pgvector stores them: a 1,536-dimension vector takes 8 KB in a row and reads back without parsing numbers. Written out, vectors look as pgvector writes them (`[1,0.5,-2]`); outside SQL they're JSON arrays, so `find` sees them too (see [search](search.md)).
- **`SET hnsw.ef_search = n`** (1 to 1000, or `default`) sets the graph's beam for the session's searches, as in pgvector; it matters only for tables big enough to get a graph.
- **Without an index, exact:** `ORDER BY distance` compares every row the `WHERE` keeps, like pgvector without an index.
- **With `USING hnsw` (or `ivfflat`), fast:** `ORDER BY <column> <op> <constant vector> LIMIT k` on one table gets its candidates from the search index (an exact scan, or its HNSW graph when the graph has shown it finds at least 99% of what the scan does, or the table is too big to scan; see [search](search.md)), then reads just the rows it returns and runs the query on them, so distances and conditions stay exact. Equality on a column or on `jsonb ->> 'key'` (Mem0's `payload->>'user_id' = $1`) narrows the candidates in the index; other conditions are checked on them, and more candidates are fetched until the `LIMIT` fills. On 76,000 real OpenAI embeddings that's 99.98% recall@10 in about 1 ms through the Postgres protocol (see [benchmarks](https://github.com/Abhishekxdg/chronosdb/blob/main/BENCHMARKS.md)). Candidates are ranked by dot product, which is cosine for the unit-length vectors most embedding models give. The index's options (`m`, `ef_construction`) are ignored: the search index has its own.
- **Indexes:** an `hnsw` index is a note on the table, since the search index does the work (`DROP INDEX` removes it); GIN (or GiST) indexes on `to_tsvector(...)` or a `tsvector` column, and GiST indexes on points, are real indexes (see the full-text and points entries above). Other index methods are refused (0A000).
- **Over the Postgres port:** text as pgvector writes it (`[1,2,3]`), and pgvector's binary form. The type's id is fixed (90000); drivers that don't know it read vectors as text.
- **Also for these tools:** `information_schema.tables` (the branch's tables, in schema `public`; see [the catalog](#the-catalog-information_schema-and-pg_catalog)), `public.table` names in `FROM`, and `DEALLOCATE` (see [Prepared statements](#prepared-statements)).

## EXPLAIN

`EXPLAIN [ANALYZE] statement`, or Postgres's `EXPLAIN (ANALYZE, FORMAT TEXT, ...)`, for `SELECT`, `INSERT`, `UPDATE` and `DELETE`. It returns one `QUERY PLAN` column in Postgres's layout:

```
Limit  (actual rows=20)
  ->  Sort
        ->  Index Scan Backward using events_owner_at on events  (actual rows=20)
Execution Time: 0.061 ms
```

- **Each table's read** shows how Chronos reached its rows: `Index Scan using <index>` with its `Index Cond`, the primary key, the search index, or `Seq Scan`. A table looked up once per row of a join shows `loops=`.
- **`ANALYZE` runs the statement**, as in Postgres (so `EXPLAIN ANALYZE DELETE` deletes), and adds actual row counts and the time taken. Without it, a write only finds its rows.
- **Not shown:** costs, and how joins pair rows beyond the order tables are read in.

## Text order

Text compares and sorts by its bytes (UTF-8), as Postgres does with `COLLATE "C"`: `'Z'` comes before `'a'`, and `'é'` after `'z'`. Indexes use the same order, so `LIKE 'abc%'` is a range. Postgres databases made with another collation (such as `en_US.UTF-8`) order text differently.

## Moving from Postgres

`chronos import` with a Postgres URL moves a whole database, while it runs:

```bash
chronos import mydb postgres://ada:secret@db.example.com:5432/shop --dry-run   # what would come over, nothing written
chronos import mydb postgres://ada:secret@db.example.com:5432/shop
```

```
"customers": 5000 rows
"orders": 18230 rows

imported 2 of 2 tables (23230 rows) into main, and 3 foreign keys, indexes and views

not imported (2):
  - function public.touch_updated_at: not imported (recreate it with CREATE FUNCTION)
  - trigger orders_touch on orders: triggers and their functions aren't imported
```

- **What comes over:** schemas, enum types, sequences (set to where Postgres had them, so `serial` and identity columns go on from there), tables with their columns, types, `NOT NULL`, defaults, primary keys, `UNIQUE` and `CHECK` constraints, then every row, then foreign keys (checked against the rows), indexes, views and materialized views.
- **What doesn't, reported instead of stopping the rest:** extensions (except `vector` and `postgis`, which are built in), functions, triggers, row-level security, roles and grants (give each program an agent instead), and any table, type or statement Chronos refuses, with its reason. A table whose rows fail to load stays, empty, and is named in the report.
- **Rows** move in COPY's text format, a table at a time, each as one `INSERT`: Chronos reads each value as its column's type, so types whose binary form it doesn't read (`uuid`, `bytea`, arrays) come over too, and floats come over exactly (Postgres 12 and later print them so they read back the same).
- **Connecting:** `sslmode` works as in libpq: `prefer` (the default: TLS if the server offers it, without checking whose certificate), `disable`, `require`, and `verify-full` (checks the certificate against `sslrootcert=<file.pem>` or the system's CAs; `verify-ca` does the same). Logins: trust, a password, and SCRAM-SHA-256; MD5 isn't supported (set `password_encryption = scram-sha-256`). The password can come from `PGPASSWORD`. TCP only, no Unix sockets.
- **Where it goes:** into `main`, or `-b <world>`. The folder must not be open in another process. Names are kept: `public.orders` is `orders`, other schemas' tables keep their schema (`app.orders`).
- **Text order:** Chronos sorts text by bytes, as `COLLATE "C"` does (see [Text order](#text-order)).

## Importing a Postgres table

`chronos import` copies one table from Postgres into a new table, to try Chronos on your own data.
Make two files with psql, putting your table's name in place of `TABLE` (running `chronos import`
with no arguments prints these commands too):

```
psql -c "\copy TABLE to 'data.csv' csv header"
psql --csv -t -c "select c.column_name, c.data_type, c.is_nullable, exists (select 1 from information_schema.table_constraints tc join information_schema.key_column_usage k using (constraint_schema, constraint_name) where tc.table_name = c.table_name and tc.table_schema = c.table_schema and tc.constraint_type = 'PRIMARY KEY' and k.column_name = c.column_name) from information_schema.columns c where c.table_name = 'TABLE' order by c.ordinal_position" > schema.csv
chronos import mydb TABLE data.csv --schema schema.csv
```

- Types: integers, `bigint`, `real`/`double precision`/`numeric` (as floats), `text`/`varchar`/`char`/`uuid`
  (as text), `boolean`, `date`, `timestamp`, `timestamptz`, `interval`, `json`/`jsonb`. Any other type
  (arrays, enums, `bytea`, ...) comes in as text, with a warning naming the column.
- An empty field is NULL and a quoted empty field (`""`) is an empty string, as `\copy` writes them.
- The table needs a primary key, of one column or several. Tables with none are refused.
- It's all or nothing: a bad row or value stops the import, names the line and column, and leaves no
  table behind. Importing into a table name that already exists is refused.
- `-b <branch>` imports into a branch other than main.

Sample data to try it on: `cargo run --example sample_data -- sample/` writes 5,000 customers and
their orders (with dates relative to today; exactly 1,240 customers have been inactive for over 90
days) plus their schema files, ready for `chronos import`.

## Speed

- **Lookups by primary key** read one row, and `key IN (...)` reads each. A range on the key (`BETWEEN`, `<`, `>`, one-sided too) reads just the rows in it, however wide: keys are stored in the order SQL compares them, integers as numbers and text as text. Tables made with 0.1.0 or before keep integer keys as their digits: there a range on one is read key by key up to 100,000 keys wide, and wider ones scan the table.
- **B-tree indexes** answer the conditions above (see [Indexes](#indexes)).
- **`column = value` conditions** on integer, bigint, text or boolean columns with no B-tree index (joined by `AND`) use the search index the rest of Chronos already keeps for the table. The rest of the `WHERE` is checked on the rows the index finds. It's built on first use and updated incrementally, per branch. It holds the table in memory, several times over (about ten times, for long unique text), so a query builds it only for tables whose rows fit in an eighth of `CHRONOS_WORK_MEM` (32 MB by default); bigger tables are scanned, unless a search already built their index.
- **Unique checks** (`UNIQUE`, `ON CONFLICT`) look up the constraint's own entry: one read, whatever the table's size.
- **Other conditions scan the table:** conditions on unindexed columns, `OR`, and float columns without an index.
- **Rows a query doesn't read** are skipped as each row is decoded.
- **Big queries use every core.** Above about 8,000 rows, scans (reading, decoding and filtering), building and probing hash joins, and `GROUP BY` split the rows into parts of about 4,000 that the cores take in turn, so fast and slow cores both stay busy. It scales with the machine on its own: Chronos uses as many threads as the operating system says it may (container CPU limits included). Queries running at the same time share those threads rather than each starting its own, so a busy server doesn't run more threads than cores. `CHRONOS_THREADS=n` sets the number instead. The parts depend on the data, not on the number of cores, so the answer is the same on any machine, sums of floats included. Queries with subqueries in their conditions, and `count(DISTINCT ...)`-style aggregates, run on one core.
- **Memory:** one-table `GROUP BY`, `DISTINCT` aggregates and `ORDER BY` spill to disk past `CHRONOS_WORK_MEM` (256 MB by default), and `ORDER BY ... LIMIT k` holds only k rows however big the table: see [operations](operations.md#memory-and-spilling-to-disk). So do the writes of a big `INSERT`, `UPDATE`, `DELETE` or `COPY`, which stays one atomic statement; `ON CONFLICT`, `RETURNING`, tables with triggers and a few other cases still hold them (the list is in [operations](operations.md#databases-bigger-than-memory)).
- **Big joins join while reading.** In a join of two tables, each core reads part of the first and joins it straight away; with `GROUP BY`, it groups the part too when the aggregates don't depend on how rows are split (`count`, `min`/`max` of a column, `sum`/`avg` of an integer column). If the first table's own conditions leave 1,000 rows or fewer, the join looks each match up by key instead, as before. Integer `sum` and `avg` add in 128 bits, so only the total has to fit in a `bigint`, as in Postgres.
- **Errors in big queries:** when a query would fail in more than one way, which error it reports can vary between runs, as with Postgres's parallel queries. The results of queries that succeed never vary.

See [BENCHMARKS.md](https://github.com/Abhishekxdg/chronosdb/blob/main/BENCHMARKS.md#4-sql-over-the-postgres-protocol) for numbers against Postgres.

Every write to a SQL table, SQL or JSON, stores the column's type, so index lookups and scans agree.

## Not yet

- **Functions:** `to_char`'s `EEEE`, `RN`, `TH` and `V` number patterns, and regular expression lookaround, among others.
- **COPY:** the binary format, `COPY ... FROM ... WHERE`, and files or programs on the server (refused on purpose; use psql's `\copy`).
- **Types and schemas:** composite and domain types, and schemas' owners and privileges.
- **Temporary tables:** `ON COMMIT DROP` / `DELETE ROWS` and savepoints (see [Temporary tables](#temporary-tables)).
- **User-defined functions and triggers:** the parts of `CREATE FUNCTION`, PL/pgSQL and `CREATE TRIGGER` listed as not yet under [Functions and triggers](#functions-and-triggers), and other languages than `sql` and `plpgsql`.
- **Views:** `WITH CHECK OPTION`, `ON CONFLICT` through a view, and renaming a table a view reads.
- **Catalog:** `pg_enum`, `pg_proc` and other catalog tables not listed under [the catalog](#the-catalog-information_schema-and-pg_catalog).

Each gives a clear error rather than a wrong answer.
