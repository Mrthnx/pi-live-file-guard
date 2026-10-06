# pi-live-file-guard

Prevent concurrent Pi sessions from overwriting each other's work with stale snapshots.

`pi-live-file-guard` is a Pi extension that records the SHA-256 hash of files when a session reads them, publishes successful writes to a shared Git common-dir bus, and blocks later `write`/`edit` calls when a session tries to write over a file that another Pi session changed after the last read.

It is designed for multiple Pi sessions working in the same clone without isolated worktrees, while still supporting sibling Git worktrees that share the same Git common directory.

## What problem does it solve?

A common lost-work sequence looks like this:

1. Session A reads `src/foo.ts`.
2. Session B edits `src/foo.ts`.
3. Session B finishes, releases, or exits.
4. Session A writes a broad replacement based on its old snapshot.
5. B's changes disappear.

Lock-only approaches can miss this if the lock has already been released or expired. `pi-live-file-guard` blocks based on the content hash that A actually read, so stale writes are caught even after the other session is no longer actively editing.

## Features

- Records read hashes for successful `read` tool calls.
- Blocks stale `write`/`edit` calls when another Pi session changed the file since the last read.
- Publishes changes to a shared append-only bus under the Git common directory.
- Sends live notifications to sessions that had read a file changed by another session.
- Supports sibling worktrees from the same clone because the bus lives in the Git common dir.
- Uses soft claims with TTL for presence and coordination.
- Optional strict mode blocks external human/IDE edits too.
- Ignores paths outside the repository and `.git/**`.
- Ignores files larger than 4 MB.
- Uses only Node.js standard library modules.

## Install

After the package is published to npm:

```bash
pi install npm:pi-live-file-guard
```

For a project-shared install, use Pi's local package scope:

```bash
pi install -l npm:pi-live-file-guard
```

## Optional local trial

Before publishing or installing globally, you can run it directly from a local checkout:

```bash
pi -e ./pi-live-file-guard
```

Or install the local package path:

```bash
pi install ./pi-live-file-guard
```

## Commands

Inside Pi:

```text
/lfg status
```

Shows current claims, files read by the current session, and recent edits known through the bus.

```text
/lfg release <path>
```

Releases this session's soft claim for a path.

## Configuration

Environment variables:

| Variable | Effect |
| --- | --- |
| `LIVE_FILE_GUARD_STRICT=1` | Block writes when the file changed since the last read even if the change was not published by another Pi session, such as a human/IDE edit. Also requires a prior read. |
| `LIVE_FILE_GUARD_TTL_MS=<ms>` | Override the soft-claim TTL. Default: `120000` ms. |
| `LIVE_FILE_GUARD_OFF=1` | Disable the guard entirely. |

Example:

```bash
LIVE_FILE_GUARD_STRICT=1 pi
```

## Runtime data

The shared bus is stored inside the Git common directory:

```text
<git-common-dir>/gentle-pi/live-files/
  reads.jsonl
  claims.jsonl
  changes.jsonl
  sessions.jsonl
```

The files are append-only runtime data. They are intentionally tolerant of partial or corrupt lines.

## Comparison with pi-edit-fence

[`pi-edit-fence`](https://pi.dev/packages/pi-edit-fence) is a simpler, already-published Pi package that uses lightweight per-file locks. It is a good fit when you want straightforward lock ownership, retry-later behavior, lease expiry, and crash recovery.

`pi-live-file-guard` uses a different model:

| Capability | `pi-edit-fence` | `pi-live-file-guard` |
| --- | --- | --- |
| Primary model | Pessimistic per-file lock | Optimistic stale-write guard using read hashes |
| Already published | Yes | Publish this package yourself |
| Main strength | Simple locking and retry-later behavior | Blocks writes based on the snapshot the session actually read |
| Protects after another session edits and releases/expires its lock | Not always, depending on lock state | Yes, if the writing session has not re-read the file |
| Sibling worktree coordination | Registry is under the current cwd | Bus is under Git common dir, so sibling worktrees share it |
| Human/IDE changes | Not hash-guarded | Allowed by default; blocked in strict mode |
| Shared config files | Warn-only by design | Stale Pi changes are still guarded |

In short: use `pi-edit-fence` if you want a small published lock manager today. Use `pi-live-file-guard` if your highest-risk failure is an old agent snapshot overwriting changes after the other session is done.

## Limitations

- Single-host/shared-filesystem assumption. The bus is filesystem based, not a network consensus system.
- It is not a merge engine and does not resolve conflicts automatically.
- Default mode does not block human/IDE edits unless `LIVE_FILE_GUARD_STRICT=1` is set.
- The JSONL bus is append-only and may need cleanup policy if used heavily for a long time.
- Only Pi tool calls that pass through extension hooks are guarded.

## Security note

Pi packages can execute extension code inside the Pi process with the user's local permissions. Review the source before installing third-party packages.

## License

MIT
