# Harness 重构 · 交给 Codex 的执行说明

2026-11-12 · 第一批基准与测量、运行标识 A0 特征测试已完成，产品结构拆分步骤3已实现，验证尚未全通过，失败及旧版对照见本步执行记录。本文把 harness 重构整理成可以逐批交办的工作包，供 Codex 执行。它不新增决定：决定在 ADR 0005、0006、0007 里，各阶段的做法在四份计划里。本文补三样东西：现在哪一步可以开工、哪一步不行；每个提交都要守的规则；运行标识这一阶段逐提交的做法，也就是计划里原先写着「动手时定」「待定」的部分。

第一批任务（拆分步骤 1 的等价脚本、存储步骤 0 的落盘测量）已经有单独的任务书：[第一批执行任务书](HARNESS_REFACTOR_CODEX_BRIEF.md)，做法在它指向的两份设计文档里（[拆分步骤 1 设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md)、[存储搬迁步骤 0 设计](HARNESS_REFACTOR_STORAGE_STEP0_DESIGN.md)）。那两件事照任务书和设计文档做，本文不重复；本文管的是第一批之后的各批。

文中行号对应提交 `39d7299`。拆分之后语句会搬家，一律以语句为准，行号只用来定位。

本文的源码核对只读了代码和脚本，没有运行任何东西。标「拟定」的内容没有经用户确认，汇总在第 10 节，每项都列了备选；动到这些地方之前先看那张表，用户没有确认的不要当成已定。2026-11-11 用户接受 ADR 0007 时确认了第 10 节 A 组十项，按「本文采用」一列；S 组和 C 组没有确认。

## 1　先读什么

1. `AGENTS.md`：测试窗口放哪块屏、UI 基准、验证与记录、截图要求。
2. `CLAUDE.md`：常用命令、测试的两类脚本、「Harness 架构地图」和「不能破坏的产品约束」。
3. 本文第 2、3 节。
4. 当前要做的那一阶段的计划（见第 4 节的表），以及它引用的 ADR。

文档之间有出入时：ADR 优先于计划，计划优先于本文；第一批的两个任务以任务书和它指向的设计文档为准；存储上两份计划有出入时以 [存储搬迁计划](HARNESS_REFACTOR_STORAGE_PLAN.md) 为准。发现出入先停下报告，不要自己挑一个执行。领域用语以 `docs/architecture/DOMAIN.md` 为准。

## 2　现在能做什么

| 阶段 | 依据 | 现在的状态 | 开工条件 |
| --- | --- | --- | --- |
| 拆分步骤 0（基线） | [拆分计划](HARNESS_REFACTOR_SPLIT_PLAN.md) | 已完成。本机 43 项过 42，结果在 `.runtime/harness-refactor/baseline/windows/` | — |
| 第一批：拆分步骤 1、存储步骤 0 | 第一批执行任务书和两份设计文档 | 已完成：任务 A `999565d`，任务 B `9784c20`（2026-11-11，本地提交，未 push） | 两个任务均未改 `src/`；回报见下文 |
| 拆分步骤 2 | [拆分计划](HARNESS_REFACTOR_SPLIT_PLAN.md) | 已完成（2026-11-11，本地提交，未 push） | 同文件 `ExecutionRun` 收拢20项现有状态，等价与完整回归通过；回报见下文 |
| 拆分步骤 3 | [拆分计划](HARNESS_REFACTOR_SPLIT_PLAN.md) | 代码已实现，验证未全绿（2026-11-12） | 工具端口已整体搬出；4个脚本失败，旧版对照及证据边界详见本步回报，不将失败项记为通过 |
| 拆分步骤 4–5，步骤 6 可选 | [ADR 0005](adr/0005-tool-pipeline-and-free-coding-entry.md)（已接受）、拆分计划 | 未开工 | 先处理步骤3回报中的失败与验收结论；用户交办时点名后续步骤号 |
| 运行标识 A0（只加特征测试） | 本文 6.2 | 已完成（2026-11-11，本地提交，未 push） | R1–R8 全部通过，已接入 `test:context-runtime`；未改 `src/`，回报见下文 |
| 运行标识 A1–A8 | [ADR 0007](adr/0007-append-only-run-log-run-id-and-readonly-delegation.md) 第五、六项，[运行标识计划](HARNESS_REFACTOR_RUN_ID_STORAGE_DELEGATION_PLAN.md) A 部分，本文第 6 节 | 未开工 | ADR 0007 已接受、第 10 节 A 组已确认（2026-11-11）。还差：拆分步骤 2–5 完成；用户点名 |
| 上下文与压缩步骤 1–7 | [ADR 0006](adr/0006-stable-prompt-prefix-and-working-window.md)（已接受）、[上下文计划](HARNESS_REFACTOR_CONTEXT_PLAN.md) | 未开工 | 拆分步骤 2–5 完成；用户点名。与运行标识的先后见第 7 节 |
| 存储搬迁步骤 1–7 | ADR 0007 第一至四、九至十一项，存储搬迁计划 | 未开工 | ADR 0007 已接受（2026-11-11）。还差：运行标识完成；步骤 0 的数字已写回计划；该计划「仍待处理」里挡路的条目已由用户定下（第 8 节有建议，建议不等于已定） |
| 缺陷候选的修复 | [拆分步骤 1 设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md) 第 8 节第 1、2 点 | 用户 2026-11-11 决定拆分阶段不修，现状固定进等价基准；没有修复设计 | 不可开工。拆分步骤 2–5 完成后由用户另行交办；修复是单独的提交，并重建等价基准 |
| 规则、审批、通用 shell、自由编码入口 | ADR 0005 第五、六项 | 没有计划 | 不可开工 |
| 只读委派 | ADR 0007 第七、八项，运行标识计划 C 部分 | 只有形态，没有实施计划 | 不可开工，见第 9 节 |

