import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ResolvedToolsUrl } from "@argent/tools-client";
import {
  createTeardownSections,
  flow,
  renderFailedSteps,
  renderReport,
  renderStepLine,
  renderTeardownLine,
  type FlowReport,
  type StepReport,
} from "../src/flow.js";

const toolsClientMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  baseUrl: vi.fn(async () => ({ url: "http://127.0.0.1:4141", token: "tok" })),
}));
const getResolvedToolsUrlMock = vi.hoisted(() =>
  vi.fn(async (): Promise<ResolvedToolsUrl> => ({ url: null, source: "none" }))
);

vi.mock("@argent/tools-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@argent/tools-client")>()),
  createToolsClient: vi.fn(() => toolsClientMock),
  getResolvedToolsUrl: getResolvedToolsUrlMock,
  materializeArtifacts: vi.fn(async (data: unknown) => ({ result: data, images: [] })),
}));

/** The runner's summarize(): narration is not counted unless it errored. */
function mkReport(steps: StepReport[]): FlowReport {
  const counted = steps.filter((s) => s.kind !== "echo" || s.status === "error");
  const failed = counted.filter((s) => s.status === "fail").length;
  const errored = counted.filter((s) => s.status === "error").length;
  return {
    flow: "checkout",
    device: "UDID-1",
    ok: failed === 0 && errored === 0,
    passed: counted.filter((s) => s.status === "pass").length,
    failed,
    skipped: counted.filter((s) => s.status === "skip").length,
    errored,
    steps,
  };
}

const STOPPED = 'did not start: the teardown list stopped at tap "Settings"';
const DID_NOT_START =
  'this and 1 more teardown step did not start because the teardown list stopped at tap "Settings": ' +
  "tool stop-all-simulator-servers, script scripts/delete-user.sh. What they clean up can remain";

/** A run whose steps fail, then a teardown list that stops at its second step. */
const FAILED_RUN: StepReport[] = [
  {
    index: 0,
    kind: "script",
    status: "pass",
    flow: "checkout",
    target: "scripts/seed-order.mjs",
    scriptLog: "created order 4711\n",
  },
  { index: 1, kind: "launch", status: "pass", flow: "checkout" },
  {
    index: 2,
    kind: "tap",
    status: "fail",
    flow: "checkout",
    target: '"Checkout"',
    reason: 'no element matched "Checkout"',
  },
  { index: 3, kind: "tap", status: "skip", flow: "checkout", target: '"Pay"' },
  {
    index: 4,
    kind: "script",
    status: "pass",
    flow: "checkout",
    target: "scripts/delete-order.sh",
    teardown: true,
    scriptLog: "deleted order 4711\n",
  },
  {
    index: 5,
    kind: "tap",
    status: "fail",
    flow: "checkout",
    target: '"Settings"',
    teardown: true,
    reason: 'no element matched "Settings"',
  },
  {
    index: 6,
    kind: "echo",
    status: "skip",
    flow: "checkout",
    teardown: true,
    reason: STOPPED,
    message: "signing out",
  },
  {
    index: 7,
    kind: "tool",
    status: "skip",
    flow: "checkout",
    teardown: true,
    tool: "stop-all-simulator-servers",
    reason: STOPPED,
    warning: DID_NOT_START,
  },
  {
    index: 8,
    kind: "script",
    status: "skip",
    flow: "checkout",
    target: "scripts/delete-user.sh",
    teardown: true,
    reason: STOPPED,
  },
];

const FAILED_RUN_LINES = [
  "  ✓  1 script scripts/seed-order.mjs",
  "       │ created order 4711",
  "  ✓  2 launch",
  '  ✗  3 tap "Checkout" — no element matched "Checkout"',
  '  ·  4 tap "Pay"',
  "  ──── teardown",
  "  ✓  5 script scripts/delete-order.sh",
  "       │ deleted order 4711",
  '  ✗  6 tap "Settings" — no element matched "Settings"',
  `  · › signing out — ${STOPPED}`,
  `  ·  7 tool stop-all-simulator-servers — ${STOPPED}`,
  `       ⚠ ${DID_NOT_START}`,
  `  ·  8 script scripts/delete-user.sh — ${STOPPED}`,
];

