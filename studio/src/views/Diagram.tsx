// The world's schema as a canvas: a card per table (its columns and types), foreign keys drawn
// between the columns they join, cards dragged where you like (kept in this browser), a menu on
// each card, and the picked table's details in the inspector on the right.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { sql } from '../api';
import { useApp } from '../context';
import { Icon, typeMark } from '../icons';
import { copyText, Empty, ErrorBox, StatusSlot } from '../ui';
import { n, plural, qtable, store } from '../util';
import { setDraft } from './Sql';

interface Col {
  name: string;
  type: string;
  nullable: boolean;
  def: string | null;
}
interface Node {
  name: string;
  json: boolean;
  rows: number | null;
  cols: Col[];
  pk: string[];
}
interface Link {
  name: string;
  from: string;
  cols: string[];
  to: string;
  refs: string[];
}
type Pos = Record<string, { x: number; y: number }>;

// card geometry (px), matched by .dg-node in styles.css
const W = 272;
const HEAD = 58;
const PAD = 6;
const ROW = 30;
const MAX_COLS = 12;
const FOOT = 48;
const heightOf = (nd: Node) => HEAD + PAD * 2 + Math.min(nd.cols.length, MAX_COLS + (nd.cols.length > MAX_COLS ? 1 : 0)) * ROW + FOOT;
/** where a column's line meets the card (its row's middle; a column not shown: the header) */
const rowY = (nd: Node, col: string) => {
  const i = nd.cols.findIndex((c) => c.name === col);
  return i < 0 ? HEAD / 2 : HEAD + PAD + Math.min(i, MAX_COLS) * ROW + ROW / 2;
};

const SYS = "('information_schema', 'pg_catalog')";
const full = (s: unknown, t: unknown) => (s === 'public' ? String(t) : `${s}.${t}`);

async function load(world: string, tables: { name: string; rows: number | null; schema: boolean }[]) {
  const [cols, keys, refs] = await sql(
    `select table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_schema not in ${SYS} order by table_schema, table_name, ordinal_position;
     select tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type, k.column_name from information_schema.table_constraints tc join information_schema.key_column_usage k on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name where tc.constraint_type in ('PRIMARY KEY', 'FOREIGN KEY') and tc.table_schema not in ${SYS} order by tc.constraint_name, k.ordinal_position;
     select rc.constraint_schema, rc.constraint_name, ccu.table_schema, ccu.table_name, ccu.column_name from information_schema.referential_constraints rc join information_schema.constraint_column_usage ccu on ccu.constraint_schema = rc.constraint_schema and ccu.constraint_name = rc.constraint_name`,
    world,
  );
  const nodes = new Map<string, Node>(tables.map((t) => [t.name, { name: t.name, json: !t.schema, rows: t.rows, cols: [], pk: t.schema ? [] : ['id'] }]));
  for (const r of cols.rows) {
    const nd = nodes.get(full(r.table_schema, r.table_name));
    if (!nd) continue; // a view
    const type =
      r.data_type === 'USER-DEFINED' ? String(r.udt_name) : r.data_type === 'ARRAY' ? String(r.udt_name).replace(/^_/, '') + '[]' : String(r.data_type);
    nd.cols.push({ name: String(r.column_name), type, nullable: r.is_nullable === 'YES', def: r.column_default == null ? null : String(r.column_default) });
  }
  const fks = new Map<string, Link>();
  for (const r of keys.rows) {
    const t = full(r.table_schema, r.table_name);
    const nd = nodes.get(t);
    if (!nd) continue;
    if (r.constraint_type === 'PRIMARY KEY') nd.pk.push(String(r.column_name));
    else {
      const k = `${r.table_schema}.${r.constraint_name}`;
      const l = fks.get(k) || { name: String(r.constraint_name), from: t, cols: [], to: '', refs: [] };
      l.cols.push(String(r.column_name));
      fks.set(k, l);
    }
  }
  for (const r of refs.rows) {
    const l = fks.get(`${r.constraint_schema}.${r.constraint_name}`);
    if (!l) continue;
    l.to = full(r.table_schema, r.table_name);
    l.refs.push(String(r.column_name));
  }
  return { nodes: [...nodes.values()], links: [...fks.values()].filter((l) => l.to && nodes.has(l.to)) };
}

