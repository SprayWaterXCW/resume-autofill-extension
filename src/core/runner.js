import { decisionSchema } from "./contracts.js";
import { toPlannerObservation } from "./catalog.js";
import { executeTool } from "./registry.js";

function result(status, trace, assessment) {
  return { status, steps: trace.length, trace, assessment };
}

function decisionForDisplay(decision, catalog) {
  if (decision.kind !== "act") return decision;
  const args = decision.tool === "add_entry"
    ? { sectionKey: decision.args?.sectionKey }
    : decision.tool === "fill_field"
      ? { fieldId: decision.args?.fieldId, sourcePath: decision.args?.sourcePath }
      : {};
  let rationale = decision.rationale;
  if (rationale) {
    for (const { path } of catalog.publicEntries) {
      const value = catalog.getValue(path);
      if (value) rationale = rationale.replaceAll(value, "[资料值已隐藏]");
    }
  }
  return {
    kind: "act", tool: decision.tool, args,
    ...(rationale ? { rationale } : {}),
    ...(decision.discardedProposals ? { discardedProposals: decision.discardedProposals } : {}),
  };
}

/** Observe → decide → guarded action → observe again → verify, with a private task evaluator. */
export async function runAgent({ goal, environment, planner, catalog, maxSteps = 20, onEvent }) {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError("maxSteps must be positive");
  let observation = await environment.reset();
  let assessment = environment.evaluate(catalog);
  const trace = [];
  if (assessment.complete) return result("completed", trace, assessment);

  for (let step = 1; step <= maxSteps; step += 1) {
    const context = {
      goal,
      page: toPlannerObservation(observation),
      profileCatalog: catalog.publicEntries,
      history: trace.map((event) => ({ ...event })),
    };
    onEvent?.({ type: "deciding", step, page: context.page, assessment });

    let decision;
    try {
      decision = decisionSchema.parse(await planner.decide(context));
    } catch (error) {
      const knownCodes = new Set(["MODEL_TIMEOUT", "MODEL_HTTP_ERROR", "MODEL_NETWORK_ERROR", "MODEL_RESPONSE_INVALID", "MODEL_ARGUMENTS_INVALID", "MODEL_CONTEXT_TOO_LARGE"]);
      trace.push({
        step,
        kind: "planner",
        code: knownCodes.has(error?.code) ? error.code : "INVALID_DECISION",
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
      });
      onEvent?.({ type: "step", event: trace.at(-1), assessment, page: context.page, beforePage: context.page });
      return result("blocked", trace, assessment);
    }

    onEvent?.({ type: "proposed", step, decision: decisionForDisplay(decision, catalog), page: context.page });

    if (decision.kind === "finish") {
      trace.push({ step, kind: "finish", code: "PREMATURE_FINISH" });
      onEvent?.({ type: "step", event: trace.at(-1), assessment, page: context.page, beforePage: context.page });
      continue;
    }
    if (decision.kind === "halt") {
      trace.push({ step, kind: "halt", code: "MODEL_HALTED", reason: decision.reason });
      onEvent?.({ type: "step", event: trace.at(-1), assessment, page: context.page, beforePage: context.page });
      return result("blocked", trace, assessment);
    }

    const execution = await executeTool({
      decision, environment, observation, catalog,
      onActionStart: (action) => onEvent?.({ type: "executing", step, action }),
    });
    trace.push({
      step,
      kind: "act",
      tool: execution.code === "UNKNOWN_TOOL" ? "[unknown]" : decision.tool,
      target: execution.target,
      allowed: execution.allowed,
      verified: execution.verified,
      code: execution.code,
      ...(execution.reason ? { reason: execution.reason } : {}),
    });
    if (!execution.allowed) {
      onEvent?.({ type: "step", event: trace.at(-1), assessment, page: context.page, beforePage: context.page });
      return result("blocked", trace, assessment);
    }

    observation = execution.observation;
    assessment = environment.evaluate(catalog);
    onEvent?.({ type: "step", event: trace.at(-1), assessment, page: toPlannerObservation(observation), beforePage: context.page });
    if (assessment.complete) return result("completed", trace, assessment);
  }

  return result("incomplete", trace, assessment);
}
