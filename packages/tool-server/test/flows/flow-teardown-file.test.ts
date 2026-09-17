import { describe, it, expect } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  parseFlow,
  serializeFlow,
  validateFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";
import { stepName, summarizeSteps } from "../../src/tools/flows/flow-step-definitions";

const CONTRACT =
  "`teardown` is a list of cleanup steps that runs after `steps` ends with pass, fail or " +
  "error, but not after a cancel, and it stops at its first failed step.";

const SNAPSHOT_REFUSAL =
  "cannot be in a teardown list: the teardown also runs after a failed run, and with " +
  "--update-baselines a snapshot there would save the screen that run left as the baseline. " +
  "Move the snapshot into `steps`.";

interface Refusal {
  message: string;
  stage: string | undefined;
  code: string | undefined;
}

function refusalOf(run: () => unknown): Refusal {
  try {
    run();
  } catch (err) {
    const signal = getFailureSignal(err);
    return {
      message: err instanceof Error ? err.message : String(err),
      stage: signal?.failure_stage,
      code: signal?.error_code,
    };
  }
  throw new Error("expected the call to throw");
}

const parseRefusal = (yaml: string): Refusal => refusalOf(() => parseFlow(yaml));

describe("the shape of the teardown key", () => {
  it("refuses `teardown:` with no value, saying it must be a list and stating the contract", () => {
    expect(parseRefusal("steps: []\nteardown:\n")).toEqual({
      message:
        "Invalid flow file: `teardown` must be a list of steps, like `steps`, but it is empty " +
        `(null). Write \`teardown: []\` for no cleanup, or remove the key. ${CONTRACT}`,
      stage: "flow_file_parse",
      code: FAILURE_CODES.FLOW_FILE_INVALID,
    });
  });

  it.each([
    ["a string", "steps: []\nteardown: foo\n"],
    ["a map", "steps: []\nteardown: { a: 1 }\n"],
    ["a number", "steps: []\nteardown: 3\n"],
  ])("refuses a teardown that is %s", (_label, yaml) => {
    const refused = parseRefusal(yaml);

    expect(refused.message).toMatch(
      /^Invalid flow file: `teardown` must be a list of steps, like `steps`, but it is /
    );
    expect(refused.message).toContain("Write `teardown: []` for no cleanup, or remove the key.");
    expect(refused.message.endsWith(CONTRACT)).toBe(true);
    expect(refused.stage).toBe("flow_file_parse");
    expect(refused.code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
  });

  it("keeps an empty teardown list through parse and serialize", () => {
    const flow = parseFlow("steps: []\nteardown: []\n");

    expect(flow).toEqual({ executionPrerequisite: "", steps: [], teardown: [] });
    expect(serializeFlow(flow)).toBe("steps: []\nteardown: []\n");
  });

  it("gives a file without the key no teardown property at all", () => {
    const flow = parseFlow("steps:\n  - echo: hi\n");

    expect("teardown" in flow).toBe(false);
    expect(serializeFlow(flow)).not.toContain("teardown");
  });

  it("accepts a teardown-only fragment that has `steps: []`", () => {
    expect(parseFlow("steps: []\nteardown:\n  - script: { path: scripts/clean.mjs }\n")).toEqual({
      executionPrerequisite: "",
      steps: [],
      teardown: [{ kind: "script", path: "scripts/clean.mjs" }],
    });
  });

  it("refuses a file with a teardown list and no steps list", () => {
    expect(parseRefusal("teardown:\n  - echo: bye\n")).toEqual({
      message: "Invalid flow file: expected an object with a steps array",
      stage: "flow_file_parse",
      code: FAILURE_CODES.FLOW_FILE_INVALID,
    });
  });

  it("lists teardown among the allowed top-level keys and states the contract", () => {
    expect(parseRefusal("steps: []\ncleanup:\n  - echo: bye\n")).toEqual({
      message:
        "Invalid flow file: unknown key `cleanup` — allowed top-level keys: " +
        `executionPrerequisite, steps, env, teardown. ${CONTRACT}`,
      stage: "flow_file_parse",
      code: FAILURE_CODES.FLOW_FILE_INVALID,
    });
  });

  it.each(["tearDown", "teardwon"])("suggests `teardown` for the misspelled key `%s`", (key) => {
    const refused = parseRefusal(`steps: []\n${key}:\n  - echo: bye\n`);

    expect(refused.message).toContain(
      `unknown key \`${key}\` (did you mean \`teardown\`?) — allowed top-level keys: ` +
        "executionPrerequisite, steps, env, teardown."
    );
    expect(refused.message.endsWith(CONTRACT)).toBe(true);
    expect(refused.stage).toBe("flow_file_parse");
  });
});

describe("teardown steps go through the step parser", () => {
  it.each([
    ["an unrecognized step kind", "  - bogus: 1\n"],
    ["a scalar entry", "  - just text\n"],
    ["a step with an unknown key", "  - type: { into: { id: name }, text: hi, sumbit: true }\n"],
  ])("refuses %s in teardown with the error the same entry gets in steps", (_label, entry) => {
    const inSteps = parseRefusal(`steps:\n${entry}`);
    const inTeardown = parseRefusal(`steps: []\nteardown:\n${entry}`);

    expect(inSteps.message).toMatch(/^Unrecognized flow entry \(/);
    expect(inTeardown).toEqual(inSteps);
    expect(inTeardown.stage).toBe("flow_file_parse_step");
    expect(inTeardown.code).toBe(FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED);
  });

  it("parses every teardown entry into the step it would be in steps", () => {
    const list =
      "  - script: { path: scripts/delete-order.sh, timeout: 5000 }\n" +
      "  - launch: { ios: com.acme.shop, android: com.acme.shop.debug }\n" +
      "  - tap: Settings\n" +
      "  - when: { platform: ios }\n" +
      "    steps:\n" +
      "      - tap: { text: Sign out }\n" +
      "  - run: ../shared/cleanup.yaml\n" +
      "  - tool: stop-all-simulator-servers\n" +
      "    args: { devices: [ABC] }\n" +
      "  - await: { idle: true }\n";

    const asTeardown = parseFlow(`steps: []\nteardown:\n${list}`).teardown;

    expect(asTeardown).toHaveLength(7);
    expect(asTeardown).toEqual(parseFlow(`steps:\n${list}`).steps);
  });
});

describe("no snapshot in a teardown list", () => {
  it("refuses a teardown snapshot, naming its teardown position", () => {
    expect(parseRefusal("steps: []\nteardown:\n  - echo: cleaning\n  - snapshot: home\n")).toEqual({
      message: `Teardown step 2 (\`snapshot\`) ${SNAPSHOT_REFUSAL}`,
      stage: "flow_file_parse_step",
      code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    });
  });

  it("refuses a snapshot inside a when block of the teardown list", () => {
    expect(
      parseRefusal(
        "steps: []\nteardown:\n  - when: { platform: ios }\n    steps:\n      - snapshot: home\n"
      )
    ).toEqual({
      message: `Teardown step 1.1 (\`snapshot\`) ${SNAPSHOT_REFUSAL}`,
      stage: "flow_file_parse_step",
      code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    });
  });

  it("refuses the snapshot when validateFlow gets a flow built in memory", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [],
      teardown: [
        { kind: "echo", message: "cleaning" },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [
            { kind: "echo", message: "android" },
            { kind: "snapshot", name: "home" },
          ],
        },
      ],
    };

    expect(refusalOf(() => validateFlow(flow))).toEqual({
      message: `Teardown step 2.2 (\`snapshot\`) ${SNAPSHOT_REFUSAL}`,
      stage: "flow_file_parse_step",
      code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    });
  });

  it("still accepts a snapshot in steps next to a teardown list", () => {
    expect(parseFlow("steps:\n  - snapshot: home\nteardown:\n  - echo: bye\n")).toEqual({
      executionPrerequisite: "",
      steps: [{ kind: "snapshot", name: "home" }],
      teardown: [{ kind: "echo", message: "bye" }],
    });
  });
});

