package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/hir4ta/claude-alfred/internal/spec"
)

// feedStdin replaces os.Stdin with a reader containing the given JSON event.
// Returns a cleanup function.
func feedStdin(t *testing.T, ev hookEvent) {
	t.Helper()
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	origStdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = origStdin })

	go func() {
		w.Write(data)
		w.Close()
	}()
}

func TestRunHook_SessionStart(t *testing.T) {
	dir := t.TempDir()

	// Create a spec so injectSpecContext has something to inject.
	sd, err := spec.Init(dir, "dispatch-test", "test dispatch")
	if err != nil {
		t.Fatalf("spec.Init: %v", err)
	}
	sd.WriteFile(spec.FileSession, "# Session: dispatch-test\n\n## Status\nactive\n\n## Currently Working On\nTesting dispatch\n")

	feedStdin(t, hookEvent{
		ProjectPath: dir,
		Source:      "startup",
	})

	output := captureStdout(t, func() {
		err := runHook("SessionStart")
		if err != nil {
			t.Fatalf("runHook error: %v", err)
		}
	})

	if output == "" {
		t.Error("expected spec context output for SessionStart with active spec")
	}
	if len(output) > 0 && !containsStr(output, "dispatch-test") {
		t.Errorf("output should contain task slug, got: %s", output)
	}
}

func TestRunHook_UserPromptSubmit_ConfigReminder(t *testing.T) {
	feedStdin(t, hookEvent{
		ProjectPath: t.TempDir(),
		Prompt:      "CLAUDE.md を改善して",
	})

	output := captureStdout(t, func() {
		runHook("UserPromptSubmit")
	})

	if !containsStr(output, "alfred") {
		t.Errorf("expected config reminder for CLAUDE.md mention, got: %s", output)
	}
}

func TestRunHook_InvalidJSON(t *testing.T) {
	// Feed invalid JSON to stdin.
	r, w, _ := os.Pipe()
	origStdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = origStdin })

	go func() {
		w.Write([]byte("not json"))
		w.Close()
	}()

	// Should not panic or return error.
	err := runHook("SessionStart")
	if err != nil {
		t.Errorf("expected nil error for invalid JSON, got: %v", err)
	}
}

func TestRunHook_UnknownEvent(t *testing.T) {
	feedStdin(t, hookEvent{ProjectPath: t.TempDir()})

	// Unknown event should be a no-op.
	err := runHook("UnknownEvent")
	if err != nil {
		t.Errorf("expected nil error for unknown event, got: %v", err)
	}
}

func TestRunHook_PreCompact_NoSpec(t *testing.T) {
	dir := t.TempDir()
	stubExecCommand(t, "")

	feedStdin(t, hookEvent{
		ProjectPath: dir,
	})

	output := captureStdout(t, func() {
		runHook("PreCompact")
	})

	if output != "" {
		t.Errorf("expected no output for PreCompact without spec, got: %s", output)
	}
}

func TestRunHook_EmptyStdin(t *testing.T) {
	r, w, _ := os.Pipe()
	origStdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() { os.Stdin = origStdin })

	go func() {
		w.Close() // empty
	}()

	err := runHook("SessionStart")
	if err != nil {
		t.Errorf("expected nil error for empty stdin, got: %v", err)
	}
}

func containsStr(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}

// Ensure captureStdout from hooks_test.go is available.
// It's in the same package so it's accessible.

// Suppress debug output during tests.
func init() {
	debugWriter = io.Discard
}
