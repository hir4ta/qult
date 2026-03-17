package store

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// ProjectInfo holds project identification data.
type ProjectInfo struct {
	Remote string // git remote URL (empty if not a git repo)
	Path   string // absolute directory path
	Name   string // human-readable project name
	Branch string // current git branch (empty if not a git repo)
}

// DetectProject identifies a project from its directory path.
// Uses git remote URL as the primary identifier, falls back to directory path.
func DetectProject(dirPath string) ProjectInfo {
	absPath, err := filepath.Abs(dirPath)
	if err != nil {
		absPath = dirPath
	}

	info := ProjectInfo{
		Path: absPath,
		Name: filepath.Base(absPath),
	}

	info.Remote = detectGitRemote(absPath)
	info.Branch = detectGitBranch(absPath)

	// Use repo name from remote URL if available.
	if info.Remote != "" {
		if name := repoNameFromRemote(info.Remote); name != "" {
			info.Name = name
		}
	}

	return info
}

// detectGitRemote returns the origin remote URL, or empty string if not a git repo.
func detectGitRemote(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "-C", dir, "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return normalizeRemoteURL(strings.TrimSpace(string(out)))
}

// detectGitBranch returns the current branch name, or empty string.
func detectGitBranch(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// normalizeRemoteURL strips protocol/auth differences to produce a canonical form.
// "git@github.com:user/repo.git" and "https://github.com/user/repo.git" → "github.com/user/repo"
func normalizeRemoteURL(raw string) string {
	s := raw

	// SSH format: git@github.com:user/repo.git
	if strings.HasPrefix(s, "git@") {
		s = strings.TrimPrefix(s, "git@")
		s = strings.Replace(s, ":", "/", 1)
	}

	// HTTPS format: https://github.com/user/repo.git
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")

	// Remove .git suffix.
	s = strings.TrimSuffix(s, ".git")

	// Remove trailing slash.
	s = strings.TrimSuffix(s, "/")

	return s
}

// repoNameFromRemote extracts "repo" from "github.com/user/repo".
func repoNameFromRemote(remote string) string {
	parts := strings.Split(remote, "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}
