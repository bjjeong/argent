import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { FAILURE_CODES, getFailureSignal, type Registry, type ToolContext } from "@argent/registry";
import type { DescribeTreeData } from "../../../src/tools/describe/contract";

// A coordinate tap in a teardown list reads the screen through the flow tree;
// serve an empty window so the tap dispatches without a device.
vi.mock("../../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: {
        role: "AXWindow",
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [],
      },
      source: "native-devtools",
    })
  ),
}));

// A launch that passes settles for a plain 1.5 s wait. Skip the wait and keep
// the abort check.
vi.mock("../../../src/utils/timing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/timing")>();
  return {
    ...actual,
    sleepOrAbort: async (_ms: number, signal?: AbortSignal) => !signal?.aborted,
  };
});

import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../../src/tools/flows/flow-run";
import { parseFlow } from "../../../src/tools/flows/flow-utils";
import { buildChildEnv } from "../../../src/tools/flows/script/flow-script-executor";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 60_000 });

scopeTempHome("argent-flow-teardown-run-home-");

const execFileAsync = promisify(execFile);

const DEVICE = "00000000-0000-0000-0000-0000000000ad";

let root: string;

type InvokeHook = (id: string, params: Record<string, unknown>) => unknown;

interface RunOptions {
  /** Whether `list-devices` reports {@link DEVICE} as booted. */
  booted?: boolean;
  invoke?: InvokeHook;
  /** Input-schema properties per tool id; any other tool declares `udid`. */
  schemas?: Record<string, Record<string, unknown>>;
  /** The `device` param; `null` leaves it out so the run resolves one. */
  device?: string | null;
  ctx?: Partial<ToolContext>;
  params?: Record<string, unknown>;
}

