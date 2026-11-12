# Harness 重构 · 拆分阶段实施计划

2026-11-12 · 步骤0基线、步骤1等价脚本及步骤2–5结构拆分均已完成验收；步骤5固定登记9个内部 hook，最终规定检查去重83个不同脚本全部通过（含完整 npm test 52个），另有定向 preview-forwarding 通过。预览生命周期经用户另行明确授权修复；工程就绪、研究桩与新手断言按当前 AGENTS 同目标常规本地修复推进，四项均已独立提交。拆分主体完成；可选步骤6及其他阶段未开始，仍待用户点名。[ADR 0005](adr/0005-tool-pipeline-and-free-coding-entry.md) 已于2026-11-11被接受，本文是它的第一阶段：只做不改变行为的结构拆分。Windows 本机基线结果记在步骤0末尾，步骤1的设计见 [拆分步骤1设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md)，当前执行记录见 [Codex 执行说明](HARNESS_REFACTOR_CODEX_HANDOFF.md)。文中行号对应提交 `d59c52d`（2026-10-14）的 `src/main/engineering/service.ts`，动手时以语句为准，不以行号为准。

整个重构分四个阶段：基线、拆分、迁移、新能力。本文只覆盖前两个。迁移（一次性数据迁移、删除 `legacy` 字符预算和旧检查点分支）和新能力（规则引擎、审批卡片、通用 shell、自由编码入口）各自另写计划。

## 目标与非目标

目标是把 `EngineeringService.agentLoop`（第 1520–1991 行，约 470 行）里的工具执行逻辑拆成一条固定阶段的管线，把现有内联规则原样搬成内部 hook，使后续阶段能在管线上加权限规则和审批，而不必再改这个闭包。

本阶段不做的事：

- 不改任何对用户或模型可见的行为，包括提示词文案、工具输出文案、错误文案、事件种类和顺序。
- 不改持久化数据的形状（`engineering-v1.json`、回执台账、检查点）。
- 不删 `runtimePolicy: 'legacy'` 这条不记回执的路径，不删 `legacy` 字符预算。
- 不加规则引擎、审批、新工具、对外 hook 接口。
- 不合并多次出现的权限复核，不调换任何两步的先后，哪怕看起来是冗余。
- 不动 `requirements.ts` 的手写循环。

## 硬约束

这些约束来自测试的加载方式和脚本对内部细节的依赖，违反任何一条都会让回归脚本失效或误报。

**测试直接转译 TS 源码。** `scripts/fixtures/verification-runtime.cjs` 的 `load()` 用 `ts.transpileModule` 逐文件转成 CommonJS，相对导入一律解析成 `<名字>.ts`，`electron` 换成桩。另有十几个脚本内联了同样写法的加载器。计划起草时 `npm test` 的51个脚本里有24个属于这一类。步骤5另行修复新增的 Windows-only 预览生命周期回归也经该加载器调用源码服务；当前 `npm test` 共52个脚本，界面冒烟仍启动已构建应用。由此：

- 新模块必须是单个 `.ts` 文件，按文件路径相对导入，不能导入目录。
- `transpileModule` 不做类型检查，类型错误只有 `npm run typecheck` 能发现，每一步都要跑。
- 新模块对 `service.ts` 只能 `import type`，不能导入值，否则形成加载环。
- 错误类留在原模块（`PreparationBoundaryError` 在 `files.ts`，`TaskRevisionChanged` 在 `task-projection.ts`，其余类推）。`isFatal` 靠 `instanceof` 判断，搬动类会改变判断结果。

**`agentLoop` 保留为同签名的门面。** 十一个脚本直接调用 `service.agentLoop(...)`，共 18 处；`service.ts` 内部另有四个调用点（第 2022、2046、2153、2191 行）。脚本还直接使用 `service.store`、`sourceFingerprint`、`executionFingerprint`、`executionAgent`、`agentModel`、`runFeature`、`prepareRuntimeHandoff`、`reconcileRuntime`，这些成员的名字和语义都不能变。

**调用时再取 `store.save`，不提前捕获。** 十个脚本和一个崩溃注入夹具会在运行中替换 `store.save`（例如 `scripts/fixtures/context-runtime-crash-host.cjs`）。搬出去的代码要写 `host.store.save()`，不能写 `const save = store.save` 之后再调，否则替换不生效，脚本会在不报错的情况下失去意义。其他服务方法同理，一律在调用点经实例访问。