ADR 0007 已于 2026-11-11 被接受。ADR 已接受不等于可以动手：上表的开工条件要逐条满足，每一步都要用户点名。

**第一批执行记录。** 任务 A 的50个等价场景连续三次通过，连续两次生成基准相同，14项临时变异均被检测；源码按原字节恢复。类型检查通过，第二次完整 `npm run test:context-runtime` 的18个脚本全部通过；首轮 `reload-smoke` 导航超时、与现场吻合的既有脚本竞态及单独复跑结果保留在 [任务 A 本机回报](../.scratch/harness-refactor/codex-report-A.md)。任务 B 完成8组双遍测量和62处事件调用点清单，数字已写回存储计划，详见 [任务 B 本机回报](../.scratch/harness-refactor/codex-report-B.md)。默认 legacy 的两种短负载均触发压缩，故 W1/W2 仅在隔离夹具显式采用已有 adaptive 256K 配置来单列压缩成本；产品默认与存储待定项未改。原始探针和正式数据均留在 `.runtime/harness-refactor/storage-baseline/`。后续进度见上表及 A0 执行记录。

**A0 执行记录。** 按后续提示词 3.1 完成 R1–R8 特征测试。正式独立运行两次均 8/8 通过；`npm run typecheck` 通过，完整 `npm run test:context-runtime` 首次运行的19个脚本全部通过，其中50个等价场景差异为0，5个 Electron 冒烟脚本通过。R1 的计数为40次，R2 首段29次、两段累计59次；已排除活动时间预占和 `output` 事件保存，计数固化在脚本中。真实 HTTP/SSE 链路验证了流量记录器 `start` 抛错不影响推理；运行标识仍保持当前行为，未提前实现 A1–A8。详情见 [A0 本机回报](../.scratch/harness-refactor/codex-report-A0.md)，原始产物和日志在 `.runtime/harness-refactor/run-identity/`。A0 当批未改产品源码。

**拆分步骤2执行记录。** 在 `service.ts` 内新增 `ExecutionRun`，收纳20项已有状态，195处绑定引用改为 `run` 字段访问；初始化先后、命令数组及 manifest 共享引用、保存与回执顺序保持。类型检查通过，独立等价脚本50个场景差异为0；完整 `test:context-runtime` 首次运行的构建及19个脚本全部通过，套件内等价复验仍为0差异，A0 为8/8且计数仍为40／29／59，5个 Electron 冒烟脚本通过。两份独立静态审查无剩余发现。详情见 [拆分步骤2本机回报](../.scratch/harness-refactor/codex-report-split-2.md)，日志在 `.runtime/harness-refactor/split-2/`。步骤2当批没有搬出工具端口或开展后续工作包。

**拆分步骤3执行记录（2026-11-12）。** 工具端口及 `agentToolMessage` 已整体搬至 `execution-tools.ts`，`agentLoop` 通过窄 host 接口调用工厂；原执行结构、权限复核和落盘顺序保持。类型检查与两次构建通过，50场景等价验证两次均0差异，A0 为8/8且计数仍为40／29／59。规定的35个原脚本均已执行：context-runtime 18/19、verification 8/11、long-task-context及四项补充5/5，共31通过、4失败；其中10个 Electron 冒烟全部通过。两个完整 npm 命令都因失败退出1，受中断影响的后续原脚本另行串行运行，没有把续跑结果冒充完整命令通过。

失败脚本为 `context-runtime-commands`（2.5秒活动时限场景缺少预期输出）、`execution-budget`（15秒等待结束断言）、`execution-convergence`（18秒等待结束断言）、`verification-preparation-stalls`（客户端已按时超时，额外等30毫秒后仍未观察到服务器连接关闭）。用拆分前 `5538403` 的原 service 源码作同机对照，四个脚本也均失败；收敛脚本当前10/11、旧版7/11，失败集合及超时阶段不同，不能宣称一一等价或共同根因。实现已落地，验收未全通过；未改测试、预算或等价基准，未推进步骤4。完整证据和诊断见 [拆分步骤3本机回报](../.scratch/harness-refactor/codex-report-split-3.md)，日志及35项汇总在 `.runtime/harness-refactor/split-3/`。

## 3　每个提交都要守的规则

第一批任务书的「通用约束」八条对后面各批同样适用，只有第 1 条「不改 `src/`」从拆分步骤 2 起按当批的计划放开。下面是任务书没有写、或者从改产品代码那一批起才用得上的规则。

**环境。**

- 验证一律用隔离资料目录：设 `COPROJER_USER_DATA`。不读写用户的真实工作区、凭据和模型密钥。
- 不运行读取 `%APPDATA%\Coprojer-dev` 的 11 个脚本：`context-runtime-real-*`、`context-window-real`、`context-window-project-replay`、`execution-project-resume-probe`、`execution-prototype-real`、`project-adaptive-context*`、`project-role-adaptive-context`、`pomodoro-live-verification`。拿不准时先在脚本里搜 `process.env.APPDATA`。
- 仓库根上不做无范围的 find / grep，指定 `src`、`docs`、`scripts`。
- 界面类脚本的窗口按 `AGENTS.md` 放到 1 号非主屏显示器，不可用时回退主屏。
- `context-runtime-migration-smoke` 在基线里失败过一次，随后连跑 3 次没有复现。它在 860×600 布局检查处超时的话先单独重跑，重跑仍失败才算回归。

**测试的加载方式带来的限制**（原文见拆分计划「硬约束」，所有阶段都适用）。

