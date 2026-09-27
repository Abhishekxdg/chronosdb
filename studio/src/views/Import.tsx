// Importing rows into the open table: a CSV file (with a header row), a JSON array of objects,
// or NDJSON (one object per line). The file is read in the page, checked against the table's
// columns and previewed; then all of it goes in as one write (a transaction of INSERTs for a
// SQL table, one batch for a JSON table), or none of it.
import { useState } from 'react';
import { api, sql, type Row } from '../api';
import type { App } from '../context';
import { toast, type Dialogs } from '../ui';
import { lit, n, plural, qid, qtable } from '../util';
import { castType, runWrite, type TableInfo } from './Data';

const MAX_ROWS = 50_000;

/** RFC 4180 CSV: quoted fields with "" for a quote, commas and newlines inside quotes. */
export function parseCsv(src: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') ((field += '"'), i++);
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') (row.push(field), (field = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') out.push(row);
      ((row = []), (field = ''));
    } else field += ch;
  }
  if (field !== '' || row.length) (row.push(field), out.push(row));
  return out;
}

interface Parsed {
  columns: string[];
  rows: Row[];
}

/** The file's rows as objects (CSV cells as text, empty as null). */
function parseFile(name: string, text: string): Parsed {
  const body = text.replace(/^﻿/, '');
  if (/\.(json|ndjson|jsonl)$/i.test(name)) {
    const t = body.trim();
    const rows: unknown[] = t.startsWith('[')
      ? JSON.parse(t)
      : t
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l, i) => {
            try {
              return JSON.parse(l);
            } catch (e) {
              throw new Error(`line ${i + 1}: ${(e as Error).message}`);
            }
          });
    if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('every row must be a JSON object');
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r as Row)))];
    return { columns, rows: rows as Row[] };
  }
  const [head, ...cells] = parseCsv(body);
  if (!head?.length) throw new Error('the file is empty');
  const columns = head.map((h) => h.trim());
  const bad = cells.findIndex((c) => c.length !== columns.length);
  if (bad >= 0) throw new Error(`row ${bad + 2} has ${cells[bad].length} fields; the header has ${columns.length}`);
  return { columns, rows: cells.map((c) => Object.fromEntries(columns.map((k, i) => [k, c[i] === '' ? null : c[i]]))) };
}

function ImportForm({ info, into }: { info: TableInfo; into: { current: Parsed | null } }) {
  const [state, setState] = useState<{ name: string; parsed?: Parsed; error?: string } | null>(null);
  const known = new Set(info.cols.map((c) => c.column_name));
  const read = async (f: File) => {
    into.current = null;
    try {
      const parsed = parseFile(f.name, await f.text());
      if (!parsed.rows.length) throw new Error('the file has no rows');
      if (parsed.rows.length > MAX_ROWS)
        throw new Error(`${n(parsed.rows.length)} rows: the Studio imports up to ${n(MAX_ROWS)} at once (chronos import takes any size)`);
      const unknown = info.json ? [] : parsed.columns.filter((c) => !known.has(c));
      if (unknown.length) throw new Error(`no column ${unknown.map((c) => `"${c}"`).join(', ')} in this table (it has ${[...known].join(', ')})`);
      if (info.json && !parsed.columns.includes('id')) throw new Error('a JSON table needs an "id" field in every row');
      into.current = parsed;
      setState({ name: f.name, parsed });
    } catch (e) {
      setState({ name: f.name, error: (e as Error).message });
    }
  };
  const p = state?.parsed;
  return (
    <>
      <label className="drop">
        <input type="file" accept=".csv,.json,.ndjson,.jsonl,text/csv,application/json" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
        <span>{state ? state.name : 'Choose a CSV (with a header row), JSON or NDJSON file'}</span>
      </label>
      {state?.error && <div className="err">{state.error}</div>}
      {p && (
        <>
          <p className="note">
            {plural(p.rows.length, 'row')}, {plural(p.columns.length, 'column')}
            {!info.json && info.cols.length > p.columns.length ? ` (the other columns take their defaults)` : ''}
            {info.json ? '; a row whose id is already there is replaced' : ''}. All go in, or none. The first rows:
          </p>
          <div className="tbl-wrap preview">
            <table className="tbl">
              <thead>
                <tr>
                  {p.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {p.columns.map((c) => (
                      <td key={c} className="mono">
                        {r[c] === null || r[c] === undefined ? (
                          <span className="faint">null</span>
                        ) : typeof r[c] === 'object' ? (
                          JSON.stringify(r[c])
                        ) : (
                          String(r[c])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

/** Asks for a file, previews it, and imports it into `table` in one write. */
export async function importRows(app: App, dlg: Dialogs, table: string, info: TableInfo) {
  const into: { current: Parsed | null } = { current: null };
  const parsed = await dlg.modal<Parsed>(
    `Import rows into ${table}`,
    <ImportForm info={info} into={into} />,
    [
      { label: 'Cancel', value: () => null },
      { label: 'Import rows', cls: 'primary', value: () => into.current ?? (toast('Choose a file that reads cleanly first'), undefined) },
    ],
    true,
  );
  if (!parsed) return;
  const types = Object.fromEntries(info.cols.map((c) => [c.column_name, castType(c)]));
  await runWrite(app, dlg, `import ${plural(parsed.rows.length, 'row')} into ${table}`, async (world) => {
    if (info.json) {
      const rows = parsed.rows.map((r) => {
        const { id, ...record } = r;
        return { table, id: String(id), record };
      });
      return api('batch', { branch: world, rows });
    }
    const cols = parsed.columns;
    const value = (v: unknown, c: string) =>
      v === null || v === undefined ? 'NULL' : `CAST(${lit(typeof v === 'object' ? JSON.stringify(v) : String(v))} AS ${types[c]})`;
    const inserts: string[] = [];
    for (let i = 0; i < parsed.rows.length; i += 500) {
      const chunk = parsed.rows.slice(i, i + 500).map((r) => `(${cols.map((c) => value(r[c], c)).join(', ')})`);
      inserts.push(`insert into ${qtable(table)} (${cols.map(qid).join(', ')}) values ${chunk.join(',\n')};`);
    }
    return sql(`begin;\n${inserts.join('\n')}\ncommit;`, world);
  });
}
