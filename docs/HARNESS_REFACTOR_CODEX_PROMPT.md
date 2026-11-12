# Harness 重构 · 交给 Codex 的提示词

2026-11-11 · 第一批待交办。本文把四份 harness 修改方案汇总成可以直接贴给 Codex 的提示词：第 2 节是第一批用的完整提示词，含四份方案的总览、每一批都适用的规则和这一次的范围；第 3 节是后续各批的短提示词；第 4 节列出现在还不能交办的部分和各自缺什么。

本文不新增决定。决定在 [ADR 0005](adr/0005-tool-pipeline-and-free-coding-entry.md)、[ADR 0006](adr/0006-stable-prompt-prefix-and-working-window.md)、[ADR 0007](adr/0007-append-only-run-log-run-id-and-readonly-delegation.md) 里，做法在四份计划和两份设计文档里，开工条件和规则在 [第一批执行任务书](HARNESS_REFACTOR_CODEX_BRIEF.md) 和 [交给 Codex 的执行说明](HARNESS_REFACTOR_CODEX_HANDOFF.md) 里。提示词与这些文档有出入时以它们为准。

## 1　交办之前

1. **先把文档提交。** 写本文时，下面这些都还没有进仓库：`CLAUDE.md`、`docs/HARNESS_REFACTOR_SPLIT_PLAN.md`、`docs/adr/0005-…md`、`docs/architecture/DOMAIN.md` 有未提交的修改；其余 `docs/HARNESS_REFACTOR_*.md`（含本文）、`docs/adr/0006-…md`、`docs/adr/0007-…md` 是未跟踪文件。任务 B 要往存储搬迁计划里加一段，文档不先提交的话，Codex 的提交会把整份文档带进去。提示词里已经要求 Codex 见到这些文档未提交就停下。

   ```text
   git add CLAUDE.md docs/HARNESS_REFACTOR_*.md docs/adr/0005-tool-pipeline-and-free-coding-entry.md docs/adr/0006-stable-prompt-prefix-and-working-window.md docs/adr/0007-append-only-run-log-run-id-and-readonly-delegation.md docs/architecture/DOMAIN.md
   git commit -m "docs: harness refactor plans, ADR 0006/0007 and Codex prompts"
   ```

   `docs/research/` 和 `docs/verification/` 下未跟踪的文档与这次交办无关，是否一起提交由你定。
2. **Codex 要在这份本机检出里执行**，不能用云端环境或另一份克隆。Windows 基线（`.runtime/harness-refactor/baseline/windows/`）、设计文档引用的核对记录（`.scratch/harness-refactor/`）和 Codex 自己的回报都在被 `.gitignore` 忽略的目录里，只存在于这台机器上。
3. **一次只交办一段。** 每段提示词都以「写回报、停下」结束。看过回报再交办下一段；回报里列出的出入要先处理。每一批做完之后，执行说明第 2 节那张状态表要跟着更新，后续的短提示词让 Codex 以那张表为准。

## 2　第一批的提示词

整段贴给 Codex。

