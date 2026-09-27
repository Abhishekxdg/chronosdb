# Contributing

Thanks for helping. The Chronos DB engine is closed source, so this repository takes
contributions to the Studio, the clients, the docs and the examples, and bug reports and
ideas for everything, the engine included.

## Reporting bugs

Use the issue templates. A few lines that reproduce it from an empty database (shell
commands, SQL or an HTTP request) and the output of `chronos --version` are the most useful
things you can send. Security issues go privately, as [SECURITY.md](SECURITY.md) says.

## The Studio

Chronos Studio (`studio/`) is a React + TypeScript app built with Vite. Work on it with live
reload against any installed `chronos`:

```bash
chronos studio mydb --no-open --port 7071                # prints http://127.0.0.1:7071/#t=<key>
cd studio && npm ci && STUDIO=http://127.0.0.1:7071 npm run dev   # then open http://localhost:5173/#t=<key>
```

`npm run build` type-checks and builds it. Each release of `chronos` has that release's
Studio built into it.

## Clients, docs and examples

- `clients/typescript/chronos.ts` and `clients/python/chronos.py`: one file each, no
  dependencies. `CHRONOS_URL=http://127.0.0.1:7070 python3 test_chronos.py` (in `clients/python`)
  checks the Python client against a running `chronos serve`.
- `docs/`: plain Markdown, also published by `site/` (Docusaurus): `cd site && npm ci && npm start`.
- `examples/`: SQL walkthroughs and agent tool definitions.

## Pull requests

- One change per pull request. Say what it does for someone using Chronos DB, and why.
- The Studio builds (`npm run build` in `studio/`), and the docs site builds with no broken
  links (`npm run build` in `site/`).
- By contributing you agree your contribution is licensed under the MIT License.