function mockRegistry(opts: RunOptions) {
  const invokeTool = vi.fn(async (id: string, params?: unknown) => {
    if (id === "list-devices") {
      return {
        devices: opts.booted ? [{ platform: "ios", udid: DEVICE, state: "Booted" }] : [],
      };
    }
    const args = (params ?? {}) as Record<string, unknown>;
    return opts.invoke ? opts.invoke(id, args) : { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn((id: string) => ({
      inputSchema: { properties: opts.schemas?.[id] ?? { udid: {} } },
    })),
    // The launch gate asks native devtools whether the app connected.
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

type InvokeMock = ReturnType<typeof mockRegistry>["invokeTool"];

function startRun(
  name: string,
  opts: RunOptions = {}
): { pending: Promise<unknown>; invokeTool: InvokeMock } {
  const { registry, invokeTool } = mockRegistry(opts);
  const params = {
    project_root: root,
    name,
    ...(opts.device === null ? {} : { device: opts.device ?? DEVICE }),
    ...opts.params,
  };
  const pending = createRunFlowTool(registry).execute(
    {},
    params as never,
    opts.ctx as ToolContext | undefined
  );
  return { pending, invokeTool };
}

function asRun(r: unknown): FlowRunResult {
  if (typeof r !== "object" || r === null || !("steps" in r)) {
    throw new Error(`expected a run result, got: ${JSON.stringify(r)}`);
  }
  return r as FlowRunResult;
}

async function runFlow(
  name: string,
  opts: RunOptions = {}
): Promise<{ result: FlowRunResult; invokeTool: InvokeMock }> {
  const { pending, invokeTool } = startRun(name, opts);
  return { result: asRun(await pending), invokeTool };
}

async function refusalOf(name: string, opts: RunOptions = {}) {
  const { pending, invokeTool } = startRun(name, opts);
  const error = await pending.then(
    (result) => {
      throw new Error(`flow ran instead of being refused: ${JSON.stringify(result)}`);
    },
    (err: unknown) => err
  );
  return { error, invokeTool };
}

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

/** A flow file under `.argent/flows`; `name` may hold a subdirectory. */
function flow(name: string, ...lines: string[]): Promise<string> {
  return write(path.join(".argent", "flows", `${name}.yaml`), `${lines.join("\n")}\n`);
}

/** A script at `relative` to the flows directory, as a root flow spells its path. */
function script(relative: string, contents: string): Promise<string> {
  return write(path.join(".argent", "flows", relative), contents);
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

function shellMarkPath(mark: string): string {
  return markPath(mark).replace(/\\/g, "/");
}

function readMark(mark: string): string | undefined {
  try {
    return fsSync.readFileSync(markPath(mark), "utf8");
  } catch {
    return undefined;
  }
}

/** A .mjs that appends `line` to a marker, so a second start shows as a second line. */
function marker(mark: string, line = "ran"): string {
  return (
    `import fs from "node:fs";\n` +
    `fs.appendFileSync(${JSON.stringify(markPath(mark))}, ${JSON.stringify(`${line}\n`)});\n`
  );
}

function toolsCalled(invokeTool: InvokeMock): string[] {
  return invokeTool.mock.calls.map((call) => call[0]).filter((id) => id !== "list-devices");
}

function argsSentTo(invokeTool: InvokeMock, tool: string): Array<Record<string, unknown>> {
  return invokeTool.mock.calls
    .filter((call) => call[0] === tool)
    .map((call) => call[1] as Record<string, unknown>);
}

/** Each report as [kind, tool or target, status, depth, teardown]. */
function shape(steps: readonly StepReport[]): unknown[][] {
  return steps.map((s) => [s.kind, s.tool ?? s.target, s.status, s.depth, s.teardown]);
}

const throws =
  (...tools: string[]): InvokeHook =>
  (id) => {
    if (tools.includes(id)) throw new Error(`${id} went wrong`);
    return { ok: true };
  };

let noBash: string | undefined;
let noJq: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) {
    noBash = found.problem;
    return;
  }
  // Asked through the same bash and the same environment a script step gets.
  try {
    await execFileAsync(found.path, ["-c", "command -v jq"], { env: buildChildEnv(undefined) });
  } catch {
    noJq = "jq is not on the PATH a script step gets";
  }
});

function skipWithoutJq(ctx: { skip: (note?: string) => void }): void {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
  if (noJq) ctx.skip(noJq);
}

beforeEach(async () => {
  // realpath'd, so the script markers and the runner's canonical paths agree.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-run-")));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("when the teardown list runs", () => {
  it.each([
    { ending: "pass", step: "step-a", invoke: undefined, status: "pass" },
    {
      ending: "fail",
      step: "await-ui-element",
      invoke: ((id) =>
        id === "await-ui-element" ? { success: false } : { ok: true }) as InvokeHook,
      status: "fail",
    },
    { ending: "error", step: "step-a", invoke: throws("step-a"), status: "error" },
  ])(
    "runs the teardown list after steps that end with $ending, after the step reports and labelled",
    async ({ step, invoke, status }) => {
      await script("scripts/cleanup.mjs", marker("cleanup"));
      await flow(
        "ending",
        "steps:",
        `  - tool: ${step}`,
        "  - tool: step-b",
        "teardown:",
        "  - script: { path: scripts/cleanup.mjs }",
        "  - tool: cleanup-tool"
      );

      const { result, invokeTool } = await runFlow("ending", { invoke });

      const passed = status === "pass";
      expect(shape(result.steps)).toEqual([
        ["tool", step, status, undefined, undefined],
        ["tool", "step-b", passed ? "pass" : "skip", undefined, undefined],
        ["script", "scripts/cleanup.mjs", "pass", undefined, true],
        ["tool", "cleanup-tool", "pass", undefined, true],
      ]);
      expect(readMark("cleanup")).toBe("ran\n");
      expect(toolsCalled(invokeTool)).toEqual([
        step,
        ...(passed ? ["step-b"] : []),
        "cleanup-tool",
      ]);
      expect(result.ok).toBe(passed);
    }
  );

  it("runs the teardown list when the first step fails, starting at its first teardown step", async () => {
    await script("scripts/seed.mjs", `throw new Error("seed failed");\n`);
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "first-fails",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }",
      "  - tool: cleanup-tool"
    );

    const { result, invokeTool } = await runFlow("first-fails");

    expect(shape(result.steps)).toEqual([
      ["script", "scripts/seed.mjs", "fail", undefined, undefined],
      ["script", "scripts/cleanup.mjs", "pass", undefined, true],
      ["tool", "cleanup-tool", "pass", undefined, true],
    ]);
    expect(result.steps[1]!.reason).toBeUndefined();
    expect(readMark("cleanup")).toBe("ran\n");
    expect(toolsCalled(invokeTool)).toEqual(["cleanup-tool"]);
    expect(result.ok).toBe(false);
  });

  it("keeps the parent stopped after a fragment whose first step failed ran its passing teardown", async () => {
    await flow(
      "parent",
      "steps:",
      "  - run: frag.yaml",
      "  - tool: parent-after",
      "teardown:",
      "  - tool: parent-cleanup"
    );
    await flow("frag", "steps:", "  - tool: frag-step", "teardown:", "  - tool: frag-cleanup");

    const { result, invokeTool } = await runFlow("parent", { invoke: throws("frag-step") });

    expect(shape(result.steps)).toEqual([
      ["run", "frag.yaml", "pass", undefined, undefined],
      ["tool", "frag-step", "error", 1, undefined],
      ["tool", "frag-cleanup", "pass", 1, true],
      ["tool", "parent-after", "skip", undefined, undefined],
      ["tool", "parent-cleanup", "pass", undefined, true],
    ]);
    expect(toolsCalled(invokeTool)).toEqual(["frag-step", "frag-cleanup", "parent-cleanup"]);
    expect(result.ok).toBe(false);
  });

  it("runs the teardown list when a throw leaves the steps, then rejects with that throw", async () => {
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "throwing-sink",
      "steps:",
      "  - tool: step-a",
      "  - tool: step-b",
      "  - tool: step-c",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }",
      "  - tool: cleanup-tool"
    );
    const boom = new Error("the progress sink failed");
    const events: StepReport[] = [];
    // The runner hands every report to the progress sink as it pushes it, so a
    // sink that throws is a real throw out of the steps.
    const emitProgress = (event: unknown): void => {
      const report = event as StepReport;
      events.push(report);
      if (report.tool === "step-b") throw boom;
    };

    const { pending, invokeTool } = startRun("throwing-sink", { ctx: { emitProgress } });

    await expect(pending).rejects.toBe(boom);
    expect(readMark("cleanup")).toBe("ran\n");
    expect(toolsCalled(invokeTool)).toEqual(["step-a", "step-b", "cleanup-tool"]);
    // After a throw, the stream is the only place the teardown reports reach.
    expect(shape(events)).toEqual([
      ["tool", "step-a", "pass", undefined, undefined],
      ["tool", "step-b", "pass", undefined, undefined],
      ["script", "scripts/cleanup.mjs", "pass", undefined, true],
      ["tool", "cleanup-tool", "pass", undefined, true],
    ]);
  });
});

