// Package pairing manages the bearer token + port file used by the
// browser extension to discover and authenticate to mnemiumd.
//
// Token is 32 random bytes, base64-url encoded. Persisted to
// ~/.local/share/mnemium/mnemium-token (0600 perms) so it survives
// daemon restarts. The pairing string the user pastes into the
// extension is mn:<port>:<token> — extension parses via
// src/ui/components/rpc.ts parsePairingString.
package pairing

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/msnotfound/mnemium/daemon/internal/xdg"
)

// Credentials carries the bearer token used by every authenticated RPC.
type Credentials struct {
	Token string
}

// LoadOrIssue returns the persisted token if one exists, else generates
// a fresh one and writes it. Token bytes are 32 (256 bits of entropy).
func LoadOrIssue() (Credentials, error) {
	paths := xdg.Resolve()
	if err := paths.Ensure(); err != nil {
		return Credentials{}, err
	}

	bytes, err := os.ReadFile(paths.TokenFile)
	if err == nil {
		token := strings.TrimSpace(string(bytes))
		if token != "" {
			return Credentials{Token: token}, nil
		}
	} else if !os.IsNotExist(err) {
		return Credentials{}, fmt.Errorf("read %s: %w", paths.TokenFile, err)
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return Credentials{}, fmt.Errorf("generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	tmp := paths.TokenFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		return Credentials{}, fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, paths.TokenFile); err != nil {
		os.Remove(tmp)
		return Credentials{}, err
	}
	return Credentials{Token: token}, nil
}

// WritePort records the actually-bound port so `mnemiumd pair` and the
// extension's autodetect can find a running instance.
func WritePort(port int) error {
	paths := xdg.Resolve()
	if err := paths.Ensure(); err != nil {
		return err
	}
	tmp := paths.PortFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.Itoa(port)+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, paths.PortFile)
}

// ReadPort returns the most recently bound port. Returns an error if no
// daemon has ever run (port file missing).
func ReadPort() (int, error) {
	paths := xdg.Resolve()
	bytes, err := os.ReadFile(paths.PortFile)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, errors.New("port file missing — start the daemon with `mnemiumd serve` first")
		}
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(bytes)))
}
