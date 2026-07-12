import "../ui/base.css";
import "./chat.css";
import "../ui/theme";
import {
  CHAT_DEFAULT_IDENTITY_LABEL,
  formatChatRelativeTime,
  type ChatSessionMetaUI,
} from "../../shared/chat-ui";
import { canUseMinimaxStreamingEarly, extractEarlyTtsSegment } from "../../shared/tts-early-playback";
import { getStickerSrcForId } from "./sticker-src";
import { resolveAsset } from "../../shared/renderer-base";

type Role = "user" | "model";

interface Message {
  id: string;
  role: Role;
  content: string;
  at: number;
  sticker?: string | null;
  thinking?: boolean;
  /** 思考过程文本（DeepSeek reasoning 等）。瞬态、不持久化，前端渲染成折叠块。 */
  thinkingText?: string;
  /** 本轮 AI 是否调用了写类/副作用工具（写文件/改文件/跑命令/发邮件等）。
   *  为 true 时禁止"重新生成/编辑重发"，避免重复副作用。 */
  usedWriteTool?: boolean;
  ttsCacheKey?: string;
}

interface ChatReplyPayload {
  reply: string;
  sticker: string | null;
}

function normalizeChatReplyPayload(payload: unknown): ChatReplyPayload {
  if (typeof payload === "string") {
    return { reply: payload.trim(), sticker: null };
  }

  if (payload && typeof payload === "object") {
    const record = payload as Partial<ChatReplyPayload>;
    return {
      reply: typeof record.reply === "string" ? record.reply.trim() : "",
      sticker: record.sticker ?? null,
    };
  }

  return { reply: "", sticker: null };
}

interface ModelConfig {
  mode: "auto" | "manual";
  provider: string;
  model: string;
  connected: boolean;
  stickerSize: "small" | "standard" | "large";
}

interface ModelConfigApi {
  get: () => Promise<ModelConfig>;
  onChanged: (callback: (config: ModelConfig) => void) => () => void;
}

interface ChatApi {
    minimize: () => void;
    close: () => void;
    toggleMaximize: () => void;
    isMaximized: () => Promise<boolean>;
    sendMessage: (messages: Array<{ role: "user" | "model"; content: string }>, style: string) => Promise<ChatReplyPayload>;
    ingestDroppedFiles: (files: File[]) => Promise<Attachment[]>;
    getEnabledStickers?: () => Promise<Array<{ id: string; src: string; description?: string }>>;
  }

/** AG-UI 事件流 API（window.agui）。 */
const BUDGET_CHARS = 60000;

/* ===== TTS 朗读按钮 SVG =====
   静态版用单条弧线表示喇叭外溢，播放版换成三条音波竖线 + CSS 动画做波浪。
   颜色全部 currentColor，主题色变了会跟着变；不依赖 emoji 字体。 */
