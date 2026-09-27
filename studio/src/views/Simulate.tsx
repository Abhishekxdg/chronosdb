// Simulations: fork many worlds from one, run the same SQL in each (with its own index and seed),
// score each with a query, keep the best and discard the rest, in one `simulate` call. Kept
// worlds can be opened, reviewed, replayed (does the script give the same world again?) or
// discarded.
import { useRef, useState } from 'react';
import { api, type ApiError } from '../api';
import { useApp } from '../context';
import { ErrorBox, toast, useDialogs } from '../ui';
import { n, plural, store } from '../util';
import { discard } from './Changes';
import { highlight } from './Sql';

interface SimWorld {
  world: string;
  id: string;
  index: number;
  seed: number;
  score: number | null;
  error: string | null;
  kept: boolean;
}
interface SimResult {
  worlds: SimWorld[];
  base: string;
  at: number;
  timings: { fork_ms: number; run_ms: number; discard_ms: number; total_ms: number };
}
interface Replay {
  identical: boolean;
  rows_differing: number;
  score: number | null;
  recorded_score: number | null;
  error: string | null;
}
interface Form {
  from: string;
  worlds: string;
  prefix: string;
  script: string;
  score: string;
  order: 'desc' | 'asc';
  keep: string;
  seed: string;
}

const SAVED = 'chronos-studio-simulate';
// the last run and its replays, kept across the view reloading (opening a world reloads it)
let last: { res: SimResult; replays: Record<string, Replay | 'running' | string> } | null = null;

