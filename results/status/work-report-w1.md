# 工作会话状态（工作会话 1）

> 作用：多会话协同时的**只读入口**——汇总会话（`arena/01a0a3f1-agentarena`）只读本文件 + 各分支的
> `results/status/work-report-w*.md`，不用挨个翻分支历史。每轮 `agent-sync.sh` 之前刷新本文件。
> 相关：`results/sync/last_sync.md`（每轮同步回执）、`results/hardware/latest.md`（本机硬件报告）。

- 角色：**工作会话 1** —— 负责【local-runner 执行协议 + 执行器】
- 工作分支：`arena/01a0a3ee-agentarena`（只在本分支读写；不合并他人分支、不动 runner 核心代码）
- 技能版本：**git-sync v2.4.5**
- 最近更新：2026-09-15（S2 已推送）

## 〇、合并提醒（**给 3d6 与汇总会话**）

`results/status/work-report.md` 在多个会话分支上同名 → 合并必定冲突。按用户决议**一会话一份**：

| 会话 | 文件名 | 状态 |
|---|---|---|
| 工作会话 1（本会话，`arena/01a0a3ee-agentarena`） | `results/status/work-report-w1.md` | ✅ 已改名（本轮） |
| 工作会话 2（`arena/01a0a3d6-agentarena`） | `results/status/work-report-w2.md` | ⏳ **请 3d6 执行**：`git mv results/status/work-report.md results/status/work-report-w2.md` 并更新内部标题 |
| 汇总会话（`arena/01a0a3f1-agentarena`） | `results/status/integration.md` | 不变（按用户要求） |

## 一、任务边界（与工作会话 2 的分工）

| 会话 | 分支 | 负责 |
|---|---|---|
| **工作会话 1（本会话）** | `arena/01a0a3ee-agentarena` | **local-runner 执行协议 + 本机侧执行器**（docs/schema/`code/local-runner.*`），不改 `packages/`、`apps/` |
| 工作会话 2 | `arena/01a0a3d6-agentarena` | 按 `docs/local-runner-brief.md` 把真机 venue 接进 `runBenchmark` / UI（改 `packages/`） |
| 汇总会话 | `arena/01a0a3f1-agentarena` | 集成、合并、真机回归、仲裁跨会话冲突 |

## 二、进度（倒序）

| 轮次 | 提交 | 内容 | 验证状态 |
|---|---|---|---|
| 3 | （见最新提交） | **S2 执行器**：`code/local-runner.mjs`（Node 本体）+ `code/local-runner.ps1`（ASCII 包装）+ `scripts/local-runner-validate.mjs`（零依赖校验器）+ `local_check.ps1` 队列挂钩 + `settings.example.json` + 协议 §10/§11.5 更新；`local-runs` 进 `download_sets`（新增 `runs` 集合，`final` 含 `local-runs/results`）；队列投放首个真机 job `20260915-001-capability-probe` | **沙箱已验**：自检 16/16；假仓库端到端 12 个场景全通过（见下 §三） |
| 2 | `d80cf11` | **S1 协议交付**：`docs/local-runner-protocol.md` + 两份 JSON Schema + `local-runs/` 骨架 + 示例 + DEVLOG 选型记录 | 沙箱已验：ajv(draft2020) 校验通过；3 个反例被拒 |
| 1 | `f4da429` | 安装 git-sync v2.4.5（技能入库 + 根目录 10 个 `.ps1` + gate + `.gitignore` 反排除） | 沙箱已验：干净克隆 gate 三项 OK |

## 三、S2 交付与验收

**新增/修改文件**

| 文件 | 说明 |
|---|---|
| `code/local-runner.mjs` | 执行器本体（Node ≥22，零依赖）：扫队列 → requirements 预检 → 执行 → 摘产物 → 写 `status.json`（原子写）+ `ledger.jsonl` + 归档 job |
| `code/local-runner.ps1` | 薄包装（ASCII-only）：定位 node 并转发参数（`-DrainOnce/-DryRun/-Job/-Force/-SelfTest/-MaxJobs`） |
| `scripts/local-runner-validate.mjs` | 校验器：`--job` / `--status`，镜像 schema 规则；执行器复用它做入队校验（单一事实源，避免漂移） |
| `code/local_check.ps1` | 追加 **1b 队列挂钩**：每轮值守先 `-DrainOnce`；无 job 时 <1s 返回；有 job 失败则判 `failed` |
| `local-runs/settings.example.json` | 本机策略样例（拷到 `local-runs/state/settings.json`，该路径不进 git） |
| `docs/local-runner-protocol.md` | 补 §10（执行器用法/策略/CLI 解析顺序）、§11.5（验收记录）、§12（S1/S2 状态）；修正 `--json` / `--json-events` 互斥的写法 |
| `local-runs/jobs/20260915-001-capability-probe.job.json` | **首个真机 job**（只读巡检） |
| `skills/git-sync/sync.config.json` | `download_sets` 增 `runs`；`final` 增 `local-runs/results`；`all` 增 `local-runs` |

**端到端验收（沙箱内用假 CLI 真跑，非纸面推演）**：正常 benchmark ✅ / 有 agent 失败 ✅ /
超时且进程树被杀干净 ✅ / `requirements` 不满足 fail-fast 未启动 CLI ✅ / 超大产物只进 manifest ✅ /
同 `idempotencyKey` 复用不重跑 ✅ / `kind=command` 未开闸被策略拒绝 ✅ / 坏 JSON → `unsupported-schema` ✅ /
有效租约 → busy 退出 0 ✅ / `--force` → `attempt+1` ✅ / `--dry-run` 零改动 ✅ / 自检 16/16 ✅

**未覆盖（留给真机首跑）**：Windows `taskkill` 分支、`where` 解析出的 `.cmd` shim 调用路径（沙箱是 Linux）。

**设计取舍**：执行器本体改用 Node 而非 PowerShell —— 沙箱无 pwsh（PowerShell 写的东西这里跑不了），
且 PS 5.1 `ConvertTo-Json` 会把单元素数组塌成对象（`artifacts[]`/`scores[]` 会坏）。`.ps1` 保留为 ASCII 包装，入口名不变。

## 四、下一步

1. **真机验证（已投放 job）**：`20260915-001-capability-probe` 在队列里，等值守排空。
   看 `local-runs/results/20260915-001-capability-probe/{status.json,probe.json,console.log}`。
2. **通过后**：据 `probe.json` 的真实情况写第二个 job（benchmark，只挑 `doctor` 里 ready 的 agent，
   显存/环境按实际填 `requirements`），真机跑 **demo 任务包** 打基线。
3. 若 `agentarena` CLI 解析不到 → 需要你在本机 `pnpm build`（或全局安装）后重跑探针；
   若硬件报告缺失 → `.\hardware.ps1 -Deep`。
4. **不做**：不改 `packages/`、`apps/`；不合并其他分支；不 push main。

## 五、你（本机）要做的事

```powershell
cd <你的 clone 目录>          # 本分支：arena/01a0a3ee-agentarena
.\sync.ps1                    # 拉到本轮（含队列里的 probe job 和新的执行器）
.\code\local-runner.ps1 -DryRun     # 可选：先看会跑什么
.\watch.ps1                   # 手动跑一轮值守（或等每 2 分钟的自动轮询）
.\hardware.ps1 -Deep          # 硬件报告（本分支还没有；probe 会顺带报告它缺失）
```

> 值守每轮会依次做：gate（`bash code/check_all.sh`）→ **排空 `local-runs/jobs/`** → 仓库专属检查。
> 队列空时执行器秒退，不影响原有检查节奏。
