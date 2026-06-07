#!/bin/sh
# mnemiumd installer (Linux / macOS one-liner target)
#
# Fetches the latest release from GitHub, sha256-verifies, drops the
# binary in ~/.local/bin (or /usr/local/bin if writable). Override
# destination with MNEMIUM_BIN_DIR=/path/to/dir.
#
# v0.0 NOTE: no GitHub releases exist yet. This script is a placeholder
# that points the user at `go install` until GoReleaser is wired up.

set -e

cat <<EOF
mnemiumd installer
==================

This is v0.0 scaffolding. No pre-built releases exist yet. For now,
install from source:

  git clone https://github.com/msnotfound/mnemium ~/src/mnemium
  cd ~/src/mnemium/daemon
  go install ./cmd/mnemiumd

That puts the binary in \$(go env GOPATH)/bin (usually ~/go/bin or
~/.local/bin). Make sure that's on your PATH, then:

  mnemiumd serve

The first run generates a pairing string. Paste it into the Mnemium
extension:  Settings → System → Daemon pairing.

Releases via GoReleaser (curl-pipe-sh installer) land in v0.0.2.

EOF