const SPEAK_ICON_IDLE = `<svg class="msg__speak-icon msg__speak-icon--idle" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M3 10v4h4l5 4V6L7 10H3z" fill="currentColor"/>
  <path d="M16 8.5a4 4 0 0 1 0 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
</svg>`;
const SPEAK_ICON_ACTIVE = `<svg class="msg__speak-icon msg__speak-icon--active" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M3 10v4h4l5 4V6L7 10H3z" fill="currentColor"/>
  <path class="msg__speak-wave msg__speak-wave--1" d="M14 9.5v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="msg__speak-wave msg__speak-wave--2" d="M17 7.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  <path class="msg__speak-wave msg__speak-wave--3" d="M20 5.5v13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

/* ===== 复制按钮 SVG =====
   静态版两个重叠方框（标准复制图标），复制成功版换成对勾 + 文案"已复制"。 */
const COPY_ICON_IDLE = `<svg class="msg__copy-icon msg__copy-icon--idle" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/>
  <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const COPY_ICON_DONE = `<svg class="msg__copy-icon msg__copy-icon--done" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
  <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

interface AguiApi {
  run: (input: { messages: unknown[]; style: string; sessionId?: string; attachments?: { name: string; text: string }[] }) => Promise<{ success: boolean; error?: string }>;
  onEvent: (callback: (event: unknown) => void) => () => void;
  cancel: () => Promise<boolean>;
}

interface SchedulerEventsApi {
  onEvent: (callback: (event: unknown) => void) => () => void;
}

/** 用户选择卡片 API（window.choice）。卡片展示走 AGUI_EVENT CUSTOM，resolve 走独立 IPC。 */
interface ChoiceApi {
  resolve: (id: string, value: string) => Promise<unknown>;
}

/** AG-UI BaseEvent 的最小本地类型（只取我们关心的字段）。 */
interface AguiBaseEvent {
  type: string;
  messageId?: string;
  delta?: string;
  role?: string;
  toolCallId?: string;
  toolCallName?: string;
  toolRisk?: string; // 工具危险等级：safe/fs-read/fs-write/shell/network/input-control
  content?: string;
  error?: string;
  stepName?: string;
  runId?: string;
  threadId?: string;
  schedulerRunId?: string;
  schedulerTaskId?: string;
  name?: string;   // CUSTOM 事件的 name
  value?: unknown; // CUSTOM 事件的 value
}

/** 写类/副作用工具的 risk 等级：这些工具会改磁盘/系统状态，重发会重复副作用。 */
function isWriteRisk(risk?: string): boolean {
  return risk === "fs-write" || risk === "shell" || risk === "input-control";
}

/** 文件摄入结果（与 main 侧 file-ingest.ts 的 Attachment 对齐）。 */
type AttachmentKind = "text" | "indexed" | "empty" | "unsupported";

interface Attachment {
  name: string;
  kind: AttachmentKind;
  text?: string;
  chunks?: number;
  reason?: string;
}

/** 任务清单状态（todo_write 工具推过来的）。 */
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}
interface TodoState {
  todos: TodoItem[];
  updatedAt: number;
}

declare global {
  interface Window {
    chat?: ChatApi;
    agui?: AguiApi;
    schedulerEvents?: SchedulerEventsApi;
    modelConfig?: ModelConfigApi;
    choice?: ChoiceApi;
  }
}

const messagesEl = document.getElementById("messages") as HTMLElement;
const formEl = document.getElementById("composer") as HTMLFormElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const stickerPickerBtn = document.getElementById("sticker-picker-btn") as HTMLButtonElement;
const stickerPicker = document.getElementById("sticker-picker") as HTMLElement;
const stickerPickerGrid = document.getElementById("sticker-picker-grid") as HTMLElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const minBtn = document.getElementById("min-btn") as HTMLButtonElement;
const maxBtn = document.getElementById("max-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const chatHintEl = document.getElementById("chat-hint") as HTMLElement;
const chatStatusBtn = document.getElementById("chat-status-btn") as HTMLButtonElement;
const chatRail = document.getElementById("chat-rail") as HTMLElement | null;
const chatRailNew = document.getElementById("chat-rail-new") as HTMLButtonElement | null;
const chatRailList = document.getElementById("chat-rail-list") as HTMLElement | null;
const chatRailEmpty = document.getElementById("chat-rail-empty") as HTMLElement | null;
const workspaceBtn = document.getElementById("workspace-btn") as HTMLButtonElement | null;
const workspaceLabel = document.getElementById("workspace-label") as HTMLElement | null;
const workspaceClear = document.getElementById("workspace-clear") as HTMLElement | null;

// 旧版 localStorage key——首次启动时检测到老数据会迁移到主进程 chats 存储再清掉。
const LEGACY_STORAGE_KEY = "cyrene.chat.history.v1";
const FRONTEND_REPLY_TIMEOUT_MS = 35000;

/**
 * Avatar source per role. Empty string = use the gradient placeholder
 * baked into the CSS background of `.msg--user .msg__avatar`.
 *
 * Model side: 昔涟的 PNG，由 CSS border-radius: 50% 自动裁圆。
 * User side: 暂留空，等设置页里上传用户头像后再把 user 改成 file:// 或 data: URL。
 */
const AVATAR_SRC: Record<Role, string> = {
  model: resolveAsset("avatars/cyrene-avatar.png"),
  user: "",
};

// Load user avatar from profile
(async () => {
  try {
    const dataUrl = await (window as any).user?.getAvatar();
    if (dataUrl) {
      AVATAR_SRC.user = dataUrl;
      render();
    }
  } catch { /* ignore */ }
})();

const BUILT_IN_STICKER_SRC: Record<string, string> = {
  playful: "/stickers/playful.png",
  "love-happy": "/stickers/love-happy.png",
  confident: "/stickers/confident.png",
  serious: "/stickers/serious.png",
  calm: "/stickers/calm.png",
  peek: "/stickers/peek.gif",
  "clingy-confused": "/stickers/clingy-confused.gif",
  "love-calm": "/stickers/love-calm.png",
  HI: "/stickers/HI.jpg",
  hello: "/stickers/hello.jpg",
  goodmoring1: "/stickers/goodmoring1.jpg",
  goodnight: "/stickers/goodnight.jpg",
  teatime: "/stickers/teatime.jpg",
  eating: "/stickers/eating.jpg",
  Allset: "/stickers/Allset.jpg",
  OK: "/stickers/OK.jpg",
  copythat: "/stickers/copythat.jpg",
  Thumbsup: "/stickers/Thumbsup.jpg",
  awesome: "/stickers/awesome.jpg",
  sogood: "/stickers/sogood.jpg",
  sonice: "/stickers/sonice.jpg",
  fighting: "/stickers/fighting.jpg",
  hellyeah: "/stickers/hellyeah.jpg",
  Thanks: "/stickers/Thanks.jpg",
  foryou: "/stickers/foryou.jpg",
  blushhard: "/stickers/blushhard.jpg",
  shyshort: "/stickers/shyshort.jpg",
  hmph: "/stickers/hmph.jpg",
  hugtight: "/stickers/hugtight.jpg",
  Airkiss: "/stickers/Airkiss.jpg",
  Gigglelots: "/stickers/Gigglelots.jpg",
  thinking: "/stickers/thinking.jpg",
  putmd: "/stickers/putmd.jpg",
  Whatswrong: "/stickers/Whatswrong.jpg",
  midmeh: "/stickers/midmeh.jpg",
  awkward: "/stickers/awkward.jpg",
  Madnow: "/stickers/Madnow.jpg",
  Hurtcry: "/stickers/Hurtcry.jpg",
  Sobbinghard: "/stickers/Sobbinghard.jpg",
  weeploud: "/stickers/weeploud.jpg",
  PanincCrying: "/stickers/PanincCrying.jpg",
  missme: "/stickers/missme.jpg",
  Free: "/stickers/Free.jpg",
  Dreak: "/stickers/Dreak.jpg",
  outfast: "/stickers/outfast.jpg",
  Vcayover: "/stickers/Vcayover.jpg",
  sleepynow: "/stickers/sleepynow.jpg",
  deadtired: "/stickers/deadtired.jpg",
  sotired: "/stickers/sotired.jpg",
  giveup: "/stickers/giveup.jpg",
  poorwallet: "/stickers/poorwallet.jpg",
  please: "/stickers/please.jpg",
};

function getStickerSrc(id: string): string | undefined {
  const raw = getStickerSrcForId(id, BUILT_IN_STICKER_SRC, enabledStickers);
  if (!raw) return undefined;
  // 内置贴纸路径以 /stickers/ 开头（绝对路径），在 file:// 协议下会解析到磁盘根
  // 用 resolveAsset() 转成正确的 file:// 或 http:// URL
  if (raw.startsWith("/stickers/")) {
    return resolveAsset(raw);
  }
  return raw;
}

// 多会话改造：messages 是当前活跃 session 的消息数组（启动时为空，由 bootstrap 填充）。
// currentSessionId 是当前正在显示的会话 id，所有持久化操作都基于它。
// 启动期间 currentSessionId 为 null，发送按钮通过 sending 标志兜底（bootstrap 极快）。
const messages: Message[] = [];
let currentSessionId: string | null = null;
let currentModelConfig: ModelConfig | null = null;
// 是否显示模型思考过程（DeepSeek reasoning 等）。由通用设置控制，默认显示。
let showThinking = true;

function formatModelHint(config: ModelConfig | null): string {
  if (!config || !config.connected) return "模型未连接";
  return `${config.model} 已连接`;
}

function applyModelConfig(config: ModelConfig | null): void {
  currentModelConfig = config;
  chatHintEl.textContent = formatModelHint(config);
  document.documentElement.dataset.stickerSize = config?.stickerSize ?? "standard";
}

async function refreshModelConfig(): Promise<boolean> {
  try {
    const config = await window.modelConfig?.get();
    applyModelConfig(config ?? null);
    return Boolean(config?.connected);
  } catch (err) {
    console.warn("[Cyrene Chat] model config unavailable:", err);
    applyModelConfig(null);
    return false;
  }
}

async function initModelConfig(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await refreshModelConfig()) break;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  window.modelConfig?.onChanged((config) => applyModelConfig(config));
}

// ── 工作目录（workspace）UI ──────────────────────────────────
// 顶部按钮显示当前 agent 基准目录；点击选目录，✕ 清除回到纯聊天。
// 只取目录名做短标签，完整路径放 title 悬浮提示。
function applyWorkspace(dir: string): void {
  if (!workspaceBtn || !workspaceLabel || !workspaceClear) return;
  if (dir) {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    workspaceLabel.textContent = name;
    workspaceBtn.title = "工作目录：" + dir + "（点击切换）";
    workspaceBtn.classList.add("is-active");
    workspaceClear.hidden = false;
  } else {
    workspaceLabel.textContent = "选择目录";
    workspaceBtn.title = "选择工作目录（agent 基准目录）";
    workspaceBtn.classList.remove("is-active");
    workspaceClear.hidden = true;
  }
}

async function initWorkspace(): Promise<void> {
  if (!workspaceBtn) return;
  try {
    const cur = await window.workspace?.get();
    applyWorkspace(cur?.dir ?? "");
  } catch { applyWorkspace(""); }

  workspaceBtn.addEventListener("click", async (e) => {
    // 点 ✕ 走清除分支，不触发选目录
    if ((e.target as HTMLElement)?.id === "workspace-clear") return;
    try {
      const res = await window.workspace?.pick();
      if (res?.ok && res.dir !== undefined) applyWorkspace(res.dir);
      else if (res && !res.ok && !res.canceled && res.error) console.warn("[Cyrene Chat] 选择工作目录失败:", res.error);
    } catch (err) {
      console.warn("[Cyrene Chat] 选择工作目录异常:", err);
    }
  });

  workspaceClear?.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const res = await window.workspace?.set("");
      if (res?.ok) applyWorkspace("");
    } catch (err) {
      console.warn("[Cyrene Chat] 清除工作目录异常:", err);
    }
  });

  // 其他窗口改了工作目录时同步 UI
  window.workspace?.onChanged((dir) => applyWorkspace(dir));
}

// ── 多会话存储桥接 ───────────────────────────────────────────
// 旧版聊天记录从 localStorage 一次性迁移到主进程 chats 存储，之后整窗口
// 所有读写都走 IPC（window.chatStore）。所有 saveHistory 调用点改成
// saveSession，本质是把 messages 全量回写当前 session 文件。
// 会话元数据类型用 shared 的 ChatSessionMetaUI（跟设置面板共用）。

interface ChatStoreSession {
  id: string;
  title: string;
  identityId: string | null;
  messages: Array<{
    id: string;
    role: Role;
    content: string;
    at: number;
    sticker?: string | null;
    ttsCacheKey?: string;
    usedWriteTool?: boolean;
  }>;
  createdAt: number;
  updatedAt: number;
  schemaVersion: 1;
}

interface ChatStoreApi {
  list: () => Promise<ChatSessionMetaUI[]>;
  get: (id: string) => Promise<ChatStoreSession | null>;
  create: (payload?: { title?: string; identityId?: string | null }) => Promise<ChatStoreSession>;
  append: (id: string, message: unknown) => Promise<ChatStoreSession | null>;
  replaceMessages: (id: string, messages: unknown[]) => Promise<ChatStoreSession | null>;
  rename: (id: string, title: string) => Promise<ChatStoreSession | null>;
  delete: (id: string) => Promise<boolean>;
  openFolder: () => Promise<boolean>;
  migrateLegacy: (messages: unknown[]) => Promise<ChatStoreSession | null>;
  openInChatWindow: (sessionId: string) => Promise<boolean>;
  setActiveSession: (sessionId: string | null) => Promise<boolean>;
  getActiveSession: () => Promise<string | null>;
  onActiveSessionChanged: (callback: (sessionId: string | null) => void) => () => void;
  onChanged: (callback: () => void) => () => void;
  onSwitchSession: (callback: (sessionId: string) => void) => () => void;
}

declare global {
  interface Window {
    chatStore?: ChatStoreApi;
    workspace?: WorkspaceApi;
  }
}

// 工作目录（workspace）：agent 的当前基准目录（可选，空=纯聊天模式）
interface WorkspaceApi {
  get: () => Promise<{ dir: string }>;
  set: (dir: string | null) => Promise<{ ok: boolean; dir?: string; error?: string }>;
  pick: () => Promise<{ ok: boolean; dir?: string; error?: string; canceled?: boolean }>;
  onChanged: (callback: (dir: string) => void) => () => void;
}

// 把渲染端 Message 数组归一化为后端能持久化的形态：
// - 过滤空 content / 渲染中的 thinking 占位（thinking=true 时通常 content 为空，但保险起见双重过滤）
// - 丢弃 thinking 字段（持久化层不存这种瞬态状态）
function toPersistableMessages(arr: Message[]): Array<{
  id: string; role: Role; content: string; at: number; sticker?: StickerId | null; ttsCacheKey?: string; usedWriteTool?: boolean;
}> {
  return arr
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim() && !m.thinking)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
      ...(m.usedWriteTool ? { usedWriteTool: true } : {}),
    }));
}

async function saveSession(): Promise<void> {
  if (!currentSessionId || !window.chatStore) return;
  try {
    await window.chatStore.replaceMessages(currentSessionId, toPersistableMessages(messages));
  } catch (err) {
    console.warn("[Cyrene Chat] saveSession 失败:", err);
  }
}

// 把 store 里的 ChatStoreSession 装载到当前窗口（替换 messages 数组并 render）。
function loadSessionIntoUI(session: ChatStoreSession): void {
  currentSessionId = session.id;
  messages.length = 0;
  for (const m of session.messages) {
    messages.push({
      id: m.id,
      role: m.role,
      content: m.content,
      at: m.at,
      sticker: m.sticker ?? null,
      ttsCacheKey: m.ttsCacheKey,
      usedWriteTool: m.usedWriteTool,
    });
  }
  // 上报活跃 sessionId（设置面板"删除当前会话"差异化提示用）
  void window.chatStore?.setActiveSession(session.id);
  render();
  // 切换会话后刷新侧栏列表的活跃高亮
  void renderRailList();
}

// ══════════════════════════════════════════════════════════════
// 通用右键/悬停菜单：一个浮层，按传入的菜单项渲染，点击外部关闭。
// 供会话侧栏项、单条消息复用。
// ══════════════════════════════════════════════════════════════
interface CtxMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

let ctxMenuEl: HTMLElement | null = null;

function closeContextMenu(): void {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
    document.removeEventListener("click", onDocClickCloseMenu, true);
    document.removeEventListener("keydown", onEscCloseMenu, true);
    window.removeEventListener("blur", closeContextMenu);
  }
}
function onDocClickCloseMenu(e: MouseEvent): void {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeContextMenu();
}
function onEscCloseMenu(e: KeyboardEvent): void {
  if (e.key === "Escape") closeContextMenu();
}

/** 在 (x,y) 处弹出上下文菜单。会自动避免超出视口。 */
function openContextMenu(x: number, y: number, items: CtxMenuItem[]): void {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ctx-menu__item" + (it.danger ? " ctx-menu__item--danger" : "");
    if (it.icon) {
      const ic = document.createElement("span");
      ic.className = "ctx-menu__icon";
      ic.textContent = it.icon;
      row.appendChild(ic);
    }
    const lb = document.createElement("span");
    lb.textContent = it.label;
    row.appendChild(lb);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      it.onClick();
    });
    menu.appendChild(row);
  }
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  // 避免超出视口
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, px) + "px";
  menu.style.top = Math.max(8, py) + "px";
  menu.style.visibility = "";
  ctxMenuEl = menu;
  // 延迟挂监听，避免本次触发的 click 立即关闭
  setTimeout(() => {
    document.addEventListener("click", onDocClickCloseMenu, true);
    document.addEventListener("keydown", onEscCloseMenu, true);
    window.addEventListener("blur", closeContextMenu);
  }, 0);
}

/** 轻量输入弹窗（Electron 禁用了 window.prompt，自实现）。返回 null=取消。 */
function showChatInputModal(opts: { title: string; defaultValue?: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "chat-modal-overlay";
    const box = document.createElement("div");
    box.className = "chat-modal";
    const h = document.createElement("div");
    h.className = "chat-modal__title";
    h.textContent = opts.title;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "chat-modal__input";
    input.value = opts.defaultValue ?? "";
    input.placeholder = opts.placeholder ?? "";
    const actions = document.createElement("div");
    actions.className = "chat-modal__actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "chat-modal__btn";
    cancel.textContent = "取消";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "chat-modal__btn chat-modal__btn--primary";
    ok.textContent = "确定";
    actions.appendChild(cancel);
    actions.appendChild(ok);
    box.appendChild(h);
    box.appendChild(input);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const cleanup = (val: string | null) => { overlay.remove(); resolve(val); };
    cancel.addEventListener("click", () => cleanup(null));
    ok.addEventListener("click", () => cleanup(input.value));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); cleanup(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}


// ── 会话侧栏（点左上角 loader 展开）──
// 精简版：+新对话 / 列表点击切换 / 活跃高亮。改名删除留设置面板。
// 渲染逻辑跟 settings.ts 的 renderChatSessions 同源（复用 shared 的格式化函数），
// 但点击行为不同：这里是本地 loadSessionIntoUI，不走跨窗口 IPC，更快。

async function renderRailList(): Promise<void> {
  if (!chatRailList || !window.chatStore) return;

  let sessions: ChatSessionMetaUI[] = [];
  try {
    sessions = await window.chatStore.list();
  } catch (err) {
    console.warn("[Cyrene Chat] 侧栏加载会话列表失败:", err);
  }

  chatRailList.innerHTML = "";
  if (sessions.length === 0) {
    if (chatRailEmpty) chatRailEmpty.classList.remove("is-hidden");
    return;
  }
  if (chatRailEmpty) chatRailEmpty.classList.add("is-hidden");

  for (const session of sessions) {
    const item = buildRailItem(session);
    chatRailList.appendChild(item);
  }
}

function buildRailItem(session: ChatSessionMetaUI): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "chat__rail-item";
  if (session.id === currentSessionId) li.classList.add("is-active");
  li.dataset.sessionId = session.id;

  const titleEl = document.createElement("div");
  titleEl.className = "chat__rail-title";
  titleEl.textContent = session.title || "新对话";

  const metaEl = document.createElement("div");
  metaEl.className = "chat__rail-meta";

  const timeEl = document.createElement("span");
  timeEl.className = "chat__rail-time";
  timeEl.textContent = formatChatRelativeTime(session.updatedAt);

  const identityEl = document.createElement("span");
  identityEl.className = "chat__rail-identity";
  identityEl.textContent = "💼 " + (session.identityId ? session.identityId : CHAT_DEFAULT_IDENTITY_LABEL);

  metaEl.appendChild(timeEl);
  metaEl.appendChild(identityEl);

  // 点击列表项 = 本地切换会话（不走跨窗口 IPC，比设置面板还快）
  li.addEventListener("click", async () => {
    if (session.id === currentSessionId) return;
    const full = await window.chatStore?.get(session.id);
    if (full) loadSessionIntoUI(full as ChatStoreSession);
  });

  // 右键菜单：重命名 / 删除
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openSessionMenu(session, e.clientX, e.clientY);
  });

  li.appendChild(titleEl);
  li.appendChild(metaEl);
  return li;
}

/** 会话项菜单：重命名 / 删除。 */
function openSessionMenu(session: ChatSessionMetaUI, x: number, y: number): void {
  openContextMenu(x, y, [
    {
      label: "重命名", icon: "✏️",
      onClick: async () => {
        const name = await showChatInputModal({ title: "重命名会话", defaultValue: session.title || "" });
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await window.chatStore?.rename(session.id, trimmed);
          await renderRailList();
        } catch (err) { console.warn("[Cyrene Chat] 重命名失败:", err); }
      },
    },
    {
      label: "删除", icon: "🗑", danger: true,
      onClick: async () => {
        const ok = window.confirm(`删除会话「${session.title || "新对话"}」？此操作不可撤销。`);
        if (!ok) return;
        try {
          await window.chatStore?.delete(session.id);
          // 删的是当前会话：切到一个新会话或空态
          if (session.id === currentSessionId) {
            const created = await window.chatStore?.create({ identityId: null });
            if (created?.id) {
              const full = await window.chatStore?.get(created.id);
              if (full) loadSessionIntoUI(full as ChatStoreSession);
            }
          }
          await renderRailList();
        } catch (err) { console.warn("[Cyrene Chat] 删除会话失败:", err); }
      },
    },
  ]);
}

// ══════════════════════════════════════════════════════════════
// 单条消息操作：复制 / 删除 / 重新生成(AI) / 编辑重发(用户)
// ══════════════════════════════════════════════════════════════
/** 打开单条消息的操作菜单。 */
function openMessageMenu(m: Message, x: number, y: number): void {
  const items: CtxMenuItem[] = [];
  const plainText = m.role === "user"
    ? m.content.replace(/\[sticker:[^\]]+\]/g, "").trim()
    : m.content;

  if (plainText) {
    items.push({
      label: "复制", icon: "📋",
      onClick: () => { void copyTextToClipboard(plainText); },
    });
  }

  // 只有"最新一轮"才允许编辑重发/重新生成，且该轮未调用写类工具（避免重复副作用）。
  const lastUserId = [...messages].reverse().find(x => x.role === "user")?.id;
  const lastModelMsg = [...messages].reverse().find(x => x.role === "model");
  // 最新 AI 回复是否用过写类工具（编辑重发会重跑这轮，因此也要看它）
  const lastTurnUsedWriteTool = !!lastModelMsg?.usedWriteTool;

  if (m.role === "user") {
    // 编辑重发：仅对最新的用户消息开放，且最新一轮没有写类工具副作用
    if (m.id === lastUserId && !lastTurnUsedWriteTool) {
      items.push({
        label: "编辑并重发", icon: "✏️",
        onClick: () => startInlineEdit(m),
      });
    }
  } else {
    // 重新生成：仅对最新的 AI 回复开放，且该回复没有写类工具副作用
    if (m.id === lastModelMsg?.id && !m.usedWriteTool) {
      items.push({
        label: "重新生成", icon: "🔄",
        onClick: () => { void regenerateMessage(m); },
      });
    }
  }

  items.push({
    label: "删除", icon: "🗑", danger: true,
    onClick: () => { void deleteMessage(m); },
  });

  openContextMenu(x, y, items);
}

/** 删除单条消息。 */
async function deleteMessage(m: Message): Promise<void> {
  if (sending) { window.alert("生成中，请先停止再操作。"); return; }
  const idx = messages.findIndex(x => x.id === m.id);
  if (idx < 0) return;
  messages.splice(idx, 1);
  await saveSession();
  render();
}

/**
 * 重新生成某条 AI 回复：删除该回复及其之后的所有消息，
 * 保留到上一条用户消息，然后基于现有历史重新触发一次生成。
 */
async function regenerateMessage(m: Message): Promise<void> {
  if (sending) { window.alert("生成中，请先停止再操作。"); return; }
  const idx = messages.findIndex(x => x.id === m.id);
  if (idx < 0) return;
  // 删除这条 AI 回复及之后的所有内容
  messages.splice(idx);
  // 取出最后一条用户消息：把它也移除，交给 send() 重新添加 + 重发（避免重复）
  const lastUserIdx = [...messages].map(x => x.role).lastIndexOf("user");
  if (lastUserIdx < 0) { await saveSession(); render(); return; }
  const lastUser = messages[lastUserIdx];
  const userText = lastUser.content;
  // 移除该用户消息及其之后（正常情况下其后已无内容）
  messages.splice(lastUserIdx);
  await saveSession();
  render();
  await send(userText);
}

/** 供内联编辑重发用：以指定文本作为新一轮用户输入发送。 */
async function sendProgrammatic(text: string): Promise<void> {
  await send(text);
}

/** 编辑用户消息（气泡内联编辑）。确认后截断其后历史并重发。 */
function startInlineEdit(m: Message): void {
  if (sending) { window.alert("生成中，请先停止再操作。"); return; }
  const row = messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
  if (!row) return;
  const bubble = row.querySelector(".msg__bubble") as HTMLElement | null;
  if (!bubble) return;
  const original = m.content.replace(/\[sticker:[^\]]+\]/g, "").trim();

  // 用 textarea 替换气泡内容
  bubble.replaceChildren();
  bubble.classList.add("msg__bubble--editing");
  const ta = document.createElement("textarea");
  ta.className = "msg__edit-input";
  ta.value = original;
  const btnRow = document.createElement("div");
  btnRow.className = "msg__edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "msg__edit-btn";
  cancel.textContent = "取消";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "msg__edit-btn msg__edit-btn--primary";
  save.textContent = "保存并重发";
  btnRow.appendChild(cancel);
  btnRow.appendChild(save);
  bubble.appendChild(ta);
  bubble.appendChild(btnRow);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autosizeTextarea(ta);
  ta.addEventListener("input", () => autosizeTextarea(ta));

  const doCancel = () => render();
  const doSave = async () => {
    const next = ta.value.trim();
    if (!next) { doCancel(); return; }
    const idx = messages.findIndex(x => x.id === m.id);
    if (idx < 0) { doCancel(); return; }
    // 截断：保留到这条用户消息之前，删掉它及其之后的所有消息
    messages.splice(idx);
    await saveSession();
    render();
    // 用编辑后的内容作为新的一轮用户输入重发
    await sendProgrammatic(next);
  };
  cancel.addEventListener("click", doCancel);
  save.addEventListener("click", () => { void doSave(); });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSave(); }
    else if (e.key === "Escape") { e.preventDefault(); doCancel(); }
  });
}

function autosizeTextarea(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
}

chatStatusBtn?.addEventListener("click", () => {
  if (!chatRail) return;
  chatRail.toggleAttribute("hidden");
  // 首次展开时拉一次列表（后续由 onChanged 持续刷新）
  if (!chatRail.hidden) void renderRailList();
});

// +新对话
chatRailNew?.addEventListener("click", async () => {
  if (!window.chatStore) return;
  try {
    const session = await window.chatStore.create({ identityId: null });
    if (session?.id) {
      const full = await window.chatStore.get(session.id);
      if (full) loadSessionIntoUI(full as ChatStoreSession);
    }
  } catch (err) {
    console.warn("[Cyrene Chat] 新建会话失败:", err);
  }
});

// 一次性迁移：检测老 localStorage 数据 → 包成 session → 删 key。
// 失败/没数据时静默 no-op，不影响后续 bootstrap。
async function maybeMigrateLegacy(): Promise<void> {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    const normalized = (parsed as Message[]).filter(
      (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
    );
    if (normalized.length === 0) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }
    await window.chatStore?.migrateLegacy(normalized);
  } catch (err) {
    console.warn("[Cyrene Chat] 旧 localStorage 迁移失败:", err);
  } finally {
    // 不管成功失败都清掉，避免每次启动都尝试迁移
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

// 启动流程：迁移老数据 → 决定加载哪个 session → render
async function bootstrap(): Promise<void> {
  if (!window.chatStore) {
    console.warn("[Cyrene Chat] chatStore IPC 未就绪——可能是 preload 未加载");
    render();
    return;
  }

  await maybeMigrateLegacy();

  // 优先级：URL ?sessionId= → 列表最新一条 → 自动建新
  const urlSessionId = new URLSearchParams(window.location.search).get("sessionId");
  let session: ChatStoreSession | null = null;

  if (urlSessionId) {
    session = await window.chatStore.get(urlSessionId);
  }
  if (!session) {
    const list = await window.chatStore.list();
    if (list.length > 0) {
      session = await window.chatStore.get(list[0].id);
    }
  }
  if (!session) {
    session = await window.chatStore.create({ identityId: null });
  }

  loadSessionIntoUI(session);
}

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 渲染左上角任务进度面板。todos 为空时收起并稍后移除。
 *  面板可收缩/展开：点击 header 或 toggle 按钮切换。 */
function renderTodoPanel(state: TodoState | null): void {
  let panel = document.querySelector(".todo-panel") as HTMLElement | null;

  // 空清单：收起动画后移除
  if (!state || !state.todos || state.todos.length === 0) {
    if (panel) {
      panel.classList.add("empty");
      setTimeout(() => panel?.remove(), 300);
    }
    return;
  }

  // 首次出现：建面板
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "todo-panel";
    document.body.appendChild(panel);
  }
  panel.classList.remove("empty");

  const total = state.todos.length;
  const done = state.todos.filter((t) => t.status === "completed").length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const checkIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" style="width:0.75rem;height:0.75rem"><path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd"/></svg>`;

  const priorityBadge = (p: string): string => {
    if (p === "high") return `<span class="todo-badge todo-badge--high">高优先级</span>`;
    if (p === "medium") return `<span class="todo-badge todo-badge--medium">中优先级</span>`;
    if (p === "low") return `<span class="todo-badge todo-badge--low">低优先级</span>`;
    return "";
  };

  const statusIcon = (s: string): string => {
    if (s === "completed") return checkIcon;
    if (s === "in_progress") return "●";
    return "";
  };

  // 检查当前是否已收缩（保留状态）
  const wasCollapsed = panel.classList.contains("todo-panel--collapsed");

  panel.innerHTML = `
    <div class="todo-panel__header">
      <div>
        <div class="todo-panel__title">📋 任务进度</div>
        <div class="todo-panel__count">${done}/${total} 已完成</div>
      </div>
      <span class="todo-panel__toggle">${wasCollapsed ? "▸" : "▾"}</span>
    </div>
    <div class="todo-panel__body">
      <hr class="todo-panel__divider" />
      <div class="todo-panel__progress">
        <div class="todo-progress__track"><div class="todo-progress__fill" style="width:${pct}%"></div></div>
        <span class="todo-progress__label">${pct}%</span>
      </div>
      <div class="todo-list">
        ${state.todos.map(t => `
          <div class="todo-item ${t.status}">
            <span class="todo-item__icon">${statusIcon(t.status)}</span>
            <span class="todo-item__text">${escapeHtml(t.content)}</span>
            <span class="todo-item__meta">${priorityBadge(t.priority || "")}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  if (wasCollapsed) panel.classList.add("todo-panel--collapsed");

  // 收缩/展开 toggle
  const togglePanel = () => {
    if (!panel) return;
    const collapsed = panel.classList.toggle("todo-panel--collapsed");
    const toggleBtn = panel.querySelector(".todo-panel__toggle");
    if (toggleBtn) toggleBtn.textContent = collapsed ? "▸" : "▾";
  };

  panel.querySelector(".todo-panel__header")?.addEventListener("click", togglePanel);
  panel.querySelector(".todo-panel__toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]!));
}

