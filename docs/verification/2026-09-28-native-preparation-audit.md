# 自动补齐验证条件：番茄钟真实路由审计

本记录对应 2026-09-28 的补充修复。早先 pomodoro-live 文档保留为历史资料，不作为本轮自动通过依据。范围为 Windows、短时检查、完整隔离番茄钟副本、独立用户目录；不改原项目，不做完整 25 分钟或 macOS 检查，不提交最终人工验收。

## 原始报告定位

从本机 C:\Users\25758\AppData\Roaming\Coprojer-dev\engineering-v1.json 只读提取。项目 dda88f47-0231-467e-a31b-6782ece970be，功能 b6ac7e29-d0a5-489a-8de4-e2d52655f870「最小化到托盘后台运行」，repairRound=3。本轮 check-1 至 check-6 的源码指纹为 7221723e97ac27f25369fe6578ba4bc544e6d32280ab6224a3bdcca19643853d。完整脱敏快照保留在 .runtime/native-preparation-audit/original-latest-report.json；本目录 2026-09-28-native-preparation-original.json 保留精确报告正文与六条命令输出。

下表时间为 UTC，本地显示时间为 UTC+8：

| ID | 时间 | 命令 | 实际结果与边界 |
|---|---|---|---|
| check-1 | 07:17:29 | npm run typecheck | exit 0 |
| check-2 | 07:17:36 | npm test | exit 0，原始输出确实是 55/55，非旧轮次 53/55 |
| check-3 | 07:17:40 | npm run build | exit 0 |
| check-4 | 07:18:09 | npm run test:tray:evidence | exit 0，但读取 05:13 的旧工件，只用于追溯 |
| check-5 | 07:18:31 | npm run test:tray:smoke | exit 1，tray-runtime.cjs:93 前台窗口可见性断言失败；后台完成 |
| check-6 | 07:24:12 | npm run test:tray:smoke | exit 0，两个并行实例，各测试 5 秒 |

### 报告更正依据

| 模式 | 单实例连续测量 | 持久化阶段切换延迟 | 外部观察阶段切换延迟 |
|---|---:|---:|---:|
| foreground | 5 秒 | 179 ms | 242 ms |
| background | 5 秒 | 303 ms | 322 ms |

数据来自 check-6 原始 JSONL。measuredDurationSeconds=10 将并行时长相加，口径错误。242/322 是前台/后台外部观察延迟，不是持久化延迟；不与后续新运行数据混用。

check-5 与 check-6 都保留。重跑成功不足以确定首次失败是环境瞬态。并行实例、焦点/可见性和窗口事件的因果关系未确定，不写为“不是应用缺陷”。

原退出检查收集主 PID 与 app.getAppMetrics 返回的 PID，再执行 process.kill(pid, 0) 存在性探测；这不是完整系统进程表检查。原脚本把所有异常都当不存在，不能排除 EPERM 等情况。本次补充检查只有 ESRCH 记为 absent，其余异常为 unknown。原项目脚本保持原样。

重复前缀在持久化 review 事件中只有一份。旧构建的真实 Electron 回归复现了 summary 显示第一行、展开 pre 又显示全文的重复。修复只改摘要，正文及合法重复词原样保留。

## 根因与修复

原 service.ts 用 !failedCheck 包住整个验证准备分支。虽然报告留下两个 unverified 项，check-5 仍在台账，因此准备 round=0、gaps=[]，直接在代码修复上限停止，没有进入当前环境诊断。另一个实测问题是原 5 秒 PowerShell/UIAutomation 探测在本机超时，不能据此认定整机不具备自动桌面能力。

修改集中于 service.ts、verification.ts、execution.ts、files.ts、共享工程类型及两个验证界面组件：终端修复失败不挡独立缺口；记录当前环境及命令 runId；准备文件变化仍保留旧失败；从本轮 JSONL 约束时长和延迟；回调证据不能重标为真实输入；过期环境断点重新诊断，预算不重置。沿用原角色、串行计划及人工验收关卡，没有重写执行引擎。

## 真实验证方式

本地确定性模型夹具只决定角色回复和工具选择。准备者通过生产文件工具实际创建补充脚本，验证者通过生产命令工具启动新进程；typecheck、单测、build、原应用 Electron 冒烟、UIAutomation/Win32 探测都实际运行。准备者文字不代表通过。结果不代表收费模型的开放式任务成功率。

系统探测识别 DISPLAY1 为非主屏。一般 Electron 测试在该屏首次显示；当前 Windows 通知区位于主屏 Shell_TrayWnd，因此原生托盘检查按项目约定回退主屏，并在首次显示前定位自己的窗口，不移动其他应用。输入前核对本次 Tray 的 bounds、Shell PID、UIAutomation/MSAA 名称和可见性，不能可靠定位时不点击。完整最大化应用截图与目标托盘/菜单局部证据分别保留。

