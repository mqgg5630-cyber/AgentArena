# 工作会话状态（工作会话 2）— `work-report-w2.md`

> **文件改名说明（2026-09-15）**：按用户指派，本会话报告从 `results/status/work-report.md`
> 迁到 **`results/status/work-report-w2.md`**（`git mv`，历史保留），避免多会话同名文件合并冲突。
> 其它会话请各自用 `work-report-<后缀>.md`；汇总会话的台账在 `results/status/integration.md`。

- 角色：**工作会话 2**（用户 2026-09-15 指认）
- 职责：**仓库调研与文档线** —— AgentArena benchmark/adapter 架构梳理、**适配点清单**、**文档一致性守卫**、DEVLOG 维护
- 工作分支：`arena/01a0a3d6-agentarena`（只在本分支读写；不 push main、不碰他人分支、**不合并**其他分支）
- 技能版本：**git-sync v2.4.7**（2026-09-15 升级；v2.4.7 = `watch.ps1` 增加 elapsed + 空输出显式标记）
- 最近更新：2026-09-15（见本分支最新提交）

## 一、进度（倒序）

| 轮次 | 提交 | 内容 | 验证状态 |
|---|---|---|---|
| 7 | 见最新提交 | round 3 已 `--accept` 收尾（`ca534b1`）；**A6 正式关账**；技能升 **v2.4.7**；DEVLOG 加 2 条（空输出"通过" / buildNumber 抖动）；本报告记录两个新发现 | 沙箱：升级后 gate 7 项全过；**真机 round 4 起用 v2.4.7 记录 elapsed**，用于判定"通过"是否空转（见第六节） |
| 6 | `ff9b3ec` | **A6 实操文档**：`docs/adding-result-fields.md`；技能升 **v2.4.6**（watch.ps1 回退 + 新增 `-Headless`） | 沙箱**实跑**：无 `tokenBudget` 时 `tokenEfficiencyScore` **键不出现**且 `scoreComponents.tokenEfficiency=0`；`--token-budget 100` 时 = `0.373134…= min(1,100/268)`；**真机 round 3 PASSED 并已 accept** |
| 5 | `09823bd` | **文档一致性守卫**：`code/check-doc-judge-sync.mjs` + 接进 `code/check_all.sh` 第 4 步；本文件改名 w2 | 沙箱**实跑**：正向 exit 0（识别 5 个目录、无误报）；**4 个反向测试全部命中**；**真机 round 2 PASSED 并已 accept** |
| 4 | `4578489` | 调研线第一阶段：`docs/benchmark-adapter-architecture-review.md`（流水线 / 4 个同步契约 / **适配点清单 A1–A10** / 文档漂移）；修 `.skills` judge 类型 12→15 + 过时路径 | 沙箱实跑 `pnpm install/build` 通过、`pnpm test` = 1124 项 / 1108 过 / 5 红（与本分支无关）；**真机 round 1 PASSED 并已 accept** |
| 3 | `5139093` / `4987b8c` | 升级 git-sync v2.4.5（config 保留）+ 建立本文件 + 分支实况表 | 沙箱：installer 3×OK、`.gitignore` 未被二次改写 |

## 二、交付物索引（本会话产生的文件）

| 文件 | 作用 |
|---|---|
| `docs/benchmark-adapter-architecture-review.md` | 架构梳理 + 适配点清单 A1–A10 + 4 个同步契约 + 文档漂移记录 |
| `code/check-doc-judge-sync.mjs` | **文档↔代码一致性守卫**：judge 类型目录必须与 `judgeTypeRegistry` 对齐（`--list` / `--verbose`） |
| `code/check_all.sh`（第 4 步） | 门禁已串入上述守卫（`agent-sync.sh` 提交前 + 本机 `local_check.ps1` 第 1 步都会跑到） |
| `docs/adding-result-fields.md` | **A6 实操文档**（已关账）：新增结果字段 / 评分组件的完整清单（core → runner → report → web-report → i18n），含 `tokenEfficiencyScore` 真实链路与最小 diff 骨架 |
| `.skills/add-judge/SKILL.md`、`.skills/taskpack-authoring/SKILL.md` | 修正 judge 类型清单 12→15 与真实文件路径 |
| `docs/DEVLOG.md` | 按 AGENTS.md 规则追加 6 条（`skills/` 被吞、基线 5 红、文档漂移、守卫设计、VBS 停摆、空输出"通过"、buildNumber 抖动） |

