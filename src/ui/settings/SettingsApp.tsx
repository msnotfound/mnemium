import type { Config } from "@shared/config";
import { DEFAULT_CONFIG } from "@shared/config";
import type { Provider } from "@shared/types";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";

import { SurfaceRoot, Toggle } from "../components/Primitives";
import { exportVault, getSettings, updateSettings } from "../components/rpc";
import "./settings.css";

type Tab = "memory" | "connections" | "privacy" | "system";

const tabs: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "memory", label: "Memory", icon: "◍" },
  { id: "connections", label: "Connections", icon: "↔" },
  { id: "privacy", label: "Privacy", icon: "◉" },
  { id: "system", label: "System", icon: "⚙" },
];

const providers: Array<{ id: Provider; label: string; icon: string }> = [
  { id: "chatgpt", label: "ChatGPT", icon: "◇" },
  { id: "claude", label: "Claude", icon: "✦" },
  { id: "gemini", label: "Gemini", icon: "✧" },
  { id: "grok", label: "Grok", icon: "◎" },
  { id: "deepseek", label: "DeepSeek", icon: "▣" },
];

export function SettingsApp(): ReactElement {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<Tab>("memory");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void getSettings()
      .then((saved) => {
        if (alive && saved !== undefined) setConfig(saved);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

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
            <p>Private second brain</p>
          </div>
        </header>
        {tabs.map((tab) => (
          <button
            type="button"
            className={`mnem-settings-tab ${activeTab === tab.id ? "is-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            key={tab.id}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </aside>
      <main className="mnem-settings-main">
        {!loaded ? <p className="mnem-settings-loading">Loading…</p> : null}
        {activeTab === "memory" ? <MemoryTab config={config} setModel={setModel} patch={patch} /> : null}
        {activeTab === "connections" ? <ConnectionsTab config={config} setSite={setSite} /> : null}
        {activeTab === "privacy" ? <PrivacyTab /> : null}
        {activeTab === "system" ? <SystemTab config={config} patch={patch} /> : null}
      </main>
    </SurfaceRoot>
  );
}

interface MemoryTabProps {
  config: Config;
  setModel: (kind: Config["memoryModel"]["kind"]) => void;
  patch: (next: Partial<Config>) => void;
}

function MemoryTab({ config, setModel, patch }: MemoryTabProps): ReactElement {
  return (
    <TabPanel
      title="Memory"
      subtitle="Engine, embeddings, and how relevant context surfaces while you type."
    >
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
    </TabPanel>
  );
}

interface ConnectionsTabProps {
  config: Config;
  setSite: (provider: Provider, enabled: boolean) => void;
}

function ConnectionsTab({ config, setSite }: ConnectionsTabProps): ReactElement {
  return (
    <TabPanel
      title="Connections"
      subtitle="Web applications where Mnemium is permitted to read and inject context."
    >
      <section className="mnem-setting-card mnem-sites">
        <h3>Active Integrations</h3>
        <p>Toggle which AI chats Mnemium captures and injects into.</p>
        {providers.map((provider) => (
          <div className="mnem-site-row" key={provider.id}>
            <span className="mnem-site-icon">{provider.icon}</span>
            <b>{provider.label}</b>
            <Toggle
              checked={config.sites[provider.id]}
              label={`${provider.label} integration`}
              onChange={(enabled) => setSite(provider.id, enabled)}
            />
          </div>
        ))}
      </section>
    </TabPanel>
  );
}

function PrivacyTab(): ReactElement {
  return (
    <TabPanel
      title="Privacy"
      subtitle="Your memory lives only on this device. Manage the raw SQLite vault here."
    >
      <section className="mnem-setting-card mnem-data">
        <div>
          <h3>Data Management</h3>
          <p>Export a portable backup or clear all stored memories.</p>
        </div>
        <button type="button" onClick={() => void exportVault()}>
          ⇩ Export backup (.sqlite)
        </button>
        <a href="#clear">Clear all memory</a>
      </section>
      <section className="mnem-setting-card">
        <h3>What stays local</h3>
        <p>
          All captures, embeddings, memories, and the model itself run inside your browser. No
          network calls except to load the model on first use and to talk to your selected
          provider (only if you chose a non-built-in compute engine).
        </p>
      </section>
    </TabPanel>
  );
}

interface SystemTabProps {
  config: Config;
  patch: (next: Partial<Config>) => void;
}

function SystemTab({ config, patch }: SystemTabProps): ReactElement {
  return (
    <TabPanel
      title="System"
      subtitle="Diagnostics, hotkey, and appearance."
    >
      <section className="mnem-setting-card mnem-setting-row">
        <div>
          <h3>Theme</h3>
          <p>UI appearance.</p>
        </div>
        <select
          value={config.theme}
          onChange={(event) => patch({ theme: event.currentTarget.value as Config["theme"] })}
          aria-label="Theme"
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </section>
      <section className="mnem-setting-card mnem-setting-row">
        <div>
          <h3>Pull-memory hotkey</h3>
          <p>
            Change at <code>chrome://extensions/shortcuts</code> if the built-in default is taken
            by your browser.
          </p>
        </div>
        <code className="mnem-mono">{config.hotkey}</code>
      </section>
    </TabPanel>
  );
}

interface TabPanelProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

function TabPanel({ title, subtitle, children }: TabPanelProps): ReactElement {
  return (
    <>
      <header className="mnem-settings-title">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      {children}
    </>
  );
}
