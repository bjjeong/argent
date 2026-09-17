import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import {
  createRunFlowTool,
  type FlowPrerequisiteNotice,
  type FlowRunResult,
} from "../../../src/tools/flows/flow-run";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 30_000 });

scopeTempHome("argent-flow-teardown-secrets-home-");

const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ad";
const ANDROID_DEVICE = "emulator-5554";

/** The project the flows run in (`project_root`). */
let root: string;
/** A second project: a nested run's `project_root`, or the tool server's working directory. */
let other: string;

function mockRegistry() {
  const invokeTool = vi.fn(async (id: string, _args?: unknown) => {
    if (id === "list-devices") {
      return { devices: [{ platform: "ios", udid: IOS_DEVICE, state: "Booted" }] };
    }
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

type InvokeMock = ReturnType<typeof mockRegistry>["invokeTool"];

async function write(dir: string, relative: string, contents: string): Promise<void> {
  const file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

function flow(name: string, ...lines: string[]): Promise<void> {
  return write(root, path.join(".argent", "flows", `${name}.yaml`), `${lines.join("\n")}\n`);
}

function secrets(dir: string, ...lines: string[]): Promise<void> {
  return write(dir, path.join(".argent", "secrets.env"), `${lines.join("\n")}\n`);
}

const MARKS = "marks";

function markPath(mark: string): string {
  return path.join(root, MARKS, `${mark}.json`);
}

/**
 * A script beside the flows (`scripts/<name>.mjs` as a flow spells it) that
 * records it started, and the TOKEN it was given, in a marker file.
 */
async function markerScript(name: string, before = ""): Promise<void> {
  await write(
    root,
    path.join(".argent", "flows", "scripts", `${name}.mjs`),
    `import fs from "node:fs";\n` +
      before +
      `fs.mkdirSync(${JSON.stringify(path.dirname(markPath(name)))}, { recursive: true });\n` +
      `fs.writeFileSync(${JSON.stringify(markPath(name))}, ` +
      `JSON.stringify({ TOKEN: process.env.TOKEN ?? null }));\n`
  );
}

/** The scripts that started, by name. */
function started(): string[] {
  try {
    return fsSync
      .readdirSync(path.join(root, MARKS))
      .map((file) => path.basename(file, ".json"))
      .sort();
  } catch {
    return [];
  }
}

function tokenSeenBy(mark: string): string | null | undefined {
  try {
    return (JSON.parse(fsSync.readFileSync(markPath(mark), "utf8")) as { TOKEN: string | null })
      .TOKEN;
  } catch {
    return undefined;
  }
}

function toolCalls(invokeTool: InvokeMock): Array<{ tool: string; args: unknown }> {
  return invokeTool.mock.calls
    .filter(([id]) => id !== "list-devices")
    .map(([tool, args]) => ({ tool, args }));
}

function shape(result: FlowRunResult): string[] {
  return result.steps.map((s) => `${s.kind}:${s.status}${s.teardown ? " (teardown)" : ""}`);
}

async function execute(
  name: string,
  params: Record<string, unknown> = {}
): Promise<{
  outcome: { result: FlowRunResult | FlowPrerequisiteNotice } | { error: unknown };
  invokeTool: InvokeMock;
}> {
  const { registry, invokeTool } = mockRegistry();
  const outcome = await createRunFlowTool(registry)
    .execute({}, { project_root: root, name, ...params } as never)
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
  return { outcome, invokeTool };
}

async function run(
  name: string,
  params: Record<string, unknown> = {}
): Promise<{ result: FlowRunResult; invokeTool: InvokeMock }> {
  const { outcome, invokeTool } = await execute(name, params);
  if ("error" in outcome) throw outcome.error;
  const { result } = outcome;
  if (!("steps" in result)) throw new Error(`expected a run result, got notice: ${result.notice}`);
  return { result, invokeTool };
}

/**
 * The run is refused before anything happens: no device lookup, no device
 * call, no script. `at` is the position the refusal names, and `detail` is
 * what the resolver said about it.
 */
async function expectRefused(
  name: string,
  at: string,
  detail: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const { outcome, invokeTool } = await execute(name, params);
  if (!("error" in outcome)) {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome.result)}`);
  }
  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
  expect(message.startsWith(`Flow "${name}" was not run: `)).toBe(true);
  expect(message).toContain(` and ${at}: ${detail}`);
  expect(getFailureSignal(outcome.error)).toMatchObject({
    error_code: FAILURE_CODES.SECRET_PLACEHOLDER_UNKNOWN,
    failure_stage: "flow_run_teardown_secrets",
  });
  expect(invokeTool).not.toHaveBeenCalled();
  expect(started()).toEqual([]);
}

/** Steps that leave a trace: a script marker, then a device call. */
const STEPS = [
  "steps:",
  "  - script: { path: scripts/setup.mjs }",
  "  - tool: button",
  "    args: { button: home }",
];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-secrets-"));
  other = await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-secrets-other-"));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  await fs.mkdir(path.join(other, ".argent"), { recursive: true });
  for (const name of ["setup", "cleanup", "after", "frag-step", "frag-cleanup"]) {
    await markerScript(name);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(other, { recursive: true, force: true });
});

describe("a teardown script's environment", () => {
  it("refuses the run on an unknown name in a root teardown script's env", async () => {
    await secrets(root, "KNOWN=value");
    await flow(
      "cleanup-env",
      ...STEPS,
      "teardown:",
      '  - script: { path: scripts/cleanup.mjs, env: { TOKEN: "{{secret:MISSING}}" } }'
    );

    await expectRefused(
      "cleanup-env",
      "teardown step 1 (script scripts/cleanup.mjs)",
      'env value TOKEN: Unknown secret "MISSING"'
    );
  });

  it("names the teardown step by its position in the list", async () => {
    await flow(
      "second",
      ...STEPS,
      "teardown:",
      "  - echo: cleaning up",
      "  - script: { path: scripts/after.mjs }",
      '  - script: { path: scripts/cleanup.mjs, env: { TOKEN: "{{secret:MISSING}}" } }'
    );

    await expectRefused(
      "second",
      "teardown step 3 (script scripts/cleanup.mjs)",
      'env value TOKEN: Unknown secret "MISSING"'
    );
  });

  it("refuses before the prerequisite notice when the prerequisite is not acknowledged", async () => {
    await flow(
      "with-prerequisite",
      ...STEPS,
      "executionPrerequisite: The app shows its home screen",
      "teardown:",
      '  - script: { path: scripts/cleanup.mjs, env: { TOKEN: "{{secret:MISSING}}" } }'
    );

    await expectRefused(
      "with-prerequisite",
      "teardown step 1 (script scripts/cleanup.mjs)",
      'env value TOKEN: Unknown secret "MISSING"'
    );
  });

  it("refuses the run on a flow-level env placeholder that a teardown script inherits", async () => {
    await flow(
      "flow-env",
      'env: { TOKEN: "{{secret:MISSING}}" }',
      "steps:",
      "  - script: { path: scripts/setup.mjs, env: { TOKEN: setup-value } }",
      "  - tool: button",
      "    args: { button: home }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    await expectRefused(
      "flow-env",
      "teardown step 1 (script scripts/cleanup.mjs)",
      'env value TOKEN: Unknown secret "MISSING"'
    );
  });

  it("runs when the teardown step's own env replaces the flow-level placeholder", async () => {
    await flow(
      "step-replaces",
      'env: { TOKEN: "{{secret:MISSING}}" }',
      "steps:",
      "  - script: { path: scripts/setup.mjs, env: { TOKEN: setup-value } }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs, env: { TOKEN: from-step } }"
    );

    const { result } = await run("step-replaces");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "script:pass (teardown)"]);
    expect(tokenSeenBy("cleanup")).toBe("from-step");
  });

  it("runs when the run's env replaces the flow-level placeholder", async () => {
    await flow(
      "run-replaces",
      'env: { TOKEN: "{{secret:MISSING}}" }',
      "steps:",
      "  - script: { path: scripts/setup.mjs }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { result } = await run("run-replaces", { env: { TOKEN: "from-run" } });

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "script:pass (teardown)"]);
    expect(tokenSeenBy("setup")).toBe("from-run");
    expect(tokenSeenBy("cleanup")).toBe("from-run");
  });

  it("does not refuse a flow-level env placeholder when no teardown step is a script", async () => {
    await flow(
      "no-teardown-script",
      'env: { TOKEN: "{{secret:MISSING}}" }',
      "steps:",
      "  - tool: button",
      "    args: { button: home }",
      "teardown:",
      "  - echo: cleaning up",
      "  - tool: button",
      "    args: { button: home }"
    );

    const { result, invokeTool } = await run("no-teardown-script");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["tool:pass", "echo:pass (teardown)", "tool:pass (teardown)"]);
    expect(toolCalls(invokeTool).map((c) => c.tool)).toEqual(["button", "button"]);
  });

  it("resolves a known secret at run time and gives the script its value", async () => {
    await secrets(root, "CLEANUP_TOKEN=tok-5e1f");
    // The setup script rotates the secret after the check read it: the teardown
    // script must get the value on disk when it starts, not the checked one.
    await markerScript(
      "setup",
      `fs.writeFileSync(${JSON.stringify(path.join(root, ".argent", "secrets.env"))}, ` +
        `"CLEANUP_TOKEN=tok-rotated\\n");\n`
    );
    await flow(
      "known",
      "steps:",
      "  - script: { path: scripts/setup.mjs }",
      "teardown:",
      '  - script: { path: scripts/cleanup.mjs, env: { TOKEN: "{{secret:CLEANUP_TOKEN}}" } }'
    );

    const { result } = await run("known");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "script:pass (teardown)"]);
    expect(tokenSeenBy("cleanup")).toBe("tok-rotated");
  });
});

describe("text a teardown types", () => {
  it("refuses the run on an unknown name in a type step at the top of the teardown list", async () => {
    await flow(
      "type-text",
      ...STEPS,
      "teardown:",
      '  - type: { into: { id: pin }, text: "{{secret:PIN}}" }',
      "  - script: { path: scripts/cleanup.mjs }"
    );

    await expectRefused(
      "type-text",
      'teardown step 1 (type into id=pin ← "{{secret:PIN}}")',
      'Unknown secret "PIN"'
    );
  });

  it.each(["keyboard", "paste"])(
    "refuses the run on an unknown name in a tool: %s step's text",
    async (tool) => {
      await flow(
        `${tool}-text`,
        ...STEPS,
        "teardown:",
        `  - tool: ${tool}`,
        '    args: { text: "{{secret:TYPED}}" }'
      );

      await expectRefused(
        `${tool}-text`,
        `teardown step 1 (tool ${tool})`,
        'Unknown secret "TYPED"'
      );
    }
  );

  it.each(["keyboard", "paste"])(
    "refuses the run on an unknown name in a %s entry of a tool: run-sequence step",
    async (tool) => {
      await flow(
        `sequence-${tool}`,
        ...STEPS,
        "teardown:",
        "  - tool: run-sequence",
        "    args:",
        "      steps:",
        "        - { tool: gesture-tap, args: { x: 0.5, y: 0.5 } }",
        `        - { tool: ${tool}, args: { text: "{{secret:SEQUENCED}}" } }`
      );

      await expectRefused(
        `sequence-${tool}`,
        "teardown step 1 (tool run-sequence)",
        'Unknown secret "SEQUENCED"'
      );
    }
  );

  it("does not examine a text arg of a run-sequence entry that is not keyboard or paste", async () => {
    await flow(
      "sequence-other",
      ...STEPS,
      "teardown:",
      "  - tool: run-sequence",
      "    args:",
      "      steps:",
      '        - { tool: await-ui-element, args: { text: "{{secret:NOPE}}" } }'
    );

    const { result } = await run("sequence-other");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "tool:pass", "tool:pass (teardown)"]);
  });

  it("runs when a keyboard placeholder resolves only from the tool server's working directory", async () => {
    await secrets(other, "KB_PIN=4821");
    vi.spyOn(process, "cwd").mockReturnValue(other);
    await flow(
      "cwd-secret",
      ...STEPS,
      "teardown:",
      "  - tool: keyboard",
      '    args: { text: "{{secret:KB_PIN}}" }'
    );

    const { result, invokeTool } = await run("cwd-secret");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "tool:pass", "tool:pass (teardown)"]);
    expect(toolCalls(invokeTool).at(-1)).toEqual({
      tool: "keyboard",
      args: { text: "{{secret:KB_PIN}}", udid: IOS_DEVICE },
    });
  });

  it("refuses a keyboard placeholder that resolves only from project_root, as keyboard would", async () => {
    await secrets(root, "KB_PIN=4821");
    await flow(
      "root-only-secret",
      ...STEPS,
      "teardown:",
      "  - tool: keyboard",
      '    args: { text: "{{secret:KB_PIN}}" }'
    );

    await expectRefused(
      "root-only-secret",
      "teardown step 1 (tool keyboard)",
      'Unknown secret "KB_PIN"'
    );
  });

  it("does not examine a tool argument that no secret resolver reads", async () => {
    await flow(
      "unread-arg",
      ...STEPS,
      "teardown:",
      "  - tool: launch-app",
      '    args: { bundleId: "{{secret:NOPE}}" }'
    );

    const { result, invokeTool } = await run("unread-arg");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "tool:pass", "tool:pass (teardown)"]);
    expect(toolCalls(invokeTool).at(-1)).toEqual({
      tool: "launch-app",
      args: { bundleId: "{{secret:NOPE}}", udid: IOS_DEVICE },
    });
  });
});

describe("a teardown when: block", () => {
  const GUARDED = [
    ...STEPS,
    "teardown:",
    "  - when: { platform: ios }",
    "    steps:",
    '      - script: { path: scripts/cleanup.mjs, env: { TOKEN: "{{secret:IOS_PIN}}" } }',
  ];

  it("is not examined before the run, so an Android run without the secret passes", async () => {
    await flow("guarded", ...GUARDED);

    const { result } = await run("guarded", { device: ANDROID_DEVICE });

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual([
      "script:pass",
      "tool:pass",
      "when:skip (teardown)",
      "script:skip (teardown)",
    ]);
    expect(started()).toEqual(["setup"]);
  });

  it("errors its step when the block starts on iOS, after the steps ran", async () => {
    await flow("guarded", ...GUARDED);

    const { result, invokeTool } = await run("guarded", { device: IOS_DEVICE });

    expect(result.ok).toBe(false);
    expect(shape(result)).toEqual([
      "script:pass",
      "tool:pass",
      "when:pass (teardown)",
      "script:error (teardown)",
    ]);
    expect(result.steps[3]?.reason).toContain('env value TOKEN: Unknown secret "IOS_PIN"');
    expect(toolCalls(invokeTool).map((c) => c.tool)).toEqual(["button"]);
    expect(started()).toEqual(["setup"]);
  });
});

describe("a teardown tool: flow-execute step", () => {
  function nestedRun(env: string, projectRoot: string): string[] {
    return [
      ...STEPS,
      "teardown:",
      "  - tool: flow-execute",
      "    args:",
      "      name: does-not-exist",
      `      project_root: ${JSON.stringify(projectRoot)}`,
      `      env: { TOKEN: ${JSON.stringify(env)} }`,
    ];
  }

  it("runs when its env placeholder resolves from its own project_root", async () => {
    await secrets(other, "CHILD_TOKEN=child-9a0c");
    await flow("nested", ...nestedRun("{{secret:CHILD_TOKEN}}", other));

    const { result, invokeTool } = await run("nested");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "tool:pass", "tool:pass (teardown)"]);
    // The named flow does not exist and was not read: the step went to the tool.
    expect(toolCalls(invokeTool).at(-1)).toEqual({
      tool: "flow-execute",
      args: {
        name: "does-not-exist",
        project_root: other,
        env: { TOKEN: "{{secret:CHILD_TOKEN}}" },
        udid: IOS_DEVICE,
      },
    });
  });

  it("refuses the run on an unknown name in its env", async () => {
    await secrets(other, "CHILD_TOKEN=child-9a0c");
    await flow("nested", ...nestedRun("{{secret:NOT_THERE}}", other));

    await expectRefused(
      "nested",
      "teardown step 1 (tool flow-execute)",
      'env value TOKEN: Unknown secret "NOT_THERE"'
    );
  });

  it("refuses a name that only the parent run's project_root defines", async () => {
    await secrets(root, "CHILD_TOKEN=child-9a0c");
    await flow("nested", ...nestedRun("{{secret:CHILD_TOKEN}}", other));

    await expectRefused(
      "nested",
      "teardown step 1 (tool flow-execute)",
      'env value TOKEN: Unknown secret "CHILD_TOKEN"'
    );
  });
});

describe("a teardown run: fragment", () => {
  it("refuses the run on an unknown name in the fragment's steps", async () => {
    await flow(
      "frag",
      "steps:",
      '  - script: { path: scripts/frag-step.mjs, env: { TOKEN: "{{secret:FRAG_MISSING}}" } }'
    );
    await flow("outer", ...STEPS, "teardown:", "  - run: frag.yaml");

    await expectRefused(
      "outer",
      "step 1 of frag.yaml at teardown step 1 (script scripts/frag-step.mjs)",
      'env value TOKEN: Unknown secret "FRAG_MISSING"'
    );
  });

  it("refuses the run on an unknown name in the fragment's own teardown list", async () => {
    await flow(
      "frag",
      "steps: []",
      "teardown:",
      "  - echo: fragment cleanup",
      '  - script: { path: scripts/frag-cleanup.mjs, env: { TOKEN: "{{secret:FRAG_MISSING}}" } }'
    );
    await flow("outer", ...STEPS, "teardown:", "  - echo: cleaning up", "  - run: frag.yaml");

    await expectRefused(
      "outer",
      "teardown step 2 of frag.yaml at teardown step 2 (script scripts/frag-cleanup.mjs)",
      'env value TOKEN: Unknown secret "FRAG_MISSING"'
    );
  });

  it("examines the fragment's scripts with the fragment's env merged over the parent's", async () => {
    await flow(
      "frag",
      'env: { TOKEN: "{{secret:FRAG_ENV}}" }',
      "steps:",
      "  - script: { path: scripts/frag-step.mjs }"
    );
    await flow("outer", ...STEPS, "teardown:", "  - run: frag.yaml");

    await expectRefused(
      "outer",
      "step 1 of frag.yaml at teardown step 1 (script scripts/frag-step.mjs)",
      'env value TOKEN: Unknown secret "FRAG_ENV"'
    );
  });

  it("runs when the fragment's env replaces the parent's placeholder", async () => {
    await flow(
      "frag",
      "env: { TOKEN: from-fragment }",
      "steps:",
      "  - script: { path: scripts/frag-step.mjs }"
    );
    await flow(
      "outer",
      'env: { TOKEN: "{{secret:MISSING}}" }',
      "steps:",
      "  - script: { path: scripts/setup.mjs, env: { TOKEN: setup-value } }",
      "teardown:",
      "  - run: frag.yaml"
    );

    const { result } = await run("outer");

    expect(result.ok).toBe(true);
    expect(shape(result)).toEqual(["script:pass", "run:pass (teardown)", "script:pass (teardown)"]);
    expect(tokenSeenBy("frag-step")).toBe("from-fragment");
  });

  it("does not throw on a cyclic run: target, and the run: step reports the cycle", async () => {
    // The walk would find this unknown name only by entering the root flow a
    // second time through its own teardown.
    await flow(
      "loop",
      "steps:",
      '  - script: { path: scripts/setup.mjs, env: { TOKEN: "{{secret:MISSING}}" } }',
      "teardown:",
      "  - run: loop.yaml"
    );

    const { result } = await run("loop");

    expect(shape(result)).toEqual(["script:error", "run:error (teardown)"]);
    expect(result.steps[1]?.reason).toMatch(/^cyclic flow reference: /);
    expect(started()).toEqual([]);
  });

  it("does not throw on a run: target that cannot be parsed or read", async () => {
    await write(root, path.join(".argent", "flows", "broken.yaml"), "steps: [\n");
    await flow(
      "unreadable",
      ...STEPS,
      "teardown:",
      "  - run: broken.yaml",
      "  - script: { path: scripts/cleanup.mjs }"
    );
    await flow("missing-target", ...STEPS, "teardown:", "  - run: absent.yaml");

    const unreadable = await run("unreadable");
    expect(shape(unreadable.result)).toEqual([
      "script:pass",
      "tool:pass",
      "run:error (teardown)",
      "script:skip (teardown)",
    ]);
    expect(unreadable.result.steps[2]?.reason).toMatch(/^could not load fragment "broken\.yaml": /);

    const absent = await run("missing-target");
    expect(shape(absent.result)).toEqual(["script:pass", "tool:pass", "run:error (teardown)"]);
    expect(absent.result.steps[2]?.reason).toMatch(/^could not load fragment "absent\.yaml": /);
  });

  it("does not throw on a mis-cased run: target, and the run: step reports it", async () => {
    await flow(
      "frag",
      "steps:",
      '  - script: { path: scripts/frag-step.mjs, env: { TOKEN: "{{secret:FRAG_MISSING}}" } }'
    );
    await flow("outer", ...STEPS, "teardown:", "  - run: Frag.yaml");
    // A case-sensitive checkout has no Frag.yaml at all: the same run: step
    // then reports a load error instead.
    const caseInsensitive = fsSync.existsSync(path.join(root, ".ARGENT"));

    const { result } = await run("outer");

    expect(shape(result)).toEqual(["script:pass", "tool:pass", "run:error (teardown)"]);
    expect(result.steps[2]?.reason).toMatch(
      caseInsensitive
        ? /^mis-cased fragment reference "Frag\.yaml": /
        : /^could not load fragment "Frag\.yaml": /
    );
    expect(started()).toEqual(["setup"]);
  });
});

describe("a fragment reached from the steps", () => {
  it("errors its run: step before its steps when its own teardown has an unknown name", async () => {
    await flow(
      "frag",
      "steps:",
      "  - script: { path: scripts/frag-step.mjs }",
      "teardown:",
      '  - script: { path: scripts/frag-cleanup.mjs, env: { TOKEN: "{{secret:FRAG_MISSING}}" } }'
    );
    await flow(
      "outer",
      "steps:",
      "  - script: { path: scripts/setup.mjs }",
      "  - run: frag.yaml",
      "  - script: { path: scripts/after.mjs }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { result } = await run("outer");

    expect(result.ok).toBe(false);
    expect(shape(result)).toEqual([
      "script:pass",
      "run:error",
      "script:skip",
      "script:pass (teardown)",
    ]);
    const reason = result.steps[1]?.reason ?? "";
    expect(reason.startsWith(`fragment "frag.yaml" was not run: `)).toBe(true);
    expect(reason).toContain(
      ' and teardown step 1 (script scripts/frag-cleanup.mjs): env value TOKEN: Unknown secret "FRAG_MISSING"'
    );
    expect(reason).not.toMatch(/[\r\n]/);
    expect(started()).toEqual(["cleanup", "setup"]);
  });

  it("does not examine the fragment's steps when it loads", async () => {
    await flow(
      "frag",
      "steps:",
      '  - script: { path: scripts/frag-step.mjs, env: { TOKEN: "{{secret:FRAG_MISSING}}" } }',
      "teardown:",
      "  - script: { path: scripts/frag-cleanup.mjs }"
    );
    await flow(
      "outer",
      "steps:",
      "  - script: { path: scripts/setup.mjs }",
      "  - run: frag.yaml",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { result } = await run("outer");

    expect(shape(result)).toEqual([
      "script:pass",
      "run:pass",
      "script:error",
      "script:pass (teardown)",
      "script:pass (teardown)",
    ]);
    expect(result.steps[2]?.reason).toContain('env value TOKEN: Unknown secret "FRAG_MISSING"');
    expect(started()).toEqual(["cleanup", "frag-cleanup", "setup"]);
  });
});

describe("secrets in the steps", () => {
  it("keeps the per-step check: the step errors and the teardown runs", async () => {
    await flow(
      "step-secret",
      "steps:",
      '  - script: { path: scripts/setup.mjs, env: { TOKEN: "{{secret:STEP_MISSING}}" } }',
      "  - tool: button",
      "    args: { button: home }",
      "teardown:",
      "  - script: { path: scripts/cleanup.mjs }"
    );

    const { result, invokeTool } = await run("step-secret");

    expect(result.ok).toBe(false);
    expect(shape(result)).toEqual(["script:error", "tool:skip", "script:pass (teardown)"]);
    expect(result.steps[0]?.reason).toContain('env value TOKEN: Unknown secret "STEP_MISSING"');
    expect(toolCalls(invokeTool)).toEqual([]);
    expect(started()).toEqual(["cleanup"]);
  });
});
