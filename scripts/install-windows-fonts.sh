#!/usr/bin/env bash
#
# 把 Windows 系统字体装进 Tectonic 自己的 fontconfig 目录。
#
# 为什么需要：中文毕设模板（如 SZTUthesis）常写死
#   \setmainfont{Times New Roman}
#   \setsansfont{Arial}
#   \setmonofont{Courier New}
# 这些是 Windows 字体，WSL 里默认没有，编译会直接失败：
#   ! Package fontspec Error: The font "Times New Roman" cannot be found.
#
# 装到哪里：`.tectonic/home/.local/share/fonts` —— 这正是 TectonicCompiler
# 传给子进程的 XDG_DATA_HOME（见 packages/latex/src/tectonicCompiler.ts），
# 所以放进去就自动生效，也不需要 sudo、不污染系统字体目录。
#
# 用法：
#   bash scripts/install-windows-fonts.sh
#
# 说明：字体只从**你自己的 Windows 目录**复制到本机 WSL 的用户目录，
# 不上传、不分发。若没有 /mnt/c 或没有权限，脚本会跳过并提示。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="${TECTONIC_FONT_DIR:-$REPO_ROOT/.tectonic/home/.local/share/fonts}"
WIN_FONTS="${WINDOWS_FONTS_DIR:-/mnt/c/Windows/Fonts}"

if [ ! -d "$WIN_FONTS" ]; then
  echo "⚠ 找不到 Windows 字体目录：$WIN_FONTS"
  echo "  （如果你没挂载 C 盘，可以用 WINDOWS_FONTS_DIR=/mnt/d/... 指定）"
  exit 1
fi

mkdir -p "$FONT_DIR"
echo "字体来源：$WIN_FONTS"
echo "安装到：  $FONT_DIR"

# 中文论文模板最常用的家族：西文三件套 + 宋黑楷仿 + 华文系列
PATTERNS=(
  "times*" "arial*" "cour*" "calibri*" "cambria*" "georgia*" "consola*" "verdana*" "tahoma*" "segoeui*"
  "simsun*" "simhei*" "simkai*" "simfang*" "msyh*" "Deng*"
  "STZHONGS*" "STKAITI*" "STSONG*" "STFANGSO*" "STXINWEI*" "STXINGKA*" "STLITI*" "STCAIYUN*" "STHUPO*" "STXIHEI*"
)

copied=0
for pattern in "${PATTERNS[@]}"; do
  for file in "$WIN_FONTS"/$pattern; do
    [ -f "$file" ] || continue
    target="$FONT_DIR/$(basename "$file")"
    if [ -e "$target" ]; then
      continue
    fi
    if cp "$file" "$target" 2>/dev/null; then
      copied=$((copied + 1))
    fi
  done
done

echo "新增 $copied 个字体文件（目录现有 $(ls -1 "$FONT_DIR" 2>/dev/null | wc -l) 个）"

# 用 Tectonic 的那套环境刷新缓存，保证它自己的 HOME 下产生索引
HOME_FOR_TECTONIC="$REPO_ROOT/.tectonic/home"
cat > "$HOME_FOR_TECTONIC/.config-placeholder" 2>/dev/null || true
HOME="$HOME_FOR_TECTONIC" \
  XDG_CACHE_HOME="$HOME_FOR_TECTONIC/.cache" \
  XDG_DATA_HOME="$HOME_FOR_TECTONIC/.local/share" \
  XDG_CONFIG_HOME="$HOME_FOR_TECTONIC/.config" \
  fc-cache -f >/dev/null 2>&1 || true

echo
echo "验证（应能看到 Times New Roman / Courier New / Arial / SimSun）："
HOME="$HOME_FOR_TECTONIC" \
  XDG_CACHE_HOME="$HOME_FOR_TECTONIC/.cache" \
  XDG_DATA_HOME="$HOME_FOR_TECTONIC/.local/share" \
  XDG_CONFIG_HOME="$HOME_FOR_TECTONIC/.config" \
  fc-list 2>/dev/null | grep -iE "times new roman|courier new|arial|simsun" | head -4 | sed 's/^/  /'

echo
echo "完成。Tectonic 下次编译会自动用上这些字体。"
