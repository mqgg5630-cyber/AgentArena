# local-runs —— 真机执行队列与回传区

> 协议规范：[`docs/local-runner-protocol.md`](../docs/local-runner-protocol.md) ｜ Schema：`docs/schemas/local-runner-job.schema.json`、`docs/schemas/local-runner-result.schema.json`
>
> 一句话：**Arena 沙箱在这里"派活"，你本机在这里"交活"**。沙箱没有你的 GPU / conda / CLI agent，
> 所以真机任务走这条路：job JSON 进 `jobs/` → 本机值守执行 → 判定回 `results/<jobId>/` → git 带回沙箱。

## 目录

| 路径 | 进 git | 说明 |
|---|---|---|
| `jobs/<jobId>.job.json` | ✅ | 待执行队列（**只认 `*.job.json`**；示例用别的后缀） |
| `jobs/archive/` | ✅ | 已收尾的 job 原件（审计 / 重放） |
| `results/<jobId>/` | ✅ | 回传区：`status.json`（判定）、`artifacts.json`、`console.log`、摘要/报告 |
| `results/<jobId>/ack.json` | ✅ | **沙箱侧**回执（`decision` / `nextStep`） |
| `ledger.jsonl` | ✅ | 追加式台账，一行一事件 |
| `drain-last.json` | ✅ | 执行器每轮写的证据（跑了没 / 为什么没跑 / 队列看到什么 / 结果）——排障第一步 |
| `state/` | ❌ | 本机私有：`lease.json`（租约）、`settings.json`（策略：允许哪些 kind/探针、回传上限）。样例见 `settings.example.json`（拷进 `state/` 再改） |
| `.work/<jobId>/` | ❌ | 执行现场：`agentarena run` 的原始输出与临时工作区 |

## 三条硬规矩

1. **先推 job，再按门铃**：`agent-sync.sh` 推 job 文件之后才 `agent-wait.sh --request "<jobId>"`——否则本机拉不到队列。
2. **不要手改 `status.json` / `artifacts.json`**（执行器写的，原子替换）；要补结论就写 `ack.json`，要重跑就换 `jobId` 或让 `attempt+1`。
3. **大产物不进 git**：单文件默认 ≤5 MB、单 job ≤20 MB（硬上限 25 MB / 100 MB）。超限只进清单 + 本机路径，用 `.\pack.ps1` / `.\download.ps1 -Set final` 取。

## 执行器（本机侧，S2）

```powershell
.\code\drain-and-push.ps1            # 一条命令：排空队列 + 提交 + 推送（不等值守，排障首选）
.\code\local-runner.ps1 -DryRun      # 只看会跑什么（不改任何文件）
.\code\local-runner.ps1 -DrainOnce   # 排空一轮（值守 local_check.ps1 用的就是这个）
.\code\local-runner.ps1 -SelfTest    # 纯逻辑自检
node scripts\local-runner-validate.mjs --job local-runs\jobs\<jobId>.job.json   # 校验 job
```

本体是 `code/local-runner.mjs`（Node，零依赖）；`.ps1` 只是定位 node 的薄包装。
挂钩自己的原始记录在 `results/status/local-runner-drain.txt`（含 CWD / node 路径 / 队列内容 / exit）；
排障报告在 `results/status/diagnose-watcher.txt`（`code\diagnose-watcher.ps1` 生成）。
设计说明、CLI 解析顺序、本机策略键、退出码含义见 `docs/local-runner-protocol.md` 第 10 节。

## 相关命令（本机）

```powershell
.\hardware.ps1 -Deep          # 让沙箱知道本机 GPU / conda / PATH（沙箱开工前先读这份）
.\watch.ps1 -Register -Interval 2   # 值守：发现请求 → 拉取 → 执行队列 → 回传判定
.\watch.ps1                   # 手动跑一轮（立即处理当前请求）
.\doctor.ps1                  # 出问题先体检（-Fix 一键修）
```

## 相关命令（Arena 会话）

```bash
bash skills/git-sync/scripts/agent-sync.sh "feat(job): <jobId>"        # 提交 job
bash skills/git-sync/scripts/agent-wait.sh --request "<jobId>" --auto-accept   # 派活并等结果
bash skills/git-sync/scripts/agent-hardware.sh                          # 读本机硬件报告
```
