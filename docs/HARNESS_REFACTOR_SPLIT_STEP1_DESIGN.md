# Harness 重构 · 拆分步骤 1 设计：工具管线等价脚本

2026-11-11 · 设计完成，尚未执行。执行方是 Codex，在 Windows 本机完成。本文是 [拆分阶段实施计划](HARNESS_REFACTOR_SPLIT_PLAN.md) 步骤 1 的展开，两者有出入时以本文为准。文中行号对应提交 `39d7299` 的源码（`src/`、`scripts/`、`package.json` 与 `d59c52d` 相同），动手时以语句为准。

本文里「已观察」的结果来自 Linux 沙箱里一份未改动的源码副本（Node v22.23.4），用一次性探针脚本跑出，每个场景连跑两次结果相同。探针没有进仓库。Windows 上没有验证过，命令取消场景在 Linux 上本来就跑不出正确结果，只能在本机做。

2026-11-11 并入了两轮后续核对的结果，用户已同意：[第三轮独立核对](../.scratch/harness-refactor/step1-crosscheck-3/README.md) 指出的 6.6 的一处出入、八个增补场景（6.12）、变异表的六行（第 7 节，其中四行是核对里建议的，另两行是并入时顺着同一处代码补的）和保存失败的注入方式（6.7）；以及按 6.7 的构造补跑的 [保存失败观察](../.scratch/harness-refactor/step1-crosscheck-4/README.md)。同日用户决定：第 8 节前两点的缺陷候选在拆分阶段不修，照现状进基准。

## 1. 目的和范围

拆分步骤 2 到 5 要把 `EngineeringService.agentLoop` 里的工具执行逻辑搬到新文件，要求行为不变。现有回归脚本覆盖主路径和崩溃恢复，但对「几次权限复核各自在什么时机生效」「落盘次数」「两条路径的输出差异」没有直接断言。步骤 1 在未改动的代码上把这些现状记成基准，之后每搬一步就对一次。

交付物是一个提交，包含三处改动：

1. 新增 `scripts/tool-pipeline-equivalence.cjs`。
2. 新增 `scripts/fixtures/tool-pipeline-equivalence.baseline.json`。
3. `package.json` 的 `test:context-runtime` 里，在 `node scripts/context-runtime-read-groups.cjs` 之后、`node scripts/context-runtime-smoke.cjs` 之前插入 `node scripts/tool-pipeline-equivalence.cjs`。`npm test` 那一行不含 `context-runtime-*` 脚本，不用改。

不做的事：不改 `src/` 下任何文件；不改 `scripts/fixtures/verification-runtime.cjs` 和其他现有脚本；不修本文第 8 节列出的现状问题；不开始步骤 2。

## 2. 脚本结构

脚本属于源码类，不读 `out/`，可以不 build 直接运行。写法沿用现有脚本：

```js
const r = require('./fixtures/verification-runtime.cjs')
const { fs, path, assert, sandbox, fixture, load, model, answer, call, run, testScript } = r
const budget = load('src/main/engineering/runtime-budget.ts')
```

每个场景是一个对象，由同一个执行器驱动：

```js
{
  name: 'revoke-in-work.effects.write',
  platform: undefined,              // 'win32' 表示只在 Windows 上运行和比较
  entry: 'run',                     // 'run' 走 runFeature；'agentLoop' 直接调 agentLoop
  role: 'developer',                // entry 为 'agentLoop' 时使用
  policy: 'receipts-effects-v1',    // '' 表示不设置 runtimePolicy，走无回执路径
  budget: false,                    // true 表示 policy 为空时也设 runtimeBudget（6.12）
  toolsExhausted: false,            // true 表示把累计工具额度设为 0（6.12）
  setup(ctx) {},                    // 写夹具文件、加原型、改智能体工具表
  reply(n, ctx) {},                 // 第 n 次模型请求的脚本化回复；返回 undefined 表示抛 CAPTURE_ONLY 结束
  onSave(ctx) {},                   // 每次真实保存成功之后调用，用来在指定落盘点收回权限
  failWrite(ctx) {},                // 返回 true 时让这一次落盘失败，整个场景只生效一次（6.7）
  stopWhen(ctx) {},                 // 返回 true 时调 ctx.service.stop('p')，执行器每 25 毫秒查一次（6.6）
  resume: false,                    // true 表示停止后再 run 一次，记录分成两份快照（6.6）
  capture: { requests: [1] }        // 要逐字记录的模型请求序号
}
```

执行器对每个场景做这些事，顺序固定：

1. `fixture()` 建隔离项目。`policy` 非空时设 `ctx.feature.runtimePolicy = policy`。`policy` 非空或场景设了 `budget: true` 时设 `ctx.feature.runtimeBudget = budget.newRuntimeBudget('equivalence')`；场景设了 `toolsExhausted: true` 时再设 `ctx.feature.runtimeBudget.limits.tools = 0`。额度要有一个独立于 `policy` 的开关，是因为 `service.ts` 第 1542 行建 `budgetLease` 只看 `f.runtimeBudget` 是否存在，不看运行策略，「无回执加额度」在代码上可达（第 657 行，用户调整额度时会给还没有额度的任务补一个）。
2. 调 `setup(ctx)`。
3. 包装 `store.save` 和 `store.event`（见第 4 节）。场景有 `failWrite` 时另外替换 `fs.writeFileSync`（见 6.7），在 `finally` 里恢复。
4. 替换 `model.complete`，签名是 `(connection, system, messages, tools, signal, onDelta, prepared)`。每次调用时记下 `messages`，按 `capture` 记录请求内容，然后返回 `reply(n, ctx)`。
5. `entry` 为 `run` 时 `await run(ctx.service)`。为 `agentLoop` 时照 `context-role-adaptive.cjs` 的写法：`ctx.service.executionAgent(ctx.feature, role 为 developer 或 preparer 时取 'developer' 否则取 'reviewer', 'p')`，再 `ctx.service.agentLoop(ctx.project, ctx.feature, agent, '', new AbortController().signal, { role })`，`feedback` 传空串。抛出的错误记下类名和消息，不让它中断脚本。场景有 `stopWhen` 时，运行期间用 `setInterval` 每 25 毫秒查一次，返回 `true` 就调 `ctx.service.stop('p')` 并停止轮询。
6. 采集（第 3 节）、归一化（第 5 节）。场景设了 `resume: true` 时，这次采集的结果记在 `stopped` 下；然后在同一个 `ctx.service` 上再 `await run(ctx.service)` 一次，`reply` 的序号接着往下数，再采集一次记在 `resumed` 下。两份快照的字段相同，计数器不清零，`resumed` 里是累计值。
7. 在 `finally` 里恢复 `model.complete`。