```text
你在 Windows 本机的 Coprojer 仓库里工作（仓库根目录，分支 main）。这是一次 harness 重构，方案已经由用户确认并写成文档，你负责执行。这段提示词分六部分：一到四是全貌和每一批都适用的规则，五是这一次的任务，六是回报。这一次只做「第一批」的两个任务，做完写回报就停下。

一、背景和分工

Coprojer 是 Windows x64 桌面的「AI 工程工作台」（Electron + React + TypeScript），它自己调用模型并组织工具执行。harness 指 src/main/engineering/ 下的这套东西：runtime.ts 的模型—工具循环 runRuntime；service.ts 里的 EngineeringService.agentLoop，它是工程执行的入口，工具执行、权限复核、回执和命令证据都内联在它的闭包里；context-request.ts 的上下文计量与压缩；store.ts 的单文件存储。现状的完整描述在 CLAUDE.md 的「Harness 架构地图」。

分工：方案由 Claude 设计到可执行，决定由用户做，你执行。文档里写着「拟定」「待定」「仍待处理」的内容没有经用户确认，不能当成已定。发现方案有问题时写进回报，不自己改方案，也不自己挑一种做法执行。

二、四份方案

重构有四条线，各有决策记录（ADR）和计划，文档都在 docs/ 下。

1. 工具执行管线拆分。ADR 0005（已接受），计划 HARNESS_REFACTOR_SPLIT_PLAN.md。
   决定：工程工具的每次调用走同一条固定阶段的管线，阶段之间留具名 hook，现有的内联规则登记成内部 hook；先做不改变行为的拆分，再加能力。
   步骤：0 基线（已完成，结果在 .runtime/harness-refactor/baseline/windows/）；1 等价脚本，把现状记成基准；2 把 agentLoop 的闭包状态收成 ExecutionRun；3 工具端口搬到 execution-tools.ts；4 在 tool-pipeline.ts 里按阶段重排；5 内联规则登记成 execution-hooks.ts 里的内部 hook；6 可选，方案规划接入同一管线。
   ADR 0005 里的规则与审批、通用 shell、自由编码入口还没有计划。

2. 上下文与压缩。ADR 0006（已接受），计划 HARNESS_REFACTOR_CONTEXT_PLAN.md。
   决定：提示词分成稳定前缀和尾部注入，让供应商的前缀缓存能命中；整理的触发线（工作窗口）设 128K token 的上限；容量声明齐全的连接默认用 adaptive 策略，这个默认值的切换排在最后，并且要先过推广门槛。
   步骤：1 稳定前缀、尾部注入与缓存统计；2 锚点计量；3 工作窗口；4 工具结果清理；5 model-summary 压缩器；6 按折算成本重测；7 切换默认值。全部是行为改动。

3. 追加式存储。ADR 0007（已接受）第一至四、九至十一项，计划 HARNESS_REFACTOR_STORAGE_PLAN.md。
   决定：回执、请求与用量、压缩记录、活动事件、额度预占从单个 engineering-v1.json 搬到每个功能一份的追加式日志；可靠性分两级；搬迁写新文件、不改旧文件；最终验收之后封存；回执正文在落盘层去重。
   步骤：0 测量现有实现的落盘次数、字节数和耗时；1 到 7 是搬迁本身。计划里的落盘布局和实施顺序仍标着「拟定」，「仍待处理」的条目用户还没有定。

4. 运行标识与只读委派。ADR 0007 第五至八项，计划 HARNESS_REFACTOR_RUN_ID_STORAGE_DELEGATION_PLAN.md，逐提交的做法在 HARNESS_REFACTOR_CODEX_HANDOFF.md 第 6 节。
   决定：一次运行只有一个标识 executionRunId，跨暂停续接和交接不变，各类记录以可选字段带上它；子智能体委派第一版只读，只在自由编码入口开放。
   步骤：运行标识分 A0 到 A8 九个工作包，A0 只加特征测试。委派只定了形态，没有实施计划。

三、整体顺序和开工条件

顺序：第一批（拆分步骤 1、存储步骤 0）→ 拆分步骤 2 到 5（6 可选）→ 运行标识 A0 到 A8 → 上下文与压缩步骤 1 到 7 → 存储搬迁步骤 1 到 7 → 规则、审批、通用 shell、自由编码入口 → 只读委派。A0 可以提到拆分步骤 2 之前。

每一步都要用户点名才能开工，上一步做完不等于下一步可以开始。当前状态以 HANDOFF 第 2 节的表为准。第一批交办时的状态是：
- 第一批：可以开工，就是这一次的任务。
- 拆分步骤 2 到 5：要等第一批任务 A 的基准已提交、回报经用户看过。
- 运行标识 A1 到 A8：ADR 0007 已接受，取值已确认（HANDOFF 第 10 节 A 组），要等拆分步骤 2 到 5 完成。
- 上下文与压缩：要等拆分步骤 2 到 5 完成，排在运行标识之后。
- 存储搬迁步骤 1 到 7：不能开工。还差运行标识完成、步骤 0 的数字写回计划、存储计划「仍待处理」里挡路的条目由用户定下。
- 拆分步骤 1 设计第 8 节的两个缺陷候选：用户决定拆分阶段不修，现状照实进基准，修复在拆分完成后另行交办。不要顺手修。
- 规则、审批、通用 shell、自由编码入口、只读委派：没有实施计划，不能开工。

四、每一批都适用的规则

原文在 HARNESS_REFACTOR_CODEX_BRIEF.md 的「通用约束」和 HANDOFF 第 3 节，以原文为准。下面是最容易出错的几条。

环境
- 验证只用隔离资料目录：COPROJER_USER_DATA，或夹具 fixture() 在系统临时目录下建的目录。不读写 %APPDATA%\Coprojer-dev，不碰用户的真实工作区、凭据和模型密钥。
- 不运行这 11 个读真实资料的脚本：context-runtime-real-*、context-window-real、context-window-project-replay、execution-project-resume-probe、execution-prototype-real、project-adaptive-context*、project-role-adaptive-context、pomodoro-live-verification。拿不准时先在脚本里搜 process.env.APPDATA。
- 仓库根上不做无范围的搜索（test/ 下有大量 Electron profile 文件），指定 src、scripts、docs。service.ts 的行很长，查看时截断。
- 有可见窗口的测试按 AGENTS.md 放到 1 号非主屏显示器，不可用时回退主屏。

测试
- 没有测试框架，测试是 scripts/ 下的 Node 脚本。源码类脚本用 ts.transpileModule 逐文件转译 src/，不做类型检查，所以每个提交都要跑 npm run typecheck。
- 新模块必须是单个 .ts 文件；对 service.ts 只能 import type；错误类留在原模块。
- agentLoop 保留为同签名的门面；调用时再取 store.save，不提前捕获方法引用；提示词标记逐字不变。
- context-runtime-migration-smoke 在基线里失败过一次，重跑没有复现。它在 860×600 布局检查处超时的话先单独重跑，重跑仍失败才算回归。

不得改动（除非当批的计划写明要改）
- executionFingerprint 的输入、已保存的模型配置和智能体配置。
- 回执意图哈希的字段表、validateReceiptRecord、工具合同版本 engineering-tools-v3、检查点版本白名单。
- 拆分阶段和运行标识阶段不增减 store.save() 和 ledger.put() 的调用，也不调换它们的位置。
- 三个人工确认节点、项目级作业互斥、开发与验证的职责分离、验证结果的三态；已完成的功能记录、验证证据和最终验收结果。
- 用量未知就保持未知，不补零；监控写失败不影响推理。

git
- 开工前看 git status，限定 src、scripts、docs、CLAUDE.md、package.json。docs/HARNESS_REFACTOR_*.md、docs/adr/ 下的 0005 到 0007、docs/architecture/DOMAIN.md、CLAUDE.md 里有未提交或未跟踪的，停下告诉用户先提交，不要替用户提交。
- 一个工作包一个提交，提交在当前分支上。只暂存这个工作包自己的文件，逐个 git add <路径>；不用 git add -A、git add .、git commit -a。不 push，不改写已有提交，不 reset --hard，不 clean。
- 只有换行符差异的文件（git diff --ignore-cr-at-eol 看不到差异）不是你的改动，不暂存、不规范化，记进回报。
- .scratch/ 和 .runtime/ 被 .gitignore 忽略，回报和运行产物留在本地，不要强制加入仓库。

停下来问用户的情况（HANDOFF 第 3 节有完整清单）
- 要动的地方落在「拟定」项上，而用户没有确认。
- 基线上通过的脚本失败了，原因不是本次提交预期的变化。
- 源码与文档描述的不一样，照着做会改变行为。
- 文档之间有出入。优先级是：ADR 高于计划，计划高于执行说明；第一批以任务书和两份设计文档为准；存储上两份计划有出入时以 HARNESS_REFACTOR_STORAGE_PLAN.md 为准。有出入先报告，不自己挑。

五、这一次的任务：第一批

先读，按这个顺序：
1. AGENTS.md、CLAUDE.md。
2. docs/HARNESS_REFACTOR_CODEX_BRIEF.md。它是第一批的任务书：通用约束、不由你决定的事、回报格式。
3. 任务 A：docs/HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md 全文；docs/HARNESS_REFACTOR_SPLIT_PLAN.md 的「硬约束」和步骤 0、1。
4. 任务 B：docs/HARNESS_REFACTOR_STORAGE_STEP0_DESIGN.md 全文；docs/HARNESS_REFACTOR_STORAGE_PLAN.md 的「现状」一节。
做法以两份设计文档为准，这里不重复。

动手前确认 src、scripts、package.json 相对提交 39d7299 没有变化：git diff --ignore-cr-at-eol --stat 39d7299 HEAD -- src scripts package.json 应为空。设计文档里的行号和「已观察」的结果都对应这个提交。不为空就停下回报。

任务 A：等价脚本（拆分步骤 1）
- 交付：新增 scripts/tool-pipeline-equivalence.cjs 和 scripts/fixtures/tool-pipeline-equivalence.baseline.json；package.json 的 test:context-runtime 里，在 node scripts/context-runtime-read-groups.cjs 之后、node scripts/context-runtime-smoke.cjs 之前插入 node scripts/tool-pipeline-equivalence.cjs。一个提交。
- 场景是设计第 6 节的 6.1 到 6.12。基准记的是今天的行为，包括第 8 节的四处反常，不修，也不绕开那些场景。
- 「已观察」一栏来自 Linux 沙箱，Windows 上没有验证过。6.6（命令取消）只在 win32 上跑，6.12 的保存次数没有测过，都以本机为准。本机结果与「已观察」的出入逐项列进回报；与平台无关的场景对不上时，按设计第 7 节末尾的规定停下。
- 按设计第 7 节六项自查。第 4 项的变异检查共 14 行：每次临时改 service.ts 一处，确认脚本报错，然后撤销这一处；哪一处改了脚本仍然通过，先补场景。这些改动不得进入提交，最后 git diff --ignore-cr-at-eol --stat HEAD -- src 为空。

任务 B：落盘测量（存储步骤 0）
- 交付：新增 scripts/storage-save-baseline.cjs，它是测量工具，不接进 package.json；在 HARNESS_REFACTOR_STORAGE_PLAN.md「现状」一节「推算的次数」那一段之后加一段「实测」。一个提交。运行产物写到 .runtime/harness-refactor/storage-baseline/，不进仓库。
- 按设计第 6 节出七项汇总，按第 7 节六项自查。
- 只报数字和清单。分级值不值、续约间隔放不放宽、哪些调用点要补显式保存，都由用户决定。

两个任务互不依赖，先后不限，各自一个提交。两个任务都不改 src/，不改现有脚本和夹具，不加依赖。

这一次不做：拆分步骤 2 及之后的任何一步、运行标识（包括 A0）、上下文与压缩、存储搬迁步骤 1 到 7、缺陷候选的修复。

六、回报

每个任务一份，放 .scratch/harness-refactor/codex-report-A.md 和 codex-report-B.md，格式照任务书「回报格式」六项。没做完或没把握的地方逐条写明，不写成已完成。两份回报写完就停下，等用户交办下一步。
```

