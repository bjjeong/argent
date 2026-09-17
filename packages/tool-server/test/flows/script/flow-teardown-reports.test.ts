import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../../src/tools/describe/contract";

// A `when` UI guard reads the flow tree; serve it directly, as flow-when.test.ts does.
let currentTree: () => DescribeNode;
vi.mock("../../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({ tree: currentTree(), source: "native-devtools" })
  ),
}));

import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../../src/tools/flows/flow-run";
import { nestedOrchestratorOutcome } from "../../../src/tools/flows/flow-nested-outcome";
import { label, screen } from "../harness";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 60_000 });

scopeTempHome("argent-flow-teardown-reports-home-");

const DEVICE = "00000000-0000-0000-0000-0000000000ad";

/** Tools that throw when a step calls them. `restart-app` makes a `launch` step error. */
const THROWING_TOOLS = new Set(["broken", "also-broken", "restart-app"]);

let root: string;

interface RunOptions {
  /** What a `tool: flow-execute` step gets back. */
  nested?: unknown;
  signal?: AbortSignal;
  onInvoke?: (id: string) => void;
}

function mockRegistry(opts: RunOptions) {
  const invokeTool = vi.fn(async (id: string, _args?: unknown) => {
    if (id === "list-devices") return { devices: [] };
    opts.onInvoke?.(id);
    if (THROWING_TOOLS.has(id)) throw new Error(`${id} blew up`);
    if (id === "flow-execute" && opts.nested !== undefined) return opts.nested;
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

type InvokeMock = ReturnType<typeof mockRegistry>["invokeTool"];

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function runFlow(
  name: string,
  opts: RunOptions = {}
): Promise<{ result: FlowRunResult; invokeTool: InvokeMock }> {
  const { registry, invokeTool } = mockRegistry(opts);
  const result = asRun(
    await createRunFlowTool(registry).execute(
      {},
      { name, project_root: root, device: DEVICE } as never,
      (opts.signal ? { signal: opts.signal } : undefined) as never
    )
  );
  return { result, invokeTool };
}

async function write(relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

function flow(name: string, ...lines: string[]): Promise<void> {
  return write(path.join(".argent", "flows", `${name}.yaml`), `${lines.join("\n")}\n`);
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

function readMark(mark: string): string | undefined {
  try {
    return fsSync.readFileSync(markPath(mark), "utf8");
  } catch {
    return undefined;
  }
}

/** A script that records the named environment values in `<mark>.mark`, which proves it started. */
async function reporterScript(file: string, mark: string, names: readonly string[]): Promise<void> {
  await write(
    path.join("scripts", file),
    `import fs from "node:fs";\n` +
      `const seen = {};\n` +
      `for (const name of ${JSON.stringify(names)}) seen[name] = process.env[name] ?? null;\n` +
      `fs.writeFileSync(${JSON.stringify(markPath(mark))}, JSON.stringify(seen));\n`
  );
}

/** The report fields this file asserts on; the rest (index, result, args) are not its subject. */
function view(report: StepReport): Partial<StepReport> {
  const { kind, status, reason, warning, tool, target, message, flow, depth, teardown } = report;
  return { kind, status, reason, warning, tool, target, message, flow, depth, teardown };
}

function warned(result: FlowRunResult): StepReport[] {
  return result.steps.filter((step) => step.warning !== undefined);
}

function toolsCalled(invokeTool: InvokeMock): string[] {
  return invokeTool.mock.calls.map((call) => call[0]);
}

const stoppedAt = (name: string): string => `did not start: the teardown list stopped at ${name}`;

const MISS = "{{output:order.id}} did not resolve: `output` has no `order` (it has no keys)";

const TAP_TEXT = "`tap.text` (spelled `tap.on.text` if the target sits under `on:`)";

/** A teardown script whose env reads `order.id` with no fallback. */
const ENV_MISS_SCRIPT = [
  "  - script:",
  "      path: ../../scripts/delete.mjs",
  '      env: { ORDER_ID: "{{output:order.id}}" }',
];

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-reports-")));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  currentTree = () => screen([label("Home")]);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("the did-not-start warning of a stopped teardown list", () => {
  it("warns on the first skipped step, gives each skipped step the reason, and names the stopper from its step", async () => {
    await reporterScript("delete.mjs", "delete", []);
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - launch: com.example.app",
      "  - tool: clear-cache",
      "  - script: { path: ../../scripts/delete.mjs }"
    );

    const { result, invokeTool } = await runFlow("root");

    const stop = stoppedAt("launch com.example.app");
    expect(result.steps.map(view)).toEqual([
      { kind: "echo", status: "pass", flow: "root", message: "seeding" },
      {
        kind: "launch",
        status: "error",
        flow: "root",
        teardown: true,
        reason: expect.stringContaining("restart-app failed"),
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "clear-cache",
        reason: stop,
        warning:
          "this and 1 more teardown step did not start because the teardown list stopped at " +
          "launch com.example.app: tool clear-cache, script ../../scripts/delete.mjs. " +
          "What they clean up can remain",
      },
      {
        kind: "script",
        status: "skip",
        flow: "root",
        teardown: true,
        target: "../../scripts/delete.mjs",
        reason: stop,
      },
    ]);
    expect(warned(result)).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(toolsCalled(invokeTool)).not.toContain("clear-cache");
    expect(readMark("delete")).toBeUndefined();
  });

  it("gives no warning in the outer list when its last step (a run:) fails, and warns inside the fragment's own list", async () => {
    await reporterScript("delete.mjs", "delete", []);
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - tool: clear-cache",
      "  - run: frag.yaml"
    );
    await flow(
      "frag",
      "steps:",
      "  - tool: broken",
      "  - script: { path: ../../scripts/delete.mjs }",
      "  - wait: 250"
    );

    const { result } = await runFlow("root");

    const stop = stoppedAt("tool broken [frag]");
    expect(result.steps.map(view)).toEqual([
      { kind: "echo", status: "pass", flow: "root", message: "seeding" },
      { kind: "tool", status: "pass", flow: "root", teardown: true, tool: "clear-cache" },
      { kind: "run", status: "pass", flow: "frag", target: "frag.yaml", teardown: true },
      {
        kind: "tool",
        status: "error",
        flow: "frag",
        depth: 1,
        teardown: true,
        tool: "broken",
        reason: "broken blew up",
      },
      {
        kind: "script",
        status: "skip",
        flow: "frag",
        depth: 1,
        teardown: true,
        target: "../../scripts/delete.mjs",
        reason: stop,
        warning:
          "this and 1 more teardown step did not start because the teardown list stopped at " +
          "tool broken [frag]: script ../../scripts/delete.mjs [frag], wait 250ms [frag]. " +
          "What they clean up can remain",
      },
      {
        kind: "wait",
        status: "skip",
        flow: "frag",
        depth: 1,
        teardown: true,
        reason: stop,
      },
    ]);
    expect(warned(result)).toHaveLength(1);
    expect(readMark("delete")).toBeUndefined();
  });

  it("stops the list at a when guard that errors, naming the when step for the next step", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      '  - when: { visible: { text: "{{output:order.id}}" } }',
      "    steps:",
      "      - tap: { text: Delete }",
      "  - tool: clear-cache"
    );

    const { result, invokeTool } = await runFlow("root");

    const whenName = `when visible "{{output:order.id}}"`;
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "when:error",
      "tap:skip",
      "tool:skip",
    ]);
    expect(result.steps[1]!.reason).toMatch(/^could not resolve when guard/);
    // The block of a guard that errored keeps its own reason.
    expect(result.steps[2]).toMatchObject({ reason: "when guard errored", teardown: true });
    expect(result.steps[2]!.warning).toBeUndefined();
    expect(view(result.steps[3]!)).toEqual({
      kind: "tool",
      status: "skip",
      flow: "root",
      teardown: true,
      tool: "clear-cache",
      reason: stoppedAt(whenName),
      warning:
        `this teardown step did not start because the teardown list stopped at ${whenName}. ` +
        "What it cleans up can remain",
    });
    expect(warned(result)).toHaveLength(1);
    expect(toolsCalled(invokeTool)).not.toContain("clear-cache");
  });

  it("stops the list at a run: whose file cannot be loaded, naming the run: step for the next step", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - run: missing.yaml",
      "  - tool: clear-cache"
    );

    const { result, invokeTool } = await runFlow("root");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "run:error",
      "tool:skip",
    ]);
    expect(result.steps[1]!.reason).toMatch(/^could not load fragment "missing\.yaml": /);
    expect(view(result.steps[2]!)).toEqual({
      kind: "tool",
      status: "skip",
      flow: "root",
      teardown: true,
      tool: "clear-cache",
      reason: stoppedAt("run missing.yaml [missing]"),
      warning:
        "this teardown step did not start because the teardown list stopped at " +
        "run missing.yaml [missing]. What it cleans up can remain",
    });
    expect(warned(result)).toHaveLength(1);
    expect(toolsCalled(invokeTool)).not.toContain("clear-cache");
  });

  it("does not stop the list at a when block whose platform does not match, and gives it no teardown reason", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - when: { platform: android }",
      "    steps:",
      "      - tool: android-cleanup",
      "  - tool: clear-cache"
    );

    const { result, invokeTool } = await runFlow("root");

    expect(result.steps.map(view)).toEqual([
      { kind: "echo", status: "pass", flow: "root", message: "seeding" },
      {
        kind: "when",
        status: "skip",
        flow: "root",
        teardown: true,
        target: "platform android",
        reason: "condition not met (platform android) — block skipped (1 step)",
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        depth: 1,
        teardown: true,
        tool: "android-cleanup",
        reason: "when block skipped",
      },
      { kind: "tool", status: "pass", flow: "root", teardown: true, tool: "clear-cache" },
    ]);
    expect(warned(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(toolsCalled(invokeTool)).toContain("clear-cache");
  });

  it("gives the block steps of a when step skipped by the stop the teardown reason, with a tool block step's tool", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - tool: broken",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: ios-cleanup",
      "      - echo: ios cleanup done",
      "  - tool: clear-cache"
    );

    const { result, invokeTool } = await runFlow("root");

    const stop = stoppedAt("tool broken");
    expect(result.steps.slice(1).map(view)).toEqual([
      {
        kind: "tool",
        status: "error",
        flow: "root",
        teardown: true,
        tool: "broken",
        reason: "broken blew up",
      },
      {
        kind: "when",
        status: "skip",
        flow: "root",
        teardown: true,
        target: "platform ios",
        reason: stop,
        warning:
          "this and 1 more teardown step did not start because the teardown list stopped at " +
          "tool broken: when platform ios, tool clear-cache. What they clean up can remain",
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        depth: 1,
        teardown: true,
        tool: "ios-cleanup",
        reason: stop,
      },
      {
        kind: "echo",
        status: "skip",
        flow: "root",
        depth: 1,
        teardown: true,
        message: "ios cleanup done",
        reason: stop,
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "clear-cache",
        reason: stop,
      },
    ]);
    expect(warned(result)).toHaveLength(1);
    expect(toolsCalled(invokeTool)).not.toContain("ios-cleanup");
  });

  it("moves the warning past a skipped echo to the next step, and neither counts nor lists echoes", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - tool: broken",
      "  - echo: about to clean",
      "  - tool: clear-cache",
      "  - echo: cache cleared",
      "  - tool: drop-user"
    );

    const { result } = await runFlow("root");

    const stop = stoppedAt("tool broken");
    expect(result.steps.slice(2).map(view)).toEqual([
      {
        kind: "echo",
        status: "skip",
        flow: "root",
        teardown: true,
        message: "about to clean",
        reason: stop,
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "clear-cache",
        reason: stop,
        warning:
          "this and 1 more teardown step did not start because the teardown list stopped at " +
          "tool broken: tool clear-cache, tool drop-user. What they clean up can remain",
      },
      {
        kind: "echo",
        status: "skip",
        flow: "root",
        teardown: true,
        message: "cache cleared",
        reason: stop,
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "drop-user",
        reason: stop,
      },
    ]);
    expect(warned(result)).toHaveLength(1);
  });

  it("gives no warning when only echo steps remain after the failure", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - tool: broken",
      "  - echo: one",
      "  - echo: two"
    );

    const { result } = await runFlow("root");

    const stop = stoppedAt("tool broken");
    expect(result.steps.slice(2).map(view)).toEqual([
      { kind: "echo", status: "skip", flow: "root", teardown: true, message: "one", reason: stop },
      { kind: "echo", status: "skip", flow: "root", teardown: true, message: "two", reason: stop },
    ]);
    expect(warned(result)).toEqual([]);
  });

  it("names the run: step, not the fragment's failed teardown step, for the outer list", async () => {
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      "  - run: frag.yaml",
      "  - tool: clear-cache"
    );
    await flow(
      "frag",
      "steps:",
      "  - tool: broken",
      "teardown:",
      "  - tool: also-broken",
      "  - tool: frag-cleanup"
    );

    const { result } = await runFlow("root");

    expect(result.steps.map(view)).toEqual([
      { kind: "echo", status: "pass", flow: "root", message: "seeding" },
      { kind: "run", status: "pass", flow: "frag", target: "frag.yaml", teardown: true },
      {
        kind: "tool",
        status: "error",
        flow: "frag",
        depth: 1,
        teardown: true,
        tool: "broken",
        reason: "broken blew up",
      },
      {
        kind: "tool",
        status: "error",
        flow: "frag",
        depth: 1,
        teardown: true,
        tool: "also-broken",
        reason: "also-broken blew up",
      },
      {
        kind: "tool",
        status: "skip",
        flow: "frag",
        depth: 1,
        teardown: true,
        tool: "frag-cleanup",
        reason: stoppedAt("tool also-broken [frag]"),
        warning:
          "this teardown step did not start because the teardown list stopped at " +
          "tool also-broken [frag]. What it cleans up can remain",
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "clear-cache",
        reason: stoppedAt("run frag.yaml [frag]"),
        warning:
          "this teardown step did not start because the teardown list stopped at " +
          "run frag.yaml [frag]. What it cleans up can remain",
      },
    ]);
    // One per stopped list: the fragment's teardown list and the outer one.
    expect(warned(result)).toHaveLength(2);
  });

  it("names skipped steps by kind and target, escapes a multi-line echo, and leaves a script's env out", async () => {
    await reporterScript("delete.mjs", "delete", ["ORDER_TOKEN"]);
    await flow(
      "root",
      "steps:",
      "  - echo: seeding",
      "teardown:",
      '  - echo: "cleanup starts\\n{{output:order.id}}"',
      "  - tool: clear-cache",
      "  - launch: com.example.app",
      "  - await: { idle: true }",
      "  - wait: 500",
      "  - echo: never printed",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      "      env: { ORDER_TOKEN: tok-8472-private }",
      "  - run: frag.yaml"
    );

    const { result } = await runFlow("root");

    const stopper = "echo cleanup starts\\n{{output:order.id}}";
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "error", teardown: true });
    const [warning] = warned(result);
    expect(warning).toMatchObject({ kind: "tool", tool: "clear-cache" });
    expect(warning!.warning).toBe(
      `this and 5 more teardown steps did not start because the teardown list stopped at ${stopper}: ` +
        "tool clear-cache, launch com.example.app, await screen idle, wait 500ms, " +
        "script ../../scripts/delete.mjs, run frag.yaml [frag]. What they clean up can remain"
    );
    expect(warning!.warning).not.toContain("\n");
    expect(warned(result)).toHaveLength(1);
    const skipped = result.steps.slice(2);
    expect(skipped.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tool:skip",
      "launch:skip",
      "idle:skip",
      "wait:skip",
      "echo:skip",
      "script:skip",
      "run:skip",
    ]);
    for (const step of skipped) {
      expect(step.reason).toBe(stoppedAt(stopper));
    }
    expect(JSON.stringify(result.steps)).not.toContain("tok-8472-private");
    expect(readMark("delete")).toBeUndefined();
  });

  it("cuts a long list of skipped steps after ten names", async () => {
    const cleanups = Array.from({ length: 12 }, (_, i) => `  - tool: cleanup-${i + 1}`);
    await flow("root", "steps: []", "teardown:", "  - tool: broken", ...cleanups);

    const { result } = await runFlow("root");

    const listed = Array.from({ length: 10 }, (_, i) => `tool cleanup-${i + 1}`).join(", ");
    expect(warned(result).map(view)).toEqual([
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "cleanup-1",
        reason: stoppedAt("tool broken"),
        warning:
          "this and 11 more teardown steps did not start because the teardown list stopped at " +
          `tool broken: ${listed}, and 2 more. What they clean up can remain`,
      },
    ]);
  });

  it("reports a skipped tool step in steps with its tool, and with no reason or warning", async () => {
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "  - tool: clear-cache",
      "  - when: { platform: ios }",
      "    steps:",
      "      - tool: ios-cleanup"
    );

    const { result } = await runFlow("root");

    expect(result.steps.slice(1).map(view)).toEqual([
      { kind: "tool", status: "skip", flow: "root", tool: "clear-cache" },
      { kind: "when", status: "skip", flow: "root", target: "platform ios" },
      { kind: "tool", status: "skip", flow: "root", depth: 1, tool: "ios-cleanup" },
    ]);
  });

  it("gives a cancelled run's teardown steps only 'run aborted', with no warning", async () => {
    const controller = new AbortController();
    await flow(
      "root",
      "steps:",
      "  - tool: cancel-here",
      "teardown:",
      "  - tool: clear-cache",
      "  - tool: drop-user",
      "  - echo: done"
    );

    const { result, invokeTool } = await runFlow("root", {
      signal: controller.signal,
      onInvoke: (id) => {
        if (id === "cancel-here") controller.abort();
      },
    });

    expect(result.steps.slice(1).map(view)).toEqual([
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "clear-cache",
        reason: "run aborted",
      },
      {
        kind: "tool",
        status: "skip",
        flow: "root",
        teardown: true,
        tool: "drop-user",
        reason: "run aborted",
      },
      {
        kind: "echo",
        status: "skip",
        flow: "root",
        teardown: true,
        message: "done",
        reason: "run aborted",
      },
    ]);
    expect(warned(result)).toEqual([]);
    expect(result.ok).toBe(false);
    expect(toolsCalled(invokeTool)).not.toContain("clear-cache");
  });
});

