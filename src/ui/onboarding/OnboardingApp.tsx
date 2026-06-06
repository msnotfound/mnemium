import type { ReactElement } from "react";
import { useState } from "react";

import { SurfaceRoot } from "../components/Primitives";
import "./onboarding.css";

const providers = ["ChatGPT", "Claude", "Gemini", "Grok", "DeepSeek"] as const;

export function OnboardingApp(): ReactElement {
  const [step, setStep] = useState<"consent" | "download">("consent");
  const progress = step === "download" ? 72 : 0;

  return (
    <SurfaceRoot className="mnem-onboarding">
      <main>
        <div className="mnem-onboarding-brand">
          <span>◍</span>
          <b>Mnemium</b>
        </div>
        <section className="mnem-onboarding-card">
          <div className="mnem-step-dots">
            <span />
            <span className="is-active" />
            <span />
          </div>
          {step === "consent" ? (
            <>
              <div className="mnem-lock">⌁</div>
              <h1>Your AI chats, with memory — 100% on your device.</h1>
              <p>
                Nothing is ever sent to a server. We read your conversations on these sites only to build your private memory,
                stored locally on this device.
              </p>
              <div className="mnem-provider-grid">
                {providers.map((provider) => (
                  <span key={provider}>✓ {provider}</span>
                ))}
              </div>
              <button onClick={() => setStep("download")} type="button">
                Grant access & continue
              </button>
              <a href="#stored">See exactly what gets stored</a>
            </>
          ) : (
            <>
              <div className="mnem-lock">⇣</div>
              <h1>Setting up local memory...</h1>
              <p>The built-in model is being prepared for offline use. This stays on this device.</p>
              <div className="mnem-download">
                <span style={{ width: `${progress}%` }} />
              </div>
              <output>{progress}% complete</output>
              <button onClick={() => setStep("consent")} type="button">
                Back
              </button>
            </>
          )}
        </section>
      </main>
    </SurfaceRoot>
  );
}
