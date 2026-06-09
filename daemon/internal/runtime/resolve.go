// Package runtime owns dependency lifecycle for backends that need
// outside-the-binary helpers: llama-server (auto-fetched from llama.cpp
// releases), Ollama (detected on localhost, model pulls proxied). The
// download manager dispatches jobs into this package.
package runtime

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
