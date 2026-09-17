import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  CLIENT_FILE_MARKER,
  getFailureSignal,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import { summarizeStep } from "../../../src/tools/flows/flow-step-definitions";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
  type FlowFile,
  type FlowStep,
  type RecordingSession,
} from "../../../src/tools/flows/flow-utils";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 30_000 });

scopeTempHome("argent-flow-teardown-recording-home-");

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-recording-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function flowPath(name: string): string {
  return path.join(root, ".argent", "flows", `${name}.yaml`);
}

async function onDisk(name: string): Promise<string> {
  return fs.readFile(flowPath(name), "utf8");
}

async function flowOnDisk(name: string): Promise<FlowFile> {
  return parseFlow(await onDisk(name));
}

async function start(name: string): Promise<void> {
  await flowStartRecordingTool.execute({}, { name, project_root: root });
}

async function session(name: string): Promise<RecordingSession> {
  const live = await getRecordingSession(root, name);
  if (!live) throw new Error(`no live recording "${name}"`);
  return live;
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

/** `.mjs` source that writes a marker file, to prove the script started. */
function writesMark(mark: string, rest = ""): string {
  return (
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(markPath(mark))}, "ran");\n` +
    rest
  );
}

function mockRegistry(results: Record<string, unknown>) {
  const invokeTool = vi.fn(async (id: string) => {
    if (!(id in results)) throw new Error(`Tool "${id}" not found`);
    return results[id];
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the call to fail");
}

function addKeyboard(registry: Registry, name: string) {
  return createFlowAddStepTool(registry).execute(
    {},
    { name, project_root: root, command: "keyboard", args: JSON.stringify({ text: "hi" }) }
  );
}

function addFlowExecute(registry: Registry, name: string, fragment: string, delayMs?: number) {
  return createFlowAddStepTool(registry).execute(
    {},
    {
      name,
      project_root: root,
      command: "flow-execute",
      args: JSON.stringify({ name: fragment, project_root: root, udid: "ABC" }),
      ...(delayMs !== undefined ? { delayMs } : {}),
    }
  );
}

function addEcho(name: string, message: string) {
  return flowInsertEchoTool.execute({}, { name, project_root: root, message });
}

function addScript(name: string, scriptPath: string) {
  return flowAddScriptTool.execute({}, { name, project_root: root, path: scriptPath });
}

function finish(name: string) {
  return flowFinishRecordingTool.execute({}, { name, project_root: root });
}

const HAND_ENV = { API_URL: "https://staging.example" };

const HAND_TEARDOWN: FlowStep[] = [
  { kind: "script", path: "../../scripts/delete-order.mjs" },
  { kind: "echo", message: "cleaned up" },
];

const HAND_HEADER =
  "env:\n  API_URL: https://staging.example\n" +
  "steps: []\n" +
  "teardown:\n" +
  "  - script: { path: ../../scripts/delete-order.mjs }\n" +
  "  - echo: cleaned up\n";

/** A flow-execute result whose run failed in a teardown step. */
function failedRun(flow: string) {
  return {
    flow,
    ok: false,
    passed: 1,
    failed: 0,
    errored: 1,
    steps: [
      { kind: "tool", status: "pass" },
      {
        kind: "script",
        status: "error",
        reason: 'Script "x.mjs" does not exist',
        teardown: true,
      },
    ],
  };
}

function failureWarning(flow: string): string {
  return (
    `the live flow-execute run did not pass (flow "${flow}" failed: 1 passed, 0 failed, 1 errored ` +
    `(teardown step script: Script "x.mjs" does not exist)). The step is recorded, but at replay ` +
    "the same failure stops the flow at this step and skips every step after it. Fix the flow it " +
    "runs, or remove this step, before you rely on the recording"
  );
}

function outputWarning(fragment: string): string {
  return (
    `the live flow-execute ran ${fragment}.yaml as a run of its own, which started with an ` +
    "empty output document, and argent kept none of the output its scripts wrote; at replay " +
    "the run: step shares this flow's output document, so its scripts and references can see " +
    "different values than they did now"
  );
}

function envWarning(fragment: string): string {
  return (
    `at replay the run: step passes API_URL from this recording's env: to ${fragment}.yaml's ` +
    "scripts, but the live flow-execute call ran without it. To make the two match, declare it " +
    `in ${fragment}.yaml's own env:, or keep the raw flow-execute step (recording the call with ` +
    "a delayMs does that)"
  );
}

