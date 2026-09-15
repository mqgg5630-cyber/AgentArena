# AgentArena 架构一页简报（local-runner 前置）

> 读仓日期：2026-09-15。本文只描述现有结构，不改运行时。

## 产品一句话

AgentArena 是 **local-first** 的编码 Agent 评测器：同一仓库、同一任务包、同一套 judge，对本地已安装的 agent CLI 做可回放对比。入口是 `agentarena run` / `agentarena ui`（默认 `127.0.0.1:4320`）。

## 包分层

| 层 | 包 | 职责 |
|---|---|---|
| CLI / UI | `packages/cli`, `apps/web-report` | 参数、doctor、HTTP API、报告页 |
| 编排 | `packages/runner` | `runBenchmark()`：解析 repo → 工作区 → preflight → 并发执行 agent → 落盘 → 汇总 |
| 适配器 | `packages/adapters` | `AgentAdapter`：`id` / `preflight()` / `execute()`；registry 注册 |
| 任务 | `packages/taskpacks` | YAML/JSON 任务包、setup / judges / teardown |
| 评判 | `packages/judges` | command / file-exists / test-result 等；命令双层 allowlist |
| 痕迹 / 报告 | `packages/trace`, `packages/report` | JSONL trace、HTML/MD/badge |
| 共享 | `packages/core` | 类型、env 过滤、sandbox、run-state、打分权重 |

工作区：`pnpm` monorepo（Node ≥ 22）。可选 Docker 壳见 `docs/runner-docker.md`（可复现工具链，**不是**安全沙箱）。

## 一次 run 的数据流

```
CLI/UI  --BenchmarkOptions-->  runBenchmark()
  1. resolveAndValidateRepo + load task pack
  2. prepareWorkspace  (.agentarena/runs/<runId>/)
  3. preflightAdapters (ready / missing / blocked / unverified)
  4. 每 agent：隔离 workspace + adapter.execute + judges
  5. 每 agent 立刻写 agents/<variantId>/result.json（可 resume）
  6. summary.json + report.html + decision-report.md
```

并发由 `mapWithConcurrency` 控制；Windows 上 adapter 用 `taskkill /F /T` 杀进程树。

## 适配器 vs runner

- **Adapter**：如何调用某个 CLI（prompt、cwd、token、preflight）。
- **Runner**：何时调、在哪份拷贝上调、如何并发、如何打分与落盘。
- **Judge**：任务包声明的验收，与 agent 实现解耦。
- **Docker runner**：把「执行壳」固定到镜像；本机 GPU / conda **不会**自动进容器。

## 安全边界（ADR-003）

Judge 走 SAFE_COMMANDS；默认禁 `bash`/`sh`、eval 风格、risky 网络命令。Agent 环境是 allowlist，不继承任意本机密钥。UI 仅 loopback + token。

## 与 git-sync 的缺口

Arena 沙箱 **没有** 用户的 GTX 1650、22 个 conda、Windows PATH 上的 Codex/Claude。现有 Docker runner 也没有这些。  
git-sync 的 `agent-wait.sh --request` → 本机 `watch.ps1` → `code/local_check.ps1` 已经能把「检查」跑在真机上。  
**local-runner** 要把同一握手循环升级成「真机执行 benchmark、结果经 git 回传」，而不是在沙箱里假装有 GPU。详见 `.skills/local-runner/SKILL.md`。
