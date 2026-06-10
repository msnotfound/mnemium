package distill

import (
	"strings"
	"testing"
)

func TestSystemPromptUsesCurrentMemoryTypeEnum(t *testing.T) {
	if !strings.Contains(SystemPrompt, "fact, preference, episode, task, identity") {
		t.Fatalf("system prompt does not list current memory types")
	}
	if strings.Contains(SystemPrompt, "skill|goal|constraint|context") {
		t.Fatalf("system prompt still contains stale memory type options")
	}
}

func TestSystemPromptRequiresTrustFields(t *testing.T) {
	for _, field := range []string{`"evidence"`, `"speaker"`, `"supportKind"`} {
		if !strings.Contains(SystemPrompt, field) {
			t.Fatalf("system prompt does not require %s", field)
		}
	}
	if !strings.Contains(SystemPrompt, "verbatim") {
		t.Fatalf("system prompt does not demand verbatim evidence")
	}
}

func TestGrammarConstrainsTrustEnums(t *testing.T) {
	for _, fragment := range []string{
		`"\"user\"" | "\"assistant\""`,
		`"\"exact\"" | "\"paraphrase\"" | "\"inferred\""`,
		`"\"fact\"" | "\"preference\"" | "\"episode\"" | "\"task\"" | "\"identity\""`,
	} {
		if !strings.Contains(Grammar, fragment) {
			t.Fatalf("grammar missing enum constraint %s", fragment)
		}
	}
}

func TestParseResponseNormalizesTrustFields(t *testing.T) {
	raw := `{
		"memories": [
			{
				"type": "preference",
				"content": "The user prefers local-first tools.",
				"evidence": " I prefer local-first tools ",
				"speaker": "User",
				"supportKind": "EXACT",
				"isStatic": true,
				"isInference": false,
				"confidence": 0.9,
				"entities": []
			}
		],
		"entities": []
	}`

	memories, _, err := ParseResponse(raw, "chatgpt:thread/abc")
	if err != nil {
		t.Fatalf("ParseResponse returned error: %v", err)
	}
	if len(memories) != 1 {
		t.Fatalf("expected one memory, got %d", len(memories))
	}
	m := memories[0]
	if m.Evidence != "I prefer local-first tools" {
		t.Fatalf("evidence not trimmed: %q", m.Evidence)
	}
	if m.Speaker != "user" {
		t.Fatalf("speaker not lowercased: %q", m.Speaker)
	}
	if m.SupportKind != "exact" {
		t.Fatalf("supportKind not lowercased: %q", m.SupportKind)
	}
}

func TestParseResponseRejectsInvalidMemoryTypes(t *testing.T) {
	raw := `{
		"memories": [
			{
				"type": "preference|fact|skill|goal|constraint|context",
				"content": "The user prefers poha for breakfast.",
				"isStatic": true,
				"isInference": false,
				"confidence": 0.8,
				"entities": []
			},
			{
				"type": "preference",
				"content": "The user prefers historical places.",
				"isStatic": true,
				"isInference": false,
				"confidence": 0.9,
				"entities": []
			}
		],
		"entities": []
	}`

	memories, _, err := ParseResponse(raw, "chatgpt:thread/abc")
	if err != nil {
		t.Fatalf("ParseResponse returned error: %v", err)
	}
	if len(memories) != 1 {
		t.Fatalf("expected one valid memory, got %d", len(memories))
	}
	if memories[0].Type != "preference" {
		t.Fatalf("expected preference memory, got %q", memories[0].Type)
	}
}