本轮遇到测试启动器重定义 Electron 导出、窗口类名识别、两个显示器启动器嵌套问题，均是新增验证基础设施问题，保留日志并修复，不归因给番茄钟业务。单独诊断还记录了真实悬停后未取得 tooltip，以及折叠托盘被其他窗口遮挡；这些记录不能写成桌面验证通过。

## 本轮结果

最新命令、源码/构建 SHA256、隔离运行 runId、完整原项目哈希核对、截图及分层状态见[机器记录](2026-09-28-native-preparation-results.json)。最后一次完整隔离复验为 .runtime/native-preparation-audit/isolated-88qoSR；开始前逐文件校验完整复制的 2482 个文件，差异为零。

准备阶段实际创建五份补充检查资料；独立验证阶段随后启动新命令。原修复轮次仍为 3，准备使用 1/2 轮。最终状态是 blocked：2 项 passed、2 项 unverified，并保留原 check-5 的未解决失败。没有清空预算或自动提交验收。

| 本次独立命令 | runId | 结果 |
|---|---|---|
| node tests/coprojer-smoke-check.cjs | f07e9ff5-b3f9-4d0d-b339-445f4eb276c4 | exit 0，实际前台/后台应用短测 |
| node tests/coprojer-desktop-check.cjs | 6d9698f9-7398-484f-bf94-8211aa971d12 | exit 1，指针输入被打断，技术阻塞 |

同一隔离轮次在准备前还新执行了 typecheck、55 条单测、build，均 exit 0。它们的 command ID 只在各自 reviewer 阶段内解释；原始命令、时间和输出全部保存在机器记录的 executions 中，不能与历史 check-1 至 check-6 混用。

| 本次模式 | 单实例测量 | 持久化延迟 | 外部观察延迟 |
|---|---:|---:|---:|
| foreground | 5 秒 | 290 ms | 364 ms |
| background | 5 秒 | 358 ms | 432 ms |

本轮原生检查实测确认 Default 交互桌面、UIAutomation/MSAA、Win32 输入与截图能力可用，并按 Shell PID、名称和本次 Tray bounds 定位到目标图标。真实发送了展开通知区与移动指针的输入。悬停期间指针应在 (1592,900)，实际变成 (1227,803)，因此停止，**没有继续右键或点击菜单，也没有宣称气泡和菜单验收通过**。最小剩余条件是短时、不受其他输入打断的桌面检查时段；这是技术输入条件，不是要求额外系统授权或让人手工点完验收。

先前一次稳定指针诊断出现“没有观察到 OS tooltip”的断言失败，原始工件仍在 isolated-qr8KeY 中保留，不能被本轮输入中断覆盖或解释为瞬态。源码每秒调用 refreshTray 并刷新图标、tooltip、菜单是可追查线索，尚未用受控实验确认其因果；未擅自修改原业务。观察器后来补充了 Win32 可见 tooltip 窗口读取，最新一轮仍因外部指针移动而无法完成观察。

退出清理后，对本次收集到的 5 个应用/子进程/探测进程 PID 探测结果均为 ESRCH。该证据仅覆盖已收集 PID，不宣称全系统没有残留。新检查器明确将 EPERM 等其他错误保留为 unknown。

### 代码与回归状态

- Coprojer 代码、构建、证据/执行预算/实际失败保留/准备编排/取消与重启/源码变化/重复无进展/进程清理回归通过。新增回归还覆盖终端修复失败与缺口共存、环境变更断点、回调输出重标、并行时长和四个延迟字段。
- 真实 Electron 验证准备及报告回归通过，实际检查 1280×840、860×600、最大化界面，未发现 renderer 错误；截图保存在本目录 native-preparation-2026-09-28。
- 完整 npm test 的原始一次执行在 research-smoke 出现 Target page closed，未声称该次全绿。此失败日志保留；完整 research-smoke 随后重新执行 exit 0，未修改断言。尚未执行到的 roundtable、decision、discussion-budget、novice 四个完整脚本逐个运行，均 exit 0。没有筛除失败用例，窗口关闭的因果未确认。
- 原番茄钟前后完整 2482 文件 SHA256 对比一致；原业务源码、测试、package.json、验收标准与任务开始前的修改均保留。只修改 Coprojer 的通用代码及其验证资料。
- 真实桌面验收仍未通过，最终人工验收未提交。已完成通用流程修复及实际验证，不能将其写成番茄钟功能全部通过。
