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

// Memory is the structured draft a distiller produces. Aligns with the
// extension's DraftMemory type (src/shared/types.ts).
type Memory struct {
	Type       string   `json:"type"`
	Content    string   `json:"content"`
	IsStatic   bool     `json:"isStatic"`
	IsInference bool    `json:"isInference"`
	Confidence float64  `json:"confidence"`
	Entities   []string `json:"entities,omitempty"`
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
}
