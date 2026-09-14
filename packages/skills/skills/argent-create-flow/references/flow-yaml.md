# Flow YAML

Read this reference when polishing, composing, or manually reviewing a flow.

- [Flow YAML](#flow-yaml)
  - [File shape and flow type](#file-shape-and-flow-type)
  - [Selectors](#selectors)
    - [The runner tree is not the discovery tree](#the-runner-tree-is-not-the-discovery-tree)
    - [Relational scopes](#relational-scopes)
  - [Directives](#directives)
    - [`swipe`](#swipe)
  - [Verification conditions](#verification-conditions)
  - [Prove a navigation: identity, then readiness](#prove-a-navigation-identity-then-readiness)
    - [`idle` readiness](#idle-readiness)
  - [Optional divergences](#optional-divergences)
  - [Composition and platform limits](#composition-and-platform-limits)
  - [Local scripts](#local-scripts)
  - [Environment values](#environment-values)
  - [Script output](#script-output)
    - [The output document](#the-output-document)
    - [References](#references)
    - [Recording script output](#recording-script-output)
  - [Snapshots and standalone runs](#snapshots-and-standalone-runs)
  - [YAML safety](#yaml-safety)

## File shape and flow type

```yaml
steps:
  - launch: com.example.app
  - await: { visible: { id: home-screen } }
  - await: { idle: true }
```

An e2e flow has a literal `launch:` as its first step that is not `echo:` or `script:`. It cannot declare `executionPrerequisite`. Put the named start state in a leading echo.

A leading `run:` does not classify the outer flow as e2e, but the runner still follows the chain to the launch it reaches, and on Chromium that launch boots the app before step 1. A flow whose `run:` chain reaches a launch is refused an `executionPrerequisite` too: parse accepts the file, then the run rejects it. The one exception is a run pinned to a Chromium instance you brought to the required state yourself (`--device chromium-cdp-<port>`), where that leading launch only attaches.

A fragment reaches no leading launch, by its own step or through a `run:` chain, and can declare:

```yaml
executionPrerequisite: User is signed in and viewing Settings
steps: []
```

Flows never store a device id. The runner binds the device. `launch:` restarts the process but does not clear app, account, or backend data.

The one exception is a device _scope_ rather than a target: `stop-all-simulator-servers`' `devices` list **is** kept in the YAML, because without it the step means the machine-wide sweep and would tear down devices other agents are mid-session on. Replay rebinds a recorded scope only when you pass `device` explicitly — an auto-detected device would retarget the teardown at a device the flow never named. So the recorded ids are what run when you replay without `device`; on another host they reap nothing and come back in `unmatched`, so re-record the cleanup flow there or pass `device`. A step that recorded no scope is narrowed onto the run's device **only when the run resolved one**. A cleanup flow whose only step is that teardown needs no device, so with none or several booted it resolves none, replays as the machine-wide sweep, and still reports a pass. Record the scope, or pass `device` at replay, whenever the sweep must stay confined.

## Selectors

Use values that meet the [stable-selector definition](../SKILL.md#stable-selectors). Always write explicit maps:

```yaml
{ id: save-button }
{ text: Save }
{ role: button }
{ id: settings-row, text: Notifications }
```

All provided fields must match. `id` is exact and case-insensitive. `text` and `role` are case-insensitive substrings. An unqualified Android id also matches its qualified resource id. `identifier` is accepted as an alias, but `id` is canonical. Never author a bare string. It is loose shorthand that tries id before text.

Use single quotes for anchored, case-sensitive regexes:

```yaml
{ text: { matches: '^Order #\d+$' } }
```

### The runner tree is not the discovery tree

Flow selectors and live discovery use different screen projections:

| Platform | Runner tree                                               | `describe` / `await-ui-element` | Important difference                                   |
| -------- | --------------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| iOS      | projected UIView hierarchy                                | accessibility tree              | `native-full-hierarchy` is raw; nodes and roles differ |
| Android  | full accessibility hierarchy                              | trimmed interactables           | Discovery can omit testID containers or merge nodes    |
| Chromium | filtered DOM nodes with id, label, value, click, or focus | shorter DOM walk                | Projections and node limits differ (12,000 vs. 5,000)  |
| Vega     | toolkit page source                                       | same source                     | Same elements, different shape                         |

On iOS, Android, and Chromium, an id absent from `describe` can still resolve in a flow. Verify it in a scratch fragment. Chromium exposes password fields to the runner as `[password]`; select them by id or role.

The recorder rechecks each successful `await-ui-element` against the runner tree. Follow any `message` warning and replay each conversion. On Vega, a mismatch usually means the screen changed. A `text` check can also select different elements from the same source. See [Live waits and checks](live-authoring.md#live-waits-and-checks).

**On iOS, a `launch:` step also decides which app the runner reads.** A successful `launch:` pins later runner-tree reads to that app, so a read probes only that app instead of fanning out over every connected one to find the frontmost. A pinned read still refuses, naming the reason, when the app has no foreground presence left, when it stops answering after an earlier read got through, when its devtools connection dropped, or when the pinned id is a `com.apple.*` system app.

Any raw `tool:` step ends the pin, because its effect on the screen is opaque to the runner, and reads auto-detect the frontmost app again until the next `launch:` re-pins. A tool that cannot change the foreground app leaves the launched id as an unpinned fallback, which takes the read only when auto-detection times out and the launched app vouches for itself with a probe of its own. `launch-app`, `restart-app`, `reinstall-app`, `open-url`, and `button` drop even that; `launch-app` and `restart-app` replace it with the app they just started, still unpinned. Nested `run:` fragments inherit both the pin and its clearing.

So on iOS recording and replay can read different apps, not only different projections: recording has no run state and always auto-detects the frontmost connected app, while a replay read between a `launch:` and the next raw `tool:` step reads the launched app.

**On iOS, never copy a `role` from `describe` into a flow selector.** The runner derives iOS roles from the UIView class name and `describe` from accessibility traits, so a React Native `Pressable` (class `RCTView`) is `AXGroup` to the runner and `AXButton` to `describe`. Select on `id`/`text`, or confirm the role against the runner's own tree.

When several nodes match, the directive decides:

- **Actions** (`tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`) take the most specific visible match: exact text/id beats substring, then the smallest frame, then reading order.
- **Conditions** (`await`, `assert`) do not rank. `exists`/`visible` hold if any match qualifies and `hidden` only if none does; `text` reads the first visible match in reading order.

A container that aggregates a child's text therefore splits them: `tap` hits the leaf while `text.in` reads the container, so `equals` fails against correct UI. Use an `id` or a [relational scope](#relational-scopes) when an action and a check must agree, and a stricter selector when ranking can still choose the wrong element.

### Relational scopes

Flow selectors support frame-based `within`, `after`, and `next` in every selector slot. Live `await-ui-element` does not support them.

```yaml
- tap: { text: Delete, within: { id: profile-card } }
- assert: { visible: { role: Button, after: { text: Danger zone } } }
- tap: { role: Switch, next: { text: Wi-Fi } }
```

`within` means visual frame containment, not source-tree ancestry. Overflowing children and anchored popovers can fall outside it. `after` and `next` use top-to-bottom, left-to-right reading order. A target cannot satisfy its own `within`, `after`, or `next` anchor. The synthetic root never counts.

`next` finds the nearest matching follower and skips non-matches. It can therefore reach the next row when the intended row lacks a control. Prefer a stable row container with `within`, or assert the row-local control first.

Scopes can combine and nest, with at most six scope keys. Use strict selectors for anchors. Scope through a trusted container when a missing control must fail instead of reaching another row.

## Directives

Directives stop the flow on failure and skip later steps. The available directives are `launch`, `tap`, `long-press`, `swipe`, `type`, `scroll-to`, `pinch`, `rotate`, `await`, `assert`, `wait`, `snapshot`, `run`, `script`, `when`, `echo`, and `tool`.

Use the launch map for cross-platform flows. A bare launch applies everywhere and becomes an app path on Chromium. The map takes `native:`, `ios:`, `android:`, `vega:`, and `chromium:`. `native:` is one id shared by iOS, Android, and Vega, and a per-platform key overrides it for that platform. `chromium:` accepts a relative or absolute app path. A launch that declares no id for the run's platform is an error, not a cue to switch platforms. On iOS, a successful launch also pins later tree reads to that app until the next raw `tool:` step, so read [The runner tree is not the discovery tree](#the-runner-tree-is-not-the-discovery-tree) when a read describes the wrong screen.

```yaml
- launch: { native: com.acme.app, chromium: ../../app }
- launch: { ios: com.acme.app, android: com.acme.app.android, chromium: ../../app }
```

An Android app that needs a non-launcher activity has no `launch:` form. Record `restart-app` with `activity` and keep the flow as a fragment.

In a `scroll-to` map, put the selector under `target:`. The map supports `up`, `down`, `left`, and `right` directions. The default is `down`; set it explicitly to reach a target above the viewport or along a horizontal carousel. If the target is already visible, the step is a safe no-op. `tap`, `type`, and `long-press` do not auto-scroll. Add `scroll-to` when the target can be off-screen. Use `within` for a nested scroller.

### `swipe`

`swipe` is one semantic finger flick where the gesture itself is the action — dismiss a card, page a carousel, open a drawer, pull-to-refresh: `- swipe: left`, `- swipe: { from: Card, direction: left }`, `- swipe: { by: { y: -0.4 } }`.

**Never use `swipe` to scroll.** Whenever the goal is "bring X on screen so the next step can act on it", write `scroll-to: <X>` instead: it is goal-seeking (stops exactly when the target appears), momentum-free, and a no-op if the target is already visible.

**`direction` is the finger's travel** (the Maestro convention): `swipe: left` flings content leftward and reveals what is to the right, the opposite sense of `scroll-to`'s content direction. Declare exactly one travel:

- `direction` - Maestro-compatible screen geometry, with edge-gesture-safe start and end points.
- `by: { x?, y? }` - signed 0-1 screen fractions, one axis or both for a diagonal.
- `to: <target>` - an explicit endpoint, selector or point.

`from` anchors the start on a selector or `{ x, y }` point. Without it the start is the direction preset, or screen centre for `to` and `by`.

All three must clear a 0.03 minimum travel on the combined start-to-end vector; shorter reads as a tap and will be rejected/fail.

Anchoring decides how a travel that does not fit is resolved:

- `direction` keeps the preset magnitude from where the finger lands (0.8 of the width for `left`/`right`, 0.7 of the height for `down`, 0.4 for `up`), clamped at the screen edge. It fails only when the clamp leaves it under 0.03, so a drawer handle or bottom sheet near the edge still swipes.
- `by` delivers its exact delta or nothing. With `from`, a delta that runs off-screen fails.

Only the direction presets carry OS-edge margins. A resolved `from` point is used verbatim, so use `from` for app-level gestures only and write system-edge gestures such as system back as raw `tool: gesture-swipe` steps.

`momentum: false` removes the fling, so the swipe lands where the finger stops. The default `momentum: true` is a natural flick that flings on. `duration` (ms) is the travel time: default 300, minimum 150. A shorter gesture gives the content too few frames to track the travel, so it overshoots and may fling backwards. Every `swipe` then waits for the tree to settle, best effort, so its momentum does not swallow the next step's touch.

On Chromium a swipe is a mouse drag (`gesture-drag`), so a `from` on an `<img>`, an `<a href>` or a `draggable="true"` node starts the browser's native drag-and-drop: the page gets `pointerdown` then `pointercancel` and sees no travel. On Vega, `swipe` fails upfront like the other touch directives.

`type` presses Enter in a second `keyboard` call unless `submit: false`. A polished focus tap plus one text-only `keyboard` call usually needs `submit: false`. Store external values as `{{secret:NAME}}`. The runner uses the first source that defines the name: environment `ARGENT_SECRET_NAME`; project `.argent/secrets.env`; project `.env.local`, then `.env`; then `~/.argent/secrets.env`. The two `secrets.env` files accept the bare `NAME`, but the shared dotenv files expose only `ARGENT_SECRET_`-prefixed keys, so a bare `NAME=…` in `.env` or `.env.local` stays unresolved. The runner redacts every resolved value, so do not use a placeholder for content a report must show.

A **selector-less gesture** — a coordinate `tap`/`long-press`/`swipe`, or a `pinch`/`rotate` with no `on:` — resolves no frame, so a tree source it cannot read does not fail it. It settles best effort, dispatches anyway, and the step **passes carrying a warning** that quotes the source's own error. That green says the gesture was sent, not that it landed: one aimed at a moving element can miss it entirely. Restore the tree source, usually by relaunching the app so the instrumentation loads. Accept the warning only where the app serves no tree at all, and put an explicit `wait:` before a gesture that follows a transition. The first such gesture proves the outage and later ones spend that verdict without paying the settle window again. A tree read that comes back, or a relaunch, retires that verdict — which only makes the next gesture pay a fresh window, and it warns again if the source is still down.

## Verification conditions

```yaml
- await: { visible: { id: settings-screen } }
- await: { hidden: { id: loading-spinner }, timeout: 15000 }
- assert: { exists: { id: notifications-toggle } }
- assert: { text: { in: { id: preference-status }, equals: Enabled } }
- assert: { text: { in: { id: result-count }, matches: '^\d+ results$' } }
```

`text.in` locates one element. It compares that element's rendered and descendant text with exactly one comparator:

- `contains`: case-insensitive substring.
- `equals`: case-insensitive full match.
- `matches`: case-sensitive JavaScript regex.

Use `equals` or an anchored regex when boundaries matter. For example, `contains: "Taps: 3"` also matches `Taps: 30`.

Use `await` for an outcome that can take time. Its default is 7500 ms. Add a larger timeout only after the default expires. Use `assert` for settled state. It has a fixed 1000 ms grace and rejects `timeout`.

A negative condition proves only that the current tree has no visible match. It also passes before the element appears, for a typo, or on the wrong screen. First prove the containing screen and the same stable selector as `visible`. Then perform the removing action and check `hidden`. Prefer an additional positive replacement or empty state.

## Prove a navigation: identity, then readiness

Every screen change needs both checks:

```yaml
- await: { visible: { id: profile-screen } }
- await: { idle: true }
```

The identity selector must exist only on the destination. A dropped tap can leave the source screen idle. A destination element can enter the tree before its animation finishes. Therefore neither check replaces the other.

### `idle` readiness

`idle` waits until the screen has content and stops changing in both the UI tree and pixels.

```yaml
- await: { idle: true, stableFor: 400, timeout: 9000 }
```

`stableFor` (default 250) is how long stillness must hold. `timeout` (default 7500) is the budget for the whole wait, and parse rejects one that cannot contain a settle. A settle spans three reads across two 200ms polls. The floor is the longer of `stableFor` and the 400ms a settle spans, plus the 200ms of budget the closing round needs to start. The hold runs during those polls rather than after them, so only the longer of the two counts: the default 250ms hold needs 600ms and an 800ms hold needs 1000ms. Stillness is measured across intervals, so `stableFor: 0` means the first two agreeing intervals, not the first read. `idle` has no assert form and no `when:` form.

It **never fails a run.** Every outcome short of a clean settle passes with a warning, because readiness is not an acceptance criterion. Read that warning rather than stepping over it:

- **the screen never held still** — it spent the timeout and was still moving on the last interval. A video, shimmer, carousel, or live text stays healthy while moving, and a load that never finished looks identical.
- **a small part of it was still changing** — a spinner, caret, or progress dot moved through the hold. Too small to count as the screen moving, so the settle completed anyway.
- **the screen was still for the last Nms** — the wait ran out mid-hold, so no settle was confirmed. It names the term that was short: a second agreeing interval, or the rest of `stableFor`. Raise this step's `timeout:`, because the wait was too short rather than the screen too busy.
- **the tree stayed empty** — the screen rendered no accessible content: a canvas or video surface, or a screen that never arrived.
- **settled on the UI tree alone** — no screenshot pair could be read, so presentation-layer animation was never waited out.
- **too few reads** — a settle needs three reads across two intervals and this step got fewer, so it ended with no evidence either way.

Only a tree source this step could not read stops the run, as an errored step — one still failing when the wait ends, one that wedges after answering, one that answers with an empty tree it flags as degraded (an unattached Vega toolkit, an AX service asking to be relaunched), or one that never answers (raise `timeout` before suspecting the app). The run is then not ok and every later step is skipped. A single failed read is not that: the hold restarts from the next good read. The same outage stops no [selector-less gesture](#directives), which needs no frame and passes with its own warning instead.

`idle` proves readiness only and never identifies the screen, so it cannot serve as acceptance evidence or replace the identity gate. Gate the next action on a stable element. Add `idle` during polish after each screen change, not after every step.

## Optional divergences

Use `when:` only for optional setup or an interstitial that reconverges:

```yaml
- when: { visible: { text: Got it } }
  steps:
    - tap: { text: Got it }
```

The guard accepts one `exists`, `visible`, `hidden`, or `text` condition, or `{ platform: ios|android|chromium|vega }`. UI guards use the short assert grace and reject `timeout`. There is no `else` or per-step `optional`. Put separate behavioral paths in separate flows. Never place a required acceptance check inside `when:`.

## Composition and platform limits

A `run:` target is a YAML path resolved against the directory of the flow file containing the step, so `../shared/login.yaml` reaches a sibling directory rather than the project root. The `.yaml` suffix is optional: `run: login` and `run: login.yaml` both name `login.yaml` beside the flow.

- iOS and Android can run fragments or e2e flows inline. A nested e2e launch restarts its app.
- Chromium boots one instance per launch **step**, not one per run. The leading launch — the flow's own, or the one its leading `run:` chain reaches — boots before step 1, unless you pinned the run with an explicit `device`, where it only attaches. Every later launch boots a fresh instance, moves the run onto it, and tears down the instance the run already owned for that app path. Nesting a Chromium e2e flow with its own launch is therefore the supported way to give a sub-scenario its own restart. Chromium rejects `pinch` and `rotate`. Use the app's own zoom or rotate controls.
- Vega uses `tool: tv-remote` and raw `tool: keyboard`. The touch directives (`tap`, `long-press`, `swipe`, `type`, `scroll-to`, `pinch`, `rotate`) are unsupported. Gate focus and navigation results with `await`.

## Local scripts

Use a local `.mjs` or `.sh` script only when the user requests one. Record it with `flow-add-script` at the point where it must run.

```yaml
- script: { path: ../../scripts/seed-order.mjs }
- script: { path: ../../scripts/seed-order.sh }
- script: { path: ../../scripts/seed-order.mjs, timeout: 60000 }
```

An `.mjs` file runs under Node.js. A `.sh` file runs under Bash.

Use the map form shown above. A bare `script: scripts/seed.mjs` is invalid.

- **`path`** is relative to the flow file that contains the step. Use the lowercase extension `.mjs` or `.sh`. Match the file name's letter case.
- **`timeout`** is optional and uses milliseconds. The default is 30000. The minimum is 100.
- **`env`** supplies [environment values](#environment-values) for this script.

If `flow-add-script` cannot access the file, finish the recording. Add the step to YAML, then replay it locally.

Argent uses `project_root` as the working directory of the script.

If a script fails, check its changes before you retry.

For Bash scripts, a nonzero exit code fails the step. Write failure explanations to stderr.

A script can return data for later steps. See [Script output](#script-output).

## Environment values

Use top-level `env` for script defaults and `script.env` for one step:

```yaml
env:
  API_URL: https://api.example.com
steps:
  - script:
      path: ../../scripts/seed.mjs
      env:
        API_KEY: "{{secret:API_KEY}}"
        USER_TYPE: premium
```

Read values with `process.env.NAME` in `.mjs` or `$NAME` in `.sh`. Override defaults with `flow-execute`'s `env` or `argent flow run <name> --env NAME=value`. Precedence, highest first: script step, run values, nested flow defaults, parent defaults, allowed host variables.

A `run:` inherits values; its defaults apply only inside that flow. A raw `tool: flow-execute` starts a separate run: pass values in `args.env`.

Use string values; quote numbers and booleans. Top-level `env`, `--env` and `flow-execute`'s `env` reject `{{output:…}}` references, because they resolve before any script runs. A script step's own `env` resolves [output references](#references) first, then `{{secret:NAME}}`. Each `args.env` value of a raw `tool: flow-execute` step resolves in the parent run: this is how a child run gets a value from the parent's output document. The child run rejects a resolved value that contains the literal text `{{output:`.

Use `{{secret:NAME}}` for credentials. Ask the user to configure missing secrets by name, never to provide their values. Plaintext `env` values and returned output documents are not redacted. Do not put credentials in logs or output documents.

`scripts.env.allow` adds names inherited from the tool-server. A later shell `export` does not update it: pass fresh values (including `PATH`) through `env` or restart the tool-server.

## Script output

A script step can return an output document. Later steps read it with `{{output:…}}` references.

```yaml
- script: { path: ../../scripts/create-user.mjs }
- type: { into: { id: user-name }, text: "{{output:user.displayName}}" }
- type: { into: { id: promo }, text: "{{output:user.promo.code ?? 'NONE'}}" }
- echo: "Region {{output:user.region ?? defaults.region ?? 'unknown'}}"
- tool: keyboard
  args: { text: "{{output:codes[0]}}" }
- echo: "Order {{output:order['order-id']}}"
```

### The output document

- Each run has one document: a JSON object that starts empty. `run:` fragments and `when` blocks use the document of the flow that runs them and keep what their scripts wrote, unlike `env` defaults. A `tool: flow-execute` step starts a separate run with its own empty document.
- In `.mjs`, the document is the `output` global. Change it (`output.user = user;`) or assign a new object (`output = { user, orderId };`).
- In `.sh`, `$ARGENT_OUTPUT` names a file that holds the document when the script starts. Write the document back to that file. Never redirect a command into the file it reads, because the shell empties the file first. Write a second file and move it:

  ```bash
  jq --argjson user "$user" '. + {user: $user}' "$ARGENT_OUTPUT" > "$ARGENT_OUTPUT.new" \
    && mv "$ARGENT_OUTPUT.new" "$ARGENT_OUTPUT"
  ```

- After a script step passes, Argent merges `{ ...current, ...returned }`. A top-level key the script writes replaces that key's whole value. A key it does not write keeps its value, so a `.sh` that writes only `order` keeps the `user` an earlier `.mjs` wrote, and the opposite order works too. A script cannot remove a key: set it to `null`. A failed or errored step's document is ignored.
- Limits: 1 MiB encoded for each script's document and for the merged document (a merge past it fails the step), 4096 levels, finite numbers, no own `__proto__` key. In `.mjs`, an `undefined` member is dropped and an `undefined` array element becomes `null`. A function, symbol, BigInt, Date, Map, Set, class instance, NaN, Infinity or cycle fails the step.
- JSON can round an integer above 9007199254740991 (the step passes with a warning naming the first path) and returns `9.90` as `9.9`. Have scripts write ids, prices and codes as strings.
- The document is not secret storage, and Argent never redacts it. An `echo` can print a value from it, a later script's log can hold one, and a resolved value in a later script's `env` is not treated as a secret.

### References

- Syntax: `{{output:`, a path, any number of `?? operand` fallbacks, then `}}`. A path starts with a name and continues with `.name`, `[0]`, `['key']` or `["key"]`. An operand is a path or a literal: a quoted string (a backslash escapes the next character), a JSON number, `true`, `false` or `null`. Whitespace is allowed between tokens, not inside a path or a number. An index other than `0` cannot start with `0`.
- `true`, `false` and `null` are literals. Read a key with one of those names, or a key that is not a name, with brackets: `flags["null"]`, `order["order-id"]`. A top-level key must be a name. The first `}}` ends the reference, so a literal cannot contain `}}`.
- `{{ output:x }}`, `{{Output:x}}` and other near spellings are not references. They stay literal text, and nothing reports them.
- `??` is the only operator. There is no concatenation, arithmetic, length, condition, function call, object or array literal, or parentheses. Compute values in the script.
- Always quote a value that holds a reference. An unquoted `echo: {{output:user.id}}` is a YAML map, and the file is rejected.
- Operands are tried left to right. A path gives a value when every segment exists as JSON data (an own key or an array element) and the value is not `null`. `name.length`, `user.constructor`, a key on an array, an index on an object, an index past the end and a segment under a string, number or boolean are missing paths, and `??` covers them. Prefer `{{output:promo.code ?? 'none'}}` over making a script write every key.
- If no operand gives a value, the step errors. The reason names the field, the path and the segment where it stopped, such as `` `output.user` has no `promo` ``. In a `when` guard, this errors the run instead of skipping the block.
- Each field resolves once, right before its step. A skipped step resolves nothing. A resolved value is never scanned for references again.
- Reference fields: `echo` messages; selector `text`, `id` and `role`, scopes included; `when` guard selectors and expected text; `type` text; `contains` and `equals` text; string values in `tool` `args`; a script step's `env`. Parse rejects a reference in script and `run` paths, `launch` values, snapshot names, `executionPrerequisite`, a `tool` step's tool name, any `matches` pattern, the `flow_path`, `project_root`, `name` and `flow_file` of `tool: flow-execute`, and the `tool` names in `tool: run-sequence` steps.
- Types: a value in `args` that is one whole reference keeps its JSON type, and a final `?? null` passes JSON `null`. The tool can reject that type: `tool: keyboard` rejects a number in `text`, so have the script write a string, or use a `type:` step. Everywhere else, including an `args` value with other text around the reference, a string, number or boolean becomes text. An object, array or `null` is an error there, except in `echo`, which prints compact one-line JSON. Argent cuts a resolved echo message at 65,536 characters.
- Selector `text` (needs a visible character), `id`, `role`, `contains` and `equals` text, and `type` text reject an empty result. Use `?? ''` only in `echo`, next to other text, or in `args`. Elsewhere pick a literal that fits the field.
- Write each `{{secret:NAME}}` whole in the file. A resolved value that supplies any character of a placeholder stops the step, and so does a whole-field `args` object that holds one.
- Step reports keep references as written, except `echo`, which shows the resolved message. A failure reason ends with each resolved value, such as `(output.order.id = 42)`.
- Parse checks every reference. A `run:` fragment is parsed only when its step starts, so a malformed reference there stops the run after earlier scripts already ran.

### Recording script output

- `flow-add-script` runs each script with the recording's own document and merges a passing result with the same rule. A second recorded script therefore reads the first one's keys, as it will at replay. `outputJson` in the result shows the returned document.
- `flow-add-script`'s `env` accepts references. They resolve against the recording's document for the live run, and the file saves the reference, not the value. An unresolved reference stops the call before the script runs, and nothing is recorded. For example, record `scripts/login.sh`, which writes `output.auth.token`. Then record `scripts/create-order.sh` with `env: { TOKEN: "{{output:auth.token}}" }`.
- `flow-add-step` resolves `args` references before the tool runs. An unresolved reference stops the call before the device acts.
- `flow-add-echo` records a message that does not resolve yet, and `message` carries a warning.
- Two recording calls that run at the same time can start from the same document. The call that appends second warns in `message`. Its step is already in the file, so calling it again appends a second step.
- When `flow-add-step` records a `flow-execute` call as a `run:` step and the fragment has a script step or a reference, the result warns. The live call started with an empty document, so replay can differ.

## Snapshots and standalone runs

`argent flow run <name> [--device <id>] [--platform ios|android|chromium|vega] [--update-baselines] [--output <dir>] [--env NAME=value] [--json]` runs without an LLM and exits non-zero on failure. Repeat `--env` for each variable; quote values with spaces: `--env "LABEL=Test account"`.

A screenshot is human evidence. A `snapshot:` is executable visual verification. A missing baseline or excessive mismatch fails. A `cropOn` size change also fails. Use snapshots for color, layout, size, spacing, typography, clipping, overflow, images, icons, or stable component appearance. Use full screen for global changes and `cropOn` for one component.

Do not use a snapshot as the only proof of navigation, persistence, data, accessibility state, logs, or network behavior. Avoid unstable timestamps, live data, ads, animation, and device drift. First establish deterministic state, identity, and readiness.

Baselines live under `.argent/flows/__baselines__/<flow>/` and are keyed by platform and full-capture geometry; `cropOn` also contributes its selector. Seed from a known-good state with `--update-baselines`. Inspect every baseline and require user review. Do not commit it yourself. Baseline creation or update is not a test pass. Never update a baseline only to make a diff pass. The default `maxMismatch` is 0.5 percent.

Pin `--platform` and `--device` for iOS, Android, or Vega. For Chromium the device class is the window's own pixel size, which the app sets and no launch argument changes: pass `--platform chromium` and omit `--device` so the runner boots the declared app path instead of attaching to a running window of another size. A window sized from host or session state produces a key CI cannot reproduce, and the step fails for a missing baseline. The runner pins mobile status bars during visual runs. `--output <dir>` writes failed baseline, current, and diff images under `<dir>/<flow>/` for CI artifact upload.

## YAML safety

Quote strings containing `#`, `:`, quotes, or an `{{output:…}}` reference. Quote numbers and `true` or `false` in text slots. Use single quotes for regexes with backslashes. Parsing rejects invalid directives, selectors, regexes, `else`, unsupported options, and e2e flows that also declare `executionPrerequisite`.
