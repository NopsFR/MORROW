# MORROW design system

> A sophisticated computational environment that happens to be living inside your computer.

Source of truth: `packages/design-system/src`. Primitives: `packages/ui/src`.
Tokens are defined in TypeScript and emitted at build time as CSS custom properties
(`--m-*`) through the Vite module `virtual:morrow-tokens.css`. They are never injected
at runtime, because the desktop CSP blocks runtime `<style>` elements (D62). Components
reference tokens only. The e2e tests compare the built stylesheet against the TypeScript
tokens.

## Principle

The interface communicates state through structure, light and depth, not decoration.
Every element must communicate identity, communicate state, improve comprehension, or
establish atmosphere; otherwise it does not exist. **Only real state moves anything.**
No progress is estimated, and no activity is simulated.

## Colour: an ink-teal room and two lights

A deep ink-teal environment (never `#000`), warm off-white text, and two lights with
distinct jobs (D67):

| Light | Token | Value | Meaning |
|---|---|---|---|
| **Brass** | `accent` (`-bright`, `-muted`, `-line`, `-glow`) | `#c9b58a` | MORROW itself: identity, focus, primary intent, and MORROW waiting on you |
| **Signal** | `signal` (`-muted`, `-line`, `-glow`) | `#5fd0c4` | Something live, right now: planning, executing, verifying |

| Token | Value | Use |
|---|---|---|
| `background-deep` / `background` | `#03070a` / `#060c10` | The room |
| `surface` / `surface-raised` / `surface-inset` | `#0a1418` / `#0f1b20` / `#04090c` | Opaque fallbacks and wells |
| `border-subtle` / `border` / `border-strong` | `#132126` / `#1d2c32` / `#2e434a` | Structure lines |
| `text-primary` / `secondary` / `muted` / `disabled` | `#ece9e1` / `#aab3b0` / `#7a8784` / `#3f4b4a` | Text hierarchy (muted ≥ 4.5:1 on panels) |
| `success` / `warning` / `error` / `info` | `#9cc597` / `#e2a35e` / `#e57b72` / `#8aaee0` | Outcome and risk only |
| `smoke` / `smoke-deep` / `floor-lift` | `#4f7a8c` / `#1d3a4a` / `#0a1820` | The environment only |

Task statuses map onto these: live statuses are signal, awaiting permission is brass,
completed is success, failed is error, and everything else is neutral (`views/format.ts`).

## Material: glass in tiers of depth

Glass is a material, not a blur on every box (`.m-panel`). Each plane has three parts:

- **Body:** a low-alpha tint over a backdrop blur, so the environment shows through.
- **Edge:** a 1px gradient border that catches light at the top and fades below
  (a masked `::before`).
- **Sheen:** a faint specular gradient across the top. The hero plane adds a broad
  sheen from the top-left.

| Tier | Token / blur | Use |
|---|---|---|
| `hero` | `glass-hero` 0.44 · 42px · `elevation-hero` (soft cool and warm bloom) | One per screen, where its purpose lives: the workspace command surface, the task overview |
| `raised` | `glass-raised` 0.68 · 30px · `e2` | What sits forward: decisions, the result, previews |
| `glass` | `glass` 0.55 · 22px · `e1` | Panels: sections, settings, history |
| `chip` | `glass-chip` 0.5 · 12px | Small planes inside others |
| `deep` | `glass-deep` 0.62 | The shell's rail and bar; wells inside panels |

Glass alpha stays between 0.4 and 0.8 (tested). Hierarchy comes from depth (blur, alpha,
shadow, light), not from louder borders.

## Typography

IBM Plex Sans for reading and IBM Plex Mono for identifiers, times, metadata and the
`label` register (uppercase, tracked). Both are bundled, so MORROW renders identically
offline.

Scale: `micro 10.5 · label 11 · meta 11.5 · bodySmall 12.5 · body 13.5 · bodyLarge 15 ·
title 17 · heading 24/300 · hero 38/300 · display 28 (mono wordmark)`. Large text is
light-weight and tightly tracked. There is one hero headline per screen.

## Geometry and size

Radii: `xs 3 · sm 5 · md 8` for controls, `lg 12 · xl 16` for planes, and `hero 22` for
the hero only (rounded, never bubbly); `pill` for counts and presence. Controls are
`28 / 34 / 44px`, icons `14 / 16 / 20px`. Shell: rail `84px`, bar `56px`, side panel
`320px`, reading column `780px`, content `1180px`, hero `920px`.

## Icons

`packages/ui/src/icons.tsx`: one family on a 20-unit grid, 1.3 stroke, square caps,
mitred joins. Each icon is a product concept: the sections, task, permission,
capability, runtime, plan, activity, evidence, verify, search, settings, and the controls.
Icons inherit colour and always carry a name or an accessible label.

## Controls and states

- **Buttons.** `primary` is brass light: the one filled control in a context (Start,
  Accept on a single decision). `quiet` is a small glass plane, `ghost` is text until
  hovered, and `danger` turns red only on hover. In lists, actions are quiet.
- **Inputs.** `Input`, `SearchField` and `TextArea` are recessed wells. Focus lights the
  edge brass.
- **Segmented.** A radio group for a few real options (status filters), with counts.
  One tab stop; the arrow keys move the choice.
- **Focus.** One focus treatment everywhere: a brass line with a soft light, keyboard
  only (`:focus-visible`).
- **Loading.** `Progress` is a thin line with travelling signal light, shown only while a
  real request is in flight.
- **Empty and error.** `EmptyState` says what is absent and why. `ErrorState` says what
  failed.