## 3　后续各批的短提示词

每段只交办一个工作包，格式沿用执行说明第 11 节的模板，多了一句让 Codex 先读第 2 节里的全貌和规则。方括号里按下面各表换成实际内容。交办前对照执行说明第 2 节确认开工条件已经满足。

### 3.1　运行标识 A0（特征测试）

不改 `src/`。执行说明把它列为用户点名即可，但它在 `package.json` 里接在等价脚本之后（执行说明 6.2），所以实际要等任务 A 提交。建议放在拆分步骤 2 之前。

```text
按 docs/HARNESS_REFACTOR_CODEX_HANDOFF.md 执行「运行标识 A0」。

先读 docs/HARNESS_REFACTOR_CODEX_PROMPT.md 第 2 节代码块的一到四部分（全貌和规则，每一批都适用；其中各阶段的状态是第一批交办时的，现在的状态以执行说明第 2 节为准）。再读 AGENTS.md、CLAUDE.md、执行说明第 2、3 节和 6.1、6.2。
已确认的拟定项：执行说明第 10 节 A1 到 A10。A0 只加特征测试，不改 src/。
只做这一个工作包，一个提交。做完按执行说明第 3 节写回报，放 .scratch/harness-refactor/codex-report-A0.md，然后停下。
遇到执行说明第 3 节「停下来问用户」里的任何一种情况，停下回报，不自行决定。
```

