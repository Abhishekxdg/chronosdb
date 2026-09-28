// The Studio API client: POST /studio/api/<op> with the session token (src/studio.rs).

export type Row = Record<string, unknown>;

export interface World {
  name: string;
  id: string;
  parent: string | null;
  depth: number;
  created: number;
  version: number;
  flagged: boolean;
  meta: unknown;
  owner: string | null;
  expires: number | null;
  active: number;
  pinned: boolean;
  checkpoints: { name: string; at: number }[];
  /** rows changed since its fork (not for main) */
  changes?: number | null;
}

export interface Table {
  name: string;
  rows: number | null;
  /** made with CREATE TABLE; false for a table made by writing JSON rows */
  schema: boolean;
}

export interface SqlResult {
  command: string;
  columns: string[];
  rows: Row[];
}

/** Something in the database that reads columns a change changed (a view, a trigger, a key...). */
export interface Reader {
  table: string;
  columns: string[];
  kind: string;
  reader: string;
  detail: string;
  /** marked critical: a merge policy holds agents' merges changing what it reads */
  critical: boolean;
}

export interface Change {
  key: string;
  before: Row | null;
  after: Row | null;
  columns: string[] | null;
}

export interface Agent {
  name: string;
  can: string[];
  created: number;
  disabled: boolean;
  [quota: string]: unknown;
}

/** An error reply: `detail` is the server's `error` (a message, or an object with more). */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail: any,
  ) {
    super(message);
  }
}

const KEY = 'chronos-studio-token';

/** The token from the URL's #t=... (then taken out of the address bar), or this tab's saved one. */
function readToken(): string | null {
  const m = location.hash.match(/[#&]t=([0-9a-f]{64})/);
  if (m) {
    try {
      sessionStorage.setItem(KEY, m[1]);
    } catch {
      /* private mode: keep it in memory */
    }
    history.replaceState(null, '', location.pathname);
    return m[1];
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const token = readToken();
// a new link pasted into this tab (same page, new #t=...): start over with it
addEventListener('hashchange', () => /[#&]t=[0-9a-f]{64}/.test(location.hash) && (readToken(), location.reload()));

type Listener = (ok: boolean) => void;
const listeners = { conn: new Set<Listener>(), gate: new Set<() => void>() };
export const onConnection = (f: Listener) => (listeners.conn.add(f), () => void listeners.conn.delete(f));
export const onGate = (f: () => void) => (listeners.gate.add(f), () => void listeners.gate.delete(f));

export function errText(e: unknown): string {
  if (e == null) return 'error';
  if (typeof e === 'string') return e;
  const o = e as { message?: string; code?: string };
  if (o.message) return o.message + (o.code ? ` (SQLSTATE ${o.code})` : '');
  return JSON.stringify(e);
}

export async function api<T = any>(op: string, args: object = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch('/studio/api/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token || '' },
      body: JSON.stringify(args),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    listeners.conn.forEach((f) => f(false));
    throw new ApiError('Studio is not reachable: is chronos studio still running?', 0, null);
  }
  listeners.conn.forEach((f) => f(true));
  let body: { error?: unknown } & Record<string, unknown>;
  try {
    body = await r.json();
  } catch {
    body = { error: `bad reply (${r.status})` };
  }
  if (!r.ok) {
    const msg = errText(body.error);
    // the server's own refusals (not an operation's): the page needs its session link
    if (r.status === 403 && /X-Studio-Token|Host|other web pages/.test(msg)) listeners.gate.forEach((f) => f());
    throw new ApiError(msg, r.status, body.error);
  }
  return body as T;
}

/** Runs SQL (one or more statements) in a world: one result per statement. */
export const sql = (q: string, world: string) =>
  api<{ results: SqlResult[] }>('sql', { sql: q, branch: world }).then((r) => r.results);