准备类角色（`preparer`、`diagnoser`）直接调 `agentLoop` 之前，要先放好 `feature.verificationPreparation`，写法见 `verification-preparation-stalls.cjs` 第 32–33 行：一个 `gaps` 条目，加一个 `status: 'running'`、`actions: []` 的 attempt。不要经过 `prepareVerification`，它会把 `verificationEnvironment` 的结果（平台、node 和 npm 的绝对路径、桌面能力探测）放进提示词。

命令行参数：

- 无参数：运行全部场景，与基准比较。有差异时打印场景名和第一处不同的字段路径，退出码为 1。
- `--update`：用本次结果重写基准。只在 `src/` 未改动时使用。在非 win32 上运行时，标了 `platform: 'win32'` 的场景保留基准里原有的记录。
- `--only <name>`：只跑名字匹配的场景，调试用。

每次运行把实际结果写到 `.runtime/context-runtime/tool-pipeline-equivalence/actual.json`，结束时删除 `sandbox`。

## 3. 每个场景记录什么

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `requests` | `model.complete` 的调用次数 | |
| `toolMessages` | 最后一次模型请求的 `messages` 里 `role === 'tool'` 的 `content` | 运行在工具执行后直接终止时为空，这时看 `events` |
| `events` | `project.events` | 每条记 `kind`；`tool`、`tool-result`、`error`、`historical-result` 四种另记 `message`。`output` 事件连续多条合并成一条 |
| `receipts` | `store.data.receiptJournals[JSON.stringify(['p','f'])].receipts` 的值，按插入顺序 | 每条记 `tool`、`strategy`、`status`、`attempts`、`applied`、`reason`、`effects`、`result.output` |
| `receiptTrace` | 每次计入的保存发生时，全部回执 `status` 连成的串 | 相邻重复的合并。用来发现落盘点移动 |
| `commands` | `agentLoop` 返回值的 `commands`；运行暂停时取 `store.data.executionCheckpoints` 里的 `commands` | 每条记 `id`、`command`、`isTest`、`code`、`evidenceKind`、`evidenceKinds`、`failureKind`、`stepId`、`output` |
| `saves` | 第 4 节的计数器 | 只比较 `counted` |
| `outcome` | `feature.contextRuntime.status` 和 `reason`、`feature.stage`、直接调 `agentLoop` 时抛出的错误类名和消息 | |
| `budget` | `feature.runtimeBudget.used` 的 `requests` 和 `tools` | 不记 `activeMs` |
| `actions` | `feature.verificationPreparation.attempts.at(-1).actions` | 只有准备类场景有 |
| `files` | 场景点名的文件是否存在及内容 | 例如 `a.txt`、`queued.txt` |
| `changes` | `project.changes` 的 `path` 列表 | |
| `secretInStore` | `JSON.stringify(store.data)` 是否含密钥样例 | 只有密钥场景有 |
| `captured` | 指定序号的模型请求的 `system`、`messages`、`tools` | 记归一化后的全文，不记哈希，出差异时能直接看出是哪一句 |

## 4. 保存次数的计法

`store.save()` 的次数是这份基准里最容易抓到「落盘点移动」的指标，但有两类保存的次数取决于机器快慢，必须单独计，不参与比较。

**活动时间预占。** 回执路径下 `RuntimeBudgetLease.reserveTime`（`runtime-budget.ts` 第 83 行起）以 1000 毫秒为窗口预占活动时间，到期由定时器或 `assertTime` 续期，每次续期保存一次。已观察：同一个写文件场景，模型回复不延迟时这类保存是 1 次，每次回复延迟 1300 毫秒时是 3 次，其余保存都是 29 次。

**命令输出事件。** `runCommand`（`files.ts` 第 441 行）每 900 毫秒把输出尾部记成一条 `output` 事件，结束时再记一次；`store.event` 每次都会保存。已观察：瞬间结束的命令是 1 条，跑 1.2 秒的命令是 2 条。

处理办法是在测试里打标记，不改源码：

```js
let inTime = 0
const reserveTime = budget.RuntimeBudgetLease.prototype.reserveTime
budget.RuntimeBudgetLease.prototype.reserveTime = function () {
  inTime++; try { return reserveTime.call(this) } finally { inTime-- }
}

// 每个场景内
const save = store.save.bind(store), event = store.event.bind(store)
let inOutput = 0
store.save = () => {
  save()
  if (inTime) saves.timeLease++
  else if (inOutput) saves.outputEvent++
  else { saves.counted++; trace() }
  scenario.onSave?.(ctx)
}
store.event = (project, kind, ...rest) => {
  if (kind === 'output') inOutput++
  try { return event(project, kind, ...rest) } finally { if (kind === 'output') inOutput-- }
}
```

