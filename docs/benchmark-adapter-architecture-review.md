# AgentArena benchmark / adapter 架构梳理与适配点清单

> **工作会话 2 · 调研与文档线** ｜ 2026-09-15 ｜ 基线：`main` @ `c9dc5b5`，本分支 `arena/01a0a3d6-agentarena`
>
> **本文边界**：只做「架构梳理 + 适配点清单 + 文档漂移修正」。
> **不涉及**「真机 venue / local-runner 执行协议」的实现细节——那是**工作会话 1（3ee）**的领域；
> 本文 §A7 只标注**接口面**供其对接，不定义协议。

---

## 0. TL;DR

- **流水线**：`agentarena run` → `loadTaskPack` → `checkTaskCompatibility` → `preflightAdapters` →
  并发 `runAgent`（每 agent 独立工作区 + 前后快照差分） → `runJudges` → `collectResults` →
  `enrichRunWithScores` / `writeReport`。
- **契约以 `@agentarena/core` 类型为单一真源**，四处「同步契约」由 CI 测试守着（见 §2）：
  adapter 注册表、judge 类型三方同步、评分权重前后端镜像、结果字段 → 评分组件。
- **`STABILITY.md` 已冻结核心**：adapter 集合、15 种 judge、6 种评分模式、CLI 命令集、
  公开 API / HTTP / taskpack schema / trace 格式。→ **扩展不是"随便加"，而是走四条缝**：
  ① 外部 adapter 插件 ② 任务包（零代码） ③ 执行地点层（venue，非冻结面） ④ 报告 / UI 层。
- **本次修掉一处文档漂移**：`.skills/add-judge` 与 `.skills/taskpack-authoring` 还写「12 种 judge
  类型」（实际 **15**），且 `add-judge` 给的三个文件路径已过时（详见 §4）。

---

## 1. 一次 benchmark 的完整流水线

| # | 阶段 | 入口 / 关键文件 | 产物 / 语义 |
|---|---|---|---|
| 1 | 解析参数 | `packages/cli/src/args.ts` → `packages/cli/src/commands/run.ts` | `ParsedArgs`；`--score-mode` 等在此校验 |
| 2 | 加载任务包 | `packages/taskpacks/src/index.ts` `loadTaskPack()`；judge 归一化在 `normalizers.ts` 的 `JUDGE_NORMALIZERS` | 未知 judge 类型 / 未知字段 / 枚举越界 → **加载期报错**，错误信息里的 `supportedTypes` 由 registry 现算 |
| 3 | 仓库兼容性预检 | `packages/runner/src/task-compatibility.ts` `checkTaskCompatibility()` | repoSource、语言标记、setup/judge 命令可用性；`fail` → **不跑 agent**，直接产出 `scoreExcluded: true` + `failureCategory: "task-pack"` 的结果 |
| 4 | Adapter 预检 | `packages/adapters/src/adapter-registry.ts` `preflightAdapters()` | 并发 + 单 agent 120s 超时；产出 `AdapterPreflightResult[]`（含 `capability`、`status: ready/unverified/blocked/missing`） |
| 5 | 并发执行 | `packages/runner/src/index.ts` `runBenchmark()` → `mapWithConcurrency` → `agent-lifecycle.ts runAgent()` | 每 variant 独立工作区：`prepareWorkspace()` → 前置快照 → `adapter.execute()`（`wrapWithTimeout`、AbortSignal）→ 后置快照 → `diffSnapshots()` → `buildDiffPrecision()` → `runJudges()` → trace 落盘 |
| 6 | 结果落盘 / 可恢复 | `agents/<variantId>/result.json`、`trace.jsonl`、`run-state.json` | `--resume` 复用已完成结果；`run-state.json` 标记 `in-progress/complete/failed/cancelled` |
| 7 | 收集与评分 | `collectResults()` → `packages/report/src/scoring.ts` `enrichRunWithScores()` + `writeReport()` | `summary.json`、`report.html`、`decision-report.md`（另见 `summary.md` / `badge.json` / `pr-comment.md`） |

**失败语义（易踩）**：一次 run 里"某 agent 失败" ≠ "run 失败"。
`run-state.json` 的 `cancelled` 是独立状态（有成功项 + 有取消项时**不能**折叠成 `failed`）；
`status` 的 `success` 需要**全部**满足：adapter 成功、无错误、judge 全过、teardown 全过。

