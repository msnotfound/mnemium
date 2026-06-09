package server

import (
	"context"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/msnotfound/mnemium/daemon/internal/backends/distill"
	"github.com/msnotfound/mnemium/daemon/internal/backends/vec"
	"github.com/msnotfound/mnemium/daemon/internal/config"
)

func (s *Server) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/distill", s.handleDistill)
	mux.HandleFunc("/embed", s.handleEmbed)
	mux.HandleFunc("/vec/upsert", s.handleVecUpsert)
	mux.HandleFunc("/vec/search", s.handleVecSearch)
	mux.HandleFunc("/vec/drop", s.handleVecDrop)
	mux.HandleFunc("/config", s.handleConfig)
	mux.HandleFunc("/model/download", s.handleModelDownload)
	mux.HandleFunc("/model/progress", s.handleModelProgress)
	mux.HandleFunc("/model/", s.handleModelByName) // DELETE /model/{name}
	mux.HandleFunc("/runtime/ensure", s.handleRuntimeEnsure)
	mux.HandleFunc("/runtime/install-ollama", s.handleRuntimeInstallOllama)
}

// ---- /status -------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	cfg, set := s.snapshot()
	available, _ := s.models.Available()
	downloading := []string{}
	for _, snap := range s.models.Snapshots() {
		if snap.Status == "running" {
			downloading = append(downloading, snap.Name)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "mnemiumd",
		"version": s.version,
		"backends": map[string]any{
			"distill": map[string]any{
				"kind":  cfg.Backends.Distill.Kind,
				"model": set.Distill.Model(),
				"ready": set.Distill.Ready(),
			},
			"embed": map[string]any{
				"kind":  cfg.Backends.Embed.Kind,
				"model": set.Embed.Model(),
				"ready": set.Embed.Ready(),
				"dim":   set.Embed.Dim(),
			},
			"vec": map[string]any{
				"kind":  cfg.Backends.Vec.Kind,
				"count": set.Vec.Count(r.Context()),
				"ready": set.Vec.Ready(),
			},
		},
		"models": map[string]any{
			"available":   available,
			"downloading": downloading,
		},
	})
}

// ---- /distill ------------------------------------------------------------

func (s *Server) handleDistill(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	_, set := s.snapshot()
	if !set.Distill.Ready() {
		backendUnavailable(w, "distill backend is not configured or not yet started")
		return
	}
	var req distill.Exchange
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	memories, entities, err := set.Distill.Distill(ctx, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "distill_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"memories": memories,
		"entities": entities,
	})
}

// ---- /embed --------------------------------------------------------------

type embedRequest struct {
	Texts []string `json:"texts"`
}

func (s *Server) handleEmbed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	_, set := s.snapshot()
	if !set.Embed.Ready() {
		backendUnavailable(w, "embed backend is not configured")
		return
	}
	var req embedRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	vectors, err := set.Embed.Embed(ctx, req.Texts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "embed_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"model":   set.Embed.Model(),
		"dim":     set.Embed.Dim(),
		"vectors": vectors,
	})
}

// ---- /vec/* --------------------------------------------------------------

type vecUpsertRequest struct {
	ModelID string    `json:"modelId"`
	Rows    []vec.Row `json:"rows"`
}

func (s *Server) handleVecUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	_, set := s.snapshot()
	if !set.Vec.Ready() {
		backendUnavailable(w, "vec backend is not configured")
		return
	}
	var req vecUpsertRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.ModelID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "modelId is required")
		return
	}
	n, err := set.Vec.Upsert(r.Context(), req.ModelID, req.Rows)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "vec_upsert_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upserted": n})
}

type vecSearchRequest struct {
	ModelID string      `json:"modelId"`
	Query   []float32   `json:"query"`
	K       int         `json:"k"`
	Filter  *vec.Filter `json:"filter,omitempty"`
}

