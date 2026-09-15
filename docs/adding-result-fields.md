# 新增结果字段 / 评分组件的完整清单（core → runner → report → web-report → i18n）

> **工作会话 2 · 文档线** ｜ 2026-09-15 ｜ 基线 `main` @ `c9dc5b5`
>
> **用途**：给一次 benchmark 的**结果**（`AgentRunResult` / `BenchmarkRun`）加字段，并可选地让它
> 参与**评分**或在**报告页**展示。本文按"改哪一层、为什么、漏了会怎样"给清单，
> 并以真实字段 **`tokenEfficiencyScore`** 走完全链路作为样本（§4 有精确 `file:line`）。
>
> **边界**：本文只讲**字段怎么落地**。`STABILITY.md` 明确冻结「评分公式与权重预设」——
> 若你的字段要改任何预设的权重值，属于"需讨论"，不是照抄本文就能合。
>
> 相关：[`benchmark-adapter-architecture-review.md`](./benchmark-adapter-architecture-review.md)（适配点 A6 即本文）、
> [`scoring.md`](./scoring.md)、[`scoring-and-fairness.md`](./scoring-and-fairness.md)、
> [`taskpack-authoring.md`](./taskpack-authoring.md)（judge 类型目录的唯一真源在 `judgeTypeRegistry`）。

---

## 1. 先分类：你要加的是哪一类字段

| 类别 | 例子（已在库中） | 需要动的层 |
|---|---|---|
| **A. 纯执行信息** | `exitCode`、`signal`、`failureTail` | core 类型 + runner 写入（+ 可选 UI 展示） |
| **B. 参与评分** | `tokenEfficiencyScore`、`diffPrecision`、`sweBench`、`cursorBench` | A + report 评分组件 + 权重适用性 + **前端镜像** |
| **C. 仅展示** | 报告页新卡片 / 新列 | A + web-report 视图/组件 + **i18n 双语** |

先分类再动手：A 类通常 2 个文件，B 类要跨 6~9 个文件（且**前后端必须同时改**），C 类多一层 i18n。

---

## 2. 检查清单（按依赖顺序自上而下）

### 步骤 1 — core 类型（`packages/core/src/types/benchmark.ts`）

- 在 `AgentRunResult`（或 `BenchmarkRun`）加 **可选** 字段，并写注释说明三件事：**语义**、**谁写入**、**何时缺省**。
- 为什么必须可选：`@agentarena/core` 的导出类型与 `summary.json` 都是**公开稳定面**。旧 run 的 JSON 里没有这个键，
  非可选字段会让旧数据在类型层就"不合法"。
- 若字段来自 adapter 输出（token/成本/变更文件等），先把 adapter 契约补上：
  `packages/core/src/types/agent.ts` 的 `AdapterExecutionResult`（这是 adapter 唯一被允许回传的形状，见 ADR-001）。

### 步骤 2 — runner 计算与写入

- **取值/计算**放 `packages/runner/src/result-assembly.ts` 的 `buildFinalResult()`；
- **传给结果对象**走 `packages/runner/src/result-builder.ts` 的 options（`resultOptions`），如 `tokenEfficiencyScore?: number`；
- 计算失败/数据不可信时**宁可缺省（undefined）**，不要塞 0：缺省才能让评分侧的"适用性过滤"生效（见步骤 3）。

### 步骤 3 — 评分组件（仅 B 类；四处都要，漏一处就是 bug）

