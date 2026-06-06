import type { Memory } from "@shared/types";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { Kbd, SurfaceRoot, TypeTag } from "../components/Primitives";
import { acceptChunk, listMemories, sourceLabel } from "../components/rpc";
import "./palette.css";

export interface CommandPaletteProps {
  open?: boolean;
  onClose?: () => void;
}

export function CommandPalette({ open = true, onClose }: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = useState("typescript");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    void listMemories(undefined, 12).then((items) => {
      if (alive) setMemories(items);
    });
    return () => {
      alive = false;
    };
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return memories;
    return memories.filter((memory) => memory.content.toLowerCase().includes(needle));
  }, [memories, query]);

  if (!open) return null;

  function inject(memory: Memory): void {
    void acceptChunk(
      {
        memoryId: memory.id,
        content: memory.content,
        type: memory.type,
        sourceLabel: sourceLabel(memory.scopeUri, memory.createdAt),
        score: memory.confidence,
      },
      { scopeUri: memory.scopeUri, threadId: "palette", messageId: "manual-inject" },
    );
  }

  return (
    <SurfaceRoot className="mnem-palette-host">
      <div className="mnem-palette-backdrop" onClick={onClose} />
      <section className="mnem-palette" role="dialog" aria-modal="true" aria-label="Command Palette">
        <header>
          <span>✦</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose?.();
              if (event.key === "ArrowDown") setActive((current) => Math.min(current + 1, results.length - 1));
              if (event.key === "ArrowUp") setActive((current) => Math.max(current - 1, 0));
              if (event.key === "Enter" && results[active] !== undefined) inject(results[active]);
            }}
            placeholder="Search memories, contexts, or tasks..."
          />
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </header>
        <div className="mnem-results" role="listbox">
          {results.map((memory, index) => (
            <button
              aria-selected={index === active}
              className={index === active ? "is-active" : ""}
              key={memory.id}
              onClick={() => inject(memory)}
              onMouseEnter={() => setActive(index)}
              role="option"
              type="button"
            >
              <span className="mnem-result-icon">{memory.type === "task" ? "✓" : "◍"}</span>
              <span className="mnem-result-copy">
                <b>{memory.content}</b>
                <small>
                  <TypeTag type={memory.type} />
                  <i>{sourceLabel(memory.scopeUri, memory.createdAt)}</i>
                </small>
              </span>
              <span className="mnem-result-action">
                inject <Kbd>↵</Kbd>
              </span>
            </button>
          ))}
        </div>
        <footer>
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> inject
          </span>
          <span>
            <Kbd>ESC</Kbd> close
          </span>
          <b>Mnemium</b>
        </footer>
      </section>
    </SurfaceRoot>
  );
}
