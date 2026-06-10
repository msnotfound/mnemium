// Package server hosts the HTTP API the extension talks to. Protocol
// spec: docs/MNEMIUMD-PROTOCOL.md.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/msnotfound/mnemium/daemon/internal/backends"
	"github.com/msnotfound/mnemium/daemon/internal/config"
	"github.com/msnotfound/mnemium/daemon/internal/models"
	"github.com/msnotfound/mnemium/daemon/internal/pairing"
	"github.com/msnotfound/mnemium/daemon/internal/runtime"
	"github.com/msnotfound/mnemium/daemon/internal/xdg"
)

// Server is the long-lived HTTP server.
type Server struct {
	mu       sync.RWMutex
	cfg      config.Config
	creds    pairing.Credentials
	version  string
	paths    xdg.Paths
	backends backends.Set
	models   *models.Manager
	runtime  *runtime.Orchestrator

	httpSrv  *http.Server
	listener net.Listener
}

// BoundAddr describes what address the server actually listened on.
type BoundAddr struct {
	Addr string
	Port int
}

// New constructs a Server. Call Listen() then Serve(). The resolver runs
// here so /status reflects real backend state from the first request.
func New(cfg config.Config, creds pairing.Credentials, version string, paths xdg.Paths) (*Server, error) {
	mgr, err := models.NewManager(paths.Models)
	if err != nil {
		return nil, fmt.Errorf("models manager: %w", err)
	}
	return &Server{
		cfg:      cfg,
		creds:    creds,
		version:  version,
		paths:    paths,
		backends: backends.Resolve(cfg, paths),
		models:   mgr,
		runtime:  runtime.New(paths),
	}, nil
}

// Reconfigure swaps backends in place after a PUT /config call. Closes
// the old set and replaces it with a freshly-resolved one. If the new
// backends spec is identical to the old one (same kind/model/endpoint/
// threads/ctx for all three), it's a no-op — onboarding flows can PUT
// /config repeatedly without thrashing the backend lifecycle.
func (s *Server) Reconfigure(cfg config.Config) {
	s.mu.Lock()
	if backendsEqual(s.cfg.Backends, cfg.Backends) {
		s.cfg.Listen = cfg.Listen
		s.mu.Unlock()
		log.Printf("[reconfigure] no-op (backends spec unchanged)")
		return
	}
	old := s.backends
	s.cfg = cfg
	s.backends = backends.Resolve(cfg, s.paths)
	newSet := s.backends
	s.mu.Unlock()
	old.Close()
	log.Printf("[reconfigure] backends now: distill=%s/%s embed=%s/%s vec=%s",
		cfg.Backends.Distill.Kind, newSet.Distill.Model(),
		cfg.Backends.Embed.Kind, newSet.Embed.Model(),
		cfg.Backends.Vec.Kind)
	// Re-warm in a goroutine so the HTTP response doesn't block on it.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		s.Warm(ctx)
	}()
}

func backendsEqual(a, b config.Backends) bool {
	return a.Distill == b.Distill && a.Embed == b.Embed && a.Vec == b.Vec
}

// Warm proactively spawns subprocess-backed backends (LlamaCPP). Designed
// to be called once from `mnemiumd serve` post-Listen and again from
// Reconfigure when the user switches backend kinds. Logs lifecycle + any
// per-backend errors but never returns error — best-effort.
func (s *Server) Warm(ctx context.Context) {
	_, set := s.snapshot()
	if model := set.Distill.Model(); model != "" {
		log.Printf("[warm] distill: starting (%s)", model)
		start := time.Now()
		if err := set.Distill.Warm(ctx); err != nil {
			log.Printf("[warm] distill: FAILED after %s: %v", time.Since(start).Round(time.Millisecond), err)
		} else {
			log.Printf("[warm] distill: ready in %s", time.Since(start).Round(time.Millisecond))
		}
	}
	if model := set.Embed.Model(); model != "" {
		log.Printf("[warm] embed: starting (%s)", model)
		start := time.Now()
		if err := set.Embed.Warm(ctx); err != nil {
			log.Printf("[warm] embed: FAILED after %s: %v", time.Since(start).Round(time.Millisecond), err)
		} else {
			log.Printf("[warm] embed: ready in %s (dim=%d)", time.Since(start).Round(time.Millisecond), set.Embed.Dim())
		}
	}
}

// snapshot returns a stable copy of cfg + backends for one request.
func (s *Server) snapshot() (config.Config, backends.Set) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg, s.backends
}

// Listen binds the configured address and returns the actual port (in
// case the user asked for :0 = auto-pick).
func (s *Server) Listen() (BoundAddr, error) {
	listenAddr := s.cfg.Listen
	if listenAddr == "" {
		listenAddr = "127.0.0.1:0"
	}
	lis, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return BoundAddr{}, err
	}
	s.listener = lis

	mux := http.NewServeMux()
	s.registerRoutes(mux)

	s.httpSrv = &http.Server{
		Handler:           s.middleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	tcp := lis.Addr().(*net.TCPAddr)
	return BoundAddr{Addr: lis.Addr().String(), Port: tcp.Port}, nil
}

// Serve blocks until the server stops.
func (s *Server) Serve() error {
	err := s.httpSrv.Serve(s.listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown gracefully stops the server and releases backend resources.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.backends.Close()
	s.mu.Unlock()
	if s.httpSrv == nil {
		return nil
	}
	return s.httpSrv.Shutdown(ctx)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Mnemiumd-Version", s.version)
		// CORS — the extension's origin is chrome-extension://<id>, which
		// varies per install. Allow all origins for the loopback API; auth
		// is enforced via bearer token so the wildcard is safe.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "authorization, content-type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
			return
		}

		start := time.Now()
		lrw := &loggingWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(lrw, r)
		log.Printf("%s %s %d %dms",
			r.Method, r.URL.Path, lrw.status, time.Since(start).Milliseconds())
	})
}

func (s *Server) authorized(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return false
	}
	return constantTimeEqual(header[len(prefix):], s.creds.Token)
}

// constantTimeEqual avoids leaking token length / contents via timing.
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		// Still walk the longer string so timing doesn't reveal length match.
		// One-pass XOR over a fixed window is fine for our scale.
		_ = a + b
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

type loggingWriter struct {
	http.ResponseWriter
	status int
}

func (w *loggingWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// ---- envelope helpers ---------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func readJSON(r *http.Request, into any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return fmt.Errorf("decode body: %w", err)
	}
	return nil
}

// parsePort splits "host:port" returning the trailing port number.
func parsePort(addr string) int {
	_, p, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(p)
	return n
}
