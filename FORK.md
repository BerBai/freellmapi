# Fork 维护说明

本仓库是 `tashfeenahmed/freellmapi` 的 Fork，使用“上游镜像 + 小型补丁分支”的方式维护，避免把所有自定义修改堆进同一个长期分支。

## 分支约定

- `main`：只用于跟踪 `upstream/main`，不添加自定义提交。
- `feat/self-hosted-catalog`：当前 Fork 的自托管目录配置与文档。
- 后续每个独立功能使用单独分支，例如 `feat/custom-routing`、`fix/local-security`。

每个自定义提交只做一件事，提交信息保持可搜索，方便以后用 `cherry-pick` 单独迁移。

## 同步上游

推荐使用仓库内脚本，脚本会在改写历史前检查工作区是否干净。

```bash
# 查看当前分支与上游的差距
./scripts/fork/upstream-sync.sh status

# 列出尚未进入当前工作分支的上游提交
./scripts/fork/upstream-sync.sh list

# 更新 main，并变基当前自定义分支
./scripts/fork/upstream-sync.sh sync

# 同时把 main 和自定义分支推送到 Fork
./scripts/fork/upstream-sync.sh sync --push
```

也可以单独执行：

```bash
# 只更新 main
./scripts/fork/upstream-sync.sh update-main --push

# 只将自定义分支变基到最新 upstream/main
./scripts/fork/upstream-sync.sh rebase --push
```

脚本默认配置：

- `upstream` 指向 `tashfeenahmed/freellmapi`
- `origin` 指向自己的 Fork
- 工作分支为 `feat/self-hosted-catalog`

可使用环境变量覆盖：

```bash
WORK_BRANCH=feat/custom-routing UPSTREAM_REMOTE=upstream ./scripts/fork/upstream-sync.sh rebase --push
```

脚本永远不会向 `upstream` 推送。如果该分支已经有多人协作，改用 `git merge upstream/main`，不要强制改写公共历史。

## 只迁移指定的上游提交

```bash
# 先确认可用提交
./scripts/fork/upstream-sync.sh list 100

# 将指定提交应用到当前工作分支
./scripts/fork/upstream-sync.sh cherry-pick <commit-sha>

# 应用后推送
./scripts/fork/upstream-sync.sh cherry-pick <commit-sha> --push
```

合并前可用 `git range-diff` 对比变基前后的补丁序列，确认没有意外丢失自定义修改。

## 自托管实时目录

自托管签名目录服务位于 [`fork/catalog`](fork/catalog/README.md)。它使用 Node.js
内置模块，没有额外运行时依赖。

服务拆分为两个角色：

- 发布端持有 Ed25519 私钥，将目录签名后原子写入 `published.json`
- 服务端只需要 `published.json`，不需要私钥，并通过 `/v1/latest` 提供签名响应

快速流程：

```bash
# 1. 生成签名密钥
node fork/catalog/src/keygen.mjs --out-dir fork/catalog/keys

# 2. 从路由数据库导出目录
npm run export-catalog -w server -- \
  --db /path/to/freeapi.db \
  --out /tmp/catalog.json \
  --tier live \
  --version 2026.11.23.1

# 3. 手动签名发布（一次性）
node fork/catalog/src/publish.mjs \
  --input /tmp/catalog.json \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data

# 4. 自动发现、探测并发布（单次）
PUBLISHER_PREPARE_COMMAND='./fork/catalog/scripts/prepare-from-db.sh' \
PUBLISHER_VALIDATE_COMMAND='node fork/catalog/src/validate-catalog.mjs' \
node fork/catalog/src/publisher.mjs \
  --private-key fork/catalog/keys/private-key.pem \
  --out-dir fork/catalog/data \
  --once

# 5. 启动目录服务
CATALOG_DATA_DIR=fork/catalog/data node fork/catalog/src/server.mjs
```

然后配置 FreeLLMAPI：

```env
CATALOG_BASE_URL=http://127.0.0.1:8787
CATALOG_PUBKEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
```

服务端点：

- `GET /health`
- `GET /publisher`
- `GET /v1/latest`
- `GET /v1/latest?since=<version>`
- `HEAD /v1/latest`

自动发布器会比较目录的语义内容：只有模型、限额、排序或 quirk 发生变化时才生成新版本；仅修改
`version` 或 `generatedAt` 不会产生新发布。默认还会阻止模型数量下降超过 50% 的异常目录，
发布状态可通过 `GET /publisher` 查看。

目录服务只负责签名和分发，不会自动发现或验证新模型。实际目录内容仍由发布端生成。
`PUBLISHER_PREPARE_COMMAND` 是接入自定义模型发现和探测流程的位置。

注意：仅删除客户端的 Premium 判断不会产生新的模型数据。免费版和实时版的核心差异是目录服务实际返回的内容；要让新模型立即出现，必须自行维护并发布一份实时目录。

## 构建与验证

```bash
npm ci
npm test
npm run build
```

Fork 分支在合并前至少完成上述测试，并在 Docker 环境中实际启动一次。
