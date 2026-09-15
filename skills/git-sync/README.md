# 本地 ↔ Agent 同步 skill —— 使用说明

> 目标是：**取、传、下载、打包、排障各一个命令**，不需要 git 知识；
> 一份配置（`sync.config.json`）驱动全部脚本，`agent-install.sh` 一条命令装进任何新仓库
> （新会话引导提示词在 `templates/new-session-prompt.md`，整段复制即用）。
> 仓库根目录放着同款脚本（`sync.ps1 / push.ps1 / upload.ps1 / download.ps1 / doctor.ps1 / pack.ps1 / bootstrap.ps1 / pr.ps1`），
> 这份 skill 是**通用版 + 说明书**。

## 一、最短用法（在仓库目录里）

```powershell
.\sync.ps1                                # 取：拉最新（本地有改动会自动 stash）
.\upload.ps1                              # 传：附件归位到 sources\ code\ results\ 后 commit + push
.\push.ps1 "说明"                          # 传：直接提交推送（拒绝推 main）
.\push.ps1 -Gate "说明"                    # 同上，但提交前本机也跑一遍自检（需 bash，装 Git 就有）
.\download.ps1 -Set final                 # 下载：把 deliverable\ 等目录镜像到本机
.\download.ps1 -Set final -Since 2026-09-14   # 只复制该日期之后变过的文件（先 .\sync.ps1）
.\download.ps1 -Folders deliverable,examples\x # 临时指定目录下载（不用改配置）
.\download.ps1 -List                      # 看有哪些集合
.\pack.ps1 -Set final                     # 打包：生成 _export\20260914_2030_final.zip
.\doctor.ps1                              # 体检：环境 / 分支 / 远端 / 未提交 / stash / 大文件 / 版本
.\doctor.ps1 -Fix                         # 一键修复：重建 refspec + stash + 切回分支 + 拉取
.\hardware.ps1 -Deep                      # 采集本机硬件/conda环境报告并推送（每台机器一次；变化后重跑）
.\watch.ps1 -Register                     # 自动验证循环：注册本机值守任务（每2分钟；-Interval 10 可改）
.\pr.ps1                                  # 开 PR：工作分支 -> main（需 GitHub CLI）
```

助手那一侧（本仓库的 `skills/git-sync/scripts/`）：

```bash
bash skills/git-sync/scripts/agent-sync.sh "feat: xxx"     # 守卫 + fetch + 自检 + 回执 + commit + push
bash skills/git-sync/scripts/agent-sync.sh --status        # 只看状态，不动文件
bash skills/git-sync/scripts/agent-hardware.sh             # 读本机硬件报告（超 30 天提醒重跑）
bash skills/git-sync/scripts/agent-check.sh --request "验证X"  # 请求本机自动检查（自动验证循环）
bash skills/git-sync/scripts/agent-wait.sh --request "验证X"   # 请求 + 原地等结果（一轮对话内闭环）
bash skills/git-sync/scripts/agent-wait.sh --request "X" --auto-accept   # 通过即自动收尾
bash skills/git-sync/scripts/agent-check.sh --read         # 读本机检查结果（0=过/2=败/3=等）
bash skills/git-sync/scripts/agent-check.sh --accept       # 通过且满意 → 收尾，循环不再触发
bash skills/git-sync/scripts/agent-recover.sh              # 沙箱 .git 被重置后的恢复
bash skills/git-sync/scripts/agent-pr.sh --dry-run         # 开 PR（--dry-run 只打印）
bash skills/git-sync/scripts/agent-pr.sh --checks          # 看 PR 的 CI 状态
```

## 二、脚本与配置