**提示词标记逐字不变。** 五个脚本按字面解析提示词：`宿主当前任务事实（每次请求重新装载）：\n`、`已读资料索引`（两者在 `service.ts` 的 `preparePrompt`）、`已完成工作摘要`（在 `context.ts`、`context-continuity.ts`、`context-session.ts`，本阶段不碰）。涉及 `context-runtime-capacity.cjs`、`context-runtime-contracts.cjs`、`context-runtime-efficiency.cjs`、`execution-prototype-continuity.cjs`、`long-task-context.cjs`。

**被脚本直接加载的模块，导出名不变。** 加载最多的是 `runtime-budget.ts`、`model.ts`、`files.ts`、`service.ts`，其次是 `context.ts`、`context-request.ts`、`verification.ts`。

**不增减 `store.save()` 和 `ledger.put()` 的调用，也不调换它们的位置。** 崩溃注入脚本（`context-runtime-crashes.cjs`，边界为 `effect`、`receipt`、`projection`）在每次 `store.save()` 返回后检查回执状态，据此决定在哪里退出进程。落盘点一变，测的就不是原来的边界。

**搬运时不重排版。** `service.ts` 很多行超过 200 字符。搬运提交里只移动和改名，不顺手换行或格式化，否则差异无法审阅。

## 现有执行顺序

下面是 `tools.execute`（第 1838–1947 行）的实际顺序，拆分后必须逐步相同。「校验参数」不在这里：工具定义查找和 `parseToolArguments` 在 `runtime.ts` 第 164–166 行完成，本阶段留在原处。

| 阶段（ADR 0005） | 现有代码 | 位置 |
| --- | --- | --- |
| 校验参数 | 查工具定义，`parseToolArguments` | `runtime.ts` 164–166 |
| 权限判定 | `authorize()`：中止信号、`assertRevision()`、`offered` 与 live agent 工具表 | 定义于 1841–1845 |
| 权限判定 | 回执路径的策略检查：缺 `identity` 报 `ReliabilityFailure`；工具不在 `supported` 内报 `RecoveryRequired` | 1907–1909 |
| 准备副作用 | 写文件：`authorize()`、参数含密钥则拒绝、有旧回执则 `assertFileReceipt` 并复用，否则 `preparePatchEffect` / `prepareFileEffect`；补丁原文含密钥则拒绝 | 1910–1921 |
| 准备副作用 | 命令：`authorize()`、参数含密钥则拒绝、有旧回执则 `assertCommandReceipt`，否则 `prepareCommandEffect`（内含 `authorizeCommand`） | 1922–1929 |
| 记录意图 | 构造 `ToolReceipt`、算 `intentHash`；`ledger.execute` 内先核对已有记录，无记录则 `put(intent)` | 1930–1937，`receipt-ledger.ts` 77 起 |
| 执行前复核 | `authorize()` 加 `budgetLease.reserve('tools')`，随后回执置 `running` 并落盘 | 1937 的回调 |
| 前置 hook | live agent 工具表再查一次（不查中止信号和修订号） | 1850–1852 |
| 前置 hook | 原型必读：写文件和跑命令前必须读完已验收原型 | 1853–1854 |
| 前置 hook | 准备类角色更新 `p.activity` 并保存；记 `tool` 事件；`budgetLease.check()` | 1855–1868 |
| 执行 | `executeCommandEffect` / `applyFileEffect` / `agentSkillReader` / `executeTool` | 1869–1871 |
| 后置 hook | 读原型分页时推进 `prototypeReadUntil` | 1872–1875 |
| 后置 hook | 无回执路径的命令证据：解析输出、脱敏、登记 `CommandEvidence`、改写输出 | 1876–1896 |
| 执行（错误归类） | 四类致命错误原样抛出；读取被取消返回 `cancelled`；回执路径抛脱敏后的错误；否则输出「工具错误：…」 | 1897–1902 |
| 封存结果 | `ledger.execute` 封存回执；不确定则对账或标 `uncertain` | `receipt-ledger.ts` |
| 后置 hook | `applyReceiptProjection`、登记命令证据、`boundaryError` 转 `PreparationBoundaryError`、再次推进原型进度、命令被取消时返回 `stopGroup` | 1939–1946 |
| 更新功能记录 | `received`：修订号变了则记 `historical-result` 并抛错；有回执则投影；准备类角色记 `actions`，保存失败则回滚 | 1961–1975 |

