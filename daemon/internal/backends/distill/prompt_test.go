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
