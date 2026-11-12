# Harness 重构 · 存储搬迁步骤 0 设计：落盘测量

2026-11-11 · 设计完成，尚未执行。执行方是 Codex，在 Windows 本机完成。本文是 [存储搬迁计划](HARNESS_REFACTOR_STORAGE_PLAN.md) 步骤 0 的展开，两者有出入时以本文为准。文中行号对应提交 `39d7299`，动手时以语句为准。

这一步只加一个测量脚本，不改 `src/`，不依赖 [ADR 0007](adr/0007-append-only-run-log-run-id-and-readonly-delegation.md) 被接受，也不依赖拆分阶段，可以随时做。存储搬迁的步骤 1 到 7 不在本文范围内。

本文里「已观察」的结果来自 Linux 沙箱里一份未改动的源码副本，用一次性探针跑出；探针放在 `.scratch/harness-refactor/step1-crosscheck/`。「未核对」的地方只读过代码。沙箱里的次数可以参考，耗时没有参考价值，耗时以本机为准。

## 1. 目的

存储搬迁计划里「每次请求约 7 次全量落盘、每次工具调用约 6 次、请求和工具两侧合计约 1850 次，加上时间续约合计约 5450 次」是按代码路径数出来的。搬迁之前要有一组本机实测，用途有四个：

1. 替换计划里的推算。
2. 判断 ADR 0007 第二项的分级值不值：回执、额度、检查点逐条 fsync，其余只追加。
3. 给「活动时间续约的间隔要不要放宽」提供依据（计划「仍待处理」第一条）。
4. 列出今天哪些保存是由活动事件、回执或额度触发、却顺带把还没落盘的业务状态提交了下去。这些记录改走日志之后捎带不再发生，对应的调用点要补显式保存（ADR 0007 第九项、计划步骤 4）。

本文只要求测出数字和清单，不对分级、续约间隔和实施顺序下结论。

## 2. 交付物

一个提交，包含两处改动：

1. 新增 `scripts/storage-save-baseline.cjs`。它是测量工具，不是回归脚本，不接进 `package.json` 的任何命令。
2. 在存储搬迁计划「现状」一节的「推算的次数」那一段之后，加一段「实测」，写日期、提交号、机器、Node 版本和第 6 节的汇总数字。原有的推算和其他各节不动。

运行产物写到 `.runtime/harness-refactor/storage-baseline/`，不进仓库：`saves-<负载>.jsonl`、`reservations-<负载>.jsonl`、`summary.json`、`summary.md`、`event-callsites.md`。

不做的事：不改 `src/`、`package.json`、现有脚本和夹具；不读 `%APPDATA%\Coprojer-dev`；不运行 `CLAUDE.md` 列出的读真实资料目录的脚本。

## 3. 测量办法

脚本属于源码类，用 `scripts/fixtures/verification-runtime.cjs` 的 `fixture()` 建隔离资料目录和隔离工程，可以不 build 直接运行。

**模型。** 用 `scripts/fixtures/context-runtime-provider.cjs` 的 `provider(handler)` 起受控服务，不直接替换 `model.complete`。请求要走真实的流式路径，请求状态和用量的保存才会像实际运行那样发生。写法参照 `scripts/context-runtime-efficiency.cjs`。每个回复都带 `usage`，否则用量那一次保存不出现。

**计次。** 包住 `store.save`，每次保存往 `saves-<负载>.jsonl` 写一行。字段见本节末尾。

**各段耗时。** 临时替换 `node:fs` 模块上的 `writeFileSync`、`fsyncSync`、`renameSync`，只在目标是 `store.path + '.tmp'`（改名时是目标为 `store.path`）时计时。已观察：`store.ts` 转译后是在调用时从模块对象上取这几个函数，替换有效。四段这样取：

- 序列化：进入 `save` 到进入 `writeFileSync` 之间。字节数取传给 `writeFileSync` 的字符串的 UTF-8 长度。
- 写入、fsync、改名：各自函数的耗时。改名在 Windows 上最多重试 5 次，重试次数另记。

**来源标记。** 用进入计数，不解析调用栈：

```js
let inEvent = '', inTime = 0, inReserve = ''
const proto = budget.RuntimeBudgetLease.prototype
const reserveTime = proto.reserveTime, reserve = proto.reserve
proto.reserveTime = function () { inTime++; try { return reserveTime.apply(this, arguments) } finally { inTime-- } }
proto.reserve = function (dimension) { inReserve = dimension; try { return reserve.apply(this, arguments) } finally { inReserve = '' } }
const event = store.event
store.event = function (project, kind) { const outer = inEvent; inEvent = kind; try { return event.apply(this, arguments) } finally { inEvent = outer } }
```

`load()` 按绝对路径缓存模块，脚本取到的 `RuntimeBudgetLease` 和 `service.ts` 用的是同一个类（已观察）。标记只能认出这三种来源，其余的保存靠下面的「变化的部分」归类。

**变化的部分。** 每次保存之前，对 `store.data` 的下列各部分分别算摘要，与上一次保存时比较，记下哪些变了。划分与存储搬迁计划「记录种类与可靠性等级」一致：

