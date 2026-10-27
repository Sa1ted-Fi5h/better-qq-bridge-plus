#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 faster-whisper 的模型文件直接下到本地目录（绕过 hf_hub 在本机的 IPv6 卡死问题）。

用法：
  python download-whisper-model.py --repo Systran/faster-whisper-small --out .whisper/models/small [--endpoint https://hf-mirror.com]

只下载运行必需的 4 个文件：model.bin / config.json / tokenizer.json / vocabulary.txt
（缺 preprocessor_config.json 也能跑；faster-whisper 只用 config 里的 mel 参数）。
已存在且大小一致的会跳过，方便断点续跑。
"""
import argparse
import os
import sys
import time
import urllib.request

FILES = [
    ('model.bin', None),
    ('config.json', None),
    ('tokenizer.json', None),
    ('vocabulary.txt', None),
]


def size_of(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return -1


def remote_size(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=30) as resp:
        return int(resp.headers.get('Content-Length') or 0)


def download(url, dest, expect):
    tmp = dest + '.part'
    started = time.time()
    have = size_of(tmp) if os.path.exists(tmp) else 0
    headers = {}
    if have > 0 and expect and have < expect:
        headers['Range'] = f'bytes={have}-'
    req = urllib.request.Request(url, headers=headers)
    mode = 'ab' if have > 0 else 'wb'
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, mode) as fh:
        total = have + int(resp.headers.get('Content-Length') or 0)
        last = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            fh.write(chunk)
            have += len(chunk)
            done = have / total if total else 0
            if done - last >= 0.1:
                last = done
                print(f'  {os.path.basename(dest)} {have/1048576:.1f}/{total/1048576:.1f} MB ({done*100:.0f}%)', flush=True)
    os.replace(tmp, dest)
    elapsed = max(time.time() - started, 0.001)
    print(f'  {os.path.basename(dest)} 完成：{size_of(dest)/1048576:.1f} MB，{elapsed:.1f}s（{size_of(dest)/1048576/elapsed:.1f} MB/s）', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='Systran/faster-whisper-small')
    ap.add_argument('--out', required=True)
    ap.add_argument('--endpoint', default=os.environ.get('HF_ENDPOINT') or 'https://hf-mirror.com')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    base = args.endpoint.rstrip('/') + '/' + args.repo + '/resolve/main/'
    print(f'来源：{base}', flush=True)

    ok = True
    for name, _ in FILES:
        dest = os.path.join(args.out, name)
        url = base + name
        try:
            expect = remote_size(url)
        except Exception as exc:  # noqa: BLE001
            print(f'{name} 取大小失败：{exc}', flush=True)
            ok = False
            continue
        if size_of(dest) == expect and expect > 0:
            print(f'{name} 已存在（{expect/1048576:.1f} MB），跳过', flush=True)
            continue
        print(f'下载 {name}（{expect/1048576:.1f} MB）…', flush=True)
        try:
            download(url, dest, expect)
        except Exception as exc:  # noqa: BLE001
            print(f'{name} 下载失败：{exc}', flush=True)
            ok = False

    print('DONE' if ok else 'FAILED', flush=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
