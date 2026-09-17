import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-flow-teardown-chromium-home-");

// One ordered log of everything that touches a chromium instance: boots
// (attempted, by app directory name), kills, page fronting, attaches, and the
// device id each `tool: screenshot` step was bound to.
const events: string[] = [];

// Each boot lands on its own port, as the real launcher does, and the device id
// is the port.
let bootCount = 0;
const defaultBoot = async (opts: { appPath: string; extraArgs?: string[] }) => {
  const n = bootCount++;
  return {
    platform: "chromium" as const,
    id: `chromium-cdp-${12345 + n}`,
    port: 12345 + n,
    pid: 4242 + n,
    appPath: opts.appPath,
    booted: true as const,
  };
};
const bootElectronApp = vi.fn(defaultBoot);
const killChromiumByPort = vi.fn();
const killChromiumByPortAndWait = vi.fn(async (_port: number, _pid: number) => {});
vi.mock("../../src/tools/devices/boot-electron", () => ({
  bootElectronApp: (opts: { appPath: string; extraArgs?: string[] }) => {
    events.push(`boot ${path.basename(opts.appPath)}`);
    return bootElectronApp(opts);
  },
  killChromiumByPort: (...args: unknown[]) =>
    (killChromiumByPort as (...a: unknown[]) => unknown)(...args),
  killChromiumByPortAndWait: (port: number, pid: number) => {
    events.push(`kill chromium-cdp-${port}`);
    return killChromiumByPortAndWait(port, pid);
  },
}));
vi.mock("../../src/utils/chromium-discovery", () => ({ untrackChromiumPort: vi.fn() }));

// Every chromium launch settles for 1.5 s, and these runs launch up to four
// times. The settle is a plain wait, so skip it and keep the abort check.
vi.mock("../../src/utils/timing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/timing")>();
  return {
    ...actual,
    sleepOrAbort: async (_ms: number, signal?: AbortSignal) => !signal?.aborted,
  };
});

const boot = (app: string) => `boot ${app}`;
const kill = (port: number) => `kill chromium-cdp-${port}`;
const front = (port: number) => `Page.bringToFront chromium-cdp-${port}`;
const attach = (port: number) => `attach chromium-cdp-${port}`;
const shot = (port: number) => `screenshot chromium-cdp-${port}`;

// The CDP session of any instance answers: `Page.bringToFront` and an attach's
// viewport refresh are logged against the device the session was resolved for.
function makeRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: { udid?: string }) => {
      events.push(`${id} ${args.udid}`);
      return {};
    }),
    // `screenshot` declares a udid, so the runner binds the run's device into it.
    getTool: vi.fn((name: string) =>
      name === "screenshot" ? { inputSchema: { properties: { udid: {} } } } : undefined
    ),
    resolveService: vi.fn(async (_urn: string, options: { device: { id: string } }) => ({
      refreshViewport: async () => {
        events.push(`attach ${options.device.id}`);
        return { width: 800, height: 600 };
      },
      cdp: {
        send: async (method: string) => {
          events.push(`${method} ${options.device.id}`);
          return {};
        },
      },
    })),
    getSnapshot: vi.fn(() => ({ services: new Map() })),
    disposeService: vi.fn(async () => {}),
  } as unknown as Registry;
}

const writtenDirs: string[] = [];

/**
 * Write `flow.yaml` and its sibling files into a new directory. realpath'd, so
 * the app paths the runner resolves match the ones the test builds (macOS keeps
 * the temp directory behind the /var -> /private/var link).
 */
async function writeFlows(files: Record<string, string>): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "flow-teardown-chromium-"))
  );
  writtenDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

/** A script that marks that it started, then fails. */
function failingScript(dir: string): string {
  return (
    `import fs from "node:fs";\n` +
    `fs.writeFileSync(${JSON.stringify(path.join(dir, "fail.mark"))}, "started");\n` +
    `process.exit(3);\n`
  );
}

