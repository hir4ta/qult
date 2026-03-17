import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import type { ProjectInfo } from '../types.js';

export function detectProject(dirPath: string): ProjectInfo {
  const absPath = resolve(dirPath);
  const info: ProjectInfo = {
    path: absPath,
    name: basename(absPath),
    remote: '',
    branch: '',
  };

  info.remote = detectGitRemote(absPath);
  info.branch = detectGitBranch(absPath);

  if (info.remote) {
    const name = repoNameFromRemote(info.remote);
    if (name) info.name = name;
  }

  return info;
}

function detectGitRemote(dir: string): string {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      timeout: 500,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeRemoteURL(out.trim());
  } catch {
    return '';
  }
}

function detectGitBranch(dir: string): string {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 500,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return '';
  }
}

export function normalizeRemoteURL(raw: string): string {
  let s = raw;

  // SSH format: git@github.com:user/repo.git
  if (s.startsWith('git@')) {
    s = s.slice(4);
    s = s.replace(':', '/');
  }

  // HTTPS format
  s = s.replace(/^https?:\/\//, '');

  // Remove .git suffix and trailing slash
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/$/, '');

  return s;
}

function repoNameFromRemote(remote: string): string {
  const parts = remote.split('/');
  return parts[parts.length - 1] ?? '';
}
