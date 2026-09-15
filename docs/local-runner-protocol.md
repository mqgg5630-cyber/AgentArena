# local-runner 执行协议（v1.0）

> 状态：**规范（设计稿）**，由【工作会话 1】维护（分支 `arena/01a0a3ee-agentarena`）。
> 本文**只定义协议**：job JSON 规范、`local-runs/` 产物目录约定、结果回传格式。
> 不涉及 `packages/`、`apps/` 下的实现代码——把协议接进 `runBenchmark` / UI 是后续阶段（见 §12）。
>
> 前置阅读：`docs/local-runner-brief.md`（为什么需要真机 venue，见分支 `arena/01a0a356-agentarena`）、
> `skills/git-sync/templates/local-runner.md`（git-sync 自带的"本机即 Runner"配方）。
> 相关：`docs/http-api.md`（`POST /api/run`）、`.skills/benchmark-run/SKILL.md`（`agentarena run` 用法）。

---

## 0. 一句话

**沙箱只提议，本机执行，git 回传**：Arena 会话把要跑的活写成一个 `job JSON` 提交到 `local-runs/jobs/`，
你本机的值守（`watch.ps1` → `code/local_check.ps1` → 执行器）按队列执行 `agentarena run`，
把**判定**写回 `local-runs/results/<jobId>/status.json` 并推送；沙箱读结果决定收尾或修复。

```
Arena 沙箱（提议）                          用户本机（执行，唯一有 GPU/conda/CLI agent 的地方）
 1. 写 local-runs/jobs/<jobId>.job.json
 2. agent-sync.sh "feat(job): <jobId>"      ──push──>
 3. agent-wait.sh --request "<jobId>"       ──push──>   4. watch.ps1 轮询发现请求
                                                         5. 执行器排空队列：requirements 校验 → agentarena run
                                                         6. 写 results/<jobId>/{status.json,artifacts.json,...}
                                                         7. handshake local_state=passed/failed ──push──>
 8. agent-check.sh --read / --accept        <──pull──
 9. 写 results/<jobId>/ack.json（结论+下一步）
```

**设计原则**

| # | 原则 | 含义 |
|---|---|---|
| P1 | **本机主权** | 本机可以拒绝任何 job（policy/timeout/忙），沙箱不能强推。拒绝也是**结构化结果**（`state=skipped`, `error.code=policy-rejected`），不是静默失败。 |
| P2 | **不静默降级** | `requirements` 不满足（例如要 CUDA 但本机 torch 是 cpu 版）→ 立刻失败并标 `failureCategory=environment`，**绝不**偷偷换环境/换设备再报"成功"。评测公平性依赖这条。 |
| P3 | **零侵入** | 协议只通过 `check_cmd` 挂钩，不改 `watch.ps1`、不改 `packages/runner`；沙箱侧不需要新权限。 |
| P4 | **可审计、可重放** | job 文件是契约（进 git），状态机与判定全落盘（`status.json` + `ledger.jsonl`），同一 job 可重跑且结果可追溯。 |
| P5 | **小文件进 git，大产物留在本机** | 回传区只带判定与摘要（默认 ≤5 MB/文件）；大产物记清单 + 本机路径，用 `pack.ps1`/网盘流转。 |

---

## 1. 目录约定：`local-runs/`

```
local-runs/
├─ README.md                     # 入口：指向本规范
├─ ledger.jsonl                  # ★ 追加式总台账，一行一事件（进 git）
├─ jobs/                         # 队列（进 git）
│   ├─ <jobId>.job.json          #   待执行（*.job.json 才被识别）
│   └─ archive/<jobId>.job.json  #   已收尾的原件（进 git，审计/重放用）
├─ results/<jobId>/              # ★ 回传区（进 git；见 §6 的产物清单）
│   ├─ status.json               #   机器可读判定（本规范的核心）
│   ├─ artifacts.json            #   产物清单（path/bytes/sha256/committed）
│   ├─ console.log               #   人类可读日志（默认截尾 2000 行）
│   ├─ summary.json              #   agentarena run 的输出摘要（kind=benchmark）
│   ├─ report.html               #   报告页（可选，受 maxFileMb 限制）
│   ├─ decision-report.md        #   决策报告（可选）
│   ├─ results.csv               #   CSV 导出（可选）
│   └─ ack.json                  #   沙箱侧回执（由 Arena 会话写，见 §7.4）
├─ state/                        # 运行时状态（**不进 git**）
│   ├─ lease.json                #   当前租约（谁在跑、心跳、过期时间）
│   └─ settings.json             #   本机侧策略（本机私有，可手改）
└─ .work/<jobId>/                # 执行现场（**不进 git**）：run 原始输出、工作区、临时文件
```

要点：

* **`jobs/` 只认 `*.job.json`**。示例/草稿请用 `*.example.json` 之类后缀，避免被当队列执行。
* **`results/<jobId>/` 一旦产生就是终态记录**，任何人不得手改 `status.json`（要重跑就 `attempt+1` 由执行器重写；要补充结论就写 `ack.json`）。
* `state/` 与 `.work/` 由 `local-runs/.gitignore` 排除；**其余目录默认全部进 git**。
* `jobId` 全局唯一（同仓同时只允许一份）；同名冲突 → 执行器拒绝（`error.code=duplicate-job-id`）。
* 多机场景：v1 假定**单台本机**。多机时每台一个 clone + `GIT_SYNC_PROFILE`，`status.json.host.name` 区分来源（见 §11 限制）。

### 1.1 `jobId` 命名

```
<YYYYMMDD>-<NNN>-<slug>        例：20260915-001-gtx1650-smoke
^[0-9]{8}-[0-9]{3}-[a-z0-9][a-z0-9-]{2,39}$
```

* `YYYYMMDD`：**本地日期**（写下 job 的日期，便于对账）；`NNN`：当天序号，从 `001` 起（撞号就 +1）；
* `slug`：小写字母/数字/连字符，描述任务（`cuda-torch-probe`、`codex-vs-claude-demo`）。

---

## 2. job JSON 规范（v1.0）

