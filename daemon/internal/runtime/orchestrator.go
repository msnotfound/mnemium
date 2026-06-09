package runtime

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/msnotfound/mnemium/daemon/internal/config"
	"github.com/msnotfound/mnemium/daemon/internal/xdg"
)

// Orchestrator coordinates higher-level dependency lifecycle (install
// llama-server, install Ollama, pull an Ollama model). The model
// downloader (internal/models) handles plain GGUF fetches; this owns
// everything that's "more than a file download" — zip extract, OS
// installer spawn, ollama-pull stream proxying. Snapshots are tracked
// here; the HTTP layer merges them with models.Manager snapshots in
// /model/progress.
type Orchestrator struct {
	paths xdg.Paths

	mu      sync.Mutex
	jobs    map[string]*job
	history map[string]Snapshot
}

// Snapshot mirrors models.Snapshot but adds Type + Stage so the UI can
// render the right copy ("Downloading llama-server" vs "Pulling
// qwen2.5:1.5b via Ollama" vs "Verifying").
type Snapshot struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`  // "llama-server" | "ollama-install" | "ollama-pull"
	Stage       string  `json:"stage"` // "downloading" | "extracting" | "installing" | "pulling" | "ready"
	Total       int64   `json:"total"`
	Downloaded  int64   `json:"downloaded"`
	Percent     float64 `json:"percent"`
	Status      string  `json:"status"` // "running" | "done" | "failed"
	Error       string  `json:"error,omitempty"`
	Message     string  `json:"message,omitempty"`
	StartedAt   int64   `json:"startedAt"`
	FinishedAt  int64   `json:"finishedAt,omitempty"`
	BytesPerSec int64   `json:"bytesPerSec,omitempty"`
}

type job struct {
	name string
	cancel context.CancelFunc

	mu       sync.Mutex
	snap     Snapshot
	lastTick time.Time
	lastBytes int64
}

// New constructs an Orchestrator.
func New(paths xdg.Paths) *Orchestrator {
	return &Orchestrator{
		paths:   paths,
		jobs:    map[string]*job{},
		history: map[string]Snapshot{},
	}
}

// Snapshots returns the current view of runtime jobs (running + history).
func (o *Orchestrator) Snapshots() []Snapshot {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]Snapshot, 0, len(o.jobs)+len(o.history))
	for _, j := range o.jobs {
		out = append(out, j.snapshot())
	}
	for _, s := range o.history {
		out = append(out, s)
	}
	return out
}

// EnsureLlamaServer kicks off a llama-server install job if no job is
// already running for it. Idempotent — if a binary is already on disk,
// returns a "ready" snapshot without doing work.
func (o *Orchestrator) EnsureLlamaServer(_ context.Context) (Snapshot, error) {
	const name = "llama-server"
	if path, err := LlamaServerBinary(o.paths.Bin); err == nil {
		ready := Snapshot{
			Name: name, Type: "llama-server", Stage: "ready", Status: "done",
			Message: "already installed at " + path,
			StartedAt: time.Now().Unix(), FinishedAt: time.Now().Unix(),
		}
		o.mu.Lock()
		o.history[name] = ready
		o.mu.Unlock()
		return ready, nil
	}

	return o.spawn(name, "llama-server", func(ctx context.Context, j *job) error {
		return installLlamaServer(ctx, o.paths.Bin, j)
	})
}

// InstallOllama downloads + launches the platform-appropriate Ollama
// installer. Idempotent: if Ollama is already reachable, returns a
// "ready" snapshot. The actual install on macOS/Windows requires user
// click-through (Gatekeeper / UAC) — we can't bypass those.
func (o *Orchestrator) InstallOllama(_ context.Context) (Snapshot, error) {
	const name = "ollama"
	if ollamaReachable() {
		ready := Snapshot{
			Name: name, Type: "ollama-install", Stage: "ready", Status: "done",
			Message: "Ollama already running on http://localhost:11434",
			StartedAt: time.Now().Unix(), FinishedAt: time.Now().Unix(),
		}
		o.mu.Lock()
		o.history[name] = ready
		o.mu.Unlock()
		return ready, nil
	}

	return o.spawn(name, "ollama-install", func(ctx context.Context, j *job) error {
		return installOllama(ctx, o.paths.Models, j)
	})
}

// PullOllamaModel proxies an `ollama pull` call, streaming progress as
// our own snapshot updates. Errors out if Ollama isn't reachable —
// caller should InstallOllama first (or surface the install CTA).
func (o *Orchestrator) PullOllamaModel(_ context.Context, model string) (Snapshot, error) {
	if model == "" {
		return Snapshot{}, errors.New("model is required")
	}
	if !ollamaReachable() {
		return Snapshot{}, errors.New("Ollama is not running on http://localhost:11434 — call POST /runtime/install-ollama or start it")
	}
	name := "ollama-pull:" + model
	return o.spawn(name, "ollama-pull", func(ctx context.Context, j *job) error {
		j.setStage("pulling")
		return pullOllamaModel(ctx, model, j)
	})
}

// EnsureConfig inspects cfg, kicks off whatever's needed to make all the
// listed backends usable, and returns the resulting snapshots. Job IDs
// are stable so the extension can poll without race issues if it
// double-calls.
func (o *Orchestrator) EnsureConfig(ctx context.Context, cfg config.Config) []Snapshot {
	out := []Snapshot{}
	seen := map[string]bool{}

	consider := func(spec config.BackendSpec) {
		switch spec.Kind {
		case "llama-cpp":
			if !seen["llama-server"] {
				snap, err := o.EnsureLlamaServer(ctx)
				if err != nil {
					out = append(out, failedSnap("llama-server", "llama-server", err))
				} else {
					out = append(out, snap)
				}
				seen["llama-server"] = true
			}
			// Note: GGUF model downloads are kicked off by the extension via
			// /model/download with URLs from the model registry. We don't
			// duplicate that here.
		case "ollama":
			if !seen["ollama"] {
				snap, err := o.InstallOllama(ctx)
				if err != nil {
					out = append(out, failedSnap("ollama", "ollama-install", err))
				} else {
					out = append(out, snap)
				}
				seen["ollama"] = true
			}
			if spec.Model != "" {
				key := "ollama-pull:" + spec.Model
				if !seen[key] {
					snap, err := o.PullOllamaModel(ctx, spec.Model)
					if err != nil {
						out = append(out, failedSnap(key, "ollama-pull", err))
					} else {
						out = append(out, snap)
					}
					seen[key] = true
				}
			}
		}
	}

	consider(cfg.Backends.Distill)
	consider(cfg.Backends.Embed)
	return out
}

// spawn registers a new job and runs runner in the background. Idempotent
// per name — if a job with the same name is already running, returns its
// current snapshot.
func (o *Orchestrator) spawn(name, jobType string, runner func(context.Context, *job) error) (Snapshot, error) {
	o.mu.Lock()
	if existing, ok := o.jobs[name]; ok {
		snap := existing.snapshot()
		o.mu.Unlock()
		return snap, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &job{
		name:   name,
		cancel: cancel,
		snap: Snapshot{
			Name:      name,
			Type:      jobType,
			Stage:     "downloading",
			Status:    "running",
			StartedAt: time.Now().Unix(),
		},
		lastTick: time.Now(),
	}
	o.jobs[name] = j
	o.mu.Unlock()

	go func() {
		err := runner(ctx, j)
		o.mu.Lock()
		if err != nil {
			j.fail(err)
		} else {
			j.complete()
		}
		snap := j.snapshot()
		delete(o.jobs, name)
		o.history[name] = snap
		o.mu.Unlock()
	}()

	return j.snapshot(), nil
}

// Cancel stops a running job by name. Returns nil if it doesn't exist.
func (o *Orchestrator) Cancel(name string) {
	o.mu.Lock()
	j, ok := o.jobs[name]
	o.mu.Unlock()
	if !ok {
		return
	}
	j.cancel()
}

// ---- job state helpers --------------------------------------------------

func (j *job) snapshot() Snapshot {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.snap
}

func (j *job) setStage(stage string) {
	j.mu.Lock()
	j.snap.Stage = stage
	j.mu.Unlock()
}

func (j *job) setMessage(msg string) {
	j.mu.Lock()
	j.snap.Message = msg
	j.mu.Unlock()
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
	j.snap.Stage = "ready"
	j.snap.Status = "done"
	j.snap.FinishedAt = time.Now().Unix()
	if j.snap.Total > 0 {
		j.snap.Percent = 100
	}
}

func (j *job) fail(err error) {
	j.snap.Status = "failed"
	j.snap.Error = err.Error()
	j.snap.FinishedAt = time.Now().Unix()
}

func failedSnap(name, jobType string, err error) Snapshot {
	return Snapshot{
		Name:       name,
		Type:       jobType,
		Status:     "failed",
		Error:      err.Error(),
		StartedAt:  time.Now().Unix(),
		FinishedAt: time.Now().Unix(),
	}
}