/** 构建用户选择卡片 DOM 元素（歧义消解器），插入聊天流让用户选选项。 */
function buildChoiceCardEl(data: {
  id: string;
  question: string;
  options: Array<{ label: string; value: string; description?: string }>;
  default?: string;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "choice-card";
  card.dataset.choiceId = data.id;

  // 标题
  const title = document.createElement("div");
  title.className = "choice-card__title";
  title.textContent = data.question;
  card.appendChild(title);

  // 选项列表
  const list = document.createElement("div");
  list.className = "choice-card__list";
  for (const opt of data.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice-card__option";
    btn.dataset.value = opt.value;

    const labelEl = document.createElement("span");
    labelEl.className = "choice-card__option-label";
    labelEl.textContent = opt.label;
    btn.appendChild(labelEl);

    if (opt.description) {
      const descEl = document.createElement("span");
      descEl.className = "choice-card__option-desc";
      descEl.textContent = opt.description;
      btn.appendChild(descEl);
    }

    btn.addEventListener("click", () => {
      // 标记已选，禁用所有按钮
      card.classList.add("choice-card--resolved");
      card.querySelectorAll<HTMLButtonElement>(".choice-card__option").forEach(b => b.disabled = true);
      btn.classList.add("choice-card__option--selected");
      void window.choice?.resolve(data.id, opt.value);
    });
    list.appendChild(btn);
  }
  card.appendChild(list);

  // 自定义输入
  const customWrap = document.createElement("div");
  customWrap.className = "choice-card__custom";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "choice-card__custom-input";
  customInput.placeholder = "或输入自定义要求...";
  customWrap.appendChild(customInput);

  const customBtn = document.createElement("button");
  customBtn.type = "button";
  customBtn.className = "choice-card__custom-btn";
  customBtn.textContent = "确认";
  customBtn.addEventListener("click", () => {
    const val = customInput.value.trim();
    if (!val) return;
    card.classList.add("choice-card--resolved");
    card.querySelectorAll<HTMLButtonElement>(".choice-card__option").forEach(b => b.disabled = true);
    customInput.disabled = true;
    customBtn.disabled = true;
    void window.choice?.resolve(data.id, val);
  });
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); customBtn.click(); }
  });
  customWrap.appendChild(customBtn);
  card.appendChild(customWrap);

  return card;
}

/** 构建权限审批卡片 DOM 元素（per-action 档位下工具调用前弹出）。 */
function buildApprovalCardEl(req: {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: string;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.approvalId = req.id;

  // 标题（带工具名 + 风险标签）
  const title = document.createElement("div");
  title.className = "approval-card__title";
  const toolSpan = document.createElement("span");
  toolSpan.className = "approval-card__tool";
  toolSpan.textContent = req.toolName || req.toolId;
  const riskBadge = document.createElement("span");
  riskBadge.className = `approval-card__risk approval-card__risk--${req.risk}`;
  riskBadge.textContent = req.risk;
  title.appendChild(toolSpan);
  title.appendChild(riskBadge);
  card.appendChild(title);

  // 描述
  if (req.toolDescription) {
    const desc = document.createElement("div");
    desc.className = "approval-card__desc";
    desc.textContent = req.toolDescription;
    card.appendChild(desc);
  }

  // 参数摘要（key: value，每行一个，限 5 行防爆窗）
  const argsEntries = Object.entries(req.args || {});
  if (argsEntries.length > 0) {
    const argsBlock = document.createElement("div");
    argsBlock.className = "approval-card__args";
    const visible = argsEntries.slice(0, 5);
    for (const [k, v] of visible) {
      const row = document.createElement("div");
      row.className = "approval-card__args-row";
      const keySpan = document.createElement("span");
      keySpan.className = "approval-card__args-key";
      keySpan.textContent = k + ":";
      const valSpan = document.createElement("span");
      valSpan.className = "approval-card__args-val";
      valSpan.textContent = JSON.stringify(v);
      row.appendChild(keySpan);
      row.appendChild(valSpan);
      argsBlock.appendChild(row);
    }
    if (argsEntries.length > 5) {
      const more = document.createElement("div");
      more.className = "approval-card__args-more";
      more.textContent = `…还有 ${argsEntries.length - 5} 个参数`;
      argsBlock.appendChild(more);
    }
    card.appendChild(argsBlock);
  }

  // 按钮行
  const actions = document.createElement("div");
  actions.className = "approval-card__actions";
  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "approval-card__btn approval-card__btn--deny";
  denyBtn.textContent = "拒绝";
  const allowBtn = document.createElement("button");
  allowBtn.type = "button";
  allowBtn.className = "approval-card__btn approval-card__btn--allow";
  allowBtn.textContent = "允许";
  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);
  card.appendChild(actions);

  // 提示行（60 秒超时）
  const note = document.createElement("div");
  note.className = "approval-card__note";
  note.textContent = "60 秒未操作自动拒绝";
  card.appendChild(note);

  // 倒计时更新（每秒刷新）
  let remaining = 60;
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      note.textContent = "已超时，自动拒绝";
      clearInterval(tick);
      return;
    }
    note.textContent = `${remaining} 秒后自动拒绝`;
  }, 1000);

  const resolve = (allowed: boolean) => {
    clearInterval(tick);
    if (!card.isConnected) return;
    card.classList.add(allowed ? "approval-card--allowed" : "approval-card--denied");
    denyBtn.disabled = true;
    allowBtn.disabled = true;
    note.textContent = allowed ? "已允许" : "已拒绝";
    void window.settings?.resolvePermissionApproval?.(req.id, allowed);
  };

  denyBtn.addEventListener("click", () => resolve(false));
  allowBtn.addEventListener("click", () => resolve(true));

  return card;
}

/** 构建天气卡片 DOM 元素（不插入，由调用方决定位置）。 */
function buildWeatherCardEl(data: Record<string, unknown>): HTMLElement {
  const card = document.createElement("div");
  card.className = "weather-card";

  const now = new Date();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 周${"日一二三四五六"[now.getDay()]}`;
  const timeStr = formatTime(Date.now());

  const temp = Number(data.temp ?? 0);
  const feelsLike = Number(data.feelsLike ?? temp);
  const humidity = Number(data.humidity ?? 0);
  const precip = Number(data.precip ?? 0);
  const pressure = Number(data.pressure ?? 0);
  const icon = String(data.icon ?? "🌤️");
  const windDir = String(data.windDir ?? "");
  const windScale = String(data.windScale ?? "");
  const visibility = data.visibility != null ? `${data.visibility}km` : "—";
  const uv = String(data.uv ?? "—");
  const aqi = data.aqi != null ? Number(data.aqi) : null;
  const aqiText = String(data.aqiText ?? "");
  const kaomoji = aqi != null ? aqiKaomojiText(Number(aqi)) : "";

  card.innerHTML = `
    <div class="w-header">
      <div class="w-datetime"><span class="w-date">${dateStr}</span><span class="w-time">${timeStr} 更新</span></div>
      <div class="w-loc"><span class="w-city">${String(data.city ?? "")}</span><span class="w-adm">${String(data.adm ?? "")}</span></div>
    </div>
    <div class="w-main">
      <div class="w-icon-box"><span class="w-icon">${icon}</span><span class="w-desc">${String(data.text ?? "")}</span></div>
      <div class="w-temp-box">
        <div class="w-temp">${temp}<span class="w-deg">°</span></div>
        ${data.hi != null ? `<div class="w-hilo"><span class="w-hi">↑${data.hi}°</span><span class="w-sep">|</span><span class="w-lo">↓${data.lo}°</span></div>` : ""}
      </div>
    </div>
    <div class="w-feels">体感 ${feelsLike}°C</div>
    <div class="w-quick">
      <div class="w-qitem"><div class="w-qicon">💧</div><div class="w-qlabel">湿度</div><div class="w-qvalue">${humidity}%</div></div>
      <div class="w-qitem"><div class="w-qicon">💨</div><div class="w-qlabel">风力</div><div class="w-qvalue">${windScale}</div></div>
      <div class="w-qitem"><div class="w-qicon">🌧️</div><div class="w-qlabel">降水</div><div class="w-qvalue">${precip}mm</div></div>
      <div class="w-qitem"><div class="w-qicon">📊</div><div class="w-qlabel">气压</div><div class="w-qvalue">${pressure || "—"}</div></div>
    </div>
    <button class="w-expand" type="button">查看更多 <span class="w-arrow">▼</span></button>
    <div class="w-details">
      <div class="w-detail-grid">
        <div class="w-ditem"><span class="w-dicon">🌡️</span><div><div class="w-dlabel">体感温度</div><div class="w-dvalue">${feelsLike}°C</div></div></div>
        <div class="w-ditem"><span class="w-dicon">💨</span><div><div class="w-dlabel">风向风力</div><div class="w-dvalue">${windDir} ${windScale}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">🔆</span><div><div class="w-dlabel">紫外线</div><div class="w-dvalue">${uv}</div></div></div>
        <div class="w-ditem"><span class="w-dicon">👁️</span><div><div class="w-dlabel">能见度</div><div class="w-dvalue">${visibility}</div></div></div>
        ${aqi != null ? `<div class="w-ditem"><span class="w-dicon">🌿</span><div><div class="w-dlabel">空气质量</div><div class="w-dvalue">${aqi} ${aqiText} <span class="w-kaomoji">${kaomoji}</span></div></div></div>` : ""}
      </div>
    </div>
    <div class="w-source"><span>${icon} ${String(data.source ?? "")}</span><span>${timeStr} 更新</span></div>
  `;

  // 展开按钮点击切换
  const expandBtn = card.querySelector(".w-expand") as HTMLButtonElement | null;
  if (expandBtn) {
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.toggle("expanded");
    });
  }

  return card;
}

/** AQI → 颜文字。 */
function aqiKaomojiText(aqi: number): string {
  if (aqi <= 50) return "(◕‿◕)";
  if (aqi <= 100) return "(´ー`)";
  if (aqi <= 150) return "(´-ω-`)";
  if (aqi <= 200) return "(；´д`)";
  return "(╥﹏╥)";
}

