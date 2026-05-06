import { useEffect, useRef, type ReactNode } from 'react';
import { Search } from 'lucide-react';

import { cn } from '@/components/ui/utils';

interface ListDetailProps {
  toolbar?: ReactNode;
  meta?: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

/** Resizable two-column layout used by all four /claude tabs. */
export function ListDetail({ toolbar, meta, list, detail }: ListDetailProps) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const split = splitRef.current;
    const divider = dividerRef.current;
    if (!split || !divider) return;
    function onDown(e: MouseEvent) {
      if (!split) return;
      e.preventDefault();
      const rect = split.getBoundingClientRect();
      const startX = e.clientX;
      const startListW = (split.firstElementChild as HTMLElement | null)
        ?.getBoundingClientRect().width ?? 320;
      function onMove(ev: MouseEvent) {
        if (!split) return;
        const delta = ev.clientX - startX;
        let next = startListW + delta;
        const max = rect.width - 420 - 4;
        if (next < 220) next = 220;
        if (next > max) next = max;
        split.style.setProperty('--list-w', `${next}px`);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    function onDouble() {
      split?.style.removeProperty('--list-w');
    }
    divider.addEventListener('mousedown', onDown);
    divider.addEventListener('dblclick', onDouble);
    return () => {
      divider.removeEventListener('mousedown', onDown);
      divider.removeEventListener('dblclick', onDouble);
    };
  }, []);

  return (
    <div className="ccfg-split" ref={splitRef}>
      <div className="ccfg-list">
        {toolbar}
        {meta}
        <div className="ccfg-list-rows">{list}</div>
      </div>
      <div className="ccfg-divider" ref={dividerRef} />
      <div className="ccfg-detail">{detail}</div>
    </div>
  );
}

interface SearchToolbarProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  trailing?: ReactNode;
}

export function SearchToolbar({ value, onChange, placeholder, trailing }: SearchToolbarProps) {
  return (
    <div className="ccfg-list-toolbar">
      <div className="ccfg-search-wrap">
        <Search />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="ccfg-search"
        />
      </div>
      {trailing}
    </div>
  );
}

interface RowProps {
  active?: boolean;
  onClick?: () => void;
  name: ReactNode;
  scope?: 'project' | 'personal' | null;
  description?: string | null;
  meta?: ReactNode;
  overridden?: boolean;
}

export function Row({ active, onClick, name, scope, description, meta, overridden }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('ccfg-row text-left w-full', active && 'is-on')}
      style={overridden ? { opacity: 0.55 } : undefined}
    >
      <div className="ccfg-row-name">
        <span>{name}</span>
        {scope && (
          <span className={cn('ccfg-scope', scope === 'personal' && 'is-personal')}>
            {scope === 'project' ? 'proj' : 'pers'}
          </span>
        )}
        {overridden && (
          <span className="ccfg-scope" title="Overridden by a project entry of the same name">
            ovr
          </span>
        )}
      </div>
      {description && <div className="ccfg-row-desc">{description}</div>}
      {meta && <div className="ccfg-row-meta">{meta}</div>}
    </button>
  );
}

export function FrontmatterGrid({ entries }: { entries: Array<[string, ReactNode]> }) {
  return (
    <div className="ccfg-fm-grid">
      {entries.map(([k, v]) => (
        <RowFm key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function RowFm({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <span className="ccfg-fm-key">{k}</span>
      <span className="ccfg-fm-val">{v}</span>
    </>
  );
}

interface ChipsProps {
  values: readonly string[];
  variant?: 'tool' | 'skill' | 'mcp' | 'event' | 'default';
  /** Show the first N chips and collapse the rest under a "+ N more" expander. */
  initial?: number;
}

export function Chips({ values, variant = 'default', initial }: ChipsProps) {
  const limit = initial ?? values.length;
  const visible = values.slice(0, limit);
  const hidden = values.length - visible.length;
  const cls = variant === 'default' ? '' : `is-${variant}`;
  return (
    <div className="ccfg-chips">
      {visible.map((v) => (
        <span key={v} className={cn('ccfg-chip', cls)}>
          {v}
        </span>
      ))}
      {hidden > 0 && <span className="ccfg-chip is-more">+ {hidden} more</span>}
    </div>
  );
}

export function EmptyDetail({ message = 'Select an entry from the list.' }: { message?: string }) {
  return <div className="ccfg-empty">{message}</div>;
}
