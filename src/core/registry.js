import { toolSchemas } from "./contracts.js";

const FORBIDDEN_INTENT = /提交|投递|递交|申请职位|报名|submit|apply|send|publish/i;

function deny(code) {
  return { allowed: false, verified: false, code };
}

function actionError(error, target) {
  if (error?.code === "NETWORK_SIDE_EFFECT_BLOCKED" || error?.code === "NETWORK_GUARD_UNVERIFIED") {
    return { allowed: false, verified: false, code: error.code, reason: error.message, target };
  }
  return null;
}

/** Only these two narrowly scoped tools exist. There is no generic click or submit tool. */
export async function executeTool({ decision, environment, observation, catalog, onActionStart }) {
  const schema = Object.hasOwn(toolSchemas, decision.tool) ? toolSchemas[decision.tool] : null;
  if (!schema) return deny("UNKNOWN_TOOL");

  const parsed = schema.safeParse(decision.args);
  if (!parsed.success) return deny("INVALID_ARGUMENTS");
  const args = parsed.data;

  if (decision.tool === "add_entry") {
    const section = observation.sections.find((item) => item.key === args.sectionKey);
    const control = section?.addControl;
    if (!control || control.intent !== "add_entry" || control.role !== "button"
      || control.type !== "button" || control.formAction
      || FORBIDDEN_INTENT.test(control.text)) {
      return deny("UNSAFE_ADD_CONTROL");
    }

    const beforeCount = section.entryCount;
    const beforeFields = observation.fields.length;
    let after;
    try {
      onActionStart?.({ tool: "add_entry", target: { sectionKey: args.sectionKey }, beforeCount, beforeFields });
      after = (await environment.step({ tool: "add_entry", sectionKey: args.sectionKey })).observation;
    } catch (error) {
      const blocked = actionError(error, { sectionKey: args.sectionKey });
      if (blocked) return blocked;
      return { allowed: true, verified: false, code: "TOOL_ERROR", observation: await environment.observe(), target: { sectionKey: args.sectionKey } };
    }
    const newCount = after.sections.find((item) => item.key === args.sectionKey)?.entryCount;
    const verified = newCount === beforeCount + 1 && after.fields.length > beforeFields;
    return { allowed: true, verified, code: verified ? "POSTCONDITION_OK" : "POSTCONDITION_FAILED", observation: after, target: { sectionKey: args.sectionKey } };
  }

  const field = observation.fields.find((item) => item.id === args.fieldId);
  if (!field || !field.writable) return deny("FIELD_NOT_WRITABLE");
  if (!catalog.hasPath(args.sourcePath)) return deny("UNKNOWN_PROFILE_PATH");

  const value = catalog.getValue(args.sourcePath);
  if (field.value && field.value !== value) return deny("WOULD_OVERWRITE_EXISTING_VALUE");
  let after;
  try {
    onActionStart?.({ tool: "fill_field", target: { fieldId: args.fieldId, sourcePath: args.sourcePath } });
    after = (await environment.step({
      tool: "fill_field", fieldId: args.fieldId, sourcePath: args.sourcePath, value,
    })).observation;
  } catch (error) {
    const blocked = actionError(error, { fieldId: args.fieldId, sourcePath: args.sourcePath });
    if (blocked) return blocked;
    return { allowed: true, verified: false, code: "TOOL_ERROR", observation: await environment.observe(), target: { fieldId: args.fieldId, sourcePath: args.sourcePath } };
  }
  const verified = after.fields.find((item) => item.id === args.fieldId)?.value === value;
  return { allowed: true, verified, code: verified ? "POSTCONDITION_OK" : "POSTCONDITION_FAILED", observation: after, target: { fieldId: args.fieldId, sourcePath: args.sourcePath } };
}
