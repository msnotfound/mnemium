// Package backends owns the resolver that turns a config.Config into
// a concrete set of distill / embed / vec implementations. Returning
// non-nil interfaces always (Disabled stubs on failure) keeps the HTTP
// layer free of nil checks.
package backends

import (
	"fmt"
	"io"
	"log"

	"github.com/msnotfound/mnemium/daemon/internal/backends/distill"
	"github.com/msnotfound/mnemium/daemon/internal/backends/embed"
	"github.com/msnotfound/mnemium/daemon/internal/backends/vec"
	"github.com/msnotfound/mnemium/daemon/internal/config"
	"github.com/msnotfound/mnemium/daemon/internal/xdg"
)

// Set is one resolved trio of backends.
type Set struct {
	Distill distill.Backend
	Embed   embed.Backend
	Vec     vec.Backend
}

// Close releases resources held by any backend that implements io.Closer.
func (s *Set) Close() {
	if s == nil {
		return
	}
	if c, ok := s.Distill.(io.Closer); ok {
		_ = c.Close()
	}
	if c, ok := s.Embed.(io.Closer); ok {
		_ = c.Close()
	}
	if c, ok := s.Vec.(io.Closer); ok {
		_ = c.Close()
	}
}

// Resolve builds a Set from cfg + the resolved data paths. Anything that
// fails to construct gets logged + replaced with a Disabled stub — the
// daemon should still boot and serve /status so the extension can show
// the user what's wrong.
func Resolve(cfg config.Config, paths xdg.Paths) Set {
	set := Set{
		Distill: distill.Disabled{},
		Embed:   embed.Disabled{},
		Vec:     vec.Disabled{},
	}
	if d, err := resolveDistill(cfg.Backends.Distill, paths.Models); err != nil {
		log.Printf("distill backend %s disabled: %v", cfg.Backends.Distill.Kind, err)
	} else if d != nil {
		set.Distill = d
	}
	if e, err := resolveEmbed(cfg.Backends.Embed, paths.Models); err != nil {
		log.Printf("embed backend %s disabled: %v", cfg.Backends.Embed.Kind, err)
	} else if e != nil {
		set.Embed = e
	}
	if v, err := resolveVec(cfg.Backends.Vec, paths.Vectors); err != nil {
		log.Printf("vec backend %s disabled: %v", cfg.Backends.Vec.Kind, err)
	} else if v != nil {
		set.Vec = v
	}
	return set
}

func resolveDistill(spec config.BackendSpec, modelsDir string) (distill.Backend, error) {
	switch spec.Kind {
	case "", "disabled":
		return nil, nil
	case "ollama":
		return distill.NewOllama(spec.Endpoint, spec.Model)
	case "openai", "openrouter", "anthropic", "together":
		return distill.NewOpenAI(spec.Endpoint, spec.Model, spec.APIKeyEnv)
	case "llama-cpp":
		return distill.NewLlamaCPP(modelsDir, spec.Model, spec.Threads, spec.Ctx)
	default:
		return nil, fmt.Errorf("unknown kind %q", spec.Kind)
	}
}

func resolveEmbed(spec config.BackendSpec, modelsDir string) (embed.Backend, error) {
	switch spec.Kind {
	case "", "disabled":
		return nil, nil
	case "ollama":
		return embed.NewOllama(spec.Endpoint, spec.Model)
	case "llama-cpp":
		return embed.NewLlamaCPP(modelsDir, spec.Model, spec.Threads)
	default:
		return nil, fmt.Errorf("unknown kind %q", spec.Kind)
	}
}

func resolveVec(spec config.BackendSpec, defaultPath string) (vec.Backend, error) {
	switch spec.Kind {
	case "", "disabled":
		return nil, nil
	case "sqlite", "sqlite-vec":
		// "sqlite-vec" stays a recognized alias even though v0.1 ships the
		// brute-force backend. When the cgo sqlite-vec extension lands
		// it'll claim this kind name.
		path := spec.Path
		if path == "" {
			path = defaultPath
		}
		return vec.NewSqlite(path)
	default:
		return nil, fmt.Errorf("unknown kind %q", spec.Kind)
	}
}
