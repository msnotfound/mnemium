/** @jsxImportSource preact */
import type { SurfacedChunk } from "@shared/types";
import { render, type JSX, type VNode } from "preact";
import { useState } from "preact/hooks";

import { acceptChunk, demoChunks, dismissChunk, type InjectionContext } from "../components/rpc";
import { tokenStyle } from "../components/theme";
import { tokens } from "../tokens";

export interface InPageUIProps extends Partial<InjectionContext> {
  chunks?: SurfacedChunk[];
  onInject?: (text: string) => Promise<boolean> | boolean;
}

export function mountInPageUI(container: HTMLElement, props: InPageUIProps = {}): () => void {
  const root = container.shadowRoot ?? container.attachShadow({ mode: "open" });
  render(<InPageMemoryBlock {...props} />, root);
  return () => render(null, root);
}

function InPageMemoryBlock({ chunks = demoChunks, onInject, scopeUri, threadId, messageId }: InPageUIProps): VNode {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(chunks);
  const context: InjectionContext = {
    scopeUri: scopeUri ?? "personal::chatgpt::draft",
    threadId: threadId ?? "current-thread",
    messageId: messageId ?? "pending-message",
  };

  async function accept(item: SurfacedChunk): Promise<void> {
    await onInject?.(item.content);
    await acceptChunk(item, context);
    setItems((current) => current.filter((chunk) => chunk.memoryId !== item.memoryId));
  }

  async function dismiss(item: SurfacedChunk): Promise<void> {
    await dismissChunk(item);
    setItems((current) => current.filter((chunk) => chunk.memoryId !== item.memoryId));
  }

  return (
    <div className="mnem-inpage" style={tokenStyle as unknown as JSX.CSSProperties}>
      <style>{inPageCss}</style>
      <div className={open ? "panel is-open" : "panel"}>
        <button className="panel-header" onClick={() => setOpen((current) => !current)} type="button">
          <span className="spark" />
          <b>Memory context</b>
          <small>{items.length === 0 ? "Quiet" : "Active"}</small>
          <i>{open ? "⌄" : "⌃"}</i>
        </button>
        {open ? (
          <div className="chunk-list">
            {items.map((item, index) => (
              <article className={index === 1 ? "chunk is-active" : "chunk"} key={item.memoryId}>
                <span>
                  <b>{item.content}</b>
                  <small>from {item.sourceLabel}</small>
                </span>
                <span className="actions">
                  <button onClick={() => void accept(item)} type="button" title="Inject this chunk">
                    ✓
                  </button>
                  <button onClick={() => void dismiss(item)} type="button" title="Dismiss this chunk">
                    ✕
                  </button>
                </span>
              </article>
            ))}
          </div>
        ) : null}
      </div>
      <button className="badge" onClick={() => setOpen((current) => !current)} type="button" aria-label="Toggle Mnemium memory">
        <span />
        Memory <kbd>⌘J</kbd>
      </button>
    </div>
  );
}

const inPageCss = `
:host {
  all: initial;
}

.mnem-inpage {
  color: var(--mnem-memory);
  display: block;
  font-family: var(--mnem-font-body);
  pointer-events: auto;
  width: 100%;
}

button {
  font: inherit;
}

.panel {
  backdrop-filter: blur(20px);
  background: color-mix(in srgb, var(--mnem-text) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--mnem-bg) 6%, transparent);
  border-radius: var(--mnem-radius-lg);
  box-shadow: ${tokens.shadow.soft};
  margin: 0 0 10px;
  overflow: hidden;
  transform-origin: bottom;
  transition: opacity var(--mnem-motion-base) var(--mnem-motion-ease), transform var(--mnem-motion-base) var(--mnem-motion-ease);
}

.panel:not(.is-open) {
  opacity: 0.92;
}

.panel-header {
  align-items: center;
  background: transparent;
  border: 0;
  color: color-mix(in srgb, var(--mnem-memory) 82%, var(--mnem-bg));
  display: flex;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  text-align: left;
  width: 100%;
}

.spark,
.badge span {
  background: var(--mnem-accent);
  border-radius: var(--mnem-radius-full);
  box-shadow: 0 0 0 4px var(--mnem-accent-soft);
  height: 6px;
  width: 6px;
}

.panel-header b {
  color: color-mix(in srgb, var(--mnem-bg) 74%, var(--mnem-memory));
  flex: 0 0 auto;
  font-family: var(--mnem-font-headline);
  font-size: 13px;
  font-weight: 600;
}

.panel-header small {
  background: color-mix(in srgb, var(--mnem-memory) 18%, transparent);
  border-radius: var(--mnem-radius-sm);
  color: var(--mnem-memory);
  font-size: 11px;
  padding: 2px 6px;
}

.panel-header i {
  color: var(--mnem-memory);
  font-style: normal;
  margin-left: auto;
}

.chunk-list {
  display: flex;
  flex-direction: column;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}

.chunk {
  align-items: center;
  display: flex;
  gap: 14px;
  justify-content: space-between;
  min-height: 48px;
  padding: 9px 14px;
  position: relative;
}

.chunk:hover,
.chunk.is-active {
  background: color-mix(in srgb, var(--mnem-text) 40%, transparent);
}

.chunk.is-active::before {
  background: var(--mnem-accent);
  border-radius: 0 var(--mnem-radius-full) var(--mnem-radius-full) 0;
  bottom: 0;
  content: "";
  left: 0;
  position: absolute;
  top: 0;
  width: 3px;
}

.chunk span:first-child {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chunk b {
  color: color-mix(in srgb, var(--mnem-bg) 70%, var(--mnem-memory));
  font-size: 13px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chunk small {
  color: var(--mnem-memory);
  font-size: 11px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 5px;
  opacity: 0;
  transition: opacity var(--mnem-motion-fast) var(--mnem-motion-ease);
}

.chunk:hover .actions,
.chunk.is-active .actions {
  opacity: 1;
}

.actions button {
  align-items: center;
  background: color-mix(in srgb, var(--mnem-text) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--mnem-bg) 10%, transparent);
  border-radius: var(--mnem-radius-full);
  color: var(--mnem-memory);
  display: flex;
  height: 28px;
  justify-content: center;
  width: 28px;
}

.actions button:first-child {
  color: var(--mnem-online);
}

.badge {
  align-items: center;
  background: color-mix(in srgb, var(--mnem-text) 76%, transparent);
  border: 1px solid color-mix(in srgb, var(--mnem-bg) 8%, transparent);
  border-radius: var(--mnem-radius-full);
  color: color-mix(in srgb, var(--mnem-bg) 62%, var(--mnem-memory));
  display: inline-flex;
  float: right;
  font-size: 12px;
  font-weight: 650;
  gap: 7px;
  padding: 6px 10px;
}

.badge kbd {
  color: var(--mnem-memory);
  font: 10px var(--mnem-font-mono);
}
`;