| 文件 | 说明 |
|---|---|
| `sync.config.json` | **唯一的配置**：`branch` / `remote` / `download_dir` / `download_sets` / `upload_map` / `gate` / `receipt` |
| `VERSION` | 技能版本号；`doctor.ps1` 和安装器都会显示，升级对账用 |
| `scripts/sync.ps1` | 拉取；配置查找：`-Config` 参数 > `sync.config.<GIT_SYNC_PROFILE>.json` > 仓库内 `skills\git-sync\` > 脚本旁边 |
| `scripts/push.ps1` | 提交推送；**拒绝推 `main` / `master`**；`-Gate` 提交前本机也跑一遍自检 |
| `scripts/upload.ps1` | 附件归位：扩展名 → 目录映射取自 `upload_map`，也可 `-Ext`/`-Dest` 临时指定 |
| `scripts/download.ps1` | robocopy 镜像下载；`-Set` 选集合，`-Mirror` 完全镜像，`-Since <日期>` 增量，`-Folders a,b` 临时指定目录 |
| `scripts/pack.ps1` | 压缩包交付；输出到 `_export\`（已在 `.gitignore` 里，不会被推送） |
| `scripts/doctor.ps1` | 体检报告 + 技能版本 + LFS/大文件检查；`-Fix` 一键修复；ahead/behind 对比的是 `origin/<分支>`（修复了老版本永远显示 0 的 bug） |
| `scripts/hardware.ps1` | **本机硬件/环境上报**：OS、CPU、内存、GPU（nvidia-smi 优先，含显存/算力/CUDA 驱动）、磁盘、conda/mamba 环境列表与各环境 python，`-Deep` 再探测每个环境的 torch + CUDA；写入 `hardware_dir`（latest.md/latest.json + 历史快照）并推送 |
| `scripts/watch.ps1` | **自动验证循环本机侧**：`-Register` 注册计划任务（默认 5 分钟轮询），发现 agent 的检查请求就自动 sync → 跑 `check_cmd` → 日志落盘 → 推回 passed/failed；`-Unregister` 摘除 |
| `scripts/bootstrap.ps1` | 首次准备：执行策略、git 身份、fetch、切分支、首拉 |
| `scripts/pr.ps1` | GitHub CLI 开 PR / 查 CI；`-Base` 换目标分支，`-Checks` 看检查状态 |
| `scripts/install.ps1` | 装到另一个仓库：`.\install.ps1 -Target C:\MyProject -Branch main`（目标已有配置时只动 branch，其余保留） |
| `scripts/agent-sync.sh` | 助手侧一键：分支守卫 → fetch → 发散自愈 → gate → **写同步回执（并按日期归档）** → commit + push |
| `scripts/agent-hardware.sh` | 助手侧读本机硬件报告；缺失/超 30 天会提示让用户跑 `.\hardware.ps1 -Deep` |
| `scripts/agent-check.sh` | **自动验证循环助手侧**：`--request` 请求本机检查（round+1）/ `--read` 读结果（exit 0=过 2=败 3=等）/ `--accept` 通过收尾 |
| `scripts/agent-pr.sh` | 助手侧开 PR / 看 CI |
| `scripts/agent-recover.sh` | 助手侧修复：`.git` 被重置回基线提交时，保住工作区把 HEAD 挪回分支 |
| `scripts/agent-install.sh` | **一条命令装进任何仓库**（见第六节） |
| `templates/check_all.sh` | 通用 gate 模板（ASCII + 分支守卫 + 根目录/skill 脚本一致性） |
| `templates/gate.yml` | GitHub Actions 模板：push 后自动跑 gate |
| `templates/new-session-prompt.md` | **新会话引导提示词模板**：整段复制到新 Arena 对话即完成安装与验收 |
| `templates/local_check.ps1` | **本机自检模板**（装到 `code\local_check.ps1`，只建不覆盖）：默认跑 gate + 扩展点，`watch.ps1` 请求检查时执行的就是它 |
| `templates/local-runner.md` | **本机即 Runner 配方**：自动验证循环的推广用法——任务在真实本机环境执行、产物自动回传（AgentArena 整合的理论基础） |
| `templates/health.yml` | GitHub Actions **每日体检**：握手卡死 / 硬件报告过期自动开 issue；定时只跑默认分支，从本机复制到 main 并改 `BRANCH` 启用 |

同步回执：助手每轮 `agent-sync.sh` 会把"纳入了你哪些提交、这轮改了哪些文件"写进配置里
`receipt` 指定的文件（默认 `results/sync/last_sync.md`），同时把带时间戳的副本归档到
`receipt_history` 目录（默认 `results/sync/history/`，自动保留最近 50 份），你 `.\sync.ps1`
之后打开就能看到。

硬件报告：你跑一次 `.\hardware.ps1 -Deep`，agent 之后用 `agent-hardware.sh` 就能看到
本机 CPU/内存/GPU（型号/显存/算力/CUDA 驱动）/磁盘/conda 与 mamba 环境列表、每个环境的
python 版本、哪个环境的 torch 能用 CUDA——计算类工作开工前先对表。

自动验证循环（v2.3）：本机 `.\watch.ps1 -Register` 一次（计划任务，每 2 分钟轮询）；
之后 agent 每轮完工 `agent-check.sh --request "验证X"` → 你本机**自动** sync → 跑
`check_cmd`（默认 `code\local_check.ps1`，可改）→ 日志落 `results\status\check_rN_<时间>.txt`
→ 把 passed/failed 推回分支；agent `--read` 读结果（0=过/2=败/3=等），败了修了再来一轮，
过了且满意 `--accept` 收尾——**循环由 handshake 文件驱动，收尾后值守静默待命**。
详见 SKILL.md 第 8 节。

## 三、为什么 `.ps1` 里绝对不能写中文

Windows PowerShell 5.1 读**没有 BOM** 的 `.ps1` 时按 **ANSI/GBK** 解码；UTF-8 的中文注释会变成乱码，
乱码里一旦出现引号就会把后面的字符串吞掉，报 `字符串缺少终止符` / `InvalidArgument`。
约定：**`.ps1` 只用 ASCII，中文只出现在 `.md` / `.json`**；
gate（`code/check_all.sh`）提交前自动扫描全部 `.ps1`，非 ASCII 直接 FAIL（本机侧 `.\push.ps1 -Gate` 也跑同一套）。

中文目录名（如 `中间版`）因此**只写在 `sync.config.json` 里**，脚本用 `Get-Content -Encoding UTF8` 读取，
再拼路径——这样既有中文目录，又不会有 GBK 问题。

所有 `.ps1` 从脚本位置**自动上溯找仓库根**（有 `.git` 的目录），所以放在根目录或
`skills\git-sync\scripts\` 里都能直接运行。

## 四、三道安全阀

1. **分支守卫**
   * `push.ps1` / `pr.ps1` / `agent-pr.sh`：分支是 `main` / `master` 直接拒绝；
   * `agent-sync.sh`：HEAD 与配置里的分支不一致就退出（不会误推到别处），并且只 `git push origin <配置分支>`。
2. **提交前自检（gate）**
   `sync.config.json` 的 `gate`（默认 `bash code/check_all.sh`）失败时 `agent-sync.sh` **不提交**，
   因此远端历史里的每个提交都是自检通过的；本机侧想同样把关就 `.\push.ps1 -Gate`。
3. **远端 CI（可选）**
   `templates/gate.yml` 装到 `.github\workflows\` 后，每次 push 在 GitHub 上自动跑同一套 gate。
   注意：GitHub App 类的 agent 令牌往往**没有 workflows 权限**，推不动这个目录——
   这时由本机侧启用（你的凭据可以）：

   ```powershell
   New-Item -ItemType Directory -Force .github\workflows | Out-Null
   Copy-Item skills\git-sync\templates\gate.yml .github\workflows\gate.yml
   .\push.ps1 "ci: enable gate workflow"
   ```

## 五、故障对照表

| 现象 | 处理 |
|---|---|
| `running scripts is disabled` | 跑一次 `.\bootstrap.ps1` |
| 要密码 / 认证失败 | GitHub 不接受密码：`gh auth login` 或 GitHub Desktop |
| `Updates were rejected`（远端有新提交） | 先 `.\sync.ps1`，再 `.\push.ps1` |
| `pull --ff-only` 失败（本地有分叉提交） | `.\doctor.ps1` 看状态；或 `.\doctor.ps1 -Fix` |
| 本地改动"消失"了 | 多半在 stash：`git stash list` → `git stash pop` |
| 下载后文件是旧的 | 先 `.\sync.ps1` 再 `.\download.ps1`；只要增量加 `-Since <日期>` |
| 想下的目录不在集合里 | `.\download.ps1 -Folders <目录1>,<目录2>`，或改进 `download_sets` |
| robocopy 返回 1—7 | 正常（有文件被复制 / 无变化 / 有额外文件），只有 ≥8 才算失败 |
| 想看这轮助手到底改了什么 | `.\sync.ps1` 后打开 `results\sync\last_sync.md`（历史回执在 `results\sync\history\`） |
| Agent 不知道本机算力/该用哪个环境 | 本机 `.\hardware.ps1 -Deep`；agent 侧 `agent-hardware.sh` 读取（超 30 天自动提醒） |
| **助手侧**工作区正常但历史回到基线提交 | `bash skills/git-sync/scripts/agent-recover.sh` → `agent-sync.sh` |

## 六、装到别的项目 / 给已装过的仓库升级

**新 Arena 会话**：打开 `templates/new-session-prompt.md`，把第一节的提示词整段复制进对话即可
（含安装命令、成功标志、本机步骤、双向验收）。

**助手侧 / 手动（一条命令）**：

```bash
git clone --quiet --depth 1 -b arena/01a09fc1-git-pull-arena \
     https://github.com/mqgg5630-cyber/git-pull-arena.git /tmp/git-sync-src \
  && bash /tmp/git-sync-src/skills/git-sync/scripts/agent-install.sh --branch <工作分支>
