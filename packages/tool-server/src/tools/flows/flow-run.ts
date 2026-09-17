import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  FLOW_FILE_NAME_PATTERN,
  FLOW_NAME_PATTERN,
  getFailureSignal,
  isLiveServiceState,
  wrapFailure,
} from "@argent/registry";
import type {
  DeviceInfo,
  FailureSignal,
  FileInputSpec,
  Registry,
  ResolvedFileInput,
  ToolContext,
  ToolDefinition,
} from "@argent/registry";
import {
  appIdForPlatform,
  assertSafeFlowName,
  assertValidProjectRoot,
  blockSteps,
  chromiumLaunchSpec,
  classifyOnDiskSpelling,
  getFlowPath,
  isBlockStep,
  parseFlow,
  precedesLeadingLaunch,
  runTargetName,
  stepsAndTeardown,
  type BlockStep,
  type FlowFile,
  type FlowStep,
  type Launch,
  type ScriptEnv,
  SELECTABLE_PLATFORMS,
} from "./flow-utils";
import { createScriptLogBudget, type FlowScriptLogBudget } from "./script/flow-script-executor";
import {
  assertNoEnvOutputReferences,
  escapeInline,
  renderedValue,
  resolveStepReferences,
  type StepReferenceResolution,
  type WholeFieldReference,
} from "./flow-utils";
import type { OutputFieldKind, ResolvedOutputReference } from "./flow-output";
import { canonicalFlowPath, resolveFlowRelativeFile } from "./flow-file-refs";
import { mergeScriptOutput, runFlowScriptStep } from "./flow-script-step";
import { describeWhenCondition, stepName, stepTarget } from "./flow-step-definitions";
import {
  describeScriptEnvProblem,
  mergeScriptEnv,
  resolveScriptEnvSecrets,
  scriptEnvParameter,
} from "./script/flow-script-env";
import { createScriptRunNotes, type FlowScriptRunNotes } from "./script/flow-script-executor";
import { sleepOrAbort } from "../../utils/timing";
import { InvalidToolInputError } from "../../utils/capability";
import { resolveSecretPlaceholders } from "../../utils/secrets";
import { invokeSubTool, describeNestedParamError } from "../../utils/sub-invoke";
import { iosDeviceRunnerRef } from "../../blueprints/ios-device-runner";
import { isUnmetUiWaitResult } from "../await-ui-element";
import { isDebuggerNotConnectedResult } from "../debugger/not-connected";
import {
  resolveFlowDevice,
  bindDeviceArgs,
  flowRequiresDevice,
  flowScopesDevice,
  stepRequiresDevice,
  type FlowPlatform,
} from "./flow-device";
import { isNestedOrchestratorTool, nestedOrchestratorOutcome } from "./flow-nested-outcome";
import {
  runDirective,
  invokeOnDevice,
  ABORTED_OUTCOME,
  probeWhenCondition,
  type ActionEnv,
  type DirectiveOutcome,
} from "./flow-actions";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  isNativeDevtoolsBlockResult,
  nativeDevtoolsRef,
  NATIVE_DEVTOOLS_CONNECT_BUDGET_MS,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
} from "../../blueprints/native-devtools";
import { androidDevtoolsRef, type AndroidDevtoolsApi } from "../../blueprints/android-devtools";
import {
  chromiumCdpRef,
  ensureCdpReachable,
  CHROMIUM_CDP_NAMESPACE,
  type ChromiumCdpApi,
} from "../../blueprints/chromium-cdp";
import { bootElectronApp, killChromiumByPortAndWait } from "../devices/boot-electron";
import { untrackChromiumPort } from "../../utils/chromium-discovery";
import { isIosPhysicalDevice, parseChromiumCdpPort, resolveDevice } from "../../utils/device-info";
import { runSnapshot, DEFAULT_MAX_MISMATCH, type SnapshotArtifacts } from "./flow-visual";
import { describeVega } from "../describe/platforms/vega";
import { pinStatusBar, restoreStatusBar } from "../../utils/status-bar";

const zodSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Name of a saved flow to run from `.argent/flows` (e.g. "settings-explore"). Omit when flow_path is set.'
      ),
    project_root: z
      .string()
      .describe(
        "Absolute path to the calling agent's project root — the cwd it is working in. With name, the saved flow is read from `.argent/flows/<name>.yaml` under this root; with flow_path, the flow, its run: siblings, its script: paths and baselines all resolve beside the YAML instead, so pass the agent's cwd. A script still RUNS in this root whichever source was used."
      ),
    flow_file: z
      .string()
      .optional()
      .describe(
        "Path to the flow .yaml as readable by the tool-server. Internal — the argent client derives it from project_root and name automatically; leave unset."
      ),
    flow_path: z
      .string()
      .optional()
      .describe(
        "Omit when name is set. Absolute path to a co-located flow .yaml on the client and tool server's shared filesystem. This must be supplied through the file-input boundary. For remote execution, pass name + project_root instead."
      ),
    device: z
      .string()
      .optional()
      .describe(
        "Device id to run against (iOS UDID, Android/Vega serial, Chromium id) — the id list-devices reports. Auto-detected when omitted, but only when exactly one booted device matches (optionally narrowed by `platform`); with several booted the run fails and lists them, so pass this explicitly whenever more than one device is up."
      ),
    platform: z
      .enum(SELECTABLE_PLATFORMS)
      .optional()
      .describe(
        "Restrict auto-detection to this platform when several devices are booted. `ios` selects local simulators only — pass `ios-remote` to select a remote one. `chromium` does more than filter: with no `device` it SELECTS the self-boot branch for an e2e flow - the runner boots an Electron instance from the `launch` step's chromium value and tears it down after the run (a single-key `launch: { chromium: … }` map selects it on its own, without this parameter). When it selects that branch it never falls back to device auto-detection (a fragment, or an e2e launch map with no `chromium` key, still does), and the launch value must be a real Electron app path on the tool-server host: a bare-string `launch:` - what the recorder writes - holds an installed-app bundle id, so passing `chromium` for one fails the whole run with `Electron boot: path does not exist`. Edit the launch to `{ chromium: <app path> }` first."
      ),
    updateBaselines: z
      .boolean()
      .optional()
      .describe(
        "Write/refresh screenshot baselines for `snapshot` steps instead of diffing against them."
      ),
    prerequisiteAcknowledged: z
      .boolean()
      .optional()
      .describe(
        "Set to true to confirm the execution prerequisite has been met. Required (LLM path) when a fragment defines an executionPrerequisite."
      ),
    env: scriptEnvParameter("This run's")
      .optional()
      .describe(
        "Environment variables for every script in this run, including nested `run:` flows. " +
          "Use string values and names that match [A-Za-z_][A-Za-z0-9_]*. " +
          "These values replace flow defaults. A script step's `env` takes priority. " +
          "Use `{{secret:NAME}}` for credentials from the tool-server's secret sources, with `project_root` for project files. " +
          "A missing secret prevents the run from starting. Plaintext values remain visible in tool logs."
      ),
  })
  .superRefine((params, ctx) => {
    if ((params.name === undefined) === (params.flow_path === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          params.name !== undefined
            ? "Pass exactly one flow source: name or flow_path."
            : "Pass exactly one flow source: name or flow_path. flow-execute needs the flow's " +
              "name in `name` — it resolves <project_root>/.argent/flows/<name>.yaml.",
        path: [],
      });
    }
  });

type Params = z.infer<typeof zodSchema>;

const fileInputs: FileInputSpec[] = [
  {
    target: "flow_path",
    path: "${flow_path}",
    kind: "file",
    optional: true,
    unwrapWhenSet: "name",
  },
  {
    target: "flow_file",
    path: "${project_root}/.argent/flows/${name}.yaml",
    kind: "file",
    skipWhenSet: "flow_path",
  },
];

export type StepStatus = "pass" | "fail" | "skip" | "error";

export interface StepReport {
  index: number;
  kind: FlowStep["kind"];
  status: StepStatus;
  reason?: string;
  warning?: string;
  tool?: string;
  result?: unknown;
  outputHint?: string;
  args?: unknown;
  message?: string;
  /**
   * The fragment a step belongs to (set on `run` and the steps it expands) —
   * the target's basename stem; when that stem collides with the top-level
   * flow's name, the as-written path minus `.yaml` (`./<stem>` for a bare
   * spelling). Renderers distinguish fragment steps by this differing from the
   * report's `flow`, which the collision fallback guarantees: both
   * disambiguated shapes contain a `/`, which FLOW_NAME_PATTERN forbids.
   */
  flow?: string;
  target?: string;
  snapshotKey?: string;
  artifacts?: SnapshotArtifacts;
  scriptLog?: string;
  scriptLogTruncated?: boolean;
  /**
   * Nesting depth for display: omitted at top level, +1 inside each nesting
   * step's expanded steps. The report is a flat list with no block-end marker,
   * so renderers cannot reconstruct depth downstream.
   */
  depth?: number;
  /**
   * Set on every report of a `teardown` list: its steps, the `run:` and `when`
   * markers in it with everything they expand to, their skip reports, and a
   * fragment's teardown list inside the parent's steps. A renderer marks the
   * section with it, and a harness tells a cleanup failure from a step failure.
   */
  teardown?: true;
}

export interface FlowRunResult {
  flow: string;
  device: string;
  executionPrerequisite: string;
  ok: boolean;
  aborted?: boolean;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  steps: StepReport[];
}

export interface FlowPrerequisiteNotice {
  flow: string;
  notice: string;
  executionPrerequisite: string;
}

export const MAX_RUN_DEPTH = 20;

const POST_LAUNCH_SETTLE_MS = 1500;

/**
 * Flows resolve selectors against the native UIView tree, served over the
 * native-devtools connection the injected dylib opens asynchronously after
 * launch. `fetchFlowTree` treats a missing connection as a hard per-read error
 * (it never degrades to the collapsing AX tree — see flow-tree.ts), so without
 * this gate a slow cold start would fail the first directive with a raw
 * tree-source error instead of reporting it on the launch step.
 *
 * Deliberately the same constant as the budget the measurement allows a dial: a
 * gate that waited longer would time out onto `unregistered`, whose remedy is a
 * tool-server restart, for an app the state machine still considered worth
 * waiting for.
 *
 * Exported so the gate's reason text can be pinned against it.
 */
export const NATIVE_READY_TIMEOUT_MS = NATIVE_DEVTOOLS_CONNECT_BUDGET_MS;
const NATIVE_READY_POLL_MS = 250;

export const LAUNCH_TO_VERDICT_MS = POST_LAUNCH_SETTLE_MS + NATIVE_READY_TIMEOUT_MS;

/**
 * `tool:` steps that can change or relaunch the foreground app — running one
 * drops {@link ActionEnv.treeTarget} outright instead of keeping it as an
 * unpinned hint, since the launched app may no longer be on screen at all, and
 * spends {@link ActionEnv.treeOutage}. `button` is included for its `home` case;
 * distinguishing button kinds would couple this list to that tool's arg schema.
 *
 * `launch-app` and `restart-app` re-set the id from their own `bundleId` once
 * they return, as an unpinned hint — they name the app they switched to, where
 * the rest leave it unknown.
 */
const FOREGROUND_CHANGING_TOOLS = new Set([
  "launch-app",
  "restart-app",
  "reinstall-app",
  "open-url",
  "button",
]);

async function waitForNativeDevtools(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  let api: NativeDevtoolsApi;
  try {
    const ref = nativeDevtoolsRef(device);
    api = await registry.resolveService<NativeDevtoolsApi>(ref.urn, ref.options);
  } catch (err) {
    if (!isInjectableBundleId(bundleId)) return null;
    return `the native-devtools service is unavailable for ${bundleId} (${errMsg(err)})`;
  }
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return null;
    if (api.isConnected(bundleId)) return null;
    if (Date.now() >= deadline) break;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return null;
  }
  // Timed out with no connection. An app the native tools refuse to target has
  // no hierarchy to wait for, so that is its expected outcome rather than a
  // launch failure; the refusal bites only where a selector needs the hierarchy,
  // and `fetchFlowTree` reports it there.
  //
  // The wait itself still runs, deliberately: whether the dylib loads into a
  // simulator system app is unsettled (#453 saw `connected: false` for
  // com.apple.Preferences on iOS 26.5, an E2E run `connected: true` on 18.5).
  // Only the VERDICT is withheld — before a measurement no arm below would
  // consult for such an app, costing several uninterruptible simctl round-trips.
  if (!isInjectableBundleId(bundleId)) return null;
  const state = await api.appConnectionState(bundleId).catch(() => "indeterminate" as const);
  if (state === "connected") return null;
  return flowLaunchGateReason(bundleId, state);
}

