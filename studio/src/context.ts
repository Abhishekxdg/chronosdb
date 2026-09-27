// What every view shares: the active world and table, and the actions that change them.
import { createContext, useContext } from 'react';
import type { Table, World } from './api';

/** The canvas tabs, then the Database pages (from the sidebar's Database menu). */
export type Tab = 'data' | 'diagram' | 'sql' | 'search' | 'changes' | 'history' | 'simulate' | 'agents' | 'audit' | 'status' | 'settings';
export const TABS: [Tab, string][] = [
  ['data', 'Data'],
  ['diagram', 'Diagram'],
  ['sql', 'SQL'],
  ['changes', 'Changes'],
  ['history', 'History'],
  ['search', 'Search'],
];

export interface Prefs {
  theme: 'light' | 'dark' | 'system';
  explorer: boolean;
  worldline: boolean;
  density: 'comfortable' | 'compact';
  /** how times read: this computer's zone, or UTC */
  time: 'local' | 'utc';
}

export interface Merged {
  world: string;
  into: string;
  rows: number;
}

export interface App {
  world: string;
  worlds: World[];
  tables: Table[];
  /** the tables list has loaded for this world */
  tablesReady: boolean;
  table: string | null;
  tab: Tab;
  setWorld(name: string): Promise<void>;
  pickTable(name: string): void;
  reloadWorlds(): Promise<void>;
  reloadTables(): Promise<void>;
  /** Asks for a name, forks `from`, and makes the new world active. */
  forkFrom(from: string, suggested?: string): Promise<string | null>;
  show(tab: Tab): void;
  /** Reloads the current view (after a write). */
  refresh(): void;
  /** A time the Data view opens at (History's "View as of"). */
  asOf: string;
  setAsOf(at: string): void;
  /** What Search opens with (Find similar), taken once. */
  search: { table: string; field: string; id: string } | null;
  setSearch(q: { table: string; field: string; id: string } | null): void;
  /** Opens the current table's data as it was at `at`. */
  timeTravel(at: string): void;
  lastMerge: Merged | null;
  setLastMerge(m: Merged | null): void;
  /** Plays the merged world's thread drawing back into its parent. */
  drawBack(world: string): Promise<void>;
  /** Main edits allowed without asking, for this tab's life. */
  mainOk: boolean;
  setMainOk(ok: boolean): void;
  prefs: Prefs;
  setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void;
  /** The status bar's left part: the view puts its own line there (StatusSlot). */
  statusSlot: HTMLElement | null;
  /** The database folder's name. */
  folder: string;
}

export const AppCtx = createContext<App | null>(null);
export const useApp = () => useContext(AppCtx)!;
export const worldOf = (app: { worlds: World[] }, name: string) => app.worlds.find((w) => w.name === name);
/** main, then each world down to `name`. */
export function lineage(worlds: World[], name: string): World[] {
  const out: World[] = [];
  let w = worlds.find((x) => x.name === name);
  while (w && out.length < 64) {
    out.unshift(w);
    const p = w.parent;
    w = p == null ? undefined : worlds.find((x) => x.name === p || x.id === p);
  }
  return out;
}