### 3.2　拆分步骤 2 到 5

开工条件：任务 A 的基准已提交，回报你已看过。四步依次交办，每步一个提交。

```text
按 docs/HARNESS_REFACTOR_CODEX_HANDOFF.md 执行「拆分步骤 [N]」。

先读 docs/HARNESS_REFACTOR_CODEX_PROMPT.md 第 2 节代码块的一到四部分（全貌和规则，每一批都适用；其中各阶段的状态是第一批交办时的，现在的状态以执行说明第 2 节为准）。再读 AGENTS.md、CLAUDE.md、执行说明第 2、3、5 节，以及 docs/HARNESS_REFACTOR_SPLIT_PLAN.md 的「硬约束」和「步骤 [N]」。
已确认的拟定项：无。
这一步不改变行为。等价脚本 tool-pipeline-equivalence.cjs 报出差异时回退这个提交，不改基准。docs/HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md 第 8 节的缺陷候选不修。
只做这一个工作包，一个提交。做完按执行说明第 3 节写回报，放 .scratch/harness-refactor/codex-report-split-[N].md，然后停下。
遇到执行说明第 3 节「停下来问用户」里的任何一种情况，停下回报，不自行决定。
```

| N | 内容 | 该步的检查（原文在拆分计划各步骤末尾） |
| --- | --- | --- |
| 2 | 闭包状态收成 `ExecutionRun`，仍在 `service.ts` 内 | `npm run typecheck`、等价脚本、`npm run test:context-runtime` |
| 3 | 工具端口搬到 `execution-tools.ts` | 上一行，加 `npm run test:verification`、`node scripts/long-task-context.cjs` 和拆分计划步骤 0 第 3 条纳入检查集的脚本 |
| 4 | 在 `tool-pipeline.ts` 里按阶段重排，每次只切一个函数 | 同步骤 3，加 `npm run test:context-window` |
| 5 | 内联规则登记成 `execution-hooks.ts` 里的内部 hook | 同步骤 4 |

