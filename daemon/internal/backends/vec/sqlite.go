// Pure-Go vector store: modernc.org/sqlite for durable rows + brute-force
// cosine scan for similarity. Good for the v0.1 footprint (tens of
// thousands of memories per user). When sqlite-vec lands its cgo
// extension we'll swap that in behind the same Backend interface — no
// schema migration needed since we already store vectors as raw blobs.
package vec

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// Sqlite is the brute-force backend. Single-user, single-writer.
type Sqlite struct {
	path string
	db   *sql.DB
	mu   sync.Mutex
}

// NewSqlite opens (or creates) the vectors database at the given path.
func NewSqlite(path string) (*Sqlite, error) {
	if path == "" {
		return nil, errors.New("sqlite vec: path is required")
	}
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS vectors (
			model_id TEXT NOT NULL,
			id       TEXT NOT NULL,
			scope    TEXT NOT NULL,
			type     TEXT NOT NULL,
			dim      INTEGER NOT NULL,
			vec      BLOB NOT NULL,
			PRIMARY KEY (model_id, id)
		);
		CREATE INDEX IF NOT EXISTS idx_vectors_scope ON vectors(model_id, scope);
		CREATE INDEX IF NOT EXISTS idx_vectors_type  ON vectors(model_id, type);
	`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Sqlite{path: path, db: db}, nil
}

func (s *Sqlite) Ready() bool { return s.db != nil }

func (s *Sqlite) Count(ctx context.Context) int {
	if s.db == nil {
		return 0
	}
	row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM vectors`)
	var n int
	_ = row.Scan(&n)
	return n
}

func (s *Sqlite) Upsert(ctx context.Context, modelID string, rows []Row) (int, error) {
	if len(rows) == 0 {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO vectors(model_id, id, scope, type, dim, vec)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(model_id, id) DO UPDATE SET
			scope = excluded.scope,
			type  = excluded.type,
			dim   = excluded.dim,
			vec   = excluded.vec`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	written := 0
	for _, r := range rows {
		if len(r.Vec) == 0 {
			continue
		}
		if _, err := stmt.ExecContext(ctx, modelID, r.ID, r.Scope, r.Type, len(r.Vec), encodeVec(r.Vec)); err != nil {
			return written, err
		}
		written++
	}
	if err := tx.Commit(); err != nil {
		return written, err
	}
	return written, nil
}

func (s *Sqlite) Search(ctx context.Context, modelID string, query []float32, k int, filter *Filter) ([]Hit, error) {
	if len(query) == 0 || k <= 0 {
		return nil, nil
	}
	// Build the scan query — pre-filter by scope prefix and/or type to
	// keep brute-force cost down on large stores.
	var (
		conds = []string{"model_id = ?"}
		args  = []any{modelID}
	)
	if filter != nil {
		if filter.ScopePrefix != "" {
			conds = append(conds, "scope LIKE ?")
			args = append(args, filter.ScopePrefix+"%")
		}
		if len(filter.Type) > 0 {
			placeholders := strings.Repeat("?,", len(filter.Type))
			placeholders = placeholders[:len(placeholders)-1]
			conds = append(conds, "type IN ("+placeholders+")")
			for _, t := range filter.Type {
				args = append(args, t)
			}
		}
	}
	sqlText := "SELECT id, vec FROM vectors WHERE " + strings.Join(conds, " AND ")
	rows, err := s.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	qnorm := norm(query)
	if qnorm == 0 {
		return nil, nil
	}
	hits := make([]Hit, 0, 256)
	for rows.Next() {
		var (
			id  string
			buf []byte
		)
		if err := rows.Scan(&id, &buf); err != nil {
			return nil, err
		}
		vec := decodeVec(buf)
		if len(vec) != len(query) {
			continue
		}
		hits = append(hits, Hit{ID: id, Score: cosine(query, vec, qnorm)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > k {
		hits = hits[:k]
	}
	return hits, nil
}

func (s *Sqlite) Drop(ctx context.Context, modelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `DELETE FROM vectors WHERE model_id = ?`, modelID)
	return err
}

func (s *Sqlite) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

// ---- encoding -----------------------------------------------------------

func encodeVec(v []float32) []byte {
	buf := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(f))
	}
	return buf
}

func decodeVec(buf []byte) []float32 {
	if len(buf)%4 != 0 {
		return nil
	}
	out := make([]float32, len(buf)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[i*4:]))
	}
	return out
}

func norm(v []float32) float64 {
	var s float64
	for _, x := range v {
		s += float64(x) * float64(x)
	}
	return math.Sqrt(s)
}

// cosine assumes qnorm = ||q||. Returns similarity normalized into [0,1]
// (where 1.0 = identical direction, 0.5 = orthogonal, 0 = opposite).
func cosine(q, v []float32, qnorm float64) float64 {
	var (
		dot   float64
		vnorm float64
	)
	for i, x := range q {
		fx := float64(x)
		fv := float64(v[i])
		dot += fx * fv
		vnorm += fv * fv
	}
	if vnorm == 0 {
		return 0
	}
	sim := dot / (qnorm * math.Sqrt(vnorm))
	return (sim + 1) / 2
}