无回执路径（`runtimePolicy` 为 `legacy`）只有一行：`authorize(); budgetLease?.reserve('tools'); return work()`（第 1906 行），不经过准备副作用和记录意图。

有几处容易被「顺手整理」掉，必须原样保留：

- 权限复核的次数因路径而异：回执路径的写文件和命令是三次（准备前、落盘后、`work()` 内），只读是两次，无回执路径是两次。`work()` 内那次不查中止信号和修订号，和 `authorize()` 不是同一个检查。
- 前置 hook 排在意图落盘之后。原型必读的拒绝发生在回执已置 `running` 之后，会被封存成一条 `failed` 回执。
- 准备副作用阶段的拒绝（密钥、角色、路径）发生在意图落盘之前，不产生回执，由 `runtime.ts` 第 171–173 行转成「工具错误：…」。
- 落盘后那次 `authorize()` 在 `ledger.execute` 的 `try` 之外。此时被拒，回执会停在 `prepared`。
- 原型读取进度推进了两次（`work()` 内和 `ledger.execute` 之后）。第二次是为复用旧回执结果的情形准备的，两次都取最大值，不能合成一次。
- 命令证据编号是 `'check-' + (commands.length + 1)`，依赖同一个数组在各处的追加顺序。

## 步骤

每一步一个提交，提交后跑该步列出的检查；有一项与基线不同就回退这个提交，不带着差异往下走。

### 步骤 0：基线

1. 确认工作区。在我这次会话的环境里，`git status` 显示 12 个已跟踪文件被修改，但 `git diff --ignore-cr-at-eol` 没有任何差异，应当只是换行符不同，在本机上可能根本不显示。另有未跟踪的 `CLAUDE.md`、`docs/research/` 和十余份 `docs/verification/` 文档。请在本机确认并先提交，基线要建立在干净的提交上。
2. 在本机依次跑并保存完整输出到 `.runtime/harness-refactor/baseline/`：
   - `npm run typecheck`
   - `npm run test:context-runtime`（17 个脚本）
   - `npm run test:context-window`（7 个）
   - `npm run test:verification`（11 个）
   - `npm run test:context-efficiency`
   - `node scripts/long-task-context.cjs`（只在全量 `npm test` 里，直接调 `agentLoop`）
3. 另有四个直接调用 `agentLoop` 的脚本不在任何 npm 命令里：`context-role-adaptive.cjs`、`context-role-adaptive-smoke.cjs`、`execution-prototype-continuity.cjs`、`execution-prototype-smoke.cjs`。逐个跑一遍，通过的纳入本阶段的检查集；基线上就不通过的记下原因，不作为判据。
4. 不跑这五个：`context-window-project-replay.cjs`、`execution-project-resume-probe.cjs`、`execution-prototype-real.cjs`、`project-adaptive-context.cjs`、`project-role-adaptive-context.cjs`。它们也调用 `agentLoop`，但会读取 `%APPDATA%\Coprojer-dev\engineering-v1.json`，也就是真实资料目录，不符合「验证用隔离资料目录」的约定。

基线里如有失败项，先记录并确认是已知问题，再决定是否开工。Linux 沙箱里跑过一份参考结果，归档在 `.runtime/harness-refactor/baseline/`；命令守卫依赖 Windows Job Object，基线以本机结果为准。

**本机基线结果（2026-11-11，提交 `39d7299`，Node v22.18.0）。** 共 43 项：typecheck、build 加 41 个脚本，每个脚本单独运行。42 项通过，1 项失败。

- 失败的是 `context-runtime-migration-smoke`。迁移、换模、授予额度、继续执行、页面重载都已通过，在最后的 860×600 布局检查时功能抽屉已经关闭，脚本超时。随后单独连跑 3 次都通过，没有复现。
- 原因没有确定。那一轮的测试窗口回退到了主屏，可能是运行期间的键盘或鼠标输入落进了窗口，也不能排除界面偶发问题。
- 处理办法：它留在检查集里。拆分期间如果在同一位置失败，先单独重跑；重跑仍失败才算回归。
- Linux 沙箱里失败的 `context-runtime-commands`、`context-runtime-command-crashes`、`context-runtime-efficient-files` 在本机都通过。
- 第 3 条的四个补充脚本和 `long-task-context` 都通过，纳入本阶段的检查集。

