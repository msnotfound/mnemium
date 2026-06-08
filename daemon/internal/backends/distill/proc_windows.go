//go:build windows

package distill

import "os/exec"

// Windows has no process group concept that maps cleanly here — we leave
// SysProcAttr unset and let Process.Kill() take down the child directly.
func configureProcAttr(_ *exec.Cmd) {}

func terminateProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}
