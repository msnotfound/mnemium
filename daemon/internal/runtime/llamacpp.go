package runtime

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const llamaReleasesAPI = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"

// installLlamaServer fetches the latest llama.cpp release for the user's
// platform, downloads the CPU-build asset, extracts llama-server into
// binDir, and sets the executable bit. Reports progress through j.
func installLlamaServer(ctx context.Context, binDir string, j *job) error {
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", binDir, err)
	}

	j.setStage("downloading")
	j.setMessage("Querying llama.cpp releases…")

	assetURL, assetName, err := pickLlamaAsset(ctx)
	if err != nil {
		return err
	}
	j.setMessage("Downloading " + assetName)

	archivePath := filepath.Join(binDir, ".llama-asset"+assetExt(assetName))
	if err := downloadWithProgress(ctx, assetURL, archivePath, j); err != nil {
		_ = os.Remove(archivePath)
		return fmt.Errorf("download %s: %w", assetURL, err)
	}

	j.setStage("extracting")
	j.setMessage("Extracting " + llamaServerBinName())

	if err := extractLlamaServer(archivePath, binDir); err != nil {
		_ = os.Remove(archivePath)
		return fmt.Errorf("extract: %w", err)
	}
	_ = os.Remove(archivePath)

	j.setMessage("Installed to " + filepath.Join(binDir, llamaServerBinName()))
	return nil
}

func assetExt(name string) string {
	if strings.HasSuffix(name, ".tar.gz") {
		return ".tar.gz"
	}
	return filepath.Ext(name)
}

// pickLlamaAsset hits GitHub's releases API and returns the download
// URL for the right CPU build for the user's OS+arch.
func pickLlamaAsset(ctx context.Context) (url string, name string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, llamaReleasesAPI, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", "", fmt.Errorf("github releases %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var release struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name        string `json:"name"`
			DownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", "", fmt.Errorf("decode releases: %w", err)
	}

	wants := assetPatternsFor(runtime.GOOS, runtime.GOARCH)
	if len(wants) == 0 {
		return "", "", fmt.Errorf("no known llama.cpp asset pattern for %s/%s — set MNEMIUM_LLAMA_SERVER manually", runtime.GOOS, runtime.GOARCH)
	}
	for _, want := range wants {
		for _, asset := range release.Assets {
			lower := strings.ToLower(asset.Name)
			if want(lower) {
				return asset.DownloadURL, asset.Name, nil
			}
		}
	}
	available := make([]string, 0, len(release.Assets))
	for _, a := range release.Assets {
		available = append(available, a.Name)
	}
	return "", "", fmt.Errorf("no matching asset in release %s for %s/%s. Available: %s",
		release.TagName, runtime.GOOS, runtime.GOARCH, strings.Join(available, ", "))
}

// assetPatternsFor returns predicates to match against asset filenames.
// Tried in order; the first match wins, so list "more specific" first.
// We deliberately prefer CPU-only builds — the GPU variants are 5-50×
// larger and most users don't need them on first install.
func assetPatternsFor(goos, goarch string) []func(string) bool {
	contains := func(parts ...string) func(string) bool {
		return func(s string) bool {
			for _, p := range parts {
				if !strings.Contains(s, p) {
					return false
				}
			}
			return true
		}
	}
	excludes := func(base func(string) bool, bads ...string) func(string) bool {
		return func(s string) bool {
			if !base(s) {
				return false
			}
			for _, b := range bads {
				if strings.Contains(s, b) {
					return false
				}
			}
			return true
		}
	}
	// llama.cpp ships `.tar.gz` for Linux/macOS and `.zip` for Windows.
	// They include CUDA/Vulkan/HIP/ROCm/OpenVINO variants we want to
	// avoid — pick CPU-only by excluding GPU-runtime keywords.
	gpuKeywords := []string{"cuda", "vulkan", "hip", "rocm", "sycl", "openvino", "opencl"}
	switch goos {
	case "linux":
		switch goarch {
		case "amd64":
			return []func(string) bool{
				excludes(contains("ubuntu", "x64", ".tar.gz"), gpuKeywords...),
				excludes(contains("linux", "x64", ".tar.gz"), gpuKeywords...),
			}
		case "arm64":
			return []func(string) bool{
				excludes(contains("ubuntu", "arm64", ".tar.gz"), gpuKeywords...),
				excludes(contains("linux", "arm64", ".tar.gz"), gpuKeywords...),
			}
		}
	case "darwin":
		switch goarch {
		case "arm64":
			return []func(string) bool{contains("macos", "arm64", ".tar.gz")}
		case "amd64":
			return []func(string) bool{contains("macos", "x64", ".tar.gz")}
		}
	case "windows":
		switch goarch {
		case "amd64":
			return []func(string) bool{
				contains("win", "cpu", "x64", ".zip"),
				excludes(contains("win", "x64", ".zip"), gpuKeywords...),
			}
		case "arm64":
			return []func(string) bool{contains("win", "cpu", "arm64", ".zip")}
		}
	}
	return nil
}

