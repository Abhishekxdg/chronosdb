// The command palette (⌘K): switch world, open a table, run the common actions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';

const GROUP_ICON: Record<string, IconName> = { 'Go to': 'right', World: 'fork', 'Switch world': 'fork', 'Open table': 'table', Settings: 'sliders' };

export interface Command {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => (c.group + ' ' + c.label).toLowerCase().includes(w))).slice(0, 60);
  }, [q, commands]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  let last = '';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Commands">
        <div className="pal-in">
          <Icon name="search" size={16} />
          <input
            autoFocus
            type="search"
            placeholder="Type a command, a world or a table"
            aria-label="Command"
            aria-controls="palette-list"
            aria-activedescendant={shown[at] ? `cmd-${at}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                e.preventDefault();
                setAt((a) => Math.min(shown.length - 1, a + 1));
              } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                e.preventDefault();
                setAt((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') go(shown[at]);
              else if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>
        <ul id="palette-list" role="listbox" ref={list}>
          {!shown.length && <li className="empty">No command matches “{q}”</li>}
          {shown.map((c, i) => {
            const head =
              c.group !== last
                ? ((last = c.group),
                  (
                    <li key={'g' + c.group} className="group label">
                      {c.group}
                    </li>
                  ))
                : null;
            return [
              head,
              <li key={c.group + c.label} role="option" aria-selected={i === at} id={`cmd-${i}`}>
                <button type="button" tabIndex={-1} className={'menu-item' + (i === at ? ' active' : '')} onMouseMove={() => setAt(i)} onClick={() => go(c)}>
                  <Icon name={GROUP_ICON[c.group] || 'right'} size={15} />
                  <span>{c.label}</span>
                  {c.hint && <span className="kbd">{c.hint}</span>}
                </button>
              </li>,
            ];
          })}
        </ul>
        <div className="pal-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">↵</span> run
          </span>
          <span className="spacer" />
          <span>
            {shown.length} of {commands.length}
          </span>
        </div>
      </div>
    </div>
  );
}
