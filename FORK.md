# Fork 维护说明

本仓库是 `tashfeenahmed/freellmapi` 的 Fork，使用“上游镜像 + 小型补丁分支”的方式维护，避免把所有自定义修改堆进同一个长期分支。

## 分支约定

- `main`：只用于跟踪 `upstream/main`，不添加自定义提交。
- `feat/self-hosted-catalog`：当前 Fork 的自托管目录配置与文档。
- 后续每个独立功能使用单独分支，例如 `feat/custom-routing`、`fix/local-security`。

每个自定义提交只做一件事，提交信息保持可搜索，方便以后用 `cherry-pick` 单独迁移。

## 同步上游

```bash
git fetch upstream --prune

# 更新纯上游镜像
git switch main
git merge --ff-only upstream/main
git push origin main

# 将自定义分支变基到最新上游
git switch feat/self-hosted-catalog
git rebase upstream/main

# 变基后推送自己的分支
git push --force-with-lease origin feat/self-hosted-catalog
```

如果该分支已经有多人协作，改用 `git merge upstream/main`，不要强制改写公共历史。

## 只迁移指定的上游提交

```bash
git fetch upstream --prune
git log --oneline HEAD..upstream/main

# 挑选需要的提交
git cherry-pick <commit-sha>
```

合并前可用 `git range-diff` 对比变基前后的补丁序列，确认没有意外丢失自定义修改。

## 自托管实时目录

FreeLLMAPI 已经支持通过环境变量覆盖目录服务，不需要先删除 Premium 页面或绕过服务端鉴权：

```env
CATALOG_BASE_URL=https://catalog.example.com
CATALOG_PUBKEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
```

目录服务需要提供：

- `GET /v1/latest`
- 可接受可选的 `?since=<version>`，并返回 `304` 表示未变化
- 响应头 `x-catalog-signature`，值为对响应原始字节进行 Ed25519 签名后的 Base64
- JSON 内的 `tier` 使用 `live` 或 `monthly`
- 客户端使用 `CATALOG_PUBKEY` 对应的公钥验证响应

示例配置见 `.env.fork.example`。私钥只能保存在目录服务端，不能提交到仓库或放进客户端 `.env`。

注意：仅删除客户端的 Premium 判断不会产生新的模型数据。免费版和实时版的核心差异是目录服务实际返回的内容；要让新模型立即出现，必须自行维护并发布一份实时目录。

## 构建与验证

```bash
npm ci
npm test
npm run build
```

Fork 分支在合并前至少完成上述测试，并在 Docker 环境中实际启动一次。
