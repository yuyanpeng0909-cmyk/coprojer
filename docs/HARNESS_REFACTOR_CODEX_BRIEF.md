# Harness 重构 · 第一批执行任务书

2026-11-11 · 待执行。第一批是两件不改产品代码的前置工作，由 Codex 在 Windows 本机执行。本文只写两件事共用的约束、不由执行方决定的事和回报格式；每件事怎么做，各有一份设计文档，以设计文档为准，本文不重复。

| 任务 | 内容 | 设计文档 | 依据 |
| --- | --- | --- | --- |
| A | 拆分步骤 1：新增等价脚本 `scripts/tool-pipeline-equivalence.cjs` 和它的基准 | [拆分步骤 1 设计](HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md) | [拆分计划](HARNESS_REFACTOR_SPLIT_PLAN.md)、[ADR 0005](adr/0005-tool-pipeline-and-free-coding-entry.md)（已接受） |
| B | 存储步骤 0：新增测量脚本 `scripts/storage-save-baseline.cjs`，把实测数字写回计划 | [存储搬迁步骤 0 设计](HARNESS_REFACTOR_STORAGE_STEP0_DESIGN.md) | [存储搬迁计划](HARNESS_REFACTOR_STORAGE_PLAN.md) |

两个任务互不依赖，各自一个提交，先后不限。任务 A 是拆分步骤 2 的前提。任务 B 只产出数字；存储搬迁本身不在第一批里：[ADR 0007](adr/0007-append-only-run-log-run-id-and-readonly-delegation.md) 已于 2026-11-11 被接受，但搬迁还要等运行标识完成、存储计划里的待定项由用户定下。第一批之后各批的安排见 [交给 Codex 的执行说明](HARNESS_REFACTOR_CODEX_HANDOFF.md)。

本文早先的一版把两个任务的做法也写在这里，与拆分步骤 1 设计重复，而且细节不完全一样。现在做法只留在设计文档里：任务 A 的落盘记法、占位符写法、场景清单都以拆分步骤 1 设计为准。

## 通用约束

两个任务都必须遵守。任何一条做不到，停下来回报，不自行变通。

1. **不改 `src/`。** 两个任务都只加脚本、基准和文档。任务 A 的变异检查会临时改 `src/main/engineering/service.ts`，每改一处跑完就撤销那一处，不得进入提交；最后用 `git diff --ignore-cr-at-eol --stat HEAD -- src` 确认为空。
2. **不改现有脚本和夹具。** `scripts/fixtures/verification-runtime.cjs` 等文件原样使用，需要的辅助函数写在新脚本里。`package.json` 只有任务 A 在 `test:context-runtime` 里插入一项，其余不动。
3. **不碰真实资料。** 不读写 `%APPDATA%\Coprojer-dev`，不运行这些脚本：`context-runtime-real-*`、`context-window-real`、`context-window-project-replay`、`execution-project-resume-probe`、`execution-prototype-real`、`project-adaptive-context*`、`project-role-adaptive-context`、`pomodoro-live-verification`。新脚本只用夹具的 `fixture()` 在系统临时目录下建的隔离资料目录和隔离工程。
4. **不加依赖，不加测试框架。** 新脚本是 CommonJS 的 `.cjs`，用 `verification-runtime.cjs` 的 `load()` 转译加载源码。注释用英文，只解释原因。
5. **用完还原。** 脚本替换过的 `model.complete`、`store.save`、`store.event`、`RuntimeBudgetLease.prototype` 上的方法、`node:fs` 上的函数，都在 `finally` 里还原；每个场景或负载用一个新的 `fixture()`；结束时不留子进程和受控服务。
6. **现状就是基准，不修现状。** 特征测试固定的是今天的行为，包括拆分步骤 1 设计第 8 节列出的几处反常。发现行为看起来不对，记进回报，不改代码，也不为了让基准好看而绕开那个场景。
7. **每个提交都跑 `npm run typecheck`。** 源码类脚本不做类型检查，要单独确认没有顺手动到类型。
8. **搜索要限定目录。** 仓库根上不做无范围的搜索，指定 `src`、`scripts`、`docs` 等子目录；`service.ts` 的行很长，查看时截断。

## 不由执行方决定的事

遇到下面的情况停下回报，等用户决定：

- 拆分步骤 1 设计第 8 节的现状问题要不要修、什么时候修。拆分阶段不改行为；要修的话是单独的提交，并且要重建基准。
- 基准里出现归一化解决不了的不稳定项；与平台无关的场景在本机的结果和设计文档「已观察」一栏不同。
- 需要改 `src/`、现有脚本或夹具、`package.json` 里现有命令的顺序才能完成任务。
- 存储的分级、活动时间续约的间隔、ADR 0007 的任何内容。任务 B 只报数字，不下结论。

## 回报格式

每个任务一份，放 `.scratch/harness-refactor/codex-report-A.md`、`codex-report-B.md`：

1. 提交号、机器、Node 版本、执行日期。
2. 改了哪些文件；跑过的命令和结果，失败的附输出的关键几行。
3. 任务 A：拆分步骤 1 设计第 7 节「验收」的六项逐项结果；本机结果与「已观察」一栏的出入；归一化规则有没有增补；每一处变异被哪个场景发现。
4. 任务 B：存储搬迁步骤 0 设计第 6 节的七项汇总和第 7 节「验收」的逐项结果。
5. 与设计文档或计划不符的地方，包括行号对不上、语句已经变了、照做会改变行为的。
6. 没做完或没把握的地方，逐条写明，不写成已完成。

写完回报就停下，等用户交办下一步。
