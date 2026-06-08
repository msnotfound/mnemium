package distill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Ollama is a distill backend that talks to a running ollama server.
// Default endpoint is http://localhost:11434.
type Ollama struct {
	endpoint string
	model    string
	client   *http.Client
}

// NewOllama constructs an ollama distill backend. Doesn't ping — Ready()
// reports false until the first successful call (and stays optimistic
// after that; the HTTP error surfaces to the caller anyway).
func NewOllama(endpoint, model string) (*Ollama, error) {
	if endpoint == "" {
		endpoint = "http://localhost:11434"
	}
	if model == "" {
		return nil, errors.New("ollama distill: model is required (e.g. qwen2.5:1.5b)")
	}
	return &Ollama{
		endpoint: endpoint,
		model:    model,
		client:   &http.Client{Timeout: 120 * time.Second},
	}, nil
}

func (o *Ollama) Ready() bool   { return true }
func (o *Ollama) Model() string { return o.model }

type ollamaMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ollamaChatRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Stream   bool            `json:"stream"`
	Format   string          `json:"format,omitempty"`
	Options  map[string]any  `json:"options,omitempty"`
}

type ollamaChatResponse struct {
	Message ollamaMessage `json:"message"`
	Error   string        `json:"error,omitempty"`
}

func (o *Ollama) Distill(ctx context.Context, ex Exchange) ([]Memory, []Entity, error) {
	body, err := json.Marshal(ollamaChatRequest{
		Model:  o.model,
		Stream: false,
		Format: "json",
		Messages: []ollamaMessage{
			{Role: "system", Content: SystemPrompt},
			{Role: "user", Content: BuildUserPrompt(ex)},
		},
		Options: map[string]any{
			"temperature": 0.2,
		},
	})
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("ollama chat: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("ollama chat %d: %s", resp.StatusCode, string(raw))
	}
	var out ollamaChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil, fmt.Errorf("decode ollama response: %w", err)
	}
	if out.Error != "" {
		return nil, nil, errors.New(out.Error)
	}
	return ParseResponse(out.Message.Content, scopeURIFor(ex))
}

// scopeURIFor builds a stable scope URI like "claude:thread/<id>" so the
// vector store can pre-filter. Falls back to provider-only if the
// thread isn't known.
func scopeURIFor(ex Exchange) string {
	if ex.ThreadID != "" {
		return fmt.Sprintf("%s:thread/%s", ex.Provider, ex.ThreadID)
	}
	if ex.Provider != "" {
		return ex.Provider + ":global"
	}
	return "unknown"
}
