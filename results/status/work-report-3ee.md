# 工作会话状态（工作会话 1）

> 作用：多会话协同时的**只读入口**——汇总会话（`arena/01a0a3f1-agentarena`）只读本文件 + 各自分支的
> `results/status/work-report.md`，不用挨个翻分支历史。每轮 `agent-sync.sh` 之前刷新本文件。
> 相关：`results/sync/last_sync.md`（每轮同步回执）、`results/hardware/latest.md`（本机硬件报告）。

- 角色：**工作会话 1** —— 负责【local-runner 执行协议】
- 工作分支：`arena/01a0a3ee-agentarena`（只在本分支读写；不合并他人分支、不动 runner 核心代码）
- 技能版本：**git-sync v2.4.5**
- 最近更新：2026-09-15

## 一、任务边界（与工作会话 2 的分工）

| 会话 | 分支 | 负责 |
|---|---|---|
| **工作会话 1（本会话）** | `arena/01a0a3ee-agentarena` | **local-runner 执行协议**：job JSON 规范、`local-runs/` 目录约定、结果回传格式、沙箱/本机侧检查清单 **（docs + schema + 骨架，不改 `packages/`、`apps/`）** |
| 工作会话 2 | `arena/01a0a3d6-agentarena` | 按 `docs/local-runner-brief.md` 把真机 venue 接进 `runBenchmark` / UI（改 `packages/`） |
| 汇总会话 | `arena/01a0a3f1-agentarena` | 集成分支、合并、真机回归、仲裁跨会话冲突 |

> 合并提醒：本文件在多个会话分支上都叫 `results/status/work-report.md`，合并到集成分支时**必然冲突**。
> 建议集成时改成一会话一份（`work-report-<branch 短名>.md`），或由汇总会话取并集后保留单一入口。

## 二、进度（倒序）

| 轮次 | 提交 | 内容 | 验证状态 |
|---|---|---|---|
| 2 | （见最新提交） | **S1 协议交付**：`docs/local-runner-protocol.md`（v1.0 规范）+ 两份 JSON Schema（job / status）+ `local-runs/` 骨架（README、`.gitignore`、jobs、results）+ 3 个示例 + DEVLOG 选型记录 + 本报告 | **沙箱已验**：2 个 job 示例与 status 示例通过 ajv（draft 2020-12）校验；3 个反例（坏 `jobId`、`kind` 与 `spec` 不匹配、`agents` 为空）被正确拒绝 |
| 1 | `f4da429` | 安装 git-sync v2.4.5：`skills/git-sync/` 入库 + 根目录 10 个 `.ps1` + `code/{check_all.sh,local_check.ps1}`；`.gitignore` 反排除 `skills/*` + `!skills/git-sync/`；`download_sets` 按真实目录 | **沙箱已验**：干净克隆后 `bash code/check_all.sh` 三项全 OK |

## 三、S1 交付物清单

| 文件 | 作用 |
|---|---|
| `docs/local-runner-protocol.md` | 协议正文：目录约定、job 规范、执行协议、退出码映射、回传格式、安全边界、限制、落地路线 |
| `docs/schemas/local-runner-job.schema.json` | job 的权威 JSON Schema（draft 2020-12，含 `kind` 分支） |
| `docs/schemas/local-runner-result.schema.json` | `status.json` 的权威 Schema（状态机 + `failureCategory` 枚举 + 产物清单） |
| `local-runs/README.md` | 骨架入口（给人看的速查） |
| `local-runs/.gitignore` | `state/` 与 `.work/` 不进 git；大压缩包不进 git |
| `local-runs/{jobs,results}/.gitkeep` | 目录就位 |
| `docs/examples/local-runner/*.json` | benchmark job、probe job、status 三个示例（已过校验） |
| `docs/DEVLOG.md` | 记录选型：结构化 job 队列 + `check_cmd` 挂钩（不改 `watch.ps1`） |

## 四、下一步

1. **S2（本会话，待你确认）**：`code/local-runner.ps1`（队列排空器，纯 ASCII，含 `requirements` 预检、租约心跳、产物摘取、`status.json` 原子写）+ `code/local_check.ps1` 追加挂钩 + 依赖零外部库的校验器（Node，`scripts/`）。
2. **真机验证点（需要 `agent-wait --auto-accept`）**：先用 `docs/examples/local-runner/probe-hardware.job.json` 这种只读探针跑通全链路，再跑 benchmark 示例。
3. **等你/汇总会话指认的点**：
   - L3（同 adapter 多 model 变体）是否要在 v1.1 走 `POST /api/run` 路线；
   - `local-runs` 是否要加进 `download_sets`（当前 `final = results + docs`，未含 `local-runs`）；
   - `work-report` 是否按会话拆文件（见 §一 的合并提醒）。
4. **不做**（明确划界）：不改 `packages/`、`apps/`；不合并其他分支；不 push main。

## 五、你（本机）要做的事

```powershell
cd E:\0github\git-sync
git clone -b arena/01a0a3ee-agentarena https://github.com/mqgg5630-cyber/AgentArena.git agentarena-w1
cd agentarena-w1
.\bootstrap.ps1
.\doctor.ps1                 # branch 应为 arena/01a0a3ee-agentarena；skill 行应为 v2.4.5
.\sync.ps1                   # 读本轮回执
.\hardware.ps1 -Deep         # 本分支还没有硬件报告（沙箱侧 agent-hardware.sh 现在会报 no report）
.\watch.ps1 -Register -Interval 2
```

> `local-runs/state/settings.json` 目前不存在 → 执行器（S2）会按最保守默认行事：只允许 `benchmark`/`probe`，`allowRiskyCommands=false`。
> 想放开逃生舱（`kind=command`）时手写这份文件即可，它不进 git。