function SqlBox({
  value,
  onChange,
  label,
  placeholder,
  rows,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  rows: number;
}) {
  const hl = useRef<HTMLPreElement>(null);
  return (
    <div className="editor">
      <pre className="hl" aria-hidden="true" ref={hl}>
        {highlight(value)}
        {'\n'}
      </pre>
      <textarea
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        rows={rows}
        style={{ minHeight: rows * 22 + 24 }}
        value={value}
        onScroll={(e) => hl.current && ((hl.current.scrollTop = e.currentTarget.scrollTop), (hl.current.scrollLeft = e.currentTarget.scrollLeft))}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function SimulateView() {
  const app = useApp();
  const dlg = useDialogs();
  const [f, setF] = useState<Form>(() => {
    const blank: Form = { from: app.world, worlds: '20', prefix: 'sim', script: '', score: '', order: 'desc', keep: '3', seed: '0' };
    try {
      return { ...blank, ...JSON.parse(store.get(SAVED) || '{}'), from: app.world };
    } catch {
      return blank;
    }
  });
  const set = (k: keyof Form) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [res, setResState] = useState<SimResult | null>(last?.res ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [replays, setReplaysState] = useState<Record<string, Replay | 'running' | string>>(last?.replays ?? {});
  const setRes = (r: SimResult) => ((last = { res: r, replays: {} }), setResState(r), setReplaysState({}));
  const setReplays = (f: (r: Record<string, Replay | 'running' | string>) => Record<string, Replay | 'running' | string>) =>
    setReplaysState((r) => {
      const next = f(r);
      if (last) last.replays = next;
      return next;
    });

  const run = async () => {
    store.set(SAVED, JSON.stringify({ ...f, from: undefined }));
    const worlds = Number(f.worlds);
    if (!Number.isInteger(worlds) || worlds < 1 || worlds > 1000) return toast('Worlds: a whole number from 1 to 1,000');
    if (!f.prefix.trim() || !f.script.trim() || !f.score.trim()) return toast('Give a name prefix, a script and a score query');
    setBusy(true);
    setError(null);
    try {
      const r = await api<SimResult>('simulate', {
        from: f.from,
        worlds,
        prefix: f.prefix.trim(),
        script: f.script,
        score: f.score,
        order: f.order,
        keep: f.keep === 'all' ? 'all' : Number(f.keep) || 0,
        seed: Number(f.seed) || 0,
      });
      setRes(r);
      await app.reloadWorlds();
      toast(`Ran ${plural(r.worlds.length, 'world')}; kept ${n(r.worlds.filter((w) => w.kept).length)}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const replay = async (w: string) => {
    setReplays((r) => ({ ...r, [w]: 'running' }));
    try {
      const r = await api<Replay>('replay', { world: w });
      setReplays((x) => ({ ...x, [w]: r }));
    } catch (e) {
      setReplays((x) => ({ ...x, [w]: (e as Error).message }));
    }
  };
  const scores = (res?.worlds || []).map((w) => w.score).filter((s): s is number => s !== null);
  const [lo, hi] = [Math.min(...scores), Math.max(...scores)];
  const bar = (s: number | null) =>
    s === null || !scores.length ? 0 : hi === lo ? 100 : Math.max(4, ((f.order === 'desc' ? s - lo : hi - s) / (hi - lo)) * 100);

  return (
    <div className="scroll">
      <div className="pad stack sim">
        <div className="head-row">
          <h2 className="ident">Simulations</h2>
          <span className="muted">fork many worlds, run the same SQL in each, keep the best</span>
        </div>
        <div className="sim-form">
          <label className="field">
            <span>From world</span>
            <select value={f.from} onChange={(e) => set('from')(e.target.value)}>
              {app.worlds.map((w) => (
                <option key={w.name}>{w.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Worlds</span>
            <input type="text" inputMode="numeric" value={f.worlds} onChange={(e) => set('worlds')(e.target.value)} />
          </label>
          <label className="field">
            <span>Names</span>
            <input type="text" value={f.prefix} onChange={(e) => set('prefix')(e.target.value)} />
            <small className="note">
              {f.prefix || 'prefix'}_0, {f.prefix || 'prefix'}_1, …
            </small>
          </label>
          <label className="field">
            <span>Seed</span>
            <input type="text" inputMode="numeric" value={f.seed} onChange={(e) => set('seed')(e.target.value)} />
          </label>
          <div className="field wide">
            <span>Script, run in each world</span>
            <SqlBox
              label="Script"
              rows={4}
              value={f.script}
              onChange={set('script')}
              placeholder={
                "-- $1 is the world's index, $2 its seed. For example:\nupdate deals set amount = amount * (1 + ($2 % 20) / 100.0) where stage = 'proposal';"
              }
            />
          </div>
          <div className="field wide">
            <span>Score, a query giving one number per world</span>
            <SqlBox label="Score query" rows={2} value={f.score} onChange={set('score')} placeholder="select sum(amount) from deals where stage = 'won'" />
          </div>
          <label className="field">
            <span>Best is</span>
            <select value={f.order} onChange={(e) => set('order')(e.target.value)}>
              <option value="desc">the highest score</option>
              <option value="asc">the lowest score</option>
            </select>
          </label>
          <label className="field">
            <span>Keep</span>
            <select value={f.keep} onChange={(e) => set('keep')(e.target.value)}>
              {['1', '3', '5', '10'].map((k) => (
                <option key={k} value={k}>
                  the best {k}
                </option>
              ))}
              <option value="all">all of them</option>
            </select>
          </label>
          <div className="sim-run">
            <button className="btn primary" type="button" disabled={busy} onClick={run}>
              {busy ? 'Running…' : `Run ${f.worlds || 0} worlds`}
            </button>
            <span className="note">Each world is an instant fork. The ones not kept are discarded.</span>
          </div>
        </div>

        {error && <ErrorBox error={error} />}
        {res && (
          <div className="sec">
            <div className="head-row">
              <h3 className="label">Results, best first</h3>
              <span className="note">
                from {res.base} · forked in {n(Math.round(res.timings.fork_ms))} ms, ran in {n(Math.round(res.timings.run_ms))} ms, discarded in{' '}
                {n(Math.round(res.timings.discard_ms))} ms
              </span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl sim-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>World</th>
                    <th className="num">Score</th>
                    <th />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {res.worlds.map((w, i) => {
                    const rp = replays[w.world];
                    const live = w.kept && app.worlds.some((x) => x.name === w.world);
                    return (
                      <tr key={w.world} className={w.kept ? '' : 'dropped'}>
                        <td className="num">{i + 1}</td>
                        <td className="mono">
                          {w.world}
                          {live ? <span className="tag ok">kept</span> : <span className="tag">discarded</span>}
                          {w.error && <div className="err small">{w.error}</div>}
                        </td>
                        <td className="num">{w.score === null ? '—' : n(Math.round(w.score * 1000) / 1000)}</td>
                        <td className="bar-cell">
                          <span className="sbar">
                            <span style={{ width: `${bar(w.score)}%` }} />
                          </span>
                        </td>
                        <td className="nowrap num">
                          {live && (
                            <>
                              {rp === 'running' ? (
                                <span className="note">replaying…</span>
                              ) : rp && typeof rp === 'object' ? (
                                <span className={'tag ' + (rp.identical ? 'ok' : 'bad')} title={rp.error || ''}>
                                  {rp.identical ? 'replays identically' : `${plural(rp.rows_differing, 'row')} differ`}
                                </span>
                              ) : typeof rp === 'string' ? (
                                <span className="tag bad" title={rp}>
                                  replay failed
                                </span>
                              ) : null}
                              <button
                                className="btn small ghost"
                                type="button"
                                title="Run the script again from the same start and compare"
                                onClick={() => replay(w.world)}
                              >
                                Replay
                              </button>
                              <button className="btn small ghost" type="button" onClick={() => app.setWorld(w.world)}>
                                Open
                              </button>
                              <button className="btn small ghost" type="button" onClick={() => app.setWorld(w.world).then(() => app.show('changes'))}>
                                Review
                              </button>
                              <button className="btn small ghost danger" type="button" onClick={() => discard(app, dlg, w.world)}>
                                Discard
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