describe("output references in a teardown step", () => {
  it("names a malformed teardown reference by its teardown position", () => {
    const refused = parseRefusal(
      'steps: []\nteardown:\n  - echo: bye\n  - echo: "id {{output:}}"\n'
    );

    expect(refused.message).toMatch(
      /^Teardown step 2 \(`echo`\): `echo` holds a malformed output reference: /
    );
    expect(refused.stage).toBe("flow_output_reference");
    expect(refused.code).toBe(FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED);
  });

  it("names a teardown reference in a static field by its teardown position", () => {
    const refused = parseRefusal('steps: []\nteardown:\n  - launch: "com.acme.{{output:app}}"\n');

    expect(refused.message).toMatch(
      /^Teardown step 1 \(`launch`\): `launch` cannot hold an output reference: /
    );
    expect(refused.stage).toBe("flow_output_reference");
  });

  it("names a reference in a teardown when block by its nested teardown position", () => {
    const refused = parseRefusal(
      "steps: []\nteardown:\n  - echo: bye\n  - when: { platform: android }\n    steps:\n" +
        '      - run: "{{output:dir}}/cleanup.yaml"\n'
    );

    expect(refused.message).toMatch(
      /^Teardown step 2\.1 \(`run`\): `run` cannot hold an output reference: /
    );
    expect(refused.stage).toBe("flow_output_reference");
  });

  it("checks the teardown when validateFlow gets a flow built in memory", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "{{output:order.id}}" }],
      teardown: [{ kind: "script", path: "{{output:dir}}/delete.mjs" }],
    };

    expect(refusalOf(() => validateFlow(flow)).message).toMatch(
      /^Teardown step 1 \(`script`\): `script\.path` cannot hold an output reference: /
    );
  });

  it("keeps the `Step N` wording for the same reference in steps", () => {
    expect(parseRefusal('steps:\n  - launch: "com.acme.{{output:app}}"\nteardown: []\n')).toEqual({
      message:
        "Step 1 (`launch`): `launch` cannot hold an output reference: Argent reads this field as " +
        'written, so the step would use the literal text "com.acme.{{output:app}}". An output ' +
        "reference resolves only in an `echo` message, a selector's `text`, `id` and `role`, a " +
        "`when` guard, `type` text, `contains` and `equals` text, a `tool` step's `args`, and a " +
        "`script` step's `env` values.",
      stage: "flow_output_reference",
      code: FAILURE_CODES.FLOW_ENTRY_UNRECOGNIZED,
    });
    expect(
      parseRefusal(
        'steps:\n  - when: { platform: ios }\n    steps:\n      - echo: "{{output:}}"\n' +
          "teardown:\n  - echo: bye\n"
      ).message
    ).toMatch(/^Step 1\.1 \(`echo`\): `echo` holds a malformed output reference: /);
  });

  it("leaves a well-formed teardown reference for the run to resolve", () => {
    expect(
      parseFlow(
        "steps: []\nteardown:\n" +
          "  - script:\n" +
          "      path: scripts/delete-order.sh\n" +
          "      env: { ORDER_ID: \"{{output:order.id ?? ''}}\" }\n" +
          '  - echo: "deleted {{output:order.id}}"\n'
      ).teardown
    ).toEqual([
      {
        kind: "script",
        path: "scripts/delete-order.sh",
        env: { ORDER_ID: "{{output:order.id ?? ''}}" },
      },
      { kind: "echo", message: "deleted {{output:order.id}}" },
    ]);
  });
});

