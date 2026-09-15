# 工作会话状态（工作会话 1）

> 作用：多会话协同时的**只读入口**——汇总会话（`arena/01a0a3f1-agentarena`）只读本文件 + 各分支的
> `results/status/work-report-w*.md`，不用挨个翻分支历史。每轮 `agent-sync.sh` 之前刷新本文件。
> 相关：`results/sync/last_sync.md`（每轮同步回执）、`results/hardware/latest.md`（本机硬件报告）。

- 角色：**工作会话 1** —— 负责【local-runner 执行协议 + 执行器】
- 工作分支：`arena/01a0a3ee-agentarena`（只在本分支读写；不合并他人分支、不动 runner 核心代码）
- 技能版本：**git-sync v2.4.7**（2.4.6 = 撤回 wscript+vbs 隐形启动器；2.4.7 = 检查日志加 elapsed + 空输出显式标注）
- 最近更新：2026-09-15（**round 4 达标：原生链生效，探针 job 已在真机执行并回传**；S3 待 CLI 在 WSL 侧可用）

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
| 5 | （见最新提交） | **绕开空转的 watcher 检查链**：`check_cmd` 换成原生 `bash code/local_check.sh`（排空队列 + gate）；新增人工兜底 `code/drain-and-push.ps1`；执行器加**沙箱护栏**（防止 job 在沙箱被吃掉） | 沙箱已验：护栏拒绝且队列不动；`--allow-sandbox` 下 e2e 正常 |
| 4 | `dca2548` | 技能升级 v2.4.6（配置/集合全保留）；**挂钩自带证据**：`results/status/local-runner-drain.txt` + `local-runs/drain-last.json`；清掉 S1 残留的 `results/status/work-report.md` | 沙箱已验：自检 16/16、gate 三项 OK、drain-last.json 两条路径（有活/无活）实测 |
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

## 三点五、S2 本机验收现状（**探针 job 尚未被执行**）

### 轮次台账

| 轮 | 本机判定 | 日志里的 `cmd:` | 副作用证据 | 结论 |
|---|---|---|---|---|
| 1 | passed | `powershell ... code/local_check.ps1` | 无 | 假通过（空转） |
| 2 | passed | 同上 | 无 | 假通过（空转） |
| 3 | passed | 同上 | 无 | **假通过，根因已定位**：该轮读取的是 round 2 时（16:31）拉下的旧配置；16:42 推的原生链要下一轮才生效 |
| 4 | passed | （原生链）| **有** | ✅ **达标**：`drain-last.json` 刷新为真机（host LAPTOP-R77M5D6M / ran:true / probe succeeded/pass），job 归档到 `jobs/archive/`，结果四件套回传 |

本机 round 1 判定：`local_state=passed`（exit 0）→ 挂钩没有失败，**但队列里的 probe job 仍未被消费**（远端无 `local-runs/results/20260915-001-capability-probe/`）。

已排除/已定位的线索：

1. 本机那笔提交只含 `check_r1_*.txt` + `handshake.json`，`local-runs/` 无任何变化 → 执行器没有产出结果；
2. `check_r1_20260915-162508.txt` 全文只有 2 行（129 字节）：`passed (exit 0)` + `cmd: ...`；round 2 同样，且**新挂钩写的 `results/status/local-runner-drain.txt` 与 `local-runs/drain-last.json` 都不存在** → 结论：`watch.ps1` 的 `powershell -NoProfile -File code/local_check.ps1` 在这台机器上**没有真正执行脚本**（不是 node 缺失，那会是 exit 127 → failed）；
3. 挂钩若跑了而 node 缺失，会是 `failed`（wrapper exit 127）→ 本次是 `passed`，所以要么挂钩没执行（本机树旧），要么执行器认为"无活可干"；
4. 自带证据（`local-runner-drain.txt` / `drain-last.json`）正是为了一次性区分这两种情况 —— 见 `docs/local-runner-protocol.md` §10.3.1；
5. **round 3 定论**：日志回显 `cmd: powershell ...` 证明本机读到的仍是旧 `check_cmd`——`watch.ps1` 的固有滞后（poll 开头读配置 + 空闲轮不 pull）。处理 round 3 的那次 poll 已把 worktree 更新到新配置，**round 4 即验证原生链**。


### 探针回传的环境事实（真机，2026-09-15 17:11 本地时间）