describe("no teardown after a cancel", () => {
  it("skips every teardown step with `run aborted` and no warning when the run is cancelled during a step", async () => {
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "cancelled",
      "steps:",
      "  - tool: step-a",
      "  - tool: step-b",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }",
      "  - tool: cleanup-tool",
      "  - echo: cleaning up",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: when-tool"
    );
    const controller = new AbortController();

    const { result, invokeTool } = await runFlow("cancelled", {
      ctx: { signal: controller.signal },
      invoke: (id) => {
        if (id === "step-b") controller.abort();
        return { ok: true };
      },
    });

    expect(result.steps.map((s) => [s.kind, s.status, s.reason, s.depth, s.teardown])).toEqual([
      ["tool", "pass", undefined, undefined, undefined],
      ["tool", "pass", undefined, undefined, undefined],
      ["script", "skip", "run aborted", undefined, true],
      ["tool", "skip", "run aborted", undefined, true],
      ["echo", "skip", "run aborted", undefined, true],
      ["when", "skip", "run aborted", undefined, true],
      ["tool", "skip", "run aborted", 1, true],
    ]);
    expect(result.steps.map((s) => s.warning)).toEqual(result.steps.map(() => undefined));
    expect(readMark("cleanup")).toBeUndefined();
    expect(toolsCalled(invokeTool)).toEqual(["step-a", "step-b"]);
    expect(result).toMatchObject({ ok: false, aborted: true });
  });

  it("stops the teardown list when the run is cancelled during a teardown step, and fails the run", async () => {
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "cancelled-in-teardown",
      "steps:",
      "  - tool: step-a",
      "teardown:",
      "  - tool: cleanup-first",
      "  - script: { path: scripts/cleanup.mjs }",
      "  - tool: cleanup-last"
    );
    const controller = new AbortController();

    const { result, invokeTool } = await runFlow("cancelled-in-teardown", {
      ctx: { signal: controller.signal },
      invoke: (id) => {
        if (id === "cleanup-first") controller.abort();
        return { ok: true };
      },
    });

    expect(result.steps.map((s) => [s.kind, s.status, s.reason, s.teardown])).toEqual([
      ["tool", "pass", undefined, undefined],
      ["tool", "pass", undefined, true],
      ["script", "skip", "run aborted", true],
      ["tool", "skip", "run aborted", true],
    ]);
    expect(result.steps.map((s) => s.warning)).toEqual(result.steps.map(() => undefined));
    expect(readMark("cleanup")).toBeUndefined();
    expect(toolsCalled(invokeTool)).toEqual(["step-a", "cleanup-first"]);
    expect(result).toMatchObject({ ok: false, aborted: true });
  });
});