export function flowLaunchGateReason(
  bundleId: string,
  state: Exclude<NativeDevtoolsAppState, "connected">
): string {
  const measured = buildAppStateMessage(bundleId, state);
  switch (state) {
    case "not_running":
      return (
        `${bundleId} was relaunched by this step and is no longer running ${LAUNCH_TO_VERDICT_MS} ms later, ` +
        `so it exited after launch rather than failing to connect. Re-running the flow repeats the same launch: ` +
        `start it by hand (launch-app, then describe or screenshot) to see the crash or early exit first.`
      );
    case "stale_process":
      // The first sentence must not pick between the state's two producers: a
      // process carrying no argent injection at all, or one carrying THIS
      // endpoint and merely older than the listener — the measured text names
      // both, and blaming the launchd environment would be false for the second.
      // The environment IS right on a SECOND landing: a re-run's process is
      // younger than any long-up listener, which rules that producer out (it
      // needs `processAge + grace >= listenerAge`).
      return (
        `${measured} This step already relaunched it, so the process it measured predates whatever the ` +
        `relaunch would have given it — re-run the flow to launch again. If it lands here twice, the ` +
        `simulator's launchd environment is not holding argent's instrumentation: re-boot the device ` +
        `(boot-device with force) before re-running.`
      );
    case "unregistered":
      return (
        `${measured} A cold start slower than the ${LAUNCH_TO_VERDICT_MS} ms this step waited reads the ` +
        `same way — if that is likely, re-run the flow to relaunch and wait again before restarting anything.`
      );
    case "connecting":
      return (
        `${measured} This step launched it ${LAUNCH_TO_VERDICT_MS} ms before that reading, so the process ` +
        `being measured started after the step's own launch — something relaunched it in between. Re-run ` +
        `the flow once the app is settled.`
      );
    case "indeterminate":
      return (
        `${measured} This step already performed that one restart, so re-run the flow at most once more ` +
        `before restarting the tool-server rather than the app.`
      );
    case "provider_attached":
      return (
        `${measured} This step already waited ${LAUNCH_TO_VERDICT_MS} ms after launching it, so the ` +
        `provider is lending a different app rather than one still connecting. Re-run the flow only ` +
        `once it is lending this one; otherwise drive the app by coordinate.`
      );
  }
}

/**
 * Poll until the Vega automation toolkit — the only tree source on Vega —
 * serves a page source. Like iOS's injected dylib it attaches asynchronously at
 * app launch, and `describeVega` degrades to an empty tree + relaunch hint until
 * it does; gating the launch keeps that window from eating the first directive's
 * auto-wait (or silently confirming a `hidden` assert against a blind read).
 */
async function waitForVegaAutomation(device: DeviceInfo, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + NATIVE_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    try {
      const data = await describeVega(device.id);
      if (!data.hint) return true;
    } catch {
      // transient adb/forward failure mid-boot — retry until the deadline
    }
    if (Date.now() >= deadline) return false;
    if (!(await sleepOrAbort(NATIVE_READY_POLL_MS, signal))) return false;
  }
}

/**
 * Probe whether the android-devtools helper — the full-hierarchy source flows
 * resolve testIDs against (`flow-android-tree.ts`) — is usable.
 *
 * Unlike iOS's native-devtools (a connection the injected dylib opens
 * asynchronously *after* launch), the Android helper is a separate
 * `am instrument` process the registry spawns synchronously on first
 * `resolveService`: one resolution either brings it up (install + spawn + ping
 * handshake in the factory) or it can't run on this device. Hence a one-shot
 * probe, not a poll.
 */
async function androidDevtoolsReady(registry: Registry, device: DeviceInfo): Promise<boolean> {
  try {
    const ref = androidDevtoolsRef(device);
    const api = await registry.resolveService<AndroidDevtoolsApi>(ref.urn, ref.options);
    return api.isReady();
  } catch {
    return false;
  }
}

async function treeSourceGate(
  registry: Registry,
  device: DeviceInfo,
  bundleId: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (isIosPhysicalDevice(device) && !signal?.aborted) {
    try {
      const ref = iosDeviceRunnerRef(device);
      await registry.resolveService(ref.urn, ref.options);
      return null;
    } catch (err) {
      return (
        `the on-device XCUITest runner did not become ready for ${device.id}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (device.platform === "ios" && !signal?.aborted) {
    const reason = await waitForNativeDevtools(registry, device, bundleId, signal);
    if (reason !== null && !signal?.aborted) {
      return `could not connect to native devtools. ${reason}`;
    }
  }
  if (device.platform === "android" && !signal?.aborted) {
    const ready = await androidDevtoolsReady(registry, device);
    if (!ready && !signal?.aborted) {
      return (
        `could not reach the Android devtools helper (full-hierarchy source for testID selectors). ` +
        `Confirm the device is unlocked and the argent helper can be installed (\`adb install -t\`); a locked device or a blocked install is the usual cause. Re-run once resolved.`
      );
    }
  }
  if (device.platform === "vega" && !signal?.aborted) {
    const ready = await waitForVegaAutomation(device, signal);
    if (!ready && !signal?.aborted) {
      return (
        `the Vega automation toolkit never served a page source for ${bundleId} (the flow tree source). ` +
        `The toolkit attaches at app launch — re-run to relaunch; if it keeps failing, confirm the app was built with automation support and the VVD is reachable over adb.`
      );
    }
  }
  return null;
}

async function runLaunch(
  state: ExecState,
  app: Launch,
  teardown: boolean
): Promise<DirectiveOutcome> {
  const env = deviceEnv(state);
  const { registry, device, signal } = env;

  if (state.treeOutage) state.treeOutage.proven = undefined;

  if (device.platform === "chromium") return runChromiumLaunch(state, app, teardown);

  const bundleId = appIdForPlatform(app, device.platform);
  if (!bundleId) {
    return {
      ok: false,
      reason: `no app id declared for platform "${device.platform}" — add a launch entry for it`,
    };
  }
  state.treeTarget = undefined;
  let restart: unknown;
  try {
    restart = await invokeOnDevice(env, "restart-app", { bundleId });
  } catch (err) {
    if (signal?.aborted) return ABORTED_OUTCOME;
    return { ok: false, reason: `restart-app failed: ${errMsg(err)}` };
  }
  // A blocked precheck is RESOLVED rather than thrown, and returns before the
  // terminate and the launch — so the app was never started. Every remedy below
  // is written for one this step did launch: unread, the gate measures an app
  // that never ran and `not_running` becomes "it exited after launch".
  if (isNativeDevtoolsBlockResult("restart-app", restart)) {
    return { ok: false, reason: `restart-app did not start ${bundleId}: ${restart.message}` };
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const gate = await treeSourceGate(registry, device, bundleId, signal);
  if (signal?.aborted) return ABORTED_OUTCOME;
  if (gate) return { ok: false, reason: gate };
  // A FRESH object every time, never a mutation of the previous target: the
  // app just cold-started, so a re-pin has to re-arm `probeAnswered`.
  state.treeTarget = { bundleId, pinned: true, probeAnswered: false };
  return { ok: true };
}

/**
 * Execute a `launch` step on a Chromium device. A chromium "device" IS the
 * booted process (its id is the CDP port), so there is no in-place relaunch:
 * only the run's FIRST launch can be satisfied without booting — settling the
 * boot {@link resolveRunDevice} hoisted, or attaching to an instance the runner
 * does not own. Later launches boot their own ({@link bootChromiumForLaunch}).
 * So does a first launch that finds the hoisted instance used or replaced by a
 * fragment's teardown list ({@link ExecState.hoisted}).
 *
 * A teardown launch always boots, and leaves the first launch to the steps.
 * Whether the steps reached their leading launch depends on where they
 * stopped, and a cleanup step that settles for the hoisted instance or attaches
 * to a pinned one would act on a different app after an early failure than
 * after a pass.
 */
async function runChromiumLaunch(
  state: ExecState,
  app: Launch,
  teardown: boolean
): Promise<DirectiveOutcome> {
  const { registry, device, signal } = deviceEnv(state);

  if (state.chromiumLaunched || teardown) return bootChromiumForLaunch(state, app);
  state.chromiumLaunched = true;

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(device) };

  const owned = ownedInstance(state);
  if (owned) {
    if (owned !== state.hoisted) return bootChromiumForLaunch(state, app);
    const declared = await resolveAppPath(spec.path, state.flowsDir);
    if (declared !== owned.appPath) {
      return {
        ok: false,
        reason: `launch declares "${declared}" but the instance booted for this run is "${owned.appPath}" — the flow file changed after the run started`,
      };
    }
    if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
    return { ok: true, reason: `booted chromium instance ${device.id}` };
  }
  // Attach over CDP, not via `launch-app`: a chromium launch value is an app
  // path, which launch-app's bundleId grammar rejects.
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.refreshViewport();
  } catch (err) {
    return {
      ok: false,
      reason: `could not attach to chromium instance "${device.id}": ${errMsg(err)}`,
    };
  }
  state.attachedAppPath = await resolveAppPath(spec.path, state.flowsDir);
  for (const [key, appId] of state.snapshotApps) {
    if (appId === `attached:${device.id}`) state.snapshotApps.set(key, state.attachedAppPath);
  }
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  return { ok: true };
}

/**
 * Boot a fresh Chromium instance for a `launch` step and move the run onto it —
 * steps read `state.device` per call, so reassigning it is all the plumbing a
 * new id needs. An instance of the same app that this run owns is killed first:
 * an Electron app holding a single-instance lock makes the second process quit
 * on startup, so its CDP endpoint would never come up. Instances the run does
 * not own are never killed.
 */
async function bootChromiumForLaunch(state: ExecState, app: Launch): Promise<DirectiveOutcome> {
  const { registry, device, signal } = deviceEnv(state);

  const spec = chromiumLaunchSpec(app);
  if (!spec) return { ok: false, reason: noChromiumAppReason(device) };
  const appPath = await resolveAppPath(spec.path, state.flowsDir);
  const prevId = device.id;

  // Path equality, so two app directories shipping one Electron `name` (a v1/v2
  // build pair) are not recognized as one app: the first stays alive, its lock
  // quits this boot, and the failure lands on {@link singleInstanceLockHint} —
  // which is why that hint has to name the instances this run owns.
  const retiring = state.owned.findIndex((o) => o.appPath === appPath);
  let retiredId: string | undefined;
  if (retiring !== -1) {
    const [prev] = state.owned.splice(retiring, 1);
    retiredId = prev!.deviceId;
    await teardownBootedChromium(registry, prev!);
  }

  let booted: BootedChromium;
  try {
    booted = await bootChromiumForFlow(spec, state.flowsDir, state.viaUpload);
  } catch (err) {
    return { ok: false, reason: await chromiumBootFailureReason(state, err) };
  }
  state.owned.push(booted);
  state.device = resolveDevice(booted.deviceId);

  await frontChromiumPage(registry, state.device);
  if (!(await sleepOrAbort(POST_LAUNCH_SETTLE_MS, signal))) return ABORTED_OUTCOME;
  const move =
    retiredId === prevId ? `retired ${prevId} (same app relaunched)` : `run moved off ${prevId}`;
  const alsoRetired =
    retiredId !== undefined && retiredId !== prevId
      ? `, retired ${retiredId} (same app relaunched)`
      : "";
  return {
    ok: true,
    reason: `booted chromium instance ${booted.deviceId} — ${move}${alsoRetired}`,
  };
}

const LOCK_SUSPECT_PROBE_TIMEOUT_MS = 800;

/**
 * The signal of a boot failure the underlying error cannot explain: an Electron
 * process that exits CLEANLY (code 0) before its CDP endpoint comes up — the
 * signature of a second copy quitting against an already-running instance's
 * single-instance lock. Null for every other failure, since a crash, missing
 * path, or spawn failure speaks for itself and a lock hint there would blame
 * the wrong app. The signal itself is returned, not a boolean, because the
 * hoist rethrows under it ({@link hoistedBootFailure}) and the reworded error
 * has to keep the `error_code` and exit-code metadata.
 */
function singleInstanceLockSignal(err: unknown): FailureSignal | null {
  const signal = getFailureSignal(err);
  if (
    signal?.error_code !== FAILURE_CODES.CHROMIUM_ELECTRON_EXITED_BEFORE_READY ||
    signal.failure_exit_code !== 0
  ) {
    return null;
  }
  return signal;
}

interface LockSuspects {
  attached: string | null;
  owned: BootedChromium[];
}

