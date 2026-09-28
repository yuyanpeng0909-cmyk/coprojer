# 长任务无进展保护与 GLM-5.3 实跑

日期：2026-09-28，Asia/Shanghai。本记录保留截至 23:47:41 的开发与实跑快照，区分宿主修复、受控回归、真实供应商调用和番茄钟功能验收；该轮未提交或发布，后续源码发布见[发布验证](2026-09-28-release.md)。公开记录省略本地项目、连接和成员的内部标识。

## 问题

番茄钟“最小化到托盘后台运行”在 22:18:16—22:40:50 的开发中耗时约 22 分 34 秒。该轮 37 个模型请求累计约 20 分 25 秒，另有反复诊断和失败命令。36 步耗尽后，模型明确说原生交互仍未完成，宿主却把普通进度总结当作开发交付，推进独立验证。摘要嵌套已另行修复，但无法阻止这种无进展循环或错误交付。

诊断快照：.runtime/execution-diagnosis/2026-09-28-2234.json。不能凭本次单一工程推断某个模型的整体能力排名。

## 已落地修复

- 开发提示要求 status / summary / nextStep JSON。预算内显式 incomplete 或空回复保存断点并暂停；即使 incomplete 报告缺少 summary/nextStep，也不能回退成普通文本交付。预算末尾必须为有效 complete JSON 才能提交。为兼容既有接口，预算内普通非空开发文本仍保留 legacy completion 支持，不保证识别所有自然语言的“未完成”。
- 新增 ExecutionProgress：比较工具名称、规范化参数、结果与工程版本；相同失败请求达到 3 次，或连续 5 次重复工具调用没有新信息/实际修改时暂停。命令比较忽略 runId、evidenceId、耗时等动态元数据。
- 新文件版本、不同分页和真实修改视为进展。只持久化有限数量哈希/计数，不再复制长工具历史。
- 在完整工具 batch 所有结果配对并保存后才暂停，保留原生签名块、命令台账和恢复计数；不会因暂停提前丢弃同一 batch 的后续结果。
- 保留固定预算、验证职责和人工验收要求。保护是有限停止机制，不保证模型自行解决所有业务或环境障碍。

生产入口：src/main/engineering/execution-progress.ts、execution.ts、service.ts。目标改动前副本保存在 .runtime/execution-convergence/baseline/，不把工作区其他既有改动计为本轮实现。

## 验证

新增 scripts/execution-convergence.cjs 先复现 4 项失败，修复后初版 9 项全部通过。后续发现 incomplete 报告缺少 nextStep 时错误回退成 legacy 交付；新增用例先观察到实际进入 acceptance（预期 blocked），修复后共 10 项全部通过：预算末尾未完成不得交付、预算内 incomplete、不完整的 incomplete 报告、重复读取保护、重复失败保护、真实进展不过早暂停、文件新版本、complete 正常流转、重启保留计数且不重放、完整多工具 batch。

以下关联检查通过：execution-budget、long-task-context、verification-live-regressions、verification-preparation、verification-evidence、reasoning、model-errors；npm run typecheck 和 npm run build 通过。新回归已加入 npm test 与 test:verification。本轮未重新运行完整 npm test。

原有预算测试改用不同文件消耗步骤，避免被正确的无进展保护提前截停；仍覆盖开发 36 步和准备 12 步边界。verification-preparation 曾因桌面环境指纹变化触发重新诊断，环境稳定后完整重跑通过，未移除生产环境指纹检查或通过 mock 隐藏变化。

日志：.runtime/execution-convergence/ 下对应 *.log、before.log、execution-convergence.log、build.log。

补充字段边界失败复现：partial-incomplete-before.log（10 项中 1 项失败）。补修后的 execution-convergence.log（10 项全部通过）及 build.log 均已重新生成；build 包含 typecheck。

## 模型切换与真实执行