/** Columns of cards, left to right: a table sits right of the tables it refers to. */
function autoLayout(nodes: Node[], links: Link[]): Pos {
  const out = new Map<string, string[]>();
  for (const l of links) if (l.from !== l.to) out.set(l.from, [...(out.get(l.from) || []), l.to]);
  const level = new Map<string, number>();
  const lv = (t: string, seen: Set<string>): number => {
    if (level.has(t)) return level.get(t)!;
    if (seen.has(t)) return 0; // a cycle
    seen.add(t);
    const v = Math.max(-1, ...(out.get(t) || []).map((x) => lv(x, seen))) + 1;
    level.set(t, v);
    return v;
  };
  const cols: Node[][] = [];
  for (const nd of nodes) (cols[lv(nd.name, new Set())] ||= []).push(nd);
  // many unrelated tables: wrap into rows of cards instead of one very tall column
  const pos: Pos = {};
  const per = Math.max(3, Math.ceil(Math.sqrt(nodes.length)));
  let x = 48;
  for (const c of cols.filter(Boolean)) {
    for (let i = 0; i < c.length; i += per) {
      let y = 48;
      for (const nd of c.slice(i, i + per)) {
        pos[nd.name] = { x, y };
        y += heightOf(nd) + 40;
      }
      x += W + 96;
    }
  }
  return pos;
}

interface Saved {
  pos: Pos;
  hidden: string[];
}