const NO_LOCK_SUSPECTS: LockSuspects = Object.freeze({ attached: null, owned: [] });

function singleInstanceLockHint(suspects: LockSuspects): string {
  const clauses: string[] = [];
  if (suspects.attached) {
    clauses.push(
      `${suspects.attached} is running and this run does not own it; if it is this same app, it holds that lock.`
    );
  }
  if (suspects.owned.length > 0) {
    const owned = suspects.owned.map((o) => `${o.deviceId} (${o.appPath})`).join(", ");
    clauses.push(
      `This run booted ${owned}, alive until run end — an app path that shares an Electron \`name\` with this one shares its lock. That holder is the runner's own, so closing it is not on offer and a rerun fails identically; launch them in separate runs, or give this launch its own \`--user-data-dir\` in \`args\`.`
    );
  }
  if (clauses.length === 0)
    clauses.push(`If a copy of this app is already running, close it and rerun.`);
  return `A clean exit before CDP comes up is the signature of a single-instance lock — an already-running copy of the app quits the new one at startup. ${clauses.join(" ")}`;
}

async function chromiumBootFailureReason(state: ExecState, err: unknown): Promise<string> {
  const base = `could not boot the chromium app: ${errMsg(err)}`;
  if (!singleInstanceLockSignal(err)) return base;
  return `${base} ${singleInstanceLockHint(await liveLockSuspects(state))}`;
}

async function liveLockSuspects(state: ExecState): Promise<LockSuspects> {
  const [attached, owned] = await Promise.all([
    liveAttachedInstance(state),
    liveOwnedInstances(state),
  ]);
  return { attached, owned };
}

async function liveAttachedInstance(state: ExecState): Promise<string | null> {
  const id = state.attachedDeviceId;
  if (id === undefined) return null;
  const port = parseChromiumCdpPort(id);
  if (port === null) return null;
  return (await answersCdp(port)) ? id : null;
}

async function liveOwnedInstances(state: ExecState): Promise<BootedChromium[]> {
  const alive = await Promise.all(state.owned.map((o) => answersCdp(o.port)));
  return state.owned.filter((_, i) => alive[i]);
}

async function answersCdp(port: number): Promise<boolean> {
  try {
    await ensureCdpReachable(port, AbortSignal.timeout(LOCK_SUSPECT_PROBE_TIMEOUT_MS));
    return true;
  } catch {
    return false;
  }
}

function ownedInstance(state: ExecState): BootedChromium | undefined {
  return state.owned.find((o) => o.deviceId === state.device?.id);
}

/**
 * App identity a snapshot capture is attributed to: the canonical app path of
 * the owned instance the run sits on, else the path the attaching launch
 * declared for the un-owned instance, else that instance's device id. The
 * declared path is trusted — the guard is best-effort collision detection, not
 * attestation — so an attach and a later boot of the same app spell one
 * identity. On ios/android the device never moves mid-run, so the guard stays
 * chromium-scoped in effect.
 */
function snapshotAppIdentity(state: ExecState): string {
  return (
    ownedInstance(state)?.appPath ??
    state.attachedAppPath ??
    `attached:${deviceEnv(state).device.id}`
  );
}

function noChromiumAppReason(device: DeviceInfo): string {
  return `no chromium app declared — the run is on ${device.id}; add a \`chromium:\` entry to this launch`;
}

interface ExecState extends Omit<ActionEnv, "device"> {
  device: DeviceInfo | null;
  deviceIsExplicit: boolean;
  flowsDir: string;
  viaUpload: boolean;
  baselineKey: string;
  updateBaselines: boolean;
  reports: StepReport[];
  stopped: boolean;
  pinned: boolean;
  owned: BootedChromium[];
  /**
   * The instance {@link resolveRunDevice} booted for the leading launch, while
   * it is still fresh. Only `echo` and `script` steps precede that launch in the
   * steps, but a fragment's teardown list can run any step before it. A teardown
   * step on this instance clears the field ({@link noteTeardownUse}), and a
   * teardown relaunch of its app replaces the instance, so the first launch then
   * boots a new one.
   */
  hoisted?: BootedChromium;
  chromiumLaunched: boolean;
  snapshotApps: Map<string, string>;
  attachedDeviceId?: string;
  attachedAppPath?: string;
  projectRoot: string;
  scriptLogBudget: FlowScriptLogBudget;
  runtimeEnv: Readonly<ScriptEnv>;
  scriptRunNotes: FlowScriptRunNotes;
  /**
   * The run's output document. It lives on the ROOT state, which a `run:`
   * fragment and a `when` block share, so a nested scope keeps what its scripts
   * merged when it ends — an environment is scoped instead, and ends with its
   * scope. Replaced on every merge and never mutated. Read here, never off an
   * `ActionEnv`: {@link deviceEnv} hands each device step a shallow copy, which
   * a later merge would not reach.
   */
  output: Record<string, unknown>;
  onStepReport?: (report: StepReport) => void;
}

function deviceEnv(state: ExecState): ActionEnv {
  if (!state.device) {
    throw new Error("internal: a step that acts on a device ran in a flow resolved as device-free");
  }
  return { ...state, device: state.device };
}

interface BootedChromium {
  deviceId: string;
  port: number;
  pid: number;
  appPath: string;
}

function displayFlowName(params: { name?: string; flow_path?: string }): string {
  const stem =
    params.flow_path === undefined ? undefined : path.basename(params.flow_path, ".yaml");
  return params.name || stem || params.flow_path || "(unspecified)";
}

function* walkSteps(
  steps: FlowStep[],
  within = "",
  label = "step"
): Generator<{ step: FlowStep; where: string }> {
  for (const [i, step] of steps.entries()) {
    const where = `${label} ${i + 1}${within}`;
    yield { step, where };
    const inner = blockSteps(step);
    if (inner) yield* walkSteps(inner, ` of the ${step.kind}: block at ${where}`, label);
  }
}

/** Every step of a flow file, the teardown list's after the steps. */
function* walkFlow(flow: FlowFile): Generator<{ step: FlowStep; where: string }> {
  yield* walkSteps(flow.steps);
  if (flow.teardown) yield* walkSteps(flow.teardown, "", "teardown step");
}

interface RetiredArgUse {
  where: string;
  tool: string;
  key: string;
  guidance: string;
}

/**
 * The guidance a schema property carries if - and only if - it is a RETIRED
 * field, else undefined (an empty string is retired with no guidance).
 *
 * A retired field is declared `z.never().optional()`, which serializes to a
 * `not: {}` with no `type`. Matched by SHAPE and never by field name, so a key
 * retired on any tool later is refused with no edit here - the same test
 * `isRetiredField` applies on the CLI's flag paths.
 */
function retiredKeyGuidance(prop: unknown): string | undefined {
  const schema = prop as { not?: Record<string, unknown>; description?: string } | undefined;
  if (!schema?.not || Object.keys(schema.not).length > 0) return undefined;
  return (schema.description ?? "").replace(/^Retired:\s*/, "");
}

function toolArgProps(registry: Registry, tool: string): Record<string, unknown> | undefined {
  return (
    registry.getTool(tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined
  )?.properties;
}

function retiredArgIn(
  props: Record<string, unknown>,
  tool: string,
  args: Record<string, unknown>,
  where: string
): RetiredArgUse | undefined {
  for (const key of Object.keys(args)) {
    const guidance = retiredKeyGuidance(props[key]);
    if (guidance !== undefined) return { where, tool, key, guidance };
  }
  return undefined;
}

/**
 * The tool invocations a `tool:` step's args carry inline, each with the
 * position naming it. Matched by SHAPE - a `{ tool, args }` entry, in an arg's
 * array (run-sequence's `steps`) or as an arg itself - never by the carrying
 * tool's name.
 *
 * Only under a key the carrying tool DECLARES: a non-strict schema strips an
 * undeclared key before execute, so the invocation it looks like is never made
 * and refusing the flow over it would refuse a call that never happens.
 *
 * One level only: those args are forwarded verbatim to the named tool, and no
 * tool that batches others allows a batching tool among them.
 */
function* nestedInvocations(
  props: Record<string, unknown>,
  args: Record<string, unknown>
): Generator<{ tool: string; args: Record<string, unknown>; at: string }> {
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const [i, entry] of entries.entries()) {
      const call = entry as { tool?: unknown; args?: unknown } | null | undefined;
      if (typeof call?.tool !== "string") continue;
      if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) continue;
      yield {
        tool: call.tool,
        args: call.args as Record<string, unknown>,
        at: Array.isArray(value) ? `step ${i + 1}` : `\`${key}\``,
      };
    }
  }
}

function findRetiredToolArg(registry: Registry, flow: FlowFile): RetiredArgUse | undefined {
  for (const { step, where } of walkFlow(flow)) {
    if (step.kind !== "tool") continue;
    const props = toolArgProps(registry, step.name);
    if (!props) continue;
    const direct = retiredArgIn(props, step.name, step.args, where);
    if (direct) return direct;
    for (const call of nestedInvocations(props, step.args)) {
      const nestedProps = toolArgProps(registry, call.tool);
      if (!nestedProps) continue;
      const hit = retiredArgIn(
        nestedProps,
        call.tool,
        call.args,
        `${call.at} of the ${step.name} step at ${where}`
      );
      if (hit) return hit;
    }
  }
  return undefined;
}

function retiredArgReason(use: RetiredArgUse): string {
  return `${use.where} as written (echo included) passes ${use.tool}'s retired \`${use.key}\` key${use.guidance ? `: ${use.guidance}` : ""}`;
}

/**
 * Reject an uploaded root flow that is not self-contained — one with a `run:`,
 * `script:` or `snapshot` step at any depth — before anything executes, so a
 * mid-run or guard-gated error cannot execute half the flow first. All three
 * anchor at the flow file's real directory, which an uploaded flow does not
 * have: a run: step's referenced files stayed on the client, a script step's
 * own file (and whatever it imports) stayed there too, and against a per-call temp
 * materialization a plain snapshot can only fail (no baseline) while
 * updateBaselines writes PNGs no later run can find.
 */
