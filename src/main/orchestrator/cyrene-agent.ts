// CyreneAgent —— 把 Function Calling 循环包进 AG-UI 的 AbstractAgent。
//
// AG-UI 是事件协议：AbstractAgent.run() 返回 Observable<BaseEvent>，
// 我们在 Observable 内部跑 FC 循环，每一步 observer.next() 一个标准事件：
//   RUN_STARTED → (每轮 STEP_STARTED → 可能 TOOL_CALL_* → STEP_FINISHED) →
//   TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT(逐字) → TEXT_MESSAGE_END → RUN_FINISHED
//
// 设计要点：
// - FC 循环仍是 stream:false 一次性拿全文（不碰 LLM 层），拿到全文后切成 delta 逐个发
//   TEXT_MESSAGE_CONTENT，这就是"流式感"的来源——标准 AG-UI 做法。
// - run() 不做副作用（不写记忆、不推断表情）。那些在桥层 runAgent 完成后做，
//   保持 agent 纯粹只管"产出事件流"。
// - 错误用 observer.error() 抛，桥层捕获。
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";
import { toolRegistry, type ToolDefinition } from "./tool-registry";
import { type ToolCallResult } from "./types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import {
  getAdapter,
  createSseReader,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ToolCall,
  type ToolExecutionResult,
  type ToolSpec,
} from "./vendors";
import { extractLastUserQuery, type ToolContext } from "./tool-context";
import { recordUsage } from "../token-usage-store";
import { resetReadRefs } from "../skills/skill-tools";
import { truncateToolResult, compressConversation } from "./context-manager";

const LOG_PREFIX = "[CyreneAgent]";
const MAX_TOOL_ROUNDS = 20; // 多步任务（写 Excel 多 sheet、生成图片等）可能耗多轮；到顶强制无工具总结兜底
const PER_ROUND_TIMEOUT_MS = 75000; // 推理模型带 thinking，30s 偏紧，放宽到 75s
const FORCE_SUMMARY_TIMEOUT_MS = 90000; // 强制总结兜底：对话历史此时已很长，30s 不够，放宽到 90s
// 连续超时即退出：超时后重试只会让上下文更长更慢，形成"超时→加消息→更慢→再超时"死循环。
// 连续 MAX_CONSECUTIVE_TIMEOUTS 次超时直接跳出走强制总结，不再空转浪费时间。
const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** 厂商配置（结构兼容 main/index.ts 的 ModelSettings，避免循环依赖）。 */
export interface AgentLoopSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** CyreneAgent.run() 需要的输入——桥层构造好后塞进 input.state 或 forwardedProps。 */
export interface CyreneRunOptions {
  settings: AgentLoopSettings;
  /** 已经拼好 system prompt 的完整消息（含 system + user/assistant）。 */
  messages: ChatMessage[];
  timeoutMs: number;
  /** 可选：本次 run 的工具集合。未传时使用当前所有已启用工具。 */
  tools?: ToolDefinition[];
  /** 是否启用真流式输出（思考+答案实时）。仅 OpenAI transport 生效；默认关（由调用方按设置传入）。 */
  streamingOutput?: boolean;
}

/** FC 循环最终结果（供桥层做副作用用）。 */
export interface CyreneRunResult {
  reply: string;
  toolResults: ToolCallResult[];
  totalUsage?: { input: number; output: number };
}

