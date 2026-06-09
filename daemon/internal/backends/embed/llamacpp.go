package embed

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

// LlamaCPP wraps a managed `llama-server --embedding` subprocess. POSTs
// to its /embedding endpoint, which returns [{embedding: [..]}, ...].
type LlamaCPP struct {
	modelPath string
	binPath   string
	threads   int

	mu      sync.Mutex
	proc    *exec.Cmd
	port    int
	client  *http.Client
	started bool
	dim     int
}

func NewLlamaCPP(modelsDir, binDir, model string, threads int) (*LlamaCPP, error) {
	if model == "" {
		return nil, errors.New("llama-cpp embed: model is required")
	}
	bin, err := runtime.LlamaServerBinary(binDir)
	if err != nil {
		return nil, err
	}
	modelPath := model
	if !filepath.IsAbs(model) && modelsDir != "" {
		candidate := filepath.Join(modelsDir, model)
		if ext := filepath.Ext(candidate); ext == "" {
			candidate += ".gguf"
		}
		modelPath = candidate
	}
	if _, statErr := os.Stat(modelPath); statErr != nil {
		return nil, fmt.Errorf("model file %s not found: %w", modelPath, statErr)
	}
	return &LlamaCPP{
		modelPath: modelPath,
		binPath:   bin,
		threads:   threads,
		client:    &http.Client{Timeout: 120 * time.Second},
	}, nil
}

func (l *LlamaCPP) Ready() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.started
}

func (l *LlamaCPP) Model() string { return filepath.Base(l.modelPath) }

func (l *LlamaCPP) Dim() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.dim
}

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
		"--embedding",
	}
	if l.threads > 0 {
		args = append(args, "--threads", strconv.Itoa(l.threads))
	}
	cmd := exec.Command(l.binPath, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	configureProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn llama-server (embed): %w", err)
	}
	l.proc = cmd
	l.port = port

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if l.healthy(ctx) {
			l.started = true
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = l.killUnlocked()
	return errors.New("llama-server (embed) didn't become healthy within 60s")
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

type llamaEmbedRequest struct {
	Content []string `json:"content"`
}

type llamaEmbedResponse []struct {
	Embedding []float32 `json:"embedding"`
	Index     int       `json:"index"`
}

func (l *LlamaCPP) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	l.mu.Lock()
	if err := l.ensureStarted(ctx); err != nil {
		l.mu.Unlock()
		return nil, err
	}
	port := l.port
	l.mu.Unlock()

	body, err := json.Marshal(llamaEmbedRequest{Content: texts})
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/embedding", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("llama-server embed: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("llama-server embed %d: %s", resp.StatusCode, string(raw))
	}
	var out llamaEmbedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode llama-server embed: %w", err)
	}
	result := make([][]float32, len(out))
	for _, row := range out {
		idx := row.Index
		if idx < 0 || idx >= len(result) {
			continue
		}
		result[idx] = row.Embedding
	}
	if len(result) > 0 && len(result[0]) > 0 {
		l.mu.Lock()
		l.dim = len(result[0])
		l.mu.Unlock()
	}
	return result, nil
}

func (l *LlamaCPP) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.killUnlocked()
}

func (l *LlamaCPP) killUnlocked() error {
	if l.proc == nil || l.proc.Process == nil {
		return nil
	}
	terminateProcess(l.proc)
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

func pickFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