async function runFlow(
  registry: Registry,
  dir: string,
  extra: { device?: string } = {}
): Promise<FlowRunResult> {
  // A co-located flow_path, as the chromium boot tests run theirs: relative app
  // paths resolve beside the flow file.
  const flowPath = path.join(dir, "flow.yaml");
  const result = (await createRunFlowTool(registry).execute(
    {},
    { project_root: dir, flow_path: flowPath, ...extra } as never,
    {
      fileInputs: {
        flow_path: {
          clientPath: flowPath,
          presentOnHost: true,
          viaUpload: false,
          statVerified: true,
        },
      },
    } as never
  )) as FlowRunResult | { notice: string };
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

function outline(result: FlowRunResult) {
  return result.steps.map(({ kind, status, depth, teardown, reason }) => ({
    kind,
    status,
    depth,
    teardown,
    reason,
  }));
}

function bootedApps(): string[] {
  return bootElectronApp.mock.calls.map((call) => call[0].appPath);
}

beforeEach(() => {
  bootCount = 0;
  events.length = 0;
  // Reset, not clear: a queued mockImplementationOnce must not leak into the
  // next test.
  bootElectronApp.mockReset().mockImplementation(defaultBoot);
  killChromiumByPort.mockReset();
  killChromiumByPortAndWait.mockReset();
});

afterEach(async () => {
  await Promise.all(writtenDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("a teardown chromium launch boots whatever the steps reached", () => {
  const TEARDOWN = "teardown:\n  - launch: { chromium: ./admin }\n  - tool: screenshot\n";

  it("boots the teardown app when the steps failed before their leading launch", async () => {
    // The leading script does not stop the runner from booting ./shop before
    // step 1, and its failure leaves the leading launch unreached. Settling for
    // that instance would report that the flow file changed.
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - script: { path: ./fail.mjs }\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n" +
        TEARDOWN,
    });
    await fs.writeFile(path.join(dir, "fail.mjs"), failingScript(dir), "utf8");
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(fsSync.existsSync(path.join(dir, "fail.mark"))).toBe(true);
    expect(outline(result)).toEqual([
      { kind: "script", status: "fail", reason: expect.any(String) },
      { kind: "launch", status: "skip" },
      { kind: "tool", status: "skip" },
      {
        kind: "launch",
        status: "pass",
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345",
      },
      { kind: "tool", status: "pass", teardown: true },
    ]);
    expect(result.steps.map((s) => s.reason ?? "").join("\n")).not.toContain(
      "the flow file changed after the run started"
    );
    expect(result.ok).toBe(false);
    expect(bootedApps()).toEqual([path.join(dir, "shop"), path.join(dir, "admin")]);
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      boot("admin"),
      front(12346),
      shot(12346),
      kill(12346),
      kill(12345),
    ]);
  });

  it("boots the teardown app after steps that all passed", async () => {
    const dir = await writeFlows({
      "flow.yaml": "steps:\n  - launch: { chromium: ./shop }\n  - tool: screenshot\n" + TEARDOWN,
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(bootedApps()).toEqual([path.join(dir, "shop"), path.join(dir, "admin")]);
    expect(outline(result)).toEqual([
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "tool", status: "pass" },
      {
        kind: "launch",
        status: "pass",
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345",
      },
      { kind: "tool", status: "pass", teardown: true },
    ]);
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      shot(12345),
      boot("admin"),
      front(12346),
      shot(12346),
      kill(12346),
      kill(12345),
    ]);
  });

  it("boots the teardown app on a pinned --device instead of attaching to that instance", async () => {
    // A pinned run boots nothing before step 1, so a teardown launch that took
    // the first-launch branch would attach to the pinned instance and the
    // teardown step after it would act on the wrong app.
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - script: { path: ./fail.mjs }\n" +
        "  - launch: { chromium: ./shop }\n" +
        TEARDOWN,
    });
    await fs.writeFile(path.join(dir, "fail.mjs"), failingScript(dir), "utf8");
    const registry = makeRegistry();

    const result = await runFlow(registry, dir, { device: "chromium-cdp-9999" });

    expect(fsSync.existsSync(path.join(dir, "fail.mark"))).toBe(true);
    expect(outline(result)).toEqual([
      { kind: "script", status: "fail", reason: expect.any(String) },
      { kind: "launch", status: "skip" },
      {
        kind: "launch",
        status: "pass",
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12345 — run moved off chromium-cdp-9999",
      },
      { kind: "tool", status: "pass", teardown: true },
    ]);
    expect(result.device).toBe("chromium-cdp-9999");
    expect(bootedApps()).toEqual([path.join(dir, "admin")]);
    // No attach, and the pinned instance is never killed.
    expect(events).toEqual([front(9999), boot("admin"), front(12345), shot(12345), kill(12345)]);
  });
});

