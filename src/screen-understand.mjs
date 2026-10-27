/**
 * 屏幕理解：截屏（ffmpeg gdigrab）+ 调用视觉模型描述。
 * 只在本机使用：截图写到临时目录，调用完即删。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SCREEN_DEFAULTS = {
  ffmpegPath: 'E:/GBT-Sovits/runtime/ffmpeg.exe',
  maxWidth: 1600,
  captureTimeoutMs: 30000,
  askTimeoutMs: 120000,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  prompt: '这是一张电脑屏幕截图。用 1~3 句话说明屏幕上的主要内容（正在用什么软件、关键文字/画面）。如果用户提了具体问题，就针对问题回答。'
};

function runCapture(ffmpegPath, outPath, maxWidth, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-loglevel', 'error',
      '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop',
      '-frames:v', '1',
      '-vf', `scale=${Math.max(320, Number(maxWidth) || 1600)}:-2`,
      outPath
    ];
    let stderr = '';
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('截屏超时'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) resolve();
      else reject(new Error(`截屏失败（ffmpeg 退出码 ${code}）：${stderr.trim().slice(0, 300)}`));
    });
  });
}

export async function captureScreen({ outPath, ffmpegPath = SCREEN_DEFAULTS.ffmpegPath, maxWidth = SCREEN_DEFAULTS.maxWidth, timeoutMs = SCREEN_DEFAULTS.captureTimeoutMs } = {}) {
  if (!outPath) throw new Error('缺少截屏输出路径');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await runCapture(ffmpegPath, outPath, maxWidth, timeoutMs);
  return { path: outPath, bytes: fs.statSync(outPath).size };
}

export async function describeImage({ imagePath, question, apiKey, baseUrl = SCREEN_DEFAULTS.baseUrl, model = SCREEN_DEFAULTS.model, timeoutMs = SCREEN_DEFAULTS.askTimeoutMs, prompt = SCREEN_DEFAULTS.prompt } = {}) {
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('截图文件不存在');
  if (!apiKey) throw new Error('缺少 DeepSeek API Key');
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const buf = fs.readFileSync(imagePath);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const text = String(question || '').trim();
  const body = {
    model,
    temperature: 0.3,
    max_tokens: 800,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: text ? `${prompt}\n\n用户的问题：${text}` : prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: String(apiKey).startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || raw.slice(0, 300);
      throw new Error(`视觉模型返回 ${res.status}：${msg}`);
    }
    const answer = json?.choices?.[0]?.message?.content;
    if (typeof answer === 'string' && answer.trim()) return { text: answer.trim(), model: json?.model || model, usage: json?.usage || null };
    if (Array.isArray(answer)) {
      const joined = answer.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
      if (joined) return { text: joined, model: json?.model || model, usage: json?.usage || null };
    }
    throw new Error('视觉模型没有返回内容');
  } finally {
    clearTimeout(timer);
  }
}