| 项 | 事实 | 对 S3 的影响 |
|---|---|---|
| **执行者 OS** | **WSL2**（`Linux 6.18.33.2-microsoft-standard-WSL2`），仓库 `/mnt/e/0github/git-sync/agentarena-w1` | 检查链跑在 Linux 子系统里；`.ps1` 助手在 Windows 侧 —— 两边工具面不同 |
| node | **v20.20.2**（`/usr/bin/node`）；仓库要求 ≥22 | 可能需在 WSL 升级 node，或先试 v20 能否 build |
| **agentarena CLI** | **不可解析**（PATH 无、无 dist） | ⛔ **S3 的唯一硬阻塞**：benchmark job 现在会立刻 `engine-error` |
| GPU | GTX 1650 4GB，driver 576.02，CUDA 驱动 12.9（WSL 下 `nvidia-smi` 可用） | GPU 任务可行但显存小 |
| conda | **WSL 侧无 conda**（Windows 侧 `E:\spider`，22 环境） | 环境型任务要么 WSL 建环境，要么显式调 Windows python |
| torch/CUDA | 全部环境无 CUDA torch（`NTxPred2` = 2.13.0+cpu） | 依赖 CUDA 的 job 会按设计 fail-fast（不降级） |
| 磁盘/内存 | `/` 887 GB 空闲；`/mnt/e` 180.8 GB；RAM 15.5 GB（14.8 空闲） | 充裕 |

### S3 计划（按你的要求：先给方案，再发 job）

**A. 先跑 CPU 兼容的 demo benchmark（推荐立刻做，不需要 torch）** —— 只差让 CLI 在 WSL 可用：

```bash
# 在 WSL 里（不是 PowerShell）
cd /mnt/e/0github/git-sync/agentarena-w1
node -v                        # v20.20.2；仓库 engines 要求 >=22
nvm install 22 && nvm use 22   # 若 v20 构建失败再装（或 apt/snap 装 nodejs 22）
pnpm install && pnpm build
node packages/cli/dist/index.js --version    # 打印 0.1.0 即可
```
> 构建出 `packages/cli/dist/index.js` 后，执行器会**自动**把它选为 CLI（候选顺序：`settings.arenaCli` → PATH `agentarena` → `node <repo>/packages/cli/dist/index.js`），无需改配置。
> 然后我发 job：`demo` 任务包 + `demo-fast/demo-thorough`（不依赖 torch/GPU/外部 CLI），`requirements: {tools:[node,git]}`。

**B. 需要 GPU/真实模型时的 CUDA torch 方案（以后再上）**：

```bash
# 方案 B1：WSL 内建环境（与执行器同 OS，最省事）
conda create -n arena-gpu python=3.11 -y     # 需先在 WSL 装 miniconda
conda run -n arena-gpu pip install torch --index-url https://download.pytorch.org/whl/cu124
conda run -n arena-gpu python -c "import torch;print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```
- 4 GB 显存：只适合小模型/小 batch；job 里要用 `requirements.gpu.minVramGb` 明确上限，避免 OOM 后才失败。
- `cu124` 与驱动 576.02 兼容（驱动支持的 CUDA 运行时上限 12.9）。
- 方案 B2（不推荐）：在 WSL 里调 Windows 侧 `E:\spider\python.exe` —— 路径/环境割裂，只在你明确要求时再做。

## 四、下一步

1. **你只在 WSL 跑一段（约 5 分钟）**：上面 A 段命令（`pnpm install && pnpm build` + `--version` 自证）。跑完告我一声，我立刻发 S3 的 demo benchmark job。
2. **若 round 4 仍不成**：本机执行三连（兜底 + 取证）：
   ```powershell
   .\sync.ps1
   .\code\drain-and-push.ps1 "results: probe run"
   .\code\diagnose-watcher.ps1
   ```
   `diagnose-watcher.txt` 会记录 HEAD/stash/有效 check_cmd/工具可用性/队列/`Invoke-Expression` 复现结果，一次定位。
3. （历史记录）**真机验证（job 仍在队列）** —— 两条命令：
   ```powershell
   .\sync.ps1                      # 拉到本轮（新 check_cmd + drain-and-push.ps1）
   .\code\drain-and-push.ps1      # 排空队列 + 提交 + 推送（不等值守）
   ```
   跑完我从分支读 `local-runs/results/20260915-001-capability-probe/`。**不要**在沙箱里手动排空（护栏会拦，这也是它存在的理由）。
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
