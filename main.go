package main

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"little-map/pkg/api"
	"little-map/pkg/config"
	"little-map/pkg/mcpserver"
	"little-map/pkg/service"
	"little-map/pkg/store"
)

//go:embed all:web/dist
var embeddedWeb embed.FS

func main() {
	cfg := config.Load()
	loc := cfg.Location()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				a.Value = slog.StringValue(time.Now().In(loc).Format(time.RFC3339))
			}
			return a
		},
	}))
	slog.SetDefault(logger)

	st, err := store.Open(cfg.DBPath, loc)
	if err != nil {
		slog.Error("open database failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	if cfg.ListMaps {
		printStoredMaps(st, cfg.BaseURL)
		return
	}

	svc := service.New(st, cfg)
	mcpHandler := mcpserver.NewHandler(svc, cfg)

	webFS, err := fs.Sub(embeddedWeb, "web/dist")
	if err != nil {
		slog.Error("load embedded web assets failed", "err", err)
		os.Exit(1)
	}

	router := api.NewRouter(svc, mcpHandler, webFS)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("little-map listening", "addr", cfg.Addr, "db", cfg.DBPath, "mcp", "/mcp")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server error", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down server")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("graceful shutdown failed", "err", err)
	}
}

func printStoredMaps(st *store.Store, baseURL string) {
	maps, err := st.ListMaps(context.Background())
	if err != nil {
		slog.Error("list maps failed", "err", err)
		os.Exit(1)
	}
	if len(maps) == 0 {
		fmt.Println("(no maps found)")
		return
	}
	for _, m := range maps {
		fmt.Printf("[%s] %s (%d features, updated %s)\n", m.ID, m.Title, m.FeatureCount, m.UpdatedAt)
		fmt.Printf("  view: %s/?m=%s\n", baseURL, m.ID)
		fmt.Printf("  edit: %s/?m=%s&t=%s\n", baseURL, m.ID, m.EditToken)
	}
}
