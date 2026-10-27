#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 faster-whisper（CPU / int8）把一段音频转成文字，结果写成 JSON 文件。

为什么不从 stdout 取结果：桥接用 spawn 时不开管道（管道在某些受限环境下会 EPERM），
所以约定「输入路径、输出路径」两个参数，结果只落在 --out 指向的 JSON 文件里。

用法：
  python whisper-transcribe.py --audio a.wav --out a.json --model small --cache .whisper/models --language auto

退出码：0 = 成功（JSON.ok=true），1 = 失败（JSON.ok=false，带 error）。
"""
import argparse
import json
import sys
import time
import traceback


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='small', help='模型名（tiny/base/small/medium）或本地模型目录')
    ap.add_argument('--cache', default='', help='模型下载/缓存目录')
    ap.add_argument('--language', default='auto', help='auto 或 zh/ja/en…')
    args = ap.parse_args()

    result = {'ok': False}
    try:
        from faster_whisper import WhisperModel

        cache = args.cache.strip() or None
        model = WhisperModel(args.model, device='cpu', compute_type='int8', download_root=cache)
        lang = None if args.language.strip().lower() in ('', 'auto', 'none') else args.language.strip().lower()
        started = time.time()
        segments, info = model.transcribe(
            args.audio,
            language=lang,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        parts = []
        segs = []
        for seg in segments:
            parts.append(seg.text)
            if len(segs) < 200:
                segs.append({'start': round(float(seg.start), 2), 'end': round(float(seg.end), 2), 'text': seg.text})
        result = {
            'ok': True,
            'text': ''.join(parts).strip(),
            'language': getattr(info, 'language', '') or '',
            'language_probability': round(float(getattr(info, 'language_probability', 0) or 0), 3),
            'duration': round(float(getattr(info, 'duration', 0) or 0), 2),
            'elapsed': round(time.time() - started, 2),
            'segments': segs,
            'model': args.model,
        }
    except Exception as exc:  # noqa: BLE001 —— 任何失败都写进 JSON，交给桥接展示
        result = {'ok': False, 'error': str(exc), 'trace': traceback.format_exc()[-1500:]}

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, ensure_ascii=False)
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
