#!/usr/bin/env node
/**
 * 清理 DSH 里指向旧 qq-bridge 目录的 workspace 记录。
 *
 * 背景：qq-bridge 升级到 qq-bridge-plus 后，DSH 持久层 workspace.json 里还留着
 * 两个旧 workspace（QQ 聊天 / QQ 黑话学习），其 path 指向已迁移的
 * E:\DSH工作区\qq-bridge\state\agents 与 ...\slang-agent。
 * 桥接新会话已改用 qq-bridge-plus\state\agents，这两个旧记录只会留下空壳，
 * 且一旦有人点开就会报 working-directory 不存在。
 *
 * 安全要求：DSH 必须完全退出（运行中会覆盖本脚本的修改）。
 * 脚本会先备份 workspace.json，再删除旧 workspace 记录、旧会话目录与投影缓存。
 *
 * 用法：
 *   node scripts/cleanup-legacy-workspaces.mjs            # 只清理
 *   node scripts/cleanup-legacy-workspaces.mjs --relaunch # 清理后重新启动 DSH
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const WS_FILE = path.join(DSH_HOME, "storages", "workspace.json");
const SESSIONS_ROOT = path.join(DSH_HOME, "sessions");
const PROJ_CACHE = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
const DSH_EXE = "E:\\Program Files\\DSH\\DeepSeek Harness.exe";

const LEGACY_IDS = [
  "6c8da7e4-fc58-4f7a-ad3e-f96f2b12a247", // QQ 聊天
  "76b715b4-c66d-4237-bd81-7a5063d33a35", // QQ 黑话学习
];
const LEGACY_DIR_HINTS = ["qq-bridge-state-agents", "qq-bridge-state-slang-agent"];

function dshState() {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    return out.includes("DeepSeek Harness.exe") ? "running" : "stopped";
  } catch {
    return "unknown";
  }
}

const FORCE = process.argv.includes("--force");
if (!fs.existsSync(WS_FILE)) {
  console.error("找不到 DSH workspace 文件：" + WS_FILE);
  process.exit(1);
}
const dshStateNow = dshState();
if (dshStateNow === "running") {
  console.error(
    "检测到 DeepSeek Harness 仍在运行。\n" +
      "请先从托盘（或任务栏）完全退出 DSH，再运行本脚本；运行中修改会被 DSH 覆盖。",
  );
  process.exit(1);
}
if (dshStateNow === "unknown" && !FORCE) {
  console.error(
    "无法确认 DeepSeek Harness 是否已退出（tasklist 调用失败）。\n" +
      "请确认已完全退出后，加 --force 重试：\n" +
      "  node scripts\\cleanup-legacy-workspaces.mjs --relaunch --force",
  );
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = WS_FILE + ".bak-" + stamp;
fs.copyFileSync(WS_FILE, backup);

const data = JSON.parse(fs.readFileSync(WS_FILE, "utf8"));
const tables = data.tables?.workspaces ?? {};
const removedSessionIds = new Set();
const removedPaths = [];
for (const id of LEGACY_IDS) {
  const w = tables[id];
  if (!w) continue;
  removedPaths.push(w.path);
  for (const s of w.sessionIds ?? []) removedSessionIds.add(s);
  delete tables[id];
}
data.global.workspaceIds = (data.global.workspaceIds ?? []).filter((x) => !LEGACY_IDS.includes(x));
data.global.archivedSessionIds = (data.global.archivedSessionIds ?? []).filter(
  (x) => !removedSessionIds.has(x),
);
fs.writeFileSync(WS_FILE, JSON.stringify(data, null, 2) + "\n");

const removedDirs = [];
if (fs.existsSync(SESSIONS_ROOT)) {
  for (const name of fs.readdirSync(SESSIONS_ROOT)) {
    if (LEGACY_DIR_HINTS.some((h) => name.includes(h))) {
      fs.rmSync(path.join(SESSIONS_ROOT, name), { recursive: true, force: true });
      removedDirs.push(name);
    }
  }
}

let removedCache = 0;
if (fs.existsSync(PROJ_CACHE)) {
  for (const s of removedSessionIds) {
    const f = path.join(PROJ_CACHE, s + ".json");
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      removedCache++;
    }
  }
}

console.log(
  JSON.stringify(
    {
      backup,
      removedWorkspaces: removedPaths,
      removedSessionCount: removedSessionIds.size,
      removedSessionDirs: removedDirs,
      removedProjectionCache: removedCache,
    },
    null,
    2,
  ),
);

if (process.argv.includes("--relaunch")) {
  if (!fs.existsSync(DSH_EXE)) {
    console.error("找不到 DSH 可执行文件：" + DSH_EXE + "，请手动启动。");
    process.exit(1);
  }
  console.log("正在重新启动 DeepSeek Harness ...");
  const child = spawn(DSH_EXE, [], { detached: true, stdio: "ignore", cwd: path.dirname(DSH_EXE) });
  child.unref();
}
