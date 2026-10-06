/**
 * live-file-guard — Pi extension
 *
 * Detects, in real time, when two or more active Pi sessions edit the same file
 * inside the same Git repository, and blocks writes that would clobber another
 * session's changes. Also shows live notifications when a file you have read is
 * modified by another session.
 *
 * Design spec: odd/prd-live-file-guard.md
 *
 * How it works:
 *   - On `read`, the SHA-256 of the file is recorded in an in-memory registry.
 *   - Before `write`/`edit`, the current hash is compared to the one you read.
 *     If they differ AND the difference was published by another Pi session, the
 *     call is blocked with an actionable reason. Human/IDE edits are allowed by
 *     default (opt into strict mode to block those too).
 *   - After a successful `write`/`edit`, the change is appended to a shared,
 *     append-only bus inside the Git common dir so every sibling session sees it.
 *   - A filesystem watcher (+ polling fallback) on the bus delivers live
 *     notifications to sessions that had the changed file open.
 *
 * Configuration (env):
 *   LIVE_FILE_GUARD_STRICT=1   Block writes when the file changed, even if the
 *                              change was not published by a Pi session (i.e. a
 *                              human/IDE edit). Also requires a prior `read`.
 *   LIVE_FILE_GUARD_TTL_MS     Soft-claim TTL in ms (default 120000).
 *   LIVE_FILE_GUARD_OFF=1      Disable the guard entirely.
 *
 * Commands:
 *   /lfg status             Show claims, watched files, and last edits.
 *   /lfg release <path>     Release your soft claim on a path.
 *
 * Fail policy: I/O errors on the bus never break the original tool (fail-open).
 * The stale check is the only thing that blocks, and only with evidence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────────────

const BUS_REL = join("gentle-pi", "live-files");
const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 15_000;
const POLL_MS = 3_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const TTL_DEFAULT_MS = 120_000;
const SCHEMA = "lfg" as const;

const STRICT = process.env.LIVE_FILE_GUARD_STRICT === "1";
const DISABLED = process.env.LIVE_FILE_GUARD_OFF === "1";
const TTL_MS = Number(process.env.LIVE_FILE_GUARD_TTL_MS) || TTL_DEFAULT_MS;

// ─── Bus record types ────────────────────────────────────────────────────────

interface SessionRecord {
  schema: "lfg.session/v1";
  sessionId: string;
  cwd: string;
  gitRoot: string;
  commonDir: string;
  pid: number;
  lastSeen: number;
}
interface ReadRecord {
  schema: "lfg.read/v1";
  sessionId: string;
  path: string;
  hash: string;
  size: number;
  readAt: number;
}
interface ClaimRecord {
  schema: "lfg.claim/v1";
  sessionId: string;
  path: string;
  claimedAt: number;
  expiresAt: number;
  reason: string;
}
interface ChangeRecord {
  schema: "lfg.change/v1";
  sessionId: string;
  path: string;
  before: string;
  after: string;
  tool: string;
  toolCallId: string;
  changedAt: number;
}
type BusRecord = SessionRecord | ReadRecord | ClaimRecord | ChangeRecord;

// ─── Small helpers ───────────────────────────────────────────────────────────

const now = () => Date.now();
function short(h: string): string {
  return h.slice(0, 12);
}

/** Append one JSON line to a bus file. Tolerant: never throws. */
function appendLine(file: string, rec: BusRecord): boolean {
  try {
    appendFileSync(file, JSON.stringify(rec) + "\n", { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/** Read and parse every line of a bus file. Tolerant: skips invalid lines. */
function readLines<T extends BusRecord>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // partial/corrupt line — ignore
    }
  }
  return out;
}

/** SHA-256 of a file. Returns "absent" | "too-big" | "<hex>" | null (read error). */
function hashFile(absPath: string): string | null {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return "absent";
  }
  if (!st.isFile()) return "absent";
  if (st.size > MAX_FILE_BYTES) return "too-big";
  try {
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// ─── Per-session state ───────────────────────────────────────────────────────

interface ReadEntry {
  hash: string; // "absent" | "too-big" | "<hex>"
  readAt: number;
}

class GuardState {
  sessionId = "";
  cwd = "";
  gitRoot = ""; // worktree toplevel (git rev-parse --show-toplevel)
  commonDir = ""; // git rev-parse --git-common-dir
  busDir = "";
  enabled = false;

  readonly reads = new Map<string, ReadEntry>(); // repo-rel path -> last read
  readonly lastChange = new Map<string, ChangeRecord>(); // repo-rel path -> last published change (any session)
  readonly claims = new Map<string, ClaimRecord>(); // repo-rel path -> my active claim

  warnedBigFile = new Set<string>();
  warnedBus = false;

  // watcher bookkeeping
  changesFile = "";
  changeOffset = 0;
  watcher: FSWatcher | null = null;
  heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  sweepTimer: ReturnType<typeof setInterval> | null = null;
  pollTimer: ReturnType<typeof setInterval> | null = null;
}

const S = new GuardState();

// ─── Identity / Git resolution ───────────────────────────────────────────────

async function resolveIdentity(
  exec: ExtensionAPI["exec"],
  cwd: string,
): Promise<{ gitRoot: string; commonDir: string } | null> {
  try {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (top.code !== 0) return null;
    const common = await exec("git", ["rev-parse", "--git-common-dir"], { cwd });
    if (common.code !== 0) return null;
    const gitRoot = realpathSafe(top.stdout.trim());
    const commonDir = realpathSafe(resolve(cwd, common.stdout.trim())); // common dir may be relative
    if (!gitRoot || !commonDir) return null;
    return { gitRoot, commonDir };
  } catch {
    return null;
  }
}

// ─── Path normalization ──────────────────────────────────────────────────────

/** Canonicalize a path that is expected to exist; falls back to the input. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve a tool `path` (maybe relative) to { abs, rel } where rel is
 * git-toplevel-relative. Returns null if the path is outside the repo, inside
 * `.git/`, or not a string. Both cwd and gitRoot are canonicalized so that
 * macOS symlink differences (e.g. /tmp vs /private/tmp) don't break the
 * relative computation.
 */
function normalizePath(rawPath: unknown): { abs: string; rel: string } | null {
  if (typeof rawPath !== "string" || !rawPath) return null;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(S.cwd, rawPath);
  const rel = relative(S.gitRoot, abs);
  if (rel.startsWith("..") || rel === "") return null; // outside repo (or the root itself)
  if (rel === ".git" || rel.startsWith(".git" + sep)) return null; // inside .git
  return { abs, rel };
}

// ─── Bus setup ───────────────────────────────────────────────────────────────

function initBus(): boolean {
  try {
    S.busDir = join(S.commonDir, BUS_REL);
    mkdirSync(S.busDir, { recursive: true });
    S.changesFile = join(S.busDir, "changes.jsonl");
    // ensure files exist
    for (const f of ["sessions", "reads", "claims", "changes"]) {
      const p = join(S.busDir, `${f}.jsonl`);
      if (!existsSync(p)) closeSync(openSync(p, "w"));
    }
    return true;
  } catch {
    return false;
  }
}

function writeHeartbeat(): void {
  const rec: SessionRecord = {
    schema: `${SCHEMA}.session/v1`,
    sessionId: S.sessionId,
    cwd: S.cwd,
    gitRoot: S.gitRoot,
    commonDir: S.commonDir,
    pid: process.pid,
    lastSeen: now(),
  };
  appendLine(join(S.busDir, "sessions.jsonl"), rec);
}

// ─── Stale check (PRD §12.1) ─────────────────────────────────────────────────

interface StaleResult {
  block: true;
  reason: string;
}

function staleCheck(rel: string, abs: string): StaleResult | null {
  const actual = hashFile(abs);
  if (actual === null) return null; // read error → fail-open
  if (actual === "too-big") return null; // skip large files

  const leido = S.reads.get(rel);
  const ultimo = S.lastChange.get(rel);

  // (4) Never read this file in this session.
  if (!leido) {
    if (STRICT) {
      return {
        block: true,
        reason: `live-file-guard (strict): nunca leíste "${rel}" en esta sesión. Hacé read antes de escribir.`,
      };
    }
    return null; // permissive: allow
  }

  // (5) File is exactly as I last read it.
  if (actual === leido.hash) return null;

  // (6) I was the last to change it and the file still matches my result.
  if (ultimo && ultimo.sessionId === S.sessionId && actual === ultimo.after) {
    return null;
  }

  // (7) Another Pi session changed it and the file matches that published change.
  if (ultimo && ultimo.sessionId !== S.sessionId && actual === ultimo.after) {
    return {
      block: true,
      reason:
        `live-file-guard: "${rel}" cambió desde tu última lectura ` +
        `(tu hash ${short(leido.hash)} → actual ${short(actual)}). ` +
        `Lo modificó la sesión ${ultimo.sessionId.slice(0, 8)} con ${ultimo.tool}. ` +
        `Re-leé el archivo con read antes de escribir para no pisar sus cambios.`,
    };
  }

  // (8) Hash differs but matches no known Pi change → human/external edit.
  if (STRICT) {
    return {
      block: true,
      reason:
        `live-file-guard (strict): "${rel}" cambió externamente ` +
        `(tu hash ${short(leido.hash)} → actual ${short(actual)}), ` +
        `y el cambio no fue publicado por ninguna sesión de Pi. ` +
        `Re-leé antes de escribir.`,
    };
  }
  return null; // permissive: allow human edits
}

// ─── Change publication + read registry update ───────────────────────────────

function publishChange(rel: string, abs: string, before: string, tool: string, toolCallId: string): void {
  const after = hashFile(abs);
  if (after === null || after === "too-big") return; // nothing useful to publish
  const rec: ChangeRecord = {
    schema: `${SCHEMA}.change/v1`,
    sessionId: S.sessionId,
    path: rel,
    before,
    after,
    tool,
    toolCallId,
    changedAt: now(),
  };
  appendLine(S.changesFile, rec);
  S.lastChange.set(rel, rec);
  S.reads.set(rel, { hash: after, readAt: rec.changedAt }); // my view is now fresh
}

// ─── Watcher: drain new change lines and notify ──────────────────────────────

function drainChanges(notify: (msg: string) => void): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(S.changesFile);
  } catch {
    return;
  }
  if (st.size === S.changeOffset) return;
  if (st.size < S.changeOffset) {
    // file truncated/rotated — reprocess from start
    S.changeOffset = 0;
  }
  let chunk: Buffer;
  try {
    const fd = openSync(S.changesFile, "r");
    const len = st.size - S.changeOffset;
    chunk = Buffer.alloc(len);
    readSync(fd, chunk, 0, len, S.changeOffset);
    closeSync(fd);
  } catch {
    return;
  }
  S.changeOffset = st.size;
  const text = chunk.toString("utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: ChangeRecord;
    try {
      rec = JSON.parse(line) as ChangeRecord;
    } catch {
      continue;
    }
    if (rec.schema !== `${SCHEMA}.change/v1`) continue;
    // Update our last-change cache for any session (including our own, idempotent).
    const prev = S.lastChange.get(rec.path);
    if (!prev || prev.changedAt <= rec.changedAt) S.lastChange.set(rec.path, rec);
    // Notify if another session changed a file we have read.
    if (rec.sessionId === S.sessionId) continue;
    if (S.reads.has(rec.path)) {
      notify(
        `⚠ live-file-guard: "${rec.path}" fue modificado por la sesión ${rec.sessionId.slice(0, 8)} ` +
          `(${rec.tool}). Re-leé antes de editar.`,
      );
    }
  }
}