| 部分 | 取自 | 搬迁后 |
| --- | --- | --- |
| 回执 | `receiptJournals` | 日志，逐条 fsync |
| 额度 | 功能上的 `runtimeBudget` | 日志，逐条 fsync |
| 检查点 | `executionCheckpoints` | 检查点文件 |
| 请求与用量 | `contextRuntime.requests` | 日志，只追加 |
| 压缩、操作、预算 | `contextRuntime.compactions`、`operations`、`latestBudget` | 日志，只追加 |
| 回执视图 | `contextRuntime.receipts` | 由回执重建 |
| 活动事件 | `project.events` | 日志，只追加 |
| 上下文运行状态其余字段 | `contextRuntime` 去掉以上各项（`manifest`、`manifests`、`status`、`reason`、`view` 等） | 未定 |
| 交接原件 | `runtimeOriginals` | 计划步骤 5 |
| 变更登记 | `project.changes` | 留在主文件 |
| 业务其余 | 整份数据去掉以上各项 | 留在主文件 |

一次保存里最后三行有任何一行变了，就是「业务状态随这次保存落盘」。它由事件、回执、额度或请求记录触发时，记为一次捎带。

**两遍。** 算摘要有开销，会拉长运行、多出几次时间续约，也会污染耗时。每个负载跑两遍：第一遍只记次数、字节数和耗时；第二遍加上「变化的部分」，不采耗时。两遍里不在 `reserveTime` 之内的保存次数应当相同，不同就在回报里写明差在哪一类。

**活动时间预占。** 另写 `reservations-<负载>.jsonl`：每次进入 `reserveTime` 的时刻、里面落盘几次、落盘耗时、返回时实例上的 `reservationWindow`。窗口初值 1000 毫秒，落盘慢时放大为落盘耗时的 2 倍（`runtime-budget.ts` 第 97 行）。已观察：一个几秒钟的场景里这类保存是 2 到 3 次，每次运行不一样，所以它单列，不并入其他次数。

**`output` 事件。** `runCommand` 每 900 毫秒把命令输出尾部记成一条 `output` 事件（`files.ts` 第 441 行），次数随命令耗时变化。它靠 `inEvent === 'output'` 认出来，汇总时单列。

`saves-<负载>.jsonl` 每行的字段：序号；距开始的毫秒数；所在的模型请求序号；最近一次工具调用的名字；`inEvent`、`inTime`、`inReserve`；变化的部分（只在第二遍有）；字节数；四段耗时与合计（只在第一遍有）；改名重试次数。

脚本结束前在 `finally` 里还原 `fs` 上的三个函数、两个原型方法和 `store` 上的两个方法，关掉受控服务，删除 `sandbox`。

## 4. 负载

除 W2 以外都走回执路径：`feature.runtimePolicy = 'receipts-effects-v1'`，`feature.runtimeBudget = newRuntimeBudget(JSON.stringify(['p', 'f']))`。新建功能的默认值就是它（`service.ts` 第 1077 行）。开发智能体的工具表补上 `search_files`、`read_file_lines`、`patch_file`，写法同 `scripts/context-runtime-efficient-files.cjs` 的 `setup()`。夹具的项目没有已验收原型，不触发原型必读。

| 编号 | 内容 | 用途 |
| --- | --- | --- |
| W1 | 一次开发运行，35 个工具回合加一次收尾，共 36 次请求、225 次工具调用。前 15 个回合每回合 10 次只读调用，中间 10 个回合每回合 5 次 `write_file` 或 `patch_file`，最后 10 个回合共 25 次 `run_command` | 主数字 |
| W2 | 与 W1 的回复序列相同，不设 `runtimePolicy` | 无回执路径的对照 |
| W3 | 3 个回合，每回合 1 次命令，每条命令等 5 秒后退出，`timeoutSeconds` 设 10 | 续约次数、每次续约的落盘耗时、窗口有没有放大、`output` 事件的次数 |
| W4 | 一个功能从开发走到最终验收：开发完成、独立验证通过、`service.accept('p', 'f')`。各阶段的回复序列参照 `scripts/verification-preparation.cjs` 第 55–64 行那个用例（它直接替换 `model.complete`，这里把同样的回复搬到受控服务的 `handler` 里） | 让各阶段的事件种类都出现，产出捎带清单 |
| W5 | 取 W1 结束时的 `store.data`，把功能 `f` 连同它的回执台账和检查点复制成多份（换功能标识和键，`stage` 设为 `done`），让序列化后的大小落在约 5、20、50 MB 三档。每档调 20 次 `store.save()`；再用夹具的 `restoreIsolated(profile)` 重新打开 5 次 | 大文件下的单次落盘耗时和启动读入耗时 |

W1 的构造要注意四点：