| 文件 | 要改什么 | 漏了会怎样 |
|---|---|---|
| `packages/report/src/scoring-schema.ts` | ① `ScoreComponents` 加键 ② `EXPECTED_COMPONENT_KEYS` 加同名键 ③ `createZeroComponents()` 加默认值 | ① 类型报错；② `validateScoreComponents()` 判定结构非法；③ 归一化时 undefined 参与运算得到 `NaN` |
| `packages/report/src/score-metrics.ts` | 加一个**纯函数** `xxxScore(result, run): number`（0–1） | 组件拿不到值 |
| `packages/report/src/scoring.ts` | 在组件装配处接上新函数 | 同上 |
| `packages/report/src/score-weights.ts` | **适用性过滤** `normalizeApplicableWeights()`：字段缺失时把该组件权重剔除、剩余权重重新归一（由 `computeCompositeScore()` 的 Rule 3 调用） | 旧 run 会被这个组件拉低分（口径污染）——这是"向后兼容"的关键一行。**注意**：被过滤的组件在 `scoreComponents` 里**仍以 0 序列化**（供 UI 展示），只是不参与复合分 |
| `packages/core/src/scoring-weights.ts` | 把新组件加进相关**预设**（⚠️ 冻结面，需讨论） | 预设里没有该键 → 该组件永远拿 0 权重（加了等于没加） |
| `packages/report/src/report-helpers.ts` | 若该组件出现在报告侧接口/标签映射里，同步 | 报告侧标签缺失 |

### 步骤 4 — 前端镜像（仅 B / C 类）

`apps/web-report/src/view-model/scoring.js` 是**后端评分的镜像实现**（前端要能对同一份 `summary.json` 动态重算）：

1. `SCORE_WEIGHT_PRESETS`：若步骤 3 动了权重，这里逐 mode 同步；
2. 组件提取：`components.xxx = result.xxxScore ?? 0` 这一层的写法；
3. **适用性 skip 分支**：`if (key === "xxx" && !hasXxx) continue;`——与后端 `score-weights.ts` 一一对应；
4. 复合分求和 + 可选 `scoreReasons` 文案 key。

> **前后端一致性由测试守着**：`tests/scoring.test.mjs` 的
> 「frontend SCORE_WEIGHT_PRESETS match backend getDefaultWeights for all modes」逐 mode、逐键比对
> 数值（容差 0.001）**并且**检查前端没有多出来的键。只改一边必红。

### 步骤 5 — 标签与 i18n（C 类，或 B 类需要显示时）

- `apps/web-report/src/score-config.js`：**两个映射都要加**——`WEIGHT_NAMES`（→ i18n key）与
  `scoreWeightElements`（→ DOM 元素 id）；
- `apps/web-report/src/i18n.js`：同一个 key 在 **en 与 zh-CN 两个语言块各加一条**（本仓库 i18n 规则：不允许只加英文）。

### 步骤 6 — 测试

| 目的 | 放哪 |
|---|---|
| 字段语义（含"不可信时不给值"） | `tests/result-builder.test.mjs` |
| 前后端评分镜像 | `tests/scoring.test.mjs` |
| 端到端（真的跑一次 run） | `tests/e2e-benchmark.test.mjs`、`tests/integration-workflow.test.mjs` |
| 必跑命令 | `pnpm build && pnpm test`（注意：Linux 基线有 5 个已知红点，见 `results/status/work-report-w2.md`，别误判） |

### 步骤 7 — 文档

- 参与评分 → 更新 `docs/scoring.md` / `docs/scoring-and-fairness.md`（组件语义与适用条件）；
- 新字段是给**人**看的 → 在 §4 那样的"全链路表"里补一行，方便下一个人照抄。

---

## 3. 不要碰的东西（踩过）

| 别改 | 原因 |
|---|---|
| `packages/cli/assets/**`、`apps/web-report/dist/**`、`packages/*/dist/**` | 构建产物；`packages/cli/assets/` 已被 `.gitignore` 忽略，改它不会进库（改源 → `pnpm build`） |
| `package.json` 的 `buildNumber` | `scripts/bump-build.js` 在 `prebuild` 自动 +1 |
| 旧 run 的 `summary.json` | 字段是**可选**的，旧数据读出来就是 `undefined`；**不要**为了"消灭 undefined"回填默认值（除 `scoring-schema` 那一处受控的 zero-components），那会让不同年代的 run 用不同口径比较 |
| `run-state.json` / `trace.jsonl` 的既有字段语义 | trace 的 JSONL 格式与 run 状态机都是稳定面（改动要按 ADR 流程） |

---

