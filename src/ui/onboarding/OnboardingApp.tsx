import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import { findModel, KNOWN_MODELS } from "@shared/model-registry";

import { SurfaceRoot } from "../components/Primitives";
import {
  ensureRuntime,
  getDaemonStatus,
  getModelProgress,
  parsePairingString,
  putDaemonConfig,
  startModelDownload,
  updateSettings,
  type DaemonProgressEntry,
} from "../components/rpc";
import "./onboarding.css";

const providers = ["ChatGPT", "Claude", "Gemini", "Grok", "DeepSeek"] as const;
const shellInstall = "curl -fsSL https://raw.githubusercontent.com/msnotfound/mnemium/main/scripts/install.sh | sh";
const windowsInstall = "irm https://raw.githubusercontent.com/msnotfound/mnemium/main/scripts/install.ps1 | iex";
const serveCommand = "mnemiumd serve";

type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;
type InstallTab = "unix" | "windows";
type DetectState = "idle" | "loading" | "paired-offline" | "unpaired" | "error";

interface ModelChoice {
  id: string;
  title: string;
  summary: string;
  distillName: string;
  distillSize: string;
  embedName: string;
  embedSize: string;
}

// Pull display labels and sizes off the model registry so onboarding and
// Settings can never drift on what's actually fetchable.
function distill(name: string): { name: string; size: string } {
  const m = findModel(name);
  return { name, size: m ? formatBytes(m.sizeBytes) : "?" };
}

const recommendedDistill = KNOWN_MODELS.find((m) => m.kind === "distill")?.name ?? "";
const qualityDistill = KNOWN_MODELS.filter((m) => m.kind === "distill")[1]?.name ?? recommendedDistill;
const recommendedEmbed = KNOWN_MODELS.find((m) => m.kind === "embed")?.name ?? "";

const modelChoices: ModelChoice[] = [
  {
    id: "recommended",
    title: "Recommended",
    summary: "Smallest workable models — fast distillation + good retrieval",
    distillName: distill(recommendedDistill).name,
    distillSize: distill(recommendedDistill).size,
    embedName: distill(recommendedEmbed).name,
    embedSize: distill(recommendedEmbed).size,
  },
  {
    id: "quality",
    title: "Higher quality",
    summary: "Slower, denser distillation. Same embedder.",
    distillName: distill(qualityDistill).name,
    distillSize: distill(qualityDistill).size,
    embedName: distill(recommendedEmbed).name,
    embedSize: distill(recommendedEmbed).size,
  },
];