const FAILURE_HEADLINE =
  "1 step recorded a flow-execute call whose run failed live, and it stops the replay there";
const READ_SUMMARY = "; read `summary` before converting or replaying";

describe("a host-mode recording keeps an author-written teardown list", () => {
  it("keeps the teardown and env through flow-add-step, flow-add-script and flow-add-echo", async () => {
    await write("scripts/seed.mjs", writesMark("seed", "output.order = { id: 7 };\n"));
    await start("kept");
    await fs.writeFile(flowPath("kept"), HAND_HEADER, "utf8");
    const { registry, invokeTool } = mockRegistry({ keyboard: { typed: "hi" } });

    await addKeyboard(registry, "kept");
    expect(invokeTool).toHaveBeenCalledWith("keyboard", { text: "hi" });
    const keyboard: FlowStep = { kind: "tool", name: "keyboard", args: { text: "hi" } };
    expect(await flowOnDisk("kept")).toEqual({
      executionPrerequisite: "",
      env: HAND_ENV,
      steps: [keyboard],
      teardown: HAND_TEARDOWN,
    });

    const script = await addScript("kept", "../../scripts/seed.mjs");
    expect(script.status).toBe("pass");
    expect(await exists(markPath("seed"))).toBe(true);
    const seed: FlowStep = { kind: "script", path: "../../scripts/seed.mjs" };
    expect(await flowOnDisk("kept")).toEqual({
      executionPrerequisite: "",
      env: HAND_ENV,
      steps: [keyboard, seed],
      teardown: HAND_TEARDOWN,
    });

    await addEcho("kept", "seeded");
    expect(await flowOnDisk("kept")).toEqual({
      executionPrerequisite: "",
      env: HAND_ENV,
      steps: [keyboard, seed, { kind: "echo", message: "seeded" }],
      teardown: HAND_TEARDOWN,
    });
    expect(await onDisk("kept")).toMatch(
      /\nteardown:\n {2}- script:\n[\s\S]*- echo: cleaned up\n$/
    );
  });

  it("keeps an author-written empty teardown list", async () => {
    await start("empty");
    await fs.writeFile(flowPath("empty"), "steps: []\nteardown: []\n", "utf8");

    await addEcho("empty", "hello");

    expect(await onDisk("empty")).toBe("steps:\n  - echo: hello\nteardown: []\n");
  });
});

describe("a host-mode recording refuses a teardown list the parser refuses", () => {
  const BAD_FILES: [label: string, yaml: string, reason: string][] = [
    [
      "an empty teardown key",
      "steps: []\nteardown:\n",
      "Invalid flow file: `teardown` must be a list of steps, like `steps`, but it is empty (null).",
    ],
    [
      "a snapshot in the teardown list",
      "steps: []\nteardown:\n  - echo: cleaning\n  - snapshot: home\n",
      "Teardown step 2 (`snapshot`) cannot be in a teardown list",
    ],
  ];

  it.each(BAD_FILES)("blames the file in flow-add-step for %s", async (_label, yaml, reason) => {
    await start("bad");
    await fs.writeFile(flowPath("bad"), yaml, "utf8");
    const { registry, invokeTool } = mockRegistry({ keyboard: { typed: "hi" } });

    const err = await rejection(addKeyboard(registry, "bad"));

    expect(invokeTool).toHaveBeenCalledWith("keyboard", { text: "hi" });
    expect(err.message).toMatch(
      /^The `keyboard` call ran, but something already in the flow file failed validation\. Fix what is named below — it is not in this call\. Check the call's changes before you retry\. /
    );
    expect(err.message).toContain(reason);
    expect(["flow_file_parse", "flow_file_parse_step"]).toContain(
      getFailureSignal(err)?.failure_stage
    );
    expect(await onDisk("bad")).toBe(yaml);
  });

  it.each(BAD_FILES)("blames the file in flow-add-echo for %s", async (_label, yaml, reason) => {
    await start("bad");
    await fs.writeFile(flowPath("bad"), yaml, "utf8");

    const err = await rejection(addEcho("bad", "hello"));

    expect(err.message).toContain(
      `The echo was not recorded. Fix what is named below in ${flowPath("bad")} — it is already ` +
        `in the file, not in this call. ${reason}`
    );
    expect(err.message).not.toContain("its own `message` failed validation");
    expect(await onDisk("bad")).toBe(yaml);
  });

  it.each(BAD_FILES)(
    "blames the file in flow-add-script, without running it, for %s written before the call",
    async (_label, yaml, reason) => {
      await write("scripts/seed.mjs", writesMark("seed"));
      await start("bad");
      await fs.writeFile(flowPath("bad"), yaml, "utf8");

      const err = await rejection(addScript("bad", "../../scripts/seed.mjs"));

      expect(err.message).toMatch(
        /^The script "\.\.\/\.\.\/scripts\/seed\.mjs" was NOT run and nothing was recorded in "bad": /
      );
      expect(err.message).toContain("The reason below is about the FILE, not about this script.");
      expect(err.message).toContain(reason);
      expect(await exists(markPath("seed"))).toBe(false);
      expect(await onDisk("bad")).toBe(yaml);
    }
  );

  it.each(BAD_FILES)(
    "blames the file in flow-add-script for %s written while the script ran",
    async (_label, yaml, reason) => {
      await start("bad");
      await write(
        "scripts/breaks.mjs",
        writesMark(
          "breaks",
          `writeFileSync(${JSON.stringify(flowPath("bad"))}, ${JSON.stringify(yaml)});\n` +
            "output.ok = true;\n"
        )
      );

      const err = await rejection(addScript("bad", "../../scripts/breaks.mjs"));

      expect(await exists(markPath("breaks"))).toBe(true);
      expect(err.message).toContain(
        `Script "../../scripts/breaks.mjs" passed, but the step was not recorded. Fix what is ` +
          `named below in ${flowPath("bad")} — it is already in the file, not in this script. ` +
          reason
      );
      expect(await onDisk("bad")).toBe(yaml);
    }
  );
});

