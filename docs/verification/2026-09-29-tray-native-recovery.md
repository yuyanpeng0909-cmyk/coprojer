# 番茄钟托盘实机验证恢复

日期：2026-09-29，Asia/Shanghai。范围是番茄钟助手的 Windows 短时托盘验证，接续 [长任务执行收敛修复](2026-09-28-execution-convergence.md)。不做 25 分钟精度测试、macOS 验证或自动人工验收；本轮未提交、推送或发布。

**最终状态：01:32:42，GLM-5.3 独立复验自然进入 acceptance（待用户试用验收），四项标准通过、活动为空。01:33:27 最终审计通过。** 最后一轮 01:28:18 开始，耗时 264.938 秒；一次原生输入超时后，同命令、同源码的实跑成功解除旧失败，并保留两次记录，没有再触发多余代码修复。

## 已确认的问题与修复

1. 本机 UIA 可以读取任务栏容器，但不暴露内部图标按钮。测试辅助脚本补充 MSAA 只读定位，所有操作继续使用 SendInput 真实鼠标输入，未用菜单回调替代原生点击。实际菜单窗口为目标进程的 `Chrome_WidgetWin_1`，不能只查找 `#32768` 或 `Chrome_WidgetWin_0`。
2. PowerShell 大小写不敏感，辅助类型的 `MOVE` 字段与 `Move` 方法冲突；方法改为 `MovePointer`。鼠标坐标按整个虚拟桌面归一化。
3. 应用原来每秒无条件替换图标、tooltip 和菜单，暂停时也刷新原生对象。`src/main/main.ts` 改为只更新发生变化的部分，新增重复刷新回归；先观察到用例失败，再修复至通过。
4. Windows 会将新图标从任务栏移到隐藏区。测试在实际悬停和右击前重新定位，点击菜单后立即移开鼠标，避免在下方其他图标上触发悬浮窗。对非目标浮窗遮挡给出明确失败，不把遮挡判成产品缺陷。shell 与 toolbar 可同时返回同一物理按钮，名称的倒计时可能跨秒改变；因此按矩形位置和尺寸去重，不把动态名称当作按钮身份。不同物理位置的多个候选仍拒绝点击。
5. 原脚本每一步启动 PowerShell 并编译辅助类型，扩大了坐标失效和桌面切换的窗口。现使用一个有界的 UTF-8 JSON 行会话，复用已加载的 Windows 辅助代码。单步仍有超时，整个原生流程上限 180 秒，成功或失败均清理测试应用和隔离资料。
6. 运行态 `remainingMs` 每 10 秒落盘，旧断言却要求它与实时 tooltip 相差小于 2.5 秒。改为用持久化 `endAt` 和采样时间计算实时期望值，保留 2.5 秒误差约束，并检查两次倒计时递减与实际经过时间相符。
7. 测试在首帧显示前路由测试窗口并最大化。当前只识别到主屏 DISPLAY5，按项目约定回退主屏。证据包含源文件和构建哈希，失败会覆盖权威 native-ui.json 的状态，避免旧成功记录掩盖新失败。
8. 复用辅助进程后，旧的启动开销不再隐式充当等待。恢复窗口检查现显式轮询 OS 可见窗口，最多 5 秒，避免 SendInput 返回后立即查询早于 Electron 显示窗口；仍只靠真实菜单点击触发恢复。

## 操作者实际验证

目标目录：`test/番茄钟助手`。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 5 个文件、56 项通过 |
| `npm run build` | 通过 |
| `npm run test:tray:native` | 通过，00:40:16–00:40:41，共 25.797 秒 |
| `npm run test:tray:smoke` | 前台、后台各 5 秒通过；实际周期切换落盘延迟分别为 436 / 446 ms |
| `npm run test:tray:evidence` | 当前源码与构建证据校验通过 |

原生链路真实读取暂停 tooltip `02:00`；鼠标打开菜单并点击“开始计时”；两次可见 tooltip 读到 `01:57` 和 `01:53`；隐藏窗口后通过真实菜单恢复；点击“退出”后，测试配置对应进程及记录的所有应用 PID 均无残留。前后台 smoke 使用 Electron API 回调，和上述真实鼠标证据分开记录。

原生结果：`test/番茄钟助手/verification/windows-tray/native-ui.json`。前后台结果：同目录 `smoke-foreground.json`、`smoke-background.json`。`native-ui-menu-open.png`、`native-ui-tooltip-running.png`、`native-ui-window-restored.png` 已逐张检查为最大化目标应用完整屏幕，关键菜单/提示可见。它们是自动化证据，不是最终人工验收。