function startWatcher(notify: (msg: string) => void): void {
  // Seed offset at current end so we don't replay history as notifications.
  try {
    S.changeOffset = statSync(S.changesFile).size;
  } catch {
    S.changeOffset = 0;
  }
  // Seed lastChange cache from existing history (tail).
  for (const rec of readLines<ChangeRecord>(S.changesFile)) {
    if (rec.schema !== `${SCHEMA}.change/v1`) continue;
    const prev = S.lastChange.get(rec.path);
    if (!prev || prev.changedAt <= rec.changedAt) S.lastChange.set(rec.path, rec);
  }

  try {
    S.watcher = watch(S.changesFile, () => drainChanges(notify));
    S.watcher.on("error", () => {});
  } catch {
    S.watcher = null;
  }
  // Polling fallback for missed fs.watch events (macOS reliability).
  S.pollTimer = setInterval(() => drainChanges(notify), POLL_MS);
  S.pollTimer.unref?.();
}

// ─── Soft claims (PRD §12.4) ──────────────────────────────────────────────────

function claim(rel: string, reason: string): void {
  const t = now();
  const rec: ClaimRecord = {
    schema: `${SCHEMA}.claim/v1`,
    sessionId: S.sessionId,
    path: rel,
    claimedAt: t,
    expiresAt: t + TTL_MS,
    reason,
  };
  appendLine(join(S.busDir, "claims.jsonl"), rec);
  S.claims.set(rel, rec);
}

