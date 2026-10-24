#!/usr/bin/env bash
#
# 在无图形环境的容器里跑 UI 冒烟测试。
#
# 它会就地准备三样东西（都放在 .playwright/ 内，不污染系统）：
#   1. Chromium headless shell（scripts 首次运行前执行 `npx playwright install chromium`）
#   2. 缺失的共享库（libnspr4 / libnss3 / libasound2），通过解包 .deb 到 .playwright/sysroot
#   3. 中文字体（否则中文界面在无 CJK 字体的机器上会渲染成方块）
#
# 用法：bash scripts/verify-ui.sh [url]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PW="$ROOT/.playwright"

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$PW}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.cache}"
export npm_config_cache="${npm_config_cache:-$ROOT/.npm-cache}"
mkdir -p "$XDG_CACHE_HOME"

if [ -d "$PW/sysroot/usr/lib/x86_64-linux-gnu" ]; then
  export LD_LIBRARY_PATH="$PW/sysroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ -d "$PW/sysroot/usr/share/fonts" ]; then
  cat > "$PW/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$PW/sysroot/usr/share/fonts</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
EOF
  export FONTCONFIG_FILE="$PW/fonts.conf"
fi

echo "==> 浏览器：$PLAYWRIGHT_BROWSERS_PATH"
echo "==> 截图输出：$ROOT/artifacts"
exec node "$ROOT/scripts/verify-ui.mjs" "$@"
