import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEBOUNCE_MS = 100;

/**
 * Watches claudeDir for project subdirectory changes and calls onUpdate when
 * any file in a project dir is modified or created (*.jsonl, sessions-index.json,
 * status.local.json).
 *
 * For each existing and newly created project subdir, watches the directory
 * directly so JSONL session file writes trigger enrichment refreshes.
 * Debounces per projectDir with a 100ms window to absorb the high frequency
 * of JSONL writes during active Claude turns.
 */
export function watchForChanges(
  claudeDir: string,
  onUpdate: (projectDir: string) => void,
): { stop: () => void } {
  const watchers = new Map<string, FSWatcher>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function scheduleUpdate(projectDir: string): void {
    const existing = timers.get(projectDir);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(projectDir);
      if (!stopped) onUpdate(projectDir);
    }, DEBOUNCE_MS);

    timers.set(projectDir, timer);
  }

  function watchProjectDir(projectDir: string): void {
    if (stopped) return;
    const key = `dir:${projectDir}`;
    if (watchers.has(key)) return;

    try {
      const watcher = watch(projectDir, () => {
        scheduleUpdate(projectDir);
      });
      watcher.on('error', () => {
        watcher.close();
        watchers.delete(key);
      });
      watchers.set(key, watcher);
    } catch {
      // Directory inaccessible — ignore
    }
  }

  async function watchProject(projectDir: string): Promise<void> {
    if (stopped) return;
    try {
      const s = await stat(projectDir);
      if (s.isDirectory()) {
        watchProjectDir(projectDir);
      }
    } catch {
      // Directory doesn't exist yet — will be picked up by claudeDir watcher
    }
  }

  // Watch claudeDir for new project subdirectories
  function startClaudeDirWatcher(): void {
    if (stopped) return;
    try {
      const watcher = watch(claudeDir, (eventType, filename) => {
        if (!filename || stopped) return;
        const newProjectDir = join(claudeDir, filename);
        watchProject(newProjectDir).catch((err) => console.error('ccmon: failed to watch new project dir:', err));
      });
      watcher.on('error', () => {
        watcher.close();
        watchers.delete('claudeDir');
      });
      watchers.set('claudeDir', watcher);
    } catch {
      // claudeDir inaccessible — nothing to watch
    }
  }

  // Initialize: watch all existing project subdirs
  async function init(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(claudeDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (entry === 'subagents') continue;
      const fullPath = join(claudeDir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          watchProjectDir(fullPath);
        }
      } catch {
        // skip
      }
    }

    startClaudeDirWatcher();
  }

  init().catch((err) => console.error('ccmon: watcher init error:', err));

  return {
    stop(): void {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers.values()) {
        try { watcher.close(); } catch { /* ignore */ }
      }
      watchers.clear();
    },
  };
}