`load()` 按绝对路径缓存模块，脚本里取到的 `RuntimeBudgetLease` 和 `service.ts` 用的是同一个类，改原型有效（已观察）。`reserveTime` 在 TypeScript 里标了 `private`，转译后是普通的原型方法。

要注意两点。`onSave` 里收回权限只改内存里的 `store.data.agents`，不调 `store.save()`，否则会改变计数。包装只在本脚本进程内有效，不影响其他脚本。

## 5. 归一化

对记录里的每个字符串依次做下面的替换，然后再比较。

| 内容 | 替换成 | 说明 |
| --- | --- | --- |
| 项目根目录 | `<ROOT>` | 三种写法都要替换：原样、反斜杠转义后的（出现在嵌套 JSON 里）、换成正斜杠的 |
| 资料目录、`sandbox` | `<PROFILE>`、`<SANDBOX>` | 同上 |
| UUID | `<UUID>` | 事件、回执、`executionRunId`、`runId`、`artifact:<uuid>` 等 |
| `call-0.` 加数字 | `<CALL>` | `call()` 生成的调用标识 |
| ISO 时间 | `<TIME>` | |
| 64 位十六进制串 | `<HASH>` | 源码指纹、验证合同指纹、环境指纹、制品版本、文件版本 |
| `"durationMs":数字` | `"durationMs":0` | 含转义写法 `\"durationMs\":数字` |

这些值为什么不稳定：`verificationContract`（`verification.ts` 第 93–97 行）的摘要里有项目根目录，夹具的根目录是随机临时目录，所以验证合同指纹每次都变；`sourceFingerprint`（`files.ts` 第 182–194 行）把相对路径连同系统的路径分隔符一起哈希；环境指纹含平台、架构和 Node 版本。

归一化之后脚本要自查一遍：结果里如果还出现 `coprojer-preparation-`（临时目录名的前缀），说明有路径没替换干净，直接报错，不写基准。

另外三条约定用来避开不稳定来源：

- 场景里不调用 `list_files`。它按 `readdirSync` 的返回顺序输出，不排序。
- npm 命令的输出文本不进基准，只记证据的 `id`、`command`、`isTest`、`code`、`failureKind`。npm 的报错里有日志路径和时间。
- 命令取消场景的命令输出只记是否包含 `PARTIAL_OUTPUT`。被取消前打印了几行取决于时机。

基准文件的格式：

```json
{
  "version": 1,
  "generated": { "commit": "39d7299", "platform": "win32", "node": "v22.18.0" },
  "scenarios": { "<场景名>": { } }
}
```

场景按名字排序，两个空格缩进。比较时把文件解析成对象再比，不比字节（Windows 检出可能是 CRLF）；`generated` 不参与比较。

## 6. 场景

「已观察」一栏是 Linux 沙箱里未改动源码的实际结果，写在这里供生成基准时核对。基准以 Windows 本机实际跑出的为准。除 6.6 以外的场景与平台无关，本机结果如果和这一栏不同，先停下来查原因，不要直接写进基准。

各场景默认以 `answer({ status: 'incomplete', summary: '停', nextStep: '核对' })` 收尾，开发角色的运行转为 `paused`，功能阶段是 `blocked`。下面的「计入保存」是第 4 节的 `saves.counted`。

### 6.1 运行中收回 live agent 的工具权限

权限复核在回执路径上最多三次：准备副作用之前（`service.ts` 第 1911、1923 行，只有写文件和命令有）、回执落盘之后（`ledger.execute` 里，`receipt-ledger.ts` 第 97 行）、`work()` 内（第 1850–1852 行）。无回执路径两次。三个时机这样构造：

- 准备前：在 `reply(1)` 返回工具调用之前，把这个工具从 live agent 的 `tools` 里去掉。
- 落盘后：`onSave` 里发现该工具的回执状态是 `prepared` 时去掉。
- `work()` 内：`onSave` 里发现该工具的回执状态是 `running` 时去掉。

| 场景 | 调用 | 已观察 | 计入保存 |
| --- | --- | --- | --- |
| `revoke-before.legacy.write` | `write_file` | 输出「工具错误：当前角色不可使用此工具。」；无回执；事件 `start, model, error, tool-result, model, developer, stopped`；`error` 的消息是「当前角色不可使用此工具；权限已变化，未执行模型返回的调用。」 | 23 |
| `revoke-before.legacy.read` | `read_file` | 同上 | 23 |
| `revoke-before.effects.write` | `write_file` | 同上，无回执 | 未单独计 |
| `revoke-before.effects.command` | `run_command` | 同上，无回执 | 24 |
| `revoke-before.effects.read` | `read_file` | 输出同上；回执 `readonly-v1 / prepared / 0`，未投影；有 `error` 事件。只读工具没有准备前那次复核，所以拒绝发生在落盘之后 | 25 |
| `revoke-after-persist.effects.write` | `write_file` | 输出同上；回执 `file-v1 / prepared / 0`，未投影；没有 `error` 和 `tool` 事件 | 未单独计 |
| `revoke-after-persist.effects.command` | `run_command` | 回执 `command-v1 / prepared / 0`，其余同上 | 24 |
| `revoke-after-persist.effects.read` | `read_file` | 回执 `readonly-v1 / prepared / 0`，其余同上 | 24 |
| `revoke-in-work.effects.write` | `write_file` | 输出同上；回执 `file-v1 / failed / 1`，已投影；文件没有写出 | 未单独计 |
| `revoke-in-work.effects.read` | `read_file` | 回执 `readonly-v1 / failed / 1`，已投影 | 28 |
| `revoke-in-work.effects.command` | `run_command` | 只有 1 次模型请求；回执停在 `command-v1 / running / 1`，未投影；事件 `start, model, error`；运行状态 `recovery_required`，原因「RecoveryRequired: 命令结果的身份、状态或资源不完整，禁止投影。」见第 8 节 | 16 |

