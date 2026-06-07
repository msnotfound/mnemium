import type { ApiKeyTarget, Config, DistillKind, EmbedKind, VecKind } from "@shared/config";
import { DEFAULT_CONFIG, mergeConfig } from "@shared/config";
import type { Provider } from "@shared/types";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";

import { SurfaceRoot, Toggle } from "../components/Primitives";
import type { DaemonStatusEnvelope } from "../components/rpc";
import { exportVault, getDaemonStatus, getSettings, parsePairingString, updateSettings } from "../components/rpc";
import {
  daemonStatusSummary,
  DISTILL_API_KEY_DEFAULT,
  DISTILL_OLLAMA_DEFAULT,
  distillBackendForKind,
  EMBED_API_KEY_DEFAULT,
  EMBED_OLLAMA_DEFAULT,
  embedBackendForKind,
  isPaired,
  vecBackendForKind,
} from "./backendSettings";
import "./settings.css";

type Tab = "memory" | "connections" | "privacy" | "system";
type SettingsPatch = Omit<Partial<Config>, "backends"> & {
  backends?: Partial<Config["backends"]>;
};

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

  function patch(nextPatch: SettingsPatch): void {
    const normalizedPatch = normalizePatch(nextPatch);
    setConfig((current) => mergeConfig(current, normalizedPatch as Partial<Config>));
    void updateSettings(normalizedPatch as Partial<Config>);
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
        {activeTab === "memory" ? <MemoryTab config={config} patch={patch} /> : null}
        {activeTab === "connections" ? <ConnectionsTab config={config} setSite={setSite} /> : null}
        {activeTab === "privacy" ? <PrivacyTab /> : null}
        {activeTab === "system" ? <SystemTab config={config} patch={patch} /> : null}
      </main>
    </SurfaceRoot>
  );
}

interface MemoryTabProps {
  config: Config;
  patch: (next: SettingsPatch) => void;
}