```

（技能合并进 main 后把 `-b` 换成 `main`；也可以 `--gha` 顺带装 CI。）

**本机侧**（比如升级另一个已有配置的仓库）：

```powershell
.\skills\git-sync\scripts\install.ps1 -Target E:\0github\git-sync\<目标仓库> -Branch <它的分支>
cd E:\0github\git-sync\<目标仓库>
.\push.ps1 "chore: upgrade git-sync skill"
```

三种方式**都保留目标仓库已有的 `sync.config.json`**（只更新分支、补缺失的键），
所以**升级已装过的仓库 = 再跑一遍安装命令**；装完 `.\doctor.ps1` 看 `skill` 一行即可对账版本。

## 七、多会话协作模式（多个 Arena 会话 × 本地）

铁律先行：**一个会话一个分支**（Arena 给每个会话自动建 `arena/<id>-仓库名>` 分支，这是天然隔离边界）；
会话之间不能直接对话，**git 是唯一的总线**（提交 / 文件 / PR）。

| 模式 | 结构 | 冲突风险 | 适用 |
|---|---|---|---|
| **A 一会话一仓库**（默认） | 每个会话一个仓库；本机一仓库一个克隆文件夹 + 一个值守 | 无 | 彼此独立的项目（现状：技能总部 / PPT 项目 / AgentArena） |
| **B 同仓库多分支分任务** | 同一仓库开多个会话（各占一个分支）；本机**每个分支一个克隆文件夹**（`<repo>-a`、`<repo>-b`），各注册值守 | 只在 merge 时可能出现内容冲突（正常解决） | 同一项目的多任务并行 |
| **C 汇总会话**（release-manager） | 一个专职会话守集成分支（main / integration）：fetch 其他会话的分支 → merge → gate → `agent-wait --auto-accept` 让本机真机回归 | 由汇总会话统一处理 | 3 个以上会话，或任务间有依赖 |

关键事实：

* **同一条分支被两个会话同时推 = 必冲突**，不要这么用（Arena 自动分会支已天然避免）；
* 同仓库不同分支互不干扰：gate / 回执 / 握手全是分支内文件，值守任务名按文件夹命名不会撞；
* **一个本地文件夹不能同时检出两个分支**——模式 B 就一分支一个克隆（想省磁盘可用 git worktree，但脚本按"文件夹=仓库"设计，不推荐混用）；
* `hardware.ps1` 每个克隆各跑一次即可（或用 `GIT_SYNC_PROFILE` 共享一份配置）；
* 模式 C 的汇总会话自己会 fetch 同仓库的其他分支，**你不需要当传声筒**；合并质量由"本机真机回归"把关——这正是自动验证循环的第二种用法。

## 八、扩展清单

已实现：

- [x] 取 / 传 / 下载 / 打包 / 体检 / 首次准备 / 复用安装 / 开 PR 八类命令
- [x] 配置化：分支、远端、下载集合、扩展名归位、gate、回执路径
- [x] 分支守卫 + 提交前自检（gate）+ 可选 GitHub Actions 远端 CI
- [x] 助手侧 `agent-sync.sh`（含发散自愈、**同步回执**）与 `agent-recover.sh`（沙箱重置恢复）
- [x] `doctor.ps1 -Fix` 一键修复；ahead/behind 改为对比 `origin/<分支>`
- [x] `download.ps1 -Since <日期>` 增量下载；`-Folders` 临时指定目录
- [x] 多环境 profile（`GIT_SYNC_PROFILE` / `-Config`）
- [x] `agent-install.sh`：任何仓库一条命令安装/升级（保留配置）
- [x] 新会话引导提示词模板（`templates/new-session-prompt.md`）
- [x] `push.ps1 -Gate`：本机侧提交前也跑同一套自检
- [x] 版本标识（`VERSION`）+ `doctor.ps1` / 安装器显示版本
- [x] 回执按日期归档（`receipt_history`，自动保留最近 50 份）
- [x] 本机硬件/环境上报（`hardware.ps1` / `agent-hardware.sh`：GPU/CPU/内存/磁盘/conda/mamba/torch+CUDA）
- [x] **自动验证循环**（`agent-check.sh --request/--read/--accept` + `watch.ps1` 值守 + `local_check.ps1` 模板）：agent 干完 → 本机自动检查回传 → 直到 agent 满意收尾
- [x] `agent-wait.sh --auto-accept`：通过即自动收尾（"干完→验证→关闭"一条命令）
- [x] 本机即 Runner 配方（`templates/local-runner.md`）+ GitHub Actions 每日体检（`templates/health.yml`：握手卡死/硬件过期自动开 issue）
- [x] 安装器：根目录精简安装（无 skills 夹）的 `sync.config.json` 升级时同样保留（AgentArena 场景）
- [x] 安装器补漏：`hardware.ps1` / `watch.ps1` 进根目录复制清单（v2.2 漏 hardware，由另一 Arena 会话实战发现）
- [x] LFS / 大文件体检（>50 MB 提醒）

还想加的（按需）：

- [ ] 实验环境快照：`hardware.ps1 -Deep` 顺带把各环境 `pip freeze` / `conda env export` 存进 `results\hardware\envs\`（复现实验用）
- [ ] `agent-sync.sh` 自动 `git lfs install` + push 前 `lfs status` 检查（真有大文件时）
- [ ] 数据集清单与校验和：`dataset-manifest`（目录 + md5 + 大小），换机器核对数据没变
- [ ] 定时同步：`schedule.ps1` 注册 Windows 计划任务，每小时自动 `.\sync.ps1`
- [ ] 增量清单进回执（`-Since` 语义写进 `last_sync.md`）