权威 JSON Schema：`docs/schemas/local-runner-job.schema.json`（draft 2020-12）。
字段命名与 AgentArena 的 TS 类型保持一致（camelCase），便于 1:1 映射到 `UiRunPayload` / CLI flags。

### 2.1 顶层字段

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `schemaVersion` | ✅ | `"1.0"` | 协议版本；执行器不认识的**更高**小版本可拒绝（`unsupported-schema`） |
| `jobId` | ✅ | string | §1.1 命名规则 |
| `createdAt` | ✅ | string | ISO 8601 带时区（沙箱 UTC 即可） |
| `kind` | ✅ | `benchmark` \| `probe` \| `command` | 决定 `spec` 的形状与默认策略（见 §3） |
| `requestedBy` | ✅ | object | `{ "branch": "arena/...", "session": "arena-01a0a3ee" }`，审计用 |
| `reason` | ✅ | string | 一句话说明**为什么**要跑这个（进 ledger，方便你事后翻账） |
| `spec` | ✅ | object | 按 `kind` 取不同形状（§3） |
| `requirements` | ⬜ | object | 前置条件，不满足即 fail-fast（§4） |
| `timeoutSeconds` | ⬜ | integer | 默认：benchmark `3600`、command `600`、probe `120`；执行器上限 `7200` |
| `priority` | ⬜ | integer 0–9 | 默认 `5`，**小者先跑**；只影响同一轮排空顺序 |
| `dependsOn` | ⬜ | string[] | 依赖的 `jobId` 列表；未满足 → `state=skipped`, `error.code=dependency-unmet` |
| `idempotencyKey` | ⬜ | string | 重试幂等键：若已有同 key 的终态结果，执行器直接复用、不再执行 |
| `artifacts` | ⬜ | object | 回传策略（§6.2） |
| `notes` | ⬜ | string | 给人看的补充说明（可多行） |
| `x-*` | ⬜ | any | 扩展位：未知 `x-` 前缀字段一律忽略（保证向后兼容） |

### 2.2 `spec` 的三种形状（§3 详述）

```jsonc
// kind = "benchmark"
"spec": {
  "repo": ".",                                  // 仓库内相对路径（不得逃出仓库根）
  "task": "examples/taskpacks/demo-repo-health.json",
  "agents": [                                   // 与 UiRunPayload.agents[] 同形
    { "baseAgentId": "demo-fast" },
    { "baseAgentId": "codex", "config": { "model": "gpt-5.4", "reasoningEffort": "high" } }
  ],
  "options": {                                  // 全部可选项，逐一映射 CLI flags（§5.2）
    "maxConcurrency": 1, "scoreMode": "balanced", "tokenBudget": 200000,
    "probeAuth": true, "agentTimeoutMs": 900000, "repeat": 1, "locale": "zh-CN"
  }
}

// kind = "probe"   —— 只读探测（默认安全，允许的命令见 §3.2）
"spec": { "probe": "hardware" }                 // hardware | doctor | nvidia-smi | conda-env-list | agentarena-version

// kind = "command" —— 逃生舱，默认被本机策略拒绝（§3.3）
"spec": {
  "shell": "powershell",
  "command": "python", "args": ["-c", "import torch;print(torch.cuda.is_available())"],
  "cwd": "code",
  "allowRisky": true                            // 必须与本机 settings.json 同时放开
}
```

### 2.3 最小可用 job（可直接复制）

```json
{
  "schemaVersion": "1.0",
  "jobId": "20260915-001-demo-smoke",
  "createdAt": "2026-09-15T07:40:00Z",
  "kind": "benchmark",
  "requestedBy": { "branch": "arena/01a0a3ee-agentarena", "session": "arena-01a0a3ee" },
  "reason": "验证 demo 任务包在本机可跑通，作为 local-runner 首个端到端用例",
  "spec": {
    "repo": ".",
    "task": "examples/taskpacks/demo-repo-health.json",
    "agents": [{ "baseAgentId": "demo-fast" }, { "baseAgentId": "demo-thorough" }],
    "options": { "maxConcurrency": 1, "locale": "zh-CN" }
  },
  "timeoutSeconds": 900
}
```

---

## 3. `kind` 与安全策略

`kind` 决定**默认放行度**。本机侧策略入口是 `local-runs/state/settings.json`（不进 git，主权在本机）：

```json
{
  "maxJobsPerDrain": 1,
  "maxParallelAgents": 2,
  "allowedKinds": ["benchmark", "probe"],
  "allowRiskyCommands": false,
  "allowedProbes": ["hardware", "doctor", "nvidia-smi", "conda-env-list", "agentarena-version"],
  "artifactPolicy": { "defaultMode": "summary", "maxFileMb": 5, "maxTotalMb": 20 }
}
```

缺省文件不存在时，执行器按**最保守**默认值行事（等价于上面这份，`allowRiskyCommands: false`）。

### 3.1 `benchmark`（主用途）

跑 `agentarena run`。`spec.agents` 至少 1 个；`options` 全部可选。

### 3.2 `probe`（只读，允许）

| `probe` 值 | 本机执行 | 回传要点 |
|---|---|---|
| `hardware` | 重跑 `hardware.ps1`（或读 `results/hardware/latest.json`） | GPU/conda 事实 + `generated` 时间 |
| `doctor` | `agentarena doctor --agents <列表> --probe-auth` | 每个 agent 的 `status`（ready/missing/blocked/unverified） |
| `nvidia-smi` | `nvidia-smi` | 驱动/CUDA/显存快照 |
| `conda-env-list` | `conda env list` | 环境清单（判断该用哪个 env） |
| `agentarena-version` | `agentarena --version` + `git rev-parse HEAD` | 版本 + 提交锚点 |
| `capability` | 复合巡检（**不改文件**）：CLI 解析结果、node/pnpm/git、GPU、conda 环境清单、磁盘/内存、硬件报告新鲜度 | `probe.json`；`checks[]` 逐项 ok/detail。**排长任务前先跑它**，一轮就能确定"这机器现在能跑什么" |

