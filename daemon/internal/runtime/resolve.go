// Package runtime owns dependency lifecycle for backends that need
// outside-the-binary helpers: llama-server (auto-fetched from llama.cpp
// releases), Ollama (detected on localhost, model pulls proxied). The
// download manager dispatches jobs into this package.
package runtime

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
)

// LlamaServerBinary picks the llama-server path in this order:
//   1. $MNEMIUM_LLAMA_SERVER          — explicit user override
//   2. <binDir>/llama-server[.exe]    — auto-installed by us
//   3. exec.LookPath("llama-server")  — system PATH
//
// Returns ("", error) when none exist so callers can decide whether to
// kick off an install job.
func LlamaServerBinary(binDir string) (string, error) {
	if env := os.Getenv("MNEMIUM_LLAMA_SERVER"); env != "" {
		if _, err := os.Stat(env); err == nil {
			return env, nil
		}
		return "", fmt.Errorf("MNEMIUM_LLAMA_SERVER=%s but file does not exist", env)
	}
	candidate := filepath.Join(binDir, llamaServerBinName())
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		// Auto-heal missing soname symlinks (e.g. libllama-common.so.0 →
		// libllama-common.so.0.0.9585). Pre-v0.0.9 the tar extractor
		// dropped tar.TypeSymlink entries, leaving installs that look
		// complete but where llama-server fails at dynamic-linker time
		// with 'cannot open shared object file'. Idempotent and cheap.
		if n, err := repairLlamaSonames(binDir); err != nil {
			log.Printf("[runtime] soname repair in %s failed: %v", binDir, err)
		} else if n > 0 {
			log.Printf("[runtime] created %d missing soname symlinks in %s (legacy install repair)", n, binDir)
		}
		return candidate, nil
	}
	if path, err := exec.LookPath("llama-server"); err == nil {
		return path, nil
	}
	return "", errLlamaServerMissing
}

var errLlamaServerMissing = errors.New("llama-server binary not found (auto-install via POST /runtime/ensure)")

// IsLlamaServerMissing reports whether the error from LlamaServerBinary
// means "nothing's installed yet" (vs. a real failure like a bad
// MNEMIUM_LLAMA_SERVER override).
func IsLlamaServerMissing(err error) bool {
	return errors.Is(err, errLlamaServerMissing)
}

func llamaServerBinName() string {
	if runtime.GOOS == "windows" {
		return "llama-server.exe"
	}
	return "llama-server"
}

// versionedSoRE matches libXYZ.so.MAJOR.MINOR(.PATCH...) — the versioned
// shared-library filename pattern. Group 1 is the "soname" (lib + first
// version component) that the dynamic linker actually opens.
//
//   libllama-common.so.0.0.9585  →  libllama-common.so.0
//   libggml-base.so.0.14.0       →  libggml-base.so.0
//
// Skipped: plain libfoo.so, libfoo.so.0 (already the soname).
var versionedSoRE = regexp.MustCompile(`^(.+\.so\.\d+)(\.\d+)+$`)

// repairLlamaSonames creates missing soname symlinks for any versioned
// shared library files found in binDir. Only operates on the *.so naming
// convention (Linux); Darwin .dylib and Windows .dll don't use this
// soname pattern. Returns the number of symlinks created.
//
// Skipped when running on platforms where soname symlinks aren't used.
func repairLlamaSonames(binDir string) (int, error) {
	if runtime.GOOS == "windows" {
		return 0, nil
	}
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		// Only act on regular files, not existing symlinks.
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := entry.Name()
		m := versionedSoRE.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		soname := m[1]
		target := filepath.Join(binDir, soname)
		if _, err := os.Lstat(target); err == nil {
			continue // already exists as file or symlink
		}
		if err := os.Symlink(name, target); err != nil {
			return created, fmt.Errorf("symlink %s → %s: %w", target, name, err)
		}
		created++
	}
	return created, nil
}