describe("after a fragment's teardown list, the run goes back to its chromium instance", () => {
  it("runs a fragment whose teardown boots another app before the root's leading launch", async () => {
    // The §3 flow: ./shop is booted before the run, seed.yaml's teardown moves
    // the run to ./admin, and the root's first launch must still find ./shop.
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - run: seed.yaml\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n",
      "seed.yaml":
        "steps:\n" +
        "  - script: { path: ./seed.mjs }\n" +
        "teardown:\n" +
        "  - launch: { chromium: ./admin }\n" +
        "  - tool: screenshot\n",
      "seed.mjs":
        `import fs from "node:fs";\n` +
        `fs.writeFileSync(new URL("./seed.mark", import.meta.url), "seeded");\n`,
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(fsSync.existsSync(path.join(dir, "seed.mark"))).toBe(true);
    expect(outline(result)).toEqual([
      { kind: "run", status: "pass" },
      { kind: "script", status: "pass", depth: 1 },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345",
      },
      { kind: "tool", status: "pass", depth: 1, teardown: true },
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    expect(bootedApps()).toEqual([path.join(dir, "shop"), path.join(dir, "admin")]);
    // The shop page is fronted again after the fragment's teardown, before the
    // root's next step.
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      boot("admin"),
      front(12346),
      shot(12346),
      front(12345),
      shot(12345),
      kill(12346),
      kill(12345),
    ]);
  });

  it("boots the root's leading launch again, with its args, when a fragment teardown relaunched that app", async () => {
    // The teardown relaunch replaces the instance booted for the root's launch.
    // Settling for the replacement would start the root on a used window that
    // lacks the root launch's args.
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - run: reset.yaml\n" +
        "  - launch: { chromium: { path: ./shop, args: [--probe] } }\n" +
        "  - tool: screenshot\n",
      "reset.yaml":
        "steps: []\nteardown:\n  - launch: { chromium: ./shop }\n  - tool: screenshot\n",
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(outline(result)).toEqual([
      { kind: "run", status: "pass" },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason:
          "booted chromium instance chromium-cdp-12346 — retired chromium-cdp-12345 (same app relaunched)",
      },
      { kind: "tool", status: "pass", depth: 1, teardown: true },
      {
        kind: "launch",
        status: "pass",
        reason:
          "booted chromium instance chromium-cdp-12347 — retired chromium-cdp-12346 (same app relaunched)",
      },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    expect(bootElectronApp.mock.calls.map((call) => call[0].extraArgs)).toEqual([
      ["--probe"],
      undefined,
      ["--probe"],
    ]);
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      kill(12345),
      boot("shop"),
      front(12346),
      shot(12346),
      kill(12346),
      boot("shop"),
      front(12347),
      shot(12347),
      kill(12347),
    ]);
  });

  it("boots the root's leading launch again when a fragment teardown step used its instance", async () => {
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - run: reset.yaml\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n",
      "reset.yaml": "steps: []\nteardown:\n  - tool: screenshot\n",
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(outline(result)).toEqual([
      { kind: "run", status: "pass" },
      { kind: "tool", status: "pass", depth: 1, teardown: true },
      {
        kind: "launch",
        status: "pass",
        reason:
          "booted chromium instance chromium-cdp-12346 — retired chromium-cdp-12345 (same app relaunched)",
      },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      shot(12345),
      kill(12345),
      boot("shop"),
      front(12346),
      shot(12346),
      kill(12346),
    ]);
  });

  it("settles the root's leading launch when a fragment teardown ran only echo and script steps", async () => {
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - run: reset.yaml\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n",
      "reset.yaml": "steps: []\nteardown:\n  - echo: cleaning\n  - script: { path: ./clean.mjs }\n",
      "clean.mjs":
        `import fs from "node:fs";\n` +
        `fs.writeFileSync(new URL("./clean.mark", import.meta.url), "cleaned");\n`,
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(fsSync.existsSync(path.join(dir, "clean.mark"))).toBe(true);
    expect(outline(result)).toEqual([
      { kind: "run", status: "pass" },
      { kind: "echo", status: "pass", depth: 1, teardown: true },
      { kind: "script", status: "pass", depth: 1, teardown: true },
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    expect(events).toEqual([boot("shop"), front(12345), shot(12345), kill(12345)]);
  });

  it("goes back to a pinned --device instance after a fragment teardown boots another app", async () => {
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - run: seed.yaml\n" +
        "  - tool: screenshot\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n",
      "seed.yaml":
        "steps:\n  - echo: seeding\nteardown:\n  - launch: { chromium: ./admin }\n  - tool: screenshot\n",
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir, { device: "chromium-cdp-9999" });

    expect(outline(result)).toEqual([
      { kind: "run", status: "pass" },
      { kind: "echo", status: "pass", depth: 1 },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12345 — run moved off chromium-cdp-9999",
      },
      { kind: "tool", status: "pass", depth: 1, teardown: true },
      { kind: "tool", status: "pass" },
      // The root's first launch still attaches to the pinned instance.
      { kind: "launch", status: "pass" },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    // The pinned instance is fronted again and stays alive; only the admin
    // instance the teardown booted is killed.
    expect(events).toEqual([
      front(9999),
      boot("admin"),
      front(12345),
      shot(12345),
      front(9999),
      shot(9999),
      attach(9999),
      shot(9999),
      kill(12345),
    ]);
  });

  it("goes to the new root-app instance when the fragment teardown relaunched that app, then booted another", async () => {
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n  - launch: { chromium: ./shop }\n  - run: relaunch.yaml\n  - tool: screenshot\n",
      "relaunch.yaml":
        "steps:\n" +
        "  - echo: in fragment\n" +
        "teardown:\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - launch: { chromium: ./admin }\n" +
        "  - tool: screenshot\n",
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(outline(result)).toEqual([
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "run", status: "pass" },
      { kind: "echo", status: "pass", depth: 1 },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason:
          "booted chromium instance chromium-cdp-12346 — retired chromium-cdp-12345 (same app relaunched)",
      },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12347 — run moved off chromium-cdp-12346",
      },
      { kind: "tool", status: "pass", depth: 1, teardown: true },
      { kind: "tool", status: "pass" },
    ]);
    expect(result.ok).toBe(true);
    // The original ./shop instance is gone (retired by the relaunch), so the
    // root's step after the fragment runs on its replacement, 12346.
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      kill(12345),
      boot("shop"),
      front(12346),
      boot("admin"),
      front(12347),
      shot(12347),
      front(12346),
      shot(12346),
      kill(12347),
      kill(12346),
    ]);
  });

  it("stays where the fragment teardown left it when relaunching the root app fails to boot", async () => {
    // The relaunch kills the run's ./shop instance before its boot fails, so no
    // ./shop instance is left to go back to. The failure stops the root's
    // remaining steps, and the root teardown's device step runs where the
    // fragment teardown left the run: the ./admin instance.
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - run: relaunch.yaml\n" +
        "  - tool: screenshot\n" +
        "teardown:\n" +
        "  - tool: screenshot\n",
      "relaunch.yaml":
        "steps:\n" +
        "  - echo: in fragment\n" +
        "teardown:\n" +
        "  - launch: { chromium: ./admin }\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - tool: screenshot\n",
    });
    bootElectronApp
      .mockImplementationOnce(defaultBoot)
      .mockImplementationOnce(defaultBoot)
      .mockImplementationOnce(async () => {
        throw new Error("Electron boot: failed to spawn electron: EACCES");
      });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(outline(result)).toEqual([
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "run", status: "pass" },
      { kind: "echo", status: "pass", depth: 1 },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345",
      },
      {
        kind: "launch",
        status: "error",
        depth: 1,
        teardown: true,
        reason: "could not boot the chromium app: Electron boot: failed to spawn electron: EACCES",
      },
      {
        kind: "tool",
        status: "skip",
        depth: 1,
        teardown: true,
        reason: expect.stringContaining("did not start: the teardown list stopped at "),
      },
      { kind: "tool", status: "skip" },
      { kind: "tool", status: "pass", teardown: true },
    ]);
    expect(result.ok).toBe(false);
    // 12345 is fronted only when the run starts: nothing moves the run back to
    // the killed instance.
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      boot("admin"),
      front(12346),
      kill(12345),
      boot("shop"),
      shot(12346),
      kill(12346),
    ]);
  });
});

