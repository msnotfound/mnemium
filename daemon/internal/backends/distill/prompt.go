package distill

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// SystemPrompt is shared across every text-LLM distill backend so the
// daemon makes the same ask of qwen / llama / gpt-4o / claude.
//
// Every memory is a CANDIDATE claim that must carry its own evidence: a
// verbatim span copied from the exchange, plus who said it. A downstream
// deterministic validator drops any memory whose evidence is not found
// character-for-character in the source — so paraphrased "evidence" is
// wasted output.
const SystemPrompt = `You extract durable, reusable facts from chat exchanges so a personal assistant can recall them later. Output STRICT JSON ONLY — no prose, no markdown fences.

Schema:
{
  "memories": [
    {
      "type": "fact",
      "content": "<one sentence stated in third person about the user>",
      "evidence": "<EXACT contiguous quote copied character-for-character from the USER or ASSISTANT text below that supports this claim>",
      "speaker": "<user|assistant — who actually wrote the evidence quote>",
      "supportKind": "<exact|paraphrase|inferred — exact: content restates the evidence; paraphrase: content rewords it; inferred: content goes beyond it>",
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
- evidence MUST be copied verbatim from the exchange — do not reword, trim mid-word, or fix typos. Memories whose evidence is not found verbatim in the source are discarded.
- speaker is whoever actually wrote the evidence: "user" for the USER section, "assistant" for the ASSISTANT section.
- "the user" is always the speaker of USER messages.
- Never turn an assistant suggestion into a user fact. Assistant-spoken evidence may only support claims describing the user.
- Never extract hypotheticals (maybe / might / could / perhaps / what if / one option / thinking about). They are not durable.
- preference, identity and fact memories require exact or paraphrase support; only task and episode memories may be inferred.
- Skip greetings, meta-talk, anything not durable.
- For memory.type, choose exactly one of: fact, preference, episode, task, identity.
- If nothing durable is present, return {"memories":[],"entities":[]}.
- Output ONLY the JSON object. No explanation, no fences.`

// Grammar is a GBNF grammar (llama.cpp dialect) that hard-constrains
// llama-server output to the distill schema — including the enum values
// for type / speaker / supportKind. Small models (qwen2.5-1.5b) follow
// the field-list prompt unreliably; the grammar makes the SHAPE
// deterministic so the only remaining failure mode is content-level
// (hallucinated evidence), which the extension validator catches by
// substring check. Sent instead of response_format on the llama.cpp
// backend only; cloud backends keep json_object mode.
// Ref: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md
const Grammar = `root ::= "{" ws "\"memories\"" ws ":" ws memories ws "," ws "\"entities\"" ws ":" ws entities ws "}" ws
memories ::= "[" ws "]" | "[" ws memory (ws "," ws memory)* ws "]"
memory ::= "{" ws "\"type\"" ws ":" ws memtype ws "," ws "\"content\"" ws ":" ws string ws "," ws "\"evidence\"" ws ":" ws string ws "," ws "\"speaker\"" ws ":" ws speaker ws "," ws "\"supportKind\"" ws ":" ws supportkind ws "," ws "\"isStatic\"" ws ":" ws bool ws "," ws "\"isInference\"" ws ":" ws bool ws "," ws "\"confidence\"" ws ":" ws number ws "," ws "\"entities\"" ws ":" ws strings ws "}"
memtype ::= "\"fact\"" | "\"preference\"" | "\"episode\"" | "\"task\"" | "\"identity\""
speaker ::= "\"user\"" | "\"assistant\""
supportkind ::= "\"exact\"" | "\"paraphrase\"" | "\"inferred\""
entities ::= "[" ws "]" | "[" ws entity (ws "," ws entity)* ws "]"
entity ::= "{" ws "\"name\"" ws ":" ws string ws "," ws "\"type\"" ws ":" ws string ws "," ws "\"normalizedName\"" ws ":" ws string ws "}"
strings ::= "[" ws "]" | "[" ws string (ws "," ws string)* ws "]"
string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\bfnrt/] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
bool ::= "true" | "false"
number ::= ("0" | "1") ("." [0-9]+)?
ws ::= [ \t\n\r]*
`

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
		Evidence    string   `json:"evidence"`
		Speaker     string   `json:"speaker"`
		SupportKind string   `json:"supportKind"`
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
		// Normalize trust fields but do NOT gate on them here — the
		// extension-side validator is the single enforcement point (it has
		// the source text to substring-check against). The daemon's job is
		// to pass candidates through with consistent casing.
		mems = append(mems, Memory{
			Type:        typ,
			Content:     content,
			Evidence:    strings.TrimSpace(m.Evidence),
			Speaker:     strings.ToLower(strings.TrimSpace(m.Speaker)),
			SupportKind: strings.ToLower(strings.TrimSpace(m.SupportKind)),
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
