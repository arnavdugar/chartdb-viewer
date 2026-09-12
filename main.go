package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
)

type handler struct {
	dialect string
	assets  *os.Root
	schema  *os.Root
	done    chan struct{}
	mu      sync.Mutex
	changed chan struct{}
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := r.URL.Path
	switch path {
	case "/config":
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(struct {
				Dialect string `json:"dialect"`
			}{Dialect: h.dialect})
		}
		return
	case "/health", "/events":
		select {
		case <-h.done:
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		default:
		}
		if path == "/events" {
			h.events(w, r)
		}
		return
	}

	root, name := h.assets, strings.TrimPrefix(path, "/")
	switch {
	case path == "/schema.sql":
		root = h.schema
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	case path == "/":
		name = "index.html"
	case path == "/favicon.ico", strings.HasPrefix(path, "/assets/"):
	default:
		http.NotFound(w, r)
		return
	}
	// Root.Open confines paths and symlinks to the corresponding mounted directory.
	file, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, name, time.Time{}, file)
}

func (h *handler) events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	if r.Method == http.MethodHead {
		return
	}
	controller := http.NewResponseController(w)
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	h.mu.Lock()
	changed := h.changed
	h.mu.Unlock()
	message := "retry: 1000\nevent: schema\ndata: connected\n\n"
	for {
		if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return
		}
		if _, err := fmt.Fprint(w, message); err != nil {
			return
		}
		if err := controller.Flush(); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-h.done:
			return
		case <-changed:
			// Subscribe before sending, so a save during a write cannot be missed.
			h.mu.Lock()
			changed = h.changed
			h.mu.Unlock()
			message = "event: schema\ndata: changed\n\n"
		case <-heartbeat.C:
			// Connection keepalive only; this never reads the schema.
			message = ": heartbeat\n\n"
		}
	}
}

func (h *handler) watch(watcher *fsnotify.Watcher, schemaDirectory string) {
	defer close(h.done)
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if filepath.Clean(event.Name) == filepath.Clean(schemaDirectory) && event.Has(fsnotify.Remove|fsnotify.Rename) {
				log.Print("Schema directory moved or removed; restart ChartDB.")
				return
			}
			if filepath.Base(event.Name) == "schema.sql" && event.Has(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) {
				timer.Reset(100 * time.Millisecond)
			}
		case <-timer.C:
			h.mu.Lock()
			close(h.changed)
			h.changed = make(chan struct{})
			h.mu.Unlock()
		case err, ok := <-watcher.Errors:
			if ok {
				log.Printf("Schema watcher failed; restart ChartDB: %v", err)
			}
			return
		}
	}
}

func schemaDialect(value string) (string, error) {
	dialect := strings.ToLower(strings.TrimSpace(value))
	if dialect == "" {
		return "", fmt.Errorf("SCHEMA_DIALECT is required; expected postgresql, mysql, mariadb, sqlite, sql_server, oracle, or cockroachdb")
	}
	switch dialect {
	case "postgresql", "mysql", "mariadb", "sqlite", "sql_server", "oracle", "cockroachdb":
		return dialect, nil
	default:
		return "", fmt.Errorf("unsupported SCHEMA_DIALECT %q; expected postgresql, mysql, mariadb, sqlite, sql_server, oracle, or cockroachdb", value)
	}
}

func run() error {
	dialect, err := schemaDialect(os.Getenv("SCHEMA_DIALECT"))
	if err != nil {
		return err
	}
	schemaDirectory := os.Getenv("SCHEMA_DIRECTORY")
	port := cmp.Or(os.Getenv("PORT"), "80")
	assets, err := os.OpenRoot(os.Getenv("ASSETS_DIRECTORY"))
	if err != nil {
		return err
	}
	defer assets.Close()
	schema, err := os.OpenRoot(schemaDirectory)
	if err != nil {
		return err
	}
	defer schema.Close()
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := watcher.Add(schemaDirectory); err != nil {
		watcher.Close()
		return err
	}
	h := &handler{dialect: dialect, assets: assets, schema: schema, done: make(chan struct{}), changed: make(chan struct{})}
	go h.watch(watcher, schemaDirectory)
	defer func() {
		watcher.Close()
		<-h.done
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{
		Addr: ":" + port, Handler: h, ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	select {
	case err := <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
		}
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
