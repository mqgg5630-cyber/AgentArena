# 新会话引导提示词（复制粘贴即用）

> 用途：在一个**新的 Arena 会话**里，把 git-sync 技能装进它当前的工作分支，
> 建立与本机的双向同步。
> 本文件就在技能里（`skills\git-sync\templates\`），所以任何装好技能的仓库都随身带着它——
> 换新会话时打开这个文件照抄即可，不用再问人要提示词。
> 来源默认指向 git-pull-arena 的 arena 分支；该技能合并进 main 后，
> 把下面的 `-b` 与分支说明换成 `main` 即可。

---

## 一、粘贴给新会话的部分（从下一行开始复制）

```text
请把 git-sync 技能安装到本仓库当前工作分支，作为你我双向同步的工具。
技能来源：https://github.com/mqgg5630-cyber/git-pull-arena 的
arena/01a09fc1-git-pull-arena 分支（skills/git-sync）。

1) 安装（在仓库根目录执行；不带 --branch 会自动装到你当前的工作分支）：

git clone --quiet --depth 1 -b arena/01a09fc1-git-pull-arena https://github.com/mqgg5630-cyber/git-pull-arena.git /tmp/git-sync-src && bash /tmp/git-sync-src/skills/git-sync/scripts/agent-install.sh

2) 提交推送（自带分支守卫 + 提交前自检 + 同步回执）：

bash skills/git-sync/scripts/agent-sync.sh "feat: install git-sync skill"

3) 装完先读 skills/git-sync/README.md 和 SKILL.md 再开始干活；
   以后每轮工作结束都用第 2 步的命令提交推送，我本机用 .\sync.ps1 拉取。
   计算/训练类任务，先看 results/hardware/latest.md 了解我的本机硬件
   （还没有就提醒我在本机跑一次 .\hardware.ps1 -Deep，或运行
   bash skills/git-sync/scripts/agent-hardware.sh 查看报告与新旧）。
   需要我在本机机器上验证的改动，推送后运行
   bash skills/git-sync/scripts/agent-wait.sh --request "要验证什么"
   ——它会发起请求并原地轮询（默认最多 10 分钟），我本机的值守任务会自动
   同步、跑自检、把结果推回来；退出码 0=过 / 2=败 / 3=超时未响应。
   一轮对话里就能完成"请求→等待→读结果→（修复→再来）→收尾"整个循环；
   通过且满意就 agent-check.sh --accept 收尾。

4) 执行完 1、2 两步后，回复我：
   - 本仓库的 GitHub 地址（git remote get-url origin 的结果）
   - 当前分支名（git rev-parse --abbrev-ref HEAD 的结果）
   - 我本机该用的 git clone 命令
```

（复制到上一行为止）

**成功的标志**：安装输出四行 `OK: ...`（技能 / 配置 / 根目录脚本 / gate）+ `== committed:` + `== done:`。

## 二、你本机的部分（等它回复仓库和分支名后）

```powershell
cd E:\0github\git-sync
git clone -b <它告诉你的分支> https://github.com/mqgg5630-cyber/<它告诉你的仓库>.git <新子文件夹名>
cd <新子文件夹名>

.\bootstrap.ps1     # 身份 / 切分支 / 首拉
.\doctor.ps1        # branch 应为那个分支，in step with the remote
```

## 三、双向验收（两小步）

1. **方向 1（agent → 本机）**：让它随便改一个文件并用 `agent-sync.sh` 推送
   → 你本机 `.\sync.ps1` 看得到 = ✅
2. **方向 2（本机 → agent）**：你随便改一个文件 → `.\push.ps1 "test: local -> arena"`
   → 让它跑一次 `agent-sync.sh`，回执 `results\sync\last_sync.md` 里
   「本轮纳入的**本机侧**提交」列出你的提交 = ✅

## 四、给已经装过技能的仓库升级（配置不丢）

在新会话里执行**同一条**第 1 步安装命令即可——`agent-install.sh` 检测到已有的
`sync.config.json` 时只更新分支、补缺失的键，下载集合 / 归位规则 / gate 全部保留。
可以用 `.\doctor.ps1`（会显示 skill 版本）确认升级到了新版本。