探测类 job 的产物小、价值高：**沙箱在排长任务前先探一次**，比跑一半才发现"本机没有 codex"便宜得多。

### 3.3 `command`（逃生舱，默认拒绝）

理由：`docs/adr`（ADR-003）里 judge 走 SAFE_COMMANDS allowlist；沙箱不应绕过它在本机执行任意命令。
双层开关：job 的 `spec.allowRisky: true` **且** 本机 `settings.json.allowRiskyCommands: true`，缺一即
`state=skipped`、`error.code=policy-rejected`。`reason` 必填（审计）。执行器仍会拒绝明显危险的形式
（`rm -rf`、`Format-`、管道到 `iex`、下载并执行等），并在 `status.json.error.message` 里说明。

---

## 4. `requirements`：前置条件（fail-fast）

```jsonc
"requirements": {
  "gpu": { "required": true, "minVramGb": 4, "minCudaDriver": "12.0" },
  "condaEnv": "spyder-runtime",           // 存在的环境名（用 conda env list 校验）
  "python": ">=3.10",
  "tools": ["codex", "claude-code"],      // 必须在 PATH 上（对应 adapter preflight）
  "minFreeDiskGb": 5,
  "minFreeRamGb": 2
}
```

判定依据（同源，避免两套事实）：

1. `results/hardware/latest.json`（由 `hardware.ps1 -Deep` 生成；沙箱侧用 `agent-hardware.sh` 读同一份）；
2. 执行器**执行前**的实时复核（PATH 探测、`conda env list`、`nvidia-smi`）。

结果写进 `status.json.requirements`：

```jsonc
"requirements": {
  "declared": { /* 原样回抄 job 的 requirements */ },
  "actual":   { "gpu": [{"name":"NVIDIA GeForce GTX 1650","vramGb":4,"cudaDriver":"12.9"}],
                "condaEnv": "spyder-runtime", "tools": {"codex":"1.2.3"},
                "hardwareGenerated": "2026-09-15 12:47:25" },
  "satisfied": false,
  "unmet": ["gpu.minVramGb: 需要 >=8GB, 实际 4GB", "condaEnv: spyder-runtime 不存在"]
}
```

* `satisfied=false` → **不执行**，`state=failed`、`failureCategory=environment`、`error.code=requirements-unmet`。
* 硬件报告过期（>30 天，`agent-hardware.sh` 同款阈值）**不阻断**，但在 `status.json.notes` 里标注，并建议重跑 `.\hardware.ps1 -Deep`。
* 已知事实（本机，2026-09-15 报告）：GTX 1650 / 4 GB / CUDA 驱动 12.9；conda 25.3.1、mamba 2.0.5；
  **现有环境里没有带 CUDA 的 torch**（`NTxPred2` 是 `2.13.0+cpu`，其余未装 torch）。
  ⇒ 依赖 CUDA 的 job 现在会走 `requirements-unmet` 分支——这是**正确行为**，不要为了"跑起来"去掉 `requirements`。

---

## 5. 执行协议（本机侧）

### 5.1 排空顺序与并发

1. 扫描 `local-runs/jobs/*.job.json`（忽略 `archive/`）；
2. 过滤：`dependsOn` 未满足、`idempotencyKey` 已有终态、`state/lease.json` 未过期的 job 跳过；
3. 排序：`priority` ↑ → `createdAt` ↑ → `jobId` ↑；
4. 本轮执行 **`settings.maxJobsPerDrain` 个**（默认 1）。4 核 / 16 GB 的机器上，一个 benchmark 已足够吃满，串行是特性不是缺陷；
5. 单个 job 内并发由 `options.maxConcurrency` 控制（默认 1）。

**租约**：`state/lease.json` = `{ jobId, host, pid, startedAt, heartbeatAt, expiresAt }`，心跳 60 s 一次，
`expiresAt` 默认 = `startedAt + 30 min`（与 `watch.ps1` 的文件锁过期语义一致）。租约未过期时新的一轮
**只做体检不抢活**；过期（进程被杀了）则下一轮自动接管并把上一轮的 `status.json` 标 `state=failed`、
`error.code=lease-expired`。

### 5.2 `benchmark` job → 命令映射（与真实 CLI 对齐）

| job 字段 | CLI | 备注 |
|---|---|---|
| `spec.repo` | `--repo <path>` | 仓库内相对路径，执行器解析为绝对路径（拒绝 `..` 逃逸） |
| `spec.task` | `--task <path>` | 同上 |
| `spec.agents[].baseAgentId` | `--agents a,b,c` | CLI 只认基础 id（`packages/cli/src/args.ts`） |
| `spec.agents[].config.model`（单变体/适配器） | `--<adapter>-model <m>` | 如 `--codex-model`；每个 adapter 一个 flag |
| `spec.agents[].config.reasoningEffort` | `--codex-reasoning <v>` | 目前仅 codex 有该 flag |
| `spec.agents[].config.providerProfileId` | `--claude-profile <id>` | 目前仅 claude 有该 flag |
| `options.maxConcurrency` | `--max-concurrency` | |
| `options.scoreMode` | `--score-mode` | `practical`/`balanced`/… |
| `options.tokenBudget` | `--token-budget` | |
| `options.probeAuth` | `--probe-auth` | |
| `options.agentTimeoutMs` | `--agent-timeout`（毫秒） | |
| `options.repeat` | `--repeat` | >1 时 `--json` 输出为数组 |
| `options.resume` | `--resume <runDir>` | 断点续跑（同 job 重试时可用） |
| `options.locale` | `--locale en\|zh-CN` | |
| —（执行器固定追加） | `--output local-runs/.work/<jobId>` | run 落到 `.work/`（不进 git），产物再按 §6 摘取 |
| —（执行器固定追加，二选一） | `--json`（默认）**或** `--json-events`（`options.jsonEvents: true` 时） | **两者互斥**（`args.ts` 会直接报错）。两种模式**最后一行都是可解析的 JSON 摘要**：`--json` 打一个对象（`--repeat >1` 时为 `{repeat, runs}`），`--json-events` 打 `{"type":"summary","runs":[...]}`（`packages/cli/src/commands/run.ts`）。`jsonEvents` 打开时同时把 NDJSON 事件流写入 `console.ndjson`（失败时保留，用来定位卡在哪一步） |