describe("the missing-output hint on a teardown step", () => {
  const FALLBACK_HINT =
    "If this teardown step must run without the value, add a `??` fallback, " +
    "and make sure that the step can use an empty value";
  const DEVICE_STEP_HINT =
    "A fallback cannot make this step optional, because the step refuses an empty value. " +
    "Put the step in a `when` block whose guard ends the reference with a fallback that no " +
    "screen shows (`?? '__none__'`), or do this cleanup in a script";
  const GUARD_HINT =
    "To skip this block when the value is missing, end the reference with a fallback that no " +
    "screen shows, such as `?? '__none__'`: the guard is then not met, and the teardown list continues";
  const NOT_PASSED = "A step before this step did not pass";

  const causeOf = (step: string): string =>
    `. A step before this step did not pass (${step}), so it is possible that no step wrote the value. `;

  it("appends the hint naming the first step that did not pass to a script env miss", async () => {
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "teardown:",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      '      env: { ORDER_ID: "{{output:order.id}}" }'
    );

    const { result } = await runFlow("root");

    expect(view(result.steps[1]!)).toEqual({
      kind: "script",
      status: "error",
      flow: "root",
      teardown: true,
      target: "../../scripts/delete.mjs",
      reason:
        `\`script.env.ORDER_ID\`: ${MISS}` +
        ". A step before this step did not pass (tool broken: error), so it is possible that no " +
        "step wrote the value. If this teardown step must run without the value, add a `??` " +
        "fallback, and make sure that the step can use an empty value",
    });
    expect(readMark("delete")).toBeUndefined();
  });

  it("appends the hint after passing steps when the writer sat in a skipped when block in steps", async () => {
    await reporterScript("seed.mjs", "seed", []);
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow(
      "root",
      "steps:",
      "  - when: { platform: android }",
      "    steps:",
      "      - script: { path: ../../scripts/seed.mjs }",
      "  - echo: seeded",
      "teardown:",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      '      env: { ORDER_ID: "{{output:order.id}}" }'
    );

    const { result } = await runFlow("root");

    const failed = result.steps.find((s) => s.kind === "script" && s.status === "error");
    expect(failed?.reason).toBe(
      `\`script.env.ORDER_ID\`: ${MISS}${causeOf("when platform android: skip")}${FALLBACK_HINT}`
    );
    expect(readMark("seed")).toBeUndefined();
    expect(readMark("delete")).toBeUndefined();
  });

  it("appends the hint after a when block skipped earlier in the same teardown list", async () => {
    await reporterScript("seed.mjs", "seed", []);
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow(
      "root",
      "steps:",
      "  - echo: seeded",
      "teardown:",
      "  - when: { platform: android }",
      "    steps:",
      "      - script: { path: ../../scripts/seed.mjs }",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      '      env: { ORDER_ID: "{{output:order.id}}" }'
    );

    const { result } = await runFlow("root");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "when:skip",
      "script:skip",
      "script:error",
    ]);
    expect(result.steps[3]!.reason).toBe(
      `\`script.env.ORDER_ID\`: ${MISS}${causeOf("when platform android: skip")}${FALLBACK_HINT}`
    );
  });

  it("gives a plain miss reason when every earlier step passed", async () => {
    await write("scripts/seed.mjs", `output.other = "kept";\n`);
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow(
      "root",
      "steps:",
      "  - script: { path: ../../scripts/seed.mjs }",
      "  - echo: seeded",
      "teardown:",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      '      env: { ORDER_ID: "{{output:order.id}}" }'
    );

    const { result } = await runFlow("root");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "script:pass",
      "echo:pass",
      "script:error",
    ]);
    expect(result.steps[2]!.reason).toBe(
      "`script.env.ORDER_ID`: {{output:order.id}} did not resolve: `output` has no `order` (its keys: other)"
    );
  });

  it.each([
    {
      title: "a literal ?? null in a tap text",
      text: "{{output:order.id ?? null}}",
      reason:
        `${TAP_TEXT}: {{output:order.id ?? null}} gave null, and this field needs text; end ` +
        "the `??` chain with a text literal, such as 'none'",
    },
    {
      title: "a tap text that resolves to an empty value",
      text: "{{output:order.id ?? ''}}",
      reason:
        `${TAP_TEXT}: "{{output:order.id ?? ''}}" resolved to "", and selector text must ` +
        "contain at least one visible character (icon-font/private-use and zero-width characters " +
        "render as nothing) — use a fallback literal that names what is on screen",
    },
  ])("gives no hint to $title after a failed step", async ({ text, reason }) => {
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "teardown:",
      `  - tap: { text: "${text}" }`,
      "  - tool: clear-cache"
    );

    const { result } = await runFlow("root");

    expect(view(result.steps[1]!)).toEqual({
      kind: "tap",
      status: "error",
      flow: "root",
      teardown: true,
      target: expect.any(String),
      reason,
    });
    expect(result.steps[1]!.reason).not.toContain(NOT_PASSED);
  });

  it("gives a when guard miss the guard hint, not the device-step hint", async () => {
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "teardown:",
      '  - when: { visible: { text: "{{output:order.id}}" } }',
      "    steps:",
      "      - tap: { text: Delete }",
      "  - tool: clear-cache"
    );

    const { result } = await runFlow("root");

    expect(result.steps[1]).toMatchObject({ kind: "when", status: "error", teardown: true });
    const reason = result.steps[1]!.reason!;
    expect(reason).toMatch(/^could not resolve when guard \(.*\): /);
    expect(reason.endsWith(`${MISS}${causeOf("tool broken: error")}${GUARD_HINT}`)).toBe(true);
    expect(reason).not.toContain(DEVICE_STEP_HINT);
    expect(reason).not.toContain("add a `??` fallback");
  });

  it.each([
    {
      where: "a tap selector text",
      lines: ['  - tap: { text: "{{output:order.id}}" }'],
      field: TAP_TEXT,
      hint: DEVICE_STEP_HINT,
    },
    {
      where: "a script env value",
      lines: [
        "  - script:",
        "      path: ../../scripts/delete.mjs",
        '      env: { ORDER_ID: "{{output:order.id}}" }',
      ],
      field: "`script.env.ORDER_ID`",
      hint: FALLBACK_HINT,
    },
  ])("gives a miss in $where the hint for that place", async ({ lines, field, hint }) => {
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow("root", "steps:", "  - tool: broken", "teardown:", ...lines);

    const { result } = await runFlow("root");

    expect(result.steps[1]).toMatchObject({ status: "error", teardown: true });
    expect(result.steps[1]!.reason).toBe(
      `${field}: ${MISS}${causeOf("tool broken: error")}${hint}`
    );
  });

  it("runs a teardown script whose env reference falls back to an empty string", async () => {
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "teardown:",
      "  - script:",
      "      path: ../../scripts/delete.mjs",
      `      env: { ORDER_ID: "{{output:order.id ?? ''}}" }`
    );

    const { result } = await runFlow("root");

    expect(result.steps[1]).toMatchObject({ kind: "script", status: "pass", teardown: true });
    expect(JSON.parse(readMark("delete") ?? "null")).toEqual({ ORDER_ID: "" });
    expect(result.ok).toBe(false);
  });

  it("skips a teardown when block whose guard falls back to a value no screen shows, and runs the next step", async () => {
    currentTree = () => screen([label("Home")]);
    await flow(
      "root",
      "steps:",
      "  - tool: broken",
      "teardown:",
      `  - when: { visible: { text: "{{output:order.id ?? '__none__'}}" } }`,
      "    steps:",
      "      - tap: { text: Delete }",
      "  - tool: clear-cache"
    );

    const { result, invokeTool } = await runFlow("root");

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "tool:error",
      "when:skip",
      "tap:skip",
      "tool:pass",
    ]);
    expect(result.steps[1]!.reason).toMatch(/^condition not met /);
    expect(result.steps[2]!.reason).toBe("when block skipped");
    expect(result.steps[3]).toMatchObject({ tool: "clear-cache", teardown: true });
    expect(warned(result)).toEqual([]);
    expect(toolsCalled(invokeTool)).toContain("clear-cache");
    expect(toolsCalled(invokeTool)).not.toContain("gesture-tap");
  });

  it("names a step of a fragment in the hint with the fragment", async () => {
    await reporterScript("delete.mjs", "delete", ["ORDER_ID"]);
    await flow("root", "steps:", "  - run: seed.yaml", "teardown:", ...ENV_MISS_SCRIPT);
    await flow("seed", "steps:", "  - tool: broken");

    const { result } = await runFlow("root");

    const failed = result.steps.find((s) => s.kind === "script");
    expect(failed).toMatchObject({ status: "error", teardown: true, flow: "root" });
    expect(failed!.reason).toBe(
      `\`script.env.ORDER_ID\`: ${MISS}${causeOf("tool broken [seed]: error")}${FALLBACK_HINT}`
    );
  });

  it("gives no hint to a miss in steps, after a skipped when block", async () => {
    await reporterScript("seed.mjs", "seed", []);
    await flow(
      "root",
      "steps:",
      "  - when: { platform: android }",
      "    steps:",
      "      - script: { path: ../../scripts/seed.mjs }",
      '  - echo: "order {{output:order.id}}"'
    );

    const { result } = await runFlow("root");

    expect(view(result.steps[2]!)).toEqual({
      kind: "echo",
      status: "error",
      flow: "root",
      message: "order {{output:order.id}}",
      reason: `\`echo\`: ${MISS}`,
    });
  });
});