记录在本机的 `.runtime/harness-refactor/baseline/windows/`（`summary.md`、`NOTES.md`）和 `baseline/windows-rerun-1`～`3/`，这个目录不进仓库。

### 步骤 1：补特征测试

现有脚本覆盖了主路径和崩溃恢复，但下面几种情形按文案字面检索不到断言。先在未改动的代码上把现状固定下来，再开始搬。

场景的构造办法、采集字段、归一化规则、保存次数的计法和验收办法见 [拆分步骤 1 设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md)。那份文档比下表细，也补了几个场景，两者有出入时以它为准。

新增 `scripts/tool-pipeline-equivalence.cjs`，用 `verification-runtime.cjs` 已导出的 `fixture`、`call`、`answer`、`run` 驱动脚本化的模型回复，把每个场景的结果归一化（去掉随机标识和时间）后与提交进仓库的基准 JSON 比较。记录内容：工具输出序列、回执的 `tool / strategy / status / attempts`、事件种类序列、命令证据编号、`store.save()` 次数。

| 场景 | 现有断言 | 要固定的现状 |
| --- | --- | --- |
| 运行中 live agent 的工具被收回 | `context-runtime-contracts.cjs`、`context-runtime-migration.cjs` 各有一例，只断言「没有执行、有拒绝事件」 | 三个时机各一例：准备前、落盘后、`work()` 内；各自的输出和回执状态。后两个时机可借替换 `store.save` 在落盘时收回权限来构造 |
| `receipts-readonly-v1` 下调用写工具 | 未检索到「尚未启用该副作用工具」 | 抛 `RecoveryRequired`，运行转 `recovery_required` |
| 原型未读完就写文件或跑命令 | `context-runtime-efficient-files.cjs` 有 | 补一条：回执为 `failed`，`attempts` 为 1 |
| 写入参数含连接密钥 | `context-runtime-efficient-files.cjs` 有 | 补一条：不产生回执 |
| 无回执路径的命令证据 | 待基线确认 | 编号连续、`isTest` 判定、输出被改写 |
| 命令被取消 | 待基线确认 | 返回 `stopGroup`，同组后续调用记 `not-started-v1` |
| 准备类角色的 `actions` | `context-runtime-commands.cjs`、`context-runtime-recovery.cjs` 有 | 无回执时由 `received` 追加，有回执时由回执投影追加，两条路径的结果相同；保存失败回滚 |
| 四个角色各一次完整运行 | 分散在多个脚本 | 模型请求的 system、工具表、首条消息逐字节一致 |

「缺少已保存的逻辑调用身份」这条分支经 `runRuntime` 走不到（`runtime.ts` 第 167、216 行总是传入身份），保留代码，不为它造测试。

把新脚本接进 `test:context-runtime`。本步只加测试，不改 `src/`。

### 步骤 2：把闭包状态收成显式对象

`agentLoop` 的各个端口共享一批闭包变量，其中 `prototypeReadUntil` 和 `commands` 是可变的，被 `preparePrompt`、`saveCheckpoint`、`finish` 和 `tools.execute` 同时读写。不先把它们显式化，工具端口搬不出去。

在 `service.ts` 内（暂不新建文件）定义 `ExecutionRun`，收纳第 1520–1603 行准备出来的值：`role`、`preparing`、`phaseLabel`、`connection`、`taskRevision`、`contractFingerprint`、`reliable`、`budgetLease`、`executionRunId`、`environmentFingerprint`、`manifest`、`ledger`、`artifacts`、`prototype` 及其长度与版本、`offered`、`assertRevision`，以及可变的 `prototypeReadUntil` 和 `commands`。各闭包改成读写 `run.xxx`。

这一步是纯机械替换，语句顺序和数量都不变。检查：`npm run typecheck`、步骤 1 的等价脚本、`test:context-runtime`。

