// 视频理解：下载 → ffmpeg 抽帧 + 提音轨 → faster-whisper（CPU/int8）转写。
//
// 设计约束（2026-10-27）：
//   · 子进程一律 **不开管道**（stdio 重定向到文件）——某些受限环境里 spawn 的管道会 EPERM，
//     而这里的中转文件本来就落在 state 下的临时目录，顺手也方便排查。
//   · 本机没有系统 Python，也没有 pip 环境，所以复用 GPT-SoVITS 自带的 runtime\python.exe，
//     把 faster-whisper 单独装到仓库内的 .whisper\pylibs，靠 PYTHONPATH 注入，**不污染** TTS 环境。
//   · 模型缓存放 .whisper\models；HF 直连在本机被劫持，默认走 hf-mirror。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VIDEO_DEFAULTS = {
  ffmpegPath: 'E:/GBT-Sovits/runtime/ffmpeg.exe',
  ffprobePath: 'E:/GBT-Sovits/runtime/ffprobe.exe',
  pythonPath: 'E:/GBT-Sovits/runtime/python.exe',
  scriptPath: path.join(ROOT, 'scripts', 'whisper-transcribe.py'),
  pylibs: path.join(ROOT, '.whisper', 'pylibs'),
  modelCache: path.join(ROOT, '.whisper', 'models'),
  modelName: 'small',
  language: 'auto',
  maxFrames: 8,
  maxVideoBytes: 30 * 1024 * 1024,
  maxAudioSeconds: 120,
  frameTimeoutMs: 120000,
  transcribeTimeoutMs: 300000
};

function run(cmd, args, { timeoutMs = 120000, stdoutFile = null, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let fd = null;
    const stdio = ['ignore', 'ignore', 'ignore'];
    if (stdoutFile) {
      fd = fs.openSync(stdoutFile, 'w');
      stdio[1] = fd;
      stdio[2] = fd;
    }
    const child = spawn(cmd, args, { stdio, windowsHide: true, env: env ?? process.env });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    const done = (err) => {
      clearTimeout(timer);
      if (fd != null) { try { fs.closeSync(fd); } catch {} }
      if (err) reject(err);
      else resolve();
    };
    child.on('error', (err) => done(new Error(`无法启动 ${path.basename(cmd)}：${err.message}`)));
    child.on('exit', (code) => done(code === 0 ? null : new Error(`${path.basename(cmd)} 退出码 ${code}`)));
  });
}

/** 用 ffprobe 读时长（秒）；拿不到返回 0。 */
export async function probeVideoDuration({ ffprobePath, input, workDir, timeoutMs = 20000 }) {
  const outJson = path.join(workDir, 'duration.json');
  await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input], { timeoutMs, stdoutFile: outJson });
  try {
    const raw = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    const d = Number(raw?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

/** 均匀抽帧：短视频按比例取点，返回 [{path, at}]。 */
export async function extractVideoFrames({ ffmpegPath, input, outDir, durationSec, count, timeoutMs }) {
  // 上限与 config.socialV2.video.maxFrames 的校验保持一致（1~32）。
  const n = Math.max(1, Math.min(32, Math.floor(Number(count) || 6)));
  const total = Number(durationSec) > 0 ? Number(durationSec) : 0;
  const frames = [];
  for (let i = 1; i <= n; i += 1) {
    // 0.35 秒的保险：有些视频最后一帧落在容器边界之外
    const at = total > 0 ? Math.max(0, Math.min(total - 0.35, (total * i) / (n + 1))) : 0;
    const out = path.join(outDir, `frame-${String(i).padStart(2, '0')}.jpg`);
    try {
      await run(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-ss', at.toFixed(2), '-i', input,
        '-frames:v', '1',
        '-vf', 'scale=min(960\\,iw):-2',
        '-q:v', '3', '-y', out
      ], { timeoutMs });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) frames.push({ path: out, at: Math.round(at * 10) / 10 });
    } catch {
      // 单帧失败不影响其余帧
    }
  }
  return frames;
}

/** 提取音轨（16k 单声道 wav，限时长）。没有音轨/失败返回 false。 */
export async function extractVideoAudio({ ffmpegPath, input, outPath, maxSeconds, timeoutMs = 180000 }) {
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-t', String(Math.max(1, Math.floor(Number(maxSeconds) || 120))),
      '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-y', outPath
    ], { timeoutMs });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 44;
  } catch {
    return false;
  }
}

/** 模型参数：优先用本地目录（.whisper\models\<名>\model.bin），否则交给 faster-whisper 按名字去 HF 拉。 */
function resolveModelArg(modelName, modelCache) {
  const name = String(modelName || 'small');
  try {
    const local = path.join(modelCache, name);
    if (fs.existsSync(path.join(local, 'model.bin'))) return local;
  } catch {}
  return name;
}

/** 调 faster-whisper 转写，返回解析后的 JSON（ok=false 时带 error）。 */
export async function transcribeAudio({ pythonPath, scriptPath, audioPath, outJson, modelName, modelCache, pylibs, language, timeoutMs }) {
  const env = {
    ...process.env,
    PYTHONPATH: pylibs,
    PYTHONIOENCODING: 'utf-8',
    HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com'
  };
  await run(pythonPath, [
    '-X', 'utf8', scriptPath,
    '--audio', audioPath,
    '--out', outJson,
    '--model', resolveModelArg(modelName, modelCache),
    '--cache', modelCache,
    '--language', String(language || 'auto')
  ], { timeoutMs, env });
  if (!fs.existsSync(outJson)) throw new Error('转写脚本没有输出结果文件');
  return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

/**
 * 完整流程：抽帧 + 提音轨 + 转写。
 * 返回 { durationSec, frames:[{path,at}], transcript, whisperError, elapsedMs }
 */
export async function understandVideo({ videoPath, workDir, options = {} }) {
  const opts = { ...VIDEO_DEFAULTS, ...options };
  const startedAt = Date.now();
  await fsp.mkdir(workDir, { recursive: true });

  let durationSec = Number(opts.durationSec) > 0 ? Number(opts.durationSec) : 0;
  if (!durationSec) {
    try { durationSec = await probeVideoDuration({ ffprobePath: opts.ffprobePath, input: videoPath, workDir }); } catch { durationSec = 0; }
  }

  const frames = await extractVideoFrames({
    ffmpegPath: opts.ffmpegPath,
    input: videoPath,
    outDir: workDir,
    durationSec,
    count: opts.maxFrames,
    timeoutMs: opts.frameTimeoutMs
  });

  const audioPath = path.join(workDir, 'audio.wav');
  const hasAudio = await extractVideoAudio({
    ffmpegPath: opts.ffmpegPath,
    input: videoPath,
    outPath: audioPath,
    maxSeconds: opts.maxAudioSeconds
  });

  let transcript = null;
  let whisperError = '';
  if (hasAudio) {
    try {
      transcript = await transcribeAudio({
        pythonPath: opts.pythonPath,
        scriptPath: opts.scriptPath,
        audioPath,
        outJson: path.join(workDir, 'transcript.json'),
        modelName: opts.modelName,
        modelCache: opts.modelCache,
        pylibs: opts.pylibs,
        language: opts.language,
        timeoutMs: opts.transcribeTimeoutMs
      });
      if (transcript && transcript.ok === false) {
        whisperError = transcript.error || '转写失败';
        transcript = null;
      }
    } catch (error) {
      whisperError = error?.message || String(error);
    }
  }

  return {
    durationSec: Math.round(durationSec * 10) / 10,
    frames,
    transcript,
    whisperError,
    elapsedMs: Date.now() - startedAt
  };
}
