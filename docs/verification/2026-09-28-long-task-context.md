# 长任务中断 P0 修复验证

日期：2026-09-28。工作区：D:/develop/coprojer。当前为本地实现与测试证据，未提交或发布。

## 问题与修复范围

修复工程执行循环中“最新完整工具组超过本地上下文预算”直接报错、再次整理丢失旧摘要、完整请求计量遗漏规则/工具/原生状态，以及开发完成工具回合后断网缺少持久恢复点的问题。

覆盖 Chat Completions、Responses、Anthropic 三种协议的请求构造和工程 agentLoop；不代表完整上下文/工具运行时已设计或实现。

## 初版 P0 回归结果

本轮先复现前三个原有失败，再实现修复。以下 11 项当前均通过：

| 场景 | 实际检查 |
| --- | --- |
| 最新工具组过大 | 同组 8 个 6000 字符结果可整理并继续，原始目标保留，调用与结果配对 |
| 多次整理 | 第二次整理保留上次摘要中的失败标记和 assistant 决定 |
| 开发断网恢复 | 写入后下一次请求失败，重建 EngineeringService 后恢复工具结果，写入事件仅一次 |
| 完整命令日志 | 真实子进程生成超过尾部缓冲的中文/emoji 日志，经 read_context 分页完整恢复；校验版本和项目隔离 |
| 脱敏 | 已配置密钥及 sk- token 跨 chunk 输出时，归档中不泄露完整密钥 |
| 三协议计量 | modelRequestCharacters 等于实际发送的 JSON body 长度，包含 instructions、schemas 和原生状态 |
| 错误分类 | 明确上下文错误进入容量分类；无关的工具 schema HTTP 400 不误分类 |
| 实际执行循环 | 真实 agentLoop 同轮执行 8 个大读取后仍进入下一次模型请求 |
| 大写入续跑 | 三协议各执行约 190000 字符写入后整理并继续，不重复执行写入 |
| 容量有限重试 | 已执行工具不重放；容量持续失败后停止并保留有效检查点 |
| 不完整工具组/必需输入 | 不压缩半组工具历史，不为了满足预算删除必需用户输入 |

定向检查：

- node scripts/long-task-context.cjs：通过。
- node scripts/context-skills.cjs：通过。
- node scripts/execution-budget.cjs：通过。
- node scripts/model-errors.cjs：通过。
- node scripts/reasoning.cjs：通过。
- npm run typecheck：通过。
- 本轮目标源码及 package.json 的 git diff --check：通过。四份调研/交接文档的本地链接检查通过。

全工作区 git diff --check 另外发现既有 test/番茄钟助手/.coprojer/ACTIVITY.md 自动活动记录中的尾部空格；不属于本轮改动，未清理或覆盖该用户工程记录。

初版 P0 完整 npm test（摘要扁平化补修前）：全部通过，进程退出码 0。包括 TypeScript、main/preload/renderer 构建、上述新增 11 项以及全部串联回归和真实 Electron 冒烟。日志见 .runtime/long-task-context/npm-test.log。

## 21 时后摘要嵌套补修

实际运行暴露了三处不足：旧摘要的元信息被原样放回新摘要；低于预算的旧断点不触发清理；当摘要加最新回合略微超限时，先丢弃了最新完整回合，而不是先缩短旧摘要。

改动仅涉及 context.ts、long-task-context.cjs 和本次记录。扁平条目使用显式版本并去重，不递归携带摘要头、归档提示或防重放说明。旧记录迁移仍先归档，再替换工作视图；完整原生工具回合优先保留，无法容纳时才整体归档。原始用户消息、调用参数和原生协议块不被截断。

新增用例中先观察到 4 个失败，修复后加入三协议恢复用例，共 16 项全部通过：

- 低于预算的 10 层旧摘要也会迁移，并保留旧归档链；第二次处理不再修改或再次归档。
- 连续 20 次压缩、每轮 8 份不同内容的 6000 字符结果，始终只保留一个摘要头和一条防重放说明；最新下一步结论保留且历史有界。
- 优先缩减早期摘要，完整保留最新调用/结果及 signed/encrypted 原生块。
- 归档失败时，旧断点消息字节不变。
- 三协议的真实 agentLoop 在恢复后的第一次请求前清理旧摘要，并保持真实用户输入和后续更正；不重放工具。

本次重新运行并通过：long-task-context、context-skills、execution-budget、model-errors、reasoning，以及 npm run build（含 typecheck，退出码 0）。纯上下文逻辑补修未再运行完整 npm test 或真实供应商调用。

对番茄钟第 22 步已保存检查点的只读回放结果：

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 摘要头数量 | 13 | 1 |
| 摘要文本字符数 | 10179 | 7187 |
| 历史 JSON 字符数（不是完整模型请求或 token 数） | 39654 | 36929 |
| 原始用户消息和近期原生历史 | 有 | 逐项不变 |

回放第二次处理不再改变消息，只创建一次模拟归档；没有写入用户配置、触发模型请求或修改验收结果。证据位于 .runtime/context-flatten/real-checkpoint-replay.json；失败复现、修复后回归、关联回归和构建日志分别为 before.log、after.log、regressions.log、build.log。

该补修解决摘要递归与近期上下文保留问题，不等于对真实模型不再重复阅读、网络不再超时或业务验收完成作出保证。通用无进展检测仍属后续运行时工作。

## 测试环境与证据边界

本次可见测试使用项目既有 scripts/test-display.cjs 路由，目标为现场识别的 Windows DISPLAY1 非主屏（物理区域 x=1920、y=0、1920×1080）。通过既有 DPI-aware 映射在首次显示前定位，没有更改系统主屏幕。

~~~powershell
$env:COPROJER_ROUTE_TEST_WINDOWS = '1'
$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --require D:/develop/coprojer/scripts/test-display.cjs').Trim()
npm.cmd test *>&1 | Tee-Object -FilePath .runtime/long-task-context/npm-test.log
exit $LASTEXITCODE
~~~

测试使用隔离工程与应用资料；三协议请求/容量错误采用受控 fixture，未据此声称真实供应商窗口或 API 兼容性已经实测。没有用这些测试替代用户原中断任务的实际完成或人工验收。

## 保留边界

- 预算仍基于字符数，不是精确 token。必需规则/输入本身无法容纳时保存现场并暂停。
- 完整工具组是恢复边界。半组中断、外部操作不确定状态和 exactly-once 不在本次保证范围。
- 摘要有界，全文依赖归档链；不保证所有历史细节始终驻留模型输入。
- 归档配额为单份 16000000 字节、单功能 128000000 字节，超限明确标记不完整；自动清理尚未实现。
- 没有强制重启用户现有应用进程，加载新构建需要重新启动。旧版未保存的历史不能事后恢复。

后续设计的本地过程记录为 `.scratch/long-task-context/handoff.md`，不随仓库发布。公开功能入口见[文档索引](../README.md)，本批次最终检查见[发布验证](2026-09-28-release.md)。