**本机执行结果（2026-11-11）。** 已在同文件定义20字段的 `ExecutionRun`；保留原初始化顺序，在 `offered` 建立后一次收纳已有值，闭包改为访问 `run`。命令数组和 manifest 仍保留续接对象的原引用。类型检查通过，独立等价脚本50个场景差异为0；完整 `test:context-runtime` 的构建及19个脚本首次运行全部通过，其中 A0 为8/8、落盘计数仍为40／29／59，5个 Electron 冒烟脚本通过。源码结构比对确认原控制流、调用顺序、文案及落盘位置不变。详见 [拆分步骤2本机回报](../.scratch/harness-refactor/codex-report-split-2.md)。本步没有搬出工具端口、增加 hook 或改变运行标识语义。

### 步骤 3：整体搬出工具端口

新建 `execution-tools.ts`，导出 `executionTools(run, host): RuntimePorts['tools']`，把第 1827–1976 行的 `tools` 对象原样搬过去，内部结构一行不动。`host` 是一个窄接口，只列工具端口实际用到的服务能力：`store`、`sourceFingerprint(p)`、`agentSkillReader(p, role, agent)`。`agentToolMessage`（第 98 行）一并搬走或改为导出。

`sourceFingerprint` 和 `agentSkillReader` 在 `EngineeringService` 上是 `private`，不能把 `this` 直接当作 `host` 传入。在 `agentLoop` 里用箭头函数包一层：`{ store: this.store, sourceFingerprint: p => this.sourceFingerprint(p), agentSkillReader: (p, role, agent) => this.agentSkillReader(p, role, agent) }`。这样既过类型检查，也保持调用时才取方法；不要为此把这两个方法改成 `public`。

`agentLoop` 里只剩 `tools: executionTools(run, host)`。

检查：`npm run typecheck`、等价脚本、`test:context-runtime`、`test:verification`、`node scripts/long-task-context.cjs`，以及步骤 0 第 3 条里纳入检查集的脚本。

**本机执行记录（2026-11-12）。** 工具端口已整体迁入 `execution-tools.ts`；`agentToolMessage` 同步迁入。原工具对象仅将30处 `this` 接收者改为 `host`，语句、格式、文案、权限复核和落盘顺序保持。`ExecutionRun` 补入原闭包的 `p/f/agent` 引用，新模块对 `service.ts` 仅作类型导入；两个服务方法仍为 private，通过箭头函数在调用时取方法。类型检查、两次50场景等价验证及 A0 的8项检查通过，计数保持40／29／59；独立结构审计与手审未发现剩余问题。

原机械提交 `0af4bc4` 的首次验收为31/35：context-runtime 18/19、verification 8/11、补充5/5，两条完整 npm 命令均退出1。原日志保留在 `.runtime/harness-refactor/split-3/`，不改记通过；旧 service `5538403` 也失败不构成豁免，convergence两版失败集合和超时阶段不同。

**四项修复及最终验收（2026-11-12）。** 用户另行授权测试生命周期与同步修复；本轮没有改产品源码、等价基准或此前留待后续的缺陷候选：

- commands：受控延迟证明2500 ms可在首次输出前正确耗尽；拆分启动期与ready后真实service lease取消场景，额度不变。原signal原因、输出、文件效果、树停止和排队未执行均有断言，断线变异准确失败。提交 `9d802a7`。
- budget：受控保存延迟证明正确36步执行可超过15秒；等待真实job及最终保存，保留业务断言。convergence：18秒也可早于正确完成，且直接查实超时残留job消耗下一模型桩；统一90秒watchdog、stop/join及45秒有界清理，未清理就停止后续case，新增生命周期回归。提交 `335df8c`。
- preparation-stalls：首次fetch可能在请求建立前已超时，原30 ms sleep也不是关闭事件屏障。预热真实HTTP、证明首SSE delta、等待自然close；正式100 ms请求超时及原2秒总界限保留。提交 `e33e77c`。

最终类型检查与独立50场景等价检查通过（0 differences），完整 `test:context-runtime` **19/19**、完整 `test:verification` **11/11**、long-task-context及四项补充 **5/5**，所有命令实际退出0，共 **35/35**。context套件内等价复验仍无差异，A0为8/8、固定计数 **40／29／59**，10个 Electron 冒烟全部通过。仅因活动预算测试后来补强真实信号覆盖，才在首轮context通过后执行最终完整套件。