- **State marks.** Small squares; live ones emit light and breathe, only while live.

## Motion

Six semantic categories (`motion.ts`). The farther away and larger a thing is, the
slower it moves:

| Category | Duration | For |
|---|---|---|
| INSTANT | 0 | State that must read immediately |
| FAST | 110ms | Hover, press, focus |
| SHORT | 180ms | Small reveals, status changes |
| MEDIUM | 320ms | Panels entering, expanding, selection moving |
| LONG | 640ms (expo-out) | Cinematic: views and planes arriving, the environment responding to state |
| AMBIENT | 40s | Environmental drift |

- **Arrivals.** Planes slide in from their edge. Pages and panels rise in with a brief
  blur, staggered by 50ms.
- **Live state.**
  - The current lifecycle stage glows and breathes, and its connector carries a moving
    light.
  - A running verification pulses.
  - A newly recorded observation arrives with a flash of signal light.
  - All of this happens only while the record says so.
- **Reduced motion.** Under `prefers-reduced-motion`, durations collapse and every
  ambient, looping and arrival animation stops. State is still shown, instantly.

## Environment

`apps/desktop/src/environment`. Layers, back to front:
1. Ink base.
2. Three distant lights: warm brass at the horizon (MORROW's own light), the room's
   constant cool light, and the **teal signal light**, which rises only with live work
   (`ambient.signal`).
3. A faint light shaft from above.
4. A floor receding to a horizon (it flows while executing).
5. Far fog, rising smoke and near fog.
6. Grain and vignette.

The layers sit at three depths and shift a few pixels with the pointer (parallax; never
under reduced motion). The only input is the ambient state derived from real runtime
state (`runtime/ambient.ts`):

| State | Trigger | Behaviour |
|---|---|---|
| IDLE | nothing open | slow drift; signal dark |
| LISTENING | composing, or awaiting permission | fog thins, light rises slightly |
| PLANNING | a task is planning | structure converges; signal rises |
| EXECUTING | a task is executing or observing | the floor flows; signal at full |
| WAITING | blocked outside MORROW | dimmer, slower; signal dark |
| VERIFYING | a task is verifying | gathered and still; signal high |
| RECOVERING | a task is recovering | partial convergence, some flow |
| COMPLETED | transient, 2.4s | settles |
| FAILED | transient, 1.4s | brief destabilisation, then recovery |

There is no starfield, node graph or particle field.

## Shell (D64, D68)

- **Rail.** Floating deep glass. The identity at the top, the work sections (Workspace,
  Projects, Memory), then Settings at the bottom. The active section is a lit tile with a
  brass edge. Its only badge is the decisions waiting on you.
- **Presence bar.** Floating deep glass:
  - left: where you are (section, plus the open task or settings page);
  - centre: one derived presence (`runtime/presence.ts`);
  - right: the Objective entry point (Ctrl/⌘+K), the model and the runtime, each leading
    to where it is acted on.
- **Stage.** Sections render here. Pages are a header (a lit glyph tile, a light heading,
  the purpose) above glass panels.
- **Settings.** A glass index of pages backed by real runtime state: Models (providers,
  models, and per-purpose routing over the existing preferences), Permissions (standing
  grants, revocable), Capabilities (registered tools) and System. There is no account,
  appearance or device page, because no such settings exist.

The native window frame is kept (D66).

## Workspace

- **Hero (idle).** The largest plane:
  - the MORROW wordmark;
  - the presence as the headline ("Ready", "Executing · …", "Waiting for your decision");
  - the model as detail;
  - counts of open, completed and failed tasks from the loaded records (labelled "latest
    50" when capped), each opening the history filtered to exactly those;
  - the command field with its Start button.
- Below it: decisions waiting on you, then in progress and recent (each with the answer
  or the recorded reason), then capabilities beside standing permissions.
- **Task open.** The task's live view fills the stage. The command field docks below as a
  single line.
- **History** is a glass panel opened from the presence bar or a hero count:
  - search and a status filter over the loaded tasks;
  - day groups that never reorder the records (newest first, as the runtime lists them);
  - a hover/focus preview of the objective and its outcome.
  
  On narrow windows it takes the stage, and steps aside once a task is chosen.

## Task view

- **Overview (hero).** Status, id, objective, what MORROW is doing, facts, and the
  **lifecycle**: Plan → Execute → Evidence → Verify → Outcome (`lifecycleOf`, D69). Each
  stage is read from the record:
  - done: the plan, steps, executions, observations or verification exist;
  - current: the task's status says so;
  - failed: the `TASK_FAILED` event names the state it failed from;
  - none: passed with nothing recorded;
  - pending: not reached.
- **Decisions** waiting on you come first: raised glass with a brass edge.
- **Result.** Raised glass, lit green when verified and amber when not.
- **The record.** Glass panels: plan, verification (labelled *checked by MORROW* or
  *judged by the model*), observations and artifacts, beside the activity timeline.
  Tool calls expand in place.

## Identity

The rail mark and the app icon are **placeholders** (a frame with a horizon line,
`assets/brand/placeholder-mark.svg`). They are intentionally plain and must be
replaced by a real MORROW mark.

## Design previews

Screens whose architecture does not exist yet may be designed as previews that exist
only in development builds and say so on screen. Today there is one:
`#preview/auth` (see `docs/authentication.md`). Production builds contain none (tested).

## Avoid

Generic dashboard grids and widgets, template look, chatbot framing, cyberpunk and
RGB, neon outlines everywhere, a screen of unrelated glass cards, giant gradients behind
text, starfields and node graphs, greeting copy, simulated progress, and any element
that does not correspond to real state or a real product concept.
