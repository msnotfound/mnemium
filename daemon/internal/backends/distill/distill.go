// Package distill defines the contract every distillation backend
// implements. v0.0 ships only the Disabled stub; real backends land
// next (llama-cpp subprocess wrapper, ollama HTTP proxy, openai/
// anthropic/openrouter clients).
package distill

import "context"

// Exchange matches the JSON shape the extension sends in POST /distill.
type Exchange struct {
	Provider      string `json:"provider"`
	ThreadID      string `json:"threadId"`
	MessageID     string `json:"messageId"`
	UserText      string `json:"userText"`
	AssistantText string `json:"assistantText"`
	Ts            int64  `json:"ts"`
}

// Memory is the structured draft a distiller produces — a CANDIDATE claim,
// not trusted memory. Aligns with the extension's DraftMemory type
// (src/shared/types.ts). The extension-side deterministic validator gates
// entry into the active memory set: Evidence must be a verbatim substring
// of the source exchange, and Speaker must match where it appears.
type Memory struct {
	Type        string   `json:"type"`
	Content     string   `json:"content"`
	Evidence    string   `json:"evidence,omitempty"`
	Speaker     string   `json:"speaker,omitempty"`
	SupportKind string   `json:"supportKind,omitempty"`
	IsStatic    bool     `json:"isStatic"`
	IsInference bool     `json:"isInference"`
	Confidence  float64  `json:"confidence"`
	Entities    []string `json:"entities,omitempty"`
}

// Entity links a memory to a named concept.
type Entity struct {
	ID             string `json:"id"`
	Type           string `json:"type"`
	Name           string `json:"name"`
	NormalizedName string `json:"normalizedName"`
	ScopeURI       string `json:"scopeUri"`
}

// Backend is the swap point. New backends only need to implement Distill.
type Backend interface {
	Distill(ctx context.Context, ex Exchange) (memories []Memory, entities []Entity, err error)
	Ready() bool
	Model() string
	// Warm pre-spawns any subprocess / pre-loads any heavy state. Called
	// from `mnemiumd serve` after Listen so the first /distill request
	// doesn't pay the cold-start tax. No-op for backends that don't have
	// expensive initialization (Disabled, Ollama, OpenAI).
	Warm(ctx context.Context) error
	// State / Message expose lifecycle to /status so the UI can show
	// loading spinners and actionable errors. State is one of:
	//   "idle"    — configured but not yet started
	//   "warming" — Warm() in flight; spawn happened, healthcheck pending
	//   "ready"   — process up, healthy
	//   "failed"  — Warm() returned error; Message has the cause
	State() string
	Message() string
}
