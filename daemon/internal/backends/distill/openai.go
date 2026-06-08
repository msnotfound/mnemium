package distill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// OpenAI is a distill backend that talks to any OpenAI-compatible chat
// completions endpoint — the real OpenAI, OpenRouter, Together,
// Anthropic-via-proxy, etc. Endpoint defaults to the canonical OpenAI
// host; api_key is read from the env var named by APIKeyEnv.
type OpenAI struct {
	endpoint string
	model    string
	apiKey   string
	client   *http.Client
}

// NewOpenAI constructs the backend. Returns an error if the env var named
// by apiKeyEnv is empty (no point starting a backend that will 401 every
// call). apiKeyEnv defaults to "OPENAI_API_KEY".
func NewOpenAI(endpoint, model, apiKeyEnv string) (*OpenAI, error) {
	if model == "" {
		return nil, errors.New("openai distill: model is required (e.g. gpt-4o-mini)")
	}
	if endpoint == "" {
		endpoint = "https://api.openai.com/v1"
	}
	endpoint = strings.TrimRight(endpoint, "/")
	if apiKeyEnv == "" {
		apiKeyEnv = "OPENAI_API_KEY"
	}
	key := os.Getenv(apiKeyEnv)
	if key == "" {
		return nil, fmt.Errorf("openai distill: env var %s is empty", apiKeyEnv)
	}
	return &OpenAI{
		endpoint: endpoint,
		model:    model,
		apiKey:   key,
		client:   &http.Client{Timeout: 120 * time.Second},
	}, nil
}

func (o *OpenAI) Ready() bool   { return true }
func (o *OpenAI) Model() string { return o.model }

type openaiMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openaiChatRequest struct {
	Model          string          `json:"model"`
	Messages       []openaiMessage `json:"messages"`
	Temperature    float64         `json:"temperature"`
	ResponseFormat *openaiFormat   `json:"response_format,omitempty"`
}

type openaiFormat struct {
	Type string `json:"type"`
}

type openaiChatResponse struct {
	Choices []struct {
		Message openaiMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
}

func (o *OpenAI) Distill(ctx context.Context, ex Exchange) ([]Memory, []Entity, error) {
	reqBody := openaiChatRequest{
		Model:       o.model,
		Temperature: 0.2,
		Messages: []openaiMessage{
			{Role: "system", Content: SystemPrompt},
			{Role: "user", Content: BuildUserPrompt(ex)},
		},
		ResponseFormat: &openaiFormat{Type: "json_object"},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+o.apiKey)
	resp, err := o.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("openai chat: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		// Retry once without response_format — some OpenAI-compatible
		// providers (openrouter free models, older anthropic shims) reject
		// json_object and we shouldn't blow up the user's pipeline over
		// vendor-specific quirks.
		if shouldRetryWithoutJSONFormat(raw) {
			reqBody.ResponseFormat = nil
			body, _ = json.Marshal(reqBody)
			req2, _ := http.NewRequestWithContext(ctx, http.MethodPost, o.endpoint+"/chat/completions", bytes.NewReader(body))
			req2.Header = req.Header
			resp2, err2 := o.client.Do(req2)
			if err2 != nil {
				return nil, nil, fmt.Errorf("openai retry: %w", err2)
			}
			defer resp2.Body.Close()
			raw, _ = io.ReadAll(resp2.Body)
			if resp2.StatusCode != http.StatusOK {
				return nil, nil, fmt.Errorf("openai chat %d: %s", resp2.StatusCode, string(raw))
			}
		} else {
			return nil, nil, fmt.Errorf("openai chat %d: %s", resp.StatusCode, string(raw))
		}
	}
	var out openaiChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil, fmt.Errorf("decode openai response: %w", err)
	}
	if out.Error != nil {
		return nil, nil, errors.New(out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return nil, nil, errors.New("openai: empty choices")
	}
	return ParseResponse(out.Choices[0].Message.Content, scopeURIFor(ex))
}

func shouldRetryWithoutJSONFormat(raw []byte) bool {
	s := strings.ToLower(string(raw))
	return strings.Contains(s, "response_format") ||
		strings.Contains(s, "json_object") ||
		strings.Contains(s, "invalid_request_error")
}