function MemoryTab({ config, patch }: MemoryTabProps): ReactElement {
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatusEnvelope | null>(null);
  const daemonSummary = daemonStatusSummary(daemonStatus);

  useEffect(() => {
    let alive = true;
    async function refresh(): Promise<void> {
      const next = await getDaemonStatus();
      if (alive) setDaemonStatus(next);
    }

    void refresh();
    const intervalId = window.setInterval(() => void refresh(), 30000);
    return () => {
      alive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <TabPanel
      title={
        <span className="mnem-title-with-status">
          Memory
          <span className={`mnem-daemon-dot is-${daemonSummary.tone}`} aria-label={`Daemon status: ${daemonSummary.label}`} />
        </span>
      }
      subtitle="Compute backends, embeddings, and how relevant context surfaces while you type."
    >
      <DistillBackendSection config={config} daemonSummary={daemonSummary} patch={patch} />
      <EmbedBackendSection config={config} patch={patch} />
      <VecBackendSection config={config} patch={patch} />
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
  patch: (next: SettingsPatch) => void;
}

function SystemTab({ config, patch }: SystemTabProps): ReactElement {
  const [pairingString, setPairingString] = useState("");
  const [pairingMessage, setPairingMessage] = useState<"paired" | "invalid" | null>(null);
  const paired = isPaired(config.daemon);

  function pairDaemon(): void {
    const pairing = parsePairingString(pairingString);
    if (pairing === null) {
      setPairingMessage("invalid");
      return;
    }
    patch({ daemon: pairing });
    setPairingString("");
    setPairingMessage("paired");
  }

  return (
    <TabPanel
      title="System"
      subtitle="Diagnostics, hotkey, and appearance."
    >
      <section className="mnem-setting-card mnem-daemon-pairing">
        <div className="mnem-card-heading">
          <div>
            <h3>Daemon pairing</h3>
            <p>Connect this extension to the local mnemiumd helper.</p>
          </div>
        </div>
        {paired ? (
          <div className="mnem-pairing-state">
            <span>
              Paired with localhost:<code className="mnem-mono">{config.daemon.port}</code>
            </span>
            <button type="button" onClick={() => patch({ daemon: {} })}>
              Unpair
            </button>
          </div>
        ) : (
          <div className="mnem-field-stack">
            <label className="mnem-field">
              <span>Pairing string</span>
              <textarea
                value={pairingString}
                onChange={(event) => {
                  setPairingString(event.currentTarget.value);
                  setPairingMessage(null);
                }}
                placeholder="mn:8442:token"
                rows={3}
              />
            </label>
            <div className="mnem-pairing-actions">
              <button type="button" onClick={pairDaemon}>
                Pair
              </button>
              {pairingMessage === "paired" ? <span className="mnem-inline-success">Paired</span> : null}
              {pairingMessage === "invalid" ? <span className="mnem-inline-error">Invalid pairing string</span> : null}
            </div>
          </div>
        )}
      </section>
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
  title: ReactNode;
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

interface BackendSectionProps {
  config: Config;
  patch: (next: SettingsPatch) => void;
}

function DistillBackendSection({
  config,
  daemonSummary,
  patch,
}: BackendSectionProps & { daemonSummary: ReturnType<typeof daemonStatusSummary> }): ReactElement {
  const backend = config.backends.distill;
  const ollama = backend.ollama ?? DISTILL_OLLAMA_DEFAULT;
  const apiKey = backend.apiKey ?? DISTILL_API_KEY_DEFAULT;

  function setKind(kind: DistillKind): void {
    patch({ backends: { distill: distillBackendForKind(backend, kind) } });
  }

  function setOllama(next: Partial<typeof ollama>): void {
    patch({ backends: { distill: { kind: "ollama", ollama: { ...ollama, ...next } } } });
  }

  function setApiKey(next: Partial<ApiKeyTarget>): void {
    patch({ backends: { distill: { kind: "apiKey", apiKey: { ...apiKey, ...next } } } });
  }

  return (
    <section className="mnem-setting-card mnem-backend-card">
      <div className="mnem-card-heading">
        <div>
          <h3>Distillation backend</h3>
          <p>Turns captured conversations into structured memories.</p>
        </div>
      </div>
      <SegmentedControl
        value={backend.kind}
        options={[
          { value: "daemon", label: "Daemon" },
          { value: "ollama", label: "Ollama" },
          { value: "apiKey", label: "API key" },
          { value: "disabled", label: "Disabled" },
        ]}
        onChange={setKind}
      />
      {backend.kind === "daemon" ? <StatusLine summary={daemonSummary} /> : null}
      {backend.kind === "ollama" ? (
        <div className="mnem-field-grid">
          <TextField label="Endpoint" value={ollama.endpoint} onChange={(endpoint) => setOllama({ endpoint })} />
          <TextField label="Model" value={ollama.model} onChange={(model) => setOllama({ model })} />
        </div>
      ) : null}
      {backend.kind === "apiKey" ? (
        <div className="mnem-field-grid">
          <SelectField
            label="Provider"
            value={apiKey.provider}
            options={[
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
              { value: "openrouter", label: "OpenRouter" },
            ]}
            onChange={(provider) => setApiKey({ provider })}
          />
          <TextField label="API key" type="password" value={apiKey.apiKey} onChange={(apiKeyValue) => setApiKey({ apiKey: apiKeyValue })} />
          <TextField label="Model" value={apiKey.model} onChange={(model) => setApiKey({ model })} />
        </div>
      ) : null}
    </section>
  );
}

function EmbedBackendSection({ config, patch }: BackendSectionProps): ReactElement {
  const backend = config.backends.embed;
  const ollama = backend.ollama ?? EMBED_OLLAMA_DEFAULT;
  const apiKey = backend.apiKey ?? EMBED_API_KEY_DEFAULT;

  function setKind(kind: EmbedKind): void {
    patch({ backends: { embed: embedBackendForKind(backend, kind) } });
  }

  function setOllama(next: Partial<typeof ollama>): void {
    patch({ backends: { embed: { kind: "ollama", ollama: { ...ollama, ...next } } } });
  }

  function setApiKey(next: Partial<typeof apiKey>): void {
    patch({ backends: { embed: { kind: "apiKey", apiKey: { ...apiKey, ...next } } } });
  }

  return (
    <section className="mnem-setting-card mnem-backend-card">
      <div className="mnem-card-heading">
        <div>
          <h3>Embedding backend</h3>
          <p>Converts memories and queries into vectors for retrieval.</p>
        </div>
      </div>
      <SegmentedControl
        value={backend.kind}
        options={[
          { value: "daemon", label: "Daemon" },
          { value: "ollama", label: "Ollama" },
          { value: "apiKey", label: "API key" },
          { value: "disabled", label: "Disabled" },
        ]}
        onChange={setKind}
      />
      {backend.kind === "ollama" ? (
        <div className="mnem-field-grid">
          <TextField label="Endpoint" value={ollama.endpoint} onChange={(endpoint) => setOllama({ endpoint })} />
          <TextField label="Model" value={ollama.model} onChange={(model) => setOllama({ model })} />
        </div>
      ) : null}
      {backend.kind === "apiKey" ? (
        <div className="mnem-field-grid">
          <SelectField
            label="Provider"
            value={apiKey.provider}
            options={[{ value: "openai", label: "OpenAI" }]}
            onChange={(provider) => setApiKey({ provider })}
          />
          <TextField label="API key" type="password" value={apiKey.apiKey} onChange={(apiKeyValue) => setApiKey({ apiKey: apiKeyValue })} />
          <TextField label="Model" value={apiKey.model} onChange={(model) => setApiKey({ model })} />
        </div>
      ) : null}
    </section>
  );
}

function VecBackendSection({ config, patch }: BackendSectionProps): ReactElement {
  const backend = config.backends.vec;
  return (
    <section className="mnem-setting-card mnem-backend-card">
      <div className="mnem-card-heading">
        <div>
          <h3>Vector store</h3>
          <p>Stores and searches memory embeddings.</p>
        </div>
      </div>
      <SegmentedControl
        value={backend.kind}
        options={[
          { value: "daemon", label: "Daemon" },
          { value: "edgevec", label: "EdgeVec (in-browser)" },
          { value: "disabled", label: "Disabled" },
        ]}
        onChange={(kind) => patch({ backends: { vec: vecBackendForKind(kind) } })}
      />
    </section>
  );
}

function StatusLine({ summary }: { summary: ReturnType<typeof daemonStatusSummary> }): ReactElement {
  return (
    <p className={`mnem-status-line is-${summary.tone}`}>
      <span className={`mnem-daemon-dot is-${summary.tone}`} />
      {summary.label}
    </p>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): ReactElement {
  return (
    <div className="mnem-segmented" role="group">
      {options.map((option) => (
        <button
          type="button"
          className={option.value === value ? "is-active" : ""}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TextField({
  label,
  value,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  type?: "password" | "text";
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="mnem-field">
      <span>{label}</span>
      <input value={value} type={type} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): ReactElement {
  return (
    <label className="mnem-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value as T)}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function normalizePatch(nextPatch: SettingsPatch): SettingsPatch {
  if (nextPatch.daemon !== undefined && Object.keys(nextPatch.daemon).length === 0) {
    return { ...nextPatch, daemon: { port: undefined, token: undefined } };
  }
  return nextPatch;
}