describe("a teardown launch is not the flow's leading launch", () => {
  it("accepts a teardown launch in a flow that declares executionPrerequisite", () => {
    expect(
      parseFlow(
        "executionPrerequisite: App on home screen\n" +
          "steps:\n  - tap: { text: Settings }\n" +
          "teardown:\n  - launch: com.acme.app\n"
      )
    ).toEqual({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "tap", selector: { text: "Settings" } }],
      teardown: [{ kind: "launch", app: "com.acme.app" }],
    });
  });

  it("accepts a teardown that starts with a launch in a fragment with no steps", () => {
    expect(
      parseFlow(
        "executionPrerequisite: App on home screen\nsteps: []\n" +
          "teardown:\n  - script: { path: scripts/clean.mjs }\n  - launch: com.acme.app\n"
      ).teardown
    ).toEqual([
      { kind: "script", path: "scripts/clean.mjs" },
      { kind: "launch", app: "com.acme.app" },
    ]);
  });

  it("still refuses the same launch as the first entry of steps", () => {
    expect(
      parseRefusal(
        "executionPrerequisite: App on home screen\n" +
          "steps:\n  - launch: com.acme.app\n" +
          "teardown:\n  - echo: bye\n"
      ).message
    ).toMatch(/must not declare executionPrerequisite/);
  });
});

