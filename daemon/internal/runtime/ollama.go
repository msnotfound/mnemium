package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const ollamaEndpoint = "http://localhost:11434"

// ollamaReachable does a quick GET /api/version with a tight timeout.
func ollamaReachable() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ollamaEndpoint+"/api/version", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// installOllama downloads the platform-appropriate Ollama installer and
// hands control to the OS so the user can click through Gatekeeper
// (macOS), UAC (Windows), or pkexec (Linux). We can't fully automate any
// of these — Ollama installs system-level resources and that requires
// user consent on every platform.
//
// After spawning the installer we poll localhost:11434 for up to 5
// minutes; when it answers we mark the job done.
func installOllama(ctx context.Context, downloadsDir string, j *job) error {
	if err := os.MkdirAll(downloadsDir, 0o755); err != nil {
		return err
	}

	switch runtime.GOOS {
	case "linux":
		return installOllamaLinux(ctx, j)
	case "darwin":
		return installOllamaMac(ctx, downloadsDir, j)
	case "windows":
		return installOllamaWindows(ctx, downloadsDir, j)
	default:
		return fmt.Errorf("Ollama auto-install not supported on %s — see https://ollama.com/download", runtime.GOOS)
	}
}

// installOllamaLinux runs Ollama's install.sh via pkexec (graphical sudo
// prompt). If pkexec isn't installed we fall back to writing the
// command to a temp file and opening it with xdg-open so the user can
// run it in their terminal.
func installOllamaLinux(ctx context.Context, j *job) error {
	j.setStage("installing")
	if _, err := exec.LookPath("pkexec"); err == nil {
		j.setMessage("Requesting elevation via polkit (you'll see a password prompt)…")
		cmd := exec.CommandContext(ctx, "pkexec", "sh", "-c",
			"curl -fsSL https://ollama.com/install.sh | sh")
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err != nil {
			tail := strings.TrimSpace(out.String())
			if len(tail) > 400 {
				tail = "…" + tail[len(tail)-400:]
			}
			return fmt.Errorf("pkexec install.sh failed: %w (output: %s)", err, tail)
		}
		return waitForOllama(ctx, j, 5*time.Minute)
	}
	// Fallback: open the install command in the user's preferred handler.
	if _, err := exec.LookPath("xdg-open"); err == nil {
		j.setMessage("Opening Ollama install page (no pkexec found — install manually)")
		_ = exec.CommandContext(ctx, "xdg-open", "https://ollama.com/download/linux").Start()
	}
	return errors.New("pkexec not available; please install Ollama manually from https://ollama.com/download/linux, then click Retry")
}

// installOllamaMac downloads Ollama-darwin.zip, extracts Ollama.app into
// /Applications via `open`. Gatekeeper will prompt the user once.
func installOllamaMac(ctx context.Context, downloadsDir string, j *job) error {
	zipPath := filepath.Join(downloadsDir, "Ollama-darwin.zip")
	j.setStage("downloading")
	j.setMessage("Downloading Ollama for macOS")
	if err := downloadWithProgress(ctx, "https://ollama.com/download/Ollama-darwin.zip", zipPath, j); err != nil {
		return err
	}
	j.setStage("installing")
	j.setMessage("Opening the installer (you'll see a Finder window)…")
	if err := exec.CommandContext(ctx, "open", zipPath).Run(); err != nil {
		return fmt.Errorf("open Ollama installer: %w", err)
	}
	return waitForOllama(ctx, j, 5*time.Minute)
}

// installOllamaWindows downloads OllamaSetup.exe and spawns it; UAC will
// prompt the user to elevate.
func installOllamaWindows(ctx context.Context, downloadsDir string, j *job) error {
	exePath := filepath.Join(downloadsDir, "OllamaSetup.exe")
	j.setStage("downloading")
	j.setMessage("Downloading Ollama for Windows")
	if err := downloadWithProgress(ctx, "https://ollama.com/download/OllamaSetup.exe", exePath, j); err != nil {
		return err
	}
	j.setStage("installing")
	j.setMessage("Launching the installer (you'll see a UAC prompt)…")
	cmd := exec.CommandContext(ctx, "cmd", "/C", "start", "/wait", exePath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn OllamaSetup.exe: %w", err)
	}
	return waitForOllama(ctx, j, 5*time.Minute)
}

func waitForOllama(ctx context.Context, j *job, max time.Duration) error {
	j.setStage("ready")
	j.setMessage("Waiting for Ollama to come online…")
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if ollamaReachable() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("Ollama installer ran but the daemon never came online — check the installer logs and click Retry")
}

// pullOllamaModel proxies POST /api/pull and translates the streaming
// status events into our own snapshot updates. Ollama emits NDJSON
// (one JSON object per line) like:
//   {"status":"pulling manifest"}
//   {"status":"downloading","digest":"sha256:…","total":1234,"completed":56}
//   {"status":"success"}
func pullOllamaModel(ctx context.Context, model string, j *job) error {
	body, _ := json.Marshal(map[string]any{"name": model, "stream": true})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		ollamaEndpoint+"/api/pull", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 0} // streaming — no overall timeout
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("ollama pull: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("ollama pull %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	dec := json.NewDecoder(resp.Body)
	for {
		var ev struct {
			Status    string `json:"status"`
			Digest    string `json:"digest,omitempty"`
			Total     int64  `json:"total,omitempty"`
			Completed int64  `json:"completed,omitempty"`
			Error     string `json:"error,omitempty"`
		}
		if err := dec.Decode(&ev); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode ollama event: %w", err)
		}
		if ev.Error != "" {
			return errors.New(ev.Error)
		}
		if ev.Status != "" {
			j.setMessage(ev.Status)
		}
		if ev.Total > 0 {
			j.tick(ev.Completed, ev.Total)
		}
		if ev.Status == "success" {
			return nil
		}
	}
}

// downloadWithProgress is the shared HTTP+progress helper used by both
// the llama-server install and Ollama installer download. Range-resume
// isn't worth the complexity here — installer files are small (~50 MB)
// and these are one-shot operations.
func downloadWithProgress(ctx context.Context, url, dest string, j *job) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	total := resp.ContentLength
	r := &progressReader{src: resp.Body, j: j, total: total}
	_, err = io.Copy(out, r)
	return err
}

type progressReader struct {
	src   io.Reader
	j     *job
	total int64
	read  int64
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.src.Read(p)
	if n > 0 {
		pr.read += int64(n)
		pr.j.tick(pr.read, pr.total)
	}
	return n, err
}
