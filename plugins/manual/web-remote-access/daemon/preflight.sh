#!/usr/bin/env bash
# 在不停止当前服务的前提下，验证 profile 组合与所有树外 bundle 的模块入口。
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
RUNTIME_CURRENT="$DSH_HOME_DIR/runtime/current"
DSH_BIN="$RUNTIME_CURRENT/node_modules/@deepseek-ai/dsh/lib/bin.js"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PROFILE_MANIFEST="$PROFILE_DIR/package.json"

for required in "$NODE_BIN" "$DSH_BIN" "$PROFILE_MANIFEST"; do
  if [[ ! -e "$required" ]]; then
    echo "!! DSH 重启预检缺少依赖：$required" >&2
    exit 1
  fi
done

echo "==> 组合 DSH profile：$PROFILE"
"$NODE_BIN" "$DSH_BIN" --profile "$PROFILE" --dump-config >/dev/null

echo "==> 导入 profile 的树外 bundle 入口"
while IFS= read -r package_name; do
  [[ -n "$package_name" ]] || continue
  printf '    %s ... ' "$package_name"
  (
    cd "$PROFILE_DIR"
    "$NODE_BIN" --input-type=module -e '
      const packageName = process.argv[1];
      const timer = setTimeout(() => {
        console.error(`\n!! bundle 入口导入超时：${packageName}`);
        process.exit(124);
      }, 15_000);
      await import(packageName);
      clearTimeout(timer);
      process.exit(0);
    ' "$package_name"
  )
  echo "OK"
done < <(
  "$NODE_BIN" -e '
    const manifest = require(process.argv[1]);
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const bundle of manifest.dsh?.profile?.bundles ?? []) {
      if (dependencies.has(bundle)) console.log(bundle);
    }
  ' "$PROFILE_MANIFEST"
)

echo "DSH 重启预检通过。"