运行日志与修改前副本：`.runtime/tray-uia-repair/`。该目录也保留诊断中失败的记录，不能用旧失败快照覆盖后续带时间戳和哈希的成功结果。

## GLM-5.3 独立复验

00:41:33 通过 Coprojer 公开 `saveContext` / `runFeature` API 更新精简接续资料并恢复 reviewer。开发和验证仍使用项目专用 `glm-5.3`，保留技能和推理配置；没有改全局成员、连接凭据、验收标准或人工验收结果。源码变化使旧断点按正常指纹规则失效并启动新验证。

第一轮 GLM 实际完成上述六条命令，全部退出 0，原生检查 14 个检查点通过，短时前后台切换延迟为 431 / 395 ms。但 00:46:41 宿主将四项结果降为“未验证”，原因是验证过程中源码指纹变化，进入了新的缺口诊断。00:49 前已主动停止，保留六条真实检查记录。

### PowerShell 缓存导致错误重验

已确认新增文件 `Microsoft/Windows/PowerShell/ModuleAnalysisCache` 是唯一的指纹差异：只将此生成缓存移到本次 `.runtime` 诊断目录，指纹即从 `82f1ebc50eeac3750b9e8484d9b505178660a8ef57495b81b3e6525fbc0cd09f` 精确恢复到审核前的 `e42197f3a578c9c598dd3b07ecc739710ec1f1e1cbe4117b14663edf41c9f338`。没有编辑业务源码来实现恢复。证据：`.runtime/tray-uia-repair/fingerprint-audit.json`。

宿主 `src/main/engineering/files.ts` 的 `runCommand` 现在显式将子进程 `PSModuleAnalysisCachePath` 指向当前工程 `.runtime/powershell/ModuleAnalysisCache`；隔离检查则使用本次隔离运行目录。仍严格检查所有实际源码、配置和二进制输入，没有把整个 Microsoft 目录加入忽略规则。

新增回归先因子进程缓存路径未定义而失败，修复后 `verification-live-regressions` 全部 10 项通过；涵盖命令实际执行、缓存不改变源码指纹、业务文件变化继续使验证失效，以及断点和证据边界。宿主 `npm run build`（含 typecheck）通过。

00:55:53 正常关闭并重启应用，加载新构建，检查点、模型连接和项目成员逐项一致；未自动恢复。00:55:55 通过公开 API 更新接续说明并再次恢复 GLM-5.3 独立验证。缓存不再写入源码目录，但 native 检查暴露出按动态名称去重导致的定位歧义；已停止该轮并修复物理按钮去重，未允许脚本任意挑选多个图标。

之后操作者重新运行 native、smoke 和 evidence，全部通过；宿主关联 `verification-preparation` 的 13 项检查也全部通过，未运行完整宿主 npm test。01:02:49 的复验进一步暴露恢复窗口后的异步读取竞态，已补齐 OS 可见性等待。

最终脚本在 01:07:07–01:08:35 连续三次完整原生验证通过，耗时分别为 28.001、28.436、27.888 秒；每次均完成真实悬停、菜单输入、恢复和无残留退出。随后 smoke 和当前哈希 evidence 校验再次通过。每轮独立 JSON 保存在 `.runtime/tray-uia-repair/native-stability-1.json` 至 `native-stability-3.json`。01:09:59 恢复 GLM-5.3，该轮随后发现下述报告类型问题；三次成功不表示桌面输入已无任何偶发超时。

### 数字字符串触发无效重验

01:09:59–01:13:52 的 GLM 复验中，六条实际命令再次全部退出 0，源码指纹稳定；三项正常通过，唯一被宿主拒绝的是短时测量。原始报告把 `measuredDurationSeconds` 写成字符串 `"5"`，宿主只接受 number。报告模板自身也用字符串说明该字段，导致本来一致的 5 秒证据进入新的诊断和准备流程。01:16:47 主动停止重复准备，保留所有真实记录。根因证据：`.runtime/tray-uia-repair/report-type-mismatch.json`。

修复位于 `src/main/engineering/verification.ts` 与 `service.ts`：示例改为 JSON 数字并明确填写规则；报告边界只接受正有限数字或纯十进制数字字符串，规范化后继续执行原有单实例测量上限、本轮命令用时、源码指纹、命令关联和原生交互校验。不会把 `5 seconds`、空串、布尔值、Infinity、十六进制或超出实测的时长转为通过。

