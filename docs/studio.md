# Chronos Studio

A web UI for a Chronos database, built into the `chronos` binary: every install (install.sh, a release tarball) has it, with nothing else to install.

```bash
chronos studio mydb                # opens http://127.0.0.1:<free port>/#t=<session key> in your browser
chronos studio mydb --port 7071    # a fixed port
chronos studio mydb --no-open      # print the link, don't open a browser
```

It works beside a running `chronos serve`, `chronos mcp` or shell on the same folder: like a second shell, it connects to the process holding the folder over its local socket, and every call runs there. Ctrl-C stops the Studio (and closes the database, if the Studio opened it).

## What it does

Studio is built around worlds: see what's in one, and decide what to merge.

- **The window:** menus, a search that opens the command palette (⌘K), an icon rail of views, a sidebar (⌘B collapses it) with the folder, worlds, tables that open to their columns, a timeline and an outline, pill tabs, and a status bar.
- **Worlds and the worldline:** a tree of worlds as lineage in the sidebar, each with its own color, owner and change count. The worldline above the views draws every world as a lane off its parent at the moment it was forked (amber for main, the live data), and each merge into main rejoining it. Click a lane to switch world; drag across the strip to read the tables as they were. Fork, see details and metadata, save a checkpoint, or discard from the world menu.
- **Data:** a grid that pages through any table (only the visible rows are fetched) with filters, sorting and a read-only view **as of** any moment. Double-click a cell (or F2) to edit it in place. Import rows from CSV, JSON or NDJSON (checked, previewed, all or nothing), and export what you see as CSV. Vectors show as a strip of bars and their size.
- **Inspector:** a row's fields, JSON pretty-printed and vectors drawn, with Find similar rows. Edit, delete, add rows. On main, a change asks first and offers to make it in a new world instead: fork, edit, review, merge.
- **Diagram:** a card per table with its columns and types, foreign keys drawn between the columns they join; drag, pan, zoom and fit.
- **SQL:** runs in the active world (several statements at once) with colouring, timing, rows affected, errors with their SQLSTATE, `EXPLAIN`, history (kept in this browser), and CSV downloads.
- **Search:** words (typos forgiven), exact filters and nearness to a row's vector in one query, fused into one ranking, beside a map of the table's vectors (their two main axes, coloured by a field with few values). Click a point or a hit to search near it.
- **Changes:** what the world changed since its fork, per table and row by row (only the changed columns, before → after; a whole row added or removed as one line), paged. Preview the merge, merge into the parent, discard, or undo the last merge.
- **History:** a world's events and checkpoints; browse its tables as they were, or restore the world to a moment or a checkpoint (confirmed; history keeps what it replaces).
- **Simulations:** fork N worlds from one, run the same SQL in each (`$1` its index, `$2` its seed), score them with a query and keep the best; open, review, replay or discard what's kept.
- **Agents, audit log and status:** agents' capabilities and quotas (a new agent's token is shown once), the audit log, and the database's version, size, encryption, storage and metrics.
- **Settings (⌘,):** theme, density, the sidebar and worldline, times in your zone or UTC, the session's key, and an integrity check of the whole database.

Keys: ⌘K (Ctrl+K) opens the command palette (switch world, open a table, fork, review, merge, discard, theme). ⌘1–⌘6 switch tabs (Data, Diagram, SQL, Changes, History, Search), ⌘B collapses the sidebar, ⌘, opens Settings, ⌘Enter runs SQL, J/K or the arrows move through rows, Enter opens a row, E edits it, F2 or a double-click edits a cell, / filters, Esc closes, ? lists them all. Light and dark themes follow the system, or pick one in Settings.

## Security

Any program on this machine, and any web page open in your browser, can reach 127.0.0.1. So:

- **A session key.** Each run makes a random 256-bit key. The link carries it after `#`, which browsers never send to a server, so it isn't in logs or a `Referer`. The page moves it into the tab's session storage and sends it as `X-Studio-Token` on every API call; the server compares it in constant time. Without it (or with a wrong one), every `/studio/api/` call is refused (403). The page's own files need no key.
- **Only its own address.** Every request must name `Host: 127.0.0.1:<port>` exactly (a web page's own name pointed at 127.0.0.1, DNS rebinding, is refused), and an `Origin`, when a browser sends one, must be `http://127.0.0.1:<port>` exactly (other pages are refused). API bodies must be `application/json`.
- **Strict headers.** Every response has `Cache-Control: no-store`, a Content-Security-Policy that allows only the Studio's own scripts, styles, fonts and API (no inline script, no other site), `X-Frame-Options: DENY` with `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- **Data is text.** Row values are shown as text (React escapes them), never as HTML.
- **No paths.** Studio acts as the database's owner (it's your folder), but its server reads and writes no files by path: backups (a path) are refused; run `chronos mydb backup <folder>` instead. Import reads a file you pick in the browser, and exports are saved by the browser. The browser is opened on a small file that only you can read, which forwards to the link, so the key never appears in the process list.
- **Listens on 127.0.0.1 only.** `chronos serve`'s own API is unchanged: it still refuses web pages.

Keep the link to yourself: anyone with it, on this machine, can use the database as you.

## Big data

The grid never loads a whole table: it counts the rows, then fetches the pages in view as you scroll (a jump deep into 250,000 rows reads one page with `OFFSET`). A SQL table is shown in key order by default. The diff is paged 50 rows at a time, and a merge preview shows at most 200 rows, conflicts first, with how many rows had each outcome. A SQL query in the console returns its whole result: add a `LIMIT` to big ones.

## Developing the Studio

The UI is a small React + TypeScript app, open source under the MIT license in [`studio/`](https://github.com/Abhishekxdg/chronosdb/tree/main/studio) of the chronosdb repo. Each release of `chronos` has that release's Studio built into it.

To work on the UI with live reload, run a Studio from any installed `chronos` for the API, then Vite's dev server, which proxies `/studio/api` to it (with the Host and Origin it expects):

```bash
chronos studio mydb --no-open --port 7071                  # prints http://127.0.0.1:7071/#t=<key>
cd studio && STUDIO=http://127.0.0.1:7071 npm run dev    # then open http://localhost:5173/#t=<key>
```

The API is `POST /studio/api/<op>` with a JSON body: the ops of the HTTP API (see [http-api.md](http-api.md)), plus `tables` (a world's tables, row counts, and whether each has a SQL schema) and `status`. `worlds` also gives each world's number of changed rows.
