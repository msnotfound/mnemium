package distill

import "context"

// Disabled is the no-op backend used when config.toml says
// distill.kind = "disabled". The HTTP layer returns 503
// backend_unavailable for distill calls in this mode — Disabled is here
// so the resolver always has an interface value to return.
type Disabled struct{}

func (Disabled) Distill(_ context.Context, _ Exchange) ([]Memory, []Entity, error) {
	return nil, nil, nil
}
func (Disabled) Ready() bool                  { return false }
func (Disabled) Model() string                { return "" }
func (Disabled) Warm(_ context.Context) error { return nil }
func (Disabled) State() string                { return "idle" }
func (Disabled) Message() string              { return "distill backend not configured" }