交办步骤 5 时在提示词里加一句：「做完后按拆分计划『完成判据』逐条核对，结果写进回报。」步骤 6 是可选的，要做的话把 `[N]` 换成 6，检查见拆分计划步骤 6。

### 3.3　运行标识 A1 到 A8

开工条件：拆分步骤 2 到 5 完成，A0 已提交。八个工作包依次交办。

```text
按 docs/HARNESS_REFACTOR_CODEX_HANDOFF.md 执行「运行标识 A[N]」。

先读 docs/HARNESS_REFACTOR_CODEX_PROMPT.md 第 2 节代码块的一到四部分（全貌和规则，每一批都适用；其中各阶段的状态是第一批交办时的，现在的状态以执行说明第 2 节为准）。再读 AGENTS.md、CLAUDE.md、执行说明第 2、3、5 节和 6.1、[6.x]，以及 docs/adr/0007-append-only-run-log-run-id-and-readonly-delegation.md 第五、六项和 docs/HARNESS_REFACTOR_RUN_ID_STORAGE_DELEGATION_PLAN.md 的 A 部分。
已确认的拟定项：执行说明第 10 节 A1 到 A10。S 组和 C 组没有确认，不要动到。
只做这一个工作包，一个提交。做完按执行说明第 3 节写回报，放 .scratch/harness-refactor/codex-report-A[N].md，然后停下。
遇到执行说明第 3 节「停下来问用户」里的任何一种情况，停下回报，不自行决定。
```