func (s *Server) handleVecSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	_, set := s.snapshot()
	if !set.Vec.Ready() {
		backendUnavailable(w, "vec backend is not configured")
		return
	}
	var req vecSearchRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.K <= 0 {
		req.K = 16
	}
	hits, err := set.Vec.Search(r.Context(), req.ModelID, req.Query, req.K, req.Filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "vec_search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

type vecDropRequest struct {
	ModelID string `json:"modelId"`
}

func (s *Server) handleVecDrop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	_, set := s.snapshot()
	if !set.Vec.Ready() {
		backendUnavailable(w, "vec backend is not configured")
		return
	}
	var req vecDropRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.ModelID == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "modelId is required")
		return
	}
	if err := set.Vec.Drop(r.Context(), req.ModelID); err != nil {
		writeError(w, http.StatusInternalServerError, "vec_drop_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"dropped": true})
}

// ---- /config -------------------------------------------------------------

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		cfg, _ := s.snapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"listen":  cfg.Listen,
			"distill": cfg.Backends.Distill,
			"embed":   cfg.Backends.Embed,
			"vec":     cfg.Backends.Vec,
		})
	case http.MethodPut:
		var incoming struct {
			Listen   *string                       `json:"listen,omitempty"`
			Backends *struct {
				Distill *config.BackendSpec `json:"distill,omitempty"`
				Embed   *config.BackendSpec `json:"embed,omitempty"`
				Vec     *config.BackendSpec `json:"vec,omitempty"`
			} `json:"backends,omitempty"`
		}
		if err := readJSON(r, &incoming); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		cfg, _ := s.snapshot()
		if incoming.Listen != nil {
			cfg.Listen = *incoming.Listen
		}
		if incoming.Backends != nil {
			if incoming.Backends.Distill != nil {
				cfg.Backends.Distill = *incoming.Backends.Distill
			}
			if incoming.Backends.Embed != nil {
				cfg.Backends.Embed = *incoming.Backends.Embed
			}
			if incoming.Backends.Vec != nil {
				cfg.Backends.Vec = *incoming.Backends.Vec
			}
		}
		if err := config.Save(cfg); err != nil {
			writeError(w, http.StatusInternalServerError, "config_save_failed", err.Error())
			return
		}
		s.Reconfigure(cfg)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"listen":  cfg.Listen,
			"distill": cfg.Backends.Distill,
			"embed":   cfg.Backends.Embed,
			"vec":     cfg.Backends.Vec,
			"note":    "listen changes require a daemon restart to take effect",
		})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or PUT")
	}
}

// ---- /model/* (download manager) -----------------------------------------

type modelDownloadRequest struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256,omitempty"`
}

func (s *Server) handleModelDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	var req modelDownloadRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.Name == "" || req.URL == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "name and url are required")
		return
	}
	if strings.ContainsAny(req.Name, "/\\") {
		writeError(w, http.StatusBadRequest, "bad_request", "name must be a basename, no path separators")
		return
	}
	snap, err := s.models.Start(r.Context(), req.Name, req.URL, req.SHA256)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, snap)
}

func (s *Server) handleModelProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	// Merge model downloads (GGUF files) and runtime jobs (llama-server
	// install, Ollama install, ollama-pull) so the extension can render
	// everything in a single progress list.
	all := make([]map[string]any, 0)
	for _, snap := range s.models.Snapshots() {
		all = append(all, map[string]any{
			"name": snap.Name, "type": "hf-model", "stage": snap.Status,
			"total": snap.Total, "downloaded": snap.Downloaded, "percent": snap.Percent,
			"status": snap.Status, "error": snap.Error,
			"startedAt": snap.StartedAt, "finishedAt": snap.FinishedAt,
			"bytesPerSec": snap.BytesPerSec, "url": snap.URL,
		})
	}
	for _, snap := range s.runtime.Snapshots() {
		all = append(all, map[string]any{
			"name": snap.Name, "type": snap.Type, "stage": snap.Stage,
			"total": snap.Total, "downloaded": snap.Downloaded, "percent": snap.Percent,
			"status": snap.Status, "error": snap.Error, "message": snap.Message,
			"startedAt": snap.StartedAt, "finishedAt": snap.FinishedAt,
			"bytesPerSec": snap.BytesPerSec,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"downloads": all})
}

func (s *Server) handleModelByName(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/model/")
	name = path.Clean(name)
	if name == "" || name == "." || strings.ContainsAny(name, "/\\") {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid model name")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.models.Cancel(name); err != nil {
			// non-fatal — keep going to also try the disk delete
		}
		if err := s.models.Delete(name); err != nil {
			writeError(w, http.StatusInternalServerError, "model_delete_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "DELETE only")
	}
}

// ---- /runtime/* (dependency orchestration) -------------------------------

func (s *Server) handleRuntimeEnsure(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	cfg, _ := s.snapshot()
	jobs := s.runtime.EnsureConfig(r.Context(), cfg)
	// Backends re-resolve themselves on the next request after a job
	// completes (orchestrator handles its own lifecycle), but trigger an
	// immediate reconfigure so /status reflects whatever is now ready.
	s.Reconfigure(cfg)
	writeJSON(w, http.StatusAccepted, map[string]any{
		"started": jobs,
		"note":    "Poll GET /model/progress for live status.",
	})
}

func (s *Server) handleRuntimeInstallOllama(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	snap, err := s.runtime.InstallOllama(r.Context())
	if err != nil {
		writeError(w, http.StatusBadRequest, "install_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, snap)
}

// ---- error helpers -------------------------------------------------------

func backendUnavailable(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusServiceUnavailable, "backend_unavailable", msg)
}
