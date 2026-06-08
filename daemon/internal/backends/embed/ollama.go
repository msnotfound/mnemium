package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Ollama embeds via POST /api/embed (returns []float32 per input).
type Ollama struct {
	endpoint string
	model    string
	client   *http.Client

	mu  sync.Mutex
	dim int // discovered on first successful call
}

func NewOllama(endpoint, model string) (*Ollama, error) {
	if endpoint == "" {
		endpoint = "http://localhost:11434"
	}
	if model == "" {
		return nil, errors.New("ollama embed: model is required (e.g. nomic-embed-text)")
	}
	return &Ollama{
		endpoint: endpoint,
		model:    model,
		client:   &http.Client{Timeout: 120 * time.Second},
	}, nil
}

func (o *Ollama) Ready() bool   { return true }
func (o *Ollama) Model() string { return o.model }
func (o *Ollama) Dim() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.dim
}

type ollamaEmbedRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type ollamaEmbedResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
	Error      string      `json:"error,omitempty"`
}

func (o *Ollama) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	body, err := json.Marshal(ollamaEmbedRequest{Model: o.model, Input: texts})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint+"/api/embed", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama embed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama embed %d: %s", resp.StatusCode, string(raw))
	}
	var out ollamaEmbedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode ollama embed: %w", err)
	}
	if out.Error != "" {
		return nil, errors.New(out.Error)
	}
	if len(out.Embeddings) > 0 && len(out.Embeddings[0]) > 0 {
		o.mu.Lock()
		o.dim = len(out.Embeddings[0])
		o.mu.Unlock()
	}
	return out.Embeddings, nil
}
