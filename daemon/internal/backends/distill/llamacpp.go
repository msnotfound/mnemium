package distill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/msnotfound/mnemium/daemon/internal/runtime"
)

// LlamaCPP wraps a managed llama-server subprocess from the llama.cpp
// project. We POST OpenAI-shaped chat completions to it on a private
// port. Lifecycle: start lazily on first call, health-check, restart on
// crash, kill on Close().
//
// The user provides:
//   - a model GGUF file (resolved via Models dir or absolute path)
//   - an optional binary path (defaults to $PATH lookup of "llama-server")
//
// We pick a free port internally; the user never has to think about it.
type LlamaCPP struct {
	modelPath string
	binPath   string
	threads   int
	ctxSize   int

	mu      sync.Mutex
	proc    *exec.Cmd
	port    int
	client  *http.Client
	started bool
}

// NewLlamaCPP constructs the wrapper. Doesn't spawn yet.
//
// modelsDir is the directory where downloaded GGUF files live; if model
// is a bare name (no path separator) it's resolved relative to modelsDir.
// Otherwise it's treated as an absolute path.
//
// binDir is mnemiumd's auto-install location for llama-server (XDG bin).
// We check, in order: $MNEMIUM_LLAMA_SERVER → <binDir>/llama-server[.exe]
// → system $PATH. The runtime ensure flow populates <binDir>; users with
// custom (GPU) builds can override via env or PATH.
func NewLlamaCPP(modelsDir, binDir, model string, threads, ctxSize int) (*LlamaCPP, error) {
	if model == "" {
		return nil, errors.New("llama-cpp distill: model is required")
	}
	bin, err := runtime.LlamaServerBinary(binDir)
	if err != nil {
		return nil, err
	}
	modelPath := model
	if !filepath.IsAbs(model) && modelsDir != "" {
		// Treat bare names as references to <modelsDir>/<name>.gguf
		// (or <modelsDir>/<name> if it already has an extension).
		candidate := filepath.Join(modelsDir, model)
		if ext := filepath.Ext(candidate); ext == "" {
			candidate += ".gguf"
		}
		modelPath = candidate
	}
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model file %s not found: %w", modelPath, err)
	}
	if ctxSize == 0 {
		ctxSize = 4096
	}
	return &LlamaCPP{
		modelPath: modelPath,
		binPath:   bin,
		threads:   threads,
		ctxSize:   ctxSize,
		client:    &http.Client{Timeout: 120 * time.Second},
	}, nil
}

func (l *LlamaCPP) Ready() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.started
}

func (l *LlamaCPP) Model() string { return filepath.Base(l.modelPath) }

// ensureStarted spawns llama-server if it isn't already up. Caller must
// hold l.mu.
func (l *LlamaCPP) ensureStarted(ctx context.Context) error {
	if l.started && l.proc != nil && l.proc.ProcessState == nil {
		return nil
	}
	port, err := pickFreePort()
	if err != nil {
		return fmt.Errorf("pick port: %w", err)
	}
	args := []string{
		"--model", l.modelPath,
		"--host", "127.0.0.1",
		"--port", strconv.Itoa(port),
		"--ctx-size", strconv.Itoa(l.ctxSize),
	}
	if l.threads > 0 {
		args = append(args, "--threads", strconv.Itoa(l.threads))
	}
	cmd := exec.Command(l.binPath, args...)
	cmd.Stdout = os.Stderr // route llama-server logs to our stderr
	cmd.Stderr = os.Stderr
	configureProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn llama-server: %w", err)
	}
	l.proc = cmd
	l.port = port

	// Healthcheck loop — wait up to 60s for the server to accept requests.
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if l.healthy(ctx) {
			l.started = true
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = l.killUnlocked()
	return errors.New("llama-server didn't become healthy within 60s")
}

func (l *LlamaCPP) healthy(ctx context.Context) bool {
	url := fmt.Sprintf("http://127.0.0.1:%d/health", l.port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := l.client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

func (l *LlamaCPP) Distill(ctx context.Context, ex Exchange) ([]Memory, []Entity, error) {
	l.mu.Lock()
	if err := l.ensureStarted(ctx); err != nil {
		l.mu.Unlock()
		return nil, nil, err
	}
	port := l.port
	l.mu.Unlock()

	reqBody := openaiChatRequest{
		Model:       "local",
		Temperature: 0.2,
		Messages: []openaiMessage{
			{Role: "system", Content: SystemPrompt},
			{Role: "user", Content: BuildUserPrompt(ex)},
		},
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/v1/chat/completions", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("llama-server chat: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, nil, fmt.Errorf("llama-server chat %d: %s", resp.StatusCode, string(raw))
	}
	var out openaiChatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, nil, fmt.Errorf("decode llama-server response: %w", err)
	}
	if len(out.Choices) == 0 {
		return nil, nil, errors.New("llama-server: empty choices")
	}
	return ParseResponse(out.Choices[0].Message.Content, scopeURIFor(ex))
}

// Close stops the subprocess if it's running. Idempotent.
func (l *LlamaCPP) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.killUnlocked()
}

func (l *LlamaCPP) killUnlocked() error {
	if l.proc == nil || l.proc.Process == nil {
		return nil
	}
	// Kill the whole process group on unix (llama-server may fork helpers).
	// On Windows we fall back to Process.Kill().
	terminateProcess(l.proc)
	// Give it 3 seconds to exit cleanly.
	done := make(chan error, 1)
	go func() { done <- l.proc.Wait() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = l.proc.Process.Kill()
		<-done
	}
	l.started = false
	l.proc = nil
	l.port = 0
	return nil
}

// pickFreePort opens a TCP socket bound to :0, reads the assigned port,
// and closes it — the kernel reuses the port for our child for a brief
// window. Race-able but fine for local single-user.
func pickFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