function assertUploadSelfContained(flow: FlowFile): void {
  for (const { step } of walkFlow(flow)) {
    if (step.kind === "run") {
      throw new FailureError(
        `This flow uses run: composition ("run: ${step.flow}"), which requires a co-located ` +
          `client and tool server — an uploaded flow's referenced files are not available on ` +
          `this host.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_run_composition",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (step.kind === "script") {
      throw new FailureError(
        `This flow uses a script step ("script: { path: ${step.path} }"), whose script file lives ` +
          `beside the flow's file on the CLIENT — an uploaded flow carries only its own YAML, so ` +
          `the script is not on this host and never could be. Use name + project_root with a ` +
          `co-located client and tool server for flows that run scripts.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_script_step",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (step.kind === "snapshot") {
      throw new FailureError(
        `This flow uses a snapshot step ("snapshot: ${step.name}"), whose baselines live ` +
          `beside the flow's file — an uploaded flow materializes to a fresh temp directory ` +
          `each call, so a plain snapshot can never find a baseline and updateBaselines ` +
          `(--update-baselines) writes PNGs no later run can read. Use name + project_root ` +
          `with a co-located client and tool server for snapshot flows.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_upload_snapshot_baseline",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
  }
}

export function createRunFlowTool(
  registry: Registry
): ToolDefinition<Params, FlowRunResult | FlowPrerequisiteNotice> {
  return {
    id: "flow-execute",
    interaction: {
      startedMsg: ({ params }) => `Running flow ${displayFlowName(params)}`,
      completedMsg: ({ params }) => `Ran flow ${displayFlowName(params)}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to run flow ${displayFlowName(params)}: ${failureSignal.error_code}`,
    },
    description: `Run a saved YAML flow end to end. Use when
asked to replay a recorded path, re-run a QA regression, or check that a known journey still passes; for a
one-off interaction use the gesture tools instead, and to author a flow use flow-start-recording. Pass
exactly one flow source: name (under project_root) or flow_path.
Returns a per-step report: the first failure stops the run and the rest report as skipped, but the flow's teardown list still runs unless the run was cancelled.`,
    longRunning: true,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx?: ToolContext) {
      const envProblem = describeScriptEnvProblem(params.env ?? {});
      if (envProblem) {
        throw new InvalidToolInputError(`This run's \`env\` ${envProblem}`, {
          failure_stage: "flow_run_env",
        });
      }
      try {
        assertNoEnvOutputReferences(params.env, "This run's");
      } catch (err) {
        throw new InvalidToolInputError(err instanceof Error ? err.message : String(err), {
          failure_stage: "flow_run_env",
        });
      }
      if (params.env && Object.keys(params.env).length > 0) {
        try {
          resolveScriptEnvSecrets(params.env, { cwd: params.project_root });
        } catch (err) {
          throw new InvalidToolInputError(
            `This run's ${err instanceof Error ? err.message : String(err)}`,
            { failure_stage: "flow_run_env" }
          );
        }
      }
      const signal = ctx?.signal;
      const { filePath, flowName, viaUpload } = await resolveFlowSource(
        params,
        ctx?.fileInputs?.flow_file,
        ctx?.fileInputs?.flow_path
      );
      const canonicalPath = await canonicalFlowPath(filePath);
      const flowsDir = path.dirname(canonicalPath);
      const flow = parseFlow(await fs.readFile(canonicalPath, "utf8"));
      if (viaUpload) assertUploadSelfContained(flow);
      const retiredArg = findRetiredToolArg(registry, flow);
      if (retiredArg) {
        throw new FailureError(`Flow "${flowName}" ${retiredArgReason(retiredArg)}`, {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_run_validate",
          failure_area: "tool_server",
          error_kind: "validation",
        });
      }
      const rootEntry: RunStackEntry = { canonical: canonicalPath, display: flowName };
      const rootScope: StepScope = { runStack: [rootEntry], depth: 0, env: flow.env ?? {} };
      const secretCheck: TeardownSecretCheck = {
        projectRoot: params.project_root,
        runtimeEnv: params.env ?? {},
      };

      // Here, before the prerequisite notice and before anything that boots or
      // pins: a refusal after `resolveRunDevice` would leave its effects in
      // place, since only the `finally` below undoes them.
      const secretProblem = await teardownSecretProblem(secretCheck, flow.teardown, rootScope);
      if (secretProblem) {
        throw new InvalidToolInputError(
          `Flow "${flowName}" was not run: ${teardownSecretRefusal(secretProblem)}`,
          {
            error_code: FAILURE_CODES.SECRET_PLACEHOLDER_UNKNOWN,
            failure_stage: "flow_run_teardown_secrets",
          }
        );
      }

      if (flow.executionPrerequisite && !pinnedToChromium(params.device)) {
        const leading = await leadingLaunch(flow, [rootEntry]);
        if (leading) {
          const pinRemedy = chromiumPinnable(leading.app, params.platform)
            ? ` Or pin the run to a chromium instance you have already brought to that state (--device chromium-cdp-<port>), where the leading launch only attaches.`
            : "";
          throw new FailureError(
            `A flow whose leading run: chain reaches a launch step must not declare executionPrerequisite — it launches its own app and controls its start state. Drop the leading launch in "${leading.flow}" to make it a fragment, or drop executionPrerequisite from "${flowName}".${pinRemedy}`,
            {
              error_code: FAILURE_CODES.FLOW_E2E_HAS_PREREQUISITE,
              failure_stage: "flow_run_validate",
              failure_area: "tool_server",
              error_kind: "validation",
            }
          );
        }
      }

      if (flow.executionPrerequisite && !params.prerequisiteAcknowledged) {
        return {
          flow: flowName,
          notice:
            "This flow has an execution prerequisite that must be fulfilled before it can run. " +
            "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true.",
          executionPrerequisite: flow.executionPrerequisite,
        };
      }

      const resolved = await resolveRunDevice(
        registry,
        ctx,
        flow,
        params,
        flowsDir,
        rootEntry,
        viaUpload
      );
      const device = resolved.device;

      const statusBarPinned = device !== null && (await pinStatusBar(device));

      // The chromium equivalent: front the page so a backgrounded window doesn't
      // throttle rendering — wheel-event acks (scroll steps) stall on a throttled
      // compositor. Covers the instance the run starts on; a launch that boots
      // one fronts it itself. Best-effort: whether bringToFront un-minimizes is
      // runtime-dependent (measured: Chrome restores the window and unthrottles
      // input, Electron leaves it minimized and hidden). Resolving the session
      // applies focus emulation, which keeps input unthrottled even while
      // minimized, and gesture-tap/-drag/-scroll carry
      // assertChromiumWindowVisible for sessions where it could not apply.
      if (device?.platform === "chromium") await frontChromiumPage(registry, device);

      const state: ExecState = {
        registry,
        ctx,
        device,
        deviceIsExplicit: Boolean(params.device),
        signal,
        treeOutage: {},
        flowsDir,
        viaUpload,
        baselineKey: baselineKeyFor(canonicalPath, flowName),
        updateBaselines: Boolean(params.updateBaselines),
        reports: [],
        stopped: false,
        pinned: statusBarPinned,
        owned: resolved.booted ? [resolved.booted] : [],
        ...(resolved.booted ? { hoisted: resolved.booted } : {}),
        chromiumLaunched: false,
        snapshotApps: new Map(),
        projectRoot: params.project_root,
        scriptLogBudget: createScriptLogBudget(),
        runtimeEnv: params.env ?? {},
        scriptRunNotes: createScriptRunNotes(),
        output: {},
        ...(!resolved.booted && device?.platform === "chromium"
          ? { attachedDeviceId: device.id }
          : {}),
        ...(ctx?.emitProgress ? { onStepReport: ctx.emitProgress } : {}),
      };

      let aborted: boolean;
      try {
        // The teardown list runs inside this `try`, so a device teardown step
        // still has the status bar and the chromium instances the `finally`
        // below takes away. In a `finally` of its own, because a throw out of
        // the steps is a flow error, not a cancel: the teardown still runs,
        // and the throw leaves after it.
        try {
          await execSteps(state, flow.steps, rootScope);
        } finally {
          await execTeardown(state, flow.teardown, rootScope);
        }
      } finally {
        // Sampled after the teardown list, so a cancel during that list fails
        // the run as a cancel during the steps does. A client disconnect during
        // the status-bar restore or the chromium shutdown below lands after
        // every step ran, and must not flip a finished run to FAIL.
        aborted = state.signal?.aborted === true;
        if (state.pinned && device) await restoreStatusBar(device);
        for (let i = state.owned.length - 1; i >= 0; i--) {
          await teardownBootedChromium(registry, state.owned[i]!);
        }
      }

      return summarize(
        flowName,
        device?.id ?? "",
        flow.executionPrerequisite,
        state.reports,
        aborted
      );
    },
  };
}

async function resolveRunDevice(
  registry: Registry,
  ctx: ToolContext | undefined,
  flow: FlowFile,
  params: Params,
  flowDir: string,
  rootEntry: RunStackEntry,
  viaUpload: boolean
): Promise<{ device: DeviceInfo | null; booted: BootedChromium | null }> {
  if (!params.device) {
    const leading = await leadingLaunch(flow, [rootEntry]);
    const spec = leading && chromiumBootSpec(leading.app, params.platform);
    if (spec) {
      let booted: BootedChromium;
      try {
        booted = await bootChromiumForFlow(spec, flowDir, viaUpload);
      } catch (err) {
        throw hoistedBootFailure(err);
      }
      return { device: resolveDevice(booted.deviceId), booted };
    }
    if (!flowRequiresDevice(registry, stepsAndTeardown(flow))) {
      if (!flowScopesDevice(registry, stepsAndTeardown(flow)))
        return { device: null, booted: null };
      // A flow that only SCOPES to a device (a cleanup flow) takes one when one
      // is unambiguous, so the teardown stays narrowed to the run device and
      // cannot reap what another agent is mid-session on. When resolution has
      // no single answer — nothing booted, or several — run it unscoped rather
      // than failing the flow.
      //
      // Swallowed only for THAT answer. `resolveFlowDevice` also reaches
      // `list-devices` through the registry, so a bare catch would absorb an
      // adb/simctl failure, a dead sub-tool, an abort — and the teardown step
      // would then run unscoped and report pass, the machine-wide sweep this
      // path exists to avoid.
      try {
        return {
          device: await resolveFlowDevice(registry, ctx, resolveOpts(params)),
          booted: null,
        };
      } catch (err) {
        if (getFailureSignal(err)?.error_code !== FAILURE_CODES.FLOW_DEVICE_RESOLUTION) throw err;
        return { device: null, booted: null };
      }
    }
  }
  const device = await resolveFlowDevice(registry, ctx, resolveOpts(params));
  return { device, booted: null };
}

function resolveOpts(params: Params): { device?: string; platform?: FlowPlatform } {
  return { device: params.device, platform: params.platform as FlowPlatform | undefined };
}

function hoistedBootFailure(err: unknown): unknown {
  const signal = singleInstanceLockSignal(err);
  if (!signal) return err;
  return wrapFailure(err, signal, `${errMsg(err)} ${singleInstanceLockHint(NO_LOCK_SUSPECTS)}`);
}

function pinnedToChromium(device: string | undefined): boolean {
  return device !== undefined && resolveDevice(device).platform === "chromium";
}

function chromiumPinnable(app: Launch, platform: string | undefined): boolean {
  if (typeof app === "string") return platform === "chromium";
  return chromiumLaunchSpec(app) !== null;
}

const NO_EXECUTABLE_STEP = "no-executable-step";

async function leadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | null> {
  const found = await scanLeadingLaunch(flow, stack);
  return found === NO_EXECUTABLE_STEP ? null : found;
}

async function scanLeadingLaunch(
  flow: FlowFile,
  stack: RunStackEntry[]
): Promise<{ app: Launch; flow: string } | typeof NO_EXECUTABLE_STEP | null> {
  const top = stack[stack.length - 1]!;
  for (const step of flow.steps) {
    if (precedesLeadingLaunch(step)) continue;
    if (step.kind === "launch") return { app: step.app, flow: top.display };
    if (step.kind !== "run") return null;
    let nested: FlowFile;
    let canonical: string;
    try {
      const hop = await resolveFlowRelativeFile(
        path.dirname(top.canonical),
        step.flow,
        FLOW_FILE_NAME_PATTERN
      );
      canonical = hop.canonical;
      if (stack.some((entry) => entry.canonical === canonical)) return null;
      if (stack.length >= MAX_RUN_DEPTH) return null;
      if (hop.spelling.state === "case_folded") return null;
      nested = parseFlow(await fs.readFile(canonical, "utf8"));
    } catch {
      return null;
    }
    const inner = await scanLeadingLaunch(nested, [
      ...stack,
      { canonical, display: runDisplayFor(step.flow, stack[0]!.display) },
    ]);
    if (inner !== NO_EXECUTABLE_STEP) return inner;
  }
  return NO_EXECUTABLE_STEP;
}

function chromiumBootSpec(
  app: Launch,
  platform: string | undefined
): { path: string; args?: string[] } | null {
  if (launchTargetPlatform(app, platform) !== "chromium") return null;
  return chromiumLaunchSpec(app);
}

function launchTargetPlatform(launch: Launch, platform: string | undefined): string | null {
  if (platform) return platform;
  if (typeof launch === "object") {
    const keys = Object.keys(launch);
    if (keys.length === 1) return keys[0]!;
  }
  return null;
}

async function resolveAppPath(specPath: string, flowDir: string): Promise<string> {
  const lexical = path.resolve(flowDir, specPath);
  try {
    return await fs.realpath(lexical);
  } catch {
    return lexical;
  }
}

async function bootChromiumForFlow(
  spec: { path: string; args?: string[] },
  flowDir: string,
  viaUpload: boolean
): Promise<BootedChromium> {
  if (viaUpload && !path.isAbsolute(spec.path)) {
    throw new FailureError(
      `A relative chromium app path ("${spec.path}") resolves against the flow file's ` +
        `directory, which requires a co-located client and tool server — an uploaded flow ` +
        `has no real flow directory on this host. Use an absolute tool-server path instead.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_upload_chromium_app_path",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const appPath = await resolveAppPath(spec.path, flowDir);
  const res = await bootElectronApp({ appPath, extraArgs: spec.args });
  return { deviceId: res.id, port: res.port, pid: res.pid, appPath: res.appPath };
}

async function teardownBootedChromium(registry: Registry, booted: BootedChromium): Promise<void> {
  const urn = `${CHROMIUM_CDP_NAMESPACE}:${booted.deviceId}`;
  try {
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
  } catch {
    /* the kill below frees the real resource regardless */
  }
  try {
    await killChromiumByPortAndWait(booted.port, booted.pid);
    untrackChromiumPort(booted.port);
  } catch {
    /* one unreachable instance must not strand the others */
  }
}

async function frontChromiumPage(registry: Registry, device: DeviceInfo): Promise<void> {
  try {
    const ref = chromiumCdpRef(device);
    const api = await registry.resolveService<ChromiumCdpApi>(ref.urn, ref.options);
    await api.cdp.send("Page.bringToFront");
  } catch {
    /* focus is best-effort */
  }
}

function summarize(
  flowName: string,
  deviceId: string,
  executionPrerequisite: string,
  steps: StepReport[],
  aborted: boolean
): FlowRunResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  for (const s of steps) {
    // Narration goes uncounted, unless it could not be printed: an echo whose
    // reference did not resolve stopped the run, and must not leave it PASS.
    if (s.kind === "echo" && s.status !== "error") continue;
    if (s.status === "pass") passed++;
    else if (s.status === "fail") failed++;
    else if (s.status === "skip") skipped++;
    else errored++;
  }
  return {
    flow: flowName,
    device: deviceId,
    executionPrerequisite,
    ok: failed === 0 && errored === 0 && !aborted,
    ...(aborted ? { aborted: true } : {}),
    passed,
    failed,
    skipped,
    errored,
    steps,
  };
}

function pushReport(state: ExecState, report: StepReport): void {
  state.reports.push(report);
  state.onStepReport?.(report);
}

interface RunStackEntry {
  canonical: string;
  display: string;
}

interface StepScope {
  runStack: RunStackEntry[];
  depth: number;
  env: Readonly<ScriptEnv>;
  /**
   * Set for a teardown list and everything it starts. {@link childScope} copies
   * it, so a fragment or a `when` block inside a teardown list is teardown too.
   */
  teardown?: true;
}

function scopeFlow(scope: StepScope): string {
  return scope.runStack[scope.runStack.length - 1]!.display;
}

function runDisplayName(target: string, scope: StepScope): string {
  return runDisplayFor(target, scope.runStack[0]!.display);
}

function runDisplayFor(target: string, rootDisplay: string): string {
  const stem = runTargetName(target);
  if (stem !== rootDisplay) return stem;
  const spelled = target.slice(0, -".yaml".length);
  return spelled === stem ? `./${stem}` : spelled;
}

function stepFlow(step: FlowStep, scope: StepScope): string {
  return step.kind === "run" ? runDisplayName(step.flow, scope) : scopeFlow(scope);
}

function scopeFlowDir(scope: StepScope): string {
  return path.dirname(scope.runStack[scope.runStack.length - 1]!.canonical);
}

function childScope(
  scope: StepScope,
  overrides: Partial<Omit<StepScope, "depth">> = {}
): StepScope {
  return { ...scope, ...overrides, depth: scope.depth + 1 };
}

/**
 * The scope stamp for a report: its depth, omitted at top level so a flow with
 * no nesting steps produces a report byte-identical to the pre-depth shape, and
 * the teardown label, omitted outside a teardown list for the same reason.
 */
function scopeStamp(scope: StepScope): Pick<StepReport, "depth" | "teardown"> {
  return {
    ...(scope.depth ? { depth: scope.depth } : {}),
    ...(scope.teardown ? { teardown: true } : {}),
  };
}

/** The report fields that name a step whose report line shows no target. */
function stepSubject(step: FlowStep): Pick<StepReport, "tool" | "message"> {
  if (step.kind === "echo") return { message: step.message };
  if (step.kind === "tool") return { tool: step.name };
  return {};
}

/** {@link stepName}, with the fragment the step belongs to when that is not the root flow. */
function stepNameInScope(step: FlowStep, scope: StepScope): string {
  const flow = stepFlow(step, scope);
  const root = scope.runStack[0]!.display;
  return flow === root ? stepName(step) : `${stepName(step)} [${escapeInline(flow)}]`;
}

const LISTED_TEARDOWN_STEPS = 10;

interface TeardownStop {
  reason: string;
  /** For the first skipped step that is not an `echo`; none when only echoes are left. */
  warning?: string;
  warned: boolean;
}

/**
 * What a teardown list that stopped at `steps[at - 1]` says about the steps it
 * did not start. Named from the `FlowStep`, not from the reports: a report
 * carries no step, and the last failed report can belong to another list (a
 * fragment's teardown list that failed after its steps stopped).
 *
 * The warning goes on a skipped step rather than on the step that failed,
 * because only this gate knows the rest of the list, and on a step that is not
 * an `echo`, because the CLI prints an echo's message and reason only.
 */
function teardownStop(steps: FlowStep[], at: number, scope: StepScope): TeardownStop {
  const stopper = stepNameInScope(steps[at - 1]!, scope);
  const reason = `did not start: the teardown list stopped at ${stopper}`;
  const left = steps
    .slice(at)
    .filter((step) => step.kind !== "echo")
    .map((step) => stepNameInScope(step, scope));
  if (left.length === 0) return { reason, warned: false };
  if (left.length === 1) {
    return {
      reason,
      warning:
        `this teardown step did not start because the teardown list stopped at ${stopper}. ` +
        "What it cleans up can remain",
      warned: false,
    };
  }
  const more = left.length - 1;
  const listed = left.slice(0, LISTED_TEARDOWN_STEPS).join(", ");
  const unlisted =
    left.length > LISTED_TEARDOWN_STEPS ? `, and ${left.length - LISTED_TEARDOWN_STEPS} more` : "";
  return {
    reason,
    warning:
      `this and ${more} more teardown step${more === 1 ? "" : "s"} did not start because the ` +
      `teardown list stopped at ${stopper}: ${listed}${unlisted}. What they clean up can remain`,
    warned: false,
  };
}

async function execSteps(state: ExecState, steps: FlowStep[], scope: StepScope): Promise<void> {
  let teardownStopped: TeardownStop | undefined;
  for (const [i, step] of steps.entries()) {
    const index = state.reports.length;

    if (state.stopped) {
      // A skipped teardown step can leave backend data behind, so outside a
      // cancel each list a teardown runs says what it did not start. A list
      // starts only while the run is not stopped, so the step before the first
      // skip is the one that stopped it.
      const aborted = state.signal?.aborted === true;
      if (!aborted && scope.teardown && i > 0) {
        teardownStopped ??= teardownStop(steps, i, scope);
      }
      const stopReason = aborted ? "run aborted" : teardownStopped?.reason;
      let warning: string | undefined;
      if (!aborted && teardownStopped && !teardownStopped.warned && step.kind !== "echo") {
        warning = teardownStopped.warning;
        teardownStopped.warned = true;
      }
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        flow: stepFlow(step, scope),
        target: stepTarget(step),
        ...scopeStamp(scope),
        ...(stopReason ? { reason: stopReason } : {}),
        ...(warning ? { warning } : {}),
        ...stepSubject(step),
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope), stopReason);
      continue;
    }
    if (!state.device && stepRequiresDevice(state.registry, step)) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "error",
        flow: scopeFlow(scope),
        target: stepTarget(step),
        ...scopeStamp(scope),
        reason: `step needs a device but the flow was resolved as device-free — pass an explicit device`,
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope));
      continue;
    }
    if (state.signal?.aborted) {
      state.stopped = true;
      pushReport(state, {
        index,
        kind: step.kind,
        status: "skip",
        reason: "run aborted",
        flow: stepFlow(step, scope),
        target: stepTarget(step),
        ...scopeStamp(scope),
        ...stepSubject(step),
      });
      const inner = blockSteps(step);
      if (inner) reportBlockSkipped(state, inner, childScope(scope), "run aborted");
      continue;
    }

    if (step.kind === "run") {
      await execRunStep(state, step, scope);
      continue;
    }
    if (isBlockStep(step)) {
      await execBlockStep(state, step, scope);
      continue;
    }

    if (scope.teardown) noteTeardownUse(state, step);
    const report = await resolveAndExecLeafStep(state, step, index, scope);
    pushReport(state, report);
    if (report.status === "fail" || report.status === "error") state.stopped = true;
  }
}

/**
 * Mark the hoisted instance as used when a teardown step acts on it. `echo` and
 * `script` do not act on it, as in {@link scanLeadingLaunch}, and a `launch`
 * boots an instance of its own.
 */
function noteTeardownUse(state: ExecState, step: FlowStep): void {
  if (!state.hoisted || step.kind === "launch" || precedesLeadingLaunch(step)) return;
  if (ownedInstance(state) === state.hoisted) state.hoisted = undefined;
}

function reportBlockSkipped(
  state: ExecState,
  steps: FlowStep[],
  scope: StepScope,
  reason?: string
): void {
  for (const step of steps) {
    pushReport(state, {
      index: state.reports.length,
      kind: step.kind,
      status: "skip",
      reason,
      flow: stepFlow(step, scope),
      target: stepTarget(step),
      ...scopeStamp(scope),
      ...stepSubject(step),
    });
    const inner = blockSteps(step);
    if (inner) reportBlockSkipped(state, inner, childScope(scope), reason);
  }
}

/**
 * Run a flow's `teardown` list after its steps, under a stop scope of its own:
 * the steps' stop flag is saved and cleared, so the list runs after a failure,
 * and on return it is the saved flag OR what the list set. That OR is what makes
 * a failed fragment teardown stop the parent's remaining steps, while the
 * parent's own teardown list still runs.
 *
 * After a cancel the flag is not cleared, and the list still goes through
 * {@link execSteps}: its gates report every teardown step skipped with "run
 * aborted", so the report stays complete and no teardown step starts. There is
 * one signal for the steps and the teardown alike. A second one would split the
 * readers: device and `tool:` steps read `ctx`, script steps and the run's
 * `aborted` sample read `state.signal`.
 */
async function execTeardown(
  state: ExecState,
  steps: FlowStep[] | undefined,
  scope: StepScope
): Promise<void> {
  if (!steps || steps.length === 0) return;
  const stopped = state.stopped;
  if (!state.signal?.aborted) state.stopped = false;
  await execSteps(state, steps, { ...scope, teardown: true });
  state.stopped = stopped || state.stopped;
}

/**
 * Dispatch a block directive to its executor. The `never` default arm is the
 * run-time site a kind registered in BLOCK_DIRECTIVE_KEYS cannot miss: an
 * unhandled registered kind fails tsc here instead of returning silently and
 * leaving the block out of the report entirely, not even its own marker. Binds
 * `step.kind` rather than `step` - while the registry has one entry BlockStep is
 * not a union, so only the discriminant narrows to `never`.
 */
async function execBlockStep(state: ExecState, step: BlockStep, scope: StepScope): Promise<void> {
  switch (step.kind) {
    case "when":
      return execWhenStep(state, step, scope);
    default: {
      const unhandled: never = step.kind;
      void unhandled;
    }
  }
}

async function execWhenStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "when" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const label = describeWhenCondition(step.condition);
  const target = stepTarget(step);
  const marker = {
    index,
    kind: "when",
    flow: scopeFlow(scope),
    target,
    ...scopeStamp(scope),
  } as const;
  const inner = childScope(scope);

  let met: boolean;
  if (step.condition.kind === "platform") {
    const guardEnv = deviceEnv(state);
    const platform = guardEnv.device.platform === "ios-remote" ? "ios" : guardEnv.device.platform;
    met = platform === step.condition.platform;
  } else {
    // Resolved before the probe, so the guard asks about the value. A reference
    // that does not resolve stops the run with an error rather than reading as
    // "condition not met": a guard that skips its block over a misspelled path,
    // saying nothing, is what the when-guard fields are on the list to prevent.
    const guard = resolveStepReferences(step, state.output);
    if (!guard.ok) {
      const hint = guard.miss && scope.teardown ? teardownMissHint(state, scope, "guard") : "";
      pushReport(state, {
        ...marker,
        status: "error",
        reason: `could not resolve when guard (${label}): ${guard.reason}${hint}`,
      });
      state.stopped = true;
      reportBlockSkipped(state, step.steps, inner, "when guard errored");
      return;
    }
    const probe = await probeWhenCondition(
      deviceEnv(state),
      guard.step.condition as typeof step.condition
    );
    if (probe.aborted) {
      pushReport(state, { ...marker, status: "skip", reason: "run aborted" });
      reportBlockSkipped(state, step.steps, inner, "run aborted");
      return;
    }
    if (!probe.ok && probe.indeterminate) {
      pushReport(state, {
        ...marker,
        status: "error",
        reason: appendResolvedValues(
          `could not evaluate when guard (${label}): ${probe.reason}`,
          guard.references
        ),
      });
      state.stopped = true;
      reportBlockSkipped(state, step.steps, inner, "when guard errored");
      return;
    }
    met = probe.ok;
  }

  if (!met) {
    const n = step.steps.length;
    pushReport(state, {
      ...marker,
      status: "skip",
      reason: `condition not met (${label}) — block skipped (${n} step${n === 1 ? "" : "s"})`,
    });
    reportBlockSkipped(state, step.steps, inner, "when block skipped");
    return;
  }

  pushReport(state, { ...marker, status: "pass", reason: `condition met (${label})` });
  await execSteps(state, step.steps, inner);
}

/**
 * The `__baselines__/<segment>` a run's snapshots key their baseline store
 * under. The store is `<flowsDir>/__baselines__/<key>` and `flowsDir` is the
 * CANONICAL root flow's directory, so the key must name the canonical file too.
 * With the as-written stem it does not, and the disagreement merges distinct
 * flows: two projects whose `.argent/flows/smoke.yaml` are symlinks into one
 * shared vault (`vault/a-smoke.yaml`, `vault/b-smoke.yaml`) both anchor at
 * `vault/` and both key "smoke", so a single `vault/__baselines__/smoke/` holds
 * one PNG the two flows silently overwrite in turn while each
 * `--update-baselines` run reports "baseline updated". For a root flow that is a
 * regular file the canonical stem IS the as-written one, so only symlinked roots
 * move.
 *
 * The canonical stem is the symlink TARGET's filename, which nothing validates:
 * `assertSafeFlowName` and `classifyOnDiskSpelling` only run against the
 * as-written spelling, so a vault file may legitimately be called `...yaml` —
 * whose stem after `.yaml` is `..`, and
 * `path.join(flowsDir, "__baselines__", "..")` IS `flowsDir`, so every baseline
 * would land beside the flow files themselves (the escape
 * `flow-path-baseline-escape.test.ts` pins for the as-written spelling). Hence
 * the pattern check, against the same charset every other flow name is held to.
 * An unsafe stem falls back to the always-validated `flowName` rather than
 * throwing: an unusually named vault file is not the caller's error to fix
 * mid-run.
 */
function baselineKeyFor(canonicalPath: string, flowName: string): string {
  const stem = path.basename(canonicalPath, ".yaml");
  return FLOW_NAME_PATTERN.test(stem) ? stem : flowName;
}

async function execRunStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "run" }>,
  scope: StepScope
): Promise<void> {
  const index = state.reports.length;
  const target = step.flow;
  const display = runDisplayName(target, scope);

  const fail = (reason: string): void => {
    pushReport(state, {
      index,
      kind: "run",
      status: "error",
      flow: display,
      target,
      reason,
      ...scopeStamp(scope),
    });
    state.stopped = true;
  };

  const { canonical, spelling } = await resolveFlowRelativeFile(
    scopeFlowDir(scope),
    target,
    FLOW_FILE_NAME_PATTERN
  );
  if (scope.runStack.some((entry) => entry.canonical === canonical)) {
    return fail(
      `cyclic flow reference: ${[...scope.runStack.map((entry) => entry.display), display].join(" → ")}`
    );
  }

  if (scope.runStack.length >= MAX_RUN_DEPTH) {
    return fail("max run depth exceeded");
  }

  const suppliedBase = path.posix.basename(target);
  if (spelling.state === "case_folded") {
    const recovery = spelling.addressable
      ? `reference it as "${target.slice(0, target.length - suppliedBase.length)}${spelling.actual}"`
      : `rename "${spelling.actual}" to "${suppliedBase}" to compose it — flow files must be ` +
        `lowercase .yaml`;
    return fail(
      `mis-cased fragment reference "${target}": no directory entry is named "${suppliedBase}" ` +
        `(this filesystem matched it case-insensitively to "${spelling.actual}"), so the fragment ` +
        `name keying its step reports is one nothing on disk carries and a case-sensitive ` +
        `checkout could not find the file at all — ${recovery}`
    );
  }

  // There is deliberately NO path fence between here and the read. A `run:`
  // target is reachable exactly when the tool-server user can read it, the same
  // reach the front door already grants: an operator can point flow_path at any
  // YAML on the host, so restricting composition below that only breaks
  // documented layouts — a fragment shared sideways (`../shared/login.yaml`),
  // and a flows dir symlinked to a tree kept outside the project. The one route
  // that carries untrusted content, an uploaded flow, never arrives here:
  // assertUploadSelfContained rejects every `run:` step on that path.
  let fragment: FlowFile;
  try {
    fragment = parseFlow(await fs.readFile(canonical, "utf8"));
  } catch (err) {
    return fail(`could not load fragment "${target}": ${errMsg(err)}`);
  }

  const retiredArg = findRetiredToolArg(state.registry, fragment);
  if (retiredArg) return fail(`fragment "${target}" ${retiredArgReason(retiredArg)}`);

  // One scope for the fragment's steps and its teardown list. With the
  // parent's, a teardown script would resolve beside the parent's file, miss the
  // fragment's `env` defaults, and escape the cycle check.
  const fragmentScope = childScope(scope, {
    runStack: [...scope.runStack, { canonical, display }],
    ...(fragment.env ? { env: mergeScriptEnv(scope.env, fragment.env) } : {}),
  });

  const secretProblem = await teardownSecretProblem(state, fragment.teardown, fragmentScope);
  if (secretProblem) {
    return fail(
      `fragment "${target}" was not run: ${escapeInline(teardownSecretRefusal(secretProblem))}`
    );
  }

  pushReport(state, {
    index,
    kind: "run",
    status: "pass",
    flow: display,
    target,
    ...scopeStamp(scope),
  });
  try {
    await execSteps(state, fragment.steps, fragmentScope);
  } finally {
    const position = chromiumPosition(state);
    await execTeardown(state, fragment.teardown, fragmentScope);
    await restoreChromiumPosition(state, position);
  }
}

/**
 * Where a chromium run stands before a fragment's teardown list: the instance
 * it is on, and that instance's app path when the run booted it.
 */
interface ChromiumPosition {
  deviceId: string;
  ownedAppPath?: string;
}

function chromiumPosition(state: ExecState): ChromiumPosition | undefined {
  if (state.device?.platform !== "chromium") return undefined;
  const owned = ownedInstance(state);
  return { deviceId: state.device.id, ...(owned ? { ownedAppPath: owned.appPath } : {}) };
}

/**
 * Put the run back on the chromium instance it was on before a fragment's
 * teardown list. A teardown `launch` always boots and moves the run
 * ({@link bootChromiumForLaunch}), and the parent's next steps, its first
 * `launch` above all ({@link ownedInstance}), find their instance through the
 * run's device.
 *
 * An instance the run did not boot is never stopped by a boot, so its id is
 * still good. One the run booted may have been replaced by a relaunch of the
 * same app inside the teardown list, and a boot keeps at most one owned
 * instance per app path, so the app path finds the current one. When there is
 * none (that relaunch failed to boot), the run stays where the list left it.
 */
async function restoreChromiumPosition(
  state: ExecState,
  before: ChromiumPosition | undefined
): Promise<void> {
  if (!before || state.device?.id === before.deviceId) return;
  const back =
    before.ownedAppPath === undefined
      ? before.deviceId
      : state.owned.find((o) => o.appPath === before.ownedAppPath)?.deviceId;
  if (back === undefined || back === state.device?.id) return;
  state.device = resolveDevice(back);
  // As a boot does: without it, the parent's next gesture can land on a window
  // behind the one the teardown booted.
  await frontChromiumPage(state.registry, state.device);
}

type TeardownSecretCheck = Pick<ExecState, "projectRoot" | "runtimeEnv">;

const KEYBOARD_TOOL = "keyboard";
const PASTE_TOOL = "paste";
const RUN_SEQUENCE_TOOL = "run-sequence";
const FLOW_EXECUTE_TOOL = "flow-execute";

/**
 * Resolve every `{{secret:NAME}}` a teardown list will need, and discard the
 * values. A placeholder resolves when its step starts, which for a teardown is
 * after the steps made the data it exists to remove: a secret set only in CI
 * would make every local run seed and then fail its cleanup.
 *
 * Only the fields a secret resolver reads, each with that resolver's own
 * sources, so the answer here is the answer the step would get. `when` blocks
 * are not walked: a guard that is not met never resolves its block, and the
 * platform is unknown before the device is, so a check there would refuse runs
 * that pass. `run:` targets are read and walked, steps and teardown alike, with
 * the guards {@link scanLeadingLaunch} uses; a target the walk cannot enter is
 * reported by its `run:` step when that step starts.
 *
 * Returns what failed and where, or undefined.
 */
async function teardownSecretProblem(
  check: TeardownSecretCheck,
  teardown: FlowStep[] | undefined,
  scope: StepScope
): Promise<string | undefined> {
  return secretProblemIn(check, teardown ?? [], scope, "teardown step", "");
}

async function secretProblemIn(
  check: TeardownSecretCheck,
  steps: FlowStep[],
  scope: StepScope,
  label: string,
  within: string
): Promise<string | undefined> {
  for (const [i, step] of steps.entries()) {
    const where = `${label} ${i + 1}${within}`;
    if (step.kind === "run") {
      const problem = await runTargetSecretProblem(check, step, scope, where);
      if (problem) return problem;
      continue;
    }
    try {
      assertStepSecretsResolve(check, step, scope);
    } catch (err) {
      return `${where} (${stepName(step)}): ${errMsg(err)}`;
    }
  }
  return undefined;
}

function assertStepSecretsResolve(
  check: TeardownSecretCheck,
  step: FlowStep,
  scope: StepScope
): void {
  switch (step.kind) {
    case "script":
      // The whole environment the step is given, as `runScriptStep` merges it:
      // a placeholder in the flow's own `env:` fails the step as well, and one
      // that a step `env` or the run's `env` replaces never resolves.
      resolveScriptEnvSecrets(mergeScriptEnv(scope.env, check.runtimeEnv, step.env), {
        cwd: check.projectRoot,
      });
      return;
    case "type":
      // A `type` step types through `keyboard`, which resolves from the tool
      // server's working directory, not from the project.
      resolveSecretPlaceholders(step.text);
      return;
    case "tool":
      assertToolSecretsResolve(step.name, step.args);
      return;
    default:
      return;
  }
}

function assertToolSecretsResolve(tool: string, args: Record<string, unknown>): void {
  if (tool === KEYBOARD_TOOL || tool === PASTE_TOOL) {
    if (typeof args.text === "string") resolveSecretPlaceholders(args.text);
    return;
  }
  if (tool === RUN_SEQUENCE_TOOL && Array.isArray(args.steps)) {
    for (const entry of args.steps as unknown[]) {
      const call = entry as { tool?: unknown; args?: { text?: unknown } } | null;
      if (call?.tool !== KEYBOARD_TOOL && call?.tool !== PASTE_TOOL) continue;
      if (typeof call.args?.text === "string") resolveSecretPlaceholders(call.args.text);
    }
    return;
  }
  if (tool === FLOW_EXECUTE_TOOL) {
    // The child run checks its own `env` against its own project root before
    // it starts; the flow file it names is not read here.
    const env = args.env;
    if (typeof args.project_root !== "string") return;
    if (env === null || typeof env !== "object" || Array.isArray(env)) return;
    const strings = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    resolveScriptEnvSecrets(strings, { cwd: args.project_root });
  }
}

async function runTargetSecretProblem(
  check: TeardownSecretCheck,
  step: Extract<FlowStep, { kind: "run" }>,
  scope: StepScope,
  where: string
): Promise<string | undefined> {
  let canonical: string;
  let fragment: FlowFile;
  try {
    const hop = await resolveFlowRelativeFile(
      scopeFlowDir(scope),
      step.flow,
      FLOW_FILE_NAME_PATTERN
    );
    canonical = hop.canonical;
    if (scope.runStack.some((entry) => entry.canonical === canonical)) return undefined;
    if (scope.runStack.length >= MAX_RUN_DEPTH) return undefined;
    if (hop.spelling.state === "case_folded") return undefined;
    fragment = parseFlow(await fs.readFile(canonical, "utf8"));
  } catch {
    return undefined;
  }
  const inner = childScope(scope, {
    runStack: [...scope.runStack, { canonical, display: runDisplayName(step.flow, scope) }],
    ...(fragment.env ? { env: mergeScriptEnv(scope.env, fragment.env) } : {}),
  });
  const within = ` of ${escapeInline(step.flow)} at ${where}`;
  return (
    (await secretProblemIn(check, fragment.steps, inner, "step", within)) ??
    (await secretProblemIn(check, fragment.teardown ?? [], inner, "teardown step", within))
  );
}

function teardownSecretRefusal(problem: string): string {
  return (
    "Argent resolves the secrets of a teardown list before the run starts, so that the run " +
    `does not create backend data that its teardown cannot remove, and ${problem}`
  );
}

type ScriptStepOutcome = Pick<
  StepReport,
  "status" | "reason" | "warning" | "scriptLog" | "scriptLogTruncated"
>;

/**
 * A `script` step is the one step whose `reason` is written by something other
 * than this server: the child's own `throw` message crosses into it verbatim,
 * and a multi-line message is the ordinary shape of a rethrown API error. Every
 * surface that renders a step is one line per step and interpolates the reason
 * raw — the CLI's step line, `flowRunToMcpContent`, and the lift in
 * `flow-nested-outcome.ts` — so a newline in it puts script-controlled text at
 * column 0, below a `✗` line and above the real summary. A forged
 * "PASS — 3 passed, 0 failed" reads there as the run's own verdict.
 *
 * Escaped rather than stripped, and here rather than in each renderer: the
 * original characters stay recoverable, and the one step whose reason is not
 * server-composed is the one that pays for it. `describe`'s tree renderer takes
 * the same measure for the same reason (`format-tree.ts`), on labels read off a
 * device — a less hostile source than a local process's uncaught throw.
 *
 * Length is left to the executor's own `SCRIPT_MAX_FAILURE_MESSAGE_CHARS`: it
 * is the budget that decides what a failed script may say about itself, and a
 * second ceiling here would cut the step's only diagnostic without moving that
 * decision anywhere a reader can find it.
 */
function oneLineReason(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

async function runScriptStep(
  state: ExecState,
  step: Extract<FlowStep, { kind: "script" }>,
  scope: StepScope
): Promise<ScriptStepOutcome> {
  const { outcome, result } = await runFlowScriptStep({
    flowDir: scopeFlowDir(scope),
    step,
    projectRoot: state.projectRoot,
    logBudget: state.scriptLogBudget,
    env: mergeScriptEnv(scope.env, state.runtimeEnv, step.env),
    output: state.output,
    runNotes: state.scriptRunNotes,
    ...(state.signal ? { signal: state.signal } : {}),
  });
  // Only a pass merges: a script that failed or errored may have written half
  // of what it meant to, and none of it is kept.
  let settled: ScriptStepOutcome = outcome;
  if (outcome.status === "pass" && result?.output) {
    const merged = mergeScriptOutput(state.output, result.output);
    if ("problem" in merged) {
      // The document is thrown away, and a warning about what it held goes too.
      const { warning: discarded, ...kept } = outcome;
      void discarded;
      settled = {
        ...kept,
        status: "fail",
        reason:
          outcome.reason === undefined ? merged.problem : `${merged.problem} ${outcome.reason}`,
      };
    } else {
      state.output = merged.output;
    }
  }
  return settled.reason === undefined
    ? settled
    : { ...settled, reason: oneLineReason(settled.reason) };
}

type LeafStep = Exclude<FlowStep, BlockStep | { kind: "run" }>;

type LeafReportBase = Pick<StepReport, "index" | "kind" | "flow" | "target" | "depth" | "teardown">;

async function resolveAndExecLeafStep(
  state: ExecState,
  step: LeafStep,
  index: number,
  scope: StepScope
): Promise<StepReport> {
  const base: LeafReportBase = {
    index,
    kind: step.kind,
    flow: scopeFlow(scope),
    target: stepTarget(step),
    ...scopeStamp(scope),
  };
  // Directly before the step, and only once it is reached: a skipped step reads
  // nothing, and every script above it has already merged.
  const resolution = resolveStepReferences(step, state.output);
  if (!resolution.ok) {
    const hint =
      resolution.miss && scope.teardown ? teardownMissHint(state, scope, resolution.miss.kind) : "";
    return {
      ...base,
      status: "error",
      reason: `${resolution.reason}${hint}`,
      ...stepSubject(step),
    };
  }
  const report = await execLeafStep(state, step, resolution, base, scope);
  if (report.status !== "fail" && report.status !== "error") return report;
  const reason = appendResolvedValues(report.reason, resolution.references);
  return reason === report.reason ? report : { ...report, reason };
}

/**
 * Why a teardown step can miss a value: usually no step wrote it, because the
 * script that would have written it failed, or sat in a `when` block that did
 * not run.
 * Said only when a report before this step did not pass. With every earlier
 * step passing, the missing value is a mistake in the flow or the script, and
 * advice about an optional value would hide it.
 *
 * The advice follows where the reference is, not the field kind: a `when`
 * guard's fields have the same kinds as a selector's, and only a guard can turn
 * a fallback into a skipped block.
 */
function teardownMissHint(
  state: ExecState,
  scope: StepScope,
  where: "guard" | Exclude<OutputFieldKind, "static">
): string {
  const earlier = state.reports.find((report) => report.status !== "pass");
  if (!earlier) return "";
  const cause =
    `. A step before this step did not pass (${reportName(earlier, scope)}: ${earlier.status}), ` +
    "so it is possible that no step wrote the value";
  switch (where) {
    case "guard":
      return (
        `${cause}. To skip this block when the value is missing, end the reference with a ` +
        "fallback that no screen shows, such as `?? '__none__'`: the guard is then not met, " +
        "and the teardown list continues"
      );
    case "env":
    case "arg":
    case "echo":
      return (
        `${cause}. If this teardown step must run without the value, add a \`??\` fallback, ` +
        "and make sure that the step can use an empty value"
      );
    case "text":
    case "identifier":
    case "role":
    case "expected":
    case "typed":
      return (
        `${cause}. A fallback cannot make this step optional, because the step refuses an ` +
        "empty value. Put the step in a `when` block whose guard ends the reference with a " +
        "fallback that no screen shows (`?? '__none__'`), or do this cleanup in a script"
      );
    default: {
      const unclassified: never = where;
      void unclassified;
      return cause;
    }
  }
}

/** A report named as its report line names it, with its fragment when that is not the root flow. */
function reportName(report: StepReport, scope: StepScope): string {
  const subject = report.tool ?? report.target ?? report.message;
  const name = escapeInline(renderedValue(subject ? `${report.kind} ${subject}` : report.kind));
  const root = scope.runStack[0]!.display;
  return report.flow && report.flow !== root ? `${name} [${escapeInline(report.flow)}]` : name;
}

/**
 * A step that read output and then failed says what it read. Its report keeps
 * the reference as the flow file spells it, the way a `tool` step keeps
 * `{{secret:NAME}}`, so without this an `assert` on `Order {{output:order.id}}`
 * would fail without the text it looked for. Output is not secret, so the
 * value is shown.
 */
function appendResolvedValues(
  reason: string | undefined,
  references: readonly ResolvedOutputReference[]
): string | undefined {
  if (references.length === 0) return reason;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const { source, value } of references) {
    if (seen.has(source)) continue;
    seen.add(source);
    // One line, whatever whitespace the author put between tokens: a step
    // reason is rendered as one line on every surface.
    const spelled = source.replace(/\s+/g, " ");
    values.push(`(output.${spelled} = ${renderedValue(JSON.stringify(value))})`);
  }
  return reason ? `${reason} ${values.join(" ")}` : values.join(" ");
}

