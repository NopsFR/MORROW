import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@morrow/shared";
import { openDatabase } from "@morrow/database";
import type { Criterion, Observation, TaskStep } from "@morrow/schemas";
import {
  criteriaProblem,
  evaluateVerification,
  excerptInObservation,
  specificReferences,
  type Runtime,
} from "@morrow/agent";
import { readTaskDetail } from "../../agent/src/host/task-detail";
import { AGENT, MIGRATIONS, tempDir, testRuntime, USER } from "./helpers";
import {
  ScriptedOllama,
  callTool,
  completeStep,
  composeCitingAll,
  criteriaRevision,
  plan,
  replanProposal,
  requestReplan,
  verdict,
  verdicts,
  type ChatCall,
  type CriterionSpec,
} from "./scripted-ollama";

/**
 * Agent Core 2.2 — grounded verification (D54 → D55). Success criteria must come from
 * the objective; verification must rest on evidence MORROW can find itself.
 */

async function setup(options: { dataDir?: string; maxReplans?: number } = {}) {
  const ollama = new ScriptedOllama();
  const rt = testRuntime({
    fetch: ollama.fetch,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.maxReplans !== undefined ? { limits: { maxActionsPerStep: 6, maxToolCallsPerTask: 24, maxReplans: options.maxReplans } } : {}),
  });
  rt.modelService.ensureDefaultProviders();
  await rt.modelService.refresh();
  return { rt, ollama };
}

function project(rt: Runtime, files: Record<string, string>) {
  const root = tempDir("morrow-ws-");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const now = rt.clock.now();
  const p = { id: newId("project", now), name: "Orbit", description: null, rootPath: root, createdAt: now, updatedAt: now, archivedAt: null };
  rt.repos.projects.insert(p);
  return p;
}
const PYPROJECT = { "pyproject.toml": '[project]\nname = "orbit"\nversion = "2.4.1"\n', "README.md": "# orbit\n" };
const CARGO = { "Cargo.toml": '[package]\nname = "orbit"\nversion = "0.4.2"\n' };

function allowAll(rt: Runtime) {
  rt.bus.subscribeTo("TOOL_PERMISSION_REQUIRED", (e) => {
    queueMicrotask(() => rt.permissionAuthority.respond({ requestId: e.payload.requestId, decision: "ALLOW", scope: "ONE_TIME" }));
  });
}

/** Evidence as a verifier quoting the prompt would give it: the observation whose data contains `text`. */
function evidenceFor(prompt: string, text: string) {
  // Text inside a JSON string appears escaped in the prompt; JSON structure appears as is.
  const escaped = JSON.stringify(text).slice(1, -1);
  for (const m of prompt.matchAll(/observation (obs_[0-9A-Z]{26}):\n(.*)/g)) {
    if (m[2]!.includes(escaped) || m[2]!.includes(text)) return [{ observationId: m[1]!, excerpt: text }];
  }
  throw new Error(`no observation in the prompt contains ${text}`);
}

const types = (rt: Runtime, taskId: string) => rt.eventLog.list({ taskId: taskId as never, limit: 1000 }).map((e) => e.type);
const problems = (rt: Runtime, taskId: string) =>
  rt.eventLog
    .list({ taskId: taskId as never, types: ["MODEL_RESPONDED"], limit: 1000 })
    .flatMap((e) => (e.type === "MODEL_RESPONDED" && e.payload.problem ? [e.payload.problem] : []));

/** "Find the project's version." — a grounded criterion, with a guess about the source kept in `evidence`. */
const VERSION: CriterionSpec = {
  requirement: "The project's version is determined and stated",
  objectiveBasis: "the project's version",
  evidence: "a project manifest or configuration file that declares the version",
};

const READ_PLAN = plan([{ title: "Read the project manifest", tools: ["filesystem.read_text_file"] }], [VERSION]);

describe("grounding rules (runtime, structural)", () => {
  it("finds specific references, not ordinary words or single-letter abbreviations", () => {
    expect(specificReferences('The version is under the [tool.poetry] section of "pyproject.toml"').sort()).toEqual(["pyproject.toml", "tool.poetry"].sort());
    expect(specificReferences("It states the version, e.g. as written by the project's maintainers")).toEqual([]);
    expect(specificReferences("The value is 2.4.1 in src/app_config.py")).toEqual(expect.arrayContaining(["2.4.1", "src/app_config.py"]));
  });

  it("accepts a requirement that restates the objective, in any domain", () => {
    expect(criteriaProblem("Find the project's package version.", [{ requirement: "The project's package version is determined", objectiveBasis: "the project's package version", evidence: "pyproject.toml or package.json", verifiableBy: "OBSERVATION", required: true }])).toBeNull();
    expect(criteriaProblem("Summarise README.md for a new contributor", [{ requirement: "The summary reflects what README.md says", objectiveBasis: "Summarise README.md", evidence: "the README contents", verifiableBy: "OBSERVATION", required: true }])).toBeNull();
  });

  it("rejects requirements that introduce specifics the objective never mentions, in any domain", () => {
    const poetry = criteriaProblem("Find the project's package version.", [{ requirement: "The version is found under the [tool.poetry] section", objectiveBasis: "package version", evidence: "", verifiableBy: "OBSERVATION", required: true }]);
    expect(poetry).toMatch(/introduces "tool\.poetry"/);
    const section = criteriaProblem("Summarise the README", [{ requirement: 'The summary covers the "Installation" section', objectiveBasis: "Summarise the README", evidence: "", verifiableBy: "OBSERVATION", required: true }]);
    expect(section).toMatch(/introduces "Installation"/);
    const value = criteriaProblem("How many tests are there?", [{ requirement: "The count is 1.2k", objectiveBasis: "How many tests", evidence: "", verifiableBy: "OBSERVATION", required: true }]);
    expect(value).toMatch(/introduces "1\.2k"/);
  });

  it("requires the basis to be the user's own words and at least one required criterion", () => {
    expect(criteriaProblem("Find the version", [{ requirement: "The version is found", objectiveBasis: "the release number", evidence: "", verifiableBy: "OBSERVATION", required: true }])).toMatch(/not part of the objective/);
    expect(criteriaProblem("Find the version", [{ requirement: "The version is found", objectiveBasis: "Find the version", evidence: "", verifiableBy: "OBSERVATION", required: false }])).toMatch(/at least one criterion must be required/);
  });
});