**`variantId` 是派生值，不要在 job 里写**：`createAgentSelection()` 按
`baseAgentId[-profile][-model][-reasoning]` 生成（`packages/core/src/utils.ts`）。job 只声明
`baseAgentId + config`，回传的 `status.json.verdict.scores[].variantId` 用实际派生值，两边才对得上。

**已知局限（v1）**：CLI 路径下"同一 adapter 的多个变体（不同 model 并发对比）"无法表达完整。
需要这种用法时走 **v1.1 路线**：本机起 `agentarena ui`（loopback + token），执行器改调
`POST /api/run`，body 直接是 `UiRunPayload` ——`spec.agents[]` 与它同形，映射是恒等的（见 `docs/http-api.md`）。

### 5.3 退出码与状态映射

| 本机执行器观察 | `status.json.state` | `verdict.outcome` | `failureCategory` |
|---|---|---|---|
| 退出码 0 且所有 agent `status=success` | `succeeded` | `pass` | — |
| 退出码 0 但有 agent 非 success | `succeeded` | `fail` | 取自 `result.failureCategory` |
| 退出码 1（`agentarena run` 的"有失败/出错"约定） | `failed` | `fail` | 逐 agent 汇总，取最关键的一个 |
| 退出码其它非零（引擎/参数错） | `failed` | `error` | `validation` 或 `unknown`，`error.code=engine-error` |
| 超时被本机 kill（进程树 `taskkill /F /T`） | `timed_out` | `inconclusive` | `cancelled` |
| `requirements.satisfied=false` | `failed` | `inconclusive` | `environment`，`error.code=requirements-unmet` |
| `state/cancel-<jobId>` 出现 / 本机主动取消 | `cancelled` | `inconclusive` | `cancelled` |
| 策略拒绝 / 版本不支持 / 依赖未满足 | `skipped` | `inconclusive` | — ，`error.code=policy-rejected` / `unsupported-schema` / `dependency-unmet` |

`failureCategory` 取值沿用 AgentArena 既有枚举：`task-pack | environment | agent | model | validation | cancelled | unknown`。

---

## 6. 结果回传格式

### 6.1 `status.json`（本规范核心，机器可读）

权威 Schema：`docs/schemas/local-runner-result.schema.json`。示例：`docs/examples/local-runner/status.example.json`。

```jsonc
{
  "schemaVersion": "1.0",
  "jobId": "20260915-001-demo-smoke",
  "state": "succeeded",                    // queued|leased|running|succeeded|failed|cancelled|timed_out|skipped
  "attempt": 1,                            // 重跑 +1
  "idempotencyKey": "demo-smoke-v1",       // 从 job 回抄（可空）
  "kind": "benchmark",
  "requestedBy": { "branch": "arena/01a0a3ee-agentarena", "session": "arena-01a0a3ee" },
  "host": { "name": "LAPTOP-R77M5D6M", "os": "Windows 11 26200", "powershell": "5.1.26100.8875" },
  "timing": { "queuedAt": "...", "startedAt": "...", "finishedAt": "...",
              "durationMs": 412345, "timeoutSeconds": 900 },

  "execution": {
    "command": "agentarena run --repo . --task examples/taskpacks/demo-repo-health.json --agents demo-fast,demo-thorough --output local-runs/.work/20260915-001-demo-smoke --json",
    "cwd": "E:\\0github\\git-sync\\AgentArena-01a0a3ee",
    "exitCode": 0,
    "runId": "2026-09-15T07-41-02-118Z-9f3c1a7b",     // = summary.json 的 runId
    "stdoutLastLine": "{...}"                           // --json 的最后一行，便于快速取摘要
  },

  "requirements": { "declared": {}, "actual": {}, "satisfied": true, "unmet": [] },
  "envActual": {
    "gpu": [{ "name": "NVIDIA GeForce GTX 1650", "vramGb": 4, "driver": "576.02", "cudaDriver": "12.9" }],
    "conda": { "conda": "conda 25.3.1", "mamba": "2.0.5", "activeEnv": "base" },
    "hardwareReport": "results/hardware/latest.json",
    "hardwareGenerated": "2026-09-15 12:47:25",
    "git": { "branch": "arena/01a0a3ee-agentarena", "commit": "f4da429" }
  },

  "artifacts": [                            // 与 artifacts.json 同源
    { "path": "summary.json", "role": "summary", "bytes": 41233, "sha256": "…", "committed": true },
    { "path": "report.html",  "role": "report",  "bytes": 918234, "sha256": "…", "committed": true },
    { "path": "console.log",  "role": "log",     "bytes": 51200,  "sha256": "…", "committed": true },
    { "path": "run.zip",      "role": "bundle",  "bytes": 73400320, "sha256": "…",
      "committed": false, "localPath": "E:\\…\\.work\\20260915-001-demo-smoke\\run.zip",
      "reason": "exceeds maxFileMb (5)" }
  ],

  "verdict": {
    "outcome": "pass",                     // pass|fail|inconclusive|error
    "failureCategory": null,
    "totals": { "agentCount": 2, "successCount": 2, "tokens": 18432, "costUsd": 0.14 },
    "scores": [                            // 逐变体，variantId 为实际派生值
      { "variantId": "demo-fast", "status": "success", "compositeScore": 0.83,
        "judges": { "passed": 5, "total": 5 }, "durationMs": 120000 }
    ],
    "failedJudges": [                      // 只列失败的（含 critical 标记）
      { "variantId": "demo-thorough", "judgeId": "tests", "label": "pnpm test", "critical": true,
        "exitCode": 1, "note": "2 failing" }
    ],
    "notes": ["硬件报告距今 0 天"]
  },

  "error": null,                           // 非终态成功时为 { "code": "...", "message": "..." }
  "logTail": ["[agentarena] …", "…"],      // 最后 50 行，方便沙箱在不拉大文件时定位
  "links": { "report": "results/<jobId>/report.html", "runSummary": "…/summary.json" }
}
```