再加两个不收回权限的对照：`write.legacy`（计入保存 24）和 `write.effects`（回执 `file-v1 / completed / 1`，计入保存 29）。

### 6.2 `receipts-readonly-v1` 下调用写工具

`readonly-policy.write`：`policy` 设为 `receipts-readonly-v1`，`reply(1)` 返回 `write_file`。已观察：1 次模型请求；无回执；事件 `start, model, error`；运行状态 `recovery_required`，原因「RecoveryRequired: 此运行版本尚未启用该副作用工具的恢复策略：write_file」。

### 6.3 原型未读完就写文件或跑命令

`setup` 里加原型：`ctx.feature.prototypeId = 'prototype'`，`ctx.project.prototypes.push({ id: 'prototype', title: '完整原型', html: '<main>' + 'x'.repeat(8000) + '</main>', at: new Date().toISOString() })`。

| 场景 | 回复序列 | 已观察 |
| --- | --- | --- |
| `prototype-unread.legacy` | `write_file`，然后 `run_command` | 两次输出都是「工具错误：请先完整分页读取已验收原型 prototype:prototype；当前已连续读取到 0 字符。」；无回执；没有 `tool` 事件；计入保存 31 |
| `prototype-unread.effects.write` | `write_file` | 输出同上；回执 `file-v1 / failed / 1`，已投影 |
| `prototype-unread.effects.command` | `run_command` | 回执停在 `command-v1 / running / 1`；运行状态 `recovery_required`。机制与 6.1 最后一行相同 |
| `prototype-read.effects` | `read_context`（`id: 'prototype:prototype'`，`offset: 0`），再读 `offset: 6000`，然后 `write_file` | 未在沙箱里跑过。`capture` 取第 1、2、3、4 次请求，用来固定「必读资料进度」和读完后附带原型全文这两段提示词 |

`prototype-unread.effects.write` 和 `.command` 连在一个场景里跑时（先写后跑命令），已观察到计入保存 30。分成两个场景后数字会不同，以本机生成的为准。

### 6.4 参数含连接密钥

密钥样例用 `'sk-isolatedfixture12345'`，与现有脚本相同。

| 场景 | 回复序列 | 已观察 |
| --- | --- | --- |
| `secret.effects` | `write_file`（`content` 含密钥），然后 `run_command`（`args` 含密钥） | 输出依次是「工具错误：工具内容包含受保护连接密钥，不能写入或保存该意图。」「工具错误：命令参数含受保护密钥，不能保存或执行。」；无回执；没有 `tool` 事件；`secretInStore` 为 `false`；计入保存 32 |
| `secret.legacy` | 同上 | 文件写入成功，命令也执行；`secretInStore` 为 `true`；计入保存 35。见第 8 节 |
| `secret.effects.patch` | 先让 `value.cjs` 的内容含密钥，再 `patch_file` | 未在沙箱里跑过。预期命中第 1917–1918 行的「补丁原文包含受保护连接密钥，无法可靠保存完整意图；未修改文件。」开发智能体默认没有 `patch_file`，`setup` 里要加进 `tools` |

### 6.5 命令证据

`setup` 里写三个文件：`tests/check.cjs` 打印 `OK sk-isolatedfixture12345`；`check.cjs`（在项目根）打印 `ROOT_CHECK`；`fail.cjs` 打印 `AssertionError: expected 5` 后 `process.exit(1)`。回复序列是五条命令：`node tests/check.cjs`（带 `evidenceKind: 'unit'`）、`node value.cjs`、`node check.cjs`、`node fail.cjs`、`npm test`（夹具的 `package.json` 没有 `test` 脚本，退出码 1）。

`commands.legacy` 和 `commands.effects` 各跑一遍。已观察，两条路径相同的部分：

| 编号 | 命令 | `isTest` | 退出码 | `failureKind` |
| --- | --- | --- | --- | --- |
| `check-1` | `node tests/check.cjs` | `true`（路径含 `tests`） | 0 | |
| `check-2` | `node value.cjs` | `false` | 0 | |
| `check-3` | `node check.cjs` | `true`（第 1894 行的补充规则） | 0 | |
| `check-4` | `node fail.cjs` | `false` | 1 | `check` |
| `check-5` | `npm test` | `true` | 1 | `condition` |

两条路径不同的部分：

- 输出里的密钥，无回执路径替换成 `[已隐藏密钥]`，回执路径替换成 `[REDACTED]`。
- 交给模型的工具输出，无回执路径是 `{ runId, artifact, code, output, evidenceId, evidenceKinds, measurements, sourceFingerprint, durationMs }`；回执路径是整条证据再加 `evidenceId` 和 `rawOutput`。
- 回执路径下退出码非零的命令，回执是 `command-v1 / failed / 1`，已投影。
- 计入保存：无回执路径 68，回执路径 89。

`node value.cjs` 没有输出，不产生 `output` 事件；其余四条各有 `output` 事件。

### 6.6 命令被取消（只在 win32 上）

照 `context-runtime-commands.cjs` 第 37–46 行 `cancel` 用例的构造：`tests/check.cjs` 起一个子进程 `tests/child.cjs`（它写出 `.runtime/child.json`），自己写 `partial.txt`、打印 `PARTIAL_OUTPUT`，然后每 200 毫秒打印一行。`reply(1)` 在同一组里返回 `run_command` 和 `write_file`（写 `queued.txt`），`reply(2)` 是默认的收尾回复。`stopWhen` 检查 `.runtime/child.json` 是否出现。场景设 `resume: true`。