/**
 * Fill the avatar slot for a given role.
 * - model role: insert an <img> with the configured PNG (auto-cropped to
 *   a circle by the .msg__avatar-img CSS rule).
 * - user role (empty src): leave the slot empty so the CSS gradient
 *   placeholder shows through.
 */
function setAvatar(slot: HTMLElement, role: Role): void {
  slot.replaceChildren();
  const src = AVATAR_SRC[role];
  if (!src) return;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.className = "msg__avatar-img";
  slot.appendChild(img);
}

/** 构建一个默认折叠的「💭 思考过程」块（<details>）。 */
function buildThinkingBlock(text: string): HTMLElement {
  const details = document.createElement("details");
  details.className = "msg__thinking";
  const summary = document.createElement("summary");
  summary.className = "msg__thinking-summary";
  summary.textContent = "💭 思考过程";
  const pre = document.createElement("div");
  pre.className = "msg__thinking-body";
  pre.textContent = text;
  details.appendChild(summary);
  details.appendChild(pre);
  return details;
}

/**
 * 流式期间就地更新当前消息的思考块（不整屏 render）。
 * 若该消息行还没建立 DOM（仍是 thinking 三点气泡），则跳过，等 render 时统一渲染。
 */
function upsertThinkingBlock(m: Message): void {
  const row = messagesEl.querySelector(`[data-msg-id="${m.id}"]`);
  if (!row) return;
  const body = row.querySelector(".msg__body");
  if (!body) return;
  let details = body.querySelector(".msg__thinking") as HTMLDetailsElement | null;
  if (!details) {
    details = buildThinkingBlock(m.thinkingText ?? "") as HTMLDetailsElement;
    body.insertBefore(details, body.firstChild);
  } else {
    const pre = details.querySelector(".msg__thinking-body");
    if (pre) pre.textContent = m.thinkingText ?? "";
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function render(): void {
  // 空态：当前会话还没有消息时（新建/全清）显示"昔涟期待与你聊天哦 ✨"占位
  // thinking 状态（昔涟主动开场/流式回复中）也算有消息，胶囊应立即消失
  const emptyEl = document.getElementById("chat-empty");
  const hasMessages = messages.some((m) => m.content.trim() || m.thinking);
  if (emptyEl) emptyEl.toggleAttribute("hidden", hasMessages);

  messagesEl.replaceChildren();
  for (const m of messages) {
    const row = document.createElement("div");
    row.className = `msg msg--${m.role}`;
    row.dataset.msgId = m.id;

    const avatar = document.createElement("div");
    avatar.className = "msg__avatar";
    avatar.setAttribute("aria-hidden", "true");
    setAvatar(avatar, m.role);

    const body = document.createElement("div");
    body.className = "msg__body";

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    bubble.hidden = false;
    if (m.thinking) {
      bubble.classList.add("msg__bubble--thinking");
      const dot1 = document.createElement("span");
      dot1.className = "thinking-dot";
      const dot2 = document.createElement("span");
      dot2.className = "thinking-dot";
      const dot3 = document.createElement("span");
      dot3.className = "thinking-dot";
      bubble.appendChild(dot1);
      bubble.appendChild(dot2);
      bubble.appendChild(dot3);
    } else if (m.role === "user") {
      // 用户消息：去掉 [sticker:xxx] 标记后显示纯文字
      const cleanText = m.content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      if (cleanText) bubble.textContent = cleanText;
      else bubble.hidden = true; // 纯表情包消息不显示气泡
    } else {
      bubble.textContent = m.content;
    }

    const time = document.createElement("div");
    time.className = "msg__time";
    time.textContent = formatTime(m.at);

    // 思考过程折叠块（若有且开关开启）：放在气泡上方，默认折叠
    if (m.role === "model" && showThinking && m.thinkingText && m.thinkingText.trim()) {
      body.appendChild(buildThinkingBlock(m.thinkingText));
    }

    if (!bubble.hidden) body.appendChild(bubble);

    if (m.sticker) {
      const stickerSrc = getStickerSrc(m.sticker);
      if (stickerSrc) {
        const sticker = document.createElement("img");
        sticker.className = "msg__sticker";
        sticker.src = stickerSrc;
        sticker.alt = m.role === "user" ? "用户表情" : "昔涟表情";
        sticker.draggable = false;
        // <img> 高度异步加载，render() 末尾的滚动会在图片撑开前就执行，
        // 导致 sticker 底部被输入框挡住。加载完成后再补一次滚到底。
        sticker.addEventListener("load", () => {
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
        body.appendChild(sticker);
      }
    }

    // actions 行：喇叭 / 复制 / 时间三个控件水平排在气泡下方。
    // 没有可显示控件的消息（纯表情包 / thinking 空内容）跳过整行。
    const actions = document.createElement("div");
    actions.className = "msg__actions";

    let hasActionItem = false;

    // model 消息加 SVG 朗读按钮（thinking 中的不显示）
    if (m.role === "model" && !m.thinking && m.content.trim()) {
      const speakBtn = document.createElement("button");
      speakBtn.type = "button";
      speakBtn.className = "msg__speak";
      speakBtn.title = "朗读";
      speakBtn.setAttribute("aria-label", "朗读这条消息");
      // 用 SVG 而不是 emoji，颜色随主题走，播放时切到波形版
      speakBtn.innerHTML = SPEAK_ICON_IDLE;
      // 点击逻辑：正在播放则停止，否则开始朗读（避免重叠）
      speakBtn.addEventListener("click", () => {
        console.log("[TTS] 喇叭点击, currentTtsAudio=", currentTtsAudio ? "有" : "无");
        if (currentSpeakingMsgId === m.id) {
          // 当前消息正在播放 → 停止并复位 UI
          stopCurrentTts();
          setSpeakingMsgId(null);
        } else {
          void speakMessage(m);
        }
      });
      actions.appendChild(speakBtn);
      hasActionItem = true;
    }

    // 复制按钮：user / model 都有，thinking / 空内容 / 纯表情包跳过
    //   user 复制时去掉 [sticker:xxx] 标记，model 直接复制 content
    if (!m.thinking && m.content.trim()) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "msg__copy";
      copyBtn.title = "复制";
      copyBtn.setAttribute("aria-label", "复制这条消息");
      copyBtn.innerHTML = COPY_ICON_IDLE;
      copyBtn.addEventListener("click", () => {
        const text = m.role === "user"
          ? m.content.replace(/\[sticker:[^\]]+\]/g, "").trim()
          : m.content;
        if (!text) return;
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return;
          // 视觉反馈：切到对勾 + 文案"已复制"，1.5s 后复原
          copyBtn.classList.add("is-copied");
          copyBtn.innerHTML = COPY_ICON_DONE;
          const label = document.createElement("span");
          label.className = "msg__copy-label";
          label.textContent = "已复制";
          copyBtn.appendChild(label);
          window.setTimeout(() => {
            copyBtn.classList.remove("is-copied");
            copyBtn.innerHTML = COPY_ICON_IDLE;
          }, 1500);
        });
      });
      actions.appendChild(copyBtn);
      hasActionItem = true;
    }

    // 更多操作「…」按钮：非 thinking、非纯表情包的消息才显示。
    // 打开消息菜单（复制/删除/重新生成/编辑重发），与右键菜单同一套。
    if (!m.thinking && (m.content.trim() || m.sticker)) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "msg__more";
      moreBtn.title = "更多";
      moreBtn.setAttribute("aria-label", "更多操作");
      moreBtn.textContent = "⋯";
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = moreBtn.getBoundingClientRect();
        openMessageMenu(m, r.left, r.bottom + 4);
      });
      actions.appendChild(moreBtn);
      hasActionItem = true;
    }

    // 时间戳总是显示；哪怕只有一个时间，也用 actions 行保持视觉一致
    actions.appendChild(time);
    hasActionItem = true;

    if (hasActionItem) body.appendChild(actions);

    // 右键消息行也弹同一套菜单（thinking 中的不弹）
    if (!m.thinking) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMessageMenu(m, e.clientX, e.clientY);
      });
    }

    row.appendChild(avatar);
    row.appendChild(body);
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function installSchedulerEventListener(): void {
  if (!window.schedulerEvents?.onEvent) return;

  interface SchedulerStreamState {
    msgId: string;
    content: string;
    toolLines: string[];
  }

  const streams = new Map<string, SchedulerStreamState>();

  const runKeyOf = (event: AguiBaseEvent): string => {
    if (event.schedulerRunId) return event.schedulerRunId;
    if (event.runId) return event.runId;
    if (event.threadId) return event.threadId;
    return "scheduler-default";
  };

  const renderState = (state: SchedulerStreamState): void => {
    const msg = messages.find(m => m.id === state.msgId);
    if (!msg) return;
    msg.thinking = false;
    msg.content = state.content || state.toolLines.join("\n") || "定时任务运行中…";
    render();
  };

  window.schedulerEvents.onEvent((rawEvent) => {
    const event = rawEvent as AguiBaseEvent;
    if (event.type === "CUSTOM" && event.name === "scheduler.started") {
      const value = event.value as { taskId?: string; title?: string; firedAt?: string; runId?: string } | undefined;
      const runKey = event.schedulerRunId ?? value?.runId ?? `scheduler-${Date.now()}`;
      messages.push({
        id: `scheduler-system-${runKey}`,
        role: "model",
        content: `⏰ 定时任务「${value?.title ?? "未命名任务"}」已触发`,
        at: Date.now(),
      });
      const msgId = `scheduler-model-${runKey}`;
      streams.set(runKey, { msgId, content: "", toolLines: [] });
      messages.push({ id: msgId, role: "model", content: "", at: Date.now(), thinking: true });
      render();
      void saveSession();
      return;
    }

    const runKey = runKeyOf(event);
    const state = streams.get(runKey);
    if (!state) return;
    const msg = messages.find(m => m.id === state.msgId);
    if (!msg) return;

    if (event.type === "TOOL_CALL_START") {
      state.toolLines.push(`🔧 调用中：${event.toolCallName ?? "工具"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_RESULT") {
      const preview = (event.content ?? "").slice(0, 240);
      state.toolLines.push(`✅ 工具结果：${preview || "完成"}`);
      renderState(state);
    } else if (event.type === "TOOL_CALL_END") {
      state.toolLines.push("✅ 工具调用完成");
      renderState(state);
    } else if (event.type === "TEXT_MESSAGE_START") {
      msg.thinking = false;
      state.content = "";
      renderState(state);
    } else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta) {
      state.content += event.delta;
      renderState(state);
    } else if (event.type === "RUN_FINISHED") {
      renderState(state);
      void saveSession();
      streams.delete(runKey);
    } else if (event.type === "RUN_ERROR") {
      msg.thinking = false;
      msg.content = "定时任务执行失败：" + (event.error ?? event.content ?? "未知错误");
      render();
      void saveSession();
      streams.delete(runKey);
    }
  });
}

// ── TTS 朗读 ──
// 从主进程加载 TTS 配置，按当前引擎调用合成并播放。
// 自动朗读（回复完成后触发）和手动 🔊 按钮共用此函数。

const TEXT_MODE_MOUTH_DURATION_MS = 8000;
const AUDIO_MOUTH_DELAY_MS = 800;

interface TtsSettings {
  ttsEngine: string;
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  // GPT-SoVITS
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  // 自定义云端
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  // MiniMax 流式播放
  ttsStreaming: boolean;
}

interface TtsApi {
  synthesize: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string; format?: "mp3" | "wav" | "pcm";
  }) => Promise<string>;
  synthesizeCached: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean }>;
  // GPT-SoVITS（返回 base64 + cacheKey + cached + format）
  synthesizeCachedGptsovits: (payload: {
    baseUrl: string; refAudioPath: string; promptText: string; text: string;
    speed?: number; format?: "wav" | "mp3";
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 自定义云端（返回 base64 + cacheKey + cached + format）
  synthesizeCachedCustomCloud: (payload: {
    endpointUrl: string; apiKey?: string; voiceId?: string; text: string;
    speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" | "mp3" }>;
  // 小米 MiMo（返回 base64 + cacheKey + cached + format）
  synthesizeCachedMimo: (payload: {
    apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string;
    expectedCacheKey?: string;
  }) => Promise<{ base64: string; cacheKey: string; cached: boolean; format: "wav" }>;
  // 流式合成（minimax，边推 chunk 边播）
  streamStart: (payload: {
    apiKey: string; voiceId: string; text: string;
    speed?: number; volume?: number; pitch?: number;
    model?: string; format?: "mp3" | "wav" | "pcm";
    expectedCacheKey?: string;
  }) => Promise<{ started: boolean; cacheKey: string; cached: boolean }>;
  onAudioChunk: (callback: (payload: { base64: string }) => void) => () => void;
  onStreamEnd: (callback: (payload: { cacheKey: string; cached: boolean; format: "mp3" | "wav" | "pcm" }) => void) => () => void;
  onStreamError: (callback: (payload: { message: string }) => void) => () => void;
  loadSettings: () => Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    tts?: TtsApi;
    live2dSpeech?: {
      prepare: () => void;
      startMouth: (durationMs: number) => void;
      stopMouth: () => void;
    };
  }
}

// 当前正在播放的 TTS 音频实例（全局唯一）。点新朗读前先停这个，避免重叠。
let currentTtsAudio: HTMLAudioElement | null = null;
// 当前正在朗读的消息 ID，用于给对应消息 row 加 .is-speaking class 并切换喇叭图标。
// null 表示没有正在播放。
let currentSpeakingMsgId: string | null = null;
let speechToken = 0;
let textMouthStarted = false;
let ttsPlaybackSequence = 0;

/** 复制文本到剪贴板，优先用现代 Clipboard API，失败时回落到 textarea+execCommand。 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或无 clipboard 上下文，回落到下面
  }
  // Fallback：临时 textarea + execCommand('copy')。旧浏览器/无焦点时也能用。
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function nextSpeechToken(): number {
  speechToken += 1;
  return speechToken;
}

/** 把正在播放的喇叭按钮切回静态 SVG，所有其他按钮恢复正常。 */
function syncSpeakingUi(): void {
  const prevId = currentSpeakingMsgId;
  document.querySelectorAll(".msg.is-speaking").forEach((el) => {
    if (prevId === null || (el as HTMLElement).dataset.msgId !== prevId) {
      el.classList.remove("is-speaking");
      const btn = el.querySelector(".msg__speak");
      if (btn) btn.innerHTML = SPEAK_ICON_IDLE;
    }
  });
  if (prevId === null) return;
  const row = document.querySelector(`.msg[data-msg-id="${CSS.escape(prevId)}"]`);
  if (!row) return;
  row.classList.add("is-speaking");
  const btn = row.querySelector(".msg__speak");
  if (btn) btn.innerHTML = SPEAK_ICON_ACTIVE;
}

/** 在开始朗读某条消息前调用：清掉旧的、设上新的，并刷新 UI。 */
function setSpeakingMsgId(id: string | null): void {
  currentSpeakingMsgId = id;
  syncSpeakingUi();
}

function stopLive2dMouth(): void {
  speechToken += 1;
  textMouthStarted = false;
  window.live2dSpeech?.stopMouth();
}

function startTextModeMouth(): void {
  if (textMouthStarted) return;
  textMouthStarted = true;
  window.live2dSpeech?.startMouth(TEXT_MODE_MOUTH_DURATION_MS);
}

/** 停止当前正在播放的 TTS 音频（如果有）。只停 audio，UI 复位由调用方决定。 */
function stopCurrentTts(): void {
  if (currentTtsAudio) {
    currentTtsAudio.pause();
    currentTtsAudio.currentTime = 0;
    currentTtsAudio = null;
  }
  stopLive2dMouth();
}

async function loadTtsSettings(): Promise<TtsSettings | null> {
  if (!window.tts) return null;
  try {
    const raw = await window.tts.loadSettings();
    return {
      ttsEngine: String(raw.ttsEngine ?? "off"),
      ttsAutoRead: Boolean(raw.ttsAutoRead),
      ttsSpeed: Number(raw.ttsSpeed ?? 1),
      ttsVolume: Number(raw.ttsVolume ?? 1),
      ttsMinimaxKey: String(raw.ttsMinimaxKey ?? ""),
      ttsMinimaxVoiceId: String(raw.ttsMinimaxVoiceId ?? ""),
      ttsMinimaxModel: raw.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
      ttsGptsovitsBaseUrl: String(raw.ttsGptsovitsBaseUrl ?? ""),
      ttsGptsovitsRefAudioPath: String(raw.ttsGptsovitsRefAudioPath ?? ""),
      ttsGptsovitsPromptText: String(raw.ttsGptsovitsPromptText ?? ""),
      ttsGptsovitsFormat: raw.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
      ttsCustomCloudEndpointUrl: String(raw.ttsCustomCloudEndpointUrl ?? ""),
      ttsCustomCloudApiKey: String(raw.ttsCustomCloudApiKey ?? ""),
      ttsCustomCloudVoiceId: String(raw.ttsCustomCloudVoiceId ?? ""),
      ttsCustomCloudFormat: raw.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
      ttsCustomCloudTimeoutMs: Number(raw.ttsCustomCloudTimeoutMs ?? 30000),
      ttsMimoKey: String(raw.ttsMimoKey ?? ""),
      ttsMimoVoiceAudioPath: String(raw.ttsMimoVoiceAudioPath ?? ""),
      ttsMimoStylePrompt: String(raw.ttsMimoStylePrompt ?? ""),
      ttsStreaming: raw.ttsStreaming !== false,
    };
  } catch {
    return null;
  }
}

// 每次朗读前重新读取设置，确保设置页刚改的模型/音量/自动朗读开关即时生效。
function waitForAudioMetadata(audio: HTMLAudioElement): Promise<number | null> {
  return new Promise((resolve) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      resolve(audio.duration);
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
  });
}

function playTtsBase64(
  base64: string,
  format: "wav" | "mp3" = "mp3",
  msgId?: string,
): void {
  stopCurrentTts();
  const token = nextSpeechToken();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const mime = format === "wav" ? "audio/wav" : "audio/mp3";
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.load();
  currentTtsAudio = audio;
  // 标记喇叭 UI 进入播放态（即使没传 msgId 也清掉旧的）
  setSpeakingMsgId(msgId ?? null);

  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentTtsAudio === audio) currentTtsAudio = null;
    if (speechToken === token) stopLive2dMouth();
    // 复位喇叭 UI：仅当当前记录的就是这条消息才清，避免覆盖后启动的
    if (msgId === undefined || currentSpeakingMsgId === msgId) {
      setSpeakingMsgId(null);
    }
  };

  void (async () => {
    const durationSec = await waitForAudioMetadata(audio);
    try {
      await audio.play();
    } catch (err) {
      console.warn("[TTS] 播放失败:", err);
      URL.revokeObjectURL(url);
      if (currentTtsAudio === audio) currentTtsAudio = null;
      if (speechToken === token) stopLive2dMouth();
      if (msgId === undefined || currentSpeakingMsgId === msgId) {
        setSpeakingMsgId(null);
      }
      return;
    }

    if (speechToken !== token) return;
    window.live2dSpeech?.prepare();
    const durationMs = durationSec === null ? 0 : Math.max(0, durationSec * 1000 - AUDIO_MOUTH_DELAY_MS);
    window.setTimeout(() => {
      if (speechToken !== token) return;
      if (durationMs > 0) window.live2dSpeech?.startMouth(durationMs);
    }, AUDIO_MOUTH_DELAY_MS);
  })();
}

/**
 * 流式播放 MiniMax TTS（MediaSource + SourceBuffer 边收边播）。
 * 返回 cacheKey（供回写消息）。失败时 fallback 到完整合成。
 */
async function streamAndPlayCached(
  settings: TtsSettings,
  text: string,
  existing?: { ttsCacheKey?: string },
  options?: { waitForPlaybackEnd?: boolean },
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  stopCurrentTts();  // 先停当前 TTS（含 stopLive2dMouth），再拿 token，否则 token 立刻失效
  const token = nextSpeechToken();
  const t0 = performance.now();  // 诊断时间戳基准（startPolling 闭包要用，必须在 try 外声明）
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let audioEl: HTMLAudioElement | null = null;
  const chunkQueue: Uint8Array[] = [];
  let ended = false;
  let resolvedCacheKey: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let offChunk: (() => void) | null = null;
  let offEnd: (() => void) | null = null;
  let offErr: (() => void) | null = null;
  let done = false;
  let playbackEnded = false;
  let streamReady = false;
  let streamResult: { cacheKey: string } | null = null;
  let resolveStream: ((v: { cacheKey: string } | null) => void) | null = null;

  const cleanup = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    offChunk?.(); offEnd?.(); offErr?.();
    offChunk = offEnd = offErr = null;
  };

  const finishStream = (result: { cacheKey: string } | null) => {
    streamReady = true;
    streamResult = result;
    if (!options?.waitForPlaybackEnd || playbackEnded) {
      resolveStream?.(streamResult);
    }
  };

  const markPlaybackEnded = () => {
    playbackEnded = true;
    if (streamReady) {
      resolveStream?.(streamResult);
    }
  };

  // 轮询 flush：每 30ms 检查一次，能 append 就 append，结束且队列空就 endOfStream + resolve
  const startPolling = (resolve: (v: { cacheKey: string } | null) => void) => {
    let startedPlayback = false;
    pollTimer = setInterval(() => {
      if (speechToken !== token) {
        cleanup();
        try { mediaSource?.endOfStream(); } catch { /* */ }
        finishStream(null);
        return;
      }
      // append 队列里的 chunk（如果 sourceBuffer 空闲）
      if (sourceBuffer && !sourceBuffer.updating && chunkQueue.length > 0) {
        const chunk = chunkQueue.shift()!;
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch {
          chunkQueue.unshift(chunk);
        }
      }
      // 第一块 append 成功后（buffered 有数据）开始播放
      if (!startedPlayback && sourceBuffer && sourceBuffer.buffered.length > 0 && audioEl && audioEl.paused) {
        startedPlayback = true;
        void audioEl.play().then(() => {
          console.log(`[TTS-Stream] play() 开始 +${Math.round(performance.now() - t0)}ms`);
          if (speechToken !== token) return;
          const estDurationMs = Math.max(2000, Array.from(text).length * 180);
          window.live2dSpeech?.startMouth(estDurationMs);
        }).catch((err) => {
          console.warn("[TTS-Stream] play 失败:", err);
          markPlaybackEnded();
        });
      }
      // 结束且队列空 → endOfStream
      if (ended && chunkQueue.length === 0 && sourceBuffer && !sourceBuffer.updating && !done) {
        done = true;
        try { mediaSource?.endOfStream(); } catch { /* */ }
        cleanup();
        if (options?.waitForPlaybackEnd && !startedPlayback) {
          markPlaybackEnded();
        }
        console.log(`[TTS-Stream] resolve +${Math.round(performance.now() - t0)}ms cacheKey=${resolvedCacheKey?.slice(0,20)}`);
        finishStream(resolvedCacheKey ? { cacheKey: resolvedCacheKey } : null);
      }
    }, 30);
  };

  try {
    // 启动流式合成
    const startResult = await window.tts.streamStart({
      apiKey: settings.ttsMinimaxKey,
      voiceId: settings.ttsMinimaxVoiceId,
      text,
      speed: settings.ttsSpeed,
      volume: settings.ttsVolume,
      model: settings.ttsMinimaxModel,
      format: "mp3",
      expectedCacheKey: existing?.ttsCacheKey,
    });
    console.log(`[TTS-Stream] streamStart 返回 +${Math.round(performance.now() - t0)}ms started=${startResult.started} cached=${startResult.cached}`);

    // 注册监听（只注册一次）
    let firstChunkAt = 0;
    offChunk = window.tts.onAudioChunk((payload) => {
      if (speechToken !== token) return;
      if (!firstChunkAt) {
        firstChunkAt = performance.now();
        console.log(`[TTS-Stream] 第一个 chunk +${Math.round(firstChunkAt - t0)}ms`);
      }
      const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
      chunkQueue.push(bytes);
    });
    offEnd = window.tts.onStreamEnd((payload) => {
      ended = true;
      resolvedCacheKey = payload.cacheKey;
      console.log(`[TTS-Stream] STREAM_END +${Math.round(performance.now() - t0)}ms chunks=${chunkQueue.length}`);
    });
    offErr = window.tts.onStreamError((payload) => {
      console.warn(`[TTS-Stream] ERROR +${Math.round(performance.now() - t0)}ms:`, payload.message);
      ended = true;
      cleanup();
      try { mediaSource?.endOfStream(); } catch { /* */ }
    });

    // 设置 MediaSource + Audio
    mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    audioEl = new Audio(url);
    currentTtsAudio = audioEl;

    window.live2dSpeech?.prepare();  // stopLive2dMouth 已在开头 stopCurrentTts 里调过

    audioEl.onended = () => {
      URL.revokeObjectURL(url);
      if (currentTtsAudio === audioEl) currentTtsAudio = null;
      if (speechToken === token) stopLive2dMouth();
      markPlaybackEnded();
    };

    mediaSource.addEventListener("sourceopen", () => {
      console.log(`[TTS-Stream] sourceopen +${Math.round(performance.now() - t0)}ms`);
      try {
        sourceBuffer = mediaSource!.addSourceBuffer("audio/mpeg");
        sourceBuffer.mode = "sequence";
        console.log(`[TTS-Stream] sourceBuffer 创建成功`);
        // 不立即 play——等轮询里第一块 append 成功（buffered.length>0）再 play
      } catch (err) {
        console.warn("[TTS-Stream] SourceBuffer 创建失败:", err);
      }
    });

    // 超时兜底（30s）
    setTimeout(() => {
      if (!done) {
        ended = true;
      }
    }, 30000);

    // 等 STREAM_END + 队列 flush 完
    return await new Promise<{ cacheKey: string } | null>((resolve) => {
      resolveStream = resolve;
      startPolling(resolve);
    });
  } catch (err) {
    console.warn("[TTS] 流式启动失败:", err);
    cleanup();
    return null;  // 调用方 fallback 到完整合成
  }
}

async function synthesizeAndPlayCached(
  text: string,
  existing?: { ttsCacheKey?: string },
  msgId?: string,
): Promise<{ cacheKey: string } | null> {
  if (!window.tts) return null;

  // 回听优先：如果旧消息有 ttsCacheKey，直接尝试读缓存文件播放，不需要任何引擎配置。
  // 只有缓存文件不存在、需要合成新音频时才检查引擎配置。
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off") return null;

  // 缓存回听：按 cacheKey 前缀分发到对应引擎的 _CACHED IPC
  // （minimax 缓存走 TTS_SYNTHESIZE_CACHED，gptsovits 缓存走 TTS_SYNTHESIZE_CACHED_GPTSOVITS）
  if (existing?.ttsCacheKey) {
    const isGptsovitsCache = existing.ttsCacheKey.startsWith("gptsovits-");
    const isCustomCloudCache = existing.ttsCacheKey.startsWith("custom-cloud-");
    const isMimoCache = existing.ttsCacheKey.startsWith("mimo-");
    try {
      if (isGptsovitsCache) {
        const result = await window.tts.synthesizeCachedGptsovits({
          baseUrl: "cache-only",        // 占位，缓存命中不会用到
          refAudioPath: "cache-only",   // 占位
          promptText: "cache-only",     // 占位
          text,
          speed: settings.ttsSpeed,
          format: settings.ttsGptsovitsFormat,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] gptsovits 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isCustomCloudCache) {
        const result = await window.tts.synthesizeCachedCustomCloud({
          endpointUrl: "cache-only",    // 占位，缓存命中不会用到
          apiKey: "cache-only",
          voiceId: "cache-only",
          text,
          speed: settings.ttsSpeed,
          volume: settings.ttsVolume,
          format: settings.ttsCustomCloudFormat,
          timeoutMs: settings.ttsCustomCloudTimeoutMs,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] custom-cloud 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else if (isMimoCache) {
        const result = await window.tts.synthesizeCachedMimo({
          apiKey: "cache-only",
          voiceAudioPath: "cache-only",
          text,
          stylePrompt: "",
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] mimo 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      } else {
        // minimax 缓存回听（保持原逻辑）
        const result = await window.tts.synthesizeCached({
          apiKey: "cache-only",
          voiceId: "cache-only",
          text,
          speed: settings.ttsSpeed,
          volume: settings.ttsVolume,
          model: settings.ttsMinimaxModel,
          expectedCacheKey: existing.ttsCacheKey,
        });
        if (result.cached) {
          console.log("[TTS] minimax 缓存命中，直接播放");
          playTtsBase64(result.base64, result.format, msgId);
          return { cacheKey: result.cacheKey };
        }
      }
    } catch {
      // 缓存读取失败，继续走正常合成流程
    }
  }

  // 需要合成新音频 → 按 engine 分发
  if (settings.ttsEngine === "minimax") {
    if (!settings.ttsMinimaxKey || !settings.ttsMinimaxVoiceId) {
      console.warn("[TTS] 缺少 apiKey 或 voiceId，无法合成新音频");
      return null;
    }
    // 流式优先（默认开）：边合成边播，首字延迟低；失败 fallback 完整合成
    if (settings.ttsStreaming) {
      const stream = await streamAndPlayCached(settings, text, existing);
      if (stream) return stream;
      console.warn("[TTS] 流式失败，fallback 完整合成");
    }
    try {
      const result = await window.tts.synthesizeCached({
        apiKey: settings.ttsMinimaxKey,
        voiceId: settings.ttsMinimaxVoiceId,
        text,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        model: settings.ttsMinimaxModel,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "gptsovits") {
    if (!settings.ttsGptsovitsBaseUrl || !settings.ttsGptsovitsRefAudioPath || !settings.ttsGptsovitsPromptText) {
      console.warn("[TTS] 缺少 GPT-SoVITS 配置（baseUrl/refAudioPath/promptText）");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedGptsovits({
        baseUrl: settings.ttsGptsovitsBaseUrl,
        refAudioPath: settings.ttsGptsovitsRefAudioPath,
        promptText: settings.ttsGptsovitsPromptText,
        text,
        speed: settings.ttsSpeed,
        format: settings.ttsGptsovitsFormat,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] GPT-SoVITS 合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "custom-cloud") {
    if (!settings.ttsCustomCloudEndpointUrl) {
      console.warn("[TTS] 缺少自定义云端 Endpoint URL");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedCustomCloud({
        endpointUrl: settings.ttsCustomCloudEndpointUrl,
        apiKey: settings.ttsCustomCloudApiKey,
        voiceId: settings.ttsCustomCloudVoiceId,
        text,
        speed: settings.ttsSpeed,
        volume: settings.ttsVolume,
        format: settings.ttsCustomCloudFormat,
        timeoutMs: settings.ttsCustomCloudTimeoutMs,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 自定义云端合成失败:", err);
      return null;
    }
  }

  if (settings.ttsEngine === "mimo") {
    if (!settings.ttsMimoKey || !settings.ttsMimoVoiceAudioPath) {
      console.warn("[TTS] 缺少小米 MiMo API Key 或昔涟克隆音频");
      return null;
    }
    try {
      const result = await window.tts.synthesizeCachedMimo({
        apiKey: settings.ttsMimoKey,
        voiceAudioPath: settings.ttsMimoVoiceAudioPath,
        text,
        stylePrompt: settings.ttsMimoStylePrompt,
        expectedCacheKey: existing?.ttsCacheKey,
      });
      playTtsBase64(result.base64, result.format, msgId);
      return { cacheKey: result.cacheKey };
    } catch (err) {
      console.warn("[TTS] 小米 MiMo 合成失败:", err);
      return null;
    }
  }

  return null;
}

async function speakMessage(message: Message): Promise<void> {
  ttsPlaybackSequence += 1;
  stopLive2dMouth();
  window.live2dSpeech?.prepare();
  // 立即切 UI：不等合成，让用户能马上看到按钮进入播放态。
  // playTtsBase64 真正开始播时会再次 setSpeakingMsgId（幂等）；如果合成失败下面 catch 里复位。
  setSpeakingMsgId(message.id);
  try {
    const cache = await synthesizeAndPlayCached(message.content, message, message.id);
    if (cache) {
      message.ttsCacheKey = cache.cacheKey;
      void saveSession();
    } else if (currentSpeakingMsgId === message.id) {
      // 合成失败（引擎关 / 配置缺失 / 网络报错）→ 复位 UI
      console.warn("[TTS] 合成失败，复位喇叭按钮");
      setSpeakingMsgId(null);
    }
  } catch (err) {
    console.warn("[TTS] speakMessage 异常:", err);
    if (currentSpeakingMsgId === message.id) setSpeakingMsgId(null);
  }
}

// 自动朗读：检查引擎是否开启 + autoRead 开关，满足条件才朗读
async function autoSpeakIfEnabled(text: string): Promise<{ cacheKey: string } | null> {
  const settings = await loadTtsSettings();
  if (!settings || settings.ttsEngine === "off" || !settings.ttsAutoRead) return null;
  ttsPlaybackSequence += 1;
  return await synthesizeAndPlayCached(text);
}

interface EarlyMinimaxPlayback {
  append(delta: string): void;
  finish(fullText: string): Promise<{ cacheKey: string } | null>;
}

function createEarlyMinimaxPlayback(): EarlyMinimaxPlayback {
  let settingsPromise: Promise<TtsSettings | null> | null = null;
  let settings: TtsSettings | null = null;
  let checked = false;
  let eligible = false;
  let triggered = false;
  let segment = "";
  let playbackPromise: Promise<{ ok: boolean; sequence: number }> | null = null;
  let sequence = 0;

  const ensureSettings = async (): Promise<TtsSettings | null> => {
    if (!settingsPromise) {
      settingsPromise = loadTtsSettings();
    }
    settings = await settingsPromise;
    if (!checked) {
      checked = true;
      eligible = canUseMinimaxStreamingEarly(settings);
    }
    return settings;
  };

  const tryStart = async (text: string): Promise<void> => {
    if (triggered) return;
    const cfg = await ensureSettings();
    if (!cfg || !eligible || triggered) return;
    const early = extractEarlyTtsSegment(text);
    if (!early) return;

    triggered = true;
    segment = early.segment;
    ttsPlaybackSequence += 1;
    sequence = ttsPlaybackSequence;
    playbackPromise = streamAndPlayCached(cfg, segment, undefined, { waitForPlaybackEnd: true })
      .then((result) => ({ ok: Boolean(result), sequence }))
      .catch(() => ({ ok: false, sequence }));
  };

  return {
    append(delta: string): void {
      if (triggered) return;
      void tryStart(delta);
    },
    async finish(fullText: string): Promise<{ cacheKey: string } | null> {
      const cfg = await ensureSettings();
      if (!cfg || !eligible) return autoSpeakIfEnabled(fullText);

      if (!triggered) {
        return autoSpeakIfEnabled(fullText);
      }

      const result = await playbackPromise;
      if (!result?.ok) {
        return autoSpeakIfEnabled(fullText);
      }
      if (result.sequence !== ttsPlaybackSequence) {
        return null;
      }

      const remainder = fullText.slice(segment.length).trim();
      if (!remainder) return null;
      const rest = await streamAndPlayCached(cfg, remainder, undefined, { waitForPlaybackEnd: true });
      return rest ? null : autoSpeakIfEnabled(fullText);
    },
  };
}

function autosize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

// ── 表情包选择器 ──

let enabledStickers: Array<{ id: string; src: string; description?: string }> = [];

async function loadEnabledStickers(): Promise<void> {
  try {
    enabledStickers = (await window.chat?.getEnabledStickers?.()) ?? [];
  } catch {
    enabledStickers = [];
  }
}

/** 根据 sticker id 查语义描述 */
function getStickerDescription(id: string): string {
  const found = enabledStickers.find((s) => s.id === id);
  return found?.description ?? id;
}

function renderStickerPicker(): void {
  stickerPickerGrid.replaceChildren();
  if (enabledStickers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sticker-picker__empty";
    empty.textContent = "没有可用的表情包";
    stickerPickerGrid.appendChild(empty);
    return;
  }
  for (const s of enabledStickers) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sticker-picker__item";
    const img = document.createElement("img");
      // 内置贴纸 src 是 "/stickers/xxx" 绝对路径，file:// 协议下解析到磁盘根目录
      // 走 resolveAsset() 转成正确的 file:// 或 http:// URL（与 sticker-manager 缩略图同模式）
      img.src = s.src.startsWith("/stickers/") ? resolveAsset(s.src) : s.src;
    img.alt = s.id;
    img.draggable = false;
    card.appendChild(img);
    card.addEventListener("click", () => {
      insertSticker(s.id);
      hideStickerPicker();
    });
    stickerPickerGrid.appendChild(card);
  }
}

function insertSticker(id: string): void {
  const marker = `[sticker:${id}]`;
  const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
  const cursorEnd = inputEl.selectionEnd ?? cursorPos;
  inputEl.value = inputEl.value.slice(0, cursorPos) + marker + inputEl.value.slice(cursorEnd);
  inputEl.selectionStart = inputEl.selectionEnd = cursorPos + marker.length;
  autosize();
  inputEl.focus();
}

function showStickerPicker(): void {
  stickerPicker.hidden = false;
  stickerPickerBtn.classList.add("is-active");
  void loadEnabledStickers().then(renderStickerPicker);
}

function hideStickerPicker(): void {
  stickerPicker.hidden = true;
  stickerPickerBtn.classList.remove("is-active");
}

stickerPickerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (stickerPicker.hidden) showStickerPicker();
  else hideStickerPicker();
});

document.addEventListener("click", (e) => {
  if (stickerPicker.hidden) return;
  if (!stickerPicker.contains(e.target as Node) && e.target !== stickerPickerBtn) {
    hideStickerPicker();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !stickerPicker.hidden) hideStickerPicker();
});

function buildModelMessages(): Array<{ role: "user" | "model"; content: string }> {
  return messages
    .filter((message) => message.content.trim())
    .slice(-16)
    .map((message) => ({
      role: message.role,
      content: message.content.replace(/\[sticker:([^\]]+)\]/g, (_match, id) => {
        const desc = getStickerDescription(id);
        return `（用户发送表情包：${desc}）`;
      }),
    }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => window.clearTimeout(timer));
  });
}


function isTalkMode(): boolean {
  const active = document.querySelector("#mode-dropdown .dm-opt.is-active") as HTMLElement | null;
  return active?.dataset?.value === "talk";
}

function getCurrentStyle(): string {
  const active = document.querySelector("#style-dropdown .dm-opt.is-active") as HTMLElement | null;
  const style = (active && active.dataset && active.dataset.value) || "01_default.md";
  // 日常聊天模式：前缀 "talk" 触发后端走 talk_system.md + tools:[]
  return isTalkMode() ? "talk" : style;
}
async function getModelReply(): Promise<ChatReplyPayload> {
  if (!window.chat?.sendMessage) {
    throw new Error("聊天 IPC 尚未就绪，请重启应用后再试。");
  }
  const payload = await withTimeout(
    window.chat.sendMessage(buildModelMessages(), getCurrentStyle()),
    FRONTEND_REPLY_TIMEOUT_MS,
    "模型响应超时，请稍后重试。",
  );
  return normalizeChatReplyPayload(payload);
}

let sending = false;
// 停止生成：send() 运行期间登记一个停止回调；点停止按钮时调用它。
let currentStopHandler: (() => void) | null = null;
let stopRequested = false;

/** 切换发送/停止按钮的外观与语义。sending=true 显示停止（■）。 */
function setSendButtonMode(isSending: boolean): void {
  if (isSending) {
    sendBtn.classList.add("chat__send--stop");
    sendBtn.setAttribute("aria-label", "停止生成");
    sendBtn.title = "停止生成";
    sendBtn.textContent = "■";
    sendBtn.disabled = false; // 停止按钮必须可点
  } else {
    sendBtn.classList.remove("chat__send--stop");
    sendBtn.setAttribute("aria-label", "发送");
    sendBtn.title = "";
    sendBtn.textContent = "↵";
    sendBtn.disabled = false;
  }
}

/** 用户点停止：中断后端请求 + 触发本轮 send() 的收尾（保留已输出内容）。 */
function requestStop(): void {
  if (!sending) return;
  stopRequested = true;
  try { void window.agui?.cancel(); } catch { /* 忽略 */ }
  if (currentStopHandler) currentStopHandler();
}


// ── 快捷预设胶囊 ──────────────────────────────────────────
// 空对话时在 empty-state 下方显示的半透明胶囊，点击后：
// - fill 模式：预设提示词填入输入框，用户修改后发送
// - chat 模式：昔涟主动开口（注入隐藏种子消息触发 agent）

interface QuickPreset {
  id: string;
  label: string;
  icon: string;
  mode: "chat" | "fill";
  prompt?: string;
}

const QUICK_PRESETS: QuickPreset[] = [
  { id: "chat",     label: "和昔涟聊天", icon: "💬",  mode: "chat" },
  { id: "schedule", label: "设置定时任务", icon: "⏰", mode: "fill", prompt: "帮我设置一个定时任务：" },
  { id: "weather",  label: "查看天气",   icon: "🌤️", mode: "fill", prompt: "帮我查一下今天的天气" },
  { id: "document", label: "生成文档",   icon: "📄", mode: "fill", prompt: "帮我生成一份文档：" },
  { id: "email",    label: "发送邮件",   icon: "✉️", mode: "fill", prompt: "帮我发一封邮件：" },
];

/** 动态生成胶囊 DOM 并绑定点击。bootstrap 末尾调一次。 */
function buildQuickPresets(): void {
  const container = document.getElementById("quick-presets");
  if (!container) return;
  container.replaceChildren();
  for (const preset of QUICK_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat__preset";
    btn.dataset.presetId = preset.id;
    const icon = document.createElement("span");
    icon.className = "chat__preset-icon";
    icon.textContent = preset.icon;
    const label = document.createElement("span");
    label.className = "chat__preset-label";
    label.textContent = preset.label;
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.addEventListener("click", () => onPresetClick(preset));
    container.appendChild(btn);
  }
}

function onPresetClick(preset: QuickPreset): void {
  if (preset.mode === "fill") {
    inputEl.value = preset.prompt ?? "";
    inputEl.focus();
    const len = inputEl.value.length;
    inputEl.setSelectionRange(len, len);
    autosize();
  } else {
    void triggerCyreneGreeting();
  }
}

/**
 * 「和昔涟聊天」胶囊：让昔涟主动开口。
 * 注入隐藏种子消息触发 agent（不推入 messages 数组、不渲染），
 * 复用现有 AG-UI 流式回复机制。
 */
async function triggerCyreneGreeting(): Promise<void> {
  if (sending || !currentSessionId) return;

  // 立即隐藏空态（胶囊），不等 refreshModelConfig 异步完成
  const emptyEl = document.getElementById("chat-empty");
  if (emptyEl) emptyEl.setAttribute("hidden", "");

  sending = true;
  stopRequested = false;
  setSendButtonMode(true);
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未连接";

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model" as const, content: "", at: Date.now(), thinking: true };
    messages.push(streamMsg);
    render();

    let streamContent = "";
    let ttsContent = "";
    let autoSpeakTriggered = false;
    const earlyMinimaxPlayback = createEarlyMinimaxPlayback();
    textMouthStarted = false;
    let pendingTtsCachePromise: Promise<{ cacheKey: string } | null> | null = null;
    let sticker: string | null = null;
    let pendingWeatherCard: Record<string, unknown> | null = null;

    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    const deltaQueue: string[] = [];
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    const getStreamingBubble = (): HTMLElement | null => {
      const row = messagesEl.querySelector(`[data-msg-id="${streamMsgId}"]`);
      return row ? row.querySelector(".msg__bubble") as HTMLElement : null;
    };
    const tryFinish = (): void => {
      if (runFinishedArrived && deltaQueue.length === 0 && playbackTimer === null) {
        finishRun();
      }
    };
    // 停止回调（与 send() 一致）：点停止立即收尾，保留已输出内容。
    currentStopHandler = () => {
      runFinishedArrived = true;
      deltaQueue.length = 0;
      if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
      finishRun();
    };
    const startPlayback = (): void => {
      if (playbackTimer !== null) return;
      playbackTimer = window.setInterval(() => {
        const next = deltaQueue.shift();
        if (next !== undefined) {
          streamContent += next;
          const bubble = getStreamingBubble();
          if (bubble) {
            const span = document.createElement("span");
            span.className = "msg__char";
            span.textContent = next;
            bubble.appendChild(span);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = window.agui!.onEvent((rawEvent) => {
      try {
        const event = rawEvent as AguiBaseEvent;
        const msg = messages.find(m => m.id === streamMsgId);
        switch (event.type) {
          case "TOOL_CALL_START": {
            // 记录本轮是否用了写类工具（供"重新生成/编辑重发"门控）
            if (isWriteRisk(event.toolRisk) && msg) msg.usedWriteTool = true;
            const bubble = getStreamingBubble();
            if (bubble) {
              bubble.classList.remove("msg__bubble--thinking");
              bubble.replaceChildren();
              const tip = document.createElement("div");
              tip.className = "msg__tool-tip";
              tip.dataset.toolCallId = event.toolCallId ?? "";
              const icon = document.createElement("span");
              icon.className = "msg__tool-icon";
              icon.textContent = "🔧";
              const text = document.createElement("span");
              text.className = "msg__tool-text";
              text.textContent = "调用中：" + (event.toolCallName ?? "工具");
              tip.appendChild(icon);
              tip.appendChild(text);
              bubble.appendChild(tip);
            }
            break;
          }
          case "TOOL_CALL_END": {
            const bubble = getStreamingBubble();
            if (bubble) {
              const tip = bubble.querySelector(".msg__tool-tip");
              if (tip) {
                const textEl = tip.querySelector(".msg__tool-text");
                if (textEl) textEl.textContent = "已完成";
                tip.classList.add("msg__tool-tip--done");
              }
            }
            break;
          }
          case "TEXT_MESSAGE_START":
            if (msg) { msg.thinking = false; render(); }
            break;
          case "TEXT_MESSAGE_CONTENT":
            if (event.delta) {
              ttsContent += event.delta;
              earlyMinimaxPlayback.append(ttsContent);
              deltaQueue.push(event.delta);
              if (!textMouthStarted) {
                void loadTtsSettings().then((settings) => {
                  if (settings && !settings.ttsAutoRead) {
                    startTextModeMouth();
                  }
                });
              }
              if (msg) { msg.thinking = false; }
              startPlayback();
            }
            break;
          case "TEXT_MESSAGE_END":
            if (!autoSpeakTriggered && ttsContent.trim()) {
              autoSpeakTriggered = true;
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent);
            }
            break;
          case "CUSTOM":
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.weather") {
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              const choiceData = event.value as { id: string; question: string; options: Array<{ label: string; value: string; description?: string }>; default?: string };
              const card = buildChoiceCardEl(choiceData);
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          case "RUN_FINISHED":
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new Error(event.content || "模型请求失败"));
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回调抛错:", err);
      }
    });

    // 种子消息：不推入 messages 数组、不渲染，只作为 agent 输入触发昔涟主动开口
    const ack = await window.agui!.run({
      messages: [{ role: "user", content: "[internal] 用户点击了「和昔涟聊天」，请你主动开口聊几句，像朋友打招呼一样自然开场。" }],
      style: getCurrentStyle(),
      sessionId: currentSessionId || undefined,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型请求发起失败");
    }

    await runDone;
    offEvent();

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      if (stopRequested) {
        msg.content = streamContent ? streamContent + "\n\n[已停止生成]" : "[已停止生成]";
      } else {
        msg.content = streamContent;
      }
      msg.sticker = sticker;
    }
    void saveSession();
    const finishedMsgId = streamMsgId;
    void pendingTtsCachePromise?.then((cache) => {
      if (!cache) return;
      const latestMsg = messages.find(m => m.id === finishedMsgId);
      if (!latestMsg) return;
      latestMsg.ttsCacheKey = cache.cacheKey;
      void saveSession();
    });
    render();
    if (pendingWeatherCard) {
      const card = buildWeatherCardEl(pendingWeatherCard);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      pendingWeatherCard = null;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "模型请求失败";
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      if (streamContent) {
        msg.content = streamContent + "\n\n[生成中断：" + message + "]";
      } else {
        msg.content = "连接模型失败：" + message;
      }
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: "连接模型失败：" + message,
        at: Date.now(),
      });
    }
    void saveSession();
    render();
  } finally {
    currentStopHandler = null;
    sending = false;
    setSendButtonMode(false);
    chatHintEl.textContent = formatModelHint(currentModelConfig);
    inputEl.focus();
  }
}

async function send(overrideText?: string): Promise<void> {
  const text = (overrideText !== undefined ? overrideText : inputEl.value).trim();
  if ((!text && attachedFiles.length === 0) || sending) return;
  // bootstrap 极快但理论上仍有竞态：currentSessionId 为 null 时消息无处可存，
  // 直接拦截避免丢失。正常情况下 bootstrap 会在用户首次按键前完成。
  if (!currentSessionId) {
    console.warn("[Cyrene Chat] 会话尚未初始化完成，已忽略此次发送");
    return;
  }

    // Option C（临时注入）：内容不进 messages 历史，只附在 agui.run payload 传给本轮。
    // fullUserText 只放精简 hint 进 history，不堆内容。
    const hintsByKind: string[] = [];
    const turnTextAttachments: { name: string; text: string }[] = [];
    let budgetUsed = 0;
    const budgetExceeded: string[] = [];
    for (const f of attachedFiles) {
      switch (f.kind) {
        case "text":
          if (f.text) {
            const remaining = BUDGET_CHARS - budgetUsed;
            if (f.text.length > remaining) {
              turnTextAttachments.push({ name: f.name, text: f.text.slice(0, remaining) });
              budgetExceeded.push(f.name);
              budgetUsed = BUDGET_CHARS;
            } else {
              turnTextAttachments.push({ name: f.name, text: f.text });
              budgetUsed += f.text.length;
            }
          }
          hintsByKind.push(`📝 ${f.name}（附件，内容已注入本轮上下文）`);
          break;
        case "indexed":
          hintsByKind.push(`📚 ${f.name}（已索引 ${f.chunks ?? 0} 段，可用 imported_docs 工具检索）`);
          break;
        case "empty":
          hintsByKind.push(`📄 ${f.name}（为空）`);
          break;
        case "unsupported":
          hintsByKind.push(`⚠️ ${f.name}（暂不支持：${f.reason || ""}）`);
          break;
      }
    }
    if (budgetExceeded.length > 0) {
      hintsByKind.push(`⚠️ ${budgetExceeded.join("、")} 已省略部分内容（超一轮预算）`);
    }
    const fileHint = hintsByKind.length > 0
      ? "\n\n【本轮文件】\n" + hintsByKind.join("\n")
      : "";
    const fullUserText = (text || (attachedFiles.length > 0 ? "请帮我看看这些文件" : "")) + fileHint;

  sending = true;
  stopRequested = false;
  setSendButtonMode(true);
  await refreshModelConfig();
  chatHintEl.textContent = currentModelConfig?.connected ? `${currentModelConfig.model} 思考中…` : "模型未连接";

  const stickerMatch = fullUserText.match(/\[sticker:([^\]]+)\]/);
  const userStickerId = stickerMatch ? stickerMatch[1] : null;

  const userMsg: Message = {
    id: String(Date.now()),
    role: "user",
    content: fullUserText,
    at: Date.now(),
    sticker: userStickerId,
  };
  messages.push(userMsg);
  inputEl.value = "";
  autosize();
  removeAttachedFiles();
  void saveSession();
  render();

  let streamMsgId = "";
  try {
    streamMsgId = String(Date.now() + 1);
    const streamMsg = { id: streamMsgId, role: "model", content: "", at: Date.now(), thinking: true };
    messages.push(streamMsg);
    render();

    let streamContent = "";
    let ttsContent = "";
    let autoSpeakTriggered = false;
    const earlyMinimaxPlayback = createEarlyMinimaxPlayback();
    textMouthStarted = false;
    let pendingTtsCachePromise: Promise<{ cacheKey: string } | null> | null = null;
    let sticker: string | null = null;
    let pendingWeatherCard: Record<string, unknown> | null = null;

    // 终态信号：由事件流的 RUN_FINISHED/RUN_ERROR 触发 resolve，
    // 不依赖 invoke 的 resolve（invoke 只做 ack，可能与事件投递存在顺序竞争）。
    let finishRun!: () => void;
    let failRun!: (err: Error) => void;
    const runDone = new Promise<void>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    });

    // AG-UI 事件流：订阅 window.agui.onEvent，按事件类型渲染
    // 主进程在 FC 完成后瞬间把所有 delta 发完，渲染端用"回放队列"按固定节奏逐字显示，
    // 营造真流式感。流式中的气泡用增量 span 追加 + CSS 渐显，不调 render() 全量重建。
    const deltaQueue: string[] = [];
    let playbackTimer: number | null = null;
    let runFinishedArrived = false;
    /** 找到当前流式消息的气泡 DOM（TEXT_MESSAGE_START 时 render 过一次，带 data-msg-id）。 */
    const getStreamingBubble = (): HTMLElement | null => {
      const row = messagesEl.querySelector(`[data-msg-id="${streamMsgId}"]`);
      return row ? row.querySelector(".msg__bubble") as HTMLElement : null;
    };
    // 终态条件：RUN_FINISHED 到达 AND 回放队列空。两者都满足才 finishRun。
    const tryFinish = (): void => {
      if (runFinishedArrived && deltaQueue.length === 0 && playbackTimer === null) {
        finishRun();
      }
    };
    // 登记停止回调：点停止按钮时立即收尾（保留已流式输出内容）。
    // 后端 fetch 已被 agui.cancel() 中断，这里只做本地收尾，不等后端事件。
    currentStopHandler = () => {
      runFinishedArrived = true;
      deltaQueue.length = 0; // 不再回放剩余队列，已输出的 span 已在气泡里
      if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
      finishRun();
    };
    const startPlayback = (): void => {
      if (playbackTimer !== null) return;
      playbackTimer = window.setInterval(() => {
        const next = deltaQueue.shift();
        if (next !== undefined) {
          streamContent += next;
          // 增量追加 span 到气泡，CSS 渐显。不调 render()，避免全量重建卡顿。
          const bubble = getStreamingBubble();
          if (bubble) {
            const span = document.createElement("span");
            span.className = "msg__char";
            span.textContent = next;
            bubble.appendChild(span);
          }
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return;
        }
        // 队列空了
        if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
        tryFinish();
      }, 40);
    };
    const offEvent = window.agui!.onEvent((rawEvent) => {
      try {
        const event = rawEvent as AguiBaseEvent;
        const msg = messages.find(m => m.id === streamMsgId);
        switch (event.type) {
          case "TOOL_CALL_START": {
            // 工具调用开始：在 thinking 气泡里显示"🔧 调用中：xxx"，替换三个点
            // 流式路径下，本轮工具调用前可能有过程文本（已入 deltaQueue/已渲染），
            // 先清空回放队列并停掉计时器 + 重置累积，避免残留字符盖在工具提示后面。
            deltaQueue.length = 0;
            if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
            streamContent = "";
            ttsContent = "";
            // 记录本轮是否用了写类工具（供"重新生成/编辑重发"门控）
            if (isWriteRisk(event.toolRisk) && msg) msg.usedWriteTool = true;
            const bubble = getStreamingBubble();
            if (bubble) {
              bubble.classList.remove("msg__bubble--thinking");
              bubble.replaceChildren();
              const tip = document.createElement("div");
              tip.className = "msg__tool-tip";
              tip.dataset.toolCallId = event.toolCallId ?? "";
              const icon = document.createElement("span");
              icon.className = "msg__tool-icon";
              icon.textContent = "🔧";
              const text = document.createElement("span");
              text.className = "msg__tool-text";
              text.textContent = "调用中：" + (event.toolCallName ?? "工具");
              tip.appendChild(icon);
              tip.appendChild(text);
              bubble.appendChild(tip);
            }
            break;
          }
          case "TOOL_CALL_END": {
            // 工具调用完成：把"调用中"改成"完成"，淡出准备让位给文字
            const bubble = getStreamingBubble();
            if (bubble) {
              const tip = bubble.querySelector(".msg__tool-tip");
              if (tip) {
                const textEl = tip.querySelector(".msg__tool-text");
                if (textEl) textEl.textContent = "已完成";
                tip.classList.add("msg__tool-tip--done");
              }
            }
            break;
          }
          case "TEXT_MESSAGE_START":
            // 切换 thinking 点 → 空气泡，render 一次建立 DOM（带 data-msg-id）
            // 工具提示（若有）会被 render 重建清掉，自然过渡到文字
            if (msg) { msg.thinking = false; render(); }
            break;
          case "TEXT_MESSAGE_CONTENT":
            if (event.delta) {
              ttsContent += event.delta;
              earlyMinimaxPlayback.append(ttsContent);
              deltaQueue.push(event.delta);
              if (!textMouthStarted) {
                void loadTtsSettings().then((settings) => {
                  if (settings && !settings.ttsAutoRead) {
                    startTextModeMouth();
                  }
                });
              }
              if (msg) { msg.thinking = false; }
              startPlayback();
            }
            break;
          case "TEXT_MESSAGE_END":
            // 全文 delta 已收齐时，ttsContent 已经同步累加完整；UI 的 streamContent 仍按 40ms 逐字回放。
            // 这样声音可尽早开始，且不受前端打字动画队列影响。
            if (!autoSpeakTriggered && ttsContent.trim()) {
              autoSpeakTriggered = true;
              pendingTtsCachePromise = earlyMinimaxPlayback.finish(ttsContent);
            }
            break;
          case "CUSTOM":
            // 主进程发的自定义事件：sticker / 天气卡片 / 任务清单 / 选择卡片 / 思考过程
            if (event.name === "cyrene.sticker") {
              sticker = (event.value as StickerId | null) ?? null;
            } else if (event.name === "cyrene.thinking") {
              // 思考过程：支持两种形态——
              //  - 非流式：{ round, text }  整段一次性到达
              //  - 流式：  { round, delta, append, start } 逐块到达
              const tv = event.value as { round?: number; text?: string; delta?: string; append?: boolean; start?: boolean } | null;
              if (tv && msg) {
                if (tv.append && typeof tv.delta === "string") {
                  // 流式增量：新一轮（start=true）之间用空行分隔，避免多轮思考粘连
                  if (tv.start && msg.thinkingText) msg.thinkingText += "\n\n";
                  msg.thinkingText = (msg.thinkingText ?? "") + tv.delta;
                  if (showThinking) upsertThinkingBlock(msg);
                } else {
                  const piece = tv.text?.trim();
                  if (piece) {
                    msg.thinkingText = msg.thinkingText ? msg.thinkingText + "\n\n" + piece : piece;
                    if (showThinking) upsertThinkingBlock(msg);
                  }
                }
              }
            } else if (event.name === "cyrene.weather") {
              // 暂存天气数据，等 runDone 后 render 再插入（避免 render 的 replaceChildren 清掉卡片）
              console.log("[Chat] 收到天气卡片数据:", JSON.stringify(event.value)?.slice(0, 100));
              pendingWeatherCard = event.value as Record<string, unknown>;
            } else if (event.name === "cyrene.todos") {
              renderTodoPanel(event.value as TodoState | null);
            } else if (event.name === "cyrene.choice") {
              // 选择卡片：立即插入聊天流（不等 runDone，因为要即时交互）
              const choiceData = event.value as { id: string; question: string; options: Array<{ label: string; value: string; description?: string }>; default?: string };
              const card = buildChoiceCardEl(choiceData);
              messagesEl.appendChild(card);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            break;
          case "RUN_FINISHED":
            // 终态信号到达，但要等回放队列空才真正 finishRun（保证流式播完）
            runFinishedArrived = true;
            tryFinish();
            break;
          case "RUN_ERROR":
            failRun(new Error(event.content || "模型请求失败"));
            break;
          default:
            // TOOL_CALL_* / STEP_* 暂不在 UI 处理（骨架阶段）
            break;
        }
      } catch (err) {
        console.error("[Chat] onEvent回调抛错:", err);
      }
    });

    // invoke 只确认"已发起"，不等 Observable 结束。
    // 真正的完成由事件流 RUN_FINISHED/RUN_ERROR 驱动（await runDone）。
    const ack = await window.agui!.run({
      messages: buildModelMessages(),
      style: getCurrentStyle(),
      sessionId: currentSessionId || undefined,
      attachments: turnTextAttachments,
    });
    if (!ack.success) {
      offEvent();
      throw new Error(ack.error || "模型请求发起失败");
    }

    // 等事件流终态
    await runDone;
    offEvent();

    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      // 用户主动停止：保留已流式输出的内容，追加"(已停止)"标记；不清空。
      if (stopRequested) {
        msg.content = streamContent ? streamContent + "\n\n[已停止生成]" : "[已停止生成]";
      } else {
        msg.content = streamContent;
      }
      msg.sticker = sticker;
    }
    void saveSession();
    const finishedMsgId = streamMsgId;
    void pendingTtsCachePromise?.then((cache) => {
      if (!cache) return;
      const latestMsg = messages.find(m => m.id === finishedMsgId);
      if (!latestMsg) return;
      latestMsg.ttsCacheKey = cache.cacheKey;
      void saveSession();
    });
    render();
    // 天气卡片在 render 后追加到末尾（模型回复之后）
    if (pendingWeatherCard) {
      console.log("[Chat] 插入天气卡片");
      const card = buildWeatherCardEl(pendingWeatherCard);
      messagesEl.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      pendingWeatherCard = null;
    }
    // TTS 已在 TEXT_MESSAGE_END 时触发，这里不再重复朗读
  } catch (err) {
    const message = err instanceof Error ? err.message : "模型请求失败";
    const msg = messages.find(m => m.id === streamMsgId);
    if (msg) {
      msg.thinking = false;
      // 关键：保留已经流式输出的内容，错误信息追加在后面（避免"清出内存后已输出内容消失"）。
      // 用户主动停止走的是正常 runDone 路径，一般不会进这里；这里主要处理真实错误。
      if (streamContent) {
        msg.content = streamContent + "\n\n[生成中断：" + message + "]";
      } else {
        msg.content = "连接模型失败：" + message;
      }
    } else {
      messages.push({
        id: String(Date.now() + 2),
        role: "model",
        content: "连接模型失败：" + message,
        at: Date.now(),
      });
    }
    void saveSession();
    render();
  } finally {
    currentStopHandler = null;
    sending = false;
    setSendButtonMode(false);
    chatHintEl.textContent = formatModelHint(currentModelConfig);
    inputEl.focus();
  }
}
function clearChat(): void {
  if (sending) return;
  if (messages.length === 0) return;
  const ok = window.confirm("清空当前对话？");
  if (!ok) return;
  messages.length = 0;
  void saveSession();
  render();
}

/* ===== Window controls ===== */
minBtn.addEventListener("click", () => {
  window.chat?.minimize();
});
maxBtn.addEventListener("click", () => {
  window.chat?.toggleMaximize();
});
closeBtn.addEventListener("click", () => {
  window.chat?.close();
});

/* ===== Composer ===== */
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  // 生成中：提交按钮语义变为"停止"
  if (sending) { requestStop(); return; }
  void send();
});

inputEl.addEventListener("input", autosize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (sending) { requestStop(); return; }
    void send();
  }
});


/* ===== File upload ===== */
const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement | null;
let attachedFiles: Attachment[] = [];
	
// ── path-based 文件摄入 ──
// 路径提取在 preload（webUtils.getPathForFile），renderer 不碰 Electron API。
async function ingestDroppedFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  attachBtn!.disabled = true;
  try {
    const results = await window.chat!.ingestDroppedFiles(files);
    if (results && results.length > 0) attachedFiles = [...attachedFiles, ...results];
    updateFileTags();
  } catch (err: unknown) {
    window.alert("文件摄入失败：" + ((err as Error)?.message || String(err)));
  } finally {
    attachBtn!.disabled = false;
    fileInput!.value = "";
  }
}
	
	function updateFileTags(): void {
	  const container = document.getElementById("file-tags");
	  if (!container) return;
	  container.innerHTML = "";
	  if (attachedFiles.length === 0) {
	    attachBtn?.classList.remove("has-file");
	    return;
	  }
	  attachBtn?.classList.add("has-file");
	  const kindLabel: Record<AttachmentKind, string> = {
	    text: "📝",
	    indexed: "📚",
	    empty: "📄",
	    unsupported: "⚠️",
	  };
	  attachedFiles.forEach((f, i) => {
	    const tag = document.createElement("div");
	    tag.className = "chat__file-tag";
	    const label = document.createElement("span");
	    const icon = kindLabel[f.kind] || "📄";
	    const detail = f.kind === "text" ? "（附件）" :
	      f.kind === "indexed" ? `（${f.chunks ?? 0} 段）` :
	      f.kind === "empty" ? "（空）" :
	      "（暂不支持）";
	    label.textContent = `${icon} ${f.name} ${detail}`;
	    const btn = document.createElement("button");
	    btn.type = "button";
	    btn.className = "file-tag-remove";
	    btn.textContent = "×";
	    btn.addEventListener("click", () => {
	      attachedFiles.splice(i, 1);
	      updateFileTags();
	    });
	    tag.appendChild(label);
	    tag.appendChild(btn);
	    container.appendChild(tag);
	  });
	}
	
	attachBtn?.addEventListener("click", () => {
	  fileInput?.click();
	});
	
	fileInput?.addEventListener("change", () => {
	  if (fileInput.files && fileInput.files.length > 0) {
	    void ingestDroppedFiles(Array.from(fileInput.files));
	  }
	});
	
	function removeAttachedFiles(): void {
	  attachedFiles = [];
	  attachBtn?.classList.remove("has-file");
	  const container = document.getElementById("file-tags");
	  if (container) container.innerHTML = "";
	}

/* ===== Drag & drop ===== */
const chatEl = document.querySelector(".chat") as HTMLElement | null;
let dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter += 1;
  chatEl?.classList.add("chat--drag-over");
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter -= 1;
  if (dragCounter <= 0) {
    dragCounter = 0;
    chatEl?.classList.remove("chat--drag-over");
  }
});

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragCounter = 0;
  chatEl?.classList.remove("chat--drag-over");
  // path-based：直接把 dataTransfer.files 传 ingestDroppedFiles，
  // main 侧 fs.statSync 判断文件/文件夹后递归展开。
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    void ingestDroppedFiles(Array.from(files));
  }
});

clearBtn.addEventListener("click", clearChat);



/* ===== Dropdown: mode + style + reasoning (body-level menus) ===== */
(function() {
  var triggers = document.querySelectorAll(".dropdown-trigger");
  var menus = {
    "mode-dropdown": document.getElementById("mode-dropdown"),
    "style-dropdown": document.getElementById("style-dropdown"),
    "reasoning-dropdown": document.getElementById("reasoning-dropdown")
  };
  var values = {
    "mode-dropdown": document.getElementById("mode-val"),
    "style-dropdown": document.getElementById("style-val"),
    "reasoning-dropdown": document.getElementById("reasoning-val")
  };

  // Close all dropdowns
  function closeAll() {
    triggers.forEach(function(t) { t.classList.remove("is-open"); });
    Object.keys(menus).forEach(function(k) {
      if (menus[k]) menus[k].classList.remove("is-open");
    });
  }

  // Open a specific dropdown
  function openDropdown(id, trigger) {
    var menu = menus[id];
    if (!menu) return;
    var rect = trigger.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = rect.left + "px";
    menu.classList.add("is-open");
    trigger.classList.add("is-open");
  }

  // Trigger click
  triggers.forEach(function(t) {
    t.addEventListener("click", function(e) {
      e.stopPropagation();
      var id = t.getAttribute("data-dropdown");
      var isOpen = t.classList.contains("is-open");
      closeAll();
      if (!isOpen) openDropdown(id, t);
    });
  });

  // Option click
  Object.keys(menus).forEach(function(id) {
    var menu = menus[id];
    if (!menu) return;
    menu.querySelectorAll(".dm-opt").forEach(function(opt) {
      opt.addEventListener("click", function() {
        menu.querySelectorAll(".dm-opt").forEach(function(o) { o.classList.remove("is-active"); });
        opt.classList.add("is-active");
        var val = values[id];
        if (val) val.textContent = opt.textContent?.trim() || "";
        closeAll();
      });
    });
  });

  // Click outside closes
  document.addEventListener("click", closeAll);
})();


/* ===== Floating particles (dreamy pink motes) =====
   在 .chat 容器底层画一组缓慢上飘的粉紫色光斑，颜色与全站 pink/violet
   主题一致，配 twinkle 闪烁。canvas 在 HTML 里绝对定位、pointer-events:none，
   所以不影响输入/点击/滚动。 */
interface Particle {
  x: number;
  y: number;
  size: number;
  vx: number;
  vy: number;
  hue: number;
  alpha: number;
  twinkle: number;
  twinkleSpeed: number;
}

const PARTICLE_COUNT = 38;
const PARTICLE_HUE_MIN = 305; // pink
const PARTICLE_HUE_MAX = 345; // violet

const particlesCanvas = document.getElementById("particles") as HTMLCanvasElement | null;
const particlesCtx = particlesCanvas ? particlesCanvas.getContext("2d") : null;
let particles: Particle[] = [];
let particlesDpr = 1;
let particlesW = 0;
let particlesH = 0;

function spawnParticle(): Particle {
  return {
    x: Math.random() * particlesW,
    y: Math.random() * particlesH,
    size: 0.6 + Math.random() * 2.4,
    vx: (Math.random() - 0.5) * 0.18,
    vy: -0.05 - Math.random() * 0.22,
    hue: PARTICLE_HUE_MIN + Math.random() * (PARTICLE_HUE_MAX - PARTICLE_HUE_MIN),
    alpha: 0.25 + Math.random() * 0.5,
    twinkle: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.005 + Math.random() * 0.012,
  };
}

function resizeParticles(): void {
  if (!particlesCanvas || !particlesCtx) return;
  const rect = particlesCanvas.getBoundingClientRect();
  particlesDpr = window.devicePixelRatio || 1;
  particlesW = rect.width;
  particlesH = rect.height;
  particlesCanvas.width = Math.max(1, Math.round(rect.width * particlesDpr));
  particlesCanvas.height = Math.max(1, Math.round(rect.height * particlesDpr));
  particlesCtx.setTransform(particlesDpr, 0, 0, particlesDpr, 0, 0);
}

function drawParticles(): void {
  if (!particlesCtx) return;
  particlesCtx.clearRect(0, 0, particlesW, particlesH);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.twinkle += p.twinkleSpeed;
    if (p.y < -10) {
      p.y = particlesH + 10;
      p.x = Math.random() * particlesW;
    }
    if (p.x < -10) p.x = particlesW + 10;
    if (p.x > particlesW + 10) p.x = -10;

    const flicker = 0.65 + Math.sin(p.twinkle) * 0.35;
    const a = p.alpha * flicker;
    const r = p.size * 3;
    const grad = particlesCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue}, 90%, 80%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 90%, 70%, ${a * 0.4})`);
    grad.addColorStop(1, `hsla(${p.hue}, 90%, 70%, 0)`);
    particlesCtx.fillStyle = grad;
    particlesCtx.beginPath();
    particlesCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    particlesCtx.fill();
  }
  // 旧逻辑：无条件持续 rAF。改为受 particlesRafId 控制，可被 stopParticles 停掉。
  particlesRafId = requestAnimationFrame(drawParticles);
}

// 动态背景开关：可启停粒子 rAF 循环，关闭时清空 canvas 省性能。
let particlesRafId: number | null = null;
function startParticles(): void {
  if (!particlesCtx) return;
  if (particlesRafId !== null) return; // 已在运行
  if (particles.length === 0) {
    particles = Array.from({ length: PARTICLE_COUNT }, spawnParticle);
  }
  particlesRafId = requestAnimationFrame(drawParticles);
}
function stopParticles(): void {
  if (particlesRafId !== null) {
    cancelAnimationFrame(particlesRafId);
    particlesRafId = null;
  }
  if (particlesCtx) particlesCtx.clearRect(0, 0, particlesW, particlesH);
}
function setDynamicBackground(enabled: boolean): void {
  if (enabled) startParticles();
  else stopParticles();
}

if (particlesCtx) {
  resizeParticles();
  particles = Array.from({ length: PARTICLE_COUNT }, spawnParticle);
  // 旧逻辑：直接 requestAnimationFrame(drawParticles) 无条件启动。
  // 新逻辑：默认启动，稍后 initGeneralPrefs() 根据设置决定是否停掉。
  startParticles();
  window.addEventListener("resize", resizeParticles);
}

// 通用偏好（动态背景 / 显示思考）：启动时读一次，并在设置变更时实时应用。
async function initGeneralPrefs(): Promise<void> {
  try {
    const g = await window.settings?.getGeneral?.() as { dynamicBackground?: boolean; showThinking?: boolean } | undefined;
    if (g) {
      setDynamicBackground(g.dynamicBackground !== false);
      showThinking = g.showThinking !== false;
      render();
    }
  } catch { /* 读不到就保持默认（都开启） */ }
}


// 启动：迁移老 localStorage → 选会话 → render
// 先把用户贴纸目录拉到内存，再 bootstrap 渲染历史消息——否则首屏里
// 纯贴纸消息（气泡已隐藏）会因 enabledStickers 还没加载而渲染成空白。
void (async () => {
  await loadEnabledStickers();
  await bootstrap();
  buildQuickPresets();
  installSchedulerEventListener();
  void initModelConfig();
  void initWorkspace();
  void initGeneralPrefs();
})();

// 设置窗口保存后，聊天窗重新聚焦时刷新一次通用偏好（动态背景 / 显示思考）
window.addEventListener("focus", () => { void initGeneralPrefs(); });

// main → renderer：权限审批请求（per-action 档位下工具调用前）
// 插入一张审批卡片到聊天流；用户点同意/拒绝后回传给主进程。
window.settings?.onPermissionApprovalRequest?.((req) => {
  console.log("[Cyrene/Chat] permission approval request:", req.id, req.toolId);
  const card = buildApprovalCardEl(req);
  messagesEl.appendChild(card);
  // 滚动到底部让用户看到
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

// main → renderer：设置面板点列表/新对话时，让窗口切到指定 session
window.chatStore?.onSwitchSession(async (sessionId) => {
  if (!window.chatStore) return;
  if (sessionId === currentSessionId) return;
  const session = await window.chatStore.get(sessionId);
  if (session) loadSessionIntoUI(session);
});

// 任意会话变动后 main 广播——两种处理：
// 1. 当前活跃会话被外部删了 → fallback 到最新一条 / 自动建新
// 2. 侧栏展开时刷新列表（别的窗口新建/改名/删除都会触发）
window.chatStore?.onChanged(async () => {
  // 侧栏展开时刷新列表（收起时不浪费 DOM 写入）
  if (chatRail && !chatRail.hidden) void renderRailList();

  if (!window.chatStore || !currentSessionId) return;
  const stillExists = await window.chatStore.get(currentSessionId);
  if (stillExists) return;
  // 当前会话已被外部删除：fallback 到最新一条 / 自动建新
  const list = await window.chatStore.list();
  let next: ChatStoreSession | null = null;
  if (list.length > 0) next = await window.chatStore.get(list[0].id);
  if (!next) next = await window.chatStore.create({ identityId: null });
  if (next) loadSessionIntoUI(next);
});
autosize();
inputEl.focus();
