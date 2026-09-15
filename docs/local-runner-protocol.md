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
| —（执行器固定追加） | `--json` | 最终摘要进 `console.log`，可解析 |
| —（执行器固定追加） | `--json-events`（可选） | NDJSON 进度事件流 → `console.ndjson`（失败时保留，便于定位卡点） |

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

`event` 取值：`queued | leased | started | heartbeat(不打日志) | finished | artifact-skipped | pushed | acked | rejected`。
台账只记"发生了什么"，判定细节一律以 `status.json` 为准。

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

## 10. 本机侧检查清单（执行器实现要点，阶段 2）

1. `*.job.json` 才入队；`idempotencyKey` 命中终态直接复用（不重复烧 token）。
2. 租约先写后跑；心跳更新 `heartbeatAt`；异常退出下一轮自愈。
3. `requirements` 先验后跑；不满足 → fail-fast，**不降级**。
4. 输出只往 `.work/` 与 `results/` 写；路径收敛在仓库根内。
5. 日志同时落 `console.log`（截尾）与 `console.ndjson`（失败时保留）。
6. 退出码：有终态 `failed/timed_out` → 非零（让 `local_check.ps1` 判 failed）；全 `succeeded/skipped(策略)` → 0。
7. `.ps1` 全 ASCII（PowerShell 5.1 GBK 解码坑，见 `skills/git-sync/SKILL.md` 铁律 1），中文只进 `.md`/`.json`。
8. 跑完不论成败都写 `status.json` + `artifacts.json` + `ledger.jsonl`，再 archive job 原件。

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

## 12. 落地路线（协议之外，按需推进）

| 阶段 | 交付物 | 归属 | 备注 |
|---|---|---|---|
| **S1（本阶段）** | 本文 + `docs/schemas/*.json` + `local-runs/` 骨架 + 示例 | 工作会话 1 | **不改** `packages/`、`apps/` |
| S2 | `code/local-runner.ps1`（队列排空器，纯 ASCII）+ `code/local_check.ps1` 挂钩 + 校验器（Node，`scripts/`） | 工作会话 1 | 本机侧文件，仍不进 runner 核心 |
| S3 | 沙箱侧小工具：`scripts/local-runner-job.mjs`（生成 job + 校验 + 收结果），供任何会话复用 | 工作会话 1 / 汇总会话 | 只读 `local-runs/**` |
| S4 | 把真机 venue 接进 `runBenchmark` / UI（job 生成、结果并入报告） | **工作会话 2**（brief 是它的地盘）+ 汇总会话 | 需要改 `packages/`，由它们定 |
| S5 | 版本与回归：把 job/status schema 纳入契约测试（`tests/`） | 汇总会话 | 合并到 main 后再谈 |

> 边界声明：本会话（工作会话 1）只做 S1–S3，**不合并其他分支、不改 runner 核心代码**；
> `packages/` / `apps/` 的接线在 S4，归工作会话 2 与汇总会话。