| 工作包 | 执行说明的小节 | 内容 |
| --- | --- | --- |
| A1 | 6.3 | 类型 |
| A2 | 6.4 | 标识进检查点，跨续接不变 |
| A3 | 6.5 | 当前步，以及请求、压缩、操作记录 |
| A4 | 6.6 | 活动事件 |
| A5 | 6.7 | 回执 |
| A6 | 6.8 | 方案规划、通用助手、需求讨论 |
| A7 | 6.9 | 流量记录与请求记录互指 |
| A8 | 6.10 | 收尾 |

### 3.4　上下文与压缩步骤 1 到 7

开工条件：拆分步骤 2 到 5 完成，运行标识在前（执行说明第 10 节 A9）。

```text
按 docs/HARNESS_REFACTOR_CODEX_HANDOFF.md 执行「上下文与压缩步骤 [N]」。

先读 docs/HARNESS_REFACTOR_CODEX_PROMPT.md 第 2 节代码块的一到四部分（全貌和规则，每一批都适用；其中各阶段的状态是第一批交办时的，现在的状态以执行说明第 2 节为准）。再读 AGENTS.md、CLAUDE.md、执行说明第 2、3、7 节，docs/adr/0006-stable-prompt-prefix-and-working-window.md，以及 docs/HARNESS_REFACTOR_CONTEXT_PLAN.md 的「步骤 [N]」「约束对照」「仍待处理」和「验证」。
已确认的拟定项：无。
计划里的行号对应提交 d59c52d，拆分之后语句已经搬家，以语句为准。计划写着「实施时定」「实施时核对」的地方，先把你打算采用的做法写进回报并停下，等用户确认后再改代码。
只做这一个工作包。做完按执行说明第 3 节写回报，放 .scratch/harness-refactor/codex-report-context-[N].md，然后停下。
遇到执行说明第 3 节「停下来问用户」里的任何一种情况，停下回报，不自行决定。
```

这一阶段有三点与前面不同，交办前要知道：

- 上下文计划只写到步骤一级，没有像运行标识那样写到语句。步骤 1 要处理三种协议下尾部消息的落位，步骤 7 的「续接的第一次请求按 `legacy` 预算发出」只定了行为、没有设计（计划「仍待处理」）。建议这两步先展开成设计文档再交办；上面提示词里「先写做法并停下」那一句是没有设计文档时的替代办法。
- 步骤 6 的门槛以真实长任务为准，要用真实的模型连接，每类任务每种策略至少跑 3 次。这部分需要你提供连接并在场，Codex 能独立做的只有回放脚本的改造。
- 步骤 7 要等步骤 6 的结果过了推广门槛才能做；任一类任务超过 20% 就不切换默认值。

## 4　现在不能交办的部分

| 部分 | 还差什么 |
| --- | --- |
| 存储搬迁步骤 1 到 7 | 运行标识完成；任务 B 的数字写回计划；存储搬迁计划「仍待处理」里挡路的条目由你定下（执行说明第 8 节有建议，建议不等于已定，即第 10 节 S 组）；「封存」一词要不要换也没有定 |
| 缺陷候选的修复（拆分步骤 1 设计第 8 节第 1、2 点） | 拆分步骤 2 到 5 完成；修复的设计；你单独交办。修复是单独的提交，并重建等价基准 |
| 规则、审批、通用 shell、自由编码入口 | 没有计划。ADR 0005 末尾列的未定事项也还没有定 |
| 只读委派 | 没有实施计划。前置见执行说明第 9 节；委派的形态和子运行的默认值仍是拟定（第 10 节 C 组） |

这几部分等条件满足、计划写好之后，再补对应的提示词。
