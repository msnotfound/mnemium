import type { Memory, MemoryType } from "@shared/types";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { memoryTypeVar, tokenStyle } from "./theme";

export function SurfaceRoot({ children, className = "" }: { children: ReactNode; className?: string }): ReactElement {
  return (
    <div className={`mnem-ui mnem-shell ${className}`} style={tokenStyle}>
      {children}
    </div>
  );
}

export function BrandHeader({
  title = "Mnemium",
  count,
  action,
}: {
  title?: string;
  count?: number;
  action?: ReactNode;
}): ReactElement {
  return (
    <header className="mnem-topbar">
      <div className="mnem-brand">
        <span className="mnem-brand-mark">◍</span>
        <span className="mnem-headline mnem-brand-title">{title}</span>
      </div>
      <div className="mnem-status">
        <span className="mnem-status-dot" />
        <span className="mnem-mono">{count === undefined ? "Local" : `Local · ${count.toLocaleString()} memories`}</span>
        {action}
      </div>
    </header>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = "Search your memory...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}): ReactElement {
  return (
    <label className="mnem-search">
      <span aria-hidden="true">⌕</span>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={placeholder} type="search" />
    </label>
  );
}

export function TypeTag({ type, subtle = false }: { type: MemoryType; subtle?: boolean }): ReactElement {
  const style = { "--mnem-tag": memoryTypeVar[type] } as CSSProperties & Record<"--mnem-tag", string>;
  return (
    <span className={subtle ? "mnem-type-tag mnem-type-tag-subtle" : "mnem-type-tag"} style={style}>
      {type.toUpperCase()}
    </span>
  );
}

export function MemoryRow({
  memory,
  source,
  onDelete,
  active = false,
}: {
  memory: Memory;
  source: string;
  onDelete?: (memoryId: string) => void;
  active?: boolean;
}): ReactElement {
  return (
    <article className={active ? "mnem-memory-row is-active" : "mnem-memory-row"}>
      <div className="mnem-memory-copy">
        <p>{memory.content}</p>
        <div className="mnem-memory-meta">
          <TypeTag type={memory.type} />
          <span className="mnem-mono">{source}</span>
        </div>
      </div>
      {onDelete === undefined ? null : (
        <button className="mnem-delete" onClick={() => onDelete(memory.id)} type="button" aria-label={`Delete ${memory.content}`}>
          ×
        </button>
      )}
    </article>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}): ReactElement {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={checked ? "mnem-toggle is-on" : "mnem-toggle"}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <span className="mnem-kbd">{children}</span>;
}
