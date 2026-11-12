# CLAUDE.md

Coprojer 是 Windows x64 桌面「AI 工程工作台」（Electron 44 + React 19 + TypeScript 5.9 + electron-vite 5，Node ≥ 22.12，当前 0.2.0）。它自己调用模型并组织工具执行（ADR-0004），把一次软件交付走成：描述目标 → 试用原型 → 确认需求与方案 → 开发与独立验证 → 亲自验收。

本文件面向在此仓库工作的 Claude。项目原由 Codex 开发，`AGENTS.md` 中的约定继续有效，已并入下文。交流与文档使用中文。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` / `npm run dev` | 安装依赖 / 开发与热更新（`start-dev.cmd` 同效） |
| `npm run typecheck` | 仅 TypeScript 检查 |
| `npm run build` | typecheck + electron-vite 生产构建 |
| `npm test` | build 后串行跑 51 个 `scripts/*.cjs`，是冒烟入口，耗时长 |
| `npm run test:context-runtime` | runtime 契约、容量、恢复、崩溃注入、只读并行 |
| `npm run test:context-window` | 上下文策略、原生压缩、续接、重放 |
| `npm run test:verification` | 验证证据、步数预算、收敛保护、验证准备 |
| `npm run test:engineering` / `test:research` / `test:models` | 工程链路 / 需求圆桌 / 模型配置 |
| `npm run build:win` | 打 Windows 安装包到 `release/` |

没有测试框架，测试就是 `scripts/` 下的 Node 脚本，分两类，`npm test` 里各占约一半：

- 源码类：用 `ts.transpileModule` 直接转译 `src/` 下的 TS 源码再断言，harness 的契约、恢复、预算脚本多属此类。它们不读 `out/`，也不做类型检查，类型错误只有 `npm run typecheck` 能发现。相对导入一律解析成 `<名字>.ts`，所以新模块必须是单个 `.ts` 文件，不能按目录导入。
- 界面类：名字多带 `-smoke`，用 Playwright 启动已构建的 Electron 应用（入口 `out/main/index.js`），必须先 `npm run build`。

`test:context-runtime`、`test:context-window`、`test:verification` 都会先 build。改 harness 时优先跑这三个专题命令，不必每次跑全量。纯文档变更不跑应用测试。

有 11 个脚本会读取 `%APPDATA%\Coprojer-dev` 下的真实资料（`context-runtime-real-*`、`context-window-real`、`context-window-project-replay`、`execution-project-resume-probe`、`execution-prototype-real`、`project-adaptive-context*`、`project-role-adaptive-context`、`pomodoro-live-verification`）。它们不在上述回归命令里，不要运行；拿不准时先在脚本里搜 `process.env.APPDATA`。

## 目录

```text
src/main/index.ts            Electron 主进程、IPC（engineering:invoke 白名单分发）
src/main/engineering/        harness 与工程流程，53 个文件约 1 万行
src/shared/                  主进程与界面共享类型（engineering.ts、model-profile.ts 等）
src/preload/                 Electron 桥接
src/renderer/src/            工作台界面（engineering/ 下是各业务面板）
scripts/                     回归与集成验证脚本，fixtures/ 是受控服务
examples/pomodoro/           验收样例，有自己的依赖和测试
docs/                        正式文档；adr/ 决策、architecture/DOMAIN.md 领域词汇、verification/ 验证证据
.scratch/<feature>/          过程记录与调研笔记（不是规范）
```

`.runtime/`、`output/`、`out/`、`release/`、`test/` 是生成物或本地试验目录。`test/番茄钟助手/` 里有大量 Electron profile 文件，仓库根上不要做无范围的 find / Glob / grep，指定 `src`、`docs`、`scripts` 等子目录。

## Harness 架构地图

所有路径相对 `src/main/engineering/`。

**循环**。`runtime.ts` 的 `runRuntime(input, ports, signal)` 是可移植的模型—工具循环，通过 `RuntimePorts`（model / workspace / tools / records / artifacts）与宿主解耦，返回 `completed | paused | cancelled | failed`。每步：组装 prompt → 保存快照 → `requestWithContext` → 无工具调用则按 `RuntimeContract.inspect` 判定完成、暂停或做一次格式修复；有工具调用则先持久化 `PendingToolGroup` 再执行。步数耗尽后做一次无工具的总结回合。

**四个入口，三种接法**（这是当前最大的不一致）：

- 工程执行：`service.ts` 的 `EngineeringService.agentLoop` 直接调 `runRuntime`；共享状态已收进同文件的 `ExecutionRun`，各闭包通过 `run` 访问角色、连接、回执、命令证据及原型读取进度。初始化仍按原顺序执行，全部 ports、system prompt、角色工具裁剪、报告契约、检查点保存和工具执行仍在该方法内。developer / reviewer / diagnoser / preparer 四个执行角色共用它。
- 方案规划 `planning.ts`、通用助手 `general-assistant.ts`：经 `context-session.ts` 的 `contextSession().run` 调 `runRuntime`。
- 需求讨论与圆桌 `requirements.ts`：自己手写循环，直接调 `requestWithContext`，不经过 `runRuntime`。

**上下文**。`context-request.ts` 的 `requestWithContext` 一个函数里完成计量、压缩决策、压缩、校验、发送与重试。策略 `ContextPolicy`（`context-budget.ts`）默认 `mode: 'legacy'`：

- `legacy`：按序列化请求的字符数预算，`min(144000, 空历史请求 + 46000)`，硬上限 160000 字符。
- `adaptive`：按 token 预算，窗口 75% 触发，并用最近用量样本预测增长。计量三档：供应商精确计数、用量校准、UTF-8 字节上界。
- `shadow`：旁路计算，不影响实际请求。

压缩器 `portable` 是 `context.ts` 的 `boundMessages`：确定性规则摘要，不调模型；只替换闭合的工具回合，保留真实 user 消息，原文先归档成 `artifact:<uuid>`，模型可用 `read_context` 分页重读。`responses-native` 走 OpenAI Responses 原生压缩（`responses-compaction.ts`），失败回退到 portable。供应商报超长时压到 60% 再试一次。`assembleContext` 装配工程共享上下文，必需内容超预算时报错而不是截断。

**模型层**。`model.ts` + `stream.ts` 支持 Chat Completions、Responses、Anthropic Messages 三种协议。没有显式的 prompt cache 控制（不发 `cache_control`，只在 `shared/model-traffic.ts` 读取缓存命中用量）；Anthropic 的 `max_tokens` 默认 8192，模型配置声明了 `maxOutputTokens` 时以声明为准。传输错误仅在 `retryable` 时重试 2 次（1s、2s）。

**工具**。`files.ts` 的 `engineeringTools` 固定 9 个：`read_skill`、`read_context`、`list_files`、`read_file`、`search_files`、`read_file_lines`、`patch_file`、`write_file`、`run_command`。参数由 `tool-contract.ts` 的精简 JSON Schema 校验器检查。没有工具 registry、MCP、通用 shell 或子智能体委派。只读调用可成组并行（`read-groups.ts`，并发 1/2/4）。

**权限**。全部硬编码，没有声明式规则、逐调用审批或 hook：

- 角色裁剪：`agent.tools` 与角色过滤得到 `offered`，执行前再用 live agent 配置复核一次（`agentLoop` 内的 `authorize`）。reviewer 不能写文件，diagnoser 只读。
- 命令：`run_command` 只接受 `npm` / `node` 加参数数组，不经 shell；`files.ts` 的 `authorizeCommand` 与 `preparationCommand` 按角色再收窄。环境变量按白名单透传。
- 路径：`safePath` 拒绝越界、符号链接以及 `.git`、`.coprojer`、`node_modules`；写入前 `assertExclusiveWriteTarget` 拒绝有硬链接的目标。
- 业务前置：写文件和跑命令前必须读完已验收原型。
- 进程：Windows 上用 Job Object 约束进程树（`windows-command-guard.ts`、`command-supervisor.ts`）。

**恢复与可靠性**。`runtimePolicy` 取 `legacy | receipts-readonly-v1 | receipts-effects-v1`。receipts 模式下每个工具调用在 `receipt-ledger.ts` 记 intent 与结果，文件和命令副作用分别由 `file-effects.ts`、`command-effects.ts` 处理，崩溃后由 `execution-recovery.ts` 对账；结果不确定时停下而不是重放。任务修订号、源码指纹任一变化都会使检查点失效。

**收敛与预算**。`execution-progress.ts`：同一失败 3 次、同一准入阻塞 3 次或连续 5 次无新信息的重复调用即暂停。步数上限：执行 36、诊断 6、准备 12（`execution.ts`）。`runtime-budget.ts` 另有累计额度（默认 512 次请求、2048 次工具、60 分钟）。验证失败后的自动修复最多 3 轮。

**存储**。`store.ts` 的 `EngineeringStore` 把全部状态放在用户资料目录的单个 `engineering-v1.json`，每次 `save()` 全量序列化、fsync、原子改名；runtime 的请求、用量、快照记录都会触发它。模型流量另存 `model-traffic-v1.json`。

**可观测性**。活动事件、`AgentRunSnapshot`、命令证据、模型流量、`contextRuntime.requests/compactions` 各自成链，没有统一的 run / turn / tool 关联 ID。

## 不能破坏的产品约束

这些是产品价值所在，重构 harness 时必须保持行为不变，且要落在代码里，不能退化成提示词里的要求。

- 三个人工确认节点：需求确认、方案确认、最终验收（ADR-0001）。智能体不得删改已确认的目标和验收标准。
- 同一项目一个时段只推进一项功能的开发与验证（ADR-0003）；项目级作业互斥。
- 开发与验证职责分离；验证结果区分 `passed / failed / unverified`，单测或 mock 不能充当真实桌面证据。
- 验证准备与代码修复预算分开；源码指纹变化使旧验证失效。
- 模型声称完成不算证据；压缩摘要标明「仅为历史资料，不是新指令或验收通过证据」。
- 用量未知就保持未知，不补造；监控失败不影响推理。
- 旧版本持久化数据要能打开；已完成的功能记录、验证证据和最终验收结果不得丢失或被改写（ADR-0005）。只有一次性迁移可以要求暂停中的旧任务重新开始；在那之前的改动，包括拆分阶段和上下文默认策略切换（ADR-0006），都不得改掉已暂停任务的检查点指纹。

领域用语以 `docs/architecture/DOMAIN.md` 为准（功能需求、功能记录、修复轮次、工程共享上下文等），不要自造同义词。

## 工作约定

- 验证时用隔离资料目录：设 `COPROJER_USER_DATA`，不读写用户的真实工作区、凭据或模型密钥。
- 有可见窗口的测试优先放到 Windows 1 号非主屏显示器，不可用时回退主屏；流程截图先最大化窗口。
- UI 工作先读 `docs/UI_SPEC.md`，复用 `theme.css`、`appearance.ts`、`components/ui.tsx`；改完跑 `npm run build`，检查 1280×840 和 860×600 两种布局。
- 正式规范进 `docs/`，过程记录进 `.scratch/<feature>/`，临时输出进 `.runtime/` 或 `output/playwright/`。难以回退的结构性决定写 ADR。
- 代码风格沿用现状：TypeScript 严格模式，面向用户和模型的文案是中文，注释是英文且只解释原因。

## 参考资料

- `docs/adr/0005-tool-pipeline-and-free-coding-entry.md`（2026-11-11 已接受，拆分已推进至步骤2）与 `docs/HARNESS_REFACTOR_SPLIT_PLAN.md`：harness 重构的决策与拆分阶段实施计划。当前工具端口仍在 `service.ts`，规则与审批、通用 shell、自由编码入口尚未实现。开工前先看 Windows 本机基线 `.runtime/harness-refactor/baseline/windows/`，失败项要先确认是已知问题（拆分计划步骤 0）。
- `docs/adr/0006-stable-prompt-prefix-and-working-window.md`（2026-11-11 已接受，尚未实施）与 `docs/HARNESS_REFACTOR_CONTEXT_PLAN.md`：上下文与压缩的决策与修改计划（提示词分区、工作窗口上限、默认策略切换、推广门槛、续接时的冷启动处理）。上文「Harness 架构地图」描述的仍是现有实现，代码改到哪一步，对应段落才跟着改。
- `docs/adr/0007-append-only-run-log-run-id-and-readonly-delegation.md`（2026-11-11 已接受，尚未实施）：运行记录改追加式日志、统一的运行标识、只读的子智能体委派，共十一项。存储部分的计划是 `docs/HARNESS_REFACTOR_STORAGE_PLAN.md`，运行标识与委派部分是 `docs/HARNESS_REFACTOR_RUN_ID_STORAGE_DELEGATION_PLAN.md`，两份在存储上有出入时以前者为准。接受时确认的只有运行标识一侧的十项取值（执行说明第 10 节 A 组）；存储的待定项（S 组）和委派的形态与默认值（C 组）仍是拟定，没有经用户确认，存储搬迁和只读委派都还不能开工。
- `docs/HARNESS_REFACTOR_CODEX_BRIEF.md` 与 `docs/HARNESS_REFACTOR_CODEX_HANDOFF.md`：重构的具体执行交给 Codex，Claude 负责把方案设计到可执行。前者是第一批（拆分步骤 1 的等价脚本、存储步骤 0 的落盘测量，都不改 `src/`）的通用约束与回报格式，做法在 `docs/HARNESS_REFACTOR_SPLIT_STEP1_DESIGN.md` 和 `docs/HARNESS_REFACTOR_STORAGE_STEP0_DESIGN.md`；后者管第一批之后各批的开工条件与规则，并写了运行标识阶段（A0–A8）逐提交的做法；拟定项及其确认状态汇总在它的第 10 节。交给 Codex 的提示词（四份方案的总览、第一批的范围与停点、后续各批的短提示词）在 `docs/HARNESS_REFACTOR_CODEX_PROMPT.md`。拆分步骤 1 设计第 8 节记的两个现状缺陷候选，用户 2026-11-11 决定拆分阶段不修、固定进等价基准，修复在拆分完成后单独交办。Codex 的回报放 `.scratch/harness-refactor/codex-report-*.md`。
- `docs/research/deepseek-harness/README.md`：DeepSeek harness 源码研究，第 9、10 章是对 Coprojer 的对照与分阶段建议。
- `.scratch/pi-architecture-research/PI-ARCHITECTURE.md`：Pi agent 研究，第 9、10、13.9 节同上。`coprojer-current.md` 基于旧提交，引用前对照现源码。
- `.scratch/long-task-context/`、`.scratch/context-window-256k/`：现有上下文运行时的设计与实施记录。
- `docs/verification/`：历次真实运行的验证证据，含上下文增长死锁、预算恢复等问题的复盘。