describe("chromium instances a teardown list booted", () => {
  it("stay alive until the run ends, after the root teardown's device steps", async () => {
    const dir = await writeFlows({
      "flow.yaml":
        "steps:\n" +
        "  - launch: { chromium: ./shop }\n" +
        "  - run: seed.yaml\n" +
        "  - tool: screenshot\n" +
        "teardown:\n" +
        "  - launch: { chromium: ./report }\n" +
        "  - tool: screenshot\n",
      "seed.yaml": "steps:\n  - echo: seeding\nteardown:\n  - launch: { chromium: ./admin }\n",
    });
    const registry = makeRegistry();

    const result = await runFlow(registry, dir);

    expect(result.ok).toBe(true);
    expect(outline(result)).toEqual([
      { kind: "launch", status: "pass", reason: "booted chromium instance chromium-cdp-12345" },
      { kind: "run", status: "pass" },
      { kind: "echo", status: "pass", depth: 1 },
      {
        kind: "launch",
        status: "pass",
        depth: 1,
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12346 — run moved off chromium-cdp-12345",
      },
      { kind: "tool", status: "pass" },
      {
        kind: "launch",
        status: "pass",
        teardown: true,
        reason: "booted chromium instance chromium-cdp-12347 — run moved off chromium-cdp-12345",
      },
      { kind: "tool", status: "pass", teardown: true },
    ]);
    // The fragment's ./admin instance outlives its teardown list, and every
    // kill comes after the root teardown's screenshot, newest instance first.
    expect(events).toEqual([
      boot("shop"),
      front(12345),
      boot("admin"),
      front(12346),
      front(12345),
      shot(12345),
      boot("report"),
      front(12347),
      shot(12347),
      kill(12347),
      kill(12346),
      kill(12345),
    ]);
    expect(killChromiumByPortAndWait.mock.calls).toEqual([
      [12347, 4244],
      [12346, 4243],
      [12345, 4242],
    ]);
    expect(killChromiumByPort).not.toHaveBeenCalled();
  });
});