/** A fragment with its own teardown list inside the root steps, then the root teardown list. */
const FRAGMENT_THEN_ROOT: StepReport[] = [
  { index: 0, kind: "run", status: "pass", flow: "login", target: "login.yaml" },
  { index: 1, kind: "tap", status: "pass", flow: "login", target: '"Sign in"', depth: 1 },
  {
    index: 2,
    kind: "script",
    status: "pass",
    flow: "login",
    target: "scripts/delete-session.mjs",
    depth: 1,
    teardown: true,
  },
  { index: 3, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
  {
    index: 4,
    kind: "script",
    status: "pass",
    flow: "checkout",
    target: "scripts/delete-order.sh",
    teardown: true,
  },
];

/**
 * A root teardown list that starts with a `run:`: the fragment's steps and its
 * own teardown list are all teardown reports one level down.
 */
const ROOT_TEARDOWN_RUN: StepReport[] = [
  { index: 0, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
  {
    index: 1,
    kind: "run",
    status: "pass",
    flow: "cleanup",
    target: "cleanup.yaml",
    teardown: true,
  },
  {
    index: 2,
    kind: "script",
    status: "pass",
    flow: "cleanup",
    target: "scripts/delete-order.sh",
    depth: 1,
    teardown: true,
  },
  {
    index: 3,
    kind: "script",
    status: "pass",
    flow: "cleanup",
    target: "scripts/delete-user.sh",
    depth: 1,
    teardown: true,
  },
  {
    index: 4,
    kind: "tool",
    status: "pass",
    flow: "checkout",
    tool: "stop-all-simulator-servers",
    teardown: true,
  },
];

function lines(report: FlowReport): string[] {
  return renderReport(report).split("\n");
}

describe("renderReport with a teardown list", () => {
  it("prints the label before the first teardown step, then the reasons, the warning and the script log", () => {
    expect(lines(mkReport(FAILED_RUN))).toEqual([
      'Flow "checkout" on UDID-1',
      ...FAILED_RUN_LINES,
      "",
      "FAIL — 3 passed, 2 failed, 0 errored, 3 skipped, 1 warning",
    ]);
  });

  it("prints the teardown word in the label column of the step line under it", () => {
    for (const n of [1, 9, 99, 100, 1000, 10000]) {
      for (const depth of [undefined, 0, 1, 3]) {
        const step: StepReport = { index: 0, kind: "tap", status: "pass", depth, teardown: true };
        const label = renderTeardownLine(step, n);
        expect(label.indexOf("teardown")).toBe(renderStepLine(step, n, "f").indexOf("tap"));
        expect(label).toBe(
          `  ${"─".repeat(2 + Math.max(2, String(n).length))} ${"  ".repeat(depth ?? 0)}teardown`
        );
      }
    }
  });

  it("widens the label with the step number when the teardown starts past step 99", () => {
    const many = (count: number): StepReport[] =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        kind: "tap",
        status: "pass" as const,
        flow: "checkout",
        target: `"Item ${i + 1}"`,
      }));
    const cleanup = (index: number): StepReport => ({
      index,
      kind: "script",
      status: "pass",
      flow: "checkout",
      target: "scripts/delete-order.sh",
      teardown: true,
    });

    const at100 = lines(mkReport([...many(99), cleanup(99)]));
    const step100 = at100.indexOf("  ✓ 100 script scripts/delete-order.sh");
    expect(at100[step100 - 1]).toBe("  ───── teardown");
    expect(at100[step100 - 2]).toBe('  ✓ 99 tap "Item 99"');

    const at101 = lines(mkReport([...many(100), cleanup(100)]));
    const step101 = at101.indexOf("  ✓ 101 script scripts/delete-order.sh");
    expect(at101[step101 - 1]).toBe("  ───── teardown");
    expect(at101[step101 - 1]!.indexOf("teardown")).toBe(at101[step101]!.indexOf("script"));
    expect(at101.filter((l) => l.endsWith("teardown"))).toHaveLength(1);
  });

  it("prints the label above an echo that opens the teardown list, sized for the next numbered step", () => {
    expect(
      lines(
        mkReport([
          { index: 0, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
          {
            index: 1,
            kind: "echo",
            status: "pass",
            flow: "checkout",
            teardown: true,
            message: "cleaning up",
          },
          {
            index: 2,
            kind: "script",
            status: "pass",
            flow: "checkout",
            target: "scripts/delete-order.sh",
            teardown: true,
          },
        ])
      )
    ).toEqual([
      'Flow "checkout" on UDID-1',
      '  ✓  1 tap "Checkout"',
      "  ──── teardown",
      "  › cleaning up",
      "  ✓  2 script scripts/delete-order.sh",
      "",
      "PASS — 2 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });
});

describe("teardown sections in renderReport", () => {
  it("labels a fragment's teardown at the fragment's depth and the root teardown after it at depth 0", () => {
    expect(lines(mkReport(FRAGMENT_THEN_ROOT))).toEqual([
      'Flow "checkout" on UDID-1',
      "  ✓  1 run login.yaml [login]",
      '  ✓  2   tap "Sign in" [login]',
      "  ────   teardown",
      "  ✓  3   script scripts/delete-session.mjs [login]",
      '  ✓  4 tap "Checkout"',
      "  ──── teardown",
      "  ✓  5 script scripts/delete-order.sh",
      "",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("labels a root teardown that starts with a run: step once, not again for the fragment's reports", () => {
    expect(lines(mkReport(ROOT_TEARDOWN_RUN))).toEqual([
      'Flow "checkout" on UDID-1',
      '  ✓  1 tap "Checkout"',
      "  ──── teardown",
      "  ✓  2 run cleanup.yaml [cleanup]",
      "  ✓  3   script scripts/delete-order.sh [cleanup]",
      "  ✓  4   script scripts/delete-user.sh [cleanup]",
      "  ✓  5 tool stop-all-simulator-servers",
      "",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("labels each run of a fragment that the steps use twice", () => {
    const run = (index: number): StepReport[] => [
      { index, kind: "run", status: "pass", flow: "login", target: "login.yaml" },
      {
        index: index + 1,
        kind: "tap",
        status: "pass",
        flow: "login",
        target: '"Sign in"',
        depth: 1,
      },
      {
        index: index + 2,
        kind: "tool",
        status: "pass",
        flow: "login",
        tool: "restart-app",
        depth: 1,
        teardown: true,
      },
    ];
    expect(lines(mkReport([...run(0), ...run(3)]))).toEqual([
      'Flow "checkout" on UDID-1',
      "  ✓  1 run login.yaml [login]",
      '  ✓  2   tap "Sign in" [login]',
      "  ────   teardown",
      "  ✓  3   tool restart-app [login]",
      "  ✓  4 run login.yaml [login]",
      '  ✓  5   tap "Sign in" [login]',
      "  ────   teardown",
      "  ✓  6   tool restart-app [login]",
      "",
      "PASS — 6 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("labels an inner fragment's teardown and then its parent fragment's teardown separately", () => {
    expect(
      lines(
        mkReport([
          { index: 0, kind: "run", status: "pass", flow: "outer", target: "outer.yaml" },
          { index: 1, kind: "run", status: "pass", flow: "inner", target: "inner.yaml", depth: 1 },
          { index: 2, kind: "tool", status: "pass", flow: "inner", tool: "a", depth: 2 },
          {
            index: 3,
            kind: "tool",
            status: "pass",
            flow: "inner",
            tool: "inner-clean",
            depth: 2,
            teardown: true,
          },
          {
            index: 4,
            kind: "tool",
            status: "pass",
            flow: "outer",
            tool: "outer-clean",
            depth: 1,
            teardown: true,
          },
        ])
      )
    ).toEqual([
      'Flow "checkout" on UDID-1',
      "  ✓  1 run outer.yaml [outer]",
      "  ✓  2   run inner.yaml [inner]",
      "  ✓  3     tool a [inner]",
      "  ────     teardown",
      "  ✓  4     tool inner-clean [inner]",
      "  ────   teardown",
      "  ✓  5   tool outer-clean [outer]",
      "",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("labels a teardown when block once, after a when block in the steps", () => {
    const stopped = "did not start: the teardown list stopped at tool td-fail";
    expect(
      lines(
        mkReport([
          {
            index: 0,
            kind: "when",
            status: "pass",
            flow: "checkout",
            target: "platform ios",
            reason: "condition met (platform ios)",
          },
          { index: 1, kind: "tool", status: "pass", flow: "checkout", tool: "a", depth: 1 },
          {
            index: 2,
            kind: "when",
            status: "pass",
            flow: "checkout",
            target: "platform ios",
            teardown: true,
            reason: "condition met (platform ios)",
          },
          {
            index: 3,
            kind: "tool",
            status: "error",
            flow: "checkout",
            tool: "td-fail",
            depth: 1,
            teardown: true,
            reason: "td-fail broke",
          },
          {
            index: 4,
            kind: "tool",
            status: "skip",
            flow: "checkout",
            tool: "b",
            depth: 1,
            teardown: true,
            reason: stopped,
          },
        ])
      )
    ).toEqual([
      'Flow "checkout" on UDID-1',
      "  ✓  1 when platform ios — condition met (platform ios)",
      "  ✓  2   tool a",
      "  ──── teardown",
      "  ✓  3 when platform ios — condition met (platform ios)",
      "  ✗  4   tool td-fail — td-fail broke",
      `  ·  5   tool b — ${stopped}`,
      "",
      "FAIL — 3 passed, 0 failed, 1 errored, 1 skipped",
    ]);
  });

  it("labels a report that is all teardown once, before its first step", () => {
    expect(
      lines(
        mkReport([
          {
            index: 0,
            kind: "script",
            status: "pass",
            flow: "checkout",
            target: "scripts/delete-order.sh",
            teardown: true,
          },
          {
            index: 1,
            kind: "tool",
            status: "pass",
            flow: "checkout",
            tool: "stop-all-simulator-servers",
            teardown: true,
          },
        ])
      )
    ).toEqual([
      'Flow "checkout" on UDID-1',
      "  ──── teardown",
      "  ✓  1 script scripts/delete-order.sh",
      "  ✓  2 tool stop-all-simulator-servers",
      "",
      "PASS — 2 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints a report with no teardown flags as before", () => {
    // The fixture and output of flow-render.test.ts's historical-shape case,
    // plus nesting and an explicit `teardown: false` off the wire.
    const out = renderReport({
      ...mkReport([
        { index: 0, kind: "echo", status: "pass", message: "starting" },
        { index: 1, kind: "launch", status: "pass" },
        { index: 2, kind: "tap", status: "pass", flow: "login", target: '"Login"' },
        {
          index: 3,
          kind: "snapshot",
          status: "fail",
          reason: "diff 2.10% > 1%",
          target: '"home"',
          artifacts: { baseline: "/tmp/b.png", diff: "/tmp/d.png" },
        },
        { index: 4, kind: "await", status: "skip", target: 'visible "Done"' },
        { index: 5, kind: "tap", status: "skip", target: '"Nested"', depth: 1, teardown: false },
      ]),
    });
    expect(out).toBe(
      [
        'Flow "checkout" on UDID-1',
        "  › starting",
        "  ✓  1 launch",
        '  ✓  2 tap "Login" [login]',
        '  ✗  3 snapshot "home" — diff 2.10% > 1%',
        "       baseline: /tmp/b.png",
        "       diff: /tmp/d.png",
        '  ·  4 await visible "Done"',
        '  ·  5   tap "Nested"',
        "",
        "FAIL — 2 passed, 1 failed, 0 errored, 2 skipped",
      ].join("\n")
    );
    expect(out).not.toContain("teardown");
  });
});

describe("renderFailedSteps with a teardown list", () => {
  const signOutFailed: StepReport = {
    index: 3,
    kind: "tap",
    status: "fail",
    flow: "checkout",
    target: '"Sign out"',
    teardown: true,
    reason: 'no element matched "Sign out"',
  };

  it("prints the label once, above the first printed step of the section", () => {
    expect(
      renderFailedSteps(
        mkReport([
          {
            index: 0,
            kind: "tap",
            status: "fail",
            flow: "checkout",
            target: '"Checkout"',
            reason: 'no element matched "Checkout"',
          },
          {
            index: 1,
            kind: "tool",
            status: "pass",
            flow: "checkout",
            tool: "restart-app",
            teardown: true,
          },
          {
            index: 2,
            kind: "script",
            status: "pass",
            flow: "checkout",
            target: "scripts/delete-order.sh",
            teardown: true,
            scriptLog: "deleted order 4711\n",
          },
          signOutFailed,
        ])
      )
    ).toEqual([
      '  ✗  1 tap "Checkout" — no element matched "Checkout"',
      "  ──── teardown",
      "  ✓  3 script scripts/delete-order.sh",
      "       │ deleted order 4711",
      '  ✗  4 tap "Sign out" — no element matched "Sign out"',
    ]);
  });

  it("prints a teardown failure after passing teardown steps under the label", () => {
    expect(
      renderFailedSteps(
        mkReport([
          { index: 0, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
          {
            index: 1,
            kind: "tool",
            status: "pass",
            flow: "checkout",
            tool: "restart-app",
            teardown: true,
          },
          {
            index: 2,
            kind: "script",
            status: "pass",
            flow: "checkout",
            target: "scripts/delete-order.sh",
            teardown: true,
          },
          signOutFailed,
        ])
      )
    ).toEqual(["  ──── teardown", '  ✗  4 tap "Sign out" — no element matched "Sign out"']);
  });

  it("prints no label for a teardown section with no printed step", () => {
    expect(
      renderFailedSteps(
        mkReport([
          {
            index: 0,
            kind: "tap",
            status: "fail",
            flow: "checkout",
            target: '"Checkout"',
            reason: 'no element matched "Checkout"',
          },
          {
            index: 1,
            kind: "script",
            status: "pass",
            flow: "checkout",
            target: "scripts/delete-order.sh",
            teardown: true,
          },
          {
            index: 2,
            kind: "echo",
            status: "pass",
            flow: "checkout",
            teardown: true,
            message: "cleaned up",
          },
          {
            index: 3,
            kind: "tool",
            status: "pass",
            flow: "checkout",
            tool: "restart-app",
            teardown: true,
          },
        ])
      )
    ).toEqual(['  ✗  1 tap "Checkout" — no element matched "Checkout"']);
  });

  it("does not carry an unprinted fragment teardown's label onto a later root step", () => {
    const steps = FRAGMENT_THEN_ROOT.map((s) =>
      s.index === 3 ? { ...s, status: "fail" as const, reason: "not found" } : s
    );
    expect(renderFailedSteps(mkReport(steps))).toEqual(['  ✗  4 tap "Checkout" — not found']);
  });

  it("labels the root teardown at depth 0 when a fragment's teardown before it printed nothing", () => {
    const steps = FRAGMENT_THEN_ROOT.map((s) =>
      s.index === 4 ? { ...s, status: "fail" as const, reason: "exit code 1" } : s
    );
    expect(renderFailedSteps(mkReport(steps))).toEqual([
      "  ──── teardown",
      "  ✗  5 script scripts/delete-order.sh — exit code 1",
    ]);
  });

  it("labels each printed section at its own depth", () => {
    const steps = FRAGMENT_THEN_ROOT.map((s) => {
      if (s.index === 2) return { ...s, status: "fail" as const, reason: "exit code 1" };
      if (s.index === 3) return { ...s, status: "skip" as const };
      if (s.index === 4) return { ...s, status: "fail" as const, reason: "exit code 2" };
      return s;
    });
    expect(renderFailedSteps(mkReport(steps))).toEqual([
      "  ────   teardown",
      "  ✗  3   script scripts/delete-session.mjs [login] — exit code 1",
      "  ──── teardown",
      "  ✗  5 script scripts/delete-order.sh — exit code 2",
    ]);
  });

  it("labels a section at the depth it opened at when its first printed step is deeper", () => {
    const steps = ROOT_TEARDOWN_RUN.map((s) =>
      s.index === 2 ? { ...s, status: "fail" as const, reason: "exit code 1" } : s
    );
    expect(renderFailedSteps(mkReport(steps))).toEqual([
      "  ──── teardown",
      "  ✗  3   script scripts/delete-order.sh [cleanup] — exit code 1",
    ]);
  });

  it("labels an errored echo that is the first printed report of a teardown section", () => {
    const reason = "`echo`: {{output:order.id}} did not resolve";
    expect(
      renderFailedSteps(
        mkReport([
          { index: 0, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
          {
            index: 1,
            kind: "tool",
            status: "pass",
            flow: "checkout",
            tool: "restart-app",
            teardown: true,
          },
          {
            index: 2,
            kind: "echo",
            status: "error",
            flow: "checkout",
            teardown: true,
            message: "Order {{output:order.id}}",
            reason,
          },
        ])
      )
    ).toEqual(["  ──── teardown", `  ✗ › Order {{output:order.id}} — ${reason}`]);
  });
});

describe("createTeardownSections", () => {
  function opens(steps: Partial<StepReport>[]): boolean[] {
    const next = createTeardownSections();
    return steps.map((s) => next({ index: 0, kind: "tap", status: "pass", ...s }));
  }

  it("opens a section at a teardown report that follows a report outside teardown", () => {
    expect(
      opens([
        {},
        { teardown: true },
        { teardown: true, depth: 1 },
        { teardown: true },
        { depth: 1 },
        { teardown: true, depth: 1 },
      ])
    ).toEqual([false, true, false, false, false, true]);
  });

  it("reads a negative, fractional or non-number depth as depth 0", () => {
    const hostile = [-1, -1e9, 1.5, Number.NaN, Infinity, -Infinity, "2", null, {}];
    for (const depth of hostile) {
      const d = depth as number;
      // As depth 0, the depth-0 report after it continues its section.
      expect(opens([{}, { teardown: true, depth: d }, { teardown: true }])).toEqual([
        false,
        true,
        false,
      ]);
      expect(
        opens([
          { teardown: true, depth: d },
          { teardown: true, depth: 1 },
        ])
      ).toEqual([true, false]);
    }
  });

  it("reads a huge integer depth as its value, without throwing or allocating by it", () => {
    const started = performance.now();
    for (const depth of [1e9, Number.MAX_SAFE_INTEGER, 2 ** 60, Number.MAX_VALUE]) {
      // As a deep report, a depth-0 teardown report after it opens a section of its own.
      expect(
        opens([{}, { teardown: true, depth }, { teardown: true, depth }, { teardown: true }])
      ).toEqual([false, true, false, true]);
      expect(renderTeardownLine({ index: 0, kind: "tap", status: "pass", depth }, 1)).toBe(
        `  ──── ${"  ".repeat(20)}teardown`
      );
    }
    const next = createTeardownSections();
    const depths = [1e9, -1, Number.MAX_VALUE, 0, 2.5, 1e9 + 1];
    for (let i = 0; i < 10_000; i++) {
      next({
        index: i,
        kind: "tap",
        status: "pass",
        depth: depths[i % depths.length],
        teardown: i % 3 === 0,
      });
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("stays linear on a report whose steps get deeper one by one", () => {
    // A scan of every depth seen took 4.3 s for this on the machine it was
    // measured on, and the stack takes about 5 ms.
    const next = createTeardownSections();
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) {
      next({ index: i, kind: "tap", status: "pass", depth: i, teardown: true });
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("renders the label of a negative or fractional depth flat", () => {
    const step: StepReport = { index: 0, kind: "tap", status: "pass", teardown: true };
    expect(renderTeardownLine({ ...step, depth: -3 }, 1)).toBe("  ──── teardown");
    expect(renderTeardownLine({ ...step, depth: 1.5 }, 1)).toBe("  ──── teardown");
  });
});

describe("argent flow run with a teardown list", () => {
  let tempRoot: string;
  let flowPath: string;
  let flowsDir: string;
  let logs: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const opts = { paths: {} as never };

  beforeAll(async () => {
    tempRoot = await fsp.mkdtemp(path.join(tmpdir(), "argent-cli-teardown-"));
    flowPath = path.join(tempRoot, "checkout.yaml");
    await fsp.writeFile(flowPath, "steps: []\n", "utf8");
    flowsDir = path.join(tempRoot, "suite");
    await fsp.mkdir(flowsDir);
    await fsp.writeFile(path.join(flowsDir, "checkout.yaml"), "steps: []\n", "utf8");
  });

  afterAll(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getResolvedToolsUrlMock.mockResolvedValue({ url: null, source: "none" });
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function streamSteps(steps: StepReport[]): void {
    toolsClientMock.callTool.mockImplementation(
      async (_tool: string, _payload: unknown, o?: { onProgress?: (e: unknown) => void }) => {
        for (const step of steps) o?.onProgress?.(step);
        return { data: mkReport(steps) };
      }
    );
  }

  it("prints the label live before the first teardown step, and counts the warning in the summary", async () => {
    streamSteps(FAILED_RUN);

    await expect(flow(["run", flowPath], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual([
      'Flow "checkout"',
      ...FAILED_RUN_LINES,
      "\nFAIL (started on UDID-1) — 3 passed, 2 failed, 0 errored, 3 skipped, 1 warning",
    ]);
  });

  it("prints a live label for each teardown section, and one for a teardown run: step", async () => {
    const steps: StepReport[] = [
      ...FRAGMENT_THEN_ROOT.slice(0, 4),
      ...ROOT_TEARDOWN_RUN.slice(1).map((s) => ({ ...s, index: s.index + 3 })),
    ];
    streamSteps(steps);

    await expect(flow(["run", flowPath], opts)).rejects.toThrow("process.exit:0");

    expect(logs).toEqual([
      'Flow "checkout"',
      "  ✓  1 run login.yaml [login]",
      '  ✓  2   tap "Sign in" [login]',
      "  ────   teardown",
      "  ✓  3   script scripts/delete-session.mjs [login]",
      '  ✓  4 tap "Checkout"',
      "  ──── teardown",
      "  ✓  5 run cleanup.yaml [cleanup]",
      "  ✓  6   script scripts/delete-order.sh [cleanup]",
      "  ✓  7   script scripts/delete-user.sh [cleanup]",
      "  ✓  8 tool stop-all-simulator-servers",
      "\nPASS (started on UDID-1) — 8 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints the live label above an echo that opens the teardown list", async () => {
    streamSteps([
      { index: 0, kind: "tap", status: "pass", flow: "checkout", target: '"Checkout"' },
      {
        index: 1,
        kind: "echo",
        status: "pass",
        flow: "checkout",
        teardown: true,
        message: "cleaning up",
      },
      {
        index: 2,
        kind: "script",
        status: "pass",
        flow: "checkout",
        target: "scripts/delete-order.sh",
        teardown: true,
      },
    ]);

    await expect(flow(["run", flowPath], opts)).rejects.toThrow("process.exit:0");

    expect(logs).toEqual([
      'Flow "checkout"',
      '  ✓  1 tap "Checkout"',
      "  ──── teardown",
      "  › cleaning up",
      "  ✓  2 script scripts/delete-order.sh",
      "\nPASS (started on UDID-1) — 2 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints the label in a directory run above the first printed teardown step", async () => {
    toolsClientMock.callTool.mockResolvedValue({ data: mkReport(FAILED_RUN) });

    await expect(flow(["run", flowsDir], opts)).rejects.toThrow("process.exit:1");

    expect(logs).toEqual([
      "[1/1] checkout.yaml",
      "  ✓  1 script scripts/seed-order.mjs",
      "       │ created order 4711",
      '  ✗  3 tap "Checkout" — no element matched "Checkout"',
      "  ──── teardown",
      "  ✓  5 script scripts/delete-order.sh",
      "       │ deleted order 4711",
      '  ✗  6 tap "Settings" — no element matched "Settings"',
      `  ·  7 tool stop-all-simulator-servers — ${STOPPED}`,
      `       ⚠ ${DID_NOT_START}`,
      // A batch prints every script step that carries a reason, whatever its status.
      `  ·  8 script scripts/delete-user.sh — ${STOPPED}`,
      "  FAIL (started on UDID-1) — 3 passed, 2 failed, 0 errored, 3 skipped, 1 warning",
      "\nFAIL — 1 flow: 0 passed, 1 failed, 0 skipped",
    ]);
  });
});
