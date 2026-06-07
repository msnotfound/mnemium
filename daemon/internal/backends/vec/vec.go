// Package vec defines the vector-store contract. v0.0 ships only the
// Disabled stub. The sqlite-vec backend (cgo-linked sqlite + vec0
// extension) lands next; an alternate hnswlib-go pure-Go backend is
// planned for users who don't want cgo.
package vec

import "context"

// Row is one (memory_id, vector) pair with metadata for pre-filtered
// HNSW search.
type Row struct {
	ID    string    `json:"id"`
	Scope string    `json:"scope"`
	Type  string    `json:"type"`
	Vec   []float32 `json:"vec"`
}

// Filter narrows search to a scope prefix and/or memory types.
type Filter struct {
	ScopePrefix string   `json:"scopePrefix,omitempty"`
	Type        []string `json:"type,omitempty"`
}

// Hit is one search result. Score is cosine similarity normalized to [0,1].
type Hit struct {
	ID    string  `json:"id"`
	Score float64 `json:"score"`
}

// Backend is the swap point for the vector store.
type Backend interface {
	Upsert(ctx context.Context, modelID string, rows []Row) (int, error)
	Search(ctx context.Context, modelID string, query []float32, k int, filter *Filter) ([]Hit, error)
	Drop(ctx context.Context, modelID string) error
	Count(ctx context.Context) int
	Ready() bool
	Close() error
}

// Disabled is the no-op vector store.
type Disabled struct{}

func (Disabled) Upsert(_ context.Context, _ string, _ []Row) (int, error) { return 0, nil }
func (Disabled) Search(_ context.Context, _ string, _ []float32, _ int, _ *Filter) ([]Hit, error) {
	return nil, nil
}
func (Disabled) Drop(_ context.Context, _ string) error { return nil }
func (Disabled) Count(_ context.Context) int            { return 0 }
func (Disabled) Ready() bool                            { return false }
func (Disabled) Close() error                           { return nil }
