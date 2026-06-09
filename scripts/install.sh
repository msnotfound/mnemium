#!/bin/sh
# Mnemium daemon installer for Linux + macOS.
#
# Usage (one-liner):
#   curl -fsSL https://github.com/msnotfound/mnemium/releases/latest/download/install.sh | sh
#
# What it does:
#   1. Detects OS + CPU arch.
#   2. Resolves the latest release tag via GitHub's API.
#   3. Downloads the matching tarball + checksums.txt.
#   4. Verifies SHA-256.
#   5. Extracts mnemiumd into ~/.local/bin (or /usr/local/bin if writable).
#
# Override the install dir with MNEMIUM_BIN_DIR=/path before running.

set -e

repo="msnotfound/mnemium"
bin_name="mnemiumd"

say() { printf '==> %s\n' "$*"; }
ok()  { printf '    %s\n' "$*"; }
die() { printf '!!! %s\n' "$*" >&2; exit 1; }

# ---- detect OS + arch -----------------------------------------------------
uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
    Linux)  goos=linux ;;
    Darwin) goos=darwin ;;
    *)      die "Unsupported OS: $uname_s. See https://github.com/$repo/releases for manual install." ;;
esac

case "$uname_m" in
    x86_64|amd64)  goarch=amd64 ;;
    aarch64|arm64) goarch=arm64 ;;
    *)             die "Unsupported architecture: $uname_m" ;;
esac

say "Platform: ${goos}/${goarch}"

# ---- resolve latest release ----------------------------------------------
say "Resolving latest release"
api="https://api.github.com/repos/$repo/releases/latest"
release_json=$(curl -fsSL -H "User-Agent: mnemium-installer" "$api") || {
    die "Failed to query GitHub. Private repo? Use the manual download path on the releases page."
}

tag=$(printf '%s' "$release_json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$tag" ] || die "Could not parse release tag from GitHub response."
ok "Latest is $tag"

asset_name="mnemiumd_${tag}_${goos}_${goarch}.tar.gz"
alt_name="mnemiumd-${goos}-${goarch}.tar.gz"

# Find the asset URL by exact-name match.
asset_url=$(printf '%s' "$release_json" \
    | tr ',' '\n' \
    | grep -F "$asset_name" \
    | grep browser_download_url \
    | head -1 \
    | sed -n 's/.*"\(https:[^"]*\)".*/\1/p')

if [ -z "$asset_url" ]; then
    asset_url=$(printf '%s' "$release_json" \
        | tr ',' '\n' \
        | grep -F "$alt_name" \
        | grep browser_download_url \
        | head -1 \
        | sed -n 's/.*"\(https:[^"]*\)".*/\1/p')
    [ -n "$asset_url" ] && asset_name=$alt_name
fi

[ -n "$asset_url" ] || die "No asset matching mnemiumd-${goos}-${goarch}.tar.gz in release $tag"

sums_url=$(printf '%s' "$release_json" \
    | tr ',' '\n' \
    | grep -F '"name": "checksums.txt"' \
    | grep browser_download_url \
    | head -1 \
    | sed -n 's/.*"\(https:[^"]*\)".*/\1/p')

# ---- download + verify + extract -----------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t mnemium-install)
trap 'rm -rf "$tmp"' EXIT

archive="$tmp/$asset_name"
say "Downloading $asset_name"
curl -fSL --progress-bar -o "$archive" "$asset_url"

if [ -n "$sums_url" ]; then
    say "Verifying SHA-256"
    curl -fsSL -o "$tmp/checksums.txt" "$sums_url"
    expected=$(grep -F "$asset_name" "$tmp/checksums.txt" | awk '{print $1}' | head -1)
    [ -n "$expected" ] || die "checksums.txt has no entry for $asset_name"

    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$archive" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$archive" | awk '{print $1}')
    else
        die "Neither sha256sum nor shasum available — install one or use the manual download path."
    fi

    [ "$actual" = "$expected" ] || die "SHA-256 mismatch! expected $expected, got $actual"
    ok "SHA-256 verified"
else
    printf '    (no checksums.txt — skipping verification)\n'
fi

say "Extracting"
( cd "$tmp" && tar xzf "$archive" )

extracted=$(find "$tmp" -name "$bin_name" -type f | head -1)
[ -n "$extracted" ] || die "Archive didn't contain '$bin_name'"

# ---- pick install dir -----------------------------------------------------
if [ -n "$MNEMIUM_BIN_DIR" ]; then
    install_dir="$MNEMIUM_BIN_DIR"
elif [ -w /usr/local/bin ] 2>/dev/null; then
    install_dir=/usr/local/bin
else
    install_dir="$HOME/.local/bin"
fi

mkdir -p "$install_dir"
install_path="$install_dir/$bin_name"

say "Installing to $install_path"
mv "$extracted" "$install_path"
chmod 0755 "$install_path"
ok "Installed"

# ---- PATH check -----------------------------------------------------------
case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        printf '\n'
        printf '%s\n' "    Note: $install_dir is not on your PATH."
        printf '%s\n' "    Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
        printf '%s\n' "        export PATH=\"$install_dir:\$PATH\""
        ;;
esac

printf '\n'
printf 'Done. Next:\n'
printf '  1. Run:  mnemiumd serve\n'
printf '  2. Copy the pairing string it prints\n'
printf '  3. Paste it into the Mnemium extension (Settings -> System -> Daemon pairing)\n'
printf '\n'
printf 'Need the extension? Grab mnemium-extension.zip from the same release:\n'
printf '  https://github.com/%s/releases/tag/%s\n' "$repo" "$tag"