describe("direct evidence (runtime)", () => {
  const obs = (data: unknown): Observation => ({ id: newId("observation"), taskId: null, stepId: null, source: { kind: "SYSTEM", subsystem: "test" }, summary: "Read text file succeeded", data: data as never, createdAt: 0 });

  it("finds an excerpt as the model saw it (JSON-escaped) or as written, ignoring case and spacing", () => {
    const o = obs({ path: "pyproject.toml", content: '[project]\nversion = "2.4.1"\n' });
    expect(excerptInObservation('version = \\"2.4.1\\"', o)).toBe(true);
    expect(excerptInObservation('VERSION  =  "2.4.1"', o)).toBe(true);
  });

  it("accepts the hybrid quotes qwen3:4b produced live: JSON structure around unescaped text", () => {
    // Seen live: backslashes un-escaped inside a JSON-looking quote…
    const listing = obs({ directory: "C:\\Users\\me\\ws", matches: [], truncated: false });
    expect(excerptInObservation('{"directory":"C:\\Users\\me\\ws","matches":[],"trunc', listing)).toBe(true);
    // …and literal \n sequences with unescaped quotes.
    const file = obs({ path: "pyproject.toml", content: '[project]\nname = "orbit"\nversion = "2.4.1"\n' });
    expect(excerptInObservation('content: "[project]\\nname = "orbit"\\nversion = "2.4.1"', file)).toBe(true);
    // A Windows path quoted as written is not decoded into a newline.
    expect(excerptInObservation("C:\\new\\bin", obs({ path: "C:\\new\\bin" }))).toBe(true);
    // A failed call, quoted as the prompt renders it ("CODE: message"), keys absent.
    const failed = obs({ outcome: "FAILED", error: { code: "PATH_NOT_FOUND", message: "No such file or directory: C:\\ws\\package.json" }, input: { path: "package.json" } });
    expect(excerptInObservation("PATH_NOT_FOUND: No such file or directory: C:\\ws\\pack", failed)).toBe(true);
    // A paraphrase of a listing whose entries are objects is not a quote.
    const entries = obs({ path: "C:\\ws", entries: [{ name: "pyproject.toml", kind: "file" }, { name: "src", kind: "directory" }] });
    expect(excerptInObservation('entries: ["pyproject.toml", "src"]', entries)).toBe(false);
  });

  it("does not accept text that is not there, or too little to show anything", () => {
    const o = obs({ content: 'version = "2.4.1"' });
    expect(excerptInObservation('version = "9.9.9"', o)).toBe(false);
    expect(excerptInObservation('version = "2.4.2"', o)).toBe(false);
    expect(excerptInObservation("version 241", o)).toBe(false); // separators inside values still count
    expect(excerptInObservation("name = orbit", o)).toBe(false);
    expect(excerptInObservation("v", o)).toBe(false);
    expect(excerptInObservation('"":[]', o)).toBe(false);
  });

  it("decides the outcome from required criteria, preferring a demonstrated failure over everything else", () => {
    const now = 1_800_000_000_000;
    const c = (requirement: string, required = true, origin: "PLAN" | "OBJECTIVE" = "PLAN"): Criterion => ({ id: newId("criterion", now), requirement, objectiveBasis: "x", evidence: "", verifiableBy: "OBSERVATION", required, revisionOf: null, origin });
    const step = { status: "COMPLETED", title: "s" } as TaskStep;
    const o = obs({ content: 'version = "2.4.1"' });
    const met = { status: "SATISFIED" as const, evidence: [{ observationId: o.id, excerpt: 'version = "2.4.1"' }], explanation: "shown", finding: "" };
    const base = { steps: [step], answerObservationIds: [o.id], answersObjective: "FULLY" as const, observations: [o], judgeError: null };
    const run = (criteria: Criterion[], verdicts: object[]) => evaluateVerification({ ...base, criteria, verdicts: verdicts as never }).outcome;
    expect(run([c("a")], [met])).toBe("VERIFIED");
    // An answer that says it did not (fully) accomplish the objective is never verified.
    expect(evaluateVerification({ ...base, answersObjective: "NOT_AT_ALL", criteria: [c("a")], verdicts: [met] }).outcome).toBe("NOT_VERIFIED");
    expect(evaluateVerification({ ...base, answersObjective: "PARTIALLY", criteria: [c("a")], verdicts: [met] }).outcome).toBe("NOT_VERIFIED");
    // The objective itself cannot be "invalid": that claim counts as missing evidence, never as a reason to revise.
    const objective = evaluateVerification({ ...base, criteria: [c("the objective", true, "OBJECTIVE")], verdicts: [{ status: "CRITERION_INVALID", evidence: [], explanation: "x", finding: "" }] });
    expect(objective.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(objective.invalidCriterionIds).toEqual([]);
    expect(run([c("a"), c("b", false)], [met, { status: "NOT_SATISFIED", evidence: [], explanation: "no" }])).toBe("VERIFIED"); // optional never decides
    expect(run([c("a"), c("b")], [met, { status: "SATISFIED", evidence: [], explanation: "trust me" }])).toBe("INSUFFICIENT_EVIDENCE");
    expect(run([c("a"), c("b")], [{ status: "CRITERION_INVALID", evidence: [], explanation: "not asked" }, { status: "INSUFFICIENT_EVIDENCE", evidence: [], explanation: "?" }])).toBe("CRITERIA_INVALID");
    expect(run([c("a"), c("b")], [{ status: "CRITERION_INVALID", evidence: [], explanation: "not asked" }, { status: "NOT_SATISFIED", evidence: [], explanation: "wrong" }])).toBe("NOT_VERIFIED");
    expect(evaluateVerification({ ...base, criteria: [c("a")], verdicts: null, judgeError: "model unavailable" }).outcome).toBe("NOT_VERIFIED");
  });
});

describe("grounded verification (agent loop)", () => {
  it("Test 1 — an objective-grounded criterion becomes task state as proposed", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    ollama.script({ expect: "PLAN", reply: plan([{ title: "Read the manifest", tools: ["filesystem.read_text_file"] }], [{ ...VERSION, objectiveBasis: "the project's package version", requirement: "The project's package version is determined" }]) });
    const task = rt.taskService.create({ objective: "Find the project's package version.", projectId: p.id }, USER);
    await rt.orchestrator.start(task.id); // the next (unscripted) model call leaves the task waiting

    const active = rt.repos.plans.active(task.id)!;
    expect(active.criteria).toHaveLength(2);
    // First, the runtime's own criterion: the objective itself, verbatim.
    expect(active.criteria![0]).toMatchObject({
      origin: "OBJECTIVE",
      requirement: 'The answer accomplishes the objective as stated: "Find the project\'s package version."',
      objectiveBasis: "Find the project's package version.",
      verifiableBy: "OBSERVATION",
      required: true,
    });
    // Then the planner's, as proposed and validated.
    expect(active.criteria![1]).toMatchObject({
      origin: "PLAN",
      requirement: "The project's package version is determined",
      objectiveBasis: "the project's package version",
      verifiableBy: "OBSERVATION",
      required: true,
      revisionOf: null,
    });
    expect(active.successCriteria).toEqual(active.criteria!.map((c) => c.requirement));
    expect(ollama.calls.filter((c) => c.purpose === "PLAN")).toHaveLength(1); // accepted first time
    const created = rt.eventLog.list({ taskId: task.id, types: ["PLAN_CREATED"] })[0]!;
    expect(created.type === "PLAN_CREATED" && created.payload.criteria?.map((c) => c.id)).toEqual(active.criteria!.map((c) => c.id));
  });

  it("Test 2 — a criterion assuming an implementation detail is rejected and regenerated, never trusted", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    const poetry: CriterionSpec = { requirement: "The version is found under the [tool.poetry] section", objectiveBasis: "package version" };
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read pyproject.toml", tools: ["filesystem.read_text_file"] }], [poetry]) },
      { expect: "PLAN", reply: plan([{ title: "Read pyproject.toml", tools: ["filesystem.read_text_file"] }], [{ requirement: "The project's package version is determined", objectiveBasis: "package version", evidence: "the [tool.poetry] section of pyproject.toml" }]) },
    );
    const task = rt.taskService.create({ objective: "Find the project's package version.", projectId: p.id }, USER);
    await rt.orchestrator.start(task.id);

    // The model was told exactly why, and corrected itself; the guess survives only as a hint.
    expect(JSON.stringify(ollama.calls[1]!.body.messages)).toContain('the requirement introduces \\"tool.poetry\\", which the objective does not mention');
    expect(problems(rt, task.id).join(" ")).toContain('introduces "tool.poetry"');
    const [only] = rt.repos.plans.listByTask(task.id);
    expect(only!.criteria![1]!.requirement).toBe("The project's package version is determined");
    expect(only!.criteria![1]!.evidence).toContain("tool.poetry");
    const stored = JSON.stringify([rt.repos.plans.listByTask(task.id), rt.eventLog.list({ taskId: task.id, types: ["PLAN_CREATED"] })]);
    expect(stored).not.toContain("found under the [tool.poetry] section");
  });

  it("Test 2b — if the model insists on an ungrounded criterion, planning fails honestly and nothing is stored", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    const poetry = plan([{ title: "Read pyproject.toml", tools: ["filesystem.read_text_file"] }], [{ requirement: "The version is under [tool.poetry]", objectiveBasis: "package version" }]);
    ollama.script({ expect: "PLAN", reply: poetry }, { expect: "PLAN", reply: poetry });
    const task = rt.taskService.create({ objective: "Find the project's package version.", projectId: p.id }, USER);
    const after = await rt.orchestrator.start(task.id);
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("INVALID_MODEL_OUTPUT");
    expect(after.statusReason?.message).toContain("tool.poetry");
    expect(rt.repos.plans.listByTask(task.id)).toEqual([]);
    expect(types(rt, task.id)).not.toContain("PLAN_CREATED");
  });

  it("Test 3 — a result shown by a real observation is VERIFIED, with the excerpt as direct evidence", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep("Read the manifest") },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "The manifest declares version 2.4.1", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1")) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    const v = done.result!.verification;
    expect(v).toMatchObject({ passed: true, outcome: "VERIFIED" });
    const [obs] = rt.repos.observations.listByTask(task.id);
    expect(v.criteria![1]).toMatchObject({
      status: "SATISFIED",
      modelStatus: "SATISFIED",
      evidence: [{ observationId: obs!.id, excerpt: 'version = "2.4.1"' }],
      assessment: "The manifest declares version 2.4.1",
      note: null,
    });
    const passed = rt.eventLog.list({ taskId: task.id, types: ["VERIFICATION_PASSED"] })[0]!;
    expect(passed.type === "VERIFICATION_PASSED" && passed.payload.outcome).toBe("VERIFIED");
  });

  it("Test 4 — a claimed answer with no supporting observation is never VERIFIED", async () => {
    // (a) Tools ran, but the verdict points at no evidence.
    const a = await setup();
    const pa = project(a.rt, PYPROJECT);
    a.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: verdicts([verdict("SATISFIED", "The answer gives the version")]) },
    );
    allowAll(a.rt);
    const ta = a.rt.taskService.create({ objective: "Find the project's version.", projectId: pa.id }, USER);
    const doneA = await a.rt.orchestrator.start(ta.id);
    expect(doneA.status).toBe("FAILED");
    expect(doneA.statusReason?.code).toBe("INSUFFICIENT_EVIDENCE");
    expect(doneA.result?.verification).toMatchObject({ passed: false, outcome: "INSUFFICIENT_EVIDENCE" });
    expect(doneA.result?.verification.criteria?.[1]).toMatchObject({ modelStatus: "SATISFIED", status: "INSUFFICIENT_EVIDENCE" });
    expect(a.rt.memoryService.list({ taskId: ta.id })).toHaveLength(0);

    // (b) No tool was used at all, yet the answer states a version the criterion needs observed.
    const b = await setup();
    b.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Answer" }], [{ ...VERSION, verifiableBy: "OBSERVATION" }]) },
      { expect: "DECIDE", reply: completeStep("I know it") },
      { expect: "COMPOSE", reply: { answer: "The project's version is 2.4.1.", observationIds: [], answersObjective: "FULLY" } },
      { expect: "VERIFY", reply: verdicts([verdict("SATISFIED", "The answer states 2.4.1")]) },
    );
    const tb = b.rt.taskService.create({ objective: "Find the project's version." }, USER);
    const doneB = await b.rt.orchestrator.start(tb.id);
    expect(doneB.status).toBe("FAILED");
    expect(doneB.result?.verification.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("Test 5 — evidence from a different source than the planner guessed still verifies", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, CARGO);
    const guessed: CriterionSpec = { ...VERSION, evidence: "package.json declares the version" };
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Find the manifest", tools: ["filesystem.list_directory"] }, { title: "Read the manifest", tools: ["filesystem.read_text_file"] }], [guessed]) },
      { expect: "DECIDE", reply: callTool("filesystem.list_directory", { path: "." }) },
      { expect: "DECIDE", reply: completeStep("Found Cargo.toml") },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("Read Cargo.toml") },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 0.4.2.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "Cargo.toml declares 0.4.2", evidenceFor(c.prompt, 'version = "0.4.2"'))], undefined, "0.4.2")) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.result?.verification.outcome).toBe("VERIFIED");
    expect(rt.repos.plans.active(task.id)!.criteria![1]!.evidence).toBe("package.json declares the version");
    const verifyPrompt = ollama.calls.find((c) => c.purpose === "VERIFY")!.prompt;
    expect(verifyPrompt).toContain("evidence hint: package.json declares the version");
    const system = JSON.stringify(ollama.calls.find((c) => c.purpose === "VERIFY")!.body.messages);
    expect(system).toContain("The evidence note of a criterion is only a hint");
  });

  it("Test 6 — citations of observations that do not exist, or excerpts that are not in them, are rejected", async () => {
    // (a) An invented observation id, twice: verification cannot run; nothing is fabricated.
    const a = await setup();
    const pa = project(a.rt, PYPROJECT);
    const invented = verdicts([verdict("SATISFIED", "shown", [{ observationId: newId("observation"), excerpt: 'version = "2.4.1"' }])]);
    a.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: invented },
      { expect: "VERIFY", reply: invented },
    );
    allowAll(a.rt);
    const ta = a.rt.taskService.create({ objective: "Find the project's version.", projectId: pa.id }, USER);
    const doneA = await a.rt.orchestrator.start(ta.id);
    expect(doneA.status).toBe("FAILED");
    expect(doneA.result?.verification.outcome).toBe("NOT_VERIFIED");
    expect(doneA.result?.verification.reasons.join(" ")).toMatch(/Verification could not run/);
    expect(a.rt.repos.observations.listByTask(ta.id)).toHaveLength(1);
    expect(doneA.result?.verification.criteria?.[0]?.evidence).toEqual([]);

    // (b) A real observation, but an excerpt it does not contain: one correction, then accepted.
    const b = await setup();
    const pb = project(b.rt, PYPROJECT);
    b.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "shown", [{ observationId: evidenceFor(c.prompt, "version")[0]!.observationId, excerpt: 'version = "9.9.9"' }])])) },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "shown", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1")) },
    );
    allowAll(b.rt);
    const tb = b.rt.taskService.create({ objective: "Find the project's version.", projectId: pb.id }, USER);
    const doneB = await b.rt.orchestrator.start(tb.id);
    expect(doneB.status).toBe("COMPLETED");
    expect(JSON.stringify(b.ollama.calls.at(-1)!.body.messages)).toContain("each excerpt must be copied exactly from the observation it cites");
  });

  it("Test 6b — an answer that does not do what was asked is not verified, however the planner's criteria were judged", async () => {
    // Seen live (qwen3:4b): "Which license does this project use?" was planned around a
    // licence FILE; none existed (the licence is declared in pyproject.toml), the answer said
    // it "cannot be determined", and the verifier judged the file criterion satisfied from
    // the empty search results. Two independent safeguards now stop that.
    const licenceFile: CriterionSpec = { requirement: "A license file containing the project's license information is found and read", objectiveBasis: "Which license does this project use" };
    const run = async (answersObjective: "FULLY" | "NOT_AT_ALL", objectiveVerdict: ReturnType<typeof verdict> | null) => {
      const { rt, ollama } = await setup();
      const p = project(rt, PYPROJECT);
      ollama.script(
        { expect: "PLAN", reply: plan([{ title: "Find the license file", tools: ["filesystem.find_files"] }], [licenceFile]) },
        { expect: "DECIDE", reply: callTool("filesystem.find_files", { pattern: "LICENSE" }) },
        { expect: "DECIDE", reply: completeStep("No license file") },
        { expect: "COMPOSE", reply: composeCitingAll("The project has no license file, so its license cannot be determined.", answersObjective) },
        {
          expect: "VERIFY",
          reply: (c: ChatCall) => {
            const empty = evidenceFor(c.prompt, '"matches":[]');
            return verdicts([verdict("SATISFIED", "the searches were made", empty)], objectiveVerdict ?? verdict("SATISFIED", "answered", empty));
          },
        },
      );
      allowAll(rt);
      const task = rt.taskService.create({ objective: "Which license does this project use?", projectId: p.id }, USER);
      return rt.orchestrator.start(task.id);
    };

    // (1) The composer's own account: it says it did not accomplish the objective.
    const own = await run("NOT_AT_ALL", null);
    expect(own.status).toBe("FAILED");
    expect(own.result?.verification.outcome).toBe("NOT_VERIFIED");
    expect(own.result?.verification.criteria?.every((c) => c.modelStatus === "SATISFIED")).toBe(true); // every verdict said yes…
    expect(own.result?.verification.reasons.join(" ")).not.toContain("could not run");
    expect(own.result?.verification.reasons.join(" ")).toContain("The answer says it accomplishes the objective: it says the objective was not accomplished");

    // (2) The objective's own criterion: judged on the question the user asked, it is not met.
    const judged = await run("FULLY", verdict("NOT_SATISFIED", "The answer names no license; the objective asks which license the project uses"));
    expect(judged.status).toBe("FAILED");
    expect(judged.result?.verification.outcome).toBe("NOT_VERIFIED");
    expect(judged.result?.verification.reasons.join(" ")).not.toContain("could not run"); // it ran, and said no
    expect(judged.result?.verification.criteria?.[0]).toMatchObject({ status: "NOT_SATISFIED" });
    expect(judged.result?.verification.criteria?.[1]).toMatchObject({ status: "SATISFIED" }); // the planner's sentence alone would have passed
  });

  it("Test 6c — the live licence false positive, reproduced exactly: every verdict 'satisfied', citing empty search results", async () => {
    // Release run lic2, verbatim in shape: the composer says FULLY; the verifier calls the
    // objective criterion and the planner's criterion satisfied, quoting (real) excerpts of
    // searches that found nothing. The answer does not name a licence (it is MIT).
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Search for license files", tools: ["filesystem.find_files"] }], [{ requirement: "The license file is present in the project workspace", objectiveBasis: "Which license does this project use" }]) },
      { expect: "DECIDE", reply: callTool("filesystem.find_files", { pattern: "LICENSE" }) },
      { expect: "DECIDE", reply: completeStep("No license file") },
      { expect: "COMPOSE", reply: composeCitingAll("No license file was found in the project workspace.", "FULLY") },
      {
        expect: "VERIFY",
        reply: (c: ChatCall) => {
          const empty = evidenceFor(c.prompt, '"matches":[]');
          return verdicts(
            [verdict("SATISFIED", "The observations confirm that no license files were found", empty)],
            verdict("SATISFIED", "The observations show no license files, which matches the answer", empty, "No license file"),
          );
        },
      },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Which license does this project use?", projectId: p.id }, USER);
    const after = await rt.orchestrator.start(task.id);

    expect(after.result?.verification.reasons.join(" ")).not.toContain("could not run");
    expect(after.status).toBe("FAILED");
    expect(after.result?.verification.outcome).not.toBe("VERIFIED");
    expect(after.result?.verification.criteria?.[0]).toMatchObject({ modelStatus: "SATISFIED", status: "INSUFFICIENT_EVIDENCE" });
    expect(after.result?.verification.criteria?.[0]?.note).toContain("does not appear in the cited evidence");
  });

  it("Test 6d — the answer's finding: invented ones are corrected, and it must be new and in the cited evidence", async () => {
    // An invented finding (not in the answer) gets the standard single correction.
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      // Seen live: the whole sentence as the "finding" — refused, it is not the result itself…
      { expect: "VERIFY", reply: (c: ChatCall) => verdicts([verdict("SATISFIED", "shown", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "The project's version is really 2.4.1 here") },
      { expect: "VERIFY", reply: (c: ChatCall) => verdicts([verdict("SATISFIED", "shown", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1") },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("COMPLETED");
    expect(JSON.stringify(ollama.calls.at(-1)!.body.messages)).toContain("must be the few words of the answer that state the result itself");
    expect(done.result?.verification.criteria?.[0]).toMatchObject({ status: "SATISFIED", finding: "2.4.1" });

    // …and one that is not in the answer at all is invented: also corrected.
    const second = await setup();
    const p2 = project(second.rt, PYPROJECT);
    second.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: (c: ChatCall) => verdicts([verdict("SATISFIED", "shown", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "version 3.0") },
      { expect: "VERIFY", reply: (c: ChatCall) => verdicts([verdict("SATISFIED", "shown", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1") },
    );
    allowAll(second.rt);
    const t2 = second.rt.taskService.create({ objective: "Find the project's version.", projectId: p2.id }, USER);
    expect((await second.rt.orchestrator.start(t2.id)).status).toBe("COMPLETED");
    expect(JSON.stringify(second.ollama.calls.at(-1)!.body.messages)).toContain("must be copied exactly from the proposed answer");

    // Deterministic rule, directly: a finding that only repeats the objective, or that the
    // cited observation does not contain, leaves the objective unproven.
    const now = 1_800_000_000_000;
    const objectiveCrit: Criterion = { id: newId("criterion", now), requirement: 'The answer accomplishes the objective as stated: "Find the project\'s version."', objectiveBasis: "Find the project's version.", evidence: "", verifiableBy: "OBSERVATION", required: true, revisionOf: null, origin: "OBJECTIVE" };
    const o: Observation = { id: newId("observation"), taskId: null, stepId: null, source: { kind: "SYSTEM", subsystem: "t" }, summary: "Read text file succeeded", data: { content: '[project]\nversion = "2.4.1"' } as never, createdAt: 0 };
    const judge = (finding: string) =>
      evaluateVerification({
        criteria: [objectiveCrit],
        verdicts: [{ status: "SATISFIED", evidence: [{ observationId: o.id, excerpt: 'version = "2.4.1"' }], explanation: "x", finding }],
        judgeError: null,
        steps: [{ status: "COMPLETED", title: "s" } as TaskStep],
        answerObservationIds: [o.id],
        answersObjective: "FULLY",
        observations: [o],
      }).criteria[0]!;
    expect(judge("2.4.1")).toMatchObject({ status: "SATISFIED" });
    expect(judge("version is 2.4.1")).toMatchObject({ status: "SATISFIED" }); // the answer's phrasing, not the file's
    expect(judge("version 2.4.2")).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", note: expect.stringContaining("not found: 2.4.2") });
    expect(judge("Find the project's")).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", note: expect.stringContaining("is in the cited evidence") });
    expect(judge("3.0.0")).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", note: expect.stringContaining("does not appear in the cited evidence") });
    expect(judge("")).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", note: expect.stringContaining("no finding") });
  });

  it("Test 6e — the boundary of 2.2, pinned down: MORROW traces the answer's words to the evidence, it does not judge support", () => {
    // These document what the structural rule cannot do, so a future semantic check changes
    // them knowingly. (1) A true absence answer cannot be shown by an excerpt: it is honest
    // uncertainty, not verified. (2) A finding that coincidentally matches unrelated text in a
    // cited observation still passes: excerpts show that text exists, not that it supports.
    const now = 1_800_000_000_000;
    const objectiveCrit: Criterion = { id: newId("criterion", now), requirement: 'The answer accomplishes the objective as stated: "Which license does this project use?"', objectiveBasis: "Which license does this project use?", evidence: "", verifiableBy: "OBSERVATION", required: true, revisionOf: null, origin: "OBJECTIVE" };
    const listing: Observation = { id: newId("observation"), taskId: null, stepId: null, source: { kind: "SYSTEM", subsystem: "t" }, summary: "List directory succeeded", data: { entries: [{ name: "README.md", kind: "file" }] } as never, createdAt: 0 };
    const judge = (finding: string) =>
      evaluateVerification({
        criteria: [objectiveCrit],
        verdicts: [{ status: "SATISFIED", evidence: [{ observationId: listing.id, excerpt: '"name":"README.md"' }], explanation: "x", finding }],
        judgeError: null,
        steps: [{ status: "COMPLETED", title: "s" } as TaskStep],
        answerObservationIds: [listing.id],
        answersObjective: "FULLY",
        observations: [listing],
      }).criteria[0]!.status;
    expect(judge("no license is declared")).toBe("INSUFFICIENT_EVIDENCE"); // (1)
    expect(judge("file")).toBe("SATISFIED"); // (2) — the known limit
    // (3) Words of the objective that also occur in the evidence pass, whatever the answer
    // meant; an answer that admits failure is stopped by its own account (D57), not by this.
    expect(judge("README.md")).toBe("SATISFIED");
  });

  it("Test 6f — a correct licence answer in the answer's own words is traced, word by word, to the manifest", () => {
    // Seen live: "The project uses the MIT license." against `license = "MIT"`. No contiguous
    // quote exists, but every word the finding adds is in the evidence.
    const now = 1_800_000_000_000;
    const objectiveCrit: Criterion = { id: newId("criterion", now), requirement: 'The answer accomplishes the objective as stated: "Which license does this project use?"', objectiveBasis: "Which license does this project use?", evidence: "", verifiableBy: "OBSERVATION", required: true, revisionOf: null, origin: "OBJECTIVE" };
    const manifest: Observation = { id: newId("observation"), taskId: null, stepId: null, source: { kind: "SYSTEM", subsystem: "t" }, summary: "Read text file succeeded", data: { content: '[project]\nname = "orbit"\nlicense = "MIT"\n' } as never, createdAt: 0 };
    const empty: Observation = { ...manifest, id: newId("observation"), summary: "Find files succeeded", data: { directory: "C:\\ws", matches: [] } as never };
    const judge = (finding: string, cited: Observation) =>
      evaluateVerification({
        criteria: [objectiveCrit],
        verdicts: [{ status: "SATISFIED", evidence: [{ observationId: cited.id, excerpt: cited === manifest ? 'license = "MIT"' : '"matches":[]' }], explanation: "x", finding }],
        judgeError: null,
        steps: [{ status: "COMPLETED", title: "s" } as TaskStep],
        answerObservationIds: [cited.id],
        answersObjective: "FULLY",
        observations: [manifest, empty],
      }).criteria[0]!;
    expect(judge("the MIT license", manifest).status).toBe("INSUFFICIENT_EVIDENCE"); // "the" is in neither: short words beyond 2 letters count
    expect(judge("MIT license", manifest).status).toBe("SATISFIED");
    expect(judge("uses MIT", manifest).status).toBe("INSUFFICIENT_EVIDENCE"); // "uses" ≠ "use", and is not in the file
    expect(judge("No license file", empty)).toMatchObject({ status: "INSUFFICIENT_EVIDENCE", note: expect.stringContaining("not found: file") });
  });

  it("Test 7 — a criterion found invalid is revised through a new plan version; the old one stays reconstructable", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, PYPROJECT);
    // Structurally grounded, but it assumes a kind of manifest the user never mentioned.
    const assumed: CriterionSpec = { requirement: "The version is read from the project's JavaScript manifest", objectiveBasis: "the project's version" };
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read the manifest", tools: ["filesystem.read_text_file"] }], [assumed]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep("Read pyproject.toml") },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      {
        expect: "VERIFY",
        // The answer accomplishes the objective (criterion 1); the planner's criterion 2 is wrong.
        reply: (c: ChatCall) =>
          verdicts(
            [verdict("CRITERION_INVALID", "The objective does not ask for a JavaScript manifest; this project declares its version in pyproject.toml", evidenceFor(c.prompt, "[project]"))],
            verdict("SATISFIED", "pyproject.toml declares 2.4.1", evidenceFor(c.prompt, 'version = "2.4.1"')),
          ),
      },
      // A revision that drops `required` and moves to another part of the objective is refused…
      { expect: "REVISE", reply: criteriaRevision({ reason: "wrong manifest assumed", replacements: [{ criterion: 2, requirement: "Something is found", objectiveBasis: "Find", required: false }] }) },
      // …a faithful one is accepted.
      { expect: "REVISE", reply: criteriaRevision({ reason: "The objective asks for the version, wherever it is declared", replacements: [{ criterion: 2, ...VERSION }] }) },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "pyproject.toml declares 2.4.1", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1")) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.result?.verification.outcome).toBe("VERIFIED");
    const revise = ollama.calls.filter((c) => c.purpose === "REVISE");
    expect(revise[0]!.prompt).toContain("does not ask for a JavaScript manifest");
    const correction = JSON.stringify(revise[1]!.body.messages);
    expect(correction).toContain("must stay required");
    expect(correction).toContain("must cover the same part of the objective");

    const [v1, v2] = rt.repos.plans.listByTask(task.id);
    expect(v1).toMatchObject({ version: 1, status: "SUPERSEDED" });
    expect(v1!.criteria![1]!.requirement).toBe(assumed.requirement); // history keeps what was replaced
    expect(v2).toMatchObject({ version: 2, status: "ACTIVE", previousPlanId: v1!.id });
    expect(v2!.criteria![0]).toEqual(v1!.criteria![0]); // the objective's own criterion is never revised
    expect(v2!.criteria![1]).toMatchObject({ requirement: VERSION.requirement, revisionOf: v1!.criteria![1]!.id, required: true });
    expect(v2!.keptStepIds).toEqual(rt.repos.taskSteps.listByTask(task.id).map((s) => s.id));
    expect(rt.repos.toolExecutions.listByTask(task.id)).toHaveLength(1); // nothing was redone

    // In this order: the failed round, the revision request, the new version, a new round that passes.
    const seq: string[] = types(rt, task.id);
    let at = -1;
    for (const t of ["VERIFICATION_FAILED", "PLAN_REPLAN_REQUESTED", "PLAN_UPDATED", "VERIFICATION_STARTED", "VERIFICATION_PASSED"]) {
      at = seq.indexOf(t, at + 1);
      expect(at, t).toBeGreaterThan(-1);
    }
    const failed = rt.eventLog.list({ taskId: task.id, types: ["VERIFICATION_FAILED"] })[0]!;
    expect(failed.type === "VERIFICATION_FAILED" && failed.payload.outcome).toBe("CRITERIA_INVALID");
    const request = rt.eventLog.list({ taskId: task.id, types: ["PLAN_REPLAN_REQUESTED"] })[0]!;
    expect(request.type === "PLAN_REPLAN_REQUESTED" && request.payload).toMatchObject({ trigger: "VERIFICATION", invalidCriteria: [{ criterionId: v1!.criteria![1]!.id }] });
    const updated = rt.eventLog.list({ taskId: task.id, types: ["PLAN_UPDATED"] })[0]!;
    expect(updated.type === "PLAN_UPDATED" && updated.payload).toMatchObject({ trigger: "VERIFICATION", revisedCriterionIds: [v1!.criteria![1]!.id] });
  });

  it("Test 7b — criteria that stay invalid fail the task within the replan bound, never pass it", async () => {
    const { rt, ollama } = await setup({ maxReplans: 1 });
    const p = project(rt, PYPROJECT);
    // The answer does accomplish the objective; only the planner's criterion is wrong, and stays wrong.
    const invalid = (c: ChatCall) =>
      verdicts([verdict("CRITERION_INVALID", "still not what was asked", evidenceFor(c.prompt, "[project]"))], verdict("SATISFIED", "2.4.1 is declared", evidenceFor(c.prompt, 'version = "2.4.1"')));
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read", tools: ["filesystem.read_text_file"] }], [{ requirement: "The version comes from the JavaScript manifest", objectiveBasis: "the project's version" }]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("2.4.1") },
      { expect: "VERIFY", reply: invalid },
      { expect: "REVISE", reply: criteriaRevision({ reason: "r", replacements: [{ criterion: 2, ...VERSION }] }) },
      { expect: "COMPOSE", reply: composeCitingAll("2.4.1") },
      { expect: "VERIFY", reply: invalid },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);
    expect(done.status).toBe("FAILED");
    expect(done.statusReason?.code).toBe("CRITERIA_INVALID");
    expect(done.statusReason?.message).toContain("still invalid after 1 replan attempt");
    expect(done.result?.verification).toMatchObject({ passed: false, outcome: "CRITERIA_INVALID" });
  });

  it("Test 8 — replanning changes the route to the evidence, never the criteria", async () => {
    const { rt, ollama } = await setup();
    const p = project(rt, CARGO);
    const criterion: CriterionSpec = { requirement: "The project's package version is determined", objectiveBasis: "the project's package version", evidence: "package.json declares it" };
    const failure = (prompt: string) => /→ FAILED \([^)]*\), observation (obs_[0-9A-Z]{26})/.exec(prompt)![1]!;
    ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read package.json", tools: ["filesystem.read_text_file"] }, { title: "Extract the version" }], [criterion]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "package.json" }) },
      { expect: "DECIDE", reply: (c: ChatCall) => requestReplan("package.json does not exist", [failure(c.prompt)]) },
      { expect: "REPLAN", reply: (c: ChatCall) => replanProposal({ reason: "No package.json; the project has a Cargo.toml", affectedSteps: [1, 2], evidence: [failure(c.prompt)], steps: [{ title: "Read Cargo.toml", tools: ["filesystem.read_text_file"] }] }) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "Cargo.toml" }) },
      { expect: "DECIDE", reply: completeStep("Read Cargo.toml") },
      { expect: "COMPOSE", reply: composeCitingAll("The project's package version is 0.4.2.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "Cargo.toml declares 0.4.2", evidenceFor(c.prompt, 'version = "0.4.2"'))], undefined, "0.4.2")) },
    );
    allowAll(rt);
    const task = rt.taskService.create({ objective: "Find the project's package version.", projectId: p.id }, USER);
    const done = await rt.orchestrator.start(task.id);

    expect(done.status).toBe("COMPLETED");
    expect(done.result?.verification.outcome).toBe("VERIFIED");
    const [v1, v2] = rt.repos.plans.listByTask(task.id);
    expect(v2!.criteria).toEqual(v1!.criteria); // same criteria, same ids: the objective did not change
    expect(v2!.criteria!.map((c) => c.requirement).join(" ")).not.toMatch(/package\.json/);
    const updated = rt.eventLog.list({ taskId: task.id, types: ["PLAN_UPDATED"] })[0]!;
    expect(updated.type === "PLAN_UPDATED" && updated.payload.trigger).toBe("EXECUTION");
    expect(ollama.calls.find((c) => c.purpose === "REPLAN")!.prompt).toContain("these come from the objective and stay as they are");
  });

  it("Test 9 — criteria, evidence and verification reconstruct identically after a restart", async () => {
    const dataDir = tempDir();
    const first = await setup({ dataDir });
    const p = project(first.rt, PYPROJECT);
    first.ollama.script(
      { expect: "PLAN", reply: READ_PLAN },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("The project's version is 2.4.1.") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "declared in the manifest", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1")) },
    );
    allowAll(first.rt);
    const task = first.rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    expect((await first.rt.orchestrator.start(task.id)).status).toBe("COMPLETED");
    const pick = (rt: Runtime) => {
      const d = readTaskDetail(rt, task.id);
      return JSON.stringify({ task: d.task, plans: d.plans, steps: d.steps, observations: d.observations, events: rt.eventLog.list({ taskId: task.id, limit: 1000 }) });
    };
    const before = pick(first.rt);
    first.rt.close();

    const second = await setup({ dataDir });
    expect(pick(second.rt)).toBe(before);
    const v = second.rt.taskService.get(task.id).result!.verification;
    expect(v.outcome).toBe("VERIFIED");
    expect(v.criteria![0]!.evidence[0]!.excerpt).toBe('version = "2.4.1"');
  });

  it("Test 9b — a criteria revision pending at shutdown is carried out after the restart", async () => {
    const dataDir = tempDir();
    const first = await setup({ dataDir });
    const p = project(first.rt, PYPROJECT);
    first.ollama.script(
      { expect: "PLAN", reply: plan([{ title: "Read", tools: ["filesystem.read_text_file"] }], [{ requirement: "The version comes from the JavaScript manifest", objectiveBasis: "the project's version" }]) },
      { expect: "DECIDE", reply: callTool("filesystem.read_text_file", { path: "pyproject.toml" }) },
      { expect: "DECIDE", reply: completeStep() },
      { expect: "COMPOSE", reply: composeCitingAll("2.4.1") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("CRITERION_INVALID", "the objective names no manifest kind", evidenceFor(c.prompt, "[project]"))])) },
      { expect: "REVISE", reply: { unreachable: true } },
    );
    allowAll(first.rt);
    const task = first.rt.taskService.create({ objective: "Find the project's version.", projectId: p.id }, USER);
    const waiting = await first.rt.orchestrator.start(task.id);
    expect(waiting).toMatchObject({ status: "WAITING", statusReason: { code: "MODEL_UNAVAILABLE" } });
    first.rt.close();

    const second = await setup({ dataDir });
    second.ollama.script(
      { expect: "REVISE", reply: criteriaRevision({ reason: "The objective asks for the version wherever it is declared", replacements: [{ criterion: 2, ...VERSION }] }) },
      { expect: "COMPOSE", reply: composeCitingAll("2.4.1") },
      { expect: "VERIFY", reply: (c: ChatCall) => (verdicts([verdict("SATISFIED", "declared", evidenceFor(c.prompt, 'version = "2.4.1"'))], undefined, "2.4.1")) },
    );
    const [resumed] = second.rt.orchestrator.resumeWaiting();
    expect((await resumed)!.status).toBe("COMPLETED");
    // The reason verification gave was persisted, so the restarted run could state it.
    expect(second.ollama.calls[0]!.prompt).toContain("the objective names no manifest kind");
  });

  it("Test 10 — tasks from before grounded verification load, and an unfinished one still verifies", async () => {
    // A database at the 2.1 schema (migrations 0000–0003): plans exist, criteria do not.
    const oldMigrations = tempDir("morrow-old-migrations-");
    mkdirSync(join(oldMigrations, "meta"));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const keep = journal.entries.filter((e: { idx: number }) => e.idx <= 3);
    for (const e of keep) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(oldMigrations, `${e.tag}.sql`));
    for (const f of readdirSync(join(MIGRATIONS, "meta")).filter((f) => /^000[0-3]_snapshot\.json$/.test(f))) copyFileSync(join(MIGRATIONS, "meta", f), join(oldMigrations, "meta", f));
    writeFileSync(join(oldMigrations, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: keep }));

    const dataDir = tempDir();
    const old = openDatabase({ path: join(dataDir, "morrow.sqlite"), migrationsFolder: oldMigrations });
    const columns = old.db.all<{ name: string }>(sql`select name from pragma_table_info('plans')`).map((r) => r.name);
    expect(columns).not.toContain("criteria"); // genuinely the previous schema
    const now = 1_800_000_000_000;
    const done = { task: newId("task", now), plan: newId("plan", now), step: newId("taskStep", now) };
    const open = { task: newId("task", now + 1), plan: newId("plan", now + 1), step: newId("taskStep", now + 1) };
    const oldResult = JSON.stringify({ answer: "done", observationIds: [], verification: { passed: true, evidence: ["It is done: ok"], reasons: [] }, modelId: null });
    old.db.run(sql`insert into tasks (id, project_id, title, objective, status, status_reason, paused_from, created_at, updated_at, started_at, ended_at, version, result)
      values (${done.task}, null, 'Old task', 'Old task', 'COMPLETED', null, null, ${now}, ${now}, ${now}, ${now}, 5, ${oldResult})`);
    old.db.run(sql`insert into tasks (id, project_id, title, objective, status, status_reason, paused_from, created_at, updated_at, started_at, ended_at, version, result)
      values (${open.task}, null, 'Say hello', 'Say hello', 'PAUSED', null, 'VERIFYING', ${now}, ${now}, ${now}, null, 4, null)`);
    for (const t of [done, open]) {
      old.db.run(sql`insert into plans (id, task_id, version, previous_plan_id, status, summary, success_criteria, kept_step_ids, reason, trigger_observation_ids, model_id, created_at, superseded_at)
        values (${t.plan}, ${t.task}, 1, null, 'ACTIVE', 'Old plan', '["It is done"]', '[]', null, '[]', null, ${now}, null)`);
      old.db.run(sql`insert into task_steps (id, task_id, plan_id, ordinal, title, description, status, expected_tool_ids, outcome, tool_execution_id, created_at, updated_at)
        values (${t.step}, ${t.task}, ${t.plan}, 0, 'Do it', null, 'COMPLETED', '[]', 'done', null, ${now}, ${now})`);
    }
    old.close();

    // Opened by the current code: migration 0004 adds the column; old rows stay as they were.
    const { rt, ollama } = await setup({ dataDir });
    const finished = readTaskDetail(rt, done.task);
    expect(finished.plan).toMatchObject({ successCriteria: ["It is done"], criteria: null });
    expect(finished.task.result?.verification).toEqual({ passed: true, evidence: ["It is done: ok"], reasons: [] });

    // The unfinished one resumes and is verified against its plain criteria, as before.
    ollama.script(
      { expect: "COMPOSE", reply: { answer: "Hello", observationIds: [], answersObjective: "FULLY" } },
      // A plan from before grounded verification has only its own criteria (no objective criterion).
      { expect: "VERIFY", reply: { verdicts: [verdict("SATISFIED", "The answer says hello")] } },
    );
    const resumed = await rt.orchestrator.resume(open.task, USER).completion;
    expect(resumed.status).toBe("COMPLETED");
    expect(resumed.result?.verification.outcome).toBe("VERIFIED");
    expect(rt.repos.plans.active(open.task)?.criteria).toBeNull(); // history is not rewritten
    expect(ollama.calls[1]!.prompt).toContain("1. It is done");
  });

  it("Test 10b — a plan from before grounded verification is not revised: invalid criteria fail it honestly", async () => {
    const { rt, ollama } = await setup();
    const task = rt.taskService.create({ objective: "Say hello" }, USER);
    const now = rt.clock.now();
    const planId = newId("plan", now);
    rt.repos.plans.insert({ id: planId, taskId: task.id, version: 1, previousPlanId: null, status: "ACTIVE", summary: "Old plan", successCriteria: ["It is done"], criteria: null, keptStepIds: [], reason: null, triggerObservationIds: [], modelId: null, createdAt: now, supersededAt: null });
    rt.repos.taskSteps.insert({ id: newId("taskStep", now), taskId: task.id, planId, ordinal: 0, title: "Do it", description: null, status: "COMPLETED", expectedToolIds: [], outcome: "done", toolExecutionId: null, createdAt: now, updatedAt: now });
    for (const to of ["PLANNING", "EXECUTING", "VERIFYING", "PAUSED"] as const) rt.taskService.transition({ taskId: task.id, to, actor: AGENT });
    ollama.script(
      { expect: "COMPOSE", reply: { answer: "Hello", observationIds: [], answersObjective: "FULLY" } },
      { expect: "VERIFY", reply: { verdicts: [verdict("CRITERION_INVALID", "the objective does not ask for it")] } },
    );
    const after = await rt.orchestrator.resume(task.id, USER).completion;
    expect(after.status).toBe("FAILED");
    expect(after.statusReason?.code).toBe("CRITERIA_INVALID");
    expect(after.statusReason?.message).toContain("cannot be revised");
    expect(types(rt, task.id)).not.toContain("PLAN_REPLAN_REQUESTED");
  });
});