/** A child run report, as `flow-execute` returns it. */
function childRun(steps: Array<Record<string, unknown>>): Record<string, unknown> {
  const count = (status: string) => steps.filter((s) => s.status === status).length;
  return {
    flow: "child",
    device: DEVICE,
    executionPrerequisite: "",
    ok: false,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skip"),
    errored: count("error"),
    steps,
  };
}

const CHILD_SHAPES = [
  {
    title: "a failure only in a teardown step",
    steps: [
      { index: 0, kind: "tool", tool: "seed-order", status: "pass" },
      {
        index: 1,
        kind: "script",
        status: "error",
        target: "scripts/delete.sh",
        reason: "script exited with code 3",
        teardown: true,
      },
    ],
    reason:
      'flow "child" failed: 1 passed, 0 failed, 1 errored ' +
      "(teardown step script: script exited with code 3)",
  },
  {
    title: "a step failure, then a teardown failure",
    steps: [
      { index: 0, kind: "tap", status: "fail", target: '"Checkout"', reason: "no match" },
      { index: 1, kind: "echo", status: "skip", message: "after" },
      {
        index: 2,
        kind: "tool",
        tool: "clear-cache",
        status: "error",
        reason: "cache locked",
        teardown: true,
      },
    ],
    reason:
      'flow "child" failed: 0 passed, 1 failed, 1 errored ' +
      "(tap: no match; then teardown step clear-cache: cache locked)",
  },
  {
    title: "two step failures and no teardown failure",
    steps: [
      { index: 0, kind: "tap", status: "fail", reason: "first failure" },
      { index: 1, kind: "tool", tool: "clear-cache", status: "error", reason: "second failure" },
      { index: 2, kind: "echo", status: "pass", message: "done", teardown: true },
    ],
    reason: 'flow "child" failed: 1 passed, 1 failed, 1 errored (tap: first failure)',
  },
];

describe("a nested flow-execute child whose teardown failed", () => {
  it.each(CHILD_SHAPES)(
    "names the child's failed steps in the parent step reason: $title",
    async ({ steps, reason }) => {
      await flow(
        "root",
        "steps:",
        "  - tool: flow-execute",
        "    args: { name: child }",
        "  - tool: clear-cache"
      );

      const { result } = await runFlow("root", { nested: childRun(steps) });

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:fail", "tool:skip"]);
      expect(result.steps[0]).toMatchObject({ tool: "flow-execute", reason });
    }
  );

  it.each(CHILD_SHAPES)(
    "nestedOrchestratorOutcome names the child's failed steps: $title",
    ({ steps, reason }) => {
      expect(nestedOrchestratorOutcome("flow-execute", childRun(steps))).toEqual({
        status: "fail",
        reason,
      });
    }
  );
});