**状态机**

```
queued ──lease──> leased ──start──> running ──┬─> succeeded
   │                                          ├─> failed
   │                                          ├─> timed_out
   └──────────(策略/依赖/幂等)────────────────>└─> cancelled
                                              └─> skipped
```

非终态（`queued/leased/running`）也会落盘，方便本机被中断后沙箱能看出"卡在哪一步"；
终态**只写一次**（原子替换：写 `status.json.tmp` → `Move-Item -Force`）。
`attempts[]`（可选）保留每轮尝试的 `{attempt, state, startedAt, finishedAt, exitCode, error}` 摘要。

### 6.2 `artifacts.json` 与回传策略

```jsonc
{
  "schemaVersion": "1.0",
  "jobId": "20260915-001-demo-smoke",
  "mode": "summary",                       // manifest-only | summary（默认） | full
  "policy": { "maxFileMb": 5, "maxTotalMb": 20, "hardMaxFileMb": 25, "hardMaxTotalMb": 100 },
  "artifacts": [ /* 同 status.json.artifacts */ ],
  "skipped": [ { "path": "agents/demo-fast/trace.jsonl", "bytes": 81234567, "reason": "exceeds maxFileMb" } ]
}
```

* `mode` 语义：
  * `manifest-only`：只回 `status.json` + `artifacts.json` + `console.log`（尾 200 行）——**最小**，适合长任务或产物很大时；
  * `summary`（默认）：+ `summary.json`、`report.html`、`decision-report.md`、`results.csv`、`trend.md`（存在才带）；
  * `full`：再带 `agents/*/result.json`、`summary.json` 全量、trace 摘要（仍受 `maxFileMb` 限制）。
* `local-runs/.gitignore` 用负例 `!console.log` / `!console.ndjson` 把回传日志救回来（仓库根 `.gitignore` 有通用 `*.log`，否则会被静默吞掉）；验证只看 `git add -A -n` 的真实结果。
* 固定回传：`status.json`、`artifacts.json`、`console.log`（头部含 jobId/命令/退出码/耗时，默认尾部 2000 行）；
  `probe` job 另带 `probe.json`；`jsonEvents` 打开且任务失败时带 `console.ndjson`。
* **硬上限**：单文件 25 MB、单 job 100 MB。超限一律 `committed:false` + 本机路径（`pack.ps1` 打包或网盘流转），
  避免触发 `doctor.ps1` 的 >50 MB tracked 警告与仓库膨胀。
* 大产物登记：`role=bundle` 的条目必须带 `localPath`，沙箱据此告诉你"要拿就用 `.\pack.ps1` / `.\download.ps1 -Set final`"。

### 6.3 `ledger.jsonl`（追加式台账）

一行一个 JSON，**只追加不修改**，用于跨会话对账（汇总会话的主要读取口）：

```json
{"ts":"2026-09-15T07:41:00Z","jobId":"20260915-001-demo-smoke","event":"queued","by":"arena-01a0a3ee"}
{"ts":"2026-09-15T07:42:11Z","jobId":"20260915-001-demo-smoke","event":"started","host":"LAPTOP-R77M5D6M","attempt":1}
{"ts":"2026-09-15T07:49:03Z","jobId":"20260915-001-demo-smoke","event":"finished","state":"succeeded","outcome":"pass","durationMs":412345}
{"ts":"2026-09-15T07:49:05Z","jobId":"20260915-001-demo-smoke","event":"pushed","commit":"abc1234"}
```

`event` 取值：`queued | leased | started | finished | rejected`，**由本机执行器独占写入**（沙箱不要写这个文件，避免双写）。
`pushed`（读到的 commit）与 `acked` 由沙箱侧按需追加（可选）；判定细节一律以 `status.json` 为准。
**收尾归档**：执行器在写终态后把 job 原件移到 `jobs/archive/`（幂等复用与策略拒绝同样归档），队列里不会留残件。

### 6.4 `ack.json`（沙箱侧回执）

**只有 Arena 会话写这个文件**（执行器不碰），用于闭环与交接：

```jsonc
{
  "schemaVersion": "1.0",
  "jobId": "20260915-001-demo-smoke",
  "ackedBy": { "branch": "arena/01a0a3ee-agentarena", "session": "arena-01a0a3ee" },
  "ackedAt": "2026-09-15T07:55:00Z",
  "verdictRead": "pass",
  "decision": "accepted",              // accepted | retry | escalated | abandoned
  "nextStep": "把 demo 双 agent 基线写进 results/status/work-report.md",
  "followUpJobs": ["20260915-002-codex-real-smoke"]
}
```

`decision=escalated` 表示"结果需要你或汇总会话定夺（例如机器不够、需要装 CUDA torch）"。

---

## 7. 与 git-sync 的接线（P3 零侵入）

| 环节 | 用什么 | 说明 |
|---|---|---|
| 派活 | `bash skills/git-sync/scripts/agent-sync.sh "feat(job): <jobId>"` 然后 `agent-wait.sh --request "<jobId>" --auto-accept` | **必须先推 job 文件再 request**，否则本机拉不到队列 |
| 触发本机 | `check_cmd`（`skills/git-sync/sync.config.json`） | 默认 `code/local_check.ps1`；阶段 2 在其中追加一行调用执行器（`code/local-runner.ps1 -DrainOnce`） |
| 回传 | `watch.ps1` 跑完自动 sync/push | 产物目录是 git 跟踪区，天然被 `git add -A` 带回 |
| 判定 | 现有 `results/status/handshake.json` | 执行器不写 handshake——`local_check.ps1` 的退出码就是判定（`local_state=passed/failed`）。**协议不改 watch.ps1** |
| 收尾 | `agent-check.sh --read` / `--accept` | 通过即 `--accept`，循环静默待命 |
| 大产物 | `pack.ps1` / `download.ps1 -Set final` | `local-runs/results/` 已在 `download_sets.all` 覆盖范围内（`results` 之外，需要时把 `local-runs` 加进集合） |

