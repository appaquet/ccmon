import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEBOUNCE_MS = 100;

/**
 * Watches claudeDir for project subdirectory changes and calls onUpdate when
 * a project's status.local.json is modified or created.
 *
 * For each existing and newly created project subdir, watches status.local.json
 * directly if it exists, or the parent dir until the file appears.
 * Debounces per projectDir with a 100ms window.
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

  function watchStatusFile(projectDir: string): void {
    if (stopped) return;
    const key = `file:${projectDir}`;
    if (watchers.has(key)) return;

    const statusFile = join(projectDir, 'status.local.json');

    try {
      const watcher = watch(statusFile, () => {
        scheduleUpdate(projectDir);
      });
      watcher.on('error', () => {
        // File removed or inaccessible — fall back to watching the parent dir
        watcher.close();
        watchers.delete(key);
        watchParentDir(projectDir);
      });
      watchers.set(key, watcher);
    } catch {
      // File doesn't exist yet — watch parent dir instead
      watchParentDir(projectDir);
    }
  }

  function watchParentDir(projectDir: string): void {
    if (stopped) return;
    const key = `dir:${projectDir}`;
    if (watchers.has(key)) return;

    try {
      const watcher = watch(projectDir, (eventType, filename) => {
        if (filename === 'status.local.json') {
          scheduleUpdate(projectDir);
          // Switch to watching the file directly once it exists
          watcher.close();
          watchers.delete(key);
          watchStatusFile(projectDir);
        }
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
    const statusFile = join(projectDir, 'status.local.json');
    let fileExists = false;
    try {
      await stat(statusFile);
      fileExists = true;
    } catch {
      // not present
    }

    if (fileExists) {
      watchStatusFile(projectDir);
    } else {
      watchParentDir(projectDir);
    }
  }

  // Watch claudeDir for new project subdirectories
  function startClaudeDirWatcher(): void {
    if (stopped) return;
    try {
      const watcher = watch(claudeDir, (eventType, filename) => {
        if (!filename || stopped) return;
        const newProjectDir = join(claudeDir, filename);
        // Attempt to set up a watch for the new directory (stat happens inside)
        watchProject(newProjectDir).catch(() => {});
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
          await watchProject(fullPath);
        }
      } catch {
        // skip
      }
    }

    startClaudeDirWatcher();
  }

  init().catch(() => {});

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