---

## 2. 契约层：四个「不许各自为政」的同步点

| # | 契约 | 单一真源 | 镜像 / 消费方 | 守卫 |
|---|---|---|---|---|
| **C1** | Adapter 注册 | `packages/adapters/src/adapter-registry.ts` `adapterEntries`（能力元数据在 `adapter-capabilities.ts`，安装探测在 `install-guides.ts`） | CLI `list-adapters`、doctor、UI 列表、插件注册 | 重复 ID 直接 `throw`；`tests/adapters*.test.mjs` |
| **C2** | Judge 类型 | `packages/core/src/types/judge.ts`（`TaskJudge` union + `JudgeTypeRegistry`），实例注册在 `packages/judges/src/index.ts` | `packages/taskpacks/src/normalizers.ts` `JUDGE_NORMALIZERS`；`runJudge()` 分发；`packages/judges/src/judges/<type>.ts` | `tests/judge-registry-sync.test.mjs`（registry ↔ normalizers ↔ union 三方对齐） |
| **C3** | 评分权重 | `packages/core/src/scoring-weights.ts`（`ScoreMode` 闭集 + `getDefaultWeights`，含每个预设的推导理由注释） | 前端 `apps/web-report/src/view-model/scoring.js` `SCORE_WEIGHT_PRESETS` | `tests/scoring.test.mjs`：「frontend SCORE_WEIGHT_PRESETS match backend getDefaultWeights for all modes」 |
| **C4** | 结果字段 → 评分组件 | `packages/core/src/types/benchmark.ts`（`AgentRunResult` / `BenchmarkRun`） | `packages/report/src/scoring-schema.ts` `EXPECTED_COMPONENT_KEYS` + `ScoreComponents`；前端 view-model | `tests/scoring.test.mjs`、`tests/core.test.mjs` |

> 另有三份 ADR 覆盖这里的决策：`docs/adr/ADR-001`（adapter↔CLI 契约）、`ADR-002`（judge 类型注册同步）、
> `ADR-003`（安全与执行模型）、`ADR-004`（web-report 状态架构）。**动这几个面前先读对应 ADR。**

**C2 的完整链路（新增一个 judge 类型要同步 6 处）**：
`core/types/judge.ts`（接口 + union） → `judges/src/index.ts`（`judgeTypeRegistry.register` + `runJudge()` 分发 case）
→ `judges/src/judges/<type>.ts`（实现） → `taskpacks/src/normalizers.ts`（`JUDGE_NORMALIZERS` 构造 + 字段校验）
→ `tests/judge-registry-sync.test.mjs` 的 `EXPECTED_JUDGE_TYPES` → 文档（`.skills/add-judge`、`docs/taskpack-authoring.md`）。

---

## 3. 适配点清单（A1–A10）

> 每个适配点标注：**改动面** / **同步契约** / **必跑验证** / **冻结状态**。
> 「冻结」= `STABILITY.md` 明确"不经讨论不允许"（新功能、新 adapter、新 judge 类型、改评分公式、破坏稳定 API）。

