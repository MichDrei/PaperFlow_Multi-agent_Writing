#!/usr/bin/env bash
# 下载 Tectonic（TeX 引擎）到 .tectonic/bin，供本地编译使用。
# 说明：仓库不携带引擎二进制（体积大、有平台差异），首次运行需要联网下载一次。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.tectonic/bin"
mkdir -p "$DEST"
if [ -x "$DEST/tectonic" ]; then
  echo "已存在：$DEST/tectonic"
  exit 0
fi
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=x86_64 ;; aarch64|arm64) ARCH=aarch64 ;; esac
URL="https://github.com/tectonic-typesetting/tectonic/releases/latest/download/tectonic-0.15.0-${ARCH}-unknown-${OS}-musl.tar.gz"
echo "下载：$URL"
tmp="$(mktemp -d)"
curl -fsSL "$URL" -o "$tmp/t.tar.gz"
tar -xzf "$tmp/t.tar.gz" -C "$DEST"
chmod +x "$DEST/tectonic"
rm -rf "$tmp"
# 缓存目录留在仓库内，避免写系统目录
mkdir -p "$ROOT/.tectonic/cache" "$ROOT/.tectonic/home"
echo "完成：$("$DEST/tectonic" --version 2>/dev/null | head -1)"
