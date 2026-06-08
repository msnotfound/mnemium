//go:build unix

package distill

import (
	"os/exec"
	"syscall"
)

// configureProcAttr puts the child into its own process group so we can
// SIGTERM the whole group cleanly on shutdown (llama-server may fork
// CUDA helpers etc.).
func configureProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateProcess sends SIGTERM to the child's process group; falls back
// to a single-process signal if the group lookup fails.
func terminateProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if pgid, err := syscall.Getpgid(cmd.Process.Pid); err == nil {
		_ = syscall.Kill(-pgid, syscall.SIGTERM)
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
}