按用户指定，当前功能开发与验证改用已经接入的 glm-5.3，保持有效推理配置 Max；项目专用成员分别继承原开发/验证技能。未修改全局智能体、其他项目、连接凭据或用户验收结果。

- 项目与功能：番茄钟助手，最小化到托盘后台运行。
- 已接入型号：glm-5.3；开发与验证分别使用项目专用成员，保留原有技能。
- 23:14:35 首次真实请求已使用 glm-5.3，请求 17,024 字符，没有旧摘要标记。
- 23:17:41 第 17 步的重复读取被新保护截停，完整断点留存。补齐成员技能并加入接续资料后，23:27:02 通过公开 runFeature 接口继续独立验证。配置指纹变化正常触发新验证会话；未清空用户检查记录或手工改写通过状态。
- 第二轮实际通过 typecheck、55 项单测与 build，23:28:25 启动 npm run test:tray:native；该命令运行 102.367 秒后退出 1：`initial: tray icon not found via UIA`，`taskbarButtonNames` 为空。随后两个已有诊断脚本成功运行；Win32 能找到 Shell_TrayWnd，但该 PowerShell 的 UIA RootElement 读取出现空值，不能据此判定托盘图标未创建，也不能判定原生交互通过。
- 第二轮 21 个真实 glm-5.3 请求中，20 个返回成功、1 个由操作者取消；20 个已完成请求累计 680.377 秒，最长单次 247.714 秒。后半段又反复阅读诊断脚本，并发生长时间模型推理。新保护只识别重复结果/重复失败，不保证识别所有交错的新读取或长时间单次推理。
- 23:44:18，在 UIA 阻塞已有明确检查证据、后续继续消耗的情况下，通过现有 stop 接口主动停止。此轮没有自然产出 reviewer 最终报告；停止不是模型判定已完成，也不是本轮自动保护触发。没有伪造通过结果或代为人工验收。
- 23:46:49 应用重启完成，加载包含 incomplete 缺字段修正的最新构建；不自动重跑。23:47:41 同时检查磁盘与公开 state 接口：activity=null、stage=blocked；reviewer 的 20 个已完成步骤、六条命令台账及 checkpoint 对象与重启前逐项一致。开发/验证均仍绑定项目专用 glm-5.3，技能保留。

第二轮六次上下文整理后，当前工作消息只有一个扁平摘要标记、没有旧嵌套摘要标记；完整历史依赖归档而非全量驻留。最后一次实际请求字符 112,280 → 33,585。这不是精确 token 统计，也不证明模型会有效利用压缩摘要。

当前应用已重启并加载上述修复构建。可见测试无法可靠识别 Windows 1 号非主屏，依项目约定回退主屏；使用独立测试资料，不覆盖番茄钟用户数据。

模型切换和技能记录：.runtime/execution-convergence/model-switch.json、skill-preservation.json。用户状态备份：%APPDATA%/Coprojer-dev/execution-fix-backups/20260928-225003/。

最终实跑证据：.runtime/execution-convergence/glm53-final-result.json、glm53-traffic.json、final-restart.json、live/restart.jsonl。最新构建 main bundle SHA256：a5be8147ed5c616a500e5ae4856b338bc99831e37938ddf5533edf9a8524d5a1。重启前资料完整备份为上述备份目录的 after-glm53-before-final-restart.json。

## 交接边界

上下文扁平化和三协议恢复见 [长任务中断记录](2026-09-28-long-task-context.md)。供应商无关的完整上下文/工具状态机设计仍留待新对话。真实托盘悬停、菜单鼠标输入、退出进程证据不得由历史 JSON、单测或直接调用菜单回调替代；最终用户验收不自动代为确认。

当前未完成的是番茄钟的原生桌面验证及 reviewer 最终报告，下一步应针对 UIA 可访问性或现有 Win32 备用检查工具做有依据的修复，再由独立验证重跑。不要清空历史、反复点击继续、直接修改通过状态，或把只切换模型当作验证成功。
