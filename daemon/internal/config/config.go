// Package config loads ~/.config/mnemium/config.toml. On first run, writes
// a default config so the user can see the shape and edit it. Backend
// kinds are TOML-driven so the user can swap llama-cpp ↔ ollama ↔ openai
// ↔ disabled without touching code.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"

	"github.com/msnotfound/mnemium/daemon/internal/xdg"
)

// Config is the on-disk shape. Mirrors what the extension's
// Config.backends.* selectors expose.
type Config struct {
	Listen   string   `toml:"listen"`
	Backends Backends `toml:"backends"`
}

type Backends struct {
	Distill BackendSpec `toml:"distill"`
	Embed   BackendSpec `toml:"embed"`
	Vec     BackendSpec `toml:"vec"`
}

type BackendSpec struct {
	Kind     string `toml:"kind"`            // "llama-cpp" | "ollama" | "openai" | "anthropic" | "openrouter" | "sqlite-vec" | "hnswlib" | "disabled"
	Model    string `toml:"model,omitempty"` // model name (depends on kind)
	Endpoint string `toml:"endpoint,omitempty"`
	APIKeyEnv string `toml:"api_key_env,omitempty"`
	Path     string `toml:"path,omitempty"` // vec backend storage
	Threads  int    `toml:"n_threads,omitempty"`
	Ctx      int    `toml:"ctx,omitempty"`
}

// Default is the shape written when no config file exists yet.
func Default() Config {
	return Config{
		Listen: "127.0.0.1:0",
		Backends: Backends{
			Distill: BackendSpec{Kind: "disabled"}, // becomes "llama-cpp" once the user picks a model
			Embed:   BackendSpec{Kind: "disabled"},
			Vec:     BackendSpec{Kind: "disabled"},
		},
	}
}

// Paths is the resolved set of locations mnemiumd writes to.
func Paths() xdg.Paths { return xdg.Resolve() }

// LoadOrCreate reads config.toml, or writes Default() if missing.
func LoadOrCreate() (Config, error) {
	paths := xdg.Resolve()
	if err := paths.Ensure(); err != nil {
		return Config{}, fmt.Errorf("ensure dirs: %w", err)
	}

	file := filepath.Join(paths.Config, "config.toml")
	bytes, err := os.ReadFile(file)
	if err != nil {
		if !os.IsNotExist(err) {
			return Config{}, fmt.Errorf("read %s: %w", file, err)
		}
		cfg := Default()
		if err := Save(cfg); err != nil {
			return Config{}, fmt.Errorf("write default config: %w", err)
		}
		return cfg, nil
	}

	cfg := Default()
	if _, err := toml.Decode(string(bytes), &cfg); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", file, err)
	}
	return cfg, nil
}

// Save writes the config back to disk atomically (write to tmp + rename).
func Save(cfg Config) error {
	paths := xdg.Resolve()
	if err := paths.Ensure(); err != nil {
		return err
	}
	file := filepath.Join(paths.Config, "config.toml")
	tmp := file + ".tmp"

	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	enc := toml.NewEncoder(f)
	if err := enc.Encode(cfg); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, file)
}