- 源码类脚本用 `ts.transpileModule` 逐文件转译，不做类型检查。每个提交都要跑 `npm run typecheck`。
- 新模块必须是单个 `.ts` 文件，按文件路径相对导入。只为类型而导入时写 `import type`。
- 新模块对 `service.ts` 只能 `import type`。错误类留在原模块。
- `agentLoop` 保留为同签名的门面。脚本直接用到的服务成员（`store`、`sourceFingerprint`、`executionFingerprint`、`executionAgent`、`agentModel`、`runFeature`、`prepareRuntimeHandoff`、`reconcileRuntime`）名字和语义不变。
- 调用时再取 `store.save`，不提前捕获方法引用。其他服务方法同理。
- 提示词标记逐字不变：`宿主当前任务事实（每次请求重新装载）：\n`、`已读资料索引`、`已完成工作摘要`。上下文计划步骤 1 会按计划移动前两处的位置，那是该步骤自己的事。
- 被脚本直接加载的模块，导出名不变。
- 搬运代码的提交只移动和改名，不重排版；搬运和改行为分成不同的提交。

**不得改动的东西**（任何阶段，除非那一阶段的计划写明要改）。

- `executionFingerprint` 的输入、已保存的模型配置和智能体配置。改了会动已暂停任务的检查点指纹。
- 回执意图哈希的字段表（`receipt-ledger.ts` 第 35–38 行的 `receiptIntentHash`）、`validateReceiptRecord`、工具合同版本 `engineering-tools-v3`、检查点版本白名单（`checkpoint-version.ts`）。
- 三个人工确认节点、项目级作业互斥、开发与验证的职责分离、验证结果的三态。
- 已完成的功能记录、验证证据和最终验收结果。
- 用量未知就保持未知，不补零、不从别的记录反推。监控写失败不得影响推理。

**落盘点。** 拆分阶段和运行标识阶段都不增减 `store.save()` 和 `ledger.put()` 的调用，也不调换它们的位置。崩溃注入脚本按落盘点定位边界，落盘点一变，测的就不是原来的边界。存储搬迁阶段按设计会变，变化要随步骤重建基准并在提交说明里写明。

**遇到下面的情况停下来问用户，不自己决定。**

- 要改的地方落在第 10 节的「拟定」项上，而用户还没有确认。
- 基线上通过的脚本失败了，原因不是本次提交预期的变化。
- 等价脚本 `tool-pipeline-equivalence.cjs` 报出差异，而本阶段的计划没有预告这个变化。拆分阶段的规定是回退那个提交，不改基准。
- 需要新增或移动一次落盘才能完成工作包。
- 需要改指纹输入、意图哈希字段表、合同版本或提示词标记。
- 源码与本文或计划描述的不一样，照着做会改变行为。
- 需要运行读真实资料目录的脚本才能验证。

**提交与回报。** 一个工作包一个提交，提交说明写阶段和步骤号。每个工作包做完写一份回报，放 `.scratch/harness-refactor/codex-report-<工作包>.md`（例如 `codex-report-split-2.md`、`codex-report-A2.md`），内容沿用任务书的格式：

1. 提交号、机器、Node 版本、执行日期。
2. 改了哪些文件；跑过的命令和结果，失败的附输出的关键几行。
3. 等价脚本是否原样通过，`run-identity.cjs` 的落盘计数有没有变。变了的话写哪个场景、哪个键、为什么。
4. 与本文或计划不符的地方，包括行号对不上、语句已经变了、照做会改变行为的。
5. 没做完或没把握的地方，逐条写明，不写成已完成。

写完回报就停下，等用户交办下一步。

**文档同步。** `CLAUDE.md` 的「Harness 架构地图」描述现有实现，代码改到哪一步，对应段落才跟着改。计划里的「仍待处理」条目解决之后在原处更新。纯文档提交不跑应用测试，只检查数值、引用和链接。

## 4　执行顺序

| 序 | 阶段 | 工作包 | 依据文档 | 每步的检查 |
| --- | --- | --- | --- | --- |
| 0 | 第一批 | 任务 A（拆分步骤 1）、任务 B（存储步骤 0） | 第一批执行任务书 | 两份设计文档各自的「验收」 |
| 1 | 拆分 | 步骤 2 闭包状态收成 `ExecutionRun`；3 搬出工具端口；4 按阶段重排；5 内联规则登记成内部 hook；6 可选 | 拆分计划 | `npm run typecheck`、等价脚本、`npm run test:context-runtime`；阶段结束加 `test:verification`、`test:context-window` 和拆分计划步骤 0 第 3 条的补充脚本 |
| 2 | 运行标识 | A0–A8 | 本文第 6 节 | 见各工作包 |
| 3 | 上下文与压缩 | 步骤 1–7 | 上下文计划 | 上下文计划「验证」 |
| 4 | 存储搬迁 | 步骤 1–7 | 存储搬迁计划 | 存储搬迁计划「验证」 |
| 5 | 规则、审批、通用 shell、自由编码入口 | 没有计划 | — | — |
| 6 | 只读委派 | 没有计划 | 运行标识计划 C 部分 | — |

第 2、3 两个阶段的先后见第 10 节 A9（已确认：运行标识先）。A0 可以提到拆分步骤 2 之前做，这样它也能替拆分阶段多守一道续接和证据编号。

## 5　拆分阶段的补充

拆分计划已经写到步骤一级，照它做。这里补三点。