这个构造不要简化。由孙进程写出触发文件，保证停止信号晚于 `PARTIAL_OUTPUT` 被采集；第三轮核对试过让同一个脚本先打印再挂住，大约七次里有一次输出没被采到。

`cancel.effects` 记两份快照，要固定的现状分别是：

| 快照 | 模型请求 | 回执 | 运行状态 | 事件 | 文件 |
| --- | --- | --- | --- | --- | --- |
| `stopped`（`stop` 之后） | 1 | 只有 `run_command / command-v1 / cancelled / 1`，已投影。`write_file` 这时还没有回执 | `cancelled`，原因 `AbortError: This operation was aborted` | `start, model, tool, tool-result, stopped` | `queued.txt` 不存在；`partial.txt` 记入了 `changes` |
| `resumed`（再 `run` 一次之后） | 2 | 另加 `write_file / not-started-v1 / cancelled / 0`，已投影，输出「未启动：原工具组已取消；本调用没有执行。」；命令回执仍是 `attempts` 为 1 | `paused` | 接着是 `start, resume`，两条 `tool-result`，然后 `model, developer, stopped` | `queued.txt` 仍不存在 |

排队调用的 `not-started-v1` 回执是续接那一次运行里写的，不是停止时写的。`runtime.ts` 第 155–163 行的循环里，每个调用开头先 `signal.throwIfAborted()`，然后才看 `stopped` 决定是否走 `ports.tools.skip`；用户停止时信号已经中止，轮到排队的调用时在 `throwIfAborted()` 就抛了 `AbortError`，`skip` 没有机会执行。本文原先把「未启动回执已投影」和「只有 1 次模型请求」写在同一时刻，两者不会同时成立，第三轮核对指出后改成现在的两份快照。现有的 `context-runtime-commands.cjs` 也是这个顺序：第 46 行在第一次运行后断言只有 1 次请求，对 `write_file` 回执的断言在续接之后。分成两份记，拆分步骤 4 重排时「排队调用何时记为未启动」也就固定住了。

上表的依据：在 Linux 上用一个不起孙进程的命令（所以能得到 `cancelled`）跑同样的两调用组，连跑三次结果相同，探针是 `.scratch/harness-refactor/step1-crosscheck-4/cancel-two-calls.cjs`；第三轮核对用三调用的组看到的也是同一个顺序。那个命令不写 `partial.txt`、不打印输出，所以表里关于 `partial.txt` 和 `PARTIAL_OUTPUT` 的部分没有在 Linux 上看过，沿用 `context-runtime-commands.cjs` 的现有断言。

Linux 沙箱里这个用例的命令回执是 `uncertain`（没有 Job Object），所以这个场景标 `platform: 'win32'`，非 win32 上跳过并打印一行说明。

### 6.7 准备类角色的 `actions`

直接调 `agentLoop`，`role` 为 `preparer`。`reply(1)` 返回 `write_file`（`path: 'tests/extra.cjs'`，新文件），`reply(2)` 返回 `answer({ status: 'ready', summary: '已补', nextStep: '独立复验' })`。

| 场景 | 注入 | 已观察 |
| --- | --- | --- |
| `preparer-actions.legacy` | 无 | `actions` 为 `created:tests/extra.cjs` 和 `write_file: 已写入 tests/extra.cjs（14 字节）`；事件 `model, tool, tool-result, model, verification-preparation-report`；运行状态 `completed` |
| `preparer-actions.effects` | 无 | `actions` 相同；回执 `file-v1 / completed / 1`，已投影 |
| `preparer-actions.legacy.save-fails` | `failWrite`：`actions` 里已经有以 `write_file: ` 开头的条目时，让那一次落盘失败 | 1 次模型请求；抛 `ReliabilityFailure`「工程记录保存失败，已停止新动作；请核对存储与恢复记录。」；`actions` 回滚到只剩 `created:tests/extra.cjs`；运行状态 `failed`；事件 `model, tool, tool-result`；`changes` 里有 `tests/extra.cjs` |
| `preparer-actions.effects.save-fails` | 同上 | 1 次模型请求；抛 `ReliabilityFailure`「调用记录保存失败；已停止新动作，请恢复存储后核对现场。」；`actions` 为空；回执 `file-v1 / completed / 1`，未投影；运行状态 `failed`；事件 `model, tool`；`changes` 为空 |

保存失败从 `node:fs` 这一层注入，不在 `store.save` 的包装里抛。真实的磁盘失败经过 `store.ts` 的 `save()`，被包成 `ReliabilityFailure`「工程记录保存失败……」再交给调用方；在包装里直接抛的错误，类型和文案都是生产环境里不会出现的，基准里记下的 `outcome` 也就不是真实失败时的样子。写法：

```js
const write = fs.writeFileSync
let failed = false
fs.writeFileSync = (target, ...rest) => {
  if (!failed && target === store.path + '.tmp' && scenario.failWrite(ctx)) { failed = true; throw new Error('injected disk failure') }
  return write(target, ...rest)
}
```

`store.ts` 转译后在调用时才取 `fs.writeFileSync`，夹具导出的 `fs` 与它用的是同一个模块对象，替换有效（已观察）。失败的那一次保存不计入 `saves.counted`，也不触发 `onSave`，第 4 节的包装不用改：真实的 `save()` 抛错后，后面的计数语句不会执行。`outcome` 只记最外层错误的类名和消息，不记 `cause`。

