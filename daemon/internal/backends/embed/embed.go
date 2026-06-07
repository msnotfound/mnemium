// Package embed defines the Embedder contract every embedding backend
// implements. v0.0 ships only the Disabled stub.
package embed

import "context"

// Backend computes vector embeddings for a batch of texts. All vectors
// in a batch share the backend's Dim().
type Backend interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Ready() bool
	Model() string
	Dim() int
}

// Disabled is the no-op backend.
type Disabled struct{}

func (Disabled) Embed(_ context.Context, _ []string) ([][]float32, error) { return nil, nil }
func (Disabled) Ready() bool                                              { return false }
func (Disabled) Model() string                                            { return "" }
func (Disabled) Dim() int                                                 { return 0 }
