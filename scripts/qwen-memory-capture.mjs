import { writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/logs/0.24.7/libexec/lib/node_modules/@qwen-code/qwen-code/chunks",
);
const chatTarget = pathToFileURL(path.join(packageRoot, "chunk-UZ5AMSVC.js")).href;
const responsesTarget = pathToFileURL(path.join(packageRoot, "openaiResponsesContentGenerator-GK7IVKOS.js")).href;
const headlessTarget = pathToFileURL(path.join(packageRoot, "chunk-2PBOCV6K.js")).href;
const remindersTarget = pathToFileURL(path.join(packageRoot, "chunk-UJ37RBHZ.js")).href;
const coreTarget = pathToFileURL(path.join(packageRoot, "chunk-AN36BHDM.js")).href;
const chatMarker = "openaiRequestCaptureContext.getStore()?.(openaiRequest);";
const responsesMarker = "const activeRequest=this.buildRequest(request,userPromptId);";
const headlessMarker = "const responseStream=llmClient.sendMessageStream(currentMessages[0]?.parts||[],abortController.signal,currentPromptId,";
const remindersMarker = "const reminderParts=[buildMcpServerInstructionsReminder(toolRegistry),skillsResult?.reminder??null,startupReminder,includeDeferredToolsReminder?buildDeferredToolsReminder(toolRegistry):null].filter(text=>text!==null).map(text=>({text}));const prelude=reminderParts.length===0?[]:[{role:\"user\",parts:reminderParts}];";
const coreMarker = "return generator.generateContentStream(request,prompt_id)";
const memoryName = "mcp__code-intelligence__memory";

let firstUserTurn;
const initialDeferredReminders = new WeakMap();
let openaiRequestSequence = 0;
let skippedOpenaiRequests = 0;
const userTurnRequestContext = new AsyncLocalStorage();