describe("flow-finish-recording with a teardown list", () => {
  it("lists teardown lines after the step lines and keeps each warning on its step", async () => {
    await write(".argent/flows/plain.yaml", "steps:\n  - echo: plain\n");
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: fragment\n");
    await start("finished");
    await fs.writeFile(flowPath("finished"), HAND_HEADER, "utf8");
    const { registry } = mockRegistry({ "flow-execute": { ok: true, steps: [] } });
    const failing = mockRegistry({ "flow-execute": failedRun("frag") });

    await addFlowExecute(registry, "finished", "plain");
    await addEcho("finished", "between");
    await addFlowExecute(failing.registry, "finished", "frag");
    const finished = await finish("finished");

    expect(finished.steps).toBe(3);
    expect(finished.summary).toEqual([
      "1. run: plain.yaml",
      `   warning: ${envWarning("plain")}`,
      "2. echo: between",
      "3. run: frag.yaml",
      `   warning: ${failureWarning("frag")}; ${envWarning("frag")}`,
      "teardown 1. script: ../../scripts/delete-order.mjs",
      "teardown 2. echo: cleaned up",
    ]);
    expect(finished.message).toBe(
      'Finished recording "finished" flow (3 steps, 2 teardown steps) — ' +
        `${FAILURE_HEADLINE}, and 1 step replays under a different env than the recorded call ` +
        `ran with${READ_SUMMARY}`
    );
    expect(parseFlow(finished.flowFile).teardown).toEqual(HAND_TEARDOWN);
  });

  it("counts a teardown list written after the last recorded step", async () => {
    await start("late");
    await addEcho("late", "one");
    await addEcho("late", "two");
    await addEcho("late", "three");
    await fs.appendFile(flowPath("late"), "teardown:\n  - echo: bye\n", "utf8");

    const finished = await finish("late");

    expect(finished.steps).toBe(3);
    expect(finished.summary).toEqual([
      "1. echo: one",
      "2. echo: two",
      "3. echo: three",
      "teardown 1. echo: bye",
    ]);
    expect(finished.message).toBe('Finished recording "late" flow (3 steps, 1 teardown step)');
  });

  it.each([
    ["no teardown key", ""],
    ["an empty teardown list", "teardown: []\n"],
  ])("keeps the plain step count for %s", async (_label, tail) => {
    await start("plain");
    await addEcho("plain", "one");
    await addEcho("plain", "two");
    await addEcho("plain", "three");
    if (tail) await fs.appendFile(flowPath("plain"), tail, "utf8");

    const finished = await finish("plain");

    expect(finished.summary).toEqual(["1. echo: one", "2. echo: two", "3. echo: three"]);
    expect(finished.message).toBe('Finished recording "plain" flow (3 steps)');
  });
});

