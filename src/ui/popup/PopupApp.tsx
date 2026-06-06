import type { Memory } from "@shared/types";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { BrandHeader, MemoryRow, SearchField, SurfaceRoot } from "../components/Primitives";
import { deleteMemory, exportVault, listMemories, searchMemories, sourceLabel } from "../components/rpc";
import "./popup.css";

export function PopupApp(): ReactElement {
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);

  useEffect(() => {
    let alive = true;
    const load = query.trim().length === 0 ? listMemories(undefined, 8) : searchMemories(query);
    void load.then((items) => {
      if (alive) setMemories(items);
    });
    return () => {
      alive = false;
    };
  }, [query]);

  const visibleMemories = useMemo(() => memories.slice(0, 8), [memories]);

  async function handleDelete(memoryId: string): Promise<void> {
    await deleteMemory(memoryId);
    setMemories((items) => items.filter((item) => item.id !== memoryId));
  }

  return (
    <SurfaceRoot className="mnem-popup">
      <BrandHeader count={1240} />
      <main className="mnem-popup-main">
        <SearchField value={query} onChange={setQuery} />
        <section className="mnem-popup-section" aria-label="Recent memories">
          <h2>Recent</h2>
          <div className="mnem-popup-list">
            {visibleMemories.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} source={sourceLabel(memory.scopeUri, memory.createdAt)} onDelete={handleDelete} />
            ))}
          </div>
        </section>
      </main>
      <footer className="mnem-popup-footer">
        <span className="mnem-mono">Local storage: 12MB</span>
        <button type="button" onClick={() => void exportVault()}>
          Export backup
        </button>
        <a href="/sidepanel.html?route=settings" aria-label="Open settings">
          ⚙
        </a>
      </footer>
    </SurfaceRoot>
  );
}