## 4. 实战样本：`tokenEfficiencyScore` 的全链路（真实位置）

| 层 | 位置 | 内容 |
|---|---|---|
| 类型 | `packages/core/src/types/benchmark.ts:246` | `tokenEfficiencyScore?: number`；`:199` 的注释说明它被 `tokenUsageReliable` 把关 |
| 计算 | `packages/runner/src/result-assembly.ts:97` | `tokenUsageReliable !== false && tokenBudget > 0 ? min(1, budget/usage) : undefined` |
| 传递 | `packages/runner/src/result-builder.ts:40` / `:87` | options 声明 → 写入结果对象 |
| 组件 | `packages/report/src/score-metrics.ts:162` → `packages/report/src/scoring.ts:127` | 纯函数 → 组件装配 |
| schema | `packages/report/src/scoring-schema.ts:19` / `:42` / `:130` | `ScoreComponents` 键 / `EXPECTED_COMPONENT_KEYS` / 默认 0 |
| 适用性 | `packages/report/src/score-weights.ts:49` / `:63` | 非 number 即剔除该权重并重新归一 |
| 权重 | `packages/core/src/scoring-weights.ts:118`（efficiency-first 0.25）/ `:139`（comprehensive 0.08） | 预设值（冻结面） |
| 前端镜像 | `apps/web-report/src/view-model/scoring.js:405`（取值）/ `:439`,`:453`（适用性）/ `:547`（求和）/ `:630`（reason）/ `:88`,`:107`（预设） | 与后端一一对应 |
| 标签 | `apps/web-report/src/score-config.js:15`（i18n key）、`:30`（DOM id）；`apps/web-report/src/i18n.js:287`（en）/`:804`（zh-CN） | 双语齐全 |
| 序列化 | `packages/report/src/scoring.ts:283-290` | `enrichRunWithScores()` 把 `scoreComponents`（14 键全量，不适用者为 0）、`compositeScore`、`scoreReasons` 写进 `summary.json` 的每条结果 |
| 复合分规则 | `packages/report/src/scoring.ts:151-200` | Rule 1 排除/失败带、Rule 2 关键 judge 失败带、Rule 3 完成态加权和（此处调用适用性过滤） |
| 测试 | `tests/result-builder.test.mjs:150-211`（可靠性 gate：`tokenUsageReliable=false` → 必须 undefined）、`tests/runner.test.mjs:1244`（`--token-budget` 覆盖 task.metadata）、`tests/scoring.test.mjs`（前后端镜像） | 三个层次都钉住了 |

**可复制的结论**：一个 B 类字段 = 1 处类型 + 2 处 runner + **4 处 report（schema/metrics/scoring/weights）** +
1 处 core 权重 + **5 处前端（预设/取值/适用性/求和/reason）+ 2 处标签 + 3 处 i18n 位置** + 测试。
A 类只要前 2 处，C 类在前 2 处基础上加前端与 i18n。

---

## 5. 最小 diff 骨架（假设加一个 B 类组件 `memoryEfficiency`）

```ts
// 1) core/src/types/benchmark.ts —— 可选 + 注释
/** Peak-RSS efficiency (0–1). Written by result-assembly when RSS was sampled. */
memoryEfficiencyScore?: number;

// 2a) runner/src/result-assembly.ts
const memoryEfficiencyScore = rssSample
  ? Math.min(1, peakBudgetBytes / rssSample.peakBytes)
  : undefined;                        // 数据缺失 → 缺省，交给适用性过滤

// 2b) runner/src/result-builder.ts
memoryEfficiencyScore?: number;       // options 声明
memoryEfficiencyScore,                // 写入结果对象

// 3a) report/src/scoring-schema.ts —— 三处：接口键 / EXPECTED 列表 / 默认 0
memoryEfficiency: number;

// 3b) report/src/score-metrics.ts
export function memoryEfficiencyScoreComponent(result: BenchmarkRun["results"][number]): number {
  return result.memoryEfficiencyScore ?? 0;
}

// 3c) report/src/scoring.ts
memoryEfficiency: memoryEfficiencyScoreComponent(result),

// 3d) report/src/score-weights.ts —— 适用性（这一行保证旧 run 不被拉低）
const hasMemoryEfficiency = typeof result.memoryEfficiencyScore === "number";
if (key === "memoryEfficiency" && !hasMemoryEfficiency) continue;

// 3e) core/src/scoring-weights.ts —— 预设里加键（⚠️ 冻结面，先讨论）
```