- **等价脚本以拆分步骤 1 设计为准。** 第一批执行任务书早先的一版也写了这个脚本的做法，与 [拆分步骤 1 设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md) 细节不同；任务书的作者已把那部分删掉，任务书现在只留通用约束和回报格式，做法指向设计文档。落盘的记法是 `saves.counted` 加 `receiptTrace`。下文说「落盘轨迹」时指这两个字段。
- **运行标识阶段不应让等价基准变化。** `executionRunId` 由 `uid()` 生成（`store.ts` 第 18 行，`randomUUID()`），设计第 5 节的归一化把 UUID 换成 `<UUID>`，并点名包括 `executionRunId`；它出现的三处（提示词「宿主当前任务事实」里的任务投影、命令证据、`historical-result` 事件的 JSON）都在归一化范围内。第 6 节新增的字段都不在基准采集的字段表里。所以 A1–A8 的每个提交，等价脚本都应当原样通过；报出差异就按第 3 节停下。
- **`ExecutionRun` 在拆分阶段只收纳现有的值。** 当前步、最近的请求记录 id 这两个字段是运行标识阶段才加的（A3），拆分阶段不要提前加。

## 6　运行标识：工作包 A0–A8

依据是 ADR 0007 第五、六项和运行标识计划 A 部分。这一节把计划里没有写到语句的地方补齐。每个工作包一个提交。下面写「运行对象」的地方，指拆分步骤 2 之后的 `ExecutionRun`；语句的位置以拆分后的代码为准，行号是拆分前的。

### 6.1　整个阶段的不变量

- 不新增 `store.save()` 和 `ledger.put()`。新字段只搭现有的落盘。
- 新字段一律可选。没有值的时候不写这个键，用条件展开 `...(x ? { executionRunId: x } : {})`，不写成 `executionRunId: undefined`。现有脚本用 `deepStrictEqual` 比对象，它区分缺键和 `undefined`。
- 不改指纹输入、意图哈希字段表、`validateReceiptRecord`、合同版本、检查点版本、提示词标记。
- 恢复、对账、续接、检查点失效的判断不读新字段。新字段只供查看和汇总。
- 不回填旧记录。旧命令证据里已有的 `executionRunId` 不改写。读到没有新字段的旧记录，按「未知」处理。
- `runtime.ts` 不改。
- `runId`（命令执行）和 `turnId`（讨论发言）的现有含义不动。运行标识的字段名是 `executionRunId`，步号是 `stepId`。
- 流量记录器、`trafficRef` 抛错都不得影响推理，调用点留在现有的 `try/catch` 里。

有几个现有脚本拿整个对象作比较：`context-runtime-migration.cjs` 第 47、74、88–89、149、203 行，`context-role-adaptive.cjs` 第 35–36、54–55 行。按代码读，它们比的都是同一次运行里的前后两份，两边同时多出字段不受影响，但没有逐个验证过。前一个脚本在 `test:context-runtime` 里；后一个不在任何 npm 命令里，是拆分计划步骤 0 第 3 条的四个补充脚本之一，要单独用 `node` 跑。A3–A5 每个提交都要跑到它们；这几处失败的话先看是不是一边带了字段、另一边没带。

### 6.2　A0　特征测试

不改 `src/`。新增 `scripts/run-identity.cjs`，源码类，用 `scripts/fixtures/verification-runtime.cjs` 的 `fixture`、`run`、`answer` 驱动；工具调用的标识自己写确定值，不用夹具的 `call()`（它用 `Math.random()`）。写法参照 `context-role-adaptive.cjs`、`execution-prototype-continuity.cjs`、`verification-preparation-stalls.cjs`。接进 `package.json` 的办法与等价脚本相同：只在 `test:context-runtime` 里插入一项，放在 `tool-pipeline-equivalence.cjs` 之后；`npm test` 那一行不改。

脚本先在未改动的代码上通过。标「现状」的断言记的是今天的行为，到指明的工作包里翻转；标「不变量」的断言在整个阶段都不能变。

| 场景 | 做什么 | 断言 |
| --- | --- | --- |
| R1 不中断的运行 | 三步：读文件、跑命令、报告完成 | 不变量：命令证据的 `id` 从 `check-1` 起连续；每条的 `stepId` 等于发起它的那一步；`evidenceProjection.executionRunId` 与证据里的值相同 |
| R2 暂停再续接 | 第一段跑一条命令后以 `incomplete` 暂停，第二段续接再跑一条 | 不变量：证据共两条，`check-1`、`check-2`，提示词里的任务投影不重复也不遗漏。现状：两段的 `executionRunId` 不同。A2 翻转成：两段相同，并等于检查点里的值 |
| R3 验证、修复、再验证 | 走一轮验证失败后的修复 | 不变量：`verificationHistory` 里同一条检查不重复（第 2224 行的去重）。现有脚本已有等价断言的话引用它，不重写 |
| R4 交接之后 | `prepareRuntimeHandoff` 之后续接 | 不变量：`manifest.id` 换新，`executionFingerprint` 不变。A2 起增加：检查点里的 `executionRunId` 不变 |
| R5 旧检查点 | 存一份检查点，删掉 `executionRunId` 键后续接 | A2 起：续接前后 `fingerprint` 不变；第一次保存检查点之后带上标识；`commands` 里旧证据的 `executionRunId` 原样 |
| R6 其他入口 | 方案规划、通用助手、需求讨论各跑一次 | 现状：请求记录和活动事件没有 `executionRunId`。A6 翻转，断言见 6.8 |
| R7 流量 | 给连接装一个假的记录器，记下 `start` 收到的参数 | 现状：只有两个参数。A7 翻转，断言见 6.9。不变量：记录器的 `start` 抛错，运行照常完成 |
| R8 落盘次数 | 包住 `store.save` 计数，排除活动时间预占和 `output` 事件（办法见拆分步骤 1 设计第 4 节） | 不变量：R1、R2 的计数在 A1–A8 每个提交前后相同 |

检查：`npm run typecheck`、`node scripts/run-identity.cjs`、`npm run test:context-runtime`。

### 6.3　A1　类型

只加类型，不改任何运行时语句。

