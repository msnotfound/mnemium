// Package xdg resolves OS-appropriate config/data/runtime paths for
// mnemiumd. Linux follows XDG, macOS uses ~/Library/Application Support,
// Windows uses %APPDATA% / %LOCALAPPDATA%.
//
// Every path can be overridden with the MNEMIUM_HOME env var (collapses
// all six paths under one directory). Useful for testing, portable
// installs, or sandboxing — matches the fleetorch pattern.
package xdg

import (
	"os"
	"path/filepath"
	"runtime"
)

// Paths is the full set of directories + files mnemiumd writes to.
type Paths struct {
	Config    string // ~/.config/mnemium/
	Data      string // ~/.local/share/mnemium/
	Models    string // ~/.local/share/mnemium/models/
	Bin       string // ~/.local/share/mnemium/bin/   (auto-installed binaries: llama-server, etc.)
	Vectors   string // ~/.local/share/mnemium/vectors.db
	PortFile  string // ~/.local/share/mnemium/port
	TokenFile string // ~/.local/share/mnemium/mnemium-token
}

// Resolve returns the active set of paths. Honors MNEMIUM_HOME for
// portable / test installs.
func Resolve() Paths {
	if home := os.Getenv("MNEMIUM_HOME"); home != "" {
		return Paths{
			Config:    home,
			Data:      home,
			Models:    filepath.Join(home, "models"),
			Bin:       filepath.Join(home, "bin"),
			Vectors:   filepath.Join(home, "vectors.db"),
			PortFile:  filepath.Join(home, "port"),
			TokenFile: filepath.Join(home, "mnemium-token"),
		}
	}

	config := osConfigDir()
	data := osDataDir()
	return Paths{
		Config:    config,
		Data:      data,
		Models:    filepath.Join(data, "models"),
		Bin:       filepath.Join(data, "bin"),
		Vectors:   filepath.Join(data, "vectors.db"),
		PortFile:  filepath.Join(data, "port"),
		TokenFile: filepath.Join(data, "mnemium-token"),
	}
}

func osConfigDir() string {
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			return filepath.Join(v, "mnemium")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "mnemium")
		}
	}
	// Linux + fallback: XDG_CONFIG_HOME or ~/.config
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "mnemium")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".config", "mnemium")
	}
	return filepath.Join(".", "mnemium-config")
}

func osDataDir() string {
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("LOCALAPPDATA"); v != "" {
			return filepath.Join(v, "mnemium")
		}
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "mnemium")
		}
	}
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, "mnemium")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "mnemium")
	}
	return filepath.Join(".", "mnemium-data")
}

// Ensure creates every directory in Paths that doesn't already exist.
func (p Paths) Ensure() error {
	for _, dir := range []string{p.Config, p.Data, p.Models, p.Bin} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
