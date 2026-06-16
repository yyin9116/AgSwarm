#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

const args = parseArgs(process.argv.slice(2));
const prompt = withAgSwarmContext(args.prompt || "", args.cwd || process.cwd());
const cwd = args.cwd || process.cwd();
const modelPattern = args.model || "";
const timeoutMs = Math.max(1000, Number(args.timeoutMs || 120000));
const BUILTIN_SLASH_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Enable or disable models for cycling" },
  { name: "export", description: "Export session" },
  { name: "import", description: "Import and resume a session" },
  { name: "share", description: "Share session" },
  { name: "copy", description: "Copy last agent message" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload skills, prompts, and themes" },
];
let sequence = 0;

function emit(kind, payload) {
  try {
    process.stdout.write(JSON.stringify({ stream: true, kind, payload }) + "\n");
  } catch (error) {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  }
}

function emitEvent(type, payload = {}) {
  emit("event", {
    type,
    task_id: args.taskId || "pi-agent-session",
    sequence: ++sequence,
    payload,
    version: "1.0",
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
  });
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : "true";
  }
  return result;
}

function withAgSwarmContext(userPrompt, workspace) {
  return `<agswarm_context>
You are the AI worker inside AgSwarm Client, a desktop app for multi-device agent collaboration.

Product summary:
- AgSwarm discovers trusted devices on the user's local network and represents each device's AI worker as a participant in shared conversations.
- The chat page is the user's command surface for asking the local device AI to reason, use tools, inspect the workspace, and coordinate tasks.
- Device and task pages track discovered peers, transfer/task state, and future multi-device handoffs.
- Prefer concise, helpful Chinese when the user writes Chinese. Keep a calm, collaborative tone.

Operating guidance:
- Treat this context as background. Do not mention implementation internals unless asked.
- When doing work, explain the next concrete action briefly, then use available tools.
- Keep file, shell, and network actions bounded to the user's request and current workspace.
- If a model/provider/runtime connection fails, report a short user-facing recovery hint instead of raw stack traces.

Current workspace: ${workspace}
</agswarm_context>

User request:
${userPrompt}`;
}

function parseSkillEntries(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== "safe_default");
}

function resolveSkillSpec(value, cwd, agentDir) {
  const entries = parseSkillEntries(value);
  const paths = [];
  const names = [];
  const diagnostics = [];
  for (const entry of entries) {
    if (/^[a-z0-9-]+$/.test(entry)) {
      names.push(entry);
      continue;
    }
    const candidates = skillPathCandidates(entry, cwd, agentDir);
    const foundPath = candidates.find((candidate) => existsSync(candidate));
    if (foundPath) {
      paths.push(foundPath);
      continue;
    }
    diagnostics.push({ type: "warning", message: "skill path does not exist", path: resolve(cwd, entry) });
  }
  return { paths, names, diagnostics };
}

function skillPathCandidates(entry, cwd, agentDir) {
  if (entry.startsWith("/") || entry.startsWith(".") || entry.includes("/")) {
    return [resolve(cwd, entry)];
  }
  return [
    join(agentDir, "skills", entry),
    join(cwd, ".pi", "skills", entry),
    join(process.env.HOME || "", ".agents", "skills", entry),
  ];
}

async function modelFromPattern(pattern, authStorage, modelRegistry) {
  const trimmed = String(pattern || "").trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    return modelRegistry.find(trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1))
      || getModel(trimmed.slice(0, slashIndex), trimmed.slice(slashIndex + 1))
      || undefined;
  }
  const allModels = typeof modelRegistry.getAll === "function" ? modelRegistry.getAll() : [];
  const configured = allModels.find((model) => (
    model.id === trimmed
    && (typeof modelRegistry.hasConfiguredAuth !== "function" || modelRegistry.hasConfiguredAuth(model))
  )) || allModels.find((model) => model.id === trimmed);
  if (configured) return configured;
  const authProviders = authStorage.getApiKeyProviders?.() || [];
  for (const provider of authProviders) {
    const model = modelRegistry.find(provider, trimmed);
    if (model) return model;
  }
  for (const provider of ["openai", "anthropic", "google", "xai", "groq", "cerebras", "zai", "openrouter"]) {
    const model = getModel(provider, trimmed);
    if (model) return model;
  }
  return undefined;
}