- 新文件 `src/shared/run-ref.ts`，只有类型，其他文件用 `import type` 引用：

  ```ts
  export interface RunRef { executionRunId: string; parentExecutionRunId?: string; parentCallId?: string }
  export interface RunRecordRef { executionRunId?: string; stepId?: string }
  ```

  `parentExecutionRunId`、`parentCallId` 是给只读委派留的，这一阶段没有任何代码写它们。
- 下面的接口各加可选字段，直接写在接口里，不用继承：

  | 接口 | 位置 | 加的字段 |
  | --- | --- | --- |
  | `ExecutionCheckpoint` | `execution.ts` 第 58 行 | `executionRunId?` |
  | `AgentRunSnapshot` | `shared/engineering.ts` 第 123 行 | `executionRunId?` |
  | `ExecutionEvent` | `shared/engineering.ts` 第 322 行 | `executionRunId?`、`stepId?` |
  | 上下文请求记录、`ContextCompactionRecord`、`ContextOperation` | `shared/model-profile.ts` 第 111、31–39 行 | `executionRunId?`、`stepId?` |
  | `ToolReceipt` | `receipt-ledger.ts` 第 8 行 | `executionRunId?`、`stepId?`。加在 `ToolReceipt` 上，不加在 `ToolReceiptView` 上 |
  | `contextSnapshots` 的值 | `store.ts` 第 33 行 | 类型扩成 `RuntimeSnapshot & { executionRunId?: string }` |
  | `TrafficRequest` | `shared/model-traffic.ts` 第 26 行 | `projectId?`、`scopeId?`、`executionRunId?`、`stepId?`、`requestId?`、`operationId?` |

- `shared/model-traffic.ts` 加 `export interface TrafficRef { projectId?: string; scopeId?: string; executionRunId?: string; stepId?: string; requestId?: string; operationId?: string }`。

检查：`npm run typecheck`、`node scripts/run-identity.cjs`、等价脚本。

### 6.4　A2　标识进检查点，跨续接不变

现状：`service.ts` 第 1544 行 `const executionRunId = p.agentRuns?.at(-1)?.id ?? uid()`。第 1535 行刚推入一条智能体快照，所以这个值就是那条快照的 `id`；每次续接都会推一条新快照，标识跟着换。

改三处：

1. 第 1544 行改成 `const executionRunId = progress?.resume?.executionRunId ?? uid()`。
2. 第 1638 行的检查点字面量加一个键 `executionRunId`。
3. 第 1571 行已有 `if (p.agentRuns?.length) p.agentRuns[p.agentRuns.length - 1].executionPhase = role`。在同一个判断下再写 `executionRunId`，让智能体快照能查到它属于哪次运行。这里是内存赋值，随后面已有的落盘一起保存，不新增落盘。

不用改的地方：交接（第 592 行）用 `{ ...closed.checkpoint, … }` 展开原检查点，标识自然保留。

旧检查点没有这个键。续接时第 1 条会新生成一个，下一次保存检查点时写进去；旧证据里的值不动。已知的边缘情形：旧检查点交接后续接得到标识 X，用户撤销交接、恢复不带标识的原件再续接，会得到另一个标识 Y。按「缺失即未知」接受，不为它加逻辑。

这一处改动之后，下面几处的行为会变，逐条确认：

| 位置 | 用法 | 变化 |
| --- | --- | --- |
| 第 1745 行 | 证据来源串 `'evidence:' + (record.runId ?? executionRunId) + …`，只用于没有 `runId` 的证据 | 续接后的来源串与续接前相同，不再每段多出一个。按 `context.ts` 第 128、204、230–245 行和 `context-session.ts` 第 19 行读，来源串只被校验成字符串、合并去重和计数，没有按它的内容作判断；来源清单因此增长得慢一些，超过 128 条才建索引的那个阈值会更晚达到。动手前再搜一遍 `.sources` 的读取方确认 |
| 第 1749、2224 行 | 按 `(executionRunId, id, at)` 去重 | 判断结果不变：同一次运行里 `id` 连续编号，`at` 各不相同 |
| 第 1751–1752 行 `taskProjection(…, executionRunId)` | 进提示词「宿主当前任务事实」和 `f.evidenceProjection` | 续接后提示词里的值与续接前相同。只有这个 UUID 的取值变，结构不变 |
| 第 1788、1963 行 | `historical-result` 事件的 JSON | 同上 |
| 第 1882、1928 行 | 新产生的命令证据 | 续接后的新证据与续接前的旧证据同一个标识 |
| 第 2256 行 | 取 `f.evidenceProjection?.executionRunId` | 跟随上面 |

把 R2 的现状断言翻转，启用 R4、R5 的新增断言。

检查：`npm run typecheck`、`node scripts/run-identity.cjs`、等价脚本、`npm run test:context-runtime`、`npm run test:verification`、`npm run test:context-window`，以及拆分计划步骤 0 第 3 条的四个补充脚本（`context-role-adaptive.cjs`、`context-role-adaptive-smoke.cjs`、`execution-prototype-continuity.cjs`、`execution-prototype-smoke.cjs`）。

### 6.5　A3　当前步，以及请求、压缩、操作记录

请求记录、压缩记录、操作记录产生的地方拿不到步号：`RuntimePorts.records` 的这几个回调没有步号参数，而 `runtime.ts` 不改。做法是让运行对象自己记当前步。

- 运行对象加 `step: number`，初值 `progress?.resume?.steps ?? 0`。
- `saveCheckpoint` 入口第一句 `run.step = snapshot.steps`。`prepareGroup` 走的是另一个回调，也在入口同样赋值。
- 运行对象加 `requestId?: string`。第 1809 行新建请求记录之后 `run.requestId = record.id`。