上表两个 `save-fails` 场景的「已观察」来自按这个写法补跑的一轮，连跑三次结果相同，探针和输出在 `.scratch/harness-refactor/step1-crosscheck-4/`。两个场景里 `tests/extra.cjs` 都已经写到磁盘上；回执路径上文件已写出而 `changes` 为空，是投影没有完成的现状，照实进基准。

两条路径最终都是两条 `actions`，但来源不同。无回执时，`executeTool` 的 `write_file` 分支追加 `created:`，`received`（第 1968–1973 行）追加工具那一条。有回执时两条都由 `applyReceiptProjection`（`execution-recovery.ts` 第 59–81 行）追加，`received` 自己不追加。拆分计划的场景表原先写「有回执时不追加」，说的是 `received` 这一处。

### 6.8 各角色的工具裁剪和命令限制

直接调 `agentLoop`，`setup` 里用 `testScript()` 写 `tests/verify.cjs`。每个场景跑无回执和 `receipts-effects-v1` 两遍，最后一次回复返回 `undefined`，让执行器抛 `CAPTURE_ONLY` 结束。

| 场景 | 回复序列 | 已观察的输出 |
| --- | --- | --- |
| `reviewer.tools` | `run_command node tests/verify.cjs`；`run_command node -e process.exit(0)`；`write_file` | 第一条成功，证据 `check-1`，`isTest` 为 `true`，输出 `ACTUAL_ASSERTION_PASSED value=5`；第二条「工具错误：验证角色请执行项目中的测试脚本。」；第三条「工具错误：当前角色不可使用此工具。」并有 `error` 事件 |
| `diagnoser.tools` | `run_command node tests/verify.cjs`；`read_file value.cjs` | 第一条「工具错误：当前角色不可使用此工具。」；第二条正常返回 |
| `preparer.tools` | `run_command node -e 1`；`run_command node tests/verify.cjs`；`write_file`（`path: 'value.cjs'`） | 第一条「工具错误：准备阶段只能执行项目检查/构建脚本或安装缺失的开发依赖；不允许内联代码、系统安装、常驻进程或外部命令。」；第二条成功，证据 `check-1`；第三条「工具错误：准备阶段只能写入 tests/test/__tests__/scripts/fixtures 测试资料，不能修改业务源码。」 |

两条路径的差别也要进基准：被 `authorizeCommand` 或 `preparationWrite` 拒绝的调用，无回执路径会先记一条 `tool` 事件再报错；回执路径在准备副作用时就被拒绝，没有 `tool` 事件，也没有回执。

### 6.9 四个角色的首次请求

`role-request.developer`、`.reviewer`、`.diagnoser`、`.preparer`：直接调 `agentLoop`，`reply(1)` 返回 `undefined`，`capture` 取第 1 次请求的 `system`、`messages`、`tools`。

已观察：同一角色两次运行的请求，替换根目录、UUID、时间和 64 位哈希之后完全相同；请求里不含平台字样。每个请求里有 2 个 UUID（任务事实投影里的 `executionRunId` 出现两次）、1 个时间（`evidence.updatedAt`）、4 个哈希。提供的工具：开发和准备是 `read_skill, read_context, list_files, read_file, write_file, run_command`；验证少 `write_file`；诊断只有 `read_skill, read_context, list_files, read_file`。

拆分计划的场景表写的是「四个角色各一次完整运行」。本设计把它拆成了三部分：首次请求的全文（本节）、各角色的工具执行（6.8）、准备角色的一次完整运行（6.7）。验证和诊断角色带报告契约的完整运行没有放进来，仍由 `test:verification` 的现有脚本负责。

### 6.10 只读并行组

`read-group.effects`：`reply(1)` 在一组里返回两个 `read_file`（`value.cjs`、`package.json`），`reply(2)` 在一组里返回 `read_file` 和 `write_file`。已观察：四条回执依次是三条 `readonly-v1 / completed / 1` 和一条 `file-v1 / completed / 1`；事件 `start, model, tool, tool-result, tool, tool-result, model, tool, tool-result, tool, tool-result, model, developer, stopped`；计入保存 58。同样的回复在无回执路径上（`read-group.legacy`）计入保存 38。

第一组全是只读调用，走 `planGroup` 和 `executeReadGroup`；第二组混有写调用，走逐个执行。两条分支各有一例。

### 6.11 两项拒绝条件同时成立

前面每个场景只让一项检查不通过，对调两项检查的先后不会改变任何一个场景的结果。下面两个场景各让两项同时不通过，用来固定先后。它们是另一轮独立探针补的，连跑两次结果相同，探针在 `.scratch/harness-refactor/step1-crosscheck/p6.cjs`。

| 场景 | 构造 | 已观察 | 固定的先后 |
| --- | --- | --- | --- |
| `order.unread-prototype.revoke-in-work.effects.write` | 6.3 的原型（未读），`write_file`，`onSave` 里发现回执为 `running` 时收回权限 | 输出「工具错误：当前角色不可使用此工具。」，不是原型必读那一句；回执 `file-v1 / failed / 1`，已投影；2 次模型请求 | `work()` 内 live agent 复查（第 1850–1852 行）先于原型必读检查（第 1853–1854 行） |
| `order.readonly-policy.revoke-before.write` | `policy` 设为 `receipts-readonly-v1`，在 `reply(1)` 返回 `write_file` 之前收回权限 | 1 次模型请求；无回执；`error` 事件两条，先是「当前角色不可使用此工具；权限已变化，未执行模型返回的调用。」，后是「此运行版本尚未启用该副作用工具的恢复策略：write_file」；运行状态 `recovery_required` | 运行策略检查（第 1909 行）先于写文件准备前的 `authorize()`（第 1911 行）。两者对调的话，结果会变成一条工具错误加第 2 次模型请求 |