describe("fragment teardown lists", () => {
  it("runs teardown lists inner to outer, each when its flow's steps end", async () => {
    await flow(
      "outer",
      "steps:",
      "  - run: a.yaml",
      "  - tool: outer-next",
      "teardown:",
      "  - tool: outer-cleanup"
    );
    await flow("a", "steps:", "  - run: b.yaml", "teardown:", "  - tool: a-cleanup");
    await flow("b", "steps:", "  - tool: b-step", "teardown:", "  - tool: b-cleanup");

    const { result, invokeTool } = await runFlow("outer");

    expect(toolsCalled(invokeTool)).toEqual([
      "b-step",
      "b-cleanup",
      "a-cleanup",
      "outer-next",
      "outer-cleanup",
    ]);
    expect(result.steps.map((s) => [s.flow, ...shape([s])[0]!])).toEqual([
      ["a", "run", "a.yaml", "pass", undefined, undefined],
      ["b", "run", "b.yaml", "pass", 1, undefined],
      ["b", "tool", "b-step", "pass", 2, undefined],
      ["b", "tool", "b-cleanup", "pass", 2, true],
      ["a", "tool", "a-cleanup", "pass", 1, true],
      ["outer", "tool", "outer-next", "pass", undefined, undefined],
      ["outer", "tool", "outer-cleanup", "pass", undefined, true],
    ]);
    expect(result.ok).toBe(true);
  });

  it("runs a fragment's teardown script beside the fragment, with the fragment's env defaults, reported at its depth", async () => {
    await flow("scoped", "steps:", "  - run: sub/frag.yaml");
    await script("clean.mjs", marker("root-clean"));
    await flow(
      "sub/frag",
      "env:",
      "  FRAG_NOTE: from-frag",
      "steps:",
      "  - echo: in the fragment",
      "teardown:",
      "  - script: { path: clean.mjs }"
    );
    await script(
      "sub/clean.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(markPath("frag-clean"))}, process.env.FRAG_NOTE ?? "unset");\n`
    );

    const { result } = await runFlow("scoped");

    expect(readMark("frag-clean")).toBe("from-frag");
    expect(readMark("root-clean")).toBeUndefined();
    const cleanup = result.steps.find((s) => s.kind === "script");
    expect(cleanup).toMatchObject({
      kind: "script",
      status: "pass",
      flow: "frag",
      target: "clean.mjs",
      depth: 1,
      teardown: true,
    });
    expect(result.ok).toBe(true);
  });

  it("errors a teardown run: of the fragment it is in as a cycle, without running the fragment's steps again", async () => {
    await flow("cyclic", "steps:", "  - run: sub/frag.yaml");
    await flow(
      "sub/frag",
      "steps:",
      "  - tool: frag-step",
      "teardown:",
      "  - script: { path: clean.mjs }",
      "  - run: frag.yaml"
    );
    await script("sub/clean.mjs", marker("frag-clean"));

    const { result, invokeTool } = await runFlow("cyclic");

    expect(toolsCalled(invokeTool)).toEqual(["frag-step"]);
    expect(readMark("frag-clean")).toBe("ran\n");
    expect(result.steps.map((s) => [s.flow, ...shape([s])[0]!])).toEqual([
      ["frag", "run", "sub/frag.yaml", "pass", undefined, undefined],
      ["frag", "tool", "frag-step", "pass", 1, undefined],
      ["frag", "script", "clean.mjs", "pass", 1, true],
      ["frag", "run", "frag.yaml", "error", 1, true],
    ]);
    expect(result.steps[3]!.reason).toBe("cyclic flow reference: cyclic → frag → frag");
    expect(result.ok).toBe(false);
  });

  it("skips the parent's remaining steps without a reason after a fragment teardown step fails, and runs the parent's teardown", async () => {
    await script("scripts/after.mjs", marker("after"));
    await flow(
      "parent",
      "steps:",
      "  - run: frag.yaml",
      "  - tool: parent-after",
      "  - script: { path: scripts/after.mjs }",
      "teardown:",
      "  - tool: parent-cleanup"
    );
    await flow("frag", "steps:", "  - tool: frag-step", "teardown:", "  - tool: frag-cleanup");

    const { result, invokeTool } = await runFlow("parent", { invoke: throws("frag-cleanup") });

    expect(shape(result.steps)).toEqual([
      ["run", "frag.yaml", "pass", undefined, undefined],
      ["tool", "frag-step", "pass", 1, undefined],
      ["tool", "frag-cleanup", "error", 1, true],
      ["tool", "parent-after", "skip", undefined, undefined],
      ["script", "scripts/after.mjs", "skip", undefined, undefined],
      ["tool", "parent-cleanup", "pass", undefined, true],
    ]);
    expect(result.steps.slice(3, 5).map((s) => [s.reason, s.warning])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(readMark("after")).toBeUndefined();
    expect(toolsCalled(invokeTool)).toEqual(["frag-step", "frag-cleanup", "parent-cleanup"]);
    expect(result.ok).toBe(false);
  });

  it("stops a teardown list at a run: step whose fragment fails, naming that run: step", async () => {
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "stops-at-run",
      "steps:",
      "  - echo: go",
      "teardown:",
      "  - run: bad.yaml",
      "  - script: { path: scripts/cleanup.mjs }"
    );
    await flow("bad", "steps:", "  - tool: bad-step");

    const { result } = await runFlow("stops-at-run", { invoke: throws("bad-step") });

    expect(shape(result.steps)).toEqual([
      ["echo", undefined, "pass", undefined, undefined],
      ["run", "bad.yaml", "pass", undefined, true],
      ["tool", "bad-step", "error", 1, true],
      ["script", "scripts/cleanup.mjs", "skip", undefined, true],
    ]);
    expect(result.steps[3]).toMatchObject({
      reason: "did not start: the teardown list stopped at run bad.yaml [bad]",
      warning:
        "this teardown step did not start because the teardown list stopped at " +
        "run bad.yaml [bad]. What it cleans up can remain",
    });
    expect(readMark("cleanup")).toBeUndefined();
    expect(result.ok).toBe(false);
  });
});

