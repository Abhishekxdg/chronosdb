// Formatting and SQL quoting shared by the views.

export const n = (x: unknown) => (typeof x === 'number' ? x.toLocaleString() : x == null ? '?' : String(x));
export const plural = (x: number, one: string, many?: string) => `${n(x)} ${x === 1 ? one : many || one + 's'}`;

const pad2 = (x: number) => String(x).padStart(2, '0');
let utc = false;
/** Times read in UTC (true) or this computer's zone (the Settings choice). */
export const setTimeZone = (inUtc: boolean) => void (utc = inUtc);
export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (utc) return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** The grid's row height for the chosen density (px, as .grid's --row in styles.css). */
export const rowHeight = () => (document.documentElement.dataset.density === 'compact' ? 26 : 32);

/** The rows as a CSV file (RFC 4180 quoting, UTF-8 with a BOM for Excel; objects and vectors as JSON), saved by the browser. */
export function downloadCsv(name: string, columns: string[], rows: Record<string, unknown>[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // text a spreadsheet would run as a formula (agents write data too): kept as text
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function bytes(b: number | null | undefined): string {
  if (b == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** A value as the grid shows it (JSON for objects), cut at `max` characters. */
export function text(v: unknown, max?: number): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return max && s.length > max ? s.slice(0, max) + '…' : s;
}
export function valClass(v: unknown): string {
  if (v === null || v === undefined) return 'v-null';
  if (typeof v === 'number') return 'v-num';
  if (typeof v === 'boolean') return 'v-bool';
  if (typeof v === 'object') return 'v-json';
  return '';
}

// SQL: identifiers in double quotes, values as string literals (standard_conforming_strings)
export const qid = (s: string) => '"' + s.replace(/"/g, '""') + '"';
export const qtable = (t: string) => t.split('.').map(qid).join('.');
export const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";
export const likeEsc = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** [schema, table] of a table name as the tables op gives it (`app.orders`, or `orders` in public). */
export function splitName(t: string): [string, string] {
  const i = t.indexOf('.');
  return i < 0 ? ['public', t] : [t.slice(0, i), t.slice(i + 1)];
}

/** An as-of moment as people read it: an ISO time as `2026-09-26 14:00:54 UTC`, anything else (`-1 hour`) as typed. */
export const when = (at: string) => (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(at) && at.endsWith('Z') ? at.slice(0, 19).replace('T', ' ') + ' UTC' : at);

export const suggestName = () => `edit-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`;

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** A world's hue: amber for main (live data), else one of six, picked by its id so it never changes. */
export function hueOf(w: { name: string; id: string } | undefined): string {
  if (!w || w.name === 'main') return 'var(--main)';
  let h = 0;
  for (const ch of w.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--h${h % 6})`;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = isMac ? '⌘' : 'Ctrl+';