/**
 * A whole-field reference keeps the JSON type the script wrote, and a tool can
 * refuse that type where a `type:` step would have made text of it — `tool:
 * keyboard` refuses a number in `text`. The tool's own message names the
 * argument, not where its value came from.
 */
function wholeFieldTypeNote(err: unknown, wholeFields: readonly WholeFieldReference[]): string {
  if (wholeFields.length === 0) return "";
  if (getFailureSignal(err)?.error_code !== FAILURE_CODES.TOOL_INPUT_INVALID) return "";
  return (
    ` — ${describeWholeFields(wholeFields)}. A reference that is the whole argument keeps the ` +
    "JSON type the script wrote: write the value as a string in the script, or enter it with a " +
    "`type:` step"
  );
}

/**
 * The same note for a `run-sequence` or a nested `flow-execute`: those report
 * an inner tool's refusal in their result rather than by throwing, so its
 * failure code never reaches the runner, and the note can only say "if".
 */
function nestedWholeFieldNote(
  status: StepStatus,
  wholeFields: readonly WholeFieldReference[]
): string {
  if (wholeFields.length === 0 || (status !== "fail" && status !== "error")) return "";
  return (
    ` — ${describeWholeFields(wholeFields)}. If a tool refused that type, write the value as a ` +
    "string in the script, or enter it with a `type:` step"
  );
}