/** 把 ToolRegistry 里的工具转成统一 ToolSpec（与 wire 格式解耦）。 */
function buildToolSpecs(tools: ToolDefinition[] = toolRegistry.getEnabledTools()): ToolSpec[] {
  return tools.filter(t => t.enabled).map(t => ({
    name: t.id,
    description: t.description,
    parameters: {
      type: "object",
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
}

/** 逐字切片：按字符（emoji 安全）切，每片 1 字（渲染端 CSS 渐显用）。 */
function sliceToDeltas(text: string, chunkSize = 1): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    out.push(chars.slice(i, i + chunkSize).join(""));
  }
  return out.length > 0 ? out : [text];
}

/**
 * 把一份完整文本以 TEXT_MESSAGE 流发出。
 * 返回该文本（供调用方记到 toolResults 等用）。
 */
function emitTextMessage(
  observer: { next: (e: BaseEvent) => void },
  messageId: string,
  text: string,
): void {
  observer.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
  // 逐字切片发 delta（每片 4 字，emoji 安全），渲染端逐字累积实现流式感。
  // FC 仍是 stream:false 一次性拿全文，这里切片只是把"整段一次"变成"多段快速"。
  for (const delta of sliceToDeltas(text)) {
    observer.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
  }
  observer.next({ type: EventType.TEXT_MESSAGE_END, messageId });
}

/** 流式一轮的结果，形态与 adapter.parseResponse 的 ChatResponse 对齐（供 FC 循环共用后续逻辑）。 */
interface StreamRoundResult {
  text: string;
  thinking?: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { input: number; output: number };
  assistantMessage: ChatMessage;
  /** 是否已经通过 TEXT_MESSAGE 流把正文发给前端（无工具调用的纯文本轮）。 */
  textAlreadyStreamed: boolean;
  /** 本轮用于前端流式展示的 messageId（textAlreadyStreamed 时有效）。 */
  streamedMessageId?: string;
}

/**
 * 真流式跑一轮（仅 OpenAI transport 用）。
 * - thinking 增量：实时发 CUSTOM cyrene.thinking（append 语义），前端边想边显示。
 * - text 增量：实时发 TEXT_MESSAGE_START/CONTENT（不预先切片，直接透传厂商 delta）。
 *   注意：若本轮最终是工具调用（无正文或正文只是过程），仍会把已发的 text 作为 assistant content 记录。
 * - tool_calls 增量：按 index 跨 chunk 拼接 id/name/arguments。
 *
 * 抛 AbortError 交由上层按超时逻辑处理，与非流式路径一致。
 */
async function streamOneRound(
  adapter: ReturnType<typeof getAdapter>,
  req: ChatRequest,
  settings: AgentLoopSettings,
  observer: { next: (e: BaseEvent) => void },
  perRoundTimeoutMs: number,
  round: number,
): Promise<StreamRoundResult> {
  const http = adapter.buildStreamRequest({ ...req, stream: true }, settings);
  console.log(LOG_PREFIX, "流式请求:", http.url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perRoundTimeoutMs);

  // 流式增量累积
  let text = "";
  let thinking = "";
  let finishReason = "stop";
  let usage: { input: number; output: number } | undefined;
  // 工具调用按 index 拼接
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  // 正文流式展示：首个 text delta 到达时才发 TEXT_MESSAGE_START
  let textStarted = false;
  const streamedMessageId = `msg-${Date.now()}-${round}`;
  // 思考流式展示：CUSTOM cyrene.thinking 用 append 语义，前端累积
  let thinkingStarted = false;

  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error("模型请求失败：HTTP " + response.status + (errorText ? " — " + errorText.slice(0, 200) : ""));
    }
    if (!response.body) throw new Error("响应体为空，不支持流式读取");

    for await (const event of createSseReader(adapter, response.body)) {
      const chunk = adapter.parseStreamEvent(event);
      if (!chunk) continue;

      if (chunk.deltaThinking) {
        thinking += chunk.deltaThinking;
        observer.next({
          type: EventType.CUSTOM,
          name: "cyrene.thinking",
          value: { round: round + 1, delta: chunk.deltaThinking, append: true, start: !thinkingStarted },
        } as BaseEvent);
        thinkingStarted = true;
      }

      if (chunk.deltaText) {
        if (!textStarted) {
          observer.next({ type: EventType.TEXT_MESSAGE_START, messageId: streamedMessageId, role: "assistant" } as BaseEvent);
          textStarted = true;
        }
        text += chunk.deltaText;
        observer.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: streamedMessageId, delta: chunk.deltaText } as BaseEvent);
      }

      if (chunk.toolCallDeltas) {
        for (const d of chunk.toolCallDeltas) {
          const cur = toolAcc.get(d.index) ?? { id: "", name: "", args: "" };
          if (d.id) cur.id = d.id;
          if (d.name) cur.name = d.name;
          if (d.argumentsDelta) cur.args += d.argumentsDelta;
          toolAcc.set(d.index, cur);
        }
      }

      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.done) break;
    }
  } finally {
    clearTimeout(timer);
  }

  // 组装 toolCalls（按 index 排序）
  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: v.name, arguments: v.args }));

  // 有工具调用时，finishReason 归一到 tool_calls（部分厂商流式最后才给，或不给）
  if (toolCalls.length > 0 && finishReason !== "tool_calls") finishReason = "tool_calls";

  // 正文已流式发完的纯文本轮：补一个 TEXT_MESSAGE_END
  const textAlreadyStreamed = textStarted && toolCalls.length === 0;
  if (textAlreadyStreamed) {
    observer.next({ type: EventType.TEXT_MESSAGE_END, messageId: streamedMessageId } as BaseEvent);
  }

  const assistantMessage: ChatMessage = {
    role: "assistant",
    ...(text ? { content: text } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(thinking ? { thinking } : {}),
  };

  return {
    text,
    thinking: thinking || undefined,
    toolCalls,
    finishReason,
    usage,
    assistantMessage,
    textAlreadyStreamed,
    streamedMessageId: textAlreadyStreamed ? streamedMessageId : undefined,
  };
}


