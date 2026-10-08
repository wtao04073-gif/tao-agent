#!/usr/bin/env bash
# 仅供独立、可信试用主机。多租户生产使用 CubeSandbox VM。
set -euo pipefail
TAO_RUNTIME_ROOT="${1:-/opt/tao-sandbox}"
TAO_PYTHON="${2:-python3}"
command -v tesseract >/dev/null || { echo '请先安装 tesseract-ocr 与 chi_sim/eng 语言数据'; exit 1; }
command -v bwrap >/dev/null || { echo '请先安装 bubblewrap'; exit 1; }
"$TAO_PYTHON" -c 'import sys; assert sys.version_info >= (3,11), "需要 Python 3.11 或更新版本"'
mkdir -p "$TAO_RUNTIME_ROOT"
"$TAO_PYTHON" -m venv "$TAO_RUNTIME_ROOT/venv"
"$TAO_RUNTIME_ROOT/venv/bin/pip" install --no-cache-dir -r "$(dirname "$0")/runtime/requirements.txt"
PLAYWRIGHT_BROWSERS_PATH="$TAO_RUNTIME_ROOT/browsers" "$TAO_RUNTIME_ROOT/venv/bin/python" -m playwright install --with-deps chromium
cc -shared -fPIC -O2 -Wall -Wextra -o "$TAO_RUNTIME_ROOT/venv/libproc-exe-compat.so" "$(dirname "$0")/runtime/proc-exe-compat.c" -ldl
printf '%s\n' '安装完成。由部署配置指定 SANDBOX_LOCAL_RUNTIME 与 SANDBOX_LOCAL_BROWSERS，再在后台测试连接。'