describe("serializeFlow and the teardown list", () => {
  const FLOW: FlowFile = {
    env: { API_URL: "https://staging.example", EMPTY: "" },
    executionPrerequisite: "Signed out, on the home screen",
    steps: [
      { kind: "script", path: "scripts/seed-order.mjs", env: { SKU: "espresso" } },
      { kind: "tap", selector: { text: "Checkout" } },
      { kind: "echo", message: "order {{output:order.id}}" },
    ],
    teardown: [
      {
        kind: "script",
        path: "scripts/delete-order.sh",
        timeout: 5000,
        env: { ORDER_ID: "{{output:order.id ?? ''}}", TOKEN: "{{secret:CI_TOKEN}}" },
      },
      {
        kind: "when",
        condition: { kind: "platform", platform: "ios" },
        steps: [
          { kind: "tap", selector: { text: "Sign out" } },
          { kind: "idle", timeout: 2000 },
        ],
      },
      { kind: "run", flow: "../shared/cleanup.yaml" },
    ],
  };

  it("round-trips a flow with env, a prerequisite, steps and a teardown list", () => {
    expect(parseFlow(serializeFlow(FLOW))).toEqual(FLOW);
  });

  it("writes the top-level keys as env, steps, executionPrerequisite, teardown", () => {
    const topLevel = [...serializeFlow(FLOW).matchAll(/^([A-Za-z]+):/gm)].map((m) => m[1]);

    expect(topLevel).toEqual(["env", "steps", "executionPrerequisite", "teardown"]);
  });

  it("writes the teardown after the steps in the file an author reads", () => {
    const yaml = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "seeding" }],
      teardown: [{ kind: "script", path: "scripts/clean.mjs" }],
    });

    expect(yaml).toBe(
      "steps:\n  - echo: seeding\nteardown:\n  - script:\n      path: scripts/clean.mjs\n"
    );
  });
});

describe("summarizeSteps with a teardown list", () => {
  it("lists teardown lines after the step lines, numbered on their own", () => {
    const flow: FlowFile = {
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "seeding" },
        { kind: "tap", selector: { text: "Checkout" } },
      ],
      teardown: [
        { kind: "script", path: "scripts/delete-order.sh", env: { ORDER_ID: "7" } },
        { kind: "idle" },
      ],
    };

    expect(summarizeSteps(flow)).toEqual([
      "1. echo: seeding",
      '2. tap: {"text":"Checkout"}',
      'teardown 1. script: scripts/delete-order.sh env {"ORDER_ID":"7"}',
      "teardown 2. await: screen idle",
    ]);
  });

  it("gives an empty teardown list no lines", () => {
    expect(
      summarizeSteps({
        executionPrerequisite: "",
        steps: [{ kind: "echo", message: "only" }],
        teardown: [],
      })
    ).toEqual(["1. echo: only"]);
  });
});

describe("stepName", () => {
  const CASES: [label: string, step: FlowStep, name: string][] = [
    [
      "a tool step by its tool, without its args",
      { kind: "tool", name: "stop-all-simulator-servers", args: { devices: ["ABC"] } },
      "tool stop-all-simulator-servers",
    ],
    [
      "a script by its path, without its env",
      {
        kind: "script",
        path: "scripts/delete-user.sh",
        timeout: 5000,
        env: { TOKEN: "{{secret:CI_TOKEN}}" },
      },
      "script scripts/delete-user.sh",
    ],
    ["a launch by its app", { kind: "launch", app: "com.acme.shop" }, "launch com.acme.shop"],
    [
      "a per-platform launch by its app map",
      { kind: "launch", app: { ios: "com.acme.shop" } },
      'launch {"ios":"com.acme.shop"}',
    ],
    ["an idle wait by its file spelling", { kind: "idle" }, "await screen idle"],
    ["a wait by its duration", { kind: "wait", ms: 500 }, "wait 500ms"],
    [
      "a multi-line echo on one line",
      { kind: "echo", message: "first\nsecond\tthird" },
      "echo first\\nsecond\\tthird",
    ],
    [
      "a run step by its target",
      { kind: "run", flow: "../shared/cleanup.yaml" },
      "run ../shared/cleanup.yaml",
    ],
    ["a tap by its target", { kind: "tap", selector: { text: "Settings" } }, 'tap "Settings"'],
    [
      "a launch id with a line break on one line",
      { kind: "launch", app: "com.acme\nshop" },
      "launch com.acme\\nshop",
    ],
  ];

  it.each(CASES)("names %s", (_label, step, name) => {
    expect(stepName(step)).toBe(name);
  });

  it("cuts a 300-character echo to the rendered-value limit", () => {
    const name = stepName({ kind: "echo", message: "x".repeat(300) });

    expect(name).toBe(`echo ${"x".repeat(195)}…(+105 chars)`);
  });
});