- 工具调用数取 225，与 2026-10-13 那次真实任务相同。请求数只有那次的一半（36 对 72），因为执行角色的步数上限是 36（`execution.ts`）。汇总时按单位成本折算，不直接比总数。
- 开发角色没有单回合调用数上限（`service.ts` 第 1695 行的 `maxCalls` 只约束诊断和准备角色）。全是只读调用的回合走并行读组，混有写调用的回合逐个执行。
- 收敛保护会在连续 5 次重复调用没有新信息时暂停运行（`execution-progress.ts`）。150 次只读调用要读不同的文件或不同的行段；25 条命令的参数或输出要各不相同。`setup` 里预先写好够用的小文件。
- 文件都控制在 1 KB 以内，整次运行不触发压缩。压缩那一类保存的次数用 `scripts/context-runtime-efficiency.cjs` 的 `compactions` 用例的构造另跑一个小负载补上，列在汇总的「压缩」一行；它不是主数字。

命令脚本打印固定文本后立即退出，退出码用 `process.exitCode` 设置。W3 的命令用 `setTimeout` 等待，不用忙等。

W5 是合成状态：复制出来的功能内容相同，只用来测大小对耗时的影响，不代表真实资料的构成。`restoreIsolated` 测到的是新建 `EngineeringService` 的总耗时；其中读文件并解析那一段另用 `JSON.parse(fs.readFileSync(store.path, 'utf8'))` 单独计时。存储搬迁计划「仍待处理」里的「启动重放的耗时」指搬迁之后重放日志的耗时，现在还没有日志，这一步测不了，只能给出今天读入主文件的耗时作对照。

真实资料目录不读。`%APPDATA%\Coprojer-dev\engineering-v1.json` 的实际大小由用户另行告知，用来判断 W5 的哪一档最接近。

## 5. 静态清单

`event-callsites.md` 列出 `src/main` 里 `store.event(` 的全部调用点。计划里数的是 62 处，其中 44 处带功能、18 处不带，以实际为准。每处一行：

| 列 | 来源 |
| --- | --- |
| 文件与行号、事件种类、带不带功能 | 读代码 |
| 这次事件之前，同一段同步代码里有没有改过业务状态而尚未保存 | 读代码 |
| 这次事件之后是否紧跟一次显式保存 | 读代码 |
| W1 到 W4 有没有走到 | 测量 |
| 走到时业务状态是否随它落盘 | 测量 |

第二列为「有」、第三列为「否」的调用点，就是事件改走日志之后必须补显式保存的地方。测量没走到的调用点只有读代码的结论，在表里标明。

回执的 `put`、额度预占、请求记录这三类落盘点数量少，不单独列表，在汇总里各给一行。

## 6. 汇总

`summary.md` 至少有下面七项，每个数字都要能从 `saves-*.jsonl` 复算：

1. W1、W2 各自的保存总数，按来源分列：回执、请求与用量、检查点、活动事件（`output` 单列）、额度预占（请求、工具分列）、活动时间预占、变更登记、压缩与操作、其他。
2. 单位成本：每次模型请求平均几次保存；每次只读调用、每次写文件、每次命令各几次。用它重算 72 次请求、225 次工具调用的合计，与计划里的 1850 次对照，差得多的话指出差在哪一类。
3. 单次保存的字节数和四段耗时：最小、中位、P95、最大。主文件大小随回合数的变化，每回合末取一次。
4. W3：续约次数、每次续约的落盘耗时、`reservationWindow` 的序列、`output` 事件的次数。
5. W5：三档的单次落盘耗时（四段分列）和读入耗时。
6. 捎带清单：按事件种类列出保存次数和其中业务状态随之落盘的次数；回执、额度预占、请求记录各一行。
7. 测量过程中发现的、与存储搬迁计划「现状」一节不符的地方。

沙箱里观察到的次数，供核对量级用：一个「读一次、写一次、收尾」的场景，回执路径下不含时间预占的保存是 44 次，无回执路径是 34 次；「两条命令、写一次、收尾」分别是 61 次和 48 次。这四个数来自直接替换 `model.complete` 的探针，没有走流式路径，回复里也没有带用量；本机用受控服务跑出来的数可能不同，不要拿它们当验收标准。

## 7. 验收

Codex 做完后按下面的顺序自查，结果写进回复里。

1. `git diff --stat HEAD -- src scripts/fixtures package.json` 为空。
2. 每个负载的两遍里，不在 `reserveTime` 之内的保存次数相同；不同的话已说明。
3. W1 跑完时 `feature.runtimeBudget.used` 的 `requests` 是 36、`tools` 是 225，运行没有被收敛保护或步数上限打断。
4. `summary.md` 七项齐全。
5. `npm run typecheck` 通过。新脚本不在回归命令里，不需要跑 `test:context-runtime`。
6. 存储搬迁计划里只多了「实测」一段。

遇到下面的情况停下来报告，不要自行处理：需要改 `src/` 或现有夹具才能测到某一项；W1 凑不到 225 次工具调用；同一负载连跑两次，不含时间预占和 `output` 事件的保存次数不一样；测出来的结果与计划「现状」一节的描述有实质出入。

## 8. 测量之后

数字写回计划之后，下面几件事由用户决定，不由执行方决定：活动时间续约的间隔放不放宽、放到多少；ADR 0007 第二项的分级要不要调整；`event-callsites.md` 里需要补显式保存的调用点怎样处理，这属于计划步骤 4，要等存储搬迁的开工条件满足（见执行说明第 2 节）。
