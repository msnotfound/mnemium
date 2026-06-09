// mnemiumd — local helper binary that gives the Mnemium browser
// extension a private, on-device "second brain" (distillation,
// embeddings, vector search). Protocol spec lives at
// docs/MNEMIUMD-PROTOCOL.md in the mnemium repo.
//
// v0.0 scaffolding: HTTP server + pairing flow + protocol envelopes.
// Compute backends are stubbed and return 503 backend_unavailable.
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/msnotfound/mnemium/daemon/internal/config"
	"github.com/msnotfound/mnemium/daemon/internal/pairing"
	"github.com/msnotfound/mnemium/daemon/internal/server"
)

const version = "0.0.3"

func main() {
	root := &cobra.Command{
		Use:           "mnemiumd",
		Short:         "Local compute helper for the Mnemium browser extension",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.AddCommand(serveCmd(), pairCmd(), configCmd(), versionCmd())

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "mnemiumd:", err)
		os.Exit(1)
	}
}

func serveCmd() *cobra.Command {
	var (
		listen string
		print  bool
	)
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start the HTTP server on localhost and print a pairing string",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.LoadOrCreate()
			if err != nil {
				return fmt.Errorf("load config: %w", err)
			}
			creds, err := pairing.LoadOrIssue()
			if err != nil {
				return fmt.Errorf("issue pairing creds: %w", err)
			}
			if listen != "" {
				cfg.Listen = listen
			}
			if cfg.Listen == "" {
				cfg.Listen = "127.0.0.1:0"
			}

			paths := config.Paths()
			if err := paths.Ensure(); err != nil {
				return fmt.Errorf("ensure paths: %w", err)
			}
			srv, err := server.New(cfg, creds, version, paths)
			if err != nil {
				return fmt.Errorf("init server: %w", err)
			}

			bound, err := srv.Listen()
			if err != nil {
				return fmt.Errorf("listen: %w", err)
			}
			// Persist the actually-bound port for the extension to read.
			if err := pairing.WritePort(bound.Port); err != nil {
				return fmt.Errorf("write port file: %w", err)
			}

			if print {
				fmt.Printf("mn:%d:%s\n", bound.Port, creds.Token)
			} else {
				fmt.Println("mnemiumd listening on", bound.Addr)
				fmt.Println("pairing string:")
				fmt.Printf("    mn:%d:%s\n", bound.Port, creds.Token)
				fmt.Println("paste it into Mnemium → Settings → System → Daemon pairing")
				fmt.Println()
				fmt.Println("ctrl-c to stop.")
			}

			return srv.Serve()
		},
	}
	cmd.Flags().StringVar(&listen, "listen", "", "override listen address (e.g. 127.0.0.1:8442). default: auto-pick port")
	cmd.Flags().BoolVar(&print, "print-pairing", false, "print only the pairing string (mn:port:token) and silence other output")
	return cmd
}

func pairCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pair",
		Short: "Print the current pairing string (does not start the server)",
		RunE: func(cmd *cobra.Command, args []string) error {
			port, err := pairing.ReadPort()
			if err != nil {
				return fmt.Errorf("no running daemon: %w", err)
			}
			creds, err := pairing.LoadOrIssue()
			if err != nil {
				return err
			}
			fmt.Printf("mn:%d:%s\n", port, creds.Token)
			return nil
		},
	}
}

func configCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect daemon configuration",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "show",
		Short: "Print resolved paths and active config",
		RunE: func(cmd *cobra.Command, args []string) error {
			paths := config.Paths()
			fmt.Println("config:  ", paths.Config)
			fmt.Println("data:    ", paths.Data)
			fmt.Println("models:  ", paths.Models)
			fmt.Println("vectors: ", paths.Vectors)
			fmt.Println("port:    ", paths.PortFile)
			fmt.Println("token:   ", paths.TokenFile)
			cfg, err := config.LoadOrCreate()
			if err != nil {
				return err
			}
			fmt.Println()
			fmt.Println("listen: ", cfg.Listen)
			fmt.Println("distill:", cfg.Backends.Distill.Kind, "/", cfg.Backends.Distill.Model)
			fmt.Println("embed:  ", cfg.Backends.Embed.Kind, "/", cfg.Backends.Embed.Model)
			fmt.Println("vec:    ", cfg.Backends.Vec.Kind)
			return nil
		},
	})
	return cmd
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("mnemiumd", version)
		},
	}
}