describe("flow-add-step and a flow-execute run that failed live", () => {
  it("records the run: step with the failure warning in its message and in the finish", async () => {
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: fragment\n");
    await start("rec");
    const { registry, invokeTool } = mockRegistry({ "flow-execute": failedRun("frag") });

    const result = await addFlowExecute(registry, "rec", "frag");

    expect(invokeTool).toHaveBeenCalledWith("flow-execute", {
      name: "frag",
      project_root: root,
      udid: "ABC",
    });
    expect(result.recorded).toBe("1. run: frag.yaml");
    expect(result.message).toBe(`Step added to "rec" flow — ${failureWarning("frag")}`);
    expect((await flowOnDisk("rec")).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
    expect([...((await session("rec")).stepWarnings ?? new Map()).values()]).toMatchObject([
      { kind: "failure", warning: failureWarning("frag") },
    ]);

    const finished = await finish("rec");

    expect(finished.summary).toEqual([
      "1. run: frag.yaml",
      `   warning: ${failureWarning("frag")}`,
    ]);
    expect(finished.message).toBe(
      `Finished recording "rec" flow (1 steps) — ${FAILURE_HEADLINE}${READ_SUMMARY}`
    );
  });

  it("records the raw flow-execute step with the failure warning in its message and in the finish", async () => {
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: fragment\n");
    await start("rec");
    const { registry } = mockRegistry({ "flow-execute": failedRun("frag") });

    const result = await addFlowExecute(registry, "rec", "frag", 250);

    const raw: FlowStep = {
      kind: "tool",
      name: "flow-execute",
      args: { name: "frag", project_root: root },
      delayMs: 250,
    };
    expect(result.message).toBe(`Step added to "rec" flow — ${failureWarning("frag")}`);
    expect((await flowOnDisk("rec")).steps).toEqual([raw]);

    const finished = await finish("rec");

    expect(finished.summary).toEqual([
      summarizeStep(raw, 1),
      `   warning: ${failureWarning("frag")}`,
    ]);
    expect(finished.message).toBe(
      `Finished recording "rec" flow (1 steps) — ${FAILURE_HEADLINE}${READ_SUMMARY}`
    );
  });

  it("keeps one warning entry per step, the failure first and the output warning after it", async () => {
    await write(
      ".argent/flows/seeded.yaml",
      "steps:\n  - script: { path: ../../scripts/seed.mjs }\n"
    );
    await start("rec");
    const { registry } = mockRegistry({ "flow-execute": failedRun("seeded") });

    const result = await addFlowExecute(registry, "rec", "seeded");

    const both = `${failureWarning("seeded")}; ${outputWarning("seeded")}`;
    expect(result.message).toBe(`Step added to "rec" flow — ${both}`);
    const warnings = (await session("rec")).stepWarnings;
    expect(warnings?.size).toBe(1);
    expect(warnings?.get(1)).toMatchObject({ kind: "failure", warning: both });

    const finished = await finish("rec");

    expect(finished.summary).toEqual(["1. run: seeded.yaml", `   warning: ${both}`]);
    expect(finished.message).toBe(
      `Finished recording "rec" flow (1 steps) — ${FAILURE_HEADLINE}${READ_SUMMARY}`
    );
    expect(finished.message).not.toContain("replays under a different env");
  });

  const NOT_FAILED: [label: string, result: unknown][] = [
    [
      "a prerequisite notice",
      {
        flow: "frag",
        notice: "This flow has an execution prerequisite. Confirm it before running.",
        executionPrerequisite: "App on home screen",
      },
    ],
    [
      "a cancelled run",
      {
        flow: "frag",
        ok: false,
        aborted: true,
        passed: 1,
        failed: 0,
        errored: 1,
        steps: [
          { kind: "tool", status: "pass" },
          { kind: "script", status: "error", reason: "cancelled" },
          { kind: "echo", status: "skip", reason: "run aborted", teardown: true },
        ],
      },
    ],
  ];

  it.each(NOT_FAILED)("gives %s no failure warning", async (_label, live) => {
    await write(".argent/flows/frag.yaml", "steps:\n  - echo: fragment\n");
    await start("rec");
    const { registry } = mockRegistry({ "flow-execute": live });

    const result = await addFlowExecute(registry, "rec", "frag");

    expect(result.message).toBe('Step added to "rec" flow');
    expect((await flowOnDisk("rec")).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
    expect((await session("rec")).stepWarnings?.size ?? 0).toBe(0);
    expect((await finish("rec")).message).toBe('Finished recording "rec" flow (1 steps)');
  });

  it.each([
    ["a teardown script", "teardown:\n  - script: { path: ../../scripts/clean.mjs }\n"],
    ["a teardown output reference", 'teardown:\n  - echo: "deleted {{output:order.id}}"\n'],
  ])("warns about the output document for a fragment whose only reader is %s", async (_l, tail) => {
    await write(".argent/flows/cleans.yaml", `steps:\n  - echo: fragment\n${tail}`);
    await start("rec");
    const { registry } = mockRegistry({ "flow-execute": { ok: true, steps: [] } });

    const result = await addFlowExecute(registry, "rec", "cleans");

    expect(result.message).toBe(`Step added to "rec" flow — ${outputWarning("cleans")}`);
    expect((await flowOnDisk("rec")).steps).toEqual([{ kind: "run", flow: "cleans.yaml" }]);
  });

  it("stays quiet for a fragment whose teardown reads no output", async () => {
    await write(
      ".argent/flows/quiet.yaml",
      "steps:\n  - echo: fragment\nteardown:\n  - echo: bye\n"
    );
    await start("rec");
    const { registry } = mockRegistry({ "flow-execute": { ok: true, steps: [] } });

    const result = await addFlowExecute(registry, "rec", "quiet");

    expect(result.message).toBe('Step added to "rec" flow');
    expect((await flowOnDisk("rec")).steps).toEqual([{ kind: "run", flow: "quiet.yaml" }]);
  });
});

describe("a client-mode recording and the teardown key", () => {
  const CLIENT_ROOT = path.join(os.tmpdir(), "definitely-not-on-this-host", "teardown-project");

  function remoteCtx(): ToolContext {
    return {
      artifacts: new ArtifactStore(),
      fileInputs: {
        project_root: { clientPath: CLIENT_ROOT, presentOnHost: false, viaUpload: false },
      },
    };
  }

  // No client-mode code reads the client's file, so the key can only reach the
  // in-memory flow by hand.
  it("writes and counts a teardown list only when the session holds one", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "remote", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    const live = await getRecordingSession(CLIENT_ROOT, "remote");
    expect(live?.persist).toBe("client");
    live!.flow.teardown = [{ kind: "echo", message: "bye" }];

    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "remote", project_root: CLIENT_ROOT, message: "hello" }
    );
    const directive = echo.savedTo as { [CLIENT_FILE_MARKER]: true; content: string };
    expect(directive[CLIENT_FILE_MARKER]).toBe(true);
    expect(parseFlow(directive.content)).toEqual({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "hello" }],
      teardown: [{ kind: "echo", message: "bye" }],
    });

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "remote", project_root: CLIENT_ROOT }
    );
    expect(finished.summary).toEqual(["1. echo: hello", "teardown 1. echo: bye"]);
    expect(finished.message).toBe('Finished recording "remote" flow (1 steps, 1 teardown step)');
    await expect(fs.stat(CLIENT_ROOT)).rejects.toThrow();
  });

  it("refuses an append while the session's teardown holds a snapshot, and drops the step", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "remote", project_root: CLIENT_ROOT },
      remoteCtx()
    );
    const live = await getRecordingSession(CLIENT_ROOT, "remote");
    live!.flow.teardown = [{ kind: "snapshot", name: "home" }];

    const err = await rejection(
      flowInsertEchoTool.execute({}, { name: "remote", project_root: CLIENT_ROOT, message: "hi" })
    );

    expect(err.message).toContain("it is already in the file, not in this call.");
    expect(err.message).toContain("Teardown step 1 (`snapshot`) cannot be in a teardown list");
    expect(live!.flow.steps).toEqual([]);
  });
});

describe("the flow-start-recording description", () => {
  it("tells the agent to save and restore the teardown list around the reset", () => {
    expect(flowStartRecordingTool.description).toContain(
      "Save any top-level `env` defaults and `teardown` list before this call. Restore them " +
        "after recording."
    );
  });
});
