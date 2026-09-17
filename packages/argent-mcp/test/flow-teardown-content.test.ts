import { describe, it, expect } from "vitest";
import {
  flowRunToMcpContent,
  type FlowExecuteResult,
  type FlowStepResult,
} from "../src/content.js";

/** The runner's summarize(): narration is not counted unless it errored. */
function result(steps: FlowStepResult[]): FlowExecuteResult {
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

/** Every block as its text; the fixtures carry no image. */
async function texts(steps: FlowStepResult[]): Promise<string[]> {
  const blocks = await flowRunToMcpContent(result(steps));
  return blocks.map((b) => {
    if (b.type !== "text") throw new Error(`unexpected ${b.type} block`);
    return b.text;
  });
}

const STOPPED = 'did not start: the teardown list stopped at tap "Settings"';
const DID_NOT_START =
  'this and 1 more teardown step did not start because the teardown list stopped at tap "Settings": ' +
  "tool stop-all-simulator-servers, script scripts/delete-user.sh. What they clean up can remain";

/** A run whose steps fail, then a teardown list that stops at its second step. */
const FAILED_RUN: FlowStepResult[] = [
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

/** A fragment with its own teardown list inside the root steps, then the root teardown list. */
const FRAGMENT_THEN_ROOT: FlowStepResult[] = [
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
    scriptLog: "deleted session s_1\n",
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

describe("flowRunToMcpContent with a teardown list", () => {
  it("prints a teardown block before the first teardown step, then the reasons, the warning and the script output", async () => {
    expect(await texts(FAILED_RUN)).toEqual([
      'Running flow "checkout" on UDID-1 (9 steps)',
      "[1] ✓ script scripts/seed-order.mjs",
      "script output:\ncreated order 4711",
      "[2] ✓ launch",
      '[3] ✗ tap "Checkout" — no element matched "Checkout"',
      '[4] · tap "Pay"',
      "── teardown ──",
      "[5] ✓ script scripts/delete-order.sh",
      "script output:\ndeleted order 4711",
      '[6] ✗ tap "Settings" — no element matched "Settings"',
      `[7] · signing out — ${STOPPED}`,
      `[8] · stop-all-simulator-servers — ${STOPPED} ⚠ ${DID_NOT_START}`,
      `[9] · script scripts/delete-user.sh — ${STOPPED}`,
      "FAIL — 3 passed, 2 failed, 0 errored, 3 skipped",
    ]);
  });

  it("prints a block for a fragment's teardown at its depth, and a second one for the root teardown", async () => {
    expect(await texts(FRAGMENT_THEN_ROOT)).toEqual([
      'Running flow "checkout" on UDID-1 (5 steps)',
      "[1] ✓ run login.yaml",
      '[2] ✓   tap "Sign in"',
      "  ── teardown ──",
      "[3] ✓   script scripts/delete-session.mjs",
      "  script output:\ndeleted session s_1",
      '[4] ✓ tap "Checkout"',
      "── teardown ──",
      "[5] ✓ script scripts/delete-order.sh",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints one block for a root teardown that starts with a run: step", async () => {
    expect(
      await texts([
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
      ])
    ).toEqual([
      'Running flow "checkout" on UDID-1 (5 steps)',
      '[1] ✓ tap "Checkout"',
      "── teardown ──",
      "[2] ✓ run cleanup.yaml",
      "[3] ✓   script scripts/delete-order.sh",
      "[4] ✓   script scripts/delete-user.sh",
      "[5] ✓ stop-all-simulator-servers",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints a block for each run of a fragment that the steps use twice", async () => {
    const run = (index: number): FlowStepResult[] => [
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
    const out = await texts([...run(0), ...run(3)]);

    expect(out.filter((t) => t.includes("teardown"))).toEqual([
      "  ── teardown ──",
      "  ── teardown ──",
    ]);
    expect(out.indexOf("  ── teardown ──")).toBe(out.indexOf('[2] ✓   tap "Sign in"') + 1);
    expect(out.lastIndexOf("  ── teardown ──")).toBe(out.indexOf('[5] ✓   tap "Sign in"') + 1);
  });

  it("prints a block for an inner fragment's teardown and another for its parent fragment's", async () => {
    expect(
      await texts([
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
    ).toEqual([
      'Running flow "checkout" on UDID-1 (5 steps)',
      "[1] ✓ run outer.yaml",
      "[2] ✓   run inner.yaml",
      "[3] ✓     a",
      "    ── teardown ──",
      "[4] ✓     inner-clean",
      "  ── teardown ──",
      "[5] ✓   outer-clean",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints one block for a teardown when block after a when block in the steps", async () => {
    const out = await texts([
      { index: 0, kind: "when", status: "pass", flow: "checkout", target: "platform ios" },
      { index: 1, kind: "tool", status: "pass", flow: "checkout", tool: "a", depth: 1 },
      {
        index: 2,
        kind: "when",
        status: "pass",
        flow: "checkout",
        target: "platform ios",
        teardown: true,
      },
      {
        index: 3,
        kind: "tool",
        status: "pass",
        flow: "checkout",
        tool: "b",
        depth: 1,
        teardown: true,
      },
    ]);

    expect(out.filter((t) => t.includes("teardown"))).toEqual(["── teardown ──"]);
    expect(out.indexOf("── teardown ──")).toBe(out.indexOf("[3] ✓ when platform ios") - 1);
  });

  it("prints the block right after the header for a result that is all teardown", async () => {
    expect(
      await texts([
        {
          index: 0,
          kind: "script",
          status: "pass",
          flow: "checkout",
          target: "scripts/delete-order.sh",
          teardown: true,
        },
      ])
    ).toEqual([
      'Running flow "checkout" on UDID-1 (1 steps)',
      "── teardown ──",
      "[1] ✓ script scripts/delete-order.sh",
      "PASS — 1 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints the block before an echo that opens the teardown list", async () => {
    expect(
      await texts([
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
    ).toEqual([
      'Running flow "checkout" on UDID-1 (3 steps)',
      '[1] ✓ tap "Checkout"',
      "── teardown ──",
      "[2] ✓ cleaning up",
      "[3] ✓ script scripts/delete-order.sh",
      "PASS — 2 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("prints nothing extra for a result with no teardown flags", async () => {
    const steps: FlowStepResult[] = FRAGMENT_THEN_ROOT.map(({ teardown: _teardown, ...s }) => s);
    steps[4] = { ...steps[4]!, teardown: false };

    expect(await texts(steps)).toEqual([
      'Running flow "checkout" on UDID-1 (5 steps)',
      "[1] ✓ run login.yaml",
      '[2] ✓   tap "Sign in"',
      "[3] ✓   script scripts/delete-session.mjs",
      "  script output:\ndeleted session s_1",
      '[4] ✓ tap "Checkout"',
      "[5] ✓ script scripts/delete-order.sh",
      "PASS — 5 passed, 0 failed, 0 errored, 0 skipped",
    ]);
  });

  it("indents the block of a hostile depth like its step line, without throwing", async () => {
    const out = await texts([
      { index: 0, kind: "tap", status: "pass", target: '"A"' },
      { index: 1, kind: "tap", status: "pass", target: '"B"', depth: 1e9, teardown: true },
      { index: 2, kind: "tap", status: "pass", target: '"C"', depth: -4, teardown: true },
    ]);

    expect(out.slice(1, -1)).toEqual([
      '[1] ✓ tap "A"',
      `${"  ".repeat(20)}── teardown ──`,
      `[2] ✓ ${"  ".repeat(20)}tap "B"`,
      "── teardown ──",
      '[3] ✓ tap "C"',
    ]);
  });
});
