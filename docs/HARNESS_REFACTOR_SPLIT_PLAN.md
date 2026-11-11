# Harness 重构 · 拆分阶段实施计划

2026-11-11 · 草案，尚未执行，基线也还没有跑。本文是 [ADR 0005 草案](adr/0005-tool-pipeline-and-free-coding-entry.md) 的第一阶段：只做不改变行为的结构拆分。文中行号对应提交 `d59c52d`（2026-10-14）的 `src/main/engineering/service.ts`，动手时以语句为准，不以行号为准。

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

**测试直接转译 TS 源码。** `scripts/fixtures/verification-runtime.cjs` 的 `load()` 用 `ts.transpileModule` 逐文件转成 CommonJS，相对导入一律解析成 `<名字>.ts`，`electron` 换成桩。另有十几个脚本内联了同样写法的加载器。`npm test` 的 51 个脚本里有 24 个属于这一类，其余是启动已构建应用的界面冒烟。由此：

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

基线里如有失败项，先记录并确认是已知问题，再决定是否开工。我没有在 Linux 沙箱里试跑这些脚本；命令守卫依赖 Windows Job Object，基线应以本机结果为准。

### 步骤 1：补特征测试

现有脚本覆盖了主路径和崩溃恢复，但下面几种情形按文案字面检索不到断言。先在未改动的代码上把现状固定下来，再开始搬。

新增 `scripts/tool-pipeline-equivalence.cjs`，用 `verification-runtime.cjs` 已导出的 `fixture`、`call`、`answer`、`run` 驱动脚本化的模型回复，把每个场景的结果归一化（去掉随机标识和时间）后与提交进仓库的基准 JSON 比较。记录内容：工具输出序列、回执的 `tool / strategy / status / attempts`、事件种类序列、命令证据编号、`store.save()` 次数。

| 场景 | 现有断言 | 要固定的现状 |
| --- | --- | --- |
| 运行中 live agent 的工具被收回 | `context-runtime-contracts.cjs`、`context-runtime-migration.cjs` 各有一例，只断言「没有执行、有拒绝事件」 | 三个时机各一例：准备前、落盘后、`work()` 内；各自的输出和回执状态。后两个时机可借替换 `store.save` 在落盘时收回权限来构造 |
| `receipts-readonly-v1` 下调用写工具 | 未检索到「尚未启用该副作用工具」 | 抛 `RecoveryRequired`，运行转 `recovery_required` |
| 原型未读完就写文件或跑命令 | `context-runtime-efficient-files.cjs` 有 | 补一条：回执为 `failed`，`attempts` 为 1 |
| 写入参数含连接密钥 | `context-runtime-efficient-files.cjs` 有 | 补一条：不产生回执 |
| 无回执路径的命令证据 | 待基线确认 | 编号连续、`isTest` 判定、输出被改写 |
| 命令被取消 | 待基线确认 | 返回 `stopGroup`，同组后续调用记 `not-started-v1` |
| 准备类角色的 `actions` | 待基线确认 | 有回执时不追加，无回执时追加，保存失败回滚 |
| 四个角色各一次完整运行 | 分散在多个脚本 | 模型请求的 system、工具表、首条消息逐字节一致 |

「缺少已保存的逻辑调用身份」这条分支经 `runRuntime` 走不到（`runtime.ts` 第 167、216 行总是传入身份），保留代码，不为它造测试。

把新脚本接进 `test:context-runtime`。本步只加测试，不改 `src/`。

### 步骤 2：把闭包状态收成显式对象

`agentLoop` 的各个端口共享一批闭包变量，其中 `prototypeReadUntil` 和 `commands` 是可变的，被 `preparePrompt`、`saveCheckpoint`、`finish` 和 `tools.execute` 同时读写。不先把它们显式化，工具端口搬不出去。

在 `service.ts` 内（暂不新建文件）定义 `ExecutionRun`，收纳第 1520–1603 行准备出来的值：`role`、`preparing`、`phaseLabel`、`connection`、`taskRevision`、`contractFingerprint`、`reliable`、`budgetLease`、`executionRunId`、`environmentFingerprint`、`manifest`、`ledger`、`artifacts`、`prototype` 及其长度与版本、`offered`、`assertRevision`，以及可变的 `prototypeReadUntil` 和 `commands`。各闭包改成读写 `run.xxx`。

这一步是纯机械替换，语句顺序和数量都不变。检查：`npm run typecheck`、步骤 1 的等价脚本、`test:context-runtime`。

### 步骤 3：整体搬出工具端口

新建 `execution-tools.ts`，导出 `executionTools(run, host): RuntimePorts['tools']`，把第 1827–1976 行的 `tools` 对象原样搬过去，内部结构一行不动。`host` 是一个窄接口，只列工具端口实际用到的服务能力：`store`、`sourceFingerprint(p)`、`agentSkillReader(p, role, agent)`。`agentToolMessage`（第 98 行）一并搬走或改为导出。

`sourceFingerprint` 和 `agentSkillReader` 在 `EngineeringService` 上是 `private`，不能把 `this` 直接当作 `host` 传入。在 `agentLoop` 里用箭头函数包一层：`{ store: this.store, sourceFingerprint: p => this.sourceFingerprint(p), agentSkillReader: (p, role, agent) => this.agentSkillReader(p, role, agent) }`。这样既过类型检查，也保持调用时才取方法；不要为此把这两个方法改成 `public`。

`agentLoop` 里只剩 `tools: executionTools(run, host)`。

检查：`npm run typecheck`、等价脚本、`test:context-runtime`、`test:verification`、`node scripts/long-task-context.cjs`，以及步骤 0 第 3 条里纳入检查集的脚本。

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

### 步骤 6（可选）：方案规划接入同一管线

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
