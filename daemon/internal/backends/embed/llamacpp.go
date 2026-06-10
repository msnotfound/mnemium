package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/msnotfound/mnemium/daemon/internal/runtime"
)

// LlamaCPP wraps a managed `llama-server --embedding` subprocess. POSTs
// to its /embedding endpoint, which returns [{embedding: [..]}, ...].
type LlamaCPP struct {
	modelPath string
	binPath   string
	threads   int

	mu     sync.Mutex
	proc   *exec.Cmd
	port   int
	client *http.Client
	// Atomic so Ready() / Dim() / State() / Message() are lock-free reads.
	// Warm() holds l.mu for up to 60s; without atomics, /status would
	// block for the entire warmup window and the extension would time out.
	started atomic.Bool
	dim     atomic.Int32
	state   atomic.Int32
	message atomic.Pointer[string]
}

const (
	embedStateIdle    int32 = 0
	embedStateWarming int32 = 1
	embedStateReady   int32 = 2
	embedStateFailed  int32 = 3
)

func embedStateName(s int32) string {
	switch s {
	case embedStateWarming:
		return "warming"
	case embedStateReady:
		return "ready"
	case embedStateFailed:
		return "failed"
	default:
		return "idle"
	}
}

func (l *LlamaCPP) setState(s int32, msg string) {
	l.state.Store(s)
	m := msg
	l.message.Store(&m)
}

func (l *LlamaCPP) State() string { return embedStateName(l.state.Load()) }
func (l *LlamaCPP) Message() string {
	p := l.message.Load()
	if p == nil {
		return ""
	}
	return *p
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
	return l.started.Load()
}

func (l *LlamaCPP) Model() string { return filepath.Base(l.modelPath) }

func (l *LlamaCPP) Dim() int {
	return int(l.dim.Load())
}

// Warm spawns llama-server --embedding proactively so the first /embed
// call doesn't pay the cold-start tax.
func (l *LlamaCPP) Warm(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.ensureStarted(ctx)
}

func (l *LlamaCPP) ensureStarted(ctx context.Context) error {
	if l.started.Load() && l.proc != nil && l.proc.ProcessState == nil {
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
	log.Printf("[embed/llama-cpp] spawning %s --model %s --port %d --embedding", l.binPath, filepath.Base(l.modelPath), port)
	l.setState(embedStateWarming, fmt.Sprintf("spawning llama-server --embedding (model=%s)", filepath.Base(l.modelPath)))
	cmd := exec.Command(l.binPath, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	configureProcAttr(cmd)
	startedAt := time.Now()
	if err := cmd.Start(); err != nil {
		l.setState(embedStateFailed, fmt.Sprintf("spawn failed: %v", err))
		return fmt.Errorf("spawn llama-server (embed): %w", err)
	}
	l.proc = cmd
	l.port = port
	log.Printf("[embed/llama-cpp] spawned pid=%d port=%d — waiting for healthcheck", cmd.Process.Pid, port)
	l.setState(embedStateWarming, fmt.Sprintf("loading model weights (pid=%d)", cmd.Process.Pid))

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if l.healthy(ctx) {
			l.started.Store(true)
			elapsed := time.Since(startedAt).Round(time.Millisecond)
			l.setState(embedStateReady, fmt.Sprintf("ready in %s", elapsed))
			log.Printf("[embed/llama-cpp] ready in %s (port=%d model=%s)", elapsed, port, filepath.Base(l.modelPath))
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	log.Printf("[embed/llama-cpp] healthcheck timed out after 60s; killing subprocess")
	l.setState(embedStateFailed, "healthcheck timed out after 60s")
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
		l.dim.Store(int32(len(result[0])))
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
	l.started.Store(false)
	l.setState(embedStateIdle, "subprocess stopped")
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
