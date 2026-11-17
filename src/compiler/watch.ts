import { watch as fsWatch, type FSWatcher } from "node:fs"

/** A directory to watch, and which of the file names it reports count as a change. */
export interface WatchTarget {
  readonly directory: string
  /** Watch the directory's subdirectories too. */
  readonly recursive: boolean
  /** Whether a change to this file, relative to `directory`, should regenerate. A null name always counts. */
  readonly accept: (file: string) => boolean
}

export interface WatchOptions {
  readonly targets: readonly WatchTarget[]
  /** Runs once at the start and once after each burst of changes settles. Never two at once. */
  readonly run: () => void | Promise<void>
  /** Gets whatever `run` throws; watching carries on. */
  readonly onError: (error: unknown) => void
  /** How long changes must stop before `run`. Default 100 ms: an editor's save is often several events. */
  readonly debounceMs?: number
  /** For tests. Defaults to `node:fs` `watch`. */
  readonly watch?: (directory: string, options: { recursive: boolean }, listener: (event: string, file: string | null) => void) => Pick<FSWatcher, "close" | "on">
}

export interface Watching {
  /** Stop watching. A run already under way finishes; nothing new starts. */
  close(): void
  /** Settles when the run in progress, and any run queued behind it, has finished. */
  idle(): Promise<void>
}

/**
 * Run `run`, then again whenever a watched file changes, for `generate --watch`. Changes that arrive while a run is
 * under way queue exactly one more run after it, so the last change is always generated. A failed run is reported
 * through `onError` and the watch continues, so a typo in a document doesn't end the session.
 *
 * It watches directories rather than files: an editor that saves by writing a new file and renaming it over the old
 * one would leave a watch on the old file behind.
 */
export function watchFiles(options: WatchOptions): Watching {
  const debounceMs = options.debounceMs ?? 100
  const watch = options.watch ?? ((directory, settings, listener) => fsWatch(directory, settings, listener))
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | null = null
  let again = false
  let closed = false

  const start = (): void => {
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = (async () => {
      try {
        await options.run()
      } catch (error) {
        options.onError(error)
      }
    })().finally(() => {
      running = null
      if (again) {
        again = false
        start()
      }
    })
  }
  const changed = (): void => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(start, debounceMs)
  }
  const watchers = options.targets.map((target) => {
    const watcher = watch(target.directory, { recursive: target.recursive }, (_event, file) => {
      if (file === null || target.accept(String(file))) changed()
    })
    watcher.on("error", options.onError)
    return watcher
  })
  start()
  return {
    close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
    async idle() {
      while (running) await running
    },
  }
}