## 三、守卫的工作方式（供汇总会话/其他会话参考）

- **单一真源**：`packages/judges/src/index.ts` 的 `judgeTypeRegistry.register({ type: ... })`（无需构建即可读）；
  另加两道自检：`core/src/types/judge.ts` 的 `TaskJudge` union 成员数，以及**有构建时**与 `packages/*/dist` 的运行时 registry 比对
  （防止本脚本的正则解析在重构后静默失效）。
- **只扫"目录型"文档**（按列表上下文识别：内联逗号串 / `- \`type\`` 项 / 表格行），叙事性文档（DEVLOG、架构梳理、troubleshooting）**故意不拦**；
  历史记录按路径豁免（`docs/plans/`、`docs/superpowers/`），单个文件可用 `<!-- judge-types: ignore -->` 退出检查。
- 已知 5 个目录：`.skills/add-judge`、`.skills/taskpack-authoring`、`README.md`、`README.zh-CN.md`、`docs/taskpack-authoring.md`。
- **CI 覆盖待办**：`pnpm test` 只跑根目录 `tests/*.test.mjs`，而 `packages/*` 没有自带测试目录/脚本，所以守卫目前走**门禁**这条线
  （提交前 + 本机值守）。若要进 CI，只需在根 `tests/` 加一个薄包装测试（用 `execFileSync("node", ["code/check-doc-judge-sync.mjs"])`）——
  **该文件不在本会话边界内**，留给汇总会话或用户认领。

## 四、基线红点（全员相关，非本会话引入）

本分支相对 `main` 未触碰 `packages/`、`apps/`、`tests/`，下列失败在 `main` 上同样存在（Linux 环境）：

- **3 个 Windows 专属 shim 测试**：`tests/adapters.test.mjs` 的 qwen/codex 用例用 `.cmd` shim，Linux `spawn` → `EACCES`。
- **2 个取消语义测试时序脆弱**：`agent-start` 后固定 `setTimeout(abort, 1000)`，demo agent 205–280 ms 就结束 →
  断言 `status === "cancelled"` 失败；**机器越快越容易红**。

⇒ 汇总会话合并后跑 CI 若见 5 红，先对照本节，不要误判为某分支引入。

## 五、分支实况与合并风险（2026-09-15 实测）

| 分支 | 角色 / 状态 | HEAD |
|---|---|---|
| `arena/01a0a3d6-agentarena` | **本会话（工作会话 2，调研与文档线）** | 见最新提交 |
| `arena/01a0a3ee-agentarena` | 工作会话 1（local-runner 执行协议） | `d61df0a` |
| `arena/01a0a3f1-agentarena` | 汇总会话（`results/status/integration.md`） | `bffe651` |
| `arena/01a0a3d5-agentarena` | 旧会话（v2.4.3，未确认是否弃用） | `6e48b20` |
| `arena/01a0a356-agentarena` | 最早一轮（精简安装，`skills/` 未入库） | `2bcc53b` |
| `arena/01a0a3de-…` / `arena/01a0a3e6-…` | 远端仍不存在 | — |

**合并注意（给汇总会话）**：

1. `skills/git-sync/sync.config.json` 是**分支私有**（各分支 `branch` 值不同），不要交叉覆盖；
   技能本体（`skills/git-sync/**`、根目录 `.ps1`）合并时只保留**最高版本（当前 v2.4.7）**一份。