新增真实服务调用路径回归，修改前 `"0.05"` 被误判 blocked；修改后数字及等值字符串正常进入 acceptance，10 种输入覆盖非法值和虚报时长，合法值不重开诊断。`verification-desktop-preparation.cjs` 当时 6 组检查全部通过，包含并行时长不能相加、原生输入不能由回调冒充、保留旧失败和中断准备恢复。宿主 build/typecheck 通过。01:20:16 重启加载当前构建，模型配置和检查点保持一致；01:20:28 通过公开 API 恢复 GLM-5.3 独立复验，该轮随后暴露下一项收尾判定错误。

### 已重验成功的旧失败仍触发修复

01:20:28 的复验中，native 第一次悬停未读取到 tooltip，真实记录为失败；后续相同源码、相同命令的独立重跑通过，六种检查均有当前成功结果。01:24:32 GLM 提交四项通过，宿主也将四项判为 passed，却因全局 `failedCheck` 仍包含首次失败而进入业务代码修复，出现“4 项通过、0 项失败、0 项未验证”同时“将进行修复”的矛盾。该轮已主动停止，未改动业务源码。

修复保留完整命令台账，并单独计算当前有效结果：只有更晚的实际成功、完全相同的命令、相同非空源码指纹、覆盖原证据类型且非 history，才能解除先前失败。不同命令、不同源码、降级证据、历史结果和更晚的新失败都继续阻断；报告若仍引用失败命令，该项也不能通过。实际替代发生时写入 `verification-retry` 事件。该规则不会把原生输入的一次失败抹成从未发生。

服务调用回归先复现 blocked，再修复至 acceptance，且断言没有额外开发轮次、两次命令 `[1, 0]` 均保留。增加负向条件后 `verification-desktop-preparation.cjs` 共 8 组通过；宿主 build/typecheck 再次通过。01:28:15 加载新构建，01:28:18 使用公开 `runFeature(..., true)` 重新独立验证，保留用户人工验收关卡。

旧诊断截图和失败 JSON 的移动清理被工具自动审批拒绝（仅返回 blocked by policy，未提供更具体原因），因此保留原件。它们不作为当前通过证据；当前运行必须以带时间戳、源码及构建哈希的权威结果和命令台账判断。

## 最终独立复验与审计

最后一轮共记录 22 次模型调用、7 次实际命令：typecheck、56 项单测、build、native 首次失败及随后通过、smoke、evidence。宿主于 01:32:42 写入 `verification-retry` 后自然写入 `acceptance` 事件，执行计划为 waiting-acceptance，未人工改写验收状态，未调用 accept。

| 检查 | 最后一轮结果 |
| --- | --- |
| `npm run typecheck` | 退出 0 |
| `npm test` | 56 项通过，退出 0 |
| `npm run build` | 退出 0 |
| `npm run test:tray:native` | 第一次真实菜单开始操作后状态读取超时；随后同源码实跑退出 0，14 个检查点通过，退出无残留 |
| `npm run test:tray:smoke` | 两模式各 5 秒通过；前台持久化/观察延迟 373/477 ms，后台 416/469 ms |
| `npm run test:tray:evidence` | 当前源码及构建证据校验通过，退出 0 |

模型文字摘要有两处与原始记录不一致：把本轮首次失败混写为上一轮的 tooltip 失败，并把运行态 tooltip 写成 `00:0x`。事实以本轮命令台账和 `native-ui.json` 为准：首次失败为 `waitForState` 超时；成功重跑截图中的 tooltip 为 `01:57`。不将模型自行判断的“桌面干扰”视为已确定原因。这些文字偏差没有用于替代真实检查，后续完整上下文/工具管理设计仍需处理历史串话。

本轮两次整理分别为 75,715 → 41,456、75,988 → 44,897 字符；整理后继续推进到完成，没有反复压缩而不执行。最终审计核对当前源码指纹 `44c8c865068910b68b7712c54827dac559b61fe7401e23a5ebd638b9a46a4d85` 与四项结果一致，模型仍是项目专属 GLM-5.3，native/smoke 均在本轮生成且哈希一致，源码目录未重新出现 PowerShell 模块缓存。三张最新原生截图已重新逐张检查，目标应用最大化，菜单/提示/恢复状态可见。

完整审计：`.runtime/tray-uia-repair/glm-final-result.json`。最终宿主定向检查为 `verification-desktop-preparation` 8 组、`verification-live-regressions` 10 项、`verification-evidence` 3 组通过；`execution-convergence` 10 项、此前 `verification-preparation` 13 项也已通过；完整宿主 `npm test` 未执行。保留最终人工试用验收，不延伸为 25 分钟或 macOS 结论。