function parseTextSignature(value) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function textFromContent(content, phase) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .filter((part) => {
      const signature = parseTextSignature(part.textSignature);
      if (!phase) return signature.phase !== "commentary";
      return signature.phase === phase;
    })
    .map((part) => String(part.text || ""))
    .filter((text) => phase || !looksLikeReasoningText(text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function looksLikeReasoningText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/^(目标是|计划(?:很|是|：|:)|已确认|现在(?:查询|请求|直接|开始|调用)|我会先|先读取|为了避免|这个结果的日期标签不可信)/.test(text)) {
    return true;
  }
  if (/^(Finding|Providing|Planning|Inspecting|Reading|Searching|Running|Calling|Considering|I need to|I should|It seems like|Let's)\b/i.test(text)) {
    return true;
  }
  if (/^(the weather information|keeping the|provide an answer|need to provide)\b/i.test(text)) {
    return true;
  }
  if (/^(I|I'm|I've|I'll|my|the|this|that|there|it|it's|its|user|guidelines|although|maybe|probably|seems|should|would|could|need|want|asking|using|python|draw|vague|clarify|specific|provide|example|response|technical|concise|tool|tools|common|option|question|answer)\b/i.test(text)) {
    return true;
  }
  return false;
}

function normalizeToolResult(result) {
  if (Array.isArray(result?.content)) {
    return result.content.map((part) => part?.text || part?.data || "").filter(Boolean).join("\n");
  }
  return result?.content || result?.text || result || "";
}

function eventToPayload(event) {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent || {};
    if (update.type === "thinking_delta") {
      return { type: "agent.token", payload: { text: "", thinking: update.delta || "", phase: "reasoning", tool_call: null } };
    }
    if (update.type === "text_delta") {
      const part = update.partial?.content?.[update.contentIndex] || {};
      const signature = parseTextSignature(part.textSignature);
      if (signature.phase === "commentary") {
        return { type: "agent.token", payload: { text: "", thinking: update.delta || "", phase: "commentary", tool_call: null } };
      }
      if (signature.phase && signature.phase !== "final_answer") return null;
      return { type: "agent.token", payload: { text: update.delta || "", thinking: "", phase: signature.phase || "final_answer", tool_call: null } };
    }
    if (update.type === "toolcall_end") {
      return { type: "agent.token", payload: { text: "", thinking: "", tool_call: update.toolCall } };
    }
    return null;
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "agent.tool_start",
      payload: { tool: event.toolName, params: event.args, toolCallId: event.toolCallId },
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      type: "agent.tool_update",
      payload: { tool: event.toolName, params: event.args, output: normalizeToolResult(event.partialResult), toolCallId: event.toolCallId },
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "agent.tool_end",
      payload: { tool: event.toolName, result: normalizeToolResult(event.result), isError: event.isError, toolCallId: event.toolCallId },
    };
  }
  if (event.type === "turn_start") return { type: "agent.turn_start", payload: {} };
  if (event.type === "turn_end") return { type: "agent.turn_end", payload: { message: event.message, tool_results: event.toolResults || [] } };
  if (event.type === "message_start") return { type: "agent.message_start", payload: {} };
  if (event.type === "message_end") return { type: "agent.message_end", payload: { message: event.message } };
  if (event.type === "agent_end") {
    return { type: "agent.end", payload: { messages: event.messages || [], willRetry: event.willRetry || false } };
  }
  return null;
}

function finalAnswer(messages) {
  for (const message of [...(messages || [])].reverse()) {
    if (message?.role !== "assistant") continue;
    const final = textFromContent(message.content, "final_answer");
    if (final) return final;
  }
  for (const message of [...(messages || [])].reverse()) {
    if (message?.role !== "assistant") continue;
    const text = textFromContent(message.content);
    if (text) return text;
  }
  return "";
}