2. `code/check_all.sh` 本分支有**本地扩展**（第 4 步守卫），与 skill 模板不同 —— 合并时保留本分支版本，别被模板覆盖。
3. ⚠️ **`package.json` 的 `buildNumber` 会被"来回改"**：`scripts/bump-build.js` 在每次 `pnpm build`（prebuild）时
   +1 并写回**被跟踪的** `package.json`，而两个方向的提交都用 `git add -A`。本分支已出现
   「我提交 16 → 值守侧提交 17 → 我的 accept 又回退 15」三次提交改同一字段。多会话并行时这**几乎必然冲突**。
   建议上游改法（二选一）：① 构建号写入**被忽略的生成文件**（如 `.agentarena/`、`build/` 下的 json）再由 `copy-cli-assets.mjs` 读取；
   ② 各会话提交前 `git checkout -- package.json`（或让 git-sync 的提交步骤排除该字段）。
   本会话现阶段**未改上游脚本**（不在本会话边界内），仅回退为基线值并在此报备。

## 六、真机验证记录（⚠️ 并附可信度说明）

| round | 内容 | 结果 |
|---|---|---|
| 1 | 文档线第一阶段回归 | ✅ `passed (exit 0)`，已 `--accept`；日志 `check_r1_20260915-154757.txt` |
| 2 | 文档守卫接入门禁后的回归 | ✅ `passed (exit 0)`，已 `--accept`；日志 `check_r2_20260915-162511.txt` |
| 3 | 技能 v2.4.6 + A6 文档线 | ✅ `passed (exit 0)`，已 `--accept`（`ca534b1`）；日志 `check_r3_20260915-163112.txt` |
| 4 | v2.4.7 记录 elapsed + 空输出标记，用于判定"通过"是否空转 | 见 `handshake.json` / `check_r4_*.txt` |

> ⚠️ **重要发现（2026-09-15，跨仓库系统性）**：本机至今**没有任何一条检查日志包含过输出内容**——
> 本会话 r1–r3、356 分支 r1、以及总部仓库 r4–r6 的日志**全部只有两行**（`verdict` + `cmd`），零输出、`exit 0`。
> 也就是说：这三轮"通过"**只证明了退出码为 0，没有留下"检查真的跑了"的证据**。
> 总部 v2.4.7 正是为此加了 `elapsed: Ns` 与"空输出即显式标注"（其注释写明 w1 克隆曾因缺失副作用文件才发现空转）。
> 本会话已升级 v2.4.7，**round 4 起日志将带耗时**：`elapsed` 接近 0 或仍无输出 ⇒ 判定为空转，
> 届时需要在本地检查链（`code/local_check.ps1`，属 3ee 文件边界）加"首行固定标记 + 显式捕获 stderr + 无输出即判失败"。

> **值守说明**：v2.4.4 的 `wscript`+VBS 隐形启动器在本机静默停摆（任务报成功但无轮询），v2.4.6 已回退为
> `powershell -WindowStyle Hidden`；v2.4.7 进一步注明 `-Headless`（S4U）**需要管理员控制台**（普通控制台报 0x80070005）。
> 本仓库克隆若要重注册：`.\watch.ps1 -Unregister` → `.\watch.ps1 -Register`。

> **沙箱事件**：本轮开工时发现沙箱 `.git` 又被静默重置回基线提交（`HEAD = c9dc5b5`，工作区文件完好）。
> `agent-check.sh --accept` 内置自愈（`reset --mixed origin/<branch>` + 还原幻影删除）已自动修复并推送（`ca534b1`）。

## 七、下一阶段候选（等指认）

1. **venue 章节**：等 3ee 的 local-runner 协议定型后，由本线往 `docs/architecture-decisions.md` 补一节（现在不写，避让其文件）。
2. **A7 复核**：3ee 协议冻结后，复核架构梳理里的"venue 接口面"与实现是否一致，输出差异清单给汇总会话。
3. 备选：把文档守卫接进 CI（需根 `tests/` 一行包装，不在本会话边界内）。
4. 备选：`buildNumber` 抖动治理（上游脚本改动，需授权）。
5. 测试硬化（第四节 5 红）：需你或汇总会话认领。
