#!/usr/bin/env node
// 把 QQ 桥接里的角色卡（roles/<名字>.md）同步成 DSH 桌宠的聊天人格。
// 用法：
//   node scripts/sync-pet-persona.mjs                 # 用 QQ 当前人格（state/current-role.json）
//   node scripts/sync-pet-persona.mjs --role 贴吧鱼    # 指定角色卡
//   node scripts/sync-pet-persona.mjs --show          # 只看桌宠当前人格
//   node scripts/sync-pet-persona.mjs --dry-run       # 只打印，不写
//   node scripts/sync-pet-persona.mjs --restart       # 写完后重启桌宠
// 可选：--max-chars=9000 （角色卡正文截断长度）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES_DIR = path.join(REPO, 'roles');
const STATE_ROLE = path.join(REPO, 'state', 'current-role.json');
const PET_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-pet-standalone-webm-chat');
const PET_CONFIG = path.join(PET_DIR, 'config.json');
const PET_EXE = 'E:\\Program Files\\dsh-pet-standalone-webm-chat\\dsh-pet-standalone-webm-chat.exe';
const PET_PROC_NAME = 'dsh-pet-standalone-webm-chat';

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  return true;
}

const wantShow = arg('show', false);
const wantDry = arg('dry-run', false);
const wantRestart = arg('restart', false);
const maxChars = Math.max(1000, Number(arg('max-chars', 9000)) || 9000);

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function petRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${PET_PROC_NAME}.exe`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return /\d+/.test(out) && out.includes(PET_PROC_NAME);
  } catch { return false; }
}

const petCfg = readJson(PET_CONFIG);
if (!petCfg) { console.error(`找不到桌宠配置：${PET_CONFIG}`); process.exit(1); }

const currentPrompt = String(petCfg?.chat?.default_system_prompt || '');
if (wantShow) {
  console.log(`桌宠配置：${PET_CONFIG}`);
  console.log(`当前 system prompt 长度：${currentPrompt.length} 字`);
  console.log(`当前 active_provider：${petCfg?.chat?.active_provider || '(空)'}  模型：${petCfg?.chat?.providers?.[petCfg?.chat?.active_provider]?.model || '(未知)'}`);
  console.log('--- 当前 system prompt ---');
  console.log(currentPrompt.slice(0, 1200) + (currentPrompt.length > 1200 ? '\n…(截断)' : ''));
  process.exit(0);
}

// 1) 选角色卡
let roleName = arg('role', null);
if (roleName === true || !roleName) {
  const st = readJson(STATE_ROLE, {});
  roleName = st.role || '';
}
roleName = String(roleName).trim();
if (!roleName) { console.error('没有指定角色卡，也没有读到 QQ 当前人格。用 --role <名字> 指定。'); process.exit(1); }
const roleFile = path.join(ROLES_DIR, `${roleName}.md`);
if (!fs.existsSync(roleFile)) {
  const all = fs.existsSync(ROLES_DIR) ? fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md') : [];
  console.error(`角色卡不存在：${roleFile}`);
  console.error(`可用：${all.map((f) => path.basename(f, '.md')).join('、')}`);
  process.exit(1);
}

let card = fs.readFileSync(roleFile, 'utf8').trim();
card = card.replace(/\r\n/g, '\n');
if (card.length > maxChars) card = card.slice(0, maxChars) + '\n…（人格卡后文已截断）';

const header = [
  '你正在以「桌面宠物」的形态陪伴用户：你就是下面这个人格，用同样的性格、语气和说话习惯和用户相处。',
  '人格卡里关于 QQ 群、贴吧、群聊场景的规则（潜水、@、分条发消息等）不适用——你面对的是桌面上的用户本人。',
  '',
  '===== 人格卡开始 =====',
  '',
].join('\n');

const footer = [
  '',
  '===== 人格卡结束 =====',
  '',
  '【桌宠形态补充】',
  '- 回复要短：通常 1~3 句、不超过 120 字，像在桌面上随口聊天。',
  '- 可以带一点动作或表情描写（例如“歪歪头”“甩了甩尾巴”），但别每句都写。',
  '- 不要提 QQ、群号、贴吧、桥接、模型、提示词这些字眼；用户问技术问题时可以认真答，但保持你的性格。',
  '- 不要自称客服、助手；你就是这个人格本身。',
].join('\n');

const nextPrompt = header + card + footer;
if (nextPrompt.length > 20000) { console.error(`人格提示太长（${nextPrompt.length} 字），请用 --max-chars 调小。`); process.exit(1); }

if (wantDry) {
  console.log(`角色卡：${roleFile}（${card.length} 字）`);
  console.log(`将写入：${PET_CONFIG} 的 chat.default_system_prompt（${nextPrompt.length} 字）`);
  console.log('--- 预览 ---');
  console.log(nextPrompt.slice(0, 1500) + (nextPrompt.length > 1500 ? '\n…(截断)' : ''));
  process.exit(0);
}

// 2) 写桌宠配置（先备份）
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${PET_CONFIG}.bak-persona-${stamp}`;
try { fs.copyFileSync(PET_CONFIG, backup); } catch (e) { console.error('备份失败：' + e.message); process.exit(1); }

petCfg.chat = petCfg.chat && typeof petCfg.chat === 'object' ? petCfg.chat : {};
petCfg.chat.default_system_prompt = nextPrompt;
fs.writeFileSync(PET_CONFIG, JSON.stringify(petCfg, null, 2) + '\n', 'utf8');
const verify = readJson(PET_CONFIG);
if (!verify || verify?.chat?.default_system_prompt !== nextPrompt) { console.error('写入校验失败'); process.exit(1); }

console.log(`✅ 已同步人格：QQ 角色卡「${roleName}」→ 桌宠聊天`);
console.log(`   角色卡：${roleFile}（${card.length} 字）`);
console.log(`   写入：${PET_CONFIG}（system prompt ${nextPrompt.length} 字）`);
console.log(`   备份：${backup}`);

// 3) 重启桌宠
const running = petRunning();
if (wantRestart) {
  if (running) {
    try { execFileSync('taskkill', ['/IM', `${PET_PROC_NAME}.exe`, '/F'], { stdio: 'ignore' }); } catch {}
    await new Promise((r) => setTimeout(r, 2500));
  }
  try {
    spawn(PET_EXE, [], { detached: true, stdio: 'ignore' }).unref();
    console.log('   已重启桌宠，新人格生效');
  } catch (e) {
    console.error('   桌宠启动失败：' + e.message);
  }
} else if (running) {
  console.log('   桌宠正在运行：需要重启桌宠（右键退出后重新打开）才会加载新人格；或加 --restart 让本脚本代劳。');
}