async function main() {
  const agentDir = getAgentDir();
  const skillSpec = resolveSkillSpec(args.skills, cwd, agentDir);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: skillSpec.paths,
    skillsOverride: skillSpec.names.length
      ? (base) => ({
        skills: base.skills.filter((skill) => skillSpec.names.includes(skill.name)),
        diagnostics: [
          ...base.diagnostics,
          ...skillSpec.diagnostics,
          ...skillSpec.names
            .filter((name) => !base.skills.some((skill) => skill.name === name))
            .map((name) => ({ type: "warning", message: `requested skill not found: ${name}` })),
        ],
      })
      : (base) => ({ skills: base.skills, diagnostics: [...base.diagnostics, ...skillSpec.diagnostics] }),
  });
  await resourceLoader.reload();
  if (args.listCommands === "true") {
    const models = await availableModels(modelRegistry);
    emit("result", {
      ok: true,
      status: "succeeded",
      commands: commandCatalog(resourceLoader, models),
      models: models.map(modelCommand),
      skills: resourceLoader.getSkills().skills.map(skillCommand),
      diagnostics: resourceLoader.getSkills().diagnostics,
    });
    return;
  }
  if (!prompt.trim()) throw new Error("prompt is required");
  emitEvent("agent.skills", {
    requested: args.skills || "",
    loaded: resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
    })),
    diagnostics: resourceLoader.getSkills().diagnostics,
  });
  const model = await modelFromPattern(modelPattern, authStorage, modelRegistry);
  emitEvent("agent.start", { model: modelPattern, cwd });

  const { session } = await createAgentSession({
    cwd,
    model,
    authStorage,
    modelRegistry,
    resourceLoader,
    thinkingLevel: args.thinkingLevel || undefined,
    tools: ["read", "bash", "edit", "write"],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  let agentEndMessages = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end") agentEndMessages = event.messages || [];
    const mapped = eventToPayload(event);
    if (mapped) emitEvent(mapped.type, mapped.payload);
  });

  const timeout = setTimeout(() => {
    emitEvent("adapter.error", { code: "timeout", message: `pi AgentSession timed out after ${timeoutMs}ms` });
    process.exitCode = 124;
  }, timeoutMs);

  try {
    await session.prompt(prompt, { source: "api" });
    clearTimeout(timeout);
    emitEvent("adapter.completed", { output: "AgSwarm AI finished" });
    emit("result", {
      ok: true,
      status: "succeeded",
      assistant_text: finalAnswer(agentEndMessages),
      events: [],
    });
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    session.dispose();
  }
}

async function availableModels(modelRegistry) {
  if (typeof modelRegistry.refresh === "function") {
    modelRegistry.refresh();
  }
  if (typeof modelRegistry.getAvailable === "function") {
    return await modelRegistry.getAvailable();
  }
  return typeof modelRegistry.getAll === "function" ? modelRegistry.getAll() : [];
}

function commandCatalog(resourceLoader, models) {
  return [
    ...BUILTIN_SLASH_COMMANDS.map((command) => ({
      name: `/${command.name}`,
      value: `/${command.name}`,
      description: command.description,
      source: "builtin",
    })),
    ...resourceLoader.getSkills().skills.map(skillCommand),
    ...models.slice(0, 80).map(modelCommand),
  ];
}

function skillCommand(skill) {
  return {
    name: `/skill:${skill.name}`,
    value: `/skill:${skill.name} `,
    description: skill.description,
    source: "skill",
  };
}

function modelCommand(model) {
  const label = `${model.provider}/${model.id}`;
  return {
    name: `/model ${label}`,
    value: `/model ${label}`,
    description: model.name || model.id,
    source: "model",
  };
}

main().catch((error) => {
  emitEvent("adapter.error", { code: "pi_agent_session_error", message: error?.message || String(error) });
  emit("result", {
    ok: false,
    status: "failed",
    stderr: error?.stack || error?.message || String(error),
  });
  process.exitCode = 1;
});