```js
// 4) apps/web-report/src/view-model/scoring.js —— 与后端同构
memoryEfficiency: result.memoryEfficiencyScore ?? 0,
const hasMemoryEfficiency = result.memoryEfficiencyScore !== undefined;
if (key === "memoryEfficiency" && !hasMemoryEfficiency) continue;
```

```js
// 5) 标签 + i18n
// apps/web-report/src/score-config.js
memoryEfficiency: 'scoreWeightMemoryEfficiency',   // WEIGHT_NAMES
memoryEfficiency: "scoreWeightMemoryEfficiency",   // scoreWeightElements
// apps/web-report/src/i18n.js —— 两个语言块各一条
scoreWeightMemoryEfficiency: "Memory Efficiency",  // en
scoreWeightMemoryEfficiency: "内存效率",            // zh-CN
```

---

## 6. 验证（照做即可）

```bash
pnpm build && pnpm test          # 关注 tests/scoring.test.mjs 的前后端镜像断言
node code/check-doc-judge-sync.mjs   # 若本文档列举了 judge 类型，必须与 registry 对齐（见下）

# 最直接的证据：真跑一次，看 summary.json 里有没有新字段
node packages/cli/dist/index.js run --repo . \
  --task examples/taskpacks/demo-repo-health.json --agents demo-fast
```

**上面这条真跑已验证**（2026-09-15，沙箱，`demo-fast` 无需任何 agent CLI 登录）。观察到的行为，正好是社会实验：

- `examples/taskpacks/demo-repo-health.json` **没有** `tokenBudget` → `tokenUsageReliable` 无从判定、
  `tokenBudget` 缺失 → `tokenEfficiencyScore` 计算为 `undefined` → **`summary.json` 里该键完全不出现**
  （JSON 序列化会丢掉 `undefined`）。这就是"可选字段 + 缺省即不适用"的正确形态。
- 同一份结果的 `scoreComponents` 里 **`tokenEfficiency: 0` 仍在**（14 个键全量），
  而 `compositeScore` 只由**适用**组件加权得出（该 run 的 `scoreWeights` 是 practical 的 8 个键，
  `scoreReasons` 显示实际生效项）。**两者并存不是矛盾**：组件表是"体检报告"，复合分才是"算进去的东西"。
- 想看到 `tokenEfficiencyScore` 有值：加 `--token-budget 100` 再跑（**已实测**）→
  `tokenEfficiencyScore = 0.373134328358209 = min(1, 100 / 268 tokens)`，且 `scoreComponents.tokenEfficiency` 同步为该值；
  同一次 run 的 `compositeScore = 100`（该任务 6 个维度里生效项全满，`tokenEfficiency` 因为有值也参与计算）。

<runId> 取输出里的 `JSON summary:` 那行目录名即可，例如：

```bash
node -e "const r=require('./.agentarena/runs/<runId>/summary.json');console.log(r.results[0].tokenEfficiencyScore, r.results[0].scoreComponents.tokenEfficiency)"
```

（`.agentarena/` 已被 `.gitignore` 忽略，跑完不会污染工作区。）

**本文档与 judge 类型守卫的关系**：`code/check-doc-judge-sync.mjs` 会扫描 `docs/**.md`，
把"列举 ≥8 个 judge 类型"的文件当作**目录**并要求与 `judgeTypeRegistry` 完全一致。
本文**刻意不列举 judge 类型**（只引用 `docs/taskpack-authoring.md`），所以不会被当作目录；
如果你在文档里确实要列 judge 类型，请列**全量**（或加 `<!-- judge-types: ignore -->` 显式退出）。
