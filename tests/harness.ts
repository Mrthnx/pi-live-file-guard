import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Create a throwaway git repo with one tracked file. */
export async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lfg-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "lfg@test.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "lfg"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/** Fake `pi.exec`: runs the real command, returns the shape the extension expects. */
async function fakeExec(cmd: string, args: string[], opts: { cwd: string }) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts.cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: 1, stdout: "", stderr: String(error) };
  }
}

export interface Notification {
  msg: string;
  type?: string;
}

export interface WriteOutcome {
  blocked: boolean;
  reason?: string;
}

export interface Session {
  sessionId: string;
  notifications: Notification[];
  /** Chain this session exported for its own children (env semantics). */
  exportedChain: string | undefined;
  /** Register the read hash for a path (tool_call: read). */
  read(path: string): Promise<void>;
  /** Ask the guard whether a write is allowed (tool_call: write). */
  write(path: string): Promise<WriteOutcome>;
  /** Full write cycle: tool_call, real file write, tool_result (publishes the change). */
  applyWrite(path: string, content: string): Promise<WriteOutcome>;
  /** /lfg status output. */
  status(): Promise<string>;
  shutdown(): Promise<void>;
}

let instanceCounter = 0;

/**
 * Load a fresh copy of the extension (the module keeps per-session state at
 * module scope) and run its session_start hook against a fake Pi API.
 */
export async function startSession(options: {
  sessionId: string;
  cwd: string;
  /** Delegation chain this session inherits from its parent (env semantics). */
  inheritedChain?: string;
  /** Extra env applied while the module is loaded (module-scope constants). */
  env?: Record<string, string | undefined>;
}): Promise<Session> {
  const previousEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (options.inheritedChain !== undefined) {
    process.env.LIVE_FILE_GUARD_LINEAGE_CHAIN = options.inheritedChain;
  }

  const url = new URL("../extensions/live-file-guard.ts", import.meta.url);
  url.searchParams.set("instance", String(++instanceCounter));
  const module = (await import(url.href)) as {
    default: (pi: unknown) => void;
  };

  const notifications: Notification[] = [];
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers[event] = handler;
    },
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commands[name] = spec.handler;
    },
    exec: fakeExec,
  };

  const ctx = {
    cwd: options.cwd,
    hasUI: true,
    mode: "tui",
    signal: new AbortController().signal,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getCwd: () => options.cwd,
    },
    ui: {
      notify: (msg: string, type?: string) => {
        notifications.push({ msg, type });
      },
      setStatus: () => {},
    },
  };

  module.default(pi);
  await handlers.session_start?.({}, ctx);
  const exportedChain = process.env.LIVE_FILE_GUARD_LINEAGE_CHAIN;

  const restoreEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  };
  restoreEnv();

  const read = async (path: string) => {
    await handlers.tool_call?.({ toolName: "read", input: { path } }, ctx);
  };

  const write = async (path: string): Promise<WriteOutcome> => {
    const result = (await handlers.tool_call?.({ toolName: "write", input: { path } }, ctx)) as
      | { block?: boolean; reason?: string }
      | undefined;
    return { blocked: result?.block === true, reason: result?.reason };
  };

  const applyWrite = async (path: string, content: string): Promise<WriteOutcome> => {
    const outcome = await write(path);
    if (outcome.blocked) return outcome;
    writeFileSync(join(options.cwd, path), content);
    await handlers.tool_result?.(
      { toolName: "write", input: { path }, isError: false, toolCallId: `call-${options.sessionId}` },
      ctx,
    );
    return outcome;
  };

  return {
    sessionId: options.sessionId,
    notifications,
    exportedChain,
    read,
    write,
    applyWrite,
    status: async () => {
      let out = "";
      await commands.lfg?.("status", {
        ...ctx,
        ui: {
          notify: (msg: string) => {
            out += msg;
          },
          setStatus: () => {},
        },
      });
      return out;
    },
    shutdown: async () => {
      await handlers.session_shutdown?.({}, ctx);
    },
  };
}

/** Wait until a predicate holds (the guard's watcher delivers bus changes async). */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

/** Append a raw change record to the bus, bypassing the extension (old-session shape). */
export async function publishRawChange(repo: string, record: Record<string, unknown>): Promise<void> {
  const bus = join(repo, ".git", "gentle-pi", "live-files");
  const { appendFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(bus, { recursive: true });
  appendFileSync(join(bus, "changes.jsonl"), JSON.stringify(record) + "\n", "utf8");
}
