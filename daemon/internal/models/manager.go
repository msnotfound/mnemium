// Package models implements the model download manager. HTTP fetcher
// with Range resume, sha256 verification, atomic rename, and a snapshot
// channel the HTTP API polls for progress.
//
// Models are fetched into <Models>/<basename(url)>. Resumable downloads
// stage as <name>.part and atomically rename to <name> on success.
package models

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Manager owns concurrent downloads. Single instance per daemon.
type Manager struct {
	dir string

	mu      sync.Mutex
	jobs    map[string]*job // keyed by model name
	results map[string]Snapshot
}

// Snapshot is the per-download progress shape returned from
// GET /model/progress.
type Snapshot struct {
	Name        string  `json:"name"`
	URL         string  `json:"url"`
	Total       int64   `json:"total"`
	Downloaded  int64   `json:"downloaded"`
	Percent     float64 `json:"percent"`
	Status      string  `json:"status"` // "running" | "done" | "failed"
	Error       string  `json:"error,omitempty"`
	StartedAt   int64   `json:"startedAt"`
	FinishedAt  int64   `json:"finishedAt,omitempty"`
	BytesPerSec int64   `json:"bytesPerSec,omitempty"`
}

type job struct {
	name   string
	url    string
	sha    string
	cancel context.CancelFunc

	mu       sync.Mutex
	snap     Snapshot
	lastTick time.Time
	lastBytes int64
}

// NewManager constructs a manager rooted at modelsDir. The directory is
// created if it doesn't exist.
func NewManager(modelsDir string) (*Manager, error) {
	if modelsDir == "" {
		return nil, errors.New("models manager: dir is required")
	}
	if err := os.MkdirAll(modelsDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", modelsDir, err)
	}
	return &Manager{
		dir:     modelsDir,
		jobs:    map[string]*job{},
		results: map[string]Snapshot{},
	}, nil
}

// Dir returns the directory downloads land in.
func (m *Manager) Dir() string { return m.dir }

// Start kicks off a download if one isn't already running for this name.
// Idempotent — re-calling for an active job returns the running snapshot.
func (m *Manager) Start(ctx context.Context, name, downloadURL, expectedSHA256 string) (Snapshot, error) {
	if name == "" || downloadURL == "" {
		return Snapshot{}, errors.New("name and url are required")
	}
	if _, err := url.Parse(downloadURL); err != nil {
		return Snapshot{}, fmt.Errorf("invalid url: %w", err)
	}

	m.mu.Lock()
	if existing, ok := m.jobs[name]; ok {
		snap := existing.snapshot()
		m.mu.Unlock()
		return snap, nil
	}

	jobCtx, cancel := context.WithCancel(context.Background())
	j := &job{
		name:   name,
		url:    downloadURL,
		sha:    strings.ToLower(strings.TrimSpace(expectedSHA256)),
		cancel: cancel,
		snap: Snapshot{
			Name:      name,
			URL:       downloadURL,
			Status:    "running",
			StartedAt: time.Now().Unix(),
		},
		lastTick: time.Now(),
	}
	m.jobs[name] = j
	m.mu.Unlock()

	go m.run(jobCtx, j)

	return j.snapshot(), nil
}

// Cancel stops a running download. Returns nil if no job exists.
func (m *Manager) Cancel(name string) error {
	m.mu.Lock()
	j, ok := m.jobs[name]
	m.mu.Unlock()
	if !ok {
		return nil
	}
	j.cancel()
	return nil
}

// Delete removes a downloaded model file from disk.
func (m *Manager) Delete(name string) error {
	if strings.ContainsAny(name, "/\\") {
		return errors.New("name must be a basename, not a path")
	}
	target := filepath.Join(m.dir, name)
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	m.mu.Lock()
	delete(m.results, name)
	m.mu.Unlock()
	return nil
}

