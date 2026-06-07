package server

import (
	"net/http"
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
}

// ---- /status -------------------------------------------------------------

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": "mnemiumd",
		"version": s.version,
		"backends": map[string]any{
			"distill": map[string]any{
				"kind":  s.cfg.Backends.Distill.Kind,
				"model": s.cfg.Backends.Distill.Model,
				"ready": false, // v0.0: no real backend implemented yet
			},
			"embed": map[string]any{
				"kind":  s.cfg.Backends.Embed.Kind,
				"model": s.cfg.Backends.Embed.Model,
				"ready": false,
				"dim":   0,
			},
			"vec": map[string]any{
				"kind":  s.cfg.Backends.Vec.Kind,
				"count": 0,
			},
		},
		"models": map[string]any{
			"available":   []string{},
			"downloading": []string{},
		},
	})
}

// ---- compute endpoints (all stubbed) -------------------------------------

func (s *Server) handleDistill(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	backendUnavailable(w, "distill backend not implemented in this build (v0.0 scaffolding)")
}

func (s *Server) handleEmbed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	backendUnavailable(w, "embed backend not implemented in this build (v0.0 scaffolding)")
}

func (s *Server) handleVecUpsert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	backendUnavailable(w, "vec backend not implemented in this build (v0.0 scaffolding)")
}

func (s *Server) handleVecSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	backendUnavailable(w, "vec backend not implemented in this build (v0.0 scaffolding)")
}

func (s *Server) handleVecDrop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	backendUnavailable(w, "vec backend not implemented in this build (v0.0 scaffolding)")
}

// ---- /config (read/write the persisted config) ---------------------------

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"distill": s.cfg.Backends.Distill,
			"embed":   s.cfg.Backends.Embed,
			"vec":     s.cfg.Backends.Vec,
		})
	case http.MethodPut:
		// v0.0: no live reconfig. Document the path: read body, persist via
		// config.Save, rebuild backends. Returning 501 until backends exist
		// so callers don't think they've changed something.
		writeError(w, http.StatusNotImplemented, "not_implemented",
			"runtime reconfig lands once real backends ship. Edit config.toml + restart for now.")
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or PUT")
	}
}

// ---- /model/* (download manager — also stubbed) --------------------------

func (s *Server) handleModelDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	writeError(w, http.StatusNotImplemented, "not_implemented",
		"model download manager not implemented in v0.0 scaffolding")
}

func (s *Server) handleModelProgress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET only")
		return
	}
	// Return an empty array so the extension's polling loop doesn't crash
	// while we wait for the real download manager.
	writeJSON(w, http.StatusOK, map[string]any{
		"downloads": []any{},
	})
}

func (s *Server) handleModelByName(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "DELETE only")
		return
	}
	writeError(w, http.StatusNotImplemented, "not_implemented",
		"model delete not implemented in v0.0 scaffolding")
}

// ---- error helpers -------------------------------------------------------

func backendUnavailable(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusServiceUnavailable, "backend_unavailable", msg)
}
