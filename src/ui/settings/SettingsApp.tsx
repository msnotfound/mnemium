import type { Config } from "@shared/config";
import { DEFAULT_CONFIG } from "@shared/config";
import type { Provider } from "@shared/types";
import type { ReactElement } from "react";
import { useState } from "react";

import { SurfaceRoot, Toggle } from "../components/Primitives";
import { exportVault, updateSettings } from "../components/rpc";
import "./settings.css";

const providers: Array<{ id: Provider; label: string; icon: string }> = [
  { id: "chatgpt", label: "ChatGPT", icon: "◇" },
  { id: "claude", label: "Claude", icon: "✦" },
  { id: "gemini", label: "Gemini", icon: "✧" },
  { id: "grok", label: "Grok", icon: "◎" },
  { id: "deepseek", label: "DeepSeek", icon: "▣" },
];

export function SettingsApp(): ReactElement {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  function patch(nextPatch: Partial<Config>): void {
    setConfig((current) => ({ ...current, ...nextPatch }));
    void updateSettings(nextPatch);
  }

  function setModel(kind: Config["memoryModel"]["kind"]): void {
    const memoryModel: Config["memoryModel"] =
      kind === "bundled"
        ? { kind, model: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC" }
        : kind === "localServer"
          ? { kind, endpoint: "http://localhost:11434", model: "llama3.2" }
          : { kind, provider: "openrouter", apiKey: "", model: "openrouter/auto" };
    patch({ memoryModel });
  }

  function setSite(provider: Provider, enabled: boolean): void {
    patch({ sites: { ...config.sites, [provider]: enabled } });
  }

  return (
    <SurfaceRoot className="mnem-settings">
      <aside className="mnem-settings-nav">
        <header>
          <span>◍</span>
          <div>
            <h1>Mnemium</h1>
            <p>Private Intelligence</p>
          </div>
        </header>
        {["Memory", "Connections", "Privacy", "System"].map((item) => (
          <a className={item === "System" ? "is-active" : ""} href={`#${item.toLowerCase()}`} key={item}>
            <span>{item === "System" ? "⚙" : "•"}</span>
            {item}
          </a>
        ))}
      </aside>
      <main className="mnem-settings-main">
        <header className="mnem-settings-title">
          <h2>System Configuration</h2>
          <p>Manage underlying models, injection rules, and local data persistence.</p>
        </header>
        <section className="mnem-setting-card">
          <div className="mnem-card-heading">
            <div>
              <h3>Compute Engine</h3>
              <p>Select the primary language model powering intelligence.</p>
            </div>
            <span>Active</span>
          </div>
          <div className="mnem-segmented">
            <button className={config.memoryModel.kind === "bundled" ? "is-active" : ""} onClick={() => setModel("bundled")} type="button">
              <i /> Built-in <small>(on-device)</small>
            </button>
            <button className={config.memoryModel.kind === "localServer" ? "is-active" : ""} onClick={() => setModel("localServer")} type="button">
              Local server <small>(Ollama)</small>
            </button>
            <button className={config.memoryModel.kind === "apiKey" ? "is-active" : ""} onClick={() => setModel("apiKey")} type="button">
              BYO-key
            </button>
          </div>
          <p className="mnem-note">Runs fully offline in built-in mode. Downloaded once and kept local.</p>
        </section>
        <section className="mnem-setting-card mnem-setting-row">
          <div>
            <h3>Embedding Space</h3>
            <p>Determines how memories are vectorized and retrieved.</p>
          </div>
          <select
            value={config.embedder.id}
            onChange={(event) => patch({ embedder: { id: event.currentTarget.value } })}
            aria-label="Embedding model"
          >
            <option value="bge-small-en-v1.5">bge-small-en</option>
            <option value="nomic-embed-text">nomic-embed-text</option>
            <option value="all-MiniLM-L6-v2">all-MiniLM-L6-v2</option>
          </select>
          <p className="mnem-warning">Changing this re-indexes your entire memory database in the background.</p>
        </section>
        <section className="mnem-setting-card">
          <div className="mnem-card-heading">
            <div>
              <h3>Context Auto-injection</h3>
              <p>Surface relevant memory automatically as you type in host apps.</p>
            </div>
            <Toggle
              checked={config.autoInject.enabled}
              label="Context auto-injection"
              onChange={(enabled) => patch({ autoInject: { ...config.autoInject, enabled } })}
            />
          </div>
          <div className={config.autoInject.enabled ? "mnem-slider" : "mnem-slider is-disabled"}>
            <label>
              <span>Injection Sensitivity</span>
              <output>{config.autoInject.sensitivity.toFixed(2)}</output>
            </label>
            <input
              disabled={!config.autoInject.enabled}
              max="1"
              min="0"
              step="0.05"
              type="range"
              value={config.autoInject.sensitivity}
              onChange={(event) =>
                patch({ autoInject: { ...config.autoInject, sensitivity: Number.parseFloat(event.currentTarget.value) } })
              }
            />
            <div>
              <span>Precise (Fewer)</span>
              <span>Broad (More)</span>
            </div>
          </div>
        </section>
        <section className="mnem-setting-card mnem-sites">
          <h3>Active Integrations</h3>
          <p>Web applications where Mnemium is permitted to read and inject context.</p>
          {providers.map((provider) => (
            <div className="mnem-site-row" key={provider.id}>
              <span className="mnem-site-icon">{provider.icon}</span>
              <b>{provider.label}</b>
              <Toggle checked={config.sites[provider.id]} label={`${provider.label} integration`} onChange={(enabled) => setSite(provider.id, enabled)} />
            </div>
          ))}
        </section>
        <section className="mnem-setting-card mnem-data">
          <div>
            <h3>Data Management</h3>
            <p>Your memory resides strictly locally. Manage the raw SQLite vault.</p>
          </div>
          <button type="button" onClick={() => void exportVault()}>
            ⇩ Export backup (.sqlite)
          </button>
          <a href="#clear">Clear all memory</a>
        </section>
      </main>
    </SurfaceRoot>
  );
}