这样取到的步号与 `runtime.ts` 的步对得上，依据是它的顺序：第 302 行 `steps = step`，随后 `request()` 在发请求之前先 `save()`（第 121 行）；一组工具执行完 `steps = group.step + 1; save()`（第 192、266 行）。有三种情形要知道：

| 情形 | 记到的步号 |
| --- | --- |
| 普通的一步 | 这一步的 `step` |
| 格式修复回合 | `step + 1`（第 314 行先加 1 再进 `repairReport`） |
| 步数用尽后的总结回合 | `stepLimit`（第 330 行） |

所以 `stepId` 的含义是「记录产生时检查点所处的步」，文档和界面都按这个说法，不说成「第几轮对话」。

加字段的四处，都写成 `executionRunId, stepId: String(run.step)`：

- 第 1809 行请求记录的字面量。
- 第 1798 行压缩记录 `{ ...record, manifestId: manifest.id, role, model: connection.model }`。
- 第 1718、1723 行两处 `onOperation`，存进 `contextState.operations` 之前在操作记录上加。

R1 增加断言：三步运行里每条请求记录的 `stepId` 依次是 `'0'`、`'1'`、`'2'`，`executionRunId` 都相同。另配一个步数用尽的小场景，断言总结回合的请求记录 `stepId` 等于 `String(stepLimit)`。

检查：同 A2。

### 6.6　A4　活动事件

- `store.ts` 第 250 行的 `event(project, kind, message, featureId?)` 加第五个可选参数 `ref?: RunRecordRef`。事件对象上按 6.1 的条件展开写两个键，没有值就不写键。
- 只有工程执行的 records 端口（`service.ts` 第 1795 行）传：`this.store.event(p, kind, message, f.id, { executionRunId, stepId: String(run.step) })`。
- 其余调用 `store.event` 的地方一律不动。它们大多不在一次运行之内（阶段流转、人工确认、验证汇总），硬套一个标识反而不准。第 1788、1963 行的 `historical-result` 事件已经在消息的 JSON 里带了标识，不重复加。

说明一点：`'model'` 事件在第 301 行发出，早于第 302 行的 `steps = step`，但上一步结束时已经保存过 `steps = step`，所以它的 `stepId` 仍是这一步。R1 加断言核对这一点。

检查：同 A2。界面读事件的地方不改，新字段界面暂时不用。

### 6.7　A5　回执

- 第 1930 行的 `intent` 字面量加 `executionRunId, stepId: String(step)`。`step` 是 `tools.execute` 的参数。
- 第 1954 行的未启动回执（`strategy: 'not-started-v1'`）加 `executionRunId, stepId: String(run.step)`。`skip` 回调没有步号参数，这时 `run.step` 等于这一组的步。
- `runtime-handoff.ts` 第 55 行起，交接时补写的取消回执不加（第 10 节 A10，已确认）。那里不在一次运行之内。

已核对这两个字段不会碰到校验：意图哈希按固定的键表取值（`receipt-ledger.ts` 第 36 行），`ledger.execute` 遇到已有回执时只比 13 个身份键和 `args`（第 79–80 行），`validateReceiptRecord` 不检查多余的键。续接时遇到已有回执，沿用的是存下来的那条，新字段不会补到旧回执上，这符合「不回填」。

`ToolReceiptView` 不加字段；回执投影给界面的内容不变。

R1 增加断言：回执路径下每条回执的 `executionRunId`、`stepId` 与同一步的请求记录一致。再断言 `receiptIntentHash` 对加字段前后的同一条回执算出相同的值。

检查：同 A2。

### 6.8　A6　方案规划、通用助手、需求讨论

这三个入口都经 `context-session.ts` 的 `contextSession(...)`，改它一处，再改三个调用方。

`contextSession` 内部：

- `let executionRunId = uid()`，`let step: number | undefined`。
- 返回值加 `resumeRun(snapshot?: { executionRunId?: string })`：快照里有标识就沿用，没有就保持新生成的。调用方在 `run` 之前调用。
- `records.save`（第 52–65 行）写快照时带上标识：`{ ...candidate, executionRunId }`。同时 `if (step !== undefined) step = candidate.steps`。
- `run(input, …)`（第 90 行）开头 `step = input.startStep`。需求讨论不调 `run`，`step` 一直是 `undefined`，它的记录因此没有 `stepId`。
- 请求记录（第 74 行）、压缩记录（第 70 行）、操作记录（第 86、99 行的 `onOperation`）按 6.1 的条件展开加两个键。
- 事件回调的类型改成 `(kind, message, ref?: RunRecordRef) => void`，`records.event`（第 67–69 行）调用时传第三个参数。
- 返回值加 `trafficRef`（见 6.9），供 `requirements.ts` 直接调模型时用。

调用方：

| 入口 | 改动 | 一次运行的界定 |
| --- | --- | --- |
| 方案规划 `planning.ts` | 第 20–21 行的事件回调把 `ref` 转给 `store.event` 的第五个参数；第 30 行算出 `restored` 之后 `if (restored) session.resumeRun(restored)` | 从空历史开始，到产出方案或被放弃；中途暂停后续接算同一次 |
| 通用助手 `general-assistant.ts` | 不调 `resumeRun`。第 153 行的事件回调是空函数，不动 | 每条用户消息一次运行（`stepLimit: 1`、`startStep: 0`） |
| 需求讨论 `requirements.ts` | 第 237–238 行的事件回调转 `ref`；第 246 行算出 `sameTurn` 之后 `if (sameTurn && restored) session.resumeRun(restored)` | 一次发言一次运行，同一次发言中断后续接算同一次（第 10 节 A4，已确认） |

需求讨论和通用助手的历史是跨发言累积的，「一次运行从空历史开始」这句话对它们不成立。ADR 0007 第五项和 DOMAIN「运行」词条在接受时已改成「从接到一次交办开始」，并写明这两个入口一次发言、一条用户消息各是一次运行。这是文字上的事，不影响上面的做法。