function describeWholeFields(wholeFields: readonly WholeFieldReference[]): string {
  return wholeFields
    .map(
      (field) =>
        `\`${field.where}\` is ${JSON.stringify(renderedValue(field.reference))} alone, so it ` +
        `received ${field.type}`
    )
    .join("; ");
}

/**
 * One leaf step, run with its references resolved. `authored` is the step as
 * the flow file spells it, and every report field that names the step keeps
 * that spelling; only an `echo` shows what it resolved to.
 */
async function execLeafStep(
  state: ExecState,
  authored: LeafStep,
  resolution: Extract<StepReferenceResolution<LeafStep>, { ok: true }>,
  base: LeafReportBase,
  scope: StepScope
): Promise<StepReport> {
  const step = resolution.step;
  const { registry, ctx, device, signal } = state;

  switch (step.kind) {
    case "echo":
      return { ...base, status: "pass", message: step.message };

    case "launch": {
      const r = await runLaunch(state, step.app, scope.teardown === true);
      if (r.aborted) return { ...base, status: "skip", reason: r.reason };
      return { ...base, status: r.ok ? "pass" : "error", reason: r.reason };
    }

    case "tap":
    case "long-press":
    case "swipe":
    case "type":
    case "await":
    case "assert":
    case "idle":
    case "scroll-to":
    case "pinch":
    case "rotate": {
      try {
        const r = await runDirective(deviceEnv(state), step);
        if (r.aborted) return { ...base, status: "skip", reason: r.reason };
        if (!r.ok && r.indeterminate && step.kind === "idle") {
          return { ...base, status: "error", reason: r.reason };
        }
        return {
          ...base,
          status: r.ok ? "pass" : "fail",
          reason: r.reason,
          ...(r.warning !== undefined ? { warning: r.warning } : {}),
        };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "wait": {
      if (!(await sleepOrAbort(step.ms, signal))) {
        return { ...base, status: "skip", reason: "run aborted during wait" };
      }
      return { ...base, status: "pass" };
    }

    case "snapshot": {
      // The parser refuses a snapshot in a teardown list; this is one that a
      // teardown `run:` reached in a fragment's steps.
      if (scope.teardown) {
        return {
          ...base,
          status: "error",
          reason:
            "a snapshot step cannot run in teardown: the teardown also runs after a failed run, " +
            "and with --update-baselines a snapshot would save the screen that run left as the " +
            "baseline",
        };
      }
      try {
        const r = await runSnapshot(deviceEnv(state), {
          flowsDir: state.flowsDir,
          flowName: state.baselineKey,
          name: step.name,
          maxMismatch: step.maxMismatch ?? DEFAULT_MAX_MISMATCH,
          updateBaselines: state.updateBaselines,
          cropOn: step.cropOn,
          appIdentity: snapshotAppIdentity(state),
          seenKeys: state.snapshotApps,
        });
        return {
          ...base,
          status: r.status,
          reason: r.reason,
          snapshotKey: r.snapshotKey,
          artifacts: r.artifacts,
        };
      } catch (err) {
        return { ...base, status: "error", reason: errMsg(err) };
      }
    }

    case "tool": {
      // A device-less run reaches here only for a tool declaring none of
      // `DEVICE_ARG_KEYS` — a target key — so binding injects no target and
      // merely strips any device key the recorded args carried. The `?? ""` is
      // unreachable for those and must stay unreachable: injecting the empty
      // string would not fail the step, it would silently retarget it at no
      // device. A SCOPE key (`devices`) does reach here device-free, which is
      // the cleanup-flow case `bindDeviceArgs` guards by keeping whatever the
      // recording scoped — as it does with a device resolved, unless the caller
      // named it.
      const args = bindDeviceArgs(
        registry,
        step.name,
        device?.id ?? "",
        step.args,
        state.deviceIsExplicit
      );
      // The tool receives `args`, every reference resolved; the report shows the
      // arguments as authored, bound the same way.
      const authoredArgs = (authored as typeof step).args;
      const reportArgs =
        authored === step
          ? args
          : bindDeviceArgs(
              registry,
              step.name,
              device?.id ?? "",
              authoredArgs,
              state.deviceIsExplicit
            );
      const outputHint = registry.getTool(step.name)?.outputHint;
      if (step.delayMs && !(await sleepOrAbort(step.delayMs, signal))) {
        return { ...base, status: "skip", tool: step.name, reason: "run aborted during delay" };
      }
      if (FOREGROUND_CHANGING_TOOLS.has(step.name)) {
        state.treeTarget = undefined;
        if (state.treeOutage) state.treeOutage.proven = undefined;
      } else if (state.treeTarget?.pinned) {
        state.treeTarget = { ...state.treeTarget, pinned: false };
        if (state.treeOutage) state.treeOutage.proven = undefined;
      }
      // A nested orchestrator runs its tools outside this run's holder -
      // `flow-execute` on an ExecState of its own, `run-sequence` on none - so
      // a tree read or relaunch inside it retires nothing here. Cleared before
      // the invoke for the same reason as above, and over-clearing only costs a
      // later gesture a window it would have skipped.
      if (isNestedOrchestratorTool(step.name) && state.treeOutage) {
        state.treeOutage.proven = undefined;
      }
      try {
        const result = await invokeSubTool(registry, ctx, step.name, args);
        if (isUnmetUiWaitResult(step.name, result)) {
          const note = (result as { note?: string }).note;
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `await-ui-element condition not met${note ? `: ${note}` : ""}`,
          };
        }
        // `flow-execute` and `run-sequence` run other tools and report what
        // happened in their result instead of throwing, so without this a
        // composition that failed everything counted as a passing step (#606).
        const nested = nestedOrchestratorOutcome(step.name, result);
        if (nested) {
          return {
            ...base,
            status: nested.status,
            tool: step.name,
            reason: `${nested.reason}${nestedWholeFieldNote(nested.status, resolution.wholeFields)}`,
            result,
            outputHint,
            args: reportArgs,
          };
        }
        if (isDebuggerNotConnectedResult(step.name, result)) {
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `debugger not connected (${result.reason}): ${result.detail} — ${result.guidance}`,
            result,
            outputHint,
            args: reportArgs,
          };
        }
        // Same hazard as the two above, on the native-devtools precheck: it
        // RESOLVES its block rather than throwing, so a step that never reached
        // the tool's work read as green. `launch:` already guards its own
        // `restart-app` (see runLaunch); this is the `tool:` spelling of the
        // same sub-tools, plus the native-* tools it never covered.
        if (isNativeDevtoolsBlockResult(step.name, result)) {
          return {
            ...base,
            status: "fail",
            tool: step.name,
            reason: `${step.name} did not run (${result.status}): ${result.message}`,
            result,
            outputHint,
            args: reportArgs,
          };
        }
        if (step.name === "launch-app" || step.name === "restart-app") {
          const launched = (args as { bundleId?: unknown }).bundleId;
          if (typeof launched === "string") {
            state.treeTarget = { bundleId: launched, pinned: false, probeAnswered: false };
          }
        }
        return {
          ...base,
          status: "pass",
          tool: step.name,
          result,
          outputHint,
          args: reportArgs,
        };
      } catch (err) {
        if (signal?.aborted) {
          return { ...base, status: "skip", tool: step.name, reason: ABORTED_OUTCOME.reason };
        }
        const reframed = describeNestedParamError(
          registry,
          err,
          step.name,
          args,
          authoredArgs ?? {}
        );
        return {
          ...base,
          status: "error",
          tool: step.name,
          reason: `${reframed ?? errMsg(err)}${wholeFieldTypeNote(err, resolution.wholeFields)}`,
        };
      }
    }

    case "script": {
      const outcome = await runScriptStep(state, step, scope);
      return { ...base, ...outcome };
    }

    default: {
      const unexecuted: never = step;
      void unexecuted;
      return { ...base, status: "error", reason: `unsupported step kind` };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the flow YAML source a tool reads. An explicit `flow_path` is accepted
 * only when the file-input boundary resolved the exact client path in place on
 * this host AND matched the client-recorded stat (`statVerified`) — presence
 * alone is satisfiable by a hand-crafted stat-less wrapper, so it is not
 * containment. Uploaded explicit paths are rejected: the uploaded root YAML
 * would lose sibling `run:` files, baseline reads, and baseline write-back. A
 * remote `name` call uploads the same way and is accepted below, so this
 * rejection only keeps `flow_path`, whose whole contract is that those resolve
 * beside the caller's YAML, from silently meaning a temp directory instead.
 *
 * With no `flow_path` or `flow_file`, derive the saved-flow path from
 * project_root + name. When `flow_file` is set it must be one of the two shapes
 * its file-input boundary legitimately produces: the exact
 * `${project_root}/.argent/flows/${name}.yaml` path (co-located client), or a
 * temp file THIS server materialized from uploaded content
 * (`fileInput.viaUpload` — remote client). Anything else is rejected: the schema
 * marks `flow_file` internal, and honoring an arbitrary path would let a caller
 * execute (and, under --update-baselines, write PNGs next to) any YAML on the
 * host through a parameter no caller is supposed to set — `flow_path`, gated on
 * the boundary above, is the one legitimate spelling for a file outside the
 * flows dir. Either source's flow name must then appear in that flow's own
 * directory listing byte-for-byte — a case-insensitive filesystem opens files
 * under spellings no directory entry carries, and the name is what keys the
 * report and `__baselines__/` (see {@link classifyOnDiskSpelling}). Name is
 * validated on the branch that has one; project_root is validated up front,
 * before either branch, since only the `name` branch would otherwise reach a
 * check.
 *
 * Resolution is pure: it reads and mutates no shared state, so replaying a flow
 * in one project can never rebind the paths of a recording in progress in
 * another.
 */
export async function resolveFlowSource(
  params: {
    name?: string;
    project_root: string;
    flow_file?: string;
    flow_path?: string;
  },
  fileInput?: ResolvedFileInput,
  flowPathInput?: ResolvedFileInput
): Promise<{ filePath: string; flowName: string; viaUpload: boolean }> {
  // The schemas' superRefine already enforces this for flow-execute and
  // flow-read-prerequisite; this copy covers direct execute() callers (tests,
  // in-process invocations) and keeps the params.name! below sound.
  if ((params.name === undefined) === (params.flow_path === undefined)) {
    throw new FailureError("Pass exactly one flow source: name or flow_path.", {
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_source",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  assertValidProjectRoot(params.project_root);

  if (params.flow_path !== undefined) {
    if (flowPathInput?.viaUpload) {
      throw new FailureError(
        `Invalid flow_path "${flowPathInput.clientPath}": explicit flow paths require a ` +
          `co-located client and tool server with a shared filesystem, and this one arrived as ` +
          `an upload — sibling run: files, baselines, and baseline write-back all resolve beside ` +
          `the copy this server materialized, alone in a temp directory. Pass name + ` +
          `project_root to run a self-contained flow from a remote client; name uploads the same ` +
          `way, so a flow with run:, script: or snapshot: steps needs the client and tool server ` +
          `on one filesystem.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_shared_filesystem",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // The last conjunct is not containment — over HTTP both sides come from the
    // same wire path (file-inputs.ts). It ties the string returned below to the
    // one the extension/name checks read, so no caller can have them validate a
    // different file than the one that gets opened.
    const isVerifiedHostPath =
      flowPathInput?.presentOnHost === true &&
      flowPathInput.statVerified === true &&
      path.resolve(params.flow_path) === path.resolve(flowPathInput.clientPath);

    if (!isVerifiedHostPath) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": explicit flow paths must be supplied through ` +
          `the flow_path file-input boundary. Pass the client-local path and let the argent ` +
          `client resolve it.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_boundary",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    if (!path.isAbsolute(params.flow_path)) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": flow paths must be absolute — a relative path ` +
          `is resolved against the tool server's working directory, not the caller's. Pass the ` +
          `absolute path to the flow's YAML.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_absolute",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    // Reject ".." segments: execute() canonicalizes this path ONCE with kernel
    // semantics (canonicalFlowPath) and derives the read, flowsDir, and the
    // runStack seed from that one result, so a ".." spelling can no longer split
    // the read from its anchors. What it still can do is carry two readings —
    // after a symlinked component, the kernel's ".." and a lexical collapse name
    // different files — or, when the directory chain is broken, slip through
    // canonicalFlowPath's verbatim fallback to fail later as a raw readFile
    // ENOENT on the unresolved spelling. Rejecting up front means every admitted
    // flow_path has exactly one reading. The argent client rejects ".." segments
    // before sending; only a direct MCP/HTTP caller can pass an unresolved
    // flow_path.
    if (params.flow_path.split(/[\\/]+/).includes("..")) {
      throw new FailureError(
        `Invalid flow_path "${params.flow_path}": flow paths must not contain ".." segments — ` +
          `a ".." after a symlinked directory can name a different file than the spelling ` +
          `suggests, and the argent client always sends fully resolved paths. Pass the fully ` +
          `resolved absolute path to the flow's YAML.`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_dotdot",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const clientPath = flowPathInput!.clientPath;
    const clientExt = path.extname(clientPath);
    // path.extname reads a basename that is only the extension as an
    // extensionless dotfile, so clientExt is "" for ".yaml" (and ".YAML") and
    // the arms below would blame the extension of a path that visibly ends in
    // .yaml. What is actually missing is the filename stem — fall past this
    // check and let assertSafeFlowName name it.
    const bareExtension = path.basename(clientPath).toLowerCase() === ".yaml";
    if (!bareExtension && clientExt !== ".yaml") {
      const detail =
        clientExt.toLowerCase() === ".yaml"
          ? `flow files must use the lowercase .yaml extension, not "${clientExt}".`
          : `flow files must use the .yaml extension.`;
      throw new FailureError(`Invalid flow_path "${clientPath}": ${detail}`, {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_path_extension",
        failure_area: "tool_server",
        error_kind: "validation",
      });
    }
    // basename leaves a suffix in place when stripping it would leave nothing,
    // and strips only an exact-case one — so both ".yaml" and ".YAML" would
    // otherwise be reported as a flow *named* that, not as a missing stem.
    const flowName = bareExtension ? "" : path.basename(clientPath, ".yaml");
    assertSafeFlowName(flowName);

    const suppliedBase = path.basename(clientPath);
    const spelling = await classifyOnDiskSpelling(path.dirname(params.flow_path), suppliedBase);
    if (spelling.state !== "listed") {
      const recovery =
        spelling.state === "absent"
          ? `Pass the basename exactly as it appears on disk.`
          : spelling.addressable
            ? `Pass flow_path with the on-disk basename "${spelling.actual}".`
            : `Rename "${spelling.actual}" to "${suppliedBase}" to run it — flow files must be lowercase .yaml.`;
      throw new FailureError(
        `Invalid flow_path "${clientPath}": the file must be named as it appears on disk — this ` +
          `filesystem matched "${suppliedBase}" case-insensitively` +
          (spelling.state === "case_folded" ? ` to "${spelling.actual}"` : "") +
          `, so the flow name (which keys the report and __baselines__/) would be one no ` +
          `directory entry carries. ${recovery}`,
        {
          error_code: FAILURE_CODES.FLOW_FILE_INVALID,
          failure_stage: "flow_path_casing",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    return { filePath: params.flow_path, flowName, viaUpload: false };
  }

  const flowName = params.name!;
  assertSafeFlowName(flowName);
  const expected = getFlowPath(params.project_root, flowName);
  if (params.flow_file && fileInput?.viaUpload)
    return { filePath: params.flow_file, flowName, viaUpload: true };
  if (
    params.flow_file &&
    (!path.isAbsolute(params.flow_file) ||
      params.flow_file.split(/[\\/]+/).includes("..") ||
      path.resolve(params.flow_file) !== path.resolve(expected))
  ) {
    throw new FailureError(
      `Invalid flow_file "${params.flow_file}": it must resolve to the flow's path under the ` +
        `project root ("${expected}"). flow_file is internal — leave it unset and pass ` +
        `project_root + name.`,
      {
        error_code: FAILURE_CODES.FLOW_FILE_INVALID,
        failure_stage: "flow_file_containment",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  const spelling = await classifyOnDiskSpelling(path.dirname(expected), `${flowName}.yaml`);
  if (spelling.state === "case_folded") {
    const recovery = spelling.addressable
      ? `Pass name "${path.basename(spelling.actual, ".yaml")}".`
      : `Rename "${spelling.actual}" to "${flowName}.yaml" to run it — flow files must be ` +
        `lowercase .yaml.`;
    throw new FailureError(
      `Invalid flow name "${flowName}": no saved flow is named "${flowName}.yaml" — this ` +
        `filesystem matched it case-insensitively to "${spelling.actual}", so the flow name ` +
        `(which keys the report and __baselines__/) would be one no directory entry carries. ` +
        recovery,
      {
        error_code: FAILURE_CODES.FLOW_NAME_INVALID,
        failure_stage: "flow_name_casing",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  return { filePath: params.flow_file || expected, flowName, viaUpload: false };
}