export function DiagramView() {
  const app = useApp();
  const { world } = app;
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = `chronos-studio-diagram:${app.folder}`;
  const [saved, setSaved] = useState<Saved>(() => {
    try {
      return { pos: {}, hidden: [], ...JSON.parse(store.get(key) || '{}') };
    } catch {
      return { pos: {}, hidden: [] };
    }
  });
  const save = (s: Saved) => (setSaved(s), store.set(key, JSON.stringify(s)));
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ name: string; x: number; y: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState(1);
  const zoom = (next: number) => setZ(Math.min(1.5, Math.max(0.3, Math.round(next * 100) / 100)));

  useEffect(() => {
    if (!app.tablesReady) return;
    load(world, app.tables).then(setData, setError);
  }, [world, app.tablesReady]); // eslint-disable-line

  const shown = useMemo(() => data?.nodes.filter((nd) => !saved.hidden.includes(nd.name)) || [], [data, saved.hidden]);
  const pos = useMemo(() => {
    const auto = data ? autoLayout(shown, data.links) : {};
    const p: Pos = { ...auto, ...saved.pos };
    if (drag) p[drag.name] = { x: drag.x, y: drag.y };
    return p;
  }, [data, shown, saved.pos, drag]);
  const byName = useMemo(() => new Map(shown.map((nd) => [nd.name, nd])), [shown]);
  const links = (data?.links || []).filter((l) => byName.has(l.from) && byName.has(l.to));
  const size = shown.reduce(
    (m, nd) => ({ w: Math.max(m.w, (pos[nd.name]?.x ?? 0) + W + 160), h: Math.max(m.h, (pos[nd.name]?.y ?? 0) + heightOf(nd) + 160) }),
    { w: 800, h: 600 },
  );

  const fit = () => {
    const sc = scroller.current;
    if (!sc) return;
    // small enough to see it all, never so small the cards can't be read
    zoom(Math.max(0.75, Math.min(1, (sc.clientWidth - 32) / size.w, (sc.clientHeight - 32) / size.h)));
    sc.scrollTo(0, 0);
  };
  const fitted = useRef(false);
  useEffect(() => {
    if (data && !fitted.current && scroller.current) ((fitted.current = true), fit());
  });
  // ⌘/Ctrl + wheel (or a pinch) zooms
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZ((v) => Math.min(1.5, Math.max(0.3, v * Math.exp(-e.deltaY / 300))));
    };
    sc.addEventListener('wheel', wheel, { passive: false });
    return () => sc.removeEventListener('wheel', wheel);
  }, [data]);

  const openData = (t: string) => app.pickTable(t);
  const query = (t: string) => {
    setDraft(`select * from ${qtable(t)} limit 100;`);
    app.show('sql');
  };
  const hide = (t: string) => {
    save({ ...saved, hidden: [...saved.hidden, t] });
    if (picked === t) setPicked(null);
  };

  // Enter opens the picked table's data, H hides it, Esc lets go
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('.overlay') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Escape') menu ? setMenu(null) : setPicked(null);
      else if (picked && e.key === 'Enter' && !t.closest('button, a')) openData(picked);
      else if (picked && e.key.toLowerCase() === 'h') hide(picked);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    addEventListener('mousedown', close);
    addEventListener('blur', close);
    return () => (removeEventListener('mousedown', close), removeEventListener('blur', close));
  }, [menu]);

  const startDrag = (nd: Node) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    setPicked(nd.name);
    const p0 = pos[nd.name];
    const sx = e.clientX;
    const sy = e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let last = p0;
    const move = (ev: PointerEvent) => {
      last = { x: Math.max(0, p0.x + (ev.clientX - sx) / z), y: Math.max(0, p0.y + (ev.clientY - sy) / z) };
      setDrag({ name: nd.name, ...last });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDrag(null);
      if (last !== p0) save({ ...saved, pos: { ...saved.pos, [nd.name]: last } });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  // dragging the empty canvas pans it
  const startPan = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.dg-node, .dg-tools')) return;
    setPicked(null);
    const sc = scroller.current!;
    const sx = e.clientX + sc.scrollLeft;
    const sy = e.clientY + sc.scrollTop;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.classList.add('panning');
    const move = (ev: PointerEvent) => sc.scrollTo(sx - ev.clientX, sy - ev.clientY);
    const up = () => (el.classList.remove('panning'), el.removeEventListener('pointermove', move), el.removeEventListener('pointerup', up));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  if (error)
    return (
      <div className="pad">
        <ErrorBox error={error} />
      </div>
    );
  if (!data) return <Empty>Reading the schema…</Empty>;
  if (!data.nodes.length) return <Empty>No tables in this world yet. Create one in the SQL tab: its card shows here.</Empty>;

  const sel = picked ? byName.get(picked) : undefined;
  // `i` spreads links that share a gap onto their own vertical lanes
  const edge = (l: Link, i: number) => {
    const lane = ((i % 5) - 2) * 12;
    const a = byName.get(l.from)!;
    const b = byName.get(l.to)!;
    const pa = pos[a.name];
    const pb = pos[b.name];
    const y1 = pa.y + rowY(a, l.cols[0]);
    const y2 = pb.y + rowY(b, l.refs[0]);
    let x1: number, x2: number, mid: number;
    if (pa.x > pb.x + W) [x1, x2] = [pa.x, pb.x + W];
    else if (pa.x + W < pb.x) [x1, x2] = [pa.x + W, pb.x];
    else {
      // stacked cards (or a table referring to itself): go round the right side
      x1 = pa.x + W;
      x2 = pb.x + W;
      mid = Math.max(x1, x2) + 36 + Math.abs(lane);
      return {
        d: `M${x1} ${y1}H${mid}V${y2}H${x2}`,
        ends: [
          [x1, y1],
          [x2, y2],
        ],
      };
    }
    mid = Math.round((x1 + x2) / 2) + lane;
    return {
      d: `M${x1} ${y1}H${mid}V${y2}H${x2}`,
      ends: [
        [x1, y1],
        [x2, y2],
      ],
    };
  };

  return (
    <>
      <div className="dg-wrap">
        <div className="diagram" ref={scroller}>
          <div className="dg-sizer" style={{ width: size.w * z, height: size.h * z }}>
            <div className="dg-plane" style={{ width: size.w, height: size.h, transform: `scale(${z})` }} onPointerDown={startPan}>
              <svg className="dg-links" width={size.w} height={size.h} aria-hidden="true">
                {links.map((l, i) => {
                  const { d, ends } = edge(l, i);
                  const hot = picked === l.from || picked === l.to;
                  return (
                    <g key={l.from + l.name} className={hot ? 'hot' : ''}>
                      <path d={d} />
                      {ends.map(([x, y], i) => (
                        <rect key={i} x={x - 4} y={y - 4} width="8" height="8" transform={`rotate(45 ${x} ${y})`} />
                      ))}
                    </g>
                  );
                })}
              </svg>
              {shown.map((nd) => {
                const p = pos[nd.name];
                const on = nd.name === picked;
                return (
                  <div
                    key={nd.name}
                    className={'dg-node' + (on ? ' on' : '') + (drag?.name === nd.name ? ' dragging' : '')}
                    style={{ left: p.x, top: p.y, width: W } as CSSProperties}
                    onPointerDown={startDrag(nd)}
                    onDoubleClick={() => openData(nd.name)}
                    onContextMenu={(e) => (e.preventDefault(), setPicked(nd.name), setMenu({ name: nd.name, x: e.clientX, y: e.clientY }))}
                  >
                    {on && <span className="dg-tag">{nd.json ? 'JSON table' : 'table'}</span>}
                    <div className="dg-head">
                      <div className="dg-title">
                        <span className="nm" title={nd.name}>
                          {nd.name}
                        </span>
                        <button
                          type="button"
                          className="btn ghost icon small"
                          aria-label={`Actions for ${nd.name}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setPicked(nd.name);
                            setMenu(menu?.name === nd.name ? null : { name: nd.name, x: r.left, y: r.bottom + 4 });
                          }}
                        >
                          <Icon name="vmore" />
                        </button>
                      </div>
                      <div className="dg-sub">
                        {nd.rows == null ? '' : plural(nd.rows, 'row')}
                        {nd.pk.length > 0 && ` · key ${nd.pk.join(', ')}`}
                      </div>
                    </div>
                    <ul className="dg-cols">
                      {nd.cols.slice(0, MAX_COLS).map((c) => (
                        <li key={c.name} title={`${c.name} ${c.type}${c.nullable ? '' : ' not null'}`}>
                          <Icon name="grip" size={12} />
                          <span className="tm">{nd.pk.includes(c.name) ? <Icon name="key" size={12} /> : typeMark(c.type)}</span>
                          <span className="cn">{c.name}</span>
                          <span className="ct">{c.type}</span>
                        </li>
                      ))}
                      {nd.cols.length > MAX_COLS && <li className="more">+{nd.cols.length - MAX_COLS} more columns</li>}
                    </ul>
                    <button type="button" className="dg-foot" onClick={() => openData(nd.name)}>
                      <Icon name="table" size={14} />
                      Open data
                      <span className="kbd">↵</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="dg-tools">
          <span className="muted">
            {plural(shown.length, 'table')} · {plural(links.length, 'link')}
          </span>
          <span className="sep" />
          <button className="btn small ghost icon" type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(z - 0.1)}>
            −
          </button>
          <button className="btn small ghost zoom" type="button" title="Actual size" onClick={() => zoom(1)}>
            {Math.round(z * 100)}%
          </button>
          <button className="btn small ghost icon" type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(z + 0.1)}>
            +
          </button>
          <button className="btn small ghost" type="button" title="Fit every table on screen" onClick={fit}>
            <Icon name="layout" size={14} /> Fit
          </button>
          <span className="sep" />
          <button className="btn small ghost" type="button" title="Put every card back in its automatic place" onClick={() => save({ ...saved, pos: {} })}>
            Tidy up
          </button>
          {saved.hidden.length > 0 && (
            <button className="btn small ghost" type="button" onClick={() => save({ ...saved, hidden: [] })}>
              <Icon name="eye" size={14} /> Show {plural(saved.hidden.length, 'hidden table')}
            </button>
          )}
        </div>
        {menu && (
          <div className="pop menu ctx" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()} role="menu">
            {(
              [
                ['table', 'Open data', 'Enter', () => openData(menu.name)],
                ['code', 'Query in SQL', '', () => query(menu.name)],
                ['copy', 'Copy name', '', () => copyText(menu.name)],
                ['eyeOff', 'Hide', 'H', () => hide(menu.name)],
              ] as const
            ).map(([icon, label, k, run]) => (
              <button key={label} type="button" role="menuitem" className="menu-item" onClick={() => (setMenu(null), run())}>
                <Icon name={icon} />
                {label}
                {k && <span className="kbd">{k}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {sel && (
        <TablePanel
          nd={sel}
          links={data.links}
          onPick={setPicked}
          onClose={() => setPicked(null)}
          onOpen={() => openData(sel.name)}
          onQuery={() => query(sel.name)}
        />
      )}
      <StatusSlot>
        <span>{plural(data.nodes.length, 'table')}</span>
        <span>{plural(data.links.length, 'foreign key')}</span>
        <span className="spacer" />
        <span className="hint faint">Drag cards · double-click opens · right-click for more</span>
      </StatusSlot>
    </>
  );
}

function TablePanel({
  nd,
  links,
  onPick,
  onClose,
  onOpen,
  onQuery,
}: {
  nd: Node;
  links: Link[];
  onPick: (t: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onQuery: () => void;
}) {
  const out = links.filter((l) => l.from === nd.name);
  const into = links.filter((l) => l.to === nd.name);
  const field = (k: string, v: string) => (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
  return (
    <aside className="inspector" aria-label="Table details">
      <div className="ih">
        <span className="label">Table</span>
        <span className="spacer" />
        <button className="btn ghost icon" type="button" aria-label="Close (Esc)" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="ib">
        {field('Name', nd.name)}
        {field('Kind', nd.json ? 'JSON table: made by writing rows' : 'SQL table')}
        {field('Rows', nd.rows == null ? '?' : n(nd.rows))}
        {field('Primary key', nd.pk.join(', ') || 'None')}
        <div className="sec">
          <h3 className="label">Columns · {nd.cols.length}</h3>
          <div>
            {nd.cols.map((c) => (
              <div key={c.name} className="schema-col">
                <span className="n">{c.name}</span>
                <span className="ty">{c.type}</span>
                <span className="d">
                  {[nd.pk.includes(c.name) && 'primary key', !c.nullable && 'not null', c.def && `default ${c.def}`].filter(Boolean).join(' · ') || ' '}
                </span>
              </div>
            ))}
          </div>
        </div>
        {(out.length > 0 || into.length > 0) && (
          <div className="sec">
            <h3 className="label">Links</h3>
            {out.map((l) => (
              <button key={'o' + l.name} type="button" className="link-line" onClick={() => onPick(l.to)}>
                {l.cols.join(', ')} <span className="d">→</span> {l.to}({l.refs.join(', ')})
              </button>
            ))}
            {into.map((l) => (
              <button key={'i' + l.name} type="button" className="link-line" onClick={() => onPick(l.from)}>
                {l.from}({l.cols.join(', ')}) <span className="d">→</span> {l.refs.join(', ')}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="if">
        <button className="btn primary" type="button" onClick={onOpen}>
          Open data
        </button>
        <button className="btn outline" type="button" onClick={onQuery}>
          Query in SQL
        </button>
      </div>
    </aside>
  );
}