// extractLlamaServer reads the downloaded archive and pulls just the
// llama-server binary plus its sibling shared libraries into binDir.
// Release archives also include llama-cli, llama-quantize, etc. — we
// don't ship all of that. Routes to tar.gz or zip based on extension.
func extractLlamaServer(archivePath, binDir string) error {
	switch {
	case strings.HasSuffix(archivePath, ".tar.gz"):
		return extractTarGz(archivePath, binDir)
	case strings.HasSuffix(archivePath, ".zip"):
		return extractZip(archivePath, binDir)
	default:
		return fmt.Errorf("unknown archive type for %s (expected .tar.gz or .zip)", archivePath)
	}
}

func isLlamaInterestingFile(base string) (binary, lib bool) {
	binName := llamaServerBinName()
	if base == binName {
		return true, false
	}
	for _, ext := range []string{".so", ".dylib", ".dll", ".so.*"} {
		if strings.HasSuffix(base, strings.TrimSuffix(ext, ".*")) {
			return false, true
		}
	}
	// Catch versioned .so files (e.g. libggml.so.1).
	if strings.Contains(base, ".so.") {
		return false, true
	}
	return false, false
}

func extractZip(archivePath, binDir string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()
	wroteBinary := false
	for _, f := range r.File {
		base := filepath.Base(f.Name)
		isBin, isLib := isLlamaInterestingFile(base)
		if !isBin && !isLib {
			continue
		}
		dest := filepath.Join(binDir, base)
		src, err := f.Open()
		if err != nil {
			return err
		}
		if err := writeFile(dest, src); err != nil {
			src.Close()
			return err
		}
		src.Close()
		if isBin {
			if err := os.Chmod(dest, 0o755); err != nil {
				return err
			}
			wroteBinary = true
		}
	}
	if !wroteBinary {
		return errors.New("llama-server binary not found in zip archive")
	}
	return nil
}

func extractTarGz(archivePath, binDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	wroteBinary := false
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		base := filepath.Base(hdr.Name)
		isBin, isLib := isLlamaInterestingFile(base)
		if !isBin && !isLib {
			continue
		}
		dest := filepath.Join(binDir, base)
		switch hdr.Typeflag {
		case tar.TypeReg, tar.TypeRegA:
			if err := writeFile(dest, tr); err != nil {
				return err
			}
			if isBin {
				if err := os.Chmod(dest, 0o755); err != nil {
					return err
				}
				wroteBinary = true
			}
		case tar.TypeSymlink:
			// Symlinks carry the soname aliases (e.g. libllama.so.0 →
			// libllama.so.0.0.9585). Without them llama-server's dynamic
			// loader can't resolve its own deps and the binary fails to
			// start with 'cannot open shared object file'. Remove existing
			// entry first so re-install works.
			_ = os.Remove(dest)
			if err := os.Symlink(hdr.Linkname, dest); err != nil {
				return fmt.Errorf("symlink %s → %s: %w", dest, hdr.Linkname, err)
			}
		}
	}
	if !wroteBinary {
		return errors.New("llama-server binary not found in tar.gz archive")
	}
	return nil
}

func writeFile(dest string, src io.Reader) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}