describe("the verdict with a teardown list", () => {
  it("fails a run whose steps pass when a teardown script fails, and counts it as failed", async () => {
    await script("scripts/cleanup.mjs", `throw new Error("cleanup failed");\n`);
    await flow(
      "teardown-fails",
      "steps:",
      "  - tool: step-a",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { result } = await runFlow("teardown-fails");

    expect(result.steps[1]).toMatchObject({ kind: "script", status: "fail", teardown: true });
    expect(result).toMatchObject({ ok: false, passed: 1, failed: 1, errored: 0, skipped: 0 });
  });

  it("fails a run whose steps pass when a teardown tool step errors, and counts it as errored", async () => {
    await flow("teardown-errors", "steps:", "  - tool: step-a", "teardown:", "  - tool: cleanup");

    const { result } = await runFlow("teardown-errors", { invoke: throws("cleanup") });

    expect(result.steps[1]).toMatchObject({ tool: "cleanup", status: "error", teardown: true });
    expect(result).toMatchObject({ ok: false, passed: 1, failed: 0, errored: 1, skipped: 0 });
  });

  it("keeps a failed run failed when its teardown passes, and counts the teardown step as passed", async () => {
    await flow("steps-fail", "steps:", "  - tool: step-a", "teardown:", "  - tool: cleanup");

    const { result } = await runFlow("steps-fail", { invoke: throws("step-a") });

    expect(result.steps[1]).toMatchObject({ tool: "cleanup", status: "pass", teardown: true });
    expect(result).toMatchObject({ ok: false, passed: 1, failed: 0, errored: 1, skipped: 0 });
  });
});

describe("teardown scripts read the committed output", () => {
  const seed = `output.order = { id: 42 };\n`;
  const unmetWait: InvokeHook = (id) =>
    id === "await-ui-element" ? { success: false } : { ok: true };

  it("hands a .mjs teardown script the output a failed run committed", async () => {
    await script("scripts/seed.mjs", seed);
    await script(
      "scripts/delete.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(markPath("deleted"))}, String(output.order?.id));\n`
    );
    await flow(
      "mjs-output",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "  - tool: await-ui-element",
      "teardown:",
      "  - script: { path: scripts/delete.mjs }"
    );

    const { result } = await runFlow("mjs-output", { invoke: unmetWait });

    expect(shape(result.steps)).toEqual([
      ["script", "scripts/seed.mjs", "pass", undefined, undefined],
      ["tool", "await-ui-element", "fail", undefined, undefined],
      ["script", "scripts/delete.mjs", "pass", undefined, true],
    ]);
    expect(readMark("deleted")).toBe("42");
    expect(result.ok).toBe(false);
  });

  // The brief's own cleanup form: `// empty` and the `-z` test keep a missing id
  // from becoming the text "null".
  const deleteSh = (): string =>
    `order_id=$(jq -r '.order.id // empty' "$ARGENT_OUTPUT")\n` +
    `if [ -z "$order_id" ]; then\n` +
    `  echo "no order was created, nothing to delete"\n` +
    `  printf 'none' > "${shellMarkPath("deleted")}"\n` +
    `  exit 0\n` +
    `fi\n` +
    `printf '%s' "$order_id" > "${shellMarkPath("deleted")}"\n`;

  it("hands a .sh teardown script the output a failed run committed, in $ARGENT_OUTPUT", async (ctx) => {
    skipWithoutJq(ctx);
    await script("scripts/seed.mjs", seed);
    await script("scripts/delete.sh", deleteSh());
    await flow(
      "sh-output",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "  - tool: await-ui-element",
      "teardown:",
      "  - script: { path: scripts/delete.sh }"
    );

    const { result } = await runFlow("sh-output", { invoke: unmetWait });

    expect(result.steps[2]).toMatchObject({
      kind: "script",
      target: "scripts/delete.sh",
      status: "pass",
      teardown: true,
    });
    expect(readMark("deleted")).toBe("42");
    expect(result.ok).toBe(false);
  });

  it("passes a .sh teardown script that reads `.order.id // empty` when no script wrote the id", async (ctx) => {
    skipWithoutJq(ctx);
    await script("scripts/seed.mjs", `throw new Error("the backend refused the order");\n`);
    await script("scripts/delete.sh", deleteSh());
    await flow(
      "sh-no-output",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - script: { path: scripts/delete.sh }"
    );

    const { result } = await runFlow("sh-no-output");

    expect(shape(result.steps)).toEqual([
      ["script", "scripts/seed.mjs", "fail", undefined, undefined],
      ["script", "scripts/delete.sh", "pass", undefined, true],
    ]);
    expect(readMark("deleted")).toBe("none");
  });
});

describe("flows that get no teardown", () => {
  it("runs no teardown for a run: step that is skipped", async () => {
    await script("scripts/frag-clean.mjs", marker("frag-clean"));
    await flow("skips-run", "steps:", "  - tool: step-a", "  - run: frag.yaml");
    await flow(
      "frag",
      "steps:",
      "  - echo: in the fragment",
      "teardown:",
      "  - script: { path: scripts/frag-clean.mjs }"
    );

    const { result } = await runFlow("skips-run", { invoke: throws("step-a") });

    expect(shape(result.steps)).toEqual([
      ["tool", "step-a", "error", undefined, undefined],
      ["run", "frag.yaml", "skip", undefined, undefined],
    ]);
    expect(readMark("frag-clean")).toBeUndefined();
  });

  // A cycle's target is already on the run stack, so it started and runs its
  // teardown once for that start; the cyclic `run:` adds no second one.
  it("runs no teardown for a cyclic run: step", async () => {
    await script("scripts/loop-clean.mjs", marker("loop-clean"));
    await flow("has-cycle", "steps:", "  - run: loop.yaml");
    await flow(
      "loop",
      "steps:",
      "  - run: loop.yaml",
      "teardown:",
      "  - script: { path: scripts/loop-clean.mjs }"
    );

    const { result } = await runFlow("has-cycle");

    expect(shape(result.steps)).toEqual([
      ["run", "loop.yaml", "pass", undefined, undefined],
      ["run", "loop.yaml", "error", 1, undefined],
      ["script", "scripts/loop-clean.mjs", "pass", 1, true],
    ]);
    expect(result.steps[1]!.reason).toBe("cyclic flow reference: has-cycle → loop → loop");
    expect(readMark("loop-clean")).toBe("ran\n");
  });

  it("runs no teardown for a run: step whose file fails to load", async () => {
    await script("scripts/broken-clean.mjs", marker("broken-clean"));
    await flow("loads-broken", "steps:", "  - run: broken.yaml");
    await flow(
      "broken",
      "steps:",
      "  - bogus: 1",
      "teardown:",
      "  - script: { path: scripts/broken-clean.mjs }"
    );

    const { result } = await runFlow("loads-broken");

    expect(shape(result.steps)).toEqual([["run", "broken.yaml", "error", undefined, undefined]]);
    expect(result.steps[0]!.reason).toMatch(/^could not load fragment "broken\.yaml": /);
    expect(readMark("broken-clean")).toBeUndefined();
  });

  it("runs no teardown when the run stops at the execution prerequisite notice", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    await script("scripts/cleanup.mjs", marker("cleanup"));
    await flow(
      "prerequisite",
      "executionPrerequisite: The shop is open",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { pending, invokeTool } = startRun("prerequisite");
    const answer = await pending;

    expect(answer).toMatchObject({
      flow: "prerequisite",
      executionPrerequisite: "The shop is open",
    });
    expect(answer).toHaveProperty("notice");
    expect(answer).not.toHaveProperty("steps");
    expect(readMark("seed")).toBeUndefined();
    expect(readMark("cleanup")).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

describe("a teardown script path that does not exist", () => {
  it("fails the teardown step with a report that names the script", async () => {
    await flow(
      "missing-script",
      "steps:",
      "  - tool: step-a",
      "teardown:",
      "  - script: { path: scripts/missing-cleanup.mjs }"
    );

    const { result } = await runFlow("missing-script");

    expect(result.steps[1]).toMatchObject({
      kind: "script",
      target: "scripts/missing-cleanup.mjs",
      teardown: true,
      status: "fail",
    });
    expect(result.steps[1]!.reason).toMatch(
      /^Script "scripts\/missing-cleanup\.mjs" does not exist\. Resolved path: .+missing-cleanup\.mjs\.$/
    );
    expect(result.ok).toBe(false);
  });
});

describe("the teardown label", () => {
  it("labels every report a teardown list makes, fragments and when blocks included, and no report of the steps", async () => {
    await flow(
      "labels",
      "steps:",
      "  - tool: step-a",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: step-when",
      "  - run: plain.yaml",
      "teardown:",
      "  - run: frag.yaml",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: cleanup-ios",
      "  - when: { platform: android }",
      "    steps:",
      "      - tool: cleanup-android",
      "      - echo: never on ios"
    );
    await flow("plain", "steps:", "  - tool: plain-step");
    await flow(
      "frag",
      "steps:",
      "  - tool: frag-step",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: frag-when"
    );

    const { result } = await runFlow("labels");

    expect(result.steps.map((s) => [s.kind, s.tool, s.status, s.depth, s.teardown])).toEqual([
      ["tool", "step-a", "pass", undefined, undefined],
      ["when", undefined, "pass", undefined, undefined],
      ["tool", "step-when", "pass", 1, undefined],
      ["run", undefined, "pass", undefined, undefined],
      ["tool", "plain-step", "pass", 1, undefined],
      ["run", undefined, "pass", undefined, true],
      ["tool", "frag-step", "pass", 1, true],
      ["when", undefined, "pass", 1, true],
      ["tool", "frag-when", "pass", 2, true],
      ["when", undefined, "pass", undefined, true],
      ["tool", "cleanup-ios", "pass", 1, true],
      ["when", undefined, "skip", undefined, true],
      ["tool", "cleanup-android", "skip", 1, true],
      ["echo", undefined, "skip", 1, true],
    ]);
    // Absent, not merely unset, so a report of the steps keeps its old shape.
    expect(result.steps.slice(0, 5).map((s) => Object.hasOwn(s, "teardown"))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(result.steps.slice(12).map((s) => s.reason)).toEqual([
      "when block skipped",
      "when block skipped",
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("a snapshot reached through a teardown run:", () => {
  it("errors the snapshot step without taking a screenshot, and stops the teardown list", async () => {
    await flow(
      "snap-teardown",
      "steps:",
      "  - tool: step-a",
      "teardown:",
      "  - run: snap.yaml",
      "  - tool: cleanup"
    );
    await flow("snap", "steps:", "  - snapshot: home");

    const { result, invokeTool } = await runFlow("snap-teardown");

    expect(result.steps[2]).toMatchObject({
      kind: "snapshot",
      status: "error",
      flow: "snap",
      depth: 1,
      teardown: true,
      reason:
        "a snapshot step cannot run in teardown: the teardown also runs after a failed run, " +
        "and with --update-baselines a snapshot would save the screen that run left as the " +
        "baseline",
    });
    expect(result.steps[3]).toMatchObject({ tool: "cleanup", status: "skip", teardown: true });
    expect(toolsCalled(invokeTool)).toEqual(["step-a"]);
    expect(result.ok).toBe(false);
  });
});

describe("a retired tool key in a teardown step", () => {
  const schemas = {
    "legacy-tool": { udid: {}, oldKey: { not: {}, description: "Retired: use newKey" } },
  };

  async function refusal(name: string) {
    const { error, invokeTool } = await refusalOf(name, { schemas });
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
    expect(readMark("seed")).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalled();
    return (error as Error).message;
  }

  it("refuses the flow before any step, naming the teardown step", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    await flow(
      "retired-teardown",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - tool: other-tool",
      "  - tool: legacy-tool",
      "    args: { oldKey: 1 }"
    );

    expect(await refusal("retired-teardown")).toBe(
      'Flow "retired-teardown" teardown step 2 as written (echo included) passes ' +
        "legacy-tool's retired `oldKey` key: use newKey"
    );
  });

  it("names a when: block inside the teardown list by its teardown step", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    await flow(
      "retired-teardown-when",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - echo: cleaning up",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: legacy-tool",
      "        args: { oldKey: 1 }"
    );

    expect(await refusal("retired-teardown-when")).toBe(
      'Flow "retired-teardown-when" teardown step 1 of the when: block at teardown step 2 as ' +
        "written (echo included) passes legacy-tool's retired `oldKey` key: use newKey"
    );
  });

  it("keeps the step N wording for a retired key in the steps of a flow with a teardown list", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    await flow(
      "retired-steps",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "  - tool: legacy-tool",
      "    args: { oldKey: 1 }",
      "teardown:",
      "  - tool: other-tool"
    );

    expect(await refusal("retired-steps")).toBe(
      'Flow "retired-steps" step 2 as written (echo included) passes ' +
        "legacy-tool's retired `oldKey` key: use newKey"
    );
  });

  it("errors the run: step of a fragment whose teardown list passes the key, before its steps", async () => {
    await script("scripts/frag-step.mjs", marker("frag-step"));
    await flow(
      "retired-frag",
      "steps:",
      "  - script: { path: scripts/frag-step.mjs }",
      "teardown:",
      "  - tool: legacy-tool",
      "    args: { oldKey: 1 }"
    );
    await flow("retired-parent", "steps:", "  - run: retired-frag.yaml", "  - tool: after");

    const { result, invokeTool } = await runFlow("retired-parent", { schemas });

    expect(result.steps.map((s) => [s.kind, s.status, s.tool ?? s.target])).toEqual([
      ["run", "error", "retired-frag.yaml"],
      ["tool", "skip", "after"],
    ]);
    expect(result.steps[0]!.reason).toBe(
      'fragment "retired-frag.yaml" teardown step 1 as written (echo included) passes ' +
        "legacy-tool's retired `oldKey` key: use newKey"
    );
    expect(readMark("frag-step")).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalledWith("legacy-tool", expect.anything());
  });
});

describe("an uploaded flow with a teardown list", () => {
  async function uploadRefusal(body: string) {
    const uploaded = await write("upload/materialized.yaml", body);
    return refusalOf("uploaded", {
      params: { flow_file: uploaded },
      ctx: {
        fileInputs: {
          flow_file: {
            clientPath: "/client/.argent/flows/uploaded.yaml",
            presentOnHost: false,
            viaUpload: true,
          },
        },
      } as Partial<ToolContext>,
    });
  }

  it.each([
    ["a script", ["  - script: { path: scripts/clean.mjs }"], "flow_upload_script_step"],
    ["a run:", ["  - run: other.yaml"], "flow_upload_run_composition"],
    [
      "a run: in a when block",
      ["  - when: { platform: ios }", "    steps:", "      - run: other.yaml"],
      "flow_upload_run_composition",
    ],
  ])("is refused before any step when its teardown list holds %s", async (_what, lines, stage) => {
    const { error, invokeTool } = await uploadRefusal(
      ["steps:", "  - echo: hi", "teardown:", ...lines, ""].join("\n")
    );

    expect(getFailureSignal(error)?.failure_stage).toBe(stage);
    expect(invokeTool).not.toHaveBeenCalled();
  });
});

describe("the walks that see the teardown list", () => {
  async function deviceTeardownFlow(): Promise<void> {
    await script("scripts/seed.mjs", marker("seed"));
    await flow(
      "device-teardown",
      "steps:",
      "  - echo: seeding",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - tap: { x: 0.5, y: 0.5 }"
    );
  }

  it("resolves the booted device for a flow whose only device step is in its teardown list", async () => {
    await deviceTeardownFlow();

    const { result, invokeTool } = await runFlow("device-teardown", {
      device: null,
      booted: true,
    });

    expect(result.device).toBe(DEVICE);
    expect(result.steps[2]).toMatchObject({ kind: "tap", status: "pass", teardown: true });
    expect(argsSentTo(invokeTool, "gesture-tap")).toEqual([{ udid: DEVICE, x: 0.5, y: 0.5 }]);
    expect(result.ok).toBe(true);
  });

  it("refuses that flow before its steps when no device is booted", async () => {
    await deviceTeardownFlow();

    const { error } = await refusalOf("device-teardown", { device: null, booted: false });

    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.FLOW_DEVICE_RESOLUTION);
    expect((error as Error).message).toContain("No booted device found.");
    expect(readMark("seed")).toBeUndefined();
  });

  it("scopes a teardown stop-all-simulator-servers step to the booted device", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    await flow(
      "scoped-teardown",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - tool: stop-all-simulator-servers"
    );

    const { result, invokeTool } = await runFlow("scoped-teardown", {
      device: null,
      booted: true,
      schemas: { "stop-all-simulator-servers": { devices: {} } },
    });

    expect(result.device).toBe(DEVICE);
    expect(argsSentTo(invokeTool, "stop-all-simulator-servers")).toEqual([{ devices: [DEVICE] }]);
    expect(result.steps[1]).toMatchObject({
      tool: "stop-all-simulator-servers",
      status: "pass",
      teardown: true,
    });
  });

  it("does not take a teardown launch for the flow's leading launch", async () => {
    await script("scripts/seed.mjs", marker("seed"));
    const file = await flow(
      "prerequisite-launch",
      "executionPrerequisite: The shop is open",
      "steps:",
      "  - script: { path: scripts/seed.mjs }",
      "teardown:",
      "  - launch: com.example.shop"
    );

    expect(() => parseFlow(fsSync.readFileSync(file, "utf8"))).not.toThrow();
    const notice = await startRun("prerequisite-launch").pending;
    expect(notice).toHaveProperty("notice");

    const { result, invokeTool } = await runFlow("prerequisite-launch", {
      params: { prerequisiteAcknowledged: true },
    });

    expect(shape(result.steps)).toEqual([
      ["script", "scripts/seed.mjs", "pass", undefined, undefined],
      ["launch", undefined, "pass", undefined, true],
    ]);
    expect(argsSentTo(invokeTool, "restart-app")).toEqual([
      { udid: DEVICE, bundleId: "com.example.shop" },
    ]);
    expect(result.ok).toBe(true);
  });
});
