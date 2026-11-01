import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { makeRepo, publishRawChange, startSession, waitFor } from "./harness.ts";

const PARENT = "parent-session-0001";
const CHILD = "child-session-0002";
const SIBLING = "sibling-session-0003";
const STRANGER = "stranger-session-0004";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

test("a change published by my own subagent does not block my write and notifies once", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({
    sessionId: CHILD,
    cwd: repo,
    inheritedChain: PARENT, // the child inherits the parent's delegation chain
  });

  try {
    await parent.read("a.txt");
    await child.read("a.txt");
    await child.applyWrite("a.txt", "child version\n");

    await waitFor(() => parent.notifications.some((n) => n.msg.includes("a.txt")));
    const notices = parent.notifications.filter((n) => n.msg.includes("a.txt"));
    assert.equal(notices.length, 1, "exactly one notice for the in-lineage change");
    assert.equal(notices[0].type, "info", "the notice is informational, not a warning");
    assert.ok(
      !/re-leé antes de editar|re-lee antes de editar/i.test(notices[0].msg),
      "the notice must not demand a re-read: " + notices[0].msg,
    );
    assert.ok(!notices[0].msg.includes("⚠"), "the notice must not look like a warning");

    const outcome = await parent.write("a.txt");
    assert.equal(outcome.blocked, false, "my subagent's change must not block my write");

    const afterWrite = parent.notifications.filter((n) => n.msg.includes("a.txt"));
    assert.equal(afterWrite.length, 1, "the notice is not repeated when I write");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a change published by an unrelated session still blocks my write", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const stranger = await startSession({ sessionId: STRANGER, cwd: repo });

  try {
    await parent.read("a.txt");
    await stranger.read("a.txt");
    await stranger.applyWrite("a.txt", "stranger version\n");

    await waitFor(() => parent.notifications.some((n) => n.type === "warning"));
    const outcome = await parent.write("a.txt");
    assert.equal(outcome.blocked, true, "an unrelated session must keep blocking my write");
    assert.ok(/live-file-guard/.test(outcome.reason ?? ""));
  } finally {
    await parent.shutdown();
    await stranger.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("two sibling subagents still block each other", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });
  const sibling = await startSession({ sessionId: SIBLING, cwd: repo, inheritedChain: PARENT });

  try {
    await child.read("a.txt");
    await sibling.read("a.txt");
    await child.applyWrite("a.txt", "child version\n");

    await waitFor(() => sibling.notifications.some((n) => n.type === "warning"));
    const outcome = await sibling.write("a.txt");
    assert.equal(outcome.blocked, true, "sibling subagents must keep blocking each other");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    await sibling.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("LIVE_FILE_GUARD_LINEAGE=off restores blocking against my own subagent", async () => {
  const repo = await makeRepo();
  const parent = await startSession({
    sessionId: PARENT,
    cwd: repo,
    env: { LIVE_FILE_GUARD_LINEAGE: "off" },
  });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });

  try {
    await parent.read("a.txt");
    await child.read("a.txt");
    await child.applyWrite("a.txt", "child version\n");

    await waitFor(() => parent.notifications.some((n) => n.type === "warning"));
    const outcome = await parent.write("a.txt");
    assert.equal(outcome.blocked, true, "with lineage trust off, my subagent blocks me again");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a change published without lineage (older session) still blocks", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });

  try {
    await parent.read("a.txt");
    await publishRawChange(repo, {
      schema: "lfg.change/v1",
      sessionId: "legacy-session-0009",
      path: "a.txt",
      before: hash("one\n"),
      after: hash("legacy version\n"),
      tool: "edit",
      toolCallId: "call-legacy",
      changedAt: Date.now(),
    });
    // The published hash must match the file on disk for the stale check to hit.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(repo, "a.txt"), "legacy version\n");

    await waitFor(() => parent.notifications.some((n) => n.type === "warning"));
    const outcome = await parent.write("a.txt");
    assert.equal(outcome.blocked, true, "a legacy change without lineage must keep blocking");
  } finally {
    await parent.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the delegation chain travels down the tree through the environment", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });
  const grandchild = await startSession({
    sessionId: SIBLING,
    cwd: repo,
    inheritedChain: `${PARENT},${CHILD}`,
  });

  try {
    assert.equal(parent.exportedChain, PARENT, "a root session exports only itself");
    assert.equal(child.exportedChain, `${PARENT},${CHILD}`, "the child exports parent,child");
    assert.equal(
      grandchild.exportedChain,
      `${PARENT},${CHILD},${SIBLING}`,
      "the grandchild exports parent,child,grandchild",
    );
  } finally {
    await parent.shutdown();
    await child.shutdown();
    await grandchild.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a change published by my parent session does not block my write", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });

  try {
    await child.read("a.txt");
    await parent.read("a.txt");
    await parent.applyWrite("a.txt", "parent version\n");

    await waitFor(() => child.notifications.some((n) => n.msg.includes("a.txt")));
    const notice = child.notifications.find((n) => n.msg.includes("a.txt"))!;
    assert.equal(notice.type, "info");
    assert.ok(
      !/re-leé antes de editar|re-lee antes de editar/i.test(notice.msg),
      "no re-read is demanded: " + notice.msg,
    );

    const outcome = await child.write("a.txt");
    assert.equal(outcome.blocked, false, "my parent session's change must not block my write");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the bus publishes the lineage without changing the record schema", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });

  try {
    await child.read("a.txt");
    await child.applyWrite("a.txt", "child version\n");

    const bus = join(repo, ".git", "gentle-pi", "live-files");
    const sessions = readFileSync(join(bus, "sessions.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const changes = readFileSync(join(bus, "changes.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const childSession = sessions.find((r) => r.sessionId === CHILD);
    assert.ok(childSession, "the child published a session record");
    assert.equal(childSession.schema, "lfg.session/v1", "the session schema is unchanged");
    assert.deepEqual(childSession.lineage, [PARENT], "the child session carries its ancestors");

    const parentSession = sessions.find((r) => r.sessionId === PARENT);
    assert.deepEqual(parentSession.lineage, [], "a root session carries an empty lineage");

    const change = changes.find((r) => r.sessionId === CHILD);
    assert.ok(change, "the child published its change");
    assert.equal(change.schema, "lfg.change/v1", "the change schema is unchanged");
    assert.deepEqual(change.lineage, [PARENT], "the change carries the changer's ancestors");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("/lfg status shows the lineage of the session", async () => {
  const repo = await makeRepo();
  const parent = await startSession({ sessionId: PARENT, cwd: repo });
  const child = await startSession({ sessionId: CHILD, cwd: repo, inheritedChain: PARENT });

  try {
    const status = await child.status();
    assert.match(status, /linaje:/);
    assert.match(status, new RegExp(PARENT.slice(0, 8)));

    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "one\n");
  } finally {
    await parent.shutdown();
    await child.shutdown();
    rmSync(repo, { recursive: true, force: true });
  }
});