// Snapshots returns the current shape of every known download (active
// + completed). HTTP layer renders this directly.
func (m *Manager) Snapshots() []Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Snapshot, 0, len(m.jobs)+len(m.results))
	for _, j := range m.jobs {
		out = append(out, j.snapshot())
	}
	for _, r := range m.results {
		out = append(out, r)
	}
	return out
}

// Available scans the models directory and returns the basenames of
// finished downloads.
func (m *Manager) Available() ([]string, error) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".part") {
			continue
		}
		out = append(out, e.Name())
	}
	return out, nil
}

// run does the actual download. Handles Range resume + sha256 check +
// atomic rename + progress reporting.
func (m *Manager) run(ctx context.Context, j *job) {
	defer func() {
		m.mu.Lock()
		snap := j.snapshot()
		delete(m.jobs, j.name)
		m.results[j.name] = snap
		m.mu.Unlock()
	}()

	target := filepath.Join(m.dir, j.name)
	partial := target + ".part"

	var offset int64
	if info, err := os.Stat(partial); err == nil {
		offset = info.Size()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, j.url, nil)
	if err != nil {
		j.fail(err)
		return
	}
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		j.fail(err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		j.fail(fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body))))
		return
	}

	var openFlags int
	if resp.StatusCode == http.StatusPartialContent {
		openFlags = os.O_APPEND | os.O_WRONLY
	} else {
		offset = 0
		openFlags = os.O_CREATE | os.O_TRUNC | os.O_WRONLY
	}
	f, err := os.OpenFile(partial, openFlags, 0o644)
	if err != nil {
		j.fail(err)
		return
	}
	defer f.Close()

	total := resp.ContentLength
	if total > 0 {
		total += offset // ContentLength on 206 is the remaining bytes
	}
	hasher := sha256.New()
	// If we resumed, fold the existing bytes into the hash before reading
	// new ones. Otherwise sha verification at the end is wrong.
	if offset > 0 {
		if err := rehash(partial, hasher, offset); err != nil {
			j.fail(fmt.Errorf("rehash partial: %w", err))
			return
		}
	}

	reader := &progressReader{
		r:     resp.Body,
		j:     j,
		hash:  hasher,
		base:  offset,
		total: total,
	}
	if _, err := io.Copy(f, reader); err != nil {
		j.fail(err)
		return
	}
	if err := f.Sync(); err != nil {
		j.fail(err)
		return
	}

	if j.sha != "" {
		got := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(got, j.sha) {
			_ = os.Remove(partial)
			j.fail(fmt.Errorf("sha256 mismatch: got %s want %s", got, j.sha))
			return
		}
	}

	if err := os.Rename(partial, target); err != nil {
		j.fail(err)
		return
	}
	j.complete()
}

func rehash(path string, h io.Writer, n int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.CopyN(h, f, n)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// progressReader wraps the response body so each Read updates job state.
type progressReader struct {
	r     io.Reader
	j     *job
	hash  io.Writer
	base  int64
	read  int64
	total int64
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	if n > 0 {
		pr.read += int64(n)
		_, _ = pr.hash.Write(p[:n])
		pr.j.tick(pr.base+pr.read, pr.total)
	}
	return n, err
}

// ---- job helpers ---------------------------------------------------------

func (j *job) snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snap
}

func (j *job) tick(downloaded, total int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.snap.Downloaded = downloaded
	if total > 0 {
		j.snap.Total = total
		j.snap.Percent = float64(downloaded) / float64(total) * 100
	}
	now := time.Now()
	if elapsed := now.Sub(j.lastTick); elapsed >= time.Second {
		delta := downloaded - j.lastBytes
		j.snap.BytesPerSec = int64(float64(delta) / elapsed.Seconds())
		j.lastTick = now
		j.lastBytes = downloaded
	}
}

func (j *job) complete() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.snap.Status = "done"
	j.snap.FinishedAt = time.Now().Unix()
	if j.snap.Total > 0 {
		j.snap.Percent = 100
	}
}

func (j *job) fail(err error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.snap.Status = "failed"
	j.snap.Error = err.Error()
	j.snap.FinishedAt = time.Now().Unix()
}