**单槽 handshake vs 多 job 队列**：handshake 是"你有活了"的**门铃**，队列是"活是什么"的**内容**。
一次 request 可以排空多个 job（`maxJobsPerDrain`），门铃只按一次——这也是为什么 job 必须结构化落盘，
而不是把参数写进 request 的自然语言 note 里。

`local_check.ps1` 挂钩示意（阶段 2 落地，本机侧文件，**不是** runner 核心代码）：

```powershell
# 2d. local-runner 队列：有 *.job.json 就排空一轮；无 job 时 <1s 返回，不影响普通检查
if (Test-Path '.\code\local-runner.ps1') {
    pwsh -NoProfile -File .\code\local-runner.ps1 -DrainOnce
    if ($LASTEXITCODE -ne 0) { Write-Output '[FAIL] local-runner: job failed'; $fail = 1 }
}
```

---

## 8. 完整时序（一个 benchmark job 的一生）

| # | 谁 | 动作 | 产物 |
|---|---|---|---|
| 1 | 沙箱 | 读 `agent-hardware.sh` 选环境/设备；写 job | `local-runs/jobs/<jobId>.job.json` |
| 2 | 沙箱 | `agent-sync.sh "feat(job): <jobId>"` | commit + push + 回执 |
| 3 | 沙箱 | `agent-wait.sh --request "<jobId>" --auto-accept` | `handshake.json: awaiting_check/pending` |
| 4 | 本机 | `watch.ps1` 轮询发现 → `sync.ps1` 拉取 | 本地出现 job 文件 |
| 5 | 本机 | `local_check.ps1` → 执行器：`requirements` 校验 | `status.json`（`running`）+ `lease.json` |
| 6 | 本机 | `agentarena run … --json`（产物落 `.work/<jobId>`） | `.work/<jobId>/**` |
| 7 | 本机 | 摘取产物 + 写判定 | `results/<jobId>/{status.json,artifacts.json,console.log,…}` + `ledger.jsonl` |
| 8 | 本机 | archive job 原件；`watch.ps1` push | `jobs/archive/<jobId>.job.json` |
| 9 | 沙箱 | `agent-check.sh --read`（或 agent-wait 自动） | exit 0/2/3 |
| 10 | 沙箱 | 读 `status.json` 决策；写 `ack.json`；继续工作 | `results/<jobId>/ack.json` |
| 11 | 沙箱 | 满意 → `agent-check.sh --accept`（或 agent-wait `--auto-accept` 已做） | `handshake.json: accepted` |

失败分支：7 写 `state=failed` → 8 push → 9 exit 2 → 沙箱按 `failureCategory` 修（`environment` 就改 `requirements` 或请你换环境；
`agent`/`model` 就改任务包或换 agent）→ 同一个 `jobId` 或新 `jobId`（`attempt+1`）再来一轮。

---

## 9. 沙箱侧检查清单（写 job 前逐条过）

1. `bash skills/git-sync/scripts/agent-hardware.sh` 看过本机硬件报告了吗？（GPU 显存 / 哪个 env 有 CUDA torch）
2. `requirements` 写全了吗？**不要**写下本机满足不了的条件再指望它"跑起来就报错"——预检会拦住，但白等一轮。
3. `repo`/`task` 路径都在仓库内、且**相对路径**？
4. `timeoutSeconds` 与任务实际耗时匹配？（benchmark 默认 3600，探针 120）
5. `artifacts.mode` 选对了吗？（长任务/大产物 → `manifest-only`，只带判定最省 git）
6. `agents[].baseAgentId` 都是 `agentarena list-adapters` 里有、本机 `doctor` 里 ready 的吗？
7. 需要 install/pip/conda 操作？那不属于 job（本机主权）——写进 `reason`/`notes` **请你手动执行**，不要用 `command` 绕过。

## 10. 执行器（S2 已落地）

### 10.1 组成与为什么是 Node

| 文件 | 角色 |
|---|---|
| `code/local-runner.mjs` | **执行器本体**（Node ≥22，零依赖）：扫队列 → requirements 预检 → 执行 → 摘产物 → 写判定 |
| `code/local-runner.ps1` | **薄包装**（纯 ASCII）：定位 node 并转发参数，保留文档里的入口名 |
| `scripts/local-runner-validate.mjs` | **校验器**（零依赖，镜像两份 JSON Schema）：`--job` / `--status`，沙箱侧推之前先自查 |
| `code/local_check.sh` | **当前 check_cmd**（原生链）：排空队列 → 跑 gate。**不经 PowerShell**，见 §10.3.2 |
| `code/local_check.ps1` | 旧挂钩（保留作参考；本机实测 watcher 的 `powershell -File` 链空转，不再作为入口） |
| `code/drain-and-push.ps1` | **人工兜底一条命令**：排空队列 + 提交 + 推送（不等值守） |
| `code/diagnose-watcher.ps1` | **取证一条命令**：写 `results/status/diagnose-watcher.txt`（HEAD/stash/有效 check_cmd/工具可用性/队列/drain 输出/`Invoke-Expression` 复现）——"日志说 passed 但什么都没发生"时先跑它 |
| `local-runs/drain-last.json` | **执行器每轮都写**（沙箱内被护栏拦下时也写，reason 标 `sandbox-environment`）的结构化证据（`ran`/`reason`/`jobsSeen`/`results`/`exitCode`）；队列没被消费时靠它区分"挂钩没跑"与"跑了但没活" |
| `results/status/local-runner-drain.txt` | **挂钩自己写**的原始记录（时间/主机/CWD/node 路径/runner 是否存在/队列内容/exit/完整 stdout）——因为 `watch.ps1` 的输出捕获在个别机器上会返回空日志 |

执行器本体用 Node 而不是 PowerShell，是**可验证性**驱动的选择：沙箱里没有 pwsh（改写的东西没法真跑），
而 PowerShell 5.1 的 `ConvertTo-Json` 会把单元素数组塌成对象，正好是 `artifacts[]` / `scores[]` / `unmet[]` 最要命的地方。
`.ps1` 仍然存在且 ASCII-only（gate 会查），只是不再承载业务逻辑。