function releaseClaim(rel: string): boolean {
  if (!S.claims.has(rel)) return false;
  S.claims.delete(rel);
  // publish a release as an expired claim so siblings drop it on sweep
  const rec: ClaimRecord = {
    schema: `${SCHEMA}.claim/v1`,
    sessionId: S.sessionId,
    path: rel,
    claimedAt: 0,
    expiresAt: 0,
    reason: "released",
  };
  appendLine(join(S.busDir, "claims.jsonl"), rec);
  return true;
}

/** Remove our expired claims and compact the in-memory map. */
function sweep(): void {
  const t = now();
  for (const [rel, c] of S.claims) {
    if (c.expiresAt < t) S.claims.delete(rel);
  }
}

// ─── Presence footer ──────────────────────────────────────────────────────────

function updateFooter(setStatus: (key: string, text: string | undefined) => void): void {
  const watched = S.reads.size;
  const claims = S.claims.size;
  if (watched === 0 && claims === 0) {
    setStatus("lfg", undefined);
    return;
  }
  const parts: string[] = [];
  if (watched) parts.push(`${watched} file${watched === 1 ? "" : "s"} watched`);
  if (claims) parts.push(`${claims} claim${claims === 1 ? "" : "s"}`);
  setStatus("lfg", `lfg: ${parts.join(" · ")}`);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdStatus(notify: (msg: string, type?: "info" | "warning" | "error") => void): void {
  if (!S.enabled) {
    notify("live-file-guard: desactivado (no es un repo Git o bus no escribible).", "warning");
    return;
  }
  const lines: string[] = [`live-file-guard — sesión ${S.sessionId.slice(0, 8)}`];
  lines.push(`repo: ${S.gitRoot}`);
  lines.push(`bus:  ${S.busDir}`);
  lines.push(`modo: ${STRICT ? "estricto" : "permisivo"} · TTL ${TTL_MS}ms`);
  lines.push("");

  // Claims (mine + siblings, from bus)
  const allClaims = readLines<ClaimRecord>(join(S.busDir, "claims.jsonl"));
  const live = new Map<string, ClaimRecord>();
  const t = now();
  for (const c of allClaims) {
    if (c.schema !== `${SCHEMA}.claim/v1`) continue;
    if (c.expiresAt < t) continue;
    const prev = live.get(c.path);
    if (!prev || prev.claimedAt <= c.claimedAt) live.set(c.path, c);
  }
  lines.push(`Claims activos (${live.size}):`);
  for (const [p, c] of live) {
    const mine = c.sessionId === S.sessionId ? " (mío)" : "";
    lines.push(`  ${p} → ${c.sessionId.slice(0, 8)}${mine} expira en ${Math.max(0, c.expiresAt - t)}ms`);
  }
  lines.push("");

  // Files I have read
  lines.push(`Archivos leídos por esta sesión (${S.reads.size}):`);
  for (const [p, r] of S.reads) {
    lines.push(`  ${p} → ${short(r.hash)} (leído ${new Date(r.readAt).toLocaleTimeString()})`);
  }
  lines.push("");

  // Last change per file
  lines.push(`Última edición por archivo (${S.lastChange.size}):`);
  for (const [p, c] of S.lastChange) {
    const mine = c.sessionId === S.sessionId ? " (yo)" : "";
    lines.push(`  ${p} → ${short(c.after)} por ${c.sessionId.slice(0, 8)}${mine} (${c.tool})`);
  }

  notify(lines.join("\n"), "info");
}

function cmdRelease(arg: string, notify: (msg: string, type?: "info" | "warning" | "error") => void): void {
  const target = arg.trim();
  if (!target) {
    notify("Uso: /lfg release <path>", "warning");
    return;
  }
  const norm = normalizePath(target);
  if (!norm) {
    notify(`live-file-guard: "${target}" no está dentro del repo.`, "warning");
    return;
  }
  if (releaseClaim(norm.rel)) {
    notify(`live-file-guard: claim liberado sobre ${norm.rel}.`, "info");
  } else {
    notify(`live-file-guard: no tenías claim sobre ${norm.rel}.`, "warning");
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown(): void {
  for (const rel of S.claims.keys()) releaseClaim(rel);
  S.claims.clear();
  if (S.heartbeatTimer) clearInterval(S.heartbeatTimer);
  if (S.sweepTimer) clearInterval(S.sweepTimer);
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.heartbeatTimer = S.sweepTimer = S.pollTimer = null;
  try {
    S.watcher?.close();
  } catch {
    // ignore
  }
  S.watcher = null;
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  pi.on("session_start", async (_event, ctx) => {
    S.sessionId = ctx.sessionManager.getSessionId();
    S.cwd = realpathSafe(ctx.cwd);

    const id = await resolveIdentity(pi.exec, S.cwd);
    if (!id) {
      // Not a git repo — guard stays inactive (fail-open).
      S.enabled = false;
      return;
    }
    S.gitRoot = id.gitRoot;
    S.commonDir = id.commonDir;

    if (!initBus()) {
      S.enabled = false;
      if (ctx.hasUI && !S.warnedBus) {
        S.warnedBus = true;
        ctx.ui.notify(
          "live-file-guard: no se pudo escribir en el bus del git common dir; el guard está inactivo.",
          "warning",
        );
      }
      return;
    }
    S.enabled = true;

    const notify = (msg: string) => {
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    };

    writeHeartbeat();
    startWatcher(notify);

    S.heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
    S.heartbeatTimer.unref?.();
    S.sweepTimer = setInterval(() => {
      sweep();
      updateFooter(ctx.ui.setStatus.bind(ctx.ui));
    }, SWEEP_MS);
    S.sweepTimer.unref?.();

    if (ctx.hasUI) {
      ctx.ui.notify(
        `live-file-guard activo · ${STRICT ? "estricto" : "permisivo"} · ${S.gitRoot}`,
        "info",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!S.enabled) return;

    // read → record hash
    if (event.toolName === "read") {
      const norm = normalizePath((event.input as { path?: unknown }).path);
      if (!norm) return;
      const h = hashFile(norm.abs);
      if (h === null) return; // read error, skip
      if (h === "too-big") {
        if (ctx.hasUI && !S.warnedBigFile.has(norm.rel)) {
          S.warnedBigFile.add(norm.rel);
          ctx.ui.notify(
            `live-file-guard: ${norm.rel} supera ${MAX_FILE_BYTES} bytes; no se vigila.`,
            "info",
          );
        }
        return;
      }
      S.reads.set(norm.rel, { hash: h, readAt: now() });
      return;
    }

    // write / edit → stale check + claim
    if (event.toolName === "write" || event.toolName === "edit") {
      const norm = normalizePath((event.input as { path?: unknown }).path);
      if (!norm) return;

      const stale = staleCheck(norm.rel, norm.abs);
      if (stale) {
        if (ctx.hasUI) ctx.ui.notify(stale.reason, "warning");
        return { block: true, reason: stale.reason };
      }

      // Soft claim for visibility (best-effort).
      claim(norm.rel, event.toolName);
      updateFooter(ctx.ui.setStatus.bind(ctx.ui));
      return;
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!S.enabled) return;
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const norm = normalizePath((event.input as { path?: unknown }).path);
    if (!norm) return;

    const before = S.reads.get(norm.rel)?.hash ?? "absent";
    publishChange(norm.rel, norm.abs, before, event.toolName, event.toolCallId);
  });

  pi.on("session_shutdown", () => {
    shutdown();
  });

  // Commands
  pi.registerCommand("lfg", {
    description: "live-file-guard: status / release <path>",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim();
      if (arg === "status" || arg === "") {
        cmdStatus((m, t) => ctx.ui.notify(m, t));
      } else if (arg.startsWith("release")) {
        cmdRelease(arg.slice("release".length), (m, t) => ctx.ui.notify(m, t));
      } else {
        ctx.ui.notify("Uso: /lfg status  |  /lfg release <path>", "info");
      }
    },
  });
}