function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)} MB`;
  return `${Math.round(n / 1_000)} KB`;
}

export function OnboardingApp(): ReactElement {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [detectAttempt, setDetectAttempt] = useState(0);
  const [detectState, setDetectState] = useState<DetectState>("idle");
  const [detectError, setDetectError] = useState("");
  const [installTab, setInstallTab] = useState<InstallTab>("unix");
  const [pairingString, setPairingString] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [progressError, setProgressError] = useState("");
  const [activeDownloads, setActiveDownloads] = useState<string[]>([]);
  const [progressEntries, setProgressEntries] = useState<DaemonProgressEntry[]>([]);

  const activeProgress = useMemo(() => {
    const byName = new Map(progressEntries.map((entry) => [entry.name, entry]));
    return activeDownloads.map((name) => ({ name, entry: byName.get(name) }));
  }, [activeDownloads, progressEntries]);

  useEffect(() => {
    if (step !== 2) return;

    let cancelled = false;
    setDetectState("loading");
    setDetectError("");

    const check = async (): Promise<void> => {
      const startedAt = Date.now();
      try {
        const envelope = await getDaemonStatus();
        await waitAtLeast(startedAt, 1000);
        if (cancelled) return;

        if (envelope.reachable) {
          setStep(4);
          return;
        }
        if (envelope.paired) {
          setDetectState("paired-offline");
          return;
        }
        setDetectState("unpaired");
        setStep(3);
      } catch (error) {
        await waitAtLeast(startedAt, 1000);
        if (cancelled) return;
        setDetectError(error instanceof Error ? error.message : "Unable to check daemon status.");
        setDetectState("error");
      }
    };

    void check();

    return () => {
      cancelled = true;
    };
  }, [detectAttempt, step]);

  useEffect(() => {
    if (step !== 5 || activeDownloads.length === 0) return;

    let cancelled = false;

    const poll = async (): Promise<void> => {
      const envelope = await getModelProgress();
      if (cancelled) return;
      if (!envelope.ok) {
        setProgressError(envelope.error ?? "Could not read download progress.");
        return;
      }
      const downloads = envelope.downloads ?? [];
      setProgressError("");
      setProgressEntries(downloads);

      const allFinished = activeDownloads.every((name) => {
        const entry = downloads.find((download) => download.name === name);
        return entry === undefined || entry.status === "done";
      });

      if (allFinished) {
        setStep(6);
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeDownloads, step]);

  async function retryDaemonStatus(): Promise<void> {
    setStep(2);
    setDetectState("loading");
    setDetectAttempt((attempt) => attempt + 1);
  }

  async function pairDaemon(): Promise<void> {
    const parsed = parsePairingString(pairingString);
    if (parsed === null) {
      setPairingError("Invalid pairing string.");
      return;
    }

    setIsPairing(true);
    setPairingError("");
    try {
      await updateSettings({ daemon: { port: parsed.port, token: parsed.token } });
      const envelope = await getDaemonStatus();
      if (envelope.reachable) {
        setStep(4);
        return;
      }
      setPairingError("Daemon paired but unreachable — make sure `mnemiumd serve` is running.");
    } catch (error) {
      setPairingError(error instanceof Error ? error.message : "Could not pair with the daemon.");
    } finally {
      setIsPairing(false);
    }
  }

  async function copyCommand(command: string): Promise<void> {
    await navigator.clipboard.writeText(command);
  }

  async function startDownloads(choice: ModelChoice): Promise<void> {
    setDownloadError("");

    try {
      // 1) Persist the extension's backend selection — "daemon" means
      //    distill / embed / vec are all proxied through mnemiumd. The
      //    daemon owns the actual model name (set in step 2).
      await updateSettings({
        backends: {
          distill: { kind: "daemon" },
          embed:   { kind: "daemon" },
          vec:     { kind: "daemon" },
        },
      });

      // 2) Configure mnemiumd itself — its *internal* backends are
      //    llama-cpp (default) + the sqlite vec store.
      const daemonPatch = {
        backends: {
          distill: { kind: "llama-cpp", model: choice.distillName },
          embed:   { kind: "llama-cpp", model: choice.embedName },
          vec:     { kind: "sqlite" },
        },
      };
      const cfgResult = await putDaemonConfig(daemonPatch);
      if (!cfgResult.ok) {
        throw new Error(cfgResult.error ?? "Could not write daemon config");
      }

      // 3) Kick off llama-server install if missing (idempotent).
      const ensure = await ensureRuntime();
      if (!ensure.ok) {
        throw new Error(ensure.error ?? "Could not start runtime setup");
      }

      // 4) Start each GGUF model download. Daemon-side they all flow
      //    through /model/progress alongside the runtime install.
      const names = Array.from(new Set([choice.distillName, choice.embedName]));
      for (const name of names) {
        const known = findModel(name);
        if (known === undefined) {
          throw new Error(`No URL registered for "${name}". Add it to shared/model-registry.ts.`);
        }
        const result = await startModelDownload(known.name, known.url, known.sha256 || undefined);
        if (!result.ok) {
          throw new Error(result.error ?? `Could not start ${name}`);
        }
      }

      // Watch all four jobs: llama-server + 2 GGUFs (distill+embed,
      // deduped if same model is used for both).
      setActiveDownloads([...names, "llama-server"]);
      setProgressEntries([]);
      setProgressError("");
      setStep(5);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Could not start setup.");
    }
  }

  function goBack(): void {
    if (step === 1) return;
    setStep((current) => Math.max(1, current - 1) as OnboardingStep);
  }

  return (
    <SurfaceRoot className="mnem-onboarding">
      <main>
        <div className="mnem-onboarding-brand">
          <span>◍</span>
          <b>Mnemium</b>
        </div>
        <section className="mnem-onboarding-card">
          <StepDots step={step} />
          {step === 1 ? <WelcomeStep onNext={() => setStep(2)} /> : null}
          {step === 2 ? (
            <DetectStep detectError={detectError} detectState={detectState} onBack={goBack} onRetry={() => void retryDaemonStatus()} />
          ) : null}
          {step === 3 ? (
            <InstallStep
              installTab={installTab}
              isPairing={isPairing}
              pairingError={pairingError}
              pairingString={pairingString}
              onBack={goBack}
              onCopy={(command) => void copyCommand(command)}
              onPair={() => void pairDaemon()}
              onPairingStringChange={setPairingString}
              onTabChange={setInstallTab}
            />
          ) : null}
          {step === 4 ? (
            <ModelStep choices={modelChoices} downloadError={downloadError} onBack={goBack} onStart={(choice) => void startDownloads(choice)} />
          ) : null}
          {step === 5 ? <ProgressStep activeProgress={activeProgress} progressError={progressError} onBack={goBack} /> : null}
          {step === 6 ? <ReadyStep /> : null}
        </section>
      </main>
    </SurfaceRoot>
  );
}

function StepDots({ step }: { step: OnboardingStep }): ReactElement {
  return (
    <div className="mnem-step-dots" aria-label={`Step ${step} of 6`}>
      {[1, 2, 3, 4, 5, 6].map((item) => (
        <span className={item === step ? "is-active" : ""} key={item} />
      ))}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }): ReactElement {
  return (
    <>
      <div className="mnem-lock">⌁</div>
      <h1>Your AI chats, with memory — 100% on your device.</h1>
      <p>
        Mnemium captures from 5 AI chat providers and stores everything locally. Distillation, embeddings, and retrieval run in
        a separate helper binary called mnemiumd, with models you control.
      </p>
      <div className="mnem-provider-grid">
        {providers.map((provider) => (
          <span key={provider}>{provider}</span>
        ))}
      </div>
      <button onClick={onNext} type="button">
        Next
      </button>
    </>
  );
}

function DetectStep({
  detectError,
  detectState,
  onBack,
  onRetry,
}: {
  detectError: string;
  detectState: DetectState;
  onBack: () => void;
  onRetry: () => void;
}): ReactElement {
  const isLoading = detectState === "loading" || detectState === "idle";
  return (
    <>
      <div className="mnem-lock">•</div>
      <h1>Checking for mnemiumd.</h1>
      {isLoading ? <p>Looking for the local helper and saved pairing credentials...</p> : null}
      {detectState === "paired-offline" ? (
        <p className="mnem-inline-error">Daemon paired but unreachable — make sure `mnemiumd serve` is running.</p>
      ) : null}
      {detectState === "error" ? <p className="mnem-inline-error">{detectError}</p> : null}
      <div className="mnem-actions">
        <button className="mnem-secondary-button" onClick={onBack} type="button">
          Back
        </button>
        <button disabled={isLoading} onClick={onRetry} type="button">
          {isLoading ? "Checking..." : "Retry"}
        </button>
      </div>
    </>
  );
}

function InstallStep({
  installTab,
  isPairing,
  pairingError,
  pairingString,
  onBack,
  onCopy,
  onPair,
  onPairingStringChange,
  onTabChange,
}: {
  installTab: InstallTab;
  isPairing: boolean;
  pairingError: string;
  pairingString: string;
  onBack: () => void;
  onCopy: (command: string) => void;
  onPair: () => void;
  onPairingStringChange: (value: string) => void;
  onTabChange: (tab: InstallTab) => void;
}): ReactElement {
  const commands = installTab === "unix" ? [shellInstall, serveCommand] : [windowsInstall, serveCommand];

  return (
    <>
      <h1>Install and pair mnemiumd.</h1>
      <p>Install the local helper, start it, then paste the pairing string it prints.</p>
      <div className="mnem-segmented mnem-install-tabs" role="tablist" aria-label="Install platform">
        <button className={installTab === "unix" ? "is-active" : ""} onClick={() => onTabChange("unix")} role="tab" type="button">
          Linux / macOS
        </button>
        <button
          className={installTab === "windows" ? "is-active" : ""}
          onClick={() => onTabChange("windows")}
          role="tab"
          type="button"
        >
          Windows
        </button>
      </div>
      <div className="mnem-command-stack">
        {commands.map((command) => (
          <div className="mnem-command" key={command}>
            <pre>{command}</pre>
            <button className="mnem-copy-button" onClick={() => onCopy(command)} type="button">
              Copy
            </button>
          </div>
        ))}
      </div>
      <label className="mnem-pairing-field">
        <span>Paste the pairing string `mnemiumd serve` printed.</span>
        <textarea
          onChange={(event) => onPairingStringChange(event.currentTarget.value)}
          placeholder="mn:8442:token"
          rows={4}
          value={pairingString}
        />
      </label>
      {pairingError.length > 0 ? <p className="mnem-inline-error">{pairingError}</p> : null}
      <div className="mnem-actions">
        <button className="mnem-secondary-button" onClick={onBack} type="button">
          Back
        </button>
        <button disabled={isPairing} onClick={onPair} type="button">
          {isPairing ? "Pairing..." : "Pair"}
        </button>
      </div>
    </>
  );
}

function ModelStep({
  choices,
  downloadError,
  onBack,
  onStart,
}: {
  choices: ModelChoice[];
  downloadError: string;
  onBack: () => void;
  onStart: (choice: ModelChoice) => void;
}): ReactElement {
  return (
    <>
      <h1>Choose models.</h1>
      <p>Pick the local model set mnemiumd should download for distillation and embeddings.</p>
      <div className="mnem-model-grid">
        {choices.map((choice) => (
          <article className="mnem-model-card" key={choice.id}>
            <div>
              <h2>{choice.title}</h2>
              <p>{choice.summary}</p>
            </div>
            <dl>
              <div>
                <dt>Distill</dt>
                <dd>
                  {choice.distillName} <span>{choice.distillSize}</span>
                </dd>
              </div>
              <div>
                <dt>Embed</dt>
                <dd>
                  {choice.embedName} <span>{choice.embedSize}</span>
                </dd>
              </div>
            </dl>
            <button onClick={() => onStart(choice)} type="button">
              Start download
            </button>
          </article>
        ))}
      </div>
      {downloadError.length > 0 ? <p className="mnem-inline-error">{downloadError}</p> : null}
      <button className="mnem-secondary-button" onClick={onBack} type="button">
        Back
      </button>
    </>
  );
}

function ProgressStep({
  activeProgress,
  progressError,
  onBack,
}: {
  activeProgress: Array<{ name: string; entry: DaemonProgressEntry | undefined }>;
  progressError: string;
  onBack: () => void;
}): ReactElement {
  return (
    <>
      <div className="mnem-lock">⇣</div>
      <h1>Downloading local models.</h1>
      <p>Keep mnemiumd running while the model files download.</p>
      <div className="mnem-progress-list">
        {activeProgress.map(({ name, entry }) => (
          <div className="mnem-progress-row" key={name}>
            <div>
              <b>{name}</b>
              <span>{formatProgress(entry)}</span>
            </div>
            <div className="mnem-download" aria-label={`${name} download progress`}>
              <span style={{ width: `${progressPercent(entry)}%` }} />
            </div>
          </div>
        ))}
      </div>
      {progressError.length > 0 ? <p className="mnem-inline-error">{progressError}</p> : null}
      <button className="mnem-secondary-button" onClick={onBack} type="button">
        Back
      </button>
    </>
  );
}

function ReadyStep(): ReactElement {
  return (
    <>
      <div className="mnem-lock">✓</div>
      <h1>Your private second brain is live.</h1>
      <p>Capture is automatic on the configured sites. Press Alt+Shift+M to pull memories into the current chat.</p>
      <a className="mnem-primary-link" href="/sidepanel.html">
        Open Mnemium
      </a>
    </>
  );
}

async function waitAtLeast(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remaining));
  }
}

function progressPercent(entry: DaemonProgressEntry | undefined): number {
  if (entry === undefined) return 0;
  if (entry.status === "done") return 100;
  if (entry.total <= 0) return 0;
  return Math.min(100, Math.round((entry.downloaded / entry.total) * 100));
}

function formatProgress(entry: DaemonProgressEntry | undefined): string {
  if (entry === undefined) return "Waiting for daemon progress...";
  if (entry.status === "failed") return `Failed: ${entry.error ?? "unknown error"}`;
  if (entry.status === "done") {
    // The daemon sends a message like "already on disk at /home/.../models/..."
    // when the file was present at boot, or "already installed at /home/.../bin/..."
    // for llama-server. Prefer that over "0.0 MB · done" which is meaningless
    // for files that never transited.
    if (typeof entry.message === "string" && entry.message.length > 0) {
      return entry.message;
    }
    return `${formatMb(entry.total)} · done`;
  }
  const eta = etaSeconds(entry);
  const rate = entry.bytesPerSec ?? 0;
  return `${formatMb(entry.downloaded)} / ${formatMb(entry.total)} · ${formatRate(rate)}${eta > 0 ? ` · ETA ${eta}s` : ""}`;
}

function etaSeconds(entry: DaemonProgressEntry): number {
  if (!entry.bytesPerSec || entry.bytesPerSec <= 0 || entry.total <= 0) return 0;
  const remaining = entry.total - entry.downloaded;
  if (remaining <= 0) return 0;
  return Math.max(0, Math.round(remaining / entry.bytesPerSec));
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatRate(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1_048_576).toFixed(1)} MB/s`;
}