本步**实现及验收完成**，机械重构与测试修复分开提交，未push、未改写原提交，步骤3当批未开始步骤4。历史具体慢点及convergence额外失败归属仍不能从旧日志确定；不把受控实验写成旧现场完整重建。原因、阶段测时、验证及限制见 [步骤3回报](../.scratch/harness-refactor/codex-report-split-3.md) 和 [本机交接](../.scratch/harness-refactor/next-chat-handoff.md)，最终日志与证据归档在 `.runtime/harness-refactor/split-3-fixes/validation/`。

### 步骤 4：在新文件内按阶段重排

新建 `tool-pipeline.ts`，只放阶段运行器和类型，不依赖 `EngineeringStore` 或 `service.ts`。建议形态如下，动手前可再调整：

```ts
export interface ToolInvocation {
  call: ToolCall
  args: Record<string, any>
  step: number
  signal: AbortSignal
  identity?: { logicalId: string; groupId: string }
}

export interface ToolHook<Run> {
  name: string
  beforeIntent?(run: Run, invocation: ToolInvocation): void
  beforeExecute?(run: Run, invocation: ToolInvocation): void
  afterExecute?(run: Run, invocation: ToolInvocation, output: string): string | void
  afterSettle?(run: Run, invocation: ToolInvocation, result: ToolResult): ToolResult | void
}
```

把 `execute` 的函数体切成具名函数：`authorize`、`assertPolicySupport`、`prepareEffect`、`buildIntent`、`perform`、`classifyError`、`settle`。回执路径和无回执路径各自保留一个顶层函数，按上表顺序调用这些具名函数；两条路径不合并。

这一步每次只切一个函数，切完就跑等价脚本。检查同步骤 3，另加 `test:context-window`。

**本机执行与验收记录（2026-11-12）。** 产品结构改动限于 `execution-tools.ts` 与新增的 `tool-pipeline.ts`。`authorize` 原本已具名，保留原检查；其余执行逻辑切为 `assertPolicySupport`、`prepareEffect`、`buildIntent`、`perform`、`classifyError`、`settle`，业务依赖及每次调用状态留在原文件内。`tool-pipeline.ts` 只含类型化阶段接口与legacy/回执两个独立运行器，不依赖 `EngineeringStore` 或 `service.ts`，两条路径不合并。原同步阶段、异常边界、权限复核、命令证据及落盘顺序保持；没有提前登记内部hook。上方类型片段为建议形态，实际采用本步需要的阶段接口，未增加尚未使用的hook接口。

按policy、prepare、intent、perform、classify、settle、legacy runner、receipt runner依次切分，8次等价检查各50/50、0 differences；独立最终等价也50/50无差异，原基准未改。最终类型检查通过，完整context-runtime **19/19**、context-window **7/7**、verification **11/11**、五项补充 **5/5**，共 **42/42** 个不同脚本，含 **11个 Electron 脚本**；A0 **8/8**、固定计数 **40／29／59**，recovery **38/38**。分步验证、构建、定向case及中间运行不重复计入分母。

首次recovery失败的HTTP请求数为0而非预期的1；受控实验查实180ms额度可能早于请求登记耗尽，但首次无trace现场的具体慢点仍未知。用户另行授权测试修复并单独提交 `1671757`。正常service起点与真实HTTP ready后的预算取消分层验证，额度、信号链路和原3秒界限保留，断信号负对照准确检出问题。verification两次Electron启动失败另查明为本轮ignored运行器用.NET写入null留下空 `ELECTRON_RUN_AS_NODE`，被既有launcher重新传入子进程；受控空值红、删除变量绿的对照已验证，只修ignored运行器，未改tracked launcher。原失败与中间结果均保留，不覆写为通过；结构拆分本身未修改测试、基准、A0、共享持久类型或依赖。

最终成功结果在 `.runtime/harness-refactor/split-4/validation-evidence/results.json`，实际来源为 `validation-final` 的前三条成功命令与 `validation-clean` 的六条成功命令；独立等价在 `standalone-equivalence/`。详细原因、证据边界与本地提交见 [步骤4本机回报](../.scratch/harness-refactor/codex-report-split-4.md)、[recovery诊断](../.scratch/harness-refactor/split-4-recovery-diagnosis.md) 和 [步骤4审阅](../.scratch/harness-refactor/split-4-review.md)。本步实现及验收完成，未push、未改写已有提交；步骤4当批未开始步骤5内部hook登记及其他后续工作。

### 步骤 5：把内联规则登记成内部 hook