### 10.2 手工用法（本机）

```powershell
.\code\local-runner.ps1 -DryRun                       # 只看会跑什么（不改任何文件）
.\code\local-runner.ps1 -DrainOnce                    # 排空一轮（值守用的就是这个）
.\code\local-runner.ps1 -Job 20260915-001-capability-probe -Force   # 指定 job 重跑（attempt+1）
.\code\local-runner.ps1 -SelfTest                     # 纯逻辑自检，不碰队列
node scripts\local-runner-validate.mjs --job local-runs\jobs\X.job.json   # 校验 job
```

退出码：`0` 无活可干 / 选中的 job 都干净（`succeeded` 或策略 `skipped`）；`1` 有 job `failed`/`timed_out`；
`2` 用法错；`3` 内部错；`127` 找不到 node 或执行器。**`local_check.ps1` 只看这个退出码**——非 0 即 handshake 判 failed。

### 10.3 本机策略：`local-runs/state/settings.json`（不进 git）

样例见 `local-runs/settings.example.json`（拷到 `local-runs/state/settings.json` 再改）：

```jsonc
{
  "maxJobsPerDrain": 1,                 // 一轮跑几个 job
  "maxParallelAgents": 2,               // 未指定 options.maxConcurrency 时的默认值
  "allowedKinds": ["benchmark", "probe"],
  "allowRiskyCommands": false,          // kind=command 的总闸（默认关）
  "allowedProbes": ["capability", "hardware", "doctor", "nvidia-smi", "conda-env-list", "agentarena-version"],
  "arenaCli": null,                     // 例如 "agentarena"，或 ["node","<dist>/index.js"] 用 arenaCliArgs
  "arenaCliArgs": [],
  "artifactPolicy": { "defaultMode": "summary", "maxFileMb": 5, "maxTotalMb": 20 },
  "defaultTimeoutSeconds": { "benchmark": 3600, "probe": 120, "command": 600 },
  "consoleTailLines": 2000
}
```

**CLI 解析顺序**（`probe: capability` 会把结果写进 `probe.json`，一眼可见）：
`settings.arenaCli` → 环境变量 `AGENTARENA_CLI`(+`AGENTARENA_CLI_ARGS`) → PATH 上的 `agentarena` →
`node packages/cli/dist/index.js`（仓库内已构建时）。四者都没有 → `benchmark` job 立刻 `failed`（`engine-error`），
不会假装跑过。

### 10.3.1 排障：队列没被消费时先看这两个文件

1. `results/status/local-runner-drain.txt` **不存在** → 挂钩没执行（本机 checkout 是旧的，或 `code/local_check.ps1` 被本地改动覆盖）。
2. 存在但 `runner: ... (MISSING)` / `node: (not found)` → 树旧或 PATH 没带上 node（计划任务可用 `Get-Command node` 复核）。
3. 存在且 `exit: 0` + `local-runs/drain-last.json.reason = "no queued jobs"` → 挂钩跑了、队列是空的：检查本机是否真的 pull 到了带 job 的那次提交。
4. 存在且 `exit: 1` → job 本身失败，直接看 `local-runs/results/<jobId>/status.json`。

> 背景：`watch.ps1` 用 `Invoke-Expression $CheckCmd 2>&1` 捕获检查输出，但在本机实测会返回**空日志且 exit 0**
> （历史上所有 `results/status/check_rN_*.txt` 都只有两行）。所以不要依赖它来判断执行器有没有跑，以上两个文件才是据。

### 10.3.2 本机实测：watcher 的 PowerShell 检查链空转 → 改用原生链

现象：`results/status/check_r1|r2_*.txt` 恒为两行、exit 0，且**没有任何副作用**（新挂钩写的
`results/status/local-runner-drain.txt`、`local-runs/drain-last.json` 都不存在）——
即 `watch.ps1` 里的 `Invoke-Expression 'powershell -NoProfile -ExecutionPolicy Bypass -File code/local_check.ps1'`
在这台机器上没能真正执行那个脚本（不是因为执行器失败：node 缺失会是 exit 127 → failed）。

处理：`check_cmd` 换成 **`bash code/local_check.sh`**（原生进程，无嵌套 PowerShell）：

```bash
node code/local-runner.mjs --drain-once   # 排空队列（自带证据）
bash code/check_all.sh                    # gate
```

任一失败即非零退出 → 值守判 `failed`。若计划任务的 PATH 上没有 bash，把 `check_cmd` 换回
`powershell ... code/local_check.ps1`（旧挂钩仍在），或改用 `cmd /c` 包装。

**改动生效有"一轮滞后"（重要）**：`watch.ps1` 在**每次 poll 开头**读配置，之后才同步代码；而空闲轮（无待处理请求）**根本不会 pull**。
所以换了 `check_cmd` 之后，**处理请求的那一轮用的还是旧命令**，要再发一轮才生效——
日志里回显的 `cmd:` 行就是判断依据（本轮 round 3 日志显示旧 powershell 链，正是这个原因，不是代码没生效）。

**人工兜底（推荐在排障时用）**：

```powershell
.\sync.ps1                          # 先拉到最新
.\code\drain-and-push.ps1          # 排空队列 + 提交 + 推送，一条命令
.\code\diagnose-watcher.ps1        # 还不对劲时：取证报告（会被下一次 push 带上分支）
```

### 10.3.3 沙箱护栏（别再让 job 死在错误的地方）

执行器在**看起来像 Arena 沙箱**的环境里会拒绝排空（`drain-last.json.reason = "sandbox-environment (refused)"`），
判据：主机名 `e2b.local`/`*.e2b.local`，或仓库路径以 `/home/user/` 开头。
原因：S2 测试期间我在沙箱里跑了一次 `--drain-once`，把本该由真机执行的 probe job 吃掉并写入了一份
**沙箱环境的假判定**（没有 GPU/conda），随后回滚。e2e 测试需要时用 `--allow-sandbox`（或 `LOCAL_RUNNER_ALLOW_SANDBOX=1`）显式放行。

