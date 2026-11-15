#!/bin/bash
# 端到端测试：构建带自动化接口的应用，用临时目录和测试热键启动，跑完 flow.py 后清理。
# 不会读写你真正的用户目录，也不发送真实按键；但主窗口会出现在屏幕上，剪贴板会被覆盖。
# 测试构建不抢单实例锁，正式版开着也能跑。
set -u
cd "$(dirname "$0")/../.."
ROOT=$PWD

# 官方扩展单独构建成 zip，测试里像用户一样安装它们。
bun tools/build-extensions.ts | tail -3
export POCKET_E2E_EXT="$ROOT/build/extensions"

GOFLAGS=-tags=e2e bunx mygo build -debug -skip-dmg -skip-installer -o "$ROOT/build/e2e" | grep -v 'web │' | tail -2
APP=$(find "$ROOT/build/e2e" -path '*.app/Contents/MacOS/*' -type f | head -1)

WORK=$(mktemp -d)
cleanup() {
  # 一个退出信号应该就够了；等不到就报告出来，并强制结束，不让脚本卡住。
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "FAIL 应用收到 SIGTERM 后 5 秒内没有退出" >&2
      kill -9 "$PID" 2>/dev/null
    fi
  fi
  if [ -n "${POCKET_E2E_SHOTS:-}" ] && [ -d "$WORK/shots" ]; then
    mkdir -p "$POCKET_E2E_SHOTS" && cp "$WORK"/shots/*.png "$POCKET_E2E_SHOTS"/ 2>/dev/null
  fi
  rm -rf "$WORK" "$ROOT/build/e2e"
  # 测试构建生成的 src/mygo.ts 里带着测试钩子（E2E 服务），换回正式的，免得被提交进去。
  (cd "$ROOT" && bunx mygo generate >/dev/null 2>&1)
}
trap cleanup EXIT

# Unix socket 的路径长度有限，所以在工作目录里用相对路径。
(
  cd "$WORK" || exit 1
  POCKET_HOME="$WORK/home" POCKET_KEEP_OPEN=1 POCKET_SELECTION=accessibility POCKET_HOTKEY="Ctrl+Alt+Shift+F12" \
    MYGO_AUTOMATION=app.sock MYGO_INSPECTOR=1 exec "$APP"
) >"$WORK/app.log" 2>&1 &
PID=$!

for _ in $(seq 1 40); do
  [ -S "$WORK/app.sock" ] && break
  sleep 0.25
done
sleep 1.5

POCKET_E2E_DIR="$WORK" python3 "${POCKET_E2E_FLOW:-tools/e2e/flow.py}"
status=$?
if [ $status -ne 0 ]; then
  echo "--- 应用输出（最后 40 行）"
  tail -40 "$WORK/app.log"
fi
exit $status