新建 `execution-hooks.ts`，把下列规则各写成一个 `ToolHook`，由 `executionTools` 按固定顺序注册。注册顺序就是现有语句顺序。

| hook | 挂载点 | 来源 |
| --- | --- | --- |
| 参数密钥拒绝 | `beforeIntent` | 1912、1924 |
| live agent 复查 | `beforeExecute` | 1850–1852 |
| 原型必读 | `beforeExecute` | 1853–1854 |
| 活动状态与 `tool` 事件 | `beforeExecute` | 1855–1864 |
| 预算检查 | `beforeExecute` | 1868 |
| 原型读取进度 | `afterExecute` 与 `afterSettle` | 1872–1875、1942–1945 |
| 无回执路径的命令证据 | `afterExecute` | 1876–1896 |
| 回执投影与命令证据 | `afterSettle` | 1939–1941 |
| 命令取消后停组 | `afterSettle` | 1946 |

角色工具裁剪、任务修订号复核、`safePath`、`authorizeCommand` 不做成 hook。它们是权限判定和副作用准备本身，留在管线的固定阶段里，这样后续阶段没有办法通过少注册一个 hook 把它们关掉。

补丁原文的密钥检查（第 1917–1918 行）也不做成 hook。它要用到 `preparePatchEffect` 算出的 `before` 和 `after`，位置在副作用准备之后、意图构造之前，留在 `prepareEffect` 内部最不容易改变先后。

检查同步骤 4。至此本阶段的主体完成。

**本机执行与验收记录（2026-11-12）。** 从 `117f3bf` 起，9个内部 hook 已在 `execution-hooks.ts` 定义并由 `executionTools` 固定注册，四类分发器同步执行。实际数组把回执投影放在原型进度之前，两个阶段各跳过没有挂载的回调，分别保持 `afterExecute` 与 `afterSettle` 的既有顺序；上表列的是规则及挂载点，不应机械照表调换共享数组。权限判定、补丁 before/after 密钥检查仍留在固定阶段。原授权次数、同步/异步及 try/catch 边界、live agent 引用、指纹/计时、回执结果 clone、命令证据、保存位置和提示词文案保持，未开放用户 hook 配置。

最终类型检查及等价50/50通过（0 differences）；context-runtime 19/19、context-window 7/7、verification 11/11、context-efficiency 1/1、五项补充5/5、完整 npm test 52/52，去重共 **83个正式不同脚本**。另有定向 preview-forwarding 通过，合计84个不同脚本；定向真实工程318.13秒及转发21.67秒的成功结果已归档，工程重复运行不再计数。A0为8/8，计数保持40／29／59。最终汇总入口为 `.runtime/harness-refactor/split-5-final-run/final-validation/results.json` 与同目录 `evidence-audit.json`，成功来源为 `split-5-verified/validation` 的前11条及 `split-5-final-run/full-only` 的新完整52脚本链。研究 provider 与 novice 测试的后续改动不在前11条的43个脚本依赖闭包内，前批成功记录按逐项来源复用；旧完整链失败仍保留，不用定向通过替代新完整链。定向工程/转发见 `split-5-verified/targeted/results.json`，研究等尾部见 `split-5-final-check/targeted/results.json`，修后新手见 `split-5-final-run/targeted/results.json`。

首次完整工程预览停止失败保留在 `.runtime/harness-refactor/split-5/`；受控 npm 根提前退出证明旧 taskkill/登记生命周期缺口，但原现场具体先后仍未知。另行授权的独立修复 `9456f4d` 共9个文件，复用 Windows Job Object 管理预览整树、停止确认后清状态，并使测试清理有界且不覆盖原失败。修复后首次定向工程重启又遇旧 `agents.length === 4` 谓词，而归档状态实际含4个全局加4个项目智能体；失败保留在 `.runtime/harness-refactor/split-5-final/`，`f1765a9` 单独只改一行以检查4个全局智能体，受控谓词与缺角色负对照已验证。预览修复由用户另行明确回答授权；就绪谓词按当前 AGENTS 同目标常规本地修复推进。Windows-only 六模式通过，其他操作系统未实测。