| 编号 | 想做的事 | 必改文件（精确路径） | 同步契约 | 必跑验证 | 冻结 |
|---|---|---|---|---|---|
| **A1** | 新增内置 CLI 型 adapter | `packages/adapters/src/<agent>-adapter.ts`、`adapter-registry.ts`、`adapter-capabilities.ts`、`install-guides.ts`；模型选择还需 `packages/cli/src/args.ts` + `packages/cli/src/index.ts` `normalizeCliSelections()` | C1 | `pnpm --filter @agentarena/adapters build`、`tests/adapters-new.test.mjs` | ❄️ 冻结（新 adapter 不接收） |
| **A2** | **不经核心加 agent**（唯一合规途径） | 只写一个**插件文件**：导出 `createAdapter(): AgentAdapter`，用 `loadAndRegisterPlugins()`（`packages/adapters/src/plugin-registry.ts`，实现 `loadAdapterPlugins` 动态 `import()` + 形状校验 + 诊断告警） | C1（运行时注册，不改源码） | 插件文件 + 一次 `preflight` 冒烟 | ✅ 允许（不需改冻结面） |
| **A3** | 新增 judge 类型 | 见 §2 的 6 处链路 | C2 | `pnpm --filter @agentarena/judges build`、`pnpm --filter @agentarena/taskpacks build`、`tests/judges.test.mjs`、`judge-registry-sync` | ❄️ 冻结（需讨论） |
| **A4** | 新增任务包字段 / 枚举 | `packages/core/src/types/task-pack.ts`、`packages/taskpacks/src/normalizers.ts`、`assert.ts`、`docs/taskpack-authoring.md` | —（schema `agentarena.taskpack/v1` 是稳定面，加字段必须可选） | `tests/taskpack*.test.mjs`、跑一次示例任务包 | ⚠️ 加可选字段可以，破坏 schema 不行 |
| **A5** | 新增评分模式 | `packages/core/src/scoring-weights.ts`（闭集 + `case` 分支，`never` 兜底强制编译期完备）、`packages/cli/src/args.ts`（validator）、`apps/web-report/src/view-model/scoring.js` | C3 | `tests/scoring.test.mjs`（前后端镜像） | ❄️ 冻结（6 模式锁定） |
| **A6** | 新增结果 / 证据字段 | `packages/core/src/types/benchmark.ts` → `packages/runner/src/result-assembly.ts` `buildFinalResult()` → `packages/report/src/scoring-schema.ts` `EXPECTED_COMPONENT_KEYS` → 前端 `apps/web-report/src/view-model/*`（+ i18n 双语） | C4 | `tests/scoring.test.mjs`、`tests/core.test.mjs`、web-report e2e | ⚠️ 新字段必须可选（向后兼容） |
| **A7** | **执行地点 / venue 扩展**（工作会话 1 主场） | 接入面：`packages/runner/src/agent-lifecycle.ts` 的 `executeAgent()` 与 `prepareWorkspace()` / `snapshotDirectory()` 之间；外部实现须满足 `AdapterExecutionContext`（`repoPath` / `workspacePath` / `environment` / `task` / `signal` / `trace` / `onActivity`） | 与 C1/C4 无直接耦合 | 见下 | ✅ 非冻结面 |
| **A8** | 报告 / UI 呈现 | `packages/report/src/*`（导出面见 `packages/report/src/index.ts`）→ `apps/web-report/src/view-model/*`、`apps/web-report/src/i18n.js`（`t()` / `localText(zh,en)`） | C3/C4（展示必须复用同一权重与组件口径） | `pnpm test:web-report:e2e`、`.skills/ui-change` 清单 | ✅ 允许（含可访问性改进） |
| **A9** | 任务包与仓库的兼容性规则 | `packages/runner/src/task-compatibility.ts`（语言标记 / 命令可用性 / build·lint 脚本 / judge 目标路径是否已存在） | — | `tests/e2e-benchmark.test.mjs` | ⚠️ 属于 runner 行为 |
| **A10** | trace / metrics / evidence | `packages/trace/*`（JSONL 格式是**稳定面**）、`packages/core/src/metrics.ts`、`evidence.ts` | trace 格式冻结 | `tests/evidence.test.mjs`、`tests/metrics.test.mjs` | ❄️ 格式冻结 |

### A7 细节（只列接口面，不定义协议）

外部 venue 想让"在别的机器上跑"接进现有评分与报告，最低要求三件事与本地执行**语义一致**：

1. **工作区隔离**：每个 `variantId` 一份独立工作区（对应 `workspaceRootPath/<variantId>`）。
2. **快照差分可靠性**：执行前后都要有快照；拿不到时必须以"不可靠"上报（`diffReliable=false`），
   不能让上层误以为 diff 为空 —— 这点直接决定 `precision` 评分是否成立。
3. **取消语义**：`AbortSignal` → `BenchmarkCancelledError`；取消必须能被 `run-state.json` 记为 `cancelled`
   而不是 `failed`（`isAbortError()` / `createCancelledRunResult()` 是现成工具）。

产物必须回落到 `agents/<variantId>/result.json` + `trace.jsonl`，才能零改动复用 §1 第 7 步的评分 / 报告。

---

## 4. 本次修正的文档漂移（同提交一并修复）