第二个场景顺带说明一件事：「权限已变化，未执行模型返回的调用」这条 `error` 事件不是工具端口发的，它来自模型端口的 `receivedReply`（第 1782–1786 行），只发事件，不拦截调用。所以 6.1 里只有「准备前」收回的场景有这条事件，落盘之后才收回的场景没有。拆分步骤 3 搬工具端口时这段代码不跟着走。

### 6.12 更多的先后，以及累计工具额度

这一节的八个场景来自第三轮独立核对，在 Linux 上都跑过，连跑三次结果相同；探针在 `.scratch/harness-refactor/step1-crosscheck-3/probe.cjs`，它的场景名和字段名与本文不同，以本文为准。前四个与 6.11 同理，各让两项拒绝条件同时成立；后四个固定累计工具额度的预留位置，现有场景完全没有走到它。

`write_file` 的参数除特别说明外与 6.1 相同。原型的构造见 6.3，密钥样例见 6.4。「收回权限」指 6.1 的做法。

| 场景 | 构造 | 已观察 | 固定的先后 |
| --- | --- | --- | --- |
| `order.revoke-before.secret.effects.write` | `receipts-effects-v1`；`reply(1)` 返回之前收回 `write_file`；`content` 含密钥样例 | 输出「工具错误：当前角色不可使用此工具。」，不是密钥那一句；无回执；有「权限已变化」的 `error` 事件；2 次模型请求；事件 `start, model, error, tool-result, model, developer, stopped` | 写文件准备前的 `authorize()`（第 1911 行）先于密钥检查（第 1912 行） |
| `order.secret.unread-prototype.effects.write` | `receipts-effects-v1`；原型未读；`content` 含密钥样例 | 输出「工具错误：工具内容包含受保护连接密钥，不能写入或保存该意图。」；无回执；没有 `tool` 事件；2 次模型请求 | 准备阶段的密钥检查先于 `work()` 内的原型必读检查 |
| `order.path-escape.unread-prototype.effects.write` | `receipts-effects-v1`；原型未读；`path: '../outside.txt'` | 输出「工具错误：此路径不可由工程文件工具访问。」；无回执；没有 `tool` 事件 | 回执路径上路径检查在准备副作用时做，先于原型必读检查 |
| `order.path-escape.unread-prototype.legacy.write` | 无回执；其余同上 | 输出是原型必读那一句（「工具错误：请先完整分页读取已验收原型 prototype:prototype；当前已连续读取到 0 字符。」）；没有 `tool` 事件 | 无回执路径上原型必读检查先于路径检查。两条路径的先后相反，搬的时候容易被「统一」掉 |
| `budget.tools-exhausted.effects.write` | `receipts-effects-v1`；`toolsExhausted: true` | 1 次模型请求；回执停在 `file-v1 / prepared / 0`，未投影；运行状态 `paused`，原因「CumulativeBudgetPause: 任务累计工具调用额度已用完；继续不会清零，请由用户调整额度。」；事件 `start, model, stopped`；文件没有写出 | 意图先落盘，再预留工具额度 |
| `order.revoke-after-persist.tools-exhausted.effects.write` | 上一行再加：`onSave` 里发现回执为 `prepared` 时收回权限 | 输出「工具错误：当前角色不可使用此工具。」；2 次模型请求；回执 `file-v1 / prepared / 0`；没有 `error` 事件；运行状态 `paused`，原因是报告未完成，不是额度 | 账本回调（第 1937 行）里 `authorize()` 先于 `budgetLease?.reserve('tools')` |
| `budget.tools-exhausted.legacy.write` | 无回执；`budget: true`，`toolsExhausted: true` | 1 次模型请求；无回执；运行状态 `paused`，原因同 `budget.tools-exhausted.effects.write`；事件 `start, model, stopped` | 无回执路径也会预留额度 |
| `order.revoke-before.tools-exhausted.legacy.write` | 上一行再加：`reply(1)` 返回之前收回权限 | 输出「工具错误：当前角色不可使用此工具。」；2 次模型请求；有 `error` 事件；事件 `start, model, error, tool-result, model, developer, stopped` | 无回执路径（第 1906 行）`authorize(); budgetLease?.reserve('tools'); return work()` 里前两句的先后 |

最后两行走的是「无回执但有累计额度」这个组合，前提见第 2 节执行器第 1 步。真实数据里有没有任务处在这个组合没有查过；它在代码上可达，拆分时两句的先后就要保住。

这八个场景的计入保存没有按本文的计法数过，以本机生成的为准。

### 没有放进来的

- 「缺少已保存的逻辑调用身份」（第 1907 行）：经 `runRuntime` 走不到，拆分计划已说明不造测试。
- 任务修订号在工具执行期间变化：`context-runtime-commands.cjs` 第 102 行的 `old revision` 用例已覆盖。
- 命令超时和活动时间耗尽：`context-runtime-commands.cjs` 的 `timeout`、`active-time` 用例已覆盖，结果与耗时强相关，不适合做逐字基准。

## 7. 验收

Codex 做完后按下面的顺序自查，结果写进提交说明或回复里。