其他入口的智能体快照不补 `executionRunId`（第 10 节 A7，已确认）。

把 R6 的现状断言翻转：三个入口的请求记录都带 `executionRunId`；方案规划暂停后续接，两段相同；通用助手连发两条消息，两次不同；需求讨论同一次发言续接相同、下一次发言不同；需求讨论的请求记录没有 `stepId` 键。

检查：A2 的各项，加 `npm run test:research`。

### 6.9　A7　流量记录与请求记录互指

目标是从一条流量记录能找到它属于哪个项目、哪次运行、哪一步、哪条请求记录或哪次辅助操作。只做流量指向请求这一个方向。

- `model.ts` 第 89 行的 `Connection` 加 `trafficRef?: () => TrafficRef | undefined`。
- `TrafficRecorder.start`（`model-traffic.ts` 第 10–15 行的接口、第 64 行的实现）加第三个可选参数 `ref?: TrafficRef`。实现里只把值是字符串的键写到 `TrafficRequest` 上。
- `model.ts` 第 257 行：`c.traffic!.start(c, c.trafficPurpose ?? 'inference', c.trafficRef?.())`。
- `model.ts` 第 434 行（`auxiliaryModelRequest`）：`c.traffic?.start(c, kind, { ...c.trafficRef?.(), requestId: undefined, operationId: operation.id })`。计数和压缩发生在下一条请求记录建立之前，这时运行对象里的 `requestId` 还是上一条的，所以清掉，改带操作记录的 id。
- 两处都在现有的 `try/catch` 之内，`trafficRef` 抛错不影响推理。
- `service.ts` 第 1533 行的连接字面量加 `trafficRef: () => ({ projectId: p.id, scopeId: f.id, executionRunId, stepId: String(run.step), requestId: run.requestId })`。第 1716–1738 行各处都是 `{ ...connection, … }` 展开，自然带上。
- `contextSession` 里同样加，取会话自己的值。那里把连接交给模型层的地方不止一处：第 84–87 行的 `measuredConnection`，以及第 97 行起 `verify` 里对 `connection` 的展开。每一处都要带上，最省事的是在会话内部那份 `connection` 上加一次。

已核对：源码里没有对连接对象做 `structuredClone`、`digest` 或 `JSON.stringify`，连接上多一个函数不会进指纹，也不会进检查点。动手时再搜一遍确认。

一条请求记录可能对应多条流量记录：`requestWithContext` 每次重试各建一条请求记录（`context-request.ts` 第 178–182 行），而 `complete` 内部的传输重试共用一条。这是预期的，不去重。不经 runtime 的模型调用（连接测试、智能体配置、助手团队）不带这些字段。

流量文件里新增了项目和范围的 id。`docs/MODEL_TRAFFIC.md` 的「保存与隐私」一节要写明新增了哪些字段、不含内容。本阶段不改流量界面（第 10 节 A8，已确认）。

把 R7 的现状断言翻转：推理请求的流量记录带 `executionRunId`、`stepId`、`requestId`，且 `requestId` 能在 `contextRuntime.requests` 里找到；计数和压缩的流量记录带 `operationId`、不带 `requestId`。

检查：A2 的各项，加 `npm run test:traffic`。

### 6.10　A8　收尾

- `CLAUDE.md`「可观测性」一段改成现状：哪些记录带运行标识和步号，哪些不带。
- 运行标识计划 A 部分标成已完成，「仍待处理」里解决了的条目更新。
- ADR 0007 被接受时已经补了 `docs/architecture/DOMAIN.md` 的「运行」词条；这里核对词条与实现一致。
- 全量检查：`npm run typecheck`、`node scripts/run-identity.cjs`、等价脚本、`npm run test:context-runtime`、`npm run test:verification`、`npm run test:context-window`、四个补充脚本、`npm run test:research`、`npm run test:traffic`、`npm run test:engineering`。

## 7　与上下文计划的衔接

运行标识先做，上下文计划后做（第 10 节 A9，已确认）。理由有两条：运行标识改动小，全是加可选字段，不动提示词和压缩；上下文计划步骤 1 要统计缓存命中、步骤 6 要重测推广门槛，有了 A7，这些数字可以直接按运行和步从流量记录里汇总，不用靠时间戳去对。

反过来做也行得通，两个阶段没有硬依赖。那样的话上下文计划里按时间对流量的做法要保留，A3 加字段的位置以改过的代码为准。

两个阶段交叠的地方只有一处：上下文计划步骤 1 会移动提示词里「宿主当前任务事实」的位置，任务投影里的 `executionRunId` 跟着走，值不变。

## 8　存储搬迁：对待定项的建议

存储搬迁计划的「仍待处理」有九条。下面是对其中几条的建议，供用户定夺时参考。**这些只是建议，没有写进存储搬迁计划；该计划由它自己的维护者更新，有出入以它为准。** 用户定下之前，存储步骤 1–7 不开工。