### 10.4 实现要点（原检查清单）



1. `*.job.json` 才入队；`idempotencyKey` 命中终态直接复用（不重复烧 token），并把 job 原件归档出队。
2. 租约先写后跑（`state/lease.json`，30 分钟 TTL + 60s 心跳）；租约有效 → 本轮只报"busy"并退出 0；过期自动接管。
3. `requirements` 先验后跑；不满足 → fail-fast，**不降级**。硬件报告字段按 `vram_gb` / `cuda_driver`（git-sync 的 snake_case）归一化。
4. 输出只往 `.work/` 与 `results/` 写；`--repo` / `--task` / `cwd` 都解析到仓库根内，逃逸即拒绝。
5. 日志落 `.work/<jobId>/{stdout,stderr}.log`，再合成 `console.log`（头部含 jobId/命令/退出码/耗时，尾部截断）。
6. `--json` 与 `--json-events` 二选一（互斥），两者最后一行都是可解析摘要；`summary.json` 优先于 stdout 摘要。
7. `.ps1` 全 ASCII（PowerShell 5.1 GBK 解码坑，见 `skills/git-sync/SKILL.md` 铁律 1）；中文只进 `.md`/`.json`/`.mjs`。
8. 跑完不论成败都写 `status.json` + `artifacts.json` + `console.log` + `ledger.jsonl`，再 archive job 原件。
9. `--dry-run` **绝不改文件**（不写状态、不归档、不记台账）。

## 11. 已知限制（v1 明确不做）

| # | 限制 | 现状 / 出路 |
|---|---|---|
| L1 | 单机假定 | 多机靠 `GIT_SYNC_PROFILE` + 每台一个 clone；`status.json.host.name` 区分 |
| L2 | 单槽 handshake | 一轮 request 排空队列；要真并行 → 多分支/多克隆，各注册值守 |
| L3 | CLI 无法表达"同 adapter 多 model 变体" | v1.1 走 `POST /api/run`（`UiRunPayload` 恒等映射） |
| L4 | 不做实时进度回传 | `console.ndjson` 是**事后**回传；实时要看进度请本机开 `agentarena ui` |
| L5 | 不做产物 diff/回放 | trace 与 workspace 留在 `.work/`（本机），要留就 `full` 模式或打包 |
| L6 | `kind=command` 默认关 | 有意为之：本机是主权方，逃生舱必须有意识打开 |
| L7 | 无队列优先级抢占 | `priority` 只在同一轮排序生效；跑起来的 job 不被打断 |

## 11.5 S2 验收记录（沙箱内真跑，2026-09-15）

在临时"假仓库"里用假 CLI（`--output/--json/--json-events` 行为对齐真 CLI）跑完整 drain，覆盖：

| 场景 | 期望 | 实测 |
|---|---|---|
| 正常 benchmark（2 agent 成功） | `succeeded` / `pass`，产物入 `results/`（sha256 齐全） | ✅ exit 0 |
| 有 agent 失败（CLI exit 1） | `failed` / `fail` / `failureCategory=environment`，`failedJudges[]` 带 judgeId+note | ✅ exit 1 |
| 超时（CLI 睡 60s，job 10s） | `timed_out` / `inconclusive`，**进程树被杀干净** | ✅ 10.0s，无残留进程 |
| `requirements` 不满足（假工具 + 8GB 显存 + 不存在的 env） | `failed` / `environment` / `requirements-unmet`，**不执行** | ✅ 未启动 CLI |
| 产物超 `maxFileMb` | 只进 manifest（`committed:false` + `localPath`），job 仍成功 | ✅ |
| 同一 `idempotencyKey` 重放 | 复用已有结果、不重跑、原件归档出队 | ✅ |
| `kind=command` 未开闸 | `skipped` / `policy-rejected` + 结构化原因 | ✅ |
| job 文件坏 JSON | `skipped` / `unsupported-schema` | ✅ |
| 有效租约在手 | 打印 busy、退出 0、队列不动 | ✅ |
| `--force` 重跑 | `attempt+1`，`attempts[]` 保留历史 | ✅ |
| `--dry-run` | 不改任何文件 | ✅ |
| 执行器自检 | `node code/local-runner.mjs --self-test` | ✅ 16/16 |

已知未覆盖：真机 Windows 上的 `taskkill` 分支、`where` 解析出的 `.cmd` shim 路径（沙箱是 Linux）——
这两条正是首轮真机 probe 要顺带验证的东西。

## 12. 落地路线（协议之外，按需推进）

| 阶段 | 交付物 | 归属 | 备注 |
|---|---|---|---|
| **S1 ✅（已推送）** | 本文 + `docs/schemas/*.json` + `local-runs/` 骨架 + 示例 | 工作会话 1 | **不改** `packages/`、`apps/` |
| **S2 ✅（已推送）** | `code/local-runner.mjs`（执行器）+ `code/local-runner.ps1`（ASCII 包装）+ `scripts/local-runner-validate.mjs`（校验器）+ `code/local_check.ps1` 挂钩 + `local-runs/settings.example.json` | 工作会话 1 | 本机侧文件，仍不进 runner 核心 |
| S3 | 沙箱侧小工具：`scripts/local-runner-job.mjs`（生成 job + 校验 + 收结果），供任何会话复用 | 工作会话 1 / 汇总会话 | 只读 `local-runs/**` |
| S4 | 把真机 venue 接进 `runBenchmark` / UI（job 生成、结果并入报告） | **工作会话 2**（brief 是它的地盘）+ 汇总会话 | 需要改 `packages/`，由它们定 |
| S5 | 版本与回归：把 job/status schema 纳入契约测试（`tests/`） | 汇总会话 | 合并到 main 后再谈 |

> 边界声明：本会话（工作会话 1）只做 S1–S3，**不合并其他分支、不改 runner 核心代码**；
> `packages/` / `apps/` 的接线在 S4，归工作会话 2 与汇总会话。
