import type { Memory } from "@shared/types";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { BrandHeader, MemoryRow, SearchField, SurfaceRoot, TypeTag } from "../components/Primitives";
import { demoLedger, listMemories, sourceLabel } from "../components/rpc";
import { OnboardingApp } from "../onboarding/OnboardingApp";
import { SettingsApp } from "../settings/SettingsApp";
import "./sidepanel.css";

type Tab = "memories" | "ledger";

export function SidePanelApp(): ReactElement {
  const route = new URLSearchParams(globalThis.location.search).get("route");
  if (route === "settings") return <SettingsApp />;
  if (route === "onboarding") return <OnboardingApp />;
  return <TrustPanel />;
}

function TrustPanel(): ReactElement {
  const [tab, setTab] = useState<Tab>("ledger");
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);

  useEffect(() => {
    let alive = true;
    void listMemories(undefined, 30).then((items) => {
      if (alive) setMemories(items);
    });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = memories.filter((memory) => memory.content.toLowerCase().includes(query.toLowerCase()));

  return (
    <SurfaceRoot className="mnem-sidepanel">
      <BrandHeader action={<a href="/sidepanel.html?route=settings">⚙</a>} />
      <nav className="mnem-tabs" aria-label="Trust UI">
        <button className={tab === "memories" ? "is-active" : ""} onClick={() => setTab("memories")} type="button">
          Memories
        </button>
        <button className={tab === "ledger" ? "is-active" : ""} onClick={() => setTab("ledger")} type="button">
          Ledger
        </button>
        <p>Audit trail — every memory injected, and where.</p>
      </nav>
      {tab === "memories" ? (
        <main className="mnem-panel-body">
          <SearchField value={query} onChange={setQuery} />
          <div className="mnem-side-list">
            {filtered.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} source={sourceLabel(memory.scopeUri, memory.createdAt)} />
            ))}
          </div>
        </main>
      ) : (
        <LedgerTimeline />
      )}
    </SurfaceRoot>
  );
}

function LedgerTimeline(): ReactElement {
  return (
    <main className="mnem-ledger" aria-label="Ledger timeline">
      <div className="mnem-ledger-line" />
      {demoLedger.map((entry, index) => (
        <section className="mnem-ledger-group" key={entry.id}>
          {index === 0 || demoLedger[index - 1]?.threadId !== entry.threadId ? (
            <header className="mnem-ledger-thread">
              <span>{entry.source.slice(0, 3).toUpperCase()}</span>
              <h3>
                {entry.source} <b>·</b> “{entry.threadTitle}”
              </h3>
            </header>
          ) : null}
          <article className={index === 1 ? "mnem-ledger-card is-active" : "mnem-ledger-card"}>
            <p>{entry.content}</p>
            <footer>
              <span>
                <TypeTag type={entry.type} subtle={index !== 1} />
                <time className="mnem-mono">{new Date(entry.injectedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </span>
              <a href={`#${entry.messageId}`}>Jump to message ↗</a>
            </footer>
          </article>
        </section>
      ))}
    </main>
  );
}
