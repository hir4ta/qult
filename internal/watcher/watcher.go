package watcher

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/hir4ta/claude-alfred/internal/parser"
)

const (
	scanBufInitSize = 256 * 1024  // initial scanner buffer size
	scanBufMaxSize  = 1024 * 1024 // max scanner buffer size

	// sessionFollowInterval is how often we check for a new session.
	sessionFollowInterval = 5 * time.Second
	// sessionStaleThreshold is how long without updates before we look for a new session.
	sessionStaleThreshold = 10 * time.Second
)

// WatchResult holds both initial events and the channel for new events.
type WatchResult struct {
	InitialEvents []parser.SessionEvent
	EventCh       <-chan parser.SessionEvent
}

// Watch monitors a JSONL file for new lines and sends parsed events to a channel.
// Initial existing events are returned as a slice (non-blocking).
// New events are sent to the channel.
func Watch(ctx context.Context, jsonlPath string, tailOnly bool) (*WatchResult, error) {
	ch := make(chan parser.SessionEvent, 64)

	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create watcher: %w", err)
	}

	// Start watching BEFORE reading existing content to avoid race condition
	if err := fw.Add(jsonlPath); err != nil {
		fw.Close()
		return nil, fmt.Errorf("watch file: %w", err)
	}

	info, err := os.Stat(jsonlPath)
	if err != nil {
		fw.Close()
		return nil, fmt.Errorf("stat file: %w", err)
	}

	var offset int64
	var initial []parser.SessionEvent

	if tailOnly {
		offset = info.Size()
	} else {
		initial, offset, err = readExisting(jsonlPath)
		if err != nil {
			fw.Close()
			return nil, fmt.Errorf("read existing: %w", err)
		}
	}

	go func() {
		defer fw.Close()
		defer close(ch)

		// Fallback: poll file size every 2s in case fsnotify misses writes
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()

		// Session following: check for new sessions in the same project
		followTicker := time.NewTicker(sessionFollowInterval)
		defer followTicker.Stop()

		currentPath := jsonlPath
		lastActivity := time.Now()

		readIfGrown := func() {
			fi, err := os.Stat(currentPath)
			if err != nil {
				return
			}
			if fi.Size() > offset {
				newOffset, err := readNewLines(currentPath, offset, ch)
				if err != nil {
					log.Printf("read new lines: %v", err)
					return
				}
				offset = newOffset
				lastActivity = time.Now()
			}
		}

		// switchToSession switches to watching a new JSONL file.
		// Reads all existing content from the new file and updates watcher state.
		switchToSession := func(newPath string) {
			// Read all events from the new file
			events, newOffset, err := readExisting(newPath)
			if err != nil {
				log.Printf("read new session: %v", err)
				return
			}

			// Send events to channel
			for _, ev := range events {
				ch <- ev
			}

			// Switch fsnotify watcher
			_ = fw.Remove(currentPath)
			if err := fw.Add(newPath); err != nil {
				log.Printf("watch new session: %v", err)
				// Keep watching old file
				_ = fw.Add(currentPath)
				return
			}

			currentPath = newPath
			offset = newOffset
			lastActivity = time.Now()
		}

		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-fw.Events:
				if !ok {
					return
				}
				if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
					readIfGrown()
				}
			case <-ticker.C:
				readIfGrown()
			case <-followTicker.C:
				// Check if session is stale and a new one exists
				if time.Since(lastActivity) < sessionStaleThreshold {
					continue
				}
				newPath := findNewerSession(currentPath)
				if newPath != "" {
					switchToSession(newPath)
				}
			case err, ok := <-fw.Errors:
				if !ok {
					return
				}
				log.Printf("watcher error: %v", err)
			}
		}
	}()

	return &WatchResult{
		InitialEvents: initial,
		EventCh:       ch,
	}, nil
}


// findNewerSession looks for a JSONL file in the same project directory
// that is newer than the current file. Returns empty string if none found.
func findNewerSession(currentPath string) string {
	dir := filepath.Dir(currentPath)
	currentBase := filepath.Base(currentPath)

	currentInfo, err := os.Stat(currentPath)
	if err != nil {
		return ""
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}

	var newest string
	var newestMod time.Time

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".jsonl") || name == currentBase {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		// Must be newer than current file
		if info.ModTime().After(currentInfo.ModTime()) && info.ModTime().After(newestMod) {
			// Must have been recently modified (within last 30 seconds)
			if time.Since(info.ModTime()) < 30*time.Second {
				newest = filepath.Join(dir, name)
				newestMod = info.ModTime()
			}
		}
	}

	return newest
}

func readExisting(path string) ([]parser.SessionEvent, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, scanBufInitSize), scanBufMaxSize)

	var events []parser.SessionEvent
	for scanner.Scan() {
		line := scanner.Bytes()
		parsed, err := parser.ParseLine(line)
		if err != nil {
			continue
		}
		events = append(events, parsed...)
	}

	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return events, 0, err
	}
	return events, offset, nil
}

func readNewLines(path string, offset int64, ch chan<- parser.SessionEvent) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return offset, err
	}
	defer f.Close()

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, err
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, scanBufInitSize), scanBufMaxSize)

	for scanner.Scan() {
		line := scanner.Bytes()
		events, err := parser.ParseLine(line)
		if err != nil {
			continue
		}
		for _, ev := range events {
			ch <- ev
		}
	}

	newOffset, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		return offset, err
	}
	return newOffset, nil
}