| 文件 | 原内容 | 实际情况 |
|---|---|---|
| `.skills/taskpack-authoring/SKILL.md` | 「12 types available」，缺 3 种 | **15 种**：缺 `directory-exists`、`regex-match`、`compilation` |
| `.skills/add-judge/SKILL.md` | 同样写 12 种；步骤 1 指 `packages/core/src/types.ts`；步骤 2 指在 `packages/judges/src/index.ts` 里写 `runXxxJudge()`；步骤 3 指改 `packages/taskpacks/src/index.ts` 的 `normalizeJudge()` / `supportedTypes` 数组 | 15 种；真实路径：`packages/core/src/types/judge.ts`；实现放 `packages/judges/src/judges/<type>.ts` + 在 `index.ts` 的 `runJudge()` 加分发；归一化在 `packages/taskpacks/src/normalizers.ts` 的 `JUDGE_NORMALIZERS`，而 `supportedTypes` 是运行时从 `judgeTypeRegistry.getAllTypes()` 现算 |
| `docs/taskpack-authoring.md` | 已正确列 15 种 | ✅ 无需改动（**说明漂移只在 `.skills/`**，没有 CI 守卫覆盖） |

---

## 5. 建议的后续（待你 / 汇总会话拍板，本阶段未实施）

1. **文档一致性守卫**（我建议下一阶段做，属文档线）：
   加一条测试，把 `.skills/*` 与 `docs/*` 中出现的 judge 类型清单与 `judgeTypeRegistry` 对齐——
   现有 CI 守卫只覆盖"代码三方同步"，**没覆盖文档**，这次漂移就是这么漏出来的。
2. **`docs/architecture-decisions.md` 增补 venue 一节**：等工作会话 1 的 local-runner 协议定型后由文档线补写
   （避免与其文档文件冲突）。
3. **A6 实操版**：为 web-report 补一页"新增结果字段的完整清单"（core → runner → report → view-model → i18n）。

---

## 6. 验证情况（如实记录）

**已在沙箱实跑**（Linux / Node v22.22.3 / pnpm 10.6.1）：

- `pnpm install --frozen-lockfile` → `pnpm build` 通过（含 web-report 构建与 `scripts/check-syntax.js` 后置检查）。
- `pnpm test`（`node --test --test-concurrency=1 tests/*.test.mjs`）：**1124 项 / 1108 通过 / 5 失败 / 11 跳过**。
- 5 个失败**与本分支无关**：本分支相对 `main` 只动了 `.gitignore`、`skills/git-sync/**`、根目录 `.ps1`、
  `docs/`、`results/`，**未触碰 `packages/`、`apps/`、`tests/`**。两类根因如下（均稳定复现，非 flaky）：
  1. **Windows 专属 shim（3 个）**：`tests/adapters.test.mjs` 的 qwen/codex 用例把假 CLI 写成 `.cmd`
     （`@echo off` + `spawn`），Linux 上直接 `EACCES`，capture 文件不会生成 →
     「Qwen adapter sends task prompt through stdin…」「Codex adapter passes configured sandbox mode…」
     「Codex adapter passes the active CODEX_HOME…」失败。
  2. **取消语义测试时序脆弱（2 个）**：`tests/integration-workflow.test.mjs` 与 `tests/runner.test.mjs`
     在收到 `agent-start` 事件后 `setTimeout(() => controller.abort(), 1000)`，而本机 demo agent
     只需 205–280 ms 就结束 → 拿到 `success` 而非 `cancelled`（断言 `status === "cancelled"` 失败）。
     **机器越快越容易红**，慢机器/Windows 上反而容易绿。
- 单文件复现命令与结果：`node --test tests/adapters.test.mjs` → 3 fail / 23 pass；
  `node --test tests/runner.test.mjs` → 1 fail / 33 pass；
  `node --test tests/integration-workflow.test.mjs` → 1 fail / 5 pass。

**建议（属"测试硬化"，`STABILITY.md` 允许；本阶段未改测试代码，留给后续或其它会话认领）**：

1. 取消类测试改为"可控延迟"：等 `agent-start` 后用一个**能被测试控制的**慢 demo agent（或轮询确认仍在运行）再 abort，
   避免用固定 `setTimeout` 与"agent 跑多快"赛跑。
2. 平台敏感的 shim 测试加 `process.platform === "win32"` 跳过，或改为跨平台 shim（node 脚本 + 可执行位）。

**尚未验证**：

- 我没有在本机（Windows）+ 真 agent CLI 上跑过端到端 benchmark；文中"兼容性预检会拦下不匹配的任务包"等
  行为结论来自**源码阅读**，未用真实 CLI 复现。
- A7 的接口面是从调用点读出的，**未与工作会话 1 的协议方案核对**——如与他们的设计冲突，以他们的为准。