| 待定项 | 建议 | 备选 |
| --- | --- | --- |
| 封存后的日志怎么查 | 主进程提供只读的分页读取函数，经只读 IPC 给界面 | 界面只看主文件里的摘要，封存日志只能导出 |
| 「单写入者」与委派的关系 | 按「每份日志一个写入器对象」理解；子运行的行写进父运行所在的日志，带 `parentExecutionRunId` | 子运行各自一份日志 |
| 项目级和会话级记录放哪里 | 带功能的规划进功能日志；不带功能的规划和需求讨论进项目日志；助手会话按 `['assistant', sessionId]` 自成范围；快照按键各存一个小文件 | 全部留在主文件 |
| 交接的提交点 | 前滚式：先写原件文件，再追加一条逐条 fsync 的「交接已准备」行，然后写关闭后的回执、替换检查点、保存主文件，最后追加「交接已应用」行。启动时见到前者没有后者就重做 | 回滚式。不可行：回执一旦追加就撤不回 |
| `legacyReviewPause` | 搬迁时固化成主文件里的业务字段 | 把相关事件提到第一级保留 |
| 第二级追加失败 | 继续运行，把这段记成未知 | 照旧停下 |
| 降级后再升级 | 以 v2 为准；v2 里记下 v1 文件的大小和 sha256，变过就提示用户，不自动合并 | 自动合并 |
| `result.output` 要不要外置 | 超过阈值才外置。阈值等存储步骤 0 的实测数字，并经用户确认 | 一律外置，或一律内联 |
| 恢复对账时的判重 | `execution-recovery.ts` 第 81 行按回执的 `logicalId` 判重 | — |

活动时间续约、启动重放耗时、界面 250 ms 轮询三条要等存储步骤 0 的数字，这里不给建议。

## 9　只读委派：现在不能开工

ADR 0007 第七、八项只定了形态：子运行只读，只在自由编码入口开放。运行标识计划 C 部分（C1–C3）写的也只是形态。它还缺下面这些前置，缺一样都不能写实施计划：

- 自由编码入口本身的计划（ADR 0005 第五项），包括它的会话范围、与项目级作业互斥的关系。
- 声明式规则、逐调用审批和通用 shell 的计划（ADR 0005 第六项）。子运行的权限要从父运行的规则里收窄，规则还不存在。
- 通用 shell 是否对子运行开放。按「只读」的字面是不开放，但要用户确认。
- 「读项目内文件」对子运行是否默认允许，还是也要逐次审批。
- 存储搬迁完成。子运行的记录要写进日志，现在的单文件存不下这种嵌套。

A1 里留的 `parentExecutionRunId`、`parentCallId` 两个类型字段是这一阶段唯一与委派有关的东西，它们没有写入方。

## 10　拟定项及其确认状态

A 组已于 2026-11-11 由用户确认，按「本文采用」一列执行。S 组和 C 组没有经用户确认。左边是本文采用的做法，右边是备选。用户改了哪一项，对应的工作包跟着改。

**A 组：运行标识（已确认，2026-11-11）。**

| 编号 | 事项 | 本文采用 | 备选 |
| --- | --- | --- | --- |
| A1 | 新运行的标识从哪里来 | 新生成 `uid()`，并把它写到当次的智能体快照上（6.4） | 不续接时沿用当次智能体快照的 `id`，与今天的取值相同。好处是首段的值不变；缺点是与 ADR 0007「运行有自己的标识」的字面不符，快照 id 身兼两职 |
| A2 | 旧检查点没有标识时怎么办 | 续接时新生成，下次保存检查点写入 | 取 `resume.commands` 最后一条证据的 `executionRunId`；或取最后一条智能体快照的 `id`。都能让旧任务的前后两段对上，代价是多一段只为旧数据存在的逻辑 |
| A3 | 步号从哪里来 | 运行对象在保存检查点时记下 `snapshot.steps`（6.5） | 给 `RuntimePorts.records` 的回调加可选的步号参数。更直接，但要改 `runtime.ts` |
| A4 | 需求讨论里什么算一次运行 | 一次发言 | 一份快照的寿命，也就是同一位参与者在资料没变之前的全部发言。这样一次运行会很长，按运行汇总用量时意义不大 |
| A5 | 字段名 | `executionRunId`、`stepId`、`parentExecutionRunId`、`parentCallId` | — （`runId`、`turnId` 已有别的含义，不能用） |
| A6 | 流量记录带不带项目和范围的 id | 带 | 只带 `executionRunId`。流量文件里不出现项目 id，但要查项目得先去主文件里反查 |
| A7 | 哪些入口的智能体快照补 `executionRunId` | 只有工程执行 | 四个入口都补 |
| A8 | 这一阶段改不改界面 | 不改。字段先落盘，界面等存储搬迁之后一起做 | 流量面板加按运行筛选 |
| A9 | 运行标识与上下文计划的先后 | 运行标识先 | 上下文计划先（第 7 节） |
| A10 | 交接时补写的取消回执加不加标识 | 不加 | 加上原检查点的标识 |

ADR 0007 里「一次运行从空历史开始」的措辞对需求讨论和通用助手不成立（6.8），这处已在接受 ADR 时改掉。

**S 组：存储搬迁（未确认）。** 第 8 节的表，每行都是。

**C 组：只读委派（未确认）。** 第 9 节列的前置，每条都是；运行标识计划「拟定项及其确认状态」一表的第 4、5 行（委派的形态、子运行的全部默认值）也都没有确认。

## 11　交办模板

每次只交办一个工作包。可以直接把下面这段给 Codex，方括号里换成实际内容。

```text
按 docs/HARNESS_REFACTOR_CODEX_HANDOFF.md 执行 [工作包，例如「拆分步骤 2」或「运行标识 A2」]。

先读 AGENTS.md、CLAUDE.md、执行说明第 2、3 节，以及 [依据文档和章节]。
已确认的拟定项：[第 10 节的编号；没有就写「无」]。
只做这一个工作包，一个提交。做完按执行说明第 3 节写回报，放
.scratch/harness-refactor/codex-report-[工作包].md，然后停下。
遇到第 3 节「停下来问用户」里的任何一种情况，停下回报，不自行决定。
```

第一批的两个任务直接交办任务书，不用这个模板。第一批用的完整提示词（含四份方案的总览）和后续各批已经填好的短提示词在 [交给 Codex 的提示词](HARNESS_REFACTOR_CODEX_PROMPT.md)。