随后完整 npm test 在第48个 research-smoke 的部分响应断言失败（`split-5-verified/validation`）；受控真实 HTTP/SSE 证明运行时 user 提示被旧桩误当当前用户发言，原现场 wire 未归档。`a08f4be` 仅修 provider（单文件5增3删），五个 HTTP/SSE 对照及受影响 design/research 两实际脚本通过。接续尾部的 novice 在旧第178行全局技能 ID 断言失败（`split-5-final-check/targeted`），`bef4b51` 仅修测试（单文件21增3删）：按每 feature 的私有 reviewer、run.agentId、owned skill/sourceId/version/hash 验证，迁移严格保留四全局及输入私有成员集合。旧第227行是实际 store 隔离对照证明的潜在后续错误，并非原 UI 已到达的失败；18个实际断言块对照符合预期，修后完整 novice 定向80.58秒通过且独立审计 passed（`split-5-final-run/targeted`）。研究和新手修复按当前 AGENTS 同目标常规本地修复推进，均未改产品。四项独立修复与 hook 提交分开，原失败记录不改记通过。

本步实现及验收完成，拆分主体到此完成。依赖、lockfile、共享持久类型、等价基准及 A0 均未改；原两个缺陷候选仍留待用户另行交办。详细提交、证据及限制见 [步骤5本机回报](../.scratch/harness-refactor/codex-report-split-5.md)、[hook审阅](../.scratch/harness-refactor/split-5-review.md)、[独立预览审阅](../.scratch/harness-refactor/split-5-preview-review.md)、[研究桩修复](../.scratch/harness-refactor/split-5-research-fixture-fix.md)、[新手断言修复](../.scratch/harness-refactor/split-5-novice-fix.md) 与 [Codex执行说明](HARNESS_REFACTOR_CODEX_HANDOFF.md)。未push；可选步骤6、A1–A8及其他阶段未开始。依赖条件满足不等于已获后续阶段的执行授权。

### 步骤 6（可选）：方案规划接入同一管线

当前未开工。步骤5已完成，结构依赖已满足；本批不继续，仍须用户点名步骤6。

`planning.ts` 第 56–71 行有一份独立的只读执行逻辑（`assertCurrent`、工具许可、`session.reserveTool()`、读取覆盖进度）。它只读、无回执，可以接到 `tool-pipeline.ts` 上，把覆盖进度写成一个 `afterExecute` hook。单独一个提交，检查用 `test:context-runtime`（含 `context-runtime-entries.cjs`）和 `npm run test:engineering`。

`agentLoop` 的 `records` 端口（第 1791 行起）与 `context-session.ts` 第 52 行起的 `records` 大量重复，合并它们也放在这里，同样单独提交、单独回归。这两件事不做也不影响后续阶段，时间紧可以推后。

## 完成判据

- `tools.execute` 的逻辑全部在 `execution-tools.ts`、`execution-hooks.ts`、`tool-pipeline.ts` 中，`agentLoop` 里不再有工具执行语句。
- `npm run typecheck` 通过。
- 步骤 0 记录的每个检查，结果与基线相同；基线上通过的没有一个变成失败。
- 步骤 1 的等价脚本基准 JSON 自建立后没有改动过。
- `package.json` 的依赖没有变化；`src/shared/` 的持久化类型没有变化。
- 全量 `npm test` 在阶段结束时跑一次，结果与基线相同。

## 风险

| 风险 | 表现 | 应对 |
| --- | --- | --- |
| 闭包变量改成对象字段时漏改一处 | 原型进度或命令证据编号错位 | 步骤 2 单独成步；等价脚本记录证据编号和进度 |
| 提前捕获方法引用 | 替换了 `sourceFingerprint` 的脚本行为变化 | `host` 一律按实例调用 |
| 搬运时误合并「重复」检查 | 权限被收回后的回执状态改变 | 步骤 1 为三个时机各建一例 |
| 落盘点移动 | 崩溃注入脚本通过，但测的边界已不是原来的 | 等价脚本记录 `store.save()` 次数 |
| 类型错误未被发现 | 脚本通过，构建失败 | 每步跑 `npm run typecheck` |
| 等价脚本本身覆盖不足 | 行为漂移未被发现 | 阶段结束跑全量 `npm test`；审阅每个提交时对照上面的顺序表 |

最后一条是这份计划的主要弱点：「不改行为」的证据只和测试覆盖一样强。步骤 1 的场景表是按读源码得出的，可能有遗漏，基线跑完后应当根据实际覆盖情况再补。
