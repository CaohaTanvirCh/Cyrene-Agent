// 工作目录（workspace）—— 给 agent 一个"当前所在目录"的基准概念。
//
// 设计动机：原本 fs 工具全部强制绝对路径，没有"工作区/项目根"概念，
// 体验上更像纯聊天而非 claude-code / opencode 那种明确 cwd 的 agent。
//
// 定位（软约束）：
//   - workspace 是"默认基准目录"，不是牢笼。
//   - 文件工具收到相对路径时，以 workspace 为基准解析成绝对路径；仍支持绝对路径访问任意位置。
//   - run_shell / 文档生成等未指定 cwd 时，默认用 workspace。
//   - 工作区可选：为空 = 纯聊天模式（回退到原行为，工具要求绝对路径）。
//
// 持久化到 userData/workspace.json，跨重启保留上次选择的目录。

import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

const LOG_PREFIX = "[Workspace]";

/** 当前工作目录的内存缓存（main 进程持有）。空串 = 未设置 = 纯聊天模式。 */
let currentWorkspace = "";

function getStorePath(): string {
  return path.join(app.getPath("userData"), "workspace.json");
}

/** 校验路径是否是一个真实存在的目录。 */
function isValidDir(p: string): boolean {
  if (!p || !path.isAbsolute(p)) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 启动时从磁盘加载上次保存的工作目录；不存在或已失效则保持空（纯聊天模式）。
 * 必须在 app.whenReady 之后调用（依赖 app.getPath）。
 */
export function initWorkspaceFromDisk(): void {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) {
      console.log(LOG_PREFIX, "未找到工作目录配置，默认纯聊天模式（无工作区）");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { dir?: unknown };
    const dir = typeof raw?.dir === "string" ? raw.dir : "";
    if (dir && isValidDir(dir)) {
      currentWorkspace = path.normalize(dir);
      console.log(LOG_PREFIX, "从磁盘加载工作目录:", currentWorkspace);
    } else if (dir) {
      console.warn(LOG_PREFIX, "保存的工作目录已失效，回退纯聊天模式:", dir);
    }
  } catch (err) {
    console.error(LOG_PREFIX, "加载工作目录失败:", err);
  }
}

/** 取当前工作目录。空串 = 未设置。 */
export function getWorkspace(): string {
  return currentWorkspace;
}

/**
 * 设置工作目录。传空串 / null 清除（回到纯聊天模式）。
 * 返回 { ok, dir?, error? }。目录不存在时报错、不改状态。
 */
export function setWorkspace(dir: string | null): { ok: boolean; dir?: string; error?: string } {
  const next = (dir ?? "").trim();
  if (!next) {
    currentWorkspace = "";
    persist("");
    console.log(LOG_PREFIX, "已清除工作目录（纯聊天模式）");
    return { ok: true, dir: "" };
  }
  if (!isValidDir(next)) {
    return { ok: false, error: "目录不存在或不是文件夹: " + next };
  }
  currentWorkspace = path.normalize(next);
  persist(currentWorkspace);
  console.log(LOG_PREFIX, "工作目录已切换:", currentWorkspace);
  return { ok: true, dir: currentWorkspace };
}

function persist(dir: string): void {
  try {
    const filePath = getStorePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ dir }, null, 2), "utf8");
  } catch (err) {
    console.error(LOG_PREFIX, "持久化工作目录失败:", err);
  }
}

/**
 * 把工具传入的 path 解析成绝对路径（软约束核心）。
 *   - 已是绝对路径 → 原样规范化返回（允许访问工作区外，权限档位另行把关）。
 *   - 相对路径 + 有工作区 → 相对工作区解析。
 *   - 相对路径 + 无工作区 → 返回 null（调用方回退到"必须绝对路径"的原行为）。
 */
export function resolveWorkspacePath(inputPath: string): string | null {
  const raw = (inputPath ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (currentWorkspace) return path.normalize(path.join(currentWorkspace, raw));
  return null;
}