function shortDescription(description) {
  const firstLine = (description || "").split("\n")[0].trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function deferredState(registry) {
  const tool = registry?.getTool(memoryName);
  const summary = registry?.getDeferredToolSummary().find((item) => item.name === memoryName);
  const bridgeAvailable = Boolean(registry?.getTool("tool_search") && registry?.getTool("tool_call"));
  return {
    registered: Boolean(tool),
    classified_deferred: tool ? registry.isEffectivelyDeferred(tool) : null,
    hidden_from_normal_tools: tool ? registry.isDeferredAndHidden(memoryName) : null,
    revealed_by_tool_search: tool ? registry.isDeferredToolRevealed(memoryName) : null,
    permission_deferred: tool ? registry.isPermissionDeferred(memoryName) : null,
    deferred_summary_contains_memory: Boolean(summary),
    tool_search_bridge_available: bridgeAvailable,
    summary_description_nonempty: summary ? shortDescription(summary.description).length > 0 : null,
    summary_description_equals_full_description: summary ? shortDescription(summary.description) === summary.description : null,
  };
}

export function observeInitialDeferredReminder(registry, reminderPresent, preludeAdded) {
  const state = deferredState(registry);
  initialDeferredReminders.set(registry, {
    constructed: reminderPresent,
    inserted_into_history: reminderPresent && preludeAdded,
    memory_name_in_summary: state.deferred_summary_contains_memory && state.hidden_from_normal_tools === true,
    memory_name_in_constructed_reminder: reminderPresent && preludeAdded && state.deferred_summary_contains_memory && state.hidden_from_normal_tools === true,
    summary_description_nonempty: state.summary_description_nonempty,
    summary_description_equals_full_description: state.summary_description_equals_full_description,
  });
}

export function markHeadlessUserTurn(promptId, llmClient) {
  if (firstUserTurn) return;
  if (typeof promptId !== "string" || promptId.length === 0) throw new Error("Headless user turn lacks a prompt ID");
  firstUserTurn = { promptId, client: llmClient };
}

export function runUserTurnModelRequest(promptId, chat, send) {
  if (firstUserTurn && promptId === firstUserTurn.promptId && chat === firstUserTurn.client?.chat) {
    return userTurnRequestContext.run(true, send);
  }
  return send();
}

export function projectMemoryDeclaration(request) {
  const matches = (Array.isArray(request?.tools) ? request.tools : [])
    .filter((tool) => tool?.type === "function" && (tool.function?.name ?? tool.name) === "mcp__code-intelligence__memory")
    .map((tool) => {
      const { name, description, parameters } = tool.function ?? tool;
      if (typeof description !== "string" || !parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
        throw new Error("Memory declaration lacks a description or object schema");
      }
      return { name, description, parametersJsonSchema: parameters };
    });
  if (matches.length > 1) throw new Error("Duplicate memory declarations in model request");
  return { tools: matches };
}

export function captureQwenOpenAIRequest(request, userPromptId, protocol) {
  openaiRequestSequence++;
  if (!firstUserTurn || userPromptId !== firstUserTurn.promptId || userTurnRequestContext.getStore() !== true) {
    skippedOpenaiRequests++;
    return;
  }
  try {
    const output = process.env.QWEN_MEMORY_CAPTURE_FILE;
    if (!output || !path.isAbsolute(output)) throw new Error("QWEN_MEMORY_CAPTURE_FILE must be an absolute path");
    const declaration = projectMemoryDeclaration(request);
    const registry = firstUserTurn.client?.config?.getToolRegistry();
    const registryState = deferredState(registry);
    const announced = firstUserTurn.client?.announcedDeferredToolNames?.has(memoryName) === true;
    const reminder = registry ? initialDeferredReminders.get(registry) : undefined;
    const memoryInNormalTools = declaration.tools.length === 1;
    const result = {
      ...declaration,
      capture: {
        phase: "first_headless_user_turn_model_request",
        protocol,
        openai_request_sequence: openaiRequestSequence,
        skipped_openai_requests: skippedOpenaiRequests,
      },
      deferred_memory: {
        ...registryState,
        name_announced_by_client: announced,
        initial_reminder_constructed: reminder?.constructed ?? null,
        initial_reminder_inserted_into_history: reminder?.inserted_into_history ?? null,
        name_in_initial_reminder: reminder?.memory_name_in_constructed_reminder ?? null,
        abbreviated_description_in_initial_reminder: reminder?.memory_name_in_constructed_reminder
          ? reminder.summary_description_nonempty : null,
        full_description_in_initial_reminder: reminder?.memory_name_in_constructed_reminder
          ? reminder.summary_description_equals_full_description : null,
        schema_in_initial_reminder: reminder?.memory_name_in_constructed_reminder ? false : null,
        memory_in_normal_tools_array: memoryInNormalTools,
        full_description_and_schema_in_normal_tools_array: memoryInNormalTools,
      },
    };
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    process.stderr.write("Captured the first headless user-turn OpenAI request; stopped before sending it.\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Memory capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

export function instrumentQwenChunk(source, kind, captureUrl = import.meta.url) {
  const marker = {
    chat: chatMarker,
    responses: responsesMarker,
    headless: headlessMarker,
    reminders: remindersMarker,
    core: coreMarker,
  }[kind];
  if (!marker || source.split(marker).length !== 2) throw new Error("Qwen 0.24.7 request hook changed");
  const names = kind === "headless" ? "markHeadlessUserTurn" : kind === "reminders" ? "observeInitialDeferredReminder"
    : kind === "core" ? "runUserTurnModelRequest" : "captureQwenOpenAIRequest";
  const captureImport = `import { ${names} } from ${JSON.stringify(captureUrl)};\n`;
  const replacement = kind === "chat"
    ? `captureQwenOpenAIRequest(openaiRequest,userPromptId,"chat_completions");${marker}`
    : kind === "responses"
      ? `${marker}captureQwenOpenAIRequest(activeRequest,userPromptId,"responses");`
      : kind === "headless"
        ? `if(isFirstTurn&&sendType==="userQuery"&&!options.continueInterrupted)markHeadlessUserTurn(currentPromptId,llmClient);${marker}`
        : kind === "core"
          ? "return runUserTurnModelRequest(prompt_id,this,()=>generator.generateContentStream(request,prompt_id))"
          : "const deferredReminder=includeDeferredToolsReminder?buildDeferredToolsReminder(toolRegistry):null;const reminderParts=[buildMcpServerInstructionsReminder(toolRegistry),skillsResult?.reminder??null,startupReminder,deferredReminder].filter(text=>text!==null).map(text=>({text}));const prelude=reminderParts.length===0?[]:[{role:\"user\",parts:reminderParts}];observeInitialDeferredReminder(toolRegistry,Boolean(deferredReminder),prelude.length===1);";
  return captureImport + source.replace(marker, replacement);
}

if (process.env.QWEN_MEMORY_CAPTURE_FILE) {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const kind = url === chatTarget ? "chat" : url === responsesTarget ? "responses"
        : url === headlessTarget ? "headless" : url === remindersTarget ? "reminders"
          : url === coreTarget ? "core" : undefined;
      if (!kind) return loaded;
      return {
        ...loaded,
        source: instrumentQwenChunk(String(loaded.source), kind),
      };
    },
  });
}