1. `git diff --stat HEAD -- src` 为空。
2. 在本机连续运行 `node scripts/tool-pipeline-equivalence.cjs` 三次，都通过。连续两次 `--update` 生成的基准文件内容相同。
3. 6.1 到 6.5、6.7 到 6.12 的本机结果与本文「已观察」一栏逐项核对，有出入的列出来。6.6 的两份快照与那一节的表逐项核对，有出入的同样列出来，不算停下来的理由（那张表的依据是 Linux 上的另一种构造）。
4. 变异检查。在工作区临时改 `service.ts`，每改一处跑一次脚本，确认脚本报错，然后撤销。这些改动都不提交。

   | 临时改动 | 应当报错的场景 |
   | --- | --- |
   | 删掉 `work()` 内的 live agent 复查（第 1850–1852 行） | `revoke-in-work.*` |
   | 删掉写文件准备前的 `authorize()`（第 1911 行） | `revoke-before.effects.write` |
   | 在 `received` 里多调一次 `this.store.save()` | 多数场景的 `saves.counted` |
   | 把原型必读检查（第 1853–1854 行）挪到 `tool` 事件之后 | `prototype-unread.*` 的事件序列 |
   | 把证据编号改成 `'check-' + commands.length` | `commands.legacy` |
   | 对调 `work()` 内的 live agent 复查和原型必读检查 | `order.unread-prototype.revoke-in-work.effects.write` |
   | 把运行策略检查（第 1909 行）挪到写文件准备前的 `authorize()` 之后 | `order.readonly-policy.revoke-before.write` |
   | 把 `preparePrompt` 里任意一句面向模型的文案改一个字 | `role-request.*` |
   | 删掉账本回调（第 1937 行）里的 `authorize()` | `revoke-after-persist.effects.*` |
   | 把写文件的密钥检查（第 1912 行）挪到 `authorize()`（第 1911 行）之前 | `order.revoke-before.secret.effects.write` |
   | 对调无回执路径（第 1906 行）的 `authorize()` 和 `budgetLease?.reserve('tools')` | `order.revoke-before.tools-exhausted.legacy.write` |
   | 对调账本回调（第 1937 行）里的 `authorize()` 和 `budgetLease?.reserve('tools')` | `order.revoke-after-persist.tools-exhausted.effects.write` |
   | `received` 的 `preparer` 分支少调一次 `this.store.save()` | 6.7、6.8 里准备角色场景的 `saves.counted` |
   | `received` 里保存失败后不回滚 `actions`（去掉 `catch` 里的还原） | `preparer-actions.legacy.save-fails` |

   前八行是本文原有的。后六行都在 Linux 沙箱的源码副本上用第三轮核对的探针试过，每一处都能发现（第四行是并入时补试的）；那是另一份探针，本脚本上要重新确认。

   哪一处改了之后脚本仍然通过，说明覆盖不够，先补场景再提交。
5. `npm run typecheck` 通过，`npm run test:context-runtime` 通过。新脚本单独运行的耗时记一下，目标是一分钟以内。
6. 最后再确认一次 `git diff --stat HEAD -- src` 为空。

遇到下面的情况停下来报告，不要自行处理：需要改 `src/` 或现有夹具才能让场景跑起来；某个场景连跑三次结果不同且找不到不稳定来源；与平台无关的场景在本机的结果和「已观察」不同。

不要运行读取 `%APPDATA%\Coprojer-dev` 的脚本，清单见 `CLAUDE.md`。

## 8. 探针里发现的现状

下面四点是写这份设计时看到的现有行为。基准照实记录它们，拆分阶段不改。其中前两点像是缺陷。用户 2026-11-11 的决定：拆分阶段不修，现状固定进基准；修复留到拆分步骤 2–5 完成之后单独交办，那时改动单独一个提交、说明原因，并重建基准。修复的做法现在没有设计，执行方不要顺手修。

1. **回执路径下，命令在启动之前失败会让任务进入 `recovery_required`。** `work()` 里在 `executeCommandEffect` 之前抛出的普通错误（原型没读完、`work()` 内发现权限被收回），`ledger.execute` 会按 `failed` 封存回执（`receipt-ledger.ts` 第 107–110 行）。但命令回执的校验 `assertCommandResult`（`command-effects.ts` 第 46–54 行）要求结果里带命令证据，这时没有，于是抛 `RecoveryRequired`「命令结果的身份、状态或资源不完整，禁止投影。」，回执停在 `running`。同样的情形下写文件只是返回一条工具错误，模型可以接着读原型。也就是说，模型在读完原型之前先调了一次 `run_command`，任务就要人工核对才能继续。这是默认流程能走到的情况：`service.ts` 第 1077 行给新建功能设的就是 `receipts-effects-v1`。在 Linux 上对停在 `running` 的任务再继续一次，回执转成 `uncertain`，提示「尚无监督进程的持久结束凭证；停止与部分效果均待核对。」；续接后的表现只在 Linux 上看过，不进基准。
2. **无回执路径不检查写入内容里的连接密钥。** 「工具内容包含受保护连接密钥」这项检查只在回执路径上（第 1912、1924 行）。无回执路径下含密钥的 `write_file` 会写入成功，密钥原文还会进入 `engineering-v1.json`（探针里 `JSON.stringify(store.data)` 能搜到）。
3. **两条路径的密钥占位符不同。** 命令输出里的密钥，无回执路径替换成 `[已隐藏密钥]`，回执路径替换成 `[REDACTED]`。
4. **被角色规则拒绝的调用，两条路径的事件不同。** 见 6.8 末尾。

## 9. 之后的步骤

步骤 2 到 6 按 [拆分阶段实施计划](HARNESS_REFACTOR_SPLIT_PLAN.md) 执行，每步一个提交，每步跑完该步列出的检查，其中都包含这个等价脚本。基准文件自建立后不应再改动；某一步之后脚本报出差异，按计划的规定回退那个提交，不改基准。唯一的例外是第 8 节前两点的修复，它排在拆分之后，由用户单独交办，届时重建基准。步骤 2 何时开始由用户决定。