/**
 * 强制总结也失败时的降级文案。用已收集的工具结果拼一个"任务中断"回复，
 * 避免整个 run 抛 subscriber.error 让用户彻底看不到任何回复。
 */
function buildFallbackReply(toolResults: ToolCallResult[], reason: string): string {
  const lines: string[] = [
    "抱歉，任务执行到一半被中断了。",
    "",
    "中断原因：" + reason,
  ];
  if (toolResults.length > 0) {
    lines.push("", "以下是中断前已经完成的步骤：");
    for (const r of toolResults) {
      // 截断过长的工具输出，只给模型/用户一个概览
      const preview = r.output.length > 200 ? r.output.slice(0, 200) + "…" : r.output;
      lines.push("- 「" + r.toolId + "」：" + preview);
    }
  } else {
    lines.push("", "（暂无已完成的步骤信息）");
  }
  return lines.join("\n");
}

/**
 * 执行一轮 Function Calling 循环（厂商无关），每步发 AG-UI 事件。
 * 内联自 function-calling.ts，保持逻辑一致，只加事件发射。
 */
async function runFcLoopWithEvents(
  options: CyreneRunOptions,
  observer: { next: (e: BaseEvent) => void; error: (e: unknown) => void; complete: () => void },
): Promise<CyreneRunResult> {
  const { settings, messages, timeoutMs } = options;
  const adapter = getAdapter(settings.provider);
  const runTools = options.tools ?? toolRegistry.getEnabledTools();
  const tools = buildToolSpecs(runTools);
  const runnableToolIds = new Set(runTools.filter(t => t.enabled).map(t => t.id));
  const allToolResults: ToolCallResult[] = [];
  const startTime = Date.now();
  let accInput = 0;
  let accOutput = 0;
  let consecutiveTimeouts = 0; // 连续超时计数：达到上限直接跳出走强制总结

  console.log(LOG_PREFIX, `provider=${settings.provider} transport=${adapter.transport} model=${settings.model}`);
  console.log(LOG_PREFIX, "可用工具:", tools.map(t => t.name).join(", ") || "(无)");
  console.log(LOG_PREFIX, "消息数:", messages.length, "最后一角色:", messages[messages.length - 1]?.role);

  // 流式开关：仅 OpenAI transport 且调用方开启时走真流式（思考+答案实时）。
  // Anthropic（MiniMax）多轮 rawAssistant 回传更微妙，即使开关开着也走原非流式路径。
  const useStreaming = options.streamingOutput === true && adapter.transport === "openai";
  console.log(LOG_PREFIX, "流式输出:", useStreaming ? "开启" : "关闭（非流式）");

  let conversation: ChatMessage[] = messages.map(m => ({ ...m }));

  // 清空本轮 skill reference 已读记录，防止跨对话污染
  resetReadRefs();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const roundStart = Date.now();

    if (Date.now() - startTime > timeoutMs) {
      console.warn(LOG_PREFIX, "Function Calling 超时，在第 " + (round + 1) + " 轮退出");
      break;
    }

    observer.next({ type: EventType.STEP_STARTED, stepName: `round-${round + 1}` });
    console.log(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 调用...");

    let req: ChatRequest = {
      model: settings.model,
      messages: conversation,
      ...(tools.length > 0 ? { tools } : {}),
      stream: false,
    };
    if (adapter.applyCacheHints) req = adapter.applyCacheHints(req, settings);

    // ── 分支：流式 vs 非流式 ──────────────────────────────
    // 统一产出 chat（含 text/thinking/toolCalls/assistantMessage/usage/finishReason）+ 标记本轮是否已流式发正文。
    let chat: {
      text: string; thinking?: string; toolCalls: ToolCall[]; finishReason: string;
      usage?: { input: number; output: number }; assistantMessage: ChatMessage;
    };
    let streamedTextInfo: { messageId: string } | null = null;

    if (useStreaming) {
      // —— 新增：真流式路径 ——
      let streamResult: StreamRoundResult;
      try {
        streamResult = await streamOneRound(adapter, req, settings, observer, PER_ROUND_TIMEOUT_MS, round);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          consecutiveTimeouts++;
          console.warn(LOG_PREFIX, "第 " + (round + 1) + " 轮流式请求超时（" + PER_ROUND_TIMEOUT_MS + "ms），连续第 " + consecutiveTimeouts + " 次");
          if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            console.warn(LOG_PREFIX, "连续 " + MAX_CONSECUTIVE_TIMEOUTS + " 次超时，跳出 FC 循环走强制总结");
            observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
            break;
          }
          observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
          continue;
        }
        throw err;
      }
      chat = {
        text: streamResult.text,
        thinking: streamResult.thinking,
        toolCalls: streamResult.toolCalls,
        finishReason: streamResult.finishReason,
        usage: streamResult.usage,
        assistantMessage: streamResult.assistantMessage,
      };
      if (streamResult.textAlreadyStreamed && streamResult.streamedMessageId) {
        streamedTextInfo = { messageId: streamResult.streamedMessageId };
      }
    } else {
      // —— 原非流式路径（原样保留） ——
      const http = adapter.buildRequest(req, settings);
      console.log(LOG_PREFIX, "请求:", http.url);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_ROUND_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(http.url, {
          method: "POST",
          signal: controller.signal,
          headers: http.headers,
          body: http.body,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          consecutiveTimeouts++;
          console.warn(LOG_PREFIX, "第 " + (round + 1) + " 轮 LLM 请求超时（" + PER_ROUND_TIMEOUT_MS + "ms），连续第 " + consecutiveTimeouts + " 次");
          clearTimeout(timer);
          // 连续超时即退出：再重试只会让上下文更长更慢，注定超时。
          // 不再往 conversation 塞"超时提示"消息（雪上加霜），直接跳出走强制总结。
          if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            console.warn(LOG_PREFIX, "连续 " + MAX_CONSECUTIVE_TIMEOUTS + " 次超时，跳出 FC 循环走强制总结");
            observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
            break;
          }
          observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error(LOG_PREFIX, "LLM 请求失败 HTTP " + response.status + ":", errorText.slice(0, 300));
        throw new Error("模型请求失败：HTTP " + response.status + (errorText ? " — " + errorText.slice(0, 200) : ""));
      }

      const data = await response.json();
      chat = adapter.parseResponse(data);
    }

    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1);
    }

    console.log(
      LOG_PREFIX,
      "第 " + (round + 1) + " 轮完成 finish=" + chat.finishReason +
      " toolCalls=" + chat.toolCalls.length + " thinking=" + (chat.thinking ? "有" : "无") +
      " 耗时=" + (Date.now() - roundStart) + "ms",
    );

    // 思考过程（DeepSeek reasoning_content / Anthropic thinking block 等）
    // 非流式：整段一次性发 CUSTOM cyrene.thinking。
    // 流式：streamOneRound 内部已边生成边发（append 语义），这里不再重复发。
    if (!useStreaming && chat.thinking && chat.thinking.trim()) {
      observer.next({
        type: EventType.CUSTOM,
        name: "cyrene.thinking",
        value: { round: round + 1, text: chat.thinking },
      } as BaseEvent);
    }

    // 请求成功，重置连续超时计数
    consecutiveTimeouts = 0;

    // 把 assistant 消息加入对话（adapter 已保留 thinking / rawAssistant 供下轮回传）
    conversation.push(chat.assistantMessage);

    // 情况1：模型要调工具
    if (chat.toolCalls.length > 0) {
      console.log(
        LOG_PREFIX,
        "模型请求调用 " + chat.toolCalls.length + " 个工具:",
        chat.toolCalls.map(tc => tc.name).join(", "),
      );

      const execResults: ToolExecutionResult[] = [];
      for (const tc of chat.toolCalls) {
        const toolCallId = tc.id || `${tc.name}-${Date.now()}`;
        const displayTool = toolRegistry.getById(tc.name);
        // 工具调用开始事件（toolCallName 用显示名，找不到工具则用 id 兜底）
        observer.next({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: displayTool?.name ?? tc.name,
        });

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || "{}");
        } catch {
          console.warn(LOG_PREFIX, "工具参数 JSON 解析失败:", tc.arguments?.slice(0, 100));
        }

        console.log(LOG_PREFIX, "执行工具:", tc.name, JSON.stringify(args).slice(0, 200));

        let output: string;
        const tool = runnableToolIds.has(tc.name) ? toolRegistry.getById(tc.name) : undefined;
        if (!tool || !tool.enabled) {
          output = "[错误] 工具不可用: " + tc.name;
          console.warn(LOG_PREFIX, output);
        } else {
          const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk || "safe";
          const perm = await checkPermission({
            toolId: tc.name,
            toolName: tool.name,
            toolDescription: tool.description,
            args,
            risk,
          });
          if (!perm.allowed) {
            output = "[已拒绝] " + (perm.reason || "权限不足");
            console.warn(LOG_PREFIX, "权限拒绝 [" + tc.name + "]:", perm.reason);
          } else {
            const ctx: ToolContext | undefined = tool.needsContext
              ? { userQuery: extractLastUserQuery(conversation) }
              : undefined;
            try {
              output = await tool.execute(args, ctx);
              console.log(LOG_PREFIX, "工具返回 [" + tc.name + "]:", output.slice(0, 200));
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              output = "[工具执行失败] " + errMsg;
              console.error(LOG_PREFIX, "工具执行失败 [" + tc.name + "]:", errMsg);
            }
          }
        }

        allToolResults.push({ toolId: tc.name, args, output });
        // execResults 进 conversation，截断防单条大结果爆窗
        execResults.push({ toolCall: tc, output: truncateToolResult(output) });

        // 工具调用结果事件 + 结束事件
        observer.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: `${toolCallId}-result`,
          content: output,
        });
        observer.next({ type: EventType.TOOL_CALL_END, toolCallId });
      }

      conversation = adapter.appendToolResults(conversation, execResults);

      // 防线②：窗口级压缩——conversation 累积超阈值时摘要化旧轮次
      conversation = compressConversation(conversation);

      observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
      continue;
    }

    // 情况2：模型正常返回文本 → 发 TEXT_MESSAGE 流
    const content = chat.text || "";
    console.log(LOG_PREFIX, "Function Calling 完成，最终回复长度=" + content.length);
    // 流式路径已在 streamOneRound 内边收边发 TEXT_MESSAGE_*，这里不再重复发（否则正文翻倍）。
    // 非流式路径照旧：一次性切片发出。
    if (!streamedTextInfo) {
      const textMessageId = `msg-${Date.now()}`;
      emitTextMessage(observer, textMessageId, content);
    }

    observer.next({ type: EventType.STEP_FINISHED, stepName: `round-${round + 1}` });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: content, toolResults: allToolResults, totalUsage };
  }

  // 超过最大轮数，强制要求模型总结（不带 tools）
  console.warn(LOG_PREFIX, "达到最大轮数 " + MAX_TOOL_ROUNDS + "，强制要求模型回复");
  conversation.push({
    role: "user",
    content: "请基于以上所有工具返回的信息，给出最终回复。不要继续调用工具。",
  });

  observer.next({ type: EventType.STEP_STARTED, stepName: "force-summary" });

  let finalReq: ChatRequest = {
    model: settings.model,
    messages: conversation,
    stream: false,
  };
  if (adapter.applyCacheHints) finalReq = adapter.applyCacheHints(finalReq, settings);
  const http = adapter.buildRequest(finalReq, settings);
  console.log(LOG_PREFIX, "请求:", http.url);

  const controller = new AbortController();
  // 强制总结是最后兜底：对话历史此时往往已很长，30s 不够模型生成完会被 abort，
  // 导致整个 run 抛错用户彻底没回复。放宽到 90s。
  const timer = setTimeout(() => controller.abort(), FORCE_SUMMARY_TIMEOUT_MS);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      throw new Error("最终回复请求失败：HTTP " + response.status);
    }

    const data = await response.json();
    const chat = adapter.parseResponse(data);
    console.log(LOG_PREFIX, "强制回复完成，长度=" + chat.text.length);
    if (chat.usage) {
      accInput += chat.usage.input;
      accOutput += chat.usage.output;
      recordUsage(chat.usage.input, chat.usage.output, 1);
    }

    // 强制总结轮的思考过程也透传（与主循环一致）
    if (chat.thinking && chat.thinking.trim()) {
      observer.next({
        type: EventType.CUSTOM,
        name: "cyrene.thinking",
        value: { round: 0, text: chat.thinking },
      } as BaseEvent);
    }

    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(observer, textMessageId, chat.text);

    observer.next({ type: EventType.STEP_FINISHED, stepName: "force-summary" });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: chat.text, toolResults: allToolResults, totalUsage };
  } catch (err) {
    // 兜底再失败也别让整个 run 崩掉（subscriber.error 会让用户彻底没回复）。
    // 用已收集的工具结果拼一个"任务中断"文案降级返回。
    const reason = err instanceof Error && err.name === "AbortError"
      ? "总结请求超时"
      : (err instanceof Error ? err.message : String(err));
    console.error(LOG_PREFIX, "强制总结也失败，降级返回已有结果:", reason);
    const fallback = buildFallbackReply(allToolResults, reason);
    const textMessageId = `msg-${Date.now()}`;
    emitTextMessage(observer, textMessageId, fallback);
    observer.next({ type: EventType.STEP_FINISHED, stepName: "force-summary" });
    const totalUsage = (accInput > 0 || accOutput > 0) ? { input: accInput, output: accOutput } : undefined;
    return { reply: fallback, toolResults: allToolResults, totalUsage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * CyreneAgent —— 单次对话一个实例。
 *
 * 用法：
 *   const agent = new CyreneAgent({ threadId });
 *   const result = await agent.runAgentWith(options);  // 跑循环 + 事件流
 *
 * 注意：不直接用 runAgent(parameters)，因为我们的输入（settings/messages）是自定义的，
 * 通过 runOptions 传入更直接。runAgent 的 Observable 桥接在桥层做。
 */
export class CyreneAgent extends AbstractAgent {
  /** 跑循环结果，run() 完成后可取（供桥层做副作用）。 */
  lastResult?: CyreneRunResult;

  /**
   * 跑 FC 循环并返回事件流。桥层订阅这个流转发给渲染进程。
   * 传入的 options 会原样跑——settings/messages/timeout 都在这里。
   */
  runWithEvents(options: CyreneRunOptions): Observable<BaseEvent> {
    const threadId = this.threadId;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      (async () => {
        try {
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });
          const result = await runFcLoopWithEvents(options, subscriber);
          this.lastResult = result;
          if (cancelled) return;
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          });
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          console.error(LOG_PREFIX, "run 失败:", err);
          subscriber.error(err instanceof Error ? err : new Error(String(err)));
        }
      })();

      return () => { cancelled = true; };
    });
  }

  // AbstractAgent 要求实现 run(input)，但我们用 runWithEvents 更直接。
  // 保留 run 作为一个薄封装，供标准 AG-UI 调用路径（暂不用）。
  protected _runOptions?: CyreneRunOptions;
  run(input: RunAgentInput): Observable<BaseEvent> {
    if (!this._runOptions) {
      return new Observable<BaseEvent>((s) => {
        s.error(new Error("CyreneAgent.run 被直接调用，但未设置 _runOptions。请用 runWithEvents。"));
      });
    }
    void input;
    return this.runWithEvents(this._runOptions);
  }
}
