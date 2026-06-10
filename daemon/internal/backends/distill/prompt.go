package distill

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SystemPrompt is shared across every text-LLM distill backend so the
// daemon makes the same ask of qwen / llama / gpt-4o / claude.
const SystemPrompt = `You extract durable, reusable facts from chat exchanges so a personal assistant can recall them later. Output STRICT JSON ONLY — no prose, no markdown fences.

Schema:
{
  "memories": [
    {
      "type": "fact",
      "content": "<one sentence stated in third person about the user>",
      "isStatic": <true if always-true biographical fact, false if temporary state>,
      "isInference": <true if you inferred it, false if user stated it>,
      "confidence": <0.0..1.0>,
      "entities": ["<canonical name>", ...]
    }
  ],
  "entities": [
    { "name": "<as it appeared>", "type": "person|place|tool|topic|org|product", "normalizedName": "<lowercase canonical>" }
  ]
}

Rules:
- Skip greetings, meta-talk, anything not durable.
- "the user" is always the speaker of USER messages.
- For memory.type, choose exactly one of: fact, preference, episode, task, identity.
- If nothing durable is present, return {"memories":[],"entities":[]}.
- Output ONLY the JSON object. No explanation, no fences.`

// BuildUserPrompt assembles the per-exchange prompt body sent after the
// system prompt. Keeps prompts deterministic so model swaps stay
// comparable.
func BuildUserPrompt(ex Exchange) string {
	var b strings.Builder
	b.WriteString("Exchange from ")
	b.WriteString(ex.Provider)
	if ex.Ts > 0 {
		b.WriteString(" at ")
		b.WriteString(time.Unix(ex.Ts/1000, 0).UTC().Format(time.RFC3339))
	}
	b.WriteString("\n\nUSER:\n")
	b.WriteString(strings.TrimSpace(ex.UserText))
	b.WriteString("\n\nASSISTANT:\n")
	b.WriteString(strings.TrimSpace(ex.AssistantText))
	b.WriteString("\n\nReturn the JSON object now.")
	return b.String()
}

// rawResponse is the JSON shape we ask models to emit.
type rawResponse struct {
	Memories []struct {
		Type        string   `json:"type"`
		Content     string   `json:"content"`
		IsStatic    bool     `json:"isStatic"`
		IsInference bool     `json:"isInference"`
		Confidence  float64  `json:"confidence"`
		Entities    []string `json:"entities"`
	} `json:"memories"`
	Entities []struct {
		Name           string `json:"name"`
		Type           string `json:"type"`
		NormalizedName string `json:"normalizedName"`
	} `json:"entities"`
}

// ParseResponse extracts the JSON object from an LLM completion. Tolerates
// markdown fences, leading prose, and trailing junk — finds the first
// balanced {...} and decodes it.
func ParseResponse(raw string, scopeURI string) ([]Memory, []Entity, error) {
	body, ok := extractJSONObject(raw)
	if !ok {
		return nil, nil, fmt.Errorf("no JSON object found in response (len=%d)", len(raw))
	}
	var parsed rawResponse
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return nil, nil, fmt.Errorf("parse JSON: %w", err)
	}

	mems := make([]Memory, 0, len(parsed.Memories))
	for _, m := range parsed.Memories {
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		typ := strings.TrimSpace(m.Type)
		if !validMemoryType(typ) {
			continue
		}
		confidence := m.Confidence
		if confidence < 0 {
			confidence = 0
		}
		if confidence > 1 {
			confidence = 1
		}
		mems = append(mems, Memory{
			Type:        typ,
			Content:     content,
			IsStatic:    m.IsStatic,
			IsInference: m.IsInference,
			Confidence:  confidence,
			Entities:    m.Entities,
		})
	}

	ents := make([]Entity, 0, len(parsed.Entities))
	for _, e := range parsed.Entities {
		name := strings.TrimSpace(e.Name)
		if name == "" {
			continue
		}
		norm := strings.TrimSpace(e.NormalizedName)
		if norm == "" {
			norm = strings.ToLower(name)
		}
		typ := e.Type
		if typ == "" {
			typ = "topic"
		}
		ents = append(ents, Entity{
			ID:             norm,
			Type:           typ,
			Name:           name,
			NormalizedName: norm,
			ScopeURI:       scopeURI,
		})
	}

	return mems, ents, nil
}

func validMemoryType(typ string) bool {
	switch typ {
	case "fact", "preference", "episode", "task", "identity":
		return true
	default:
		return false
	}
}

// extractJSONObject finds the first balanced {...} block in s. Handles
// strings (and escaped quotes inside them) so braces in dialogue content
// don't unbalance the count.
func extractJSONObject(s string) (string, bool) {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return "", false
	}
	depth := 0
	inString := false
	escape := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inString {
			if escape {
				escape = false
				continue
			}
			if c == '\\' {
				escape = true
				continue
			}
			if c == '"' {
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1], true
			}
		}
	}
	return "", false
}
