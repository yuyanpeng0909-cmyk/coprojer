# 验证条件自动准备：实现与验证记录

日期：2026-09-28。目录：`D:\develop\coprojer`。本次修改通用工程流程，使用临时目标工程、隔离资料目录和本地确定性模型协议夹具。没有调用收费模型、运行完整 25 分钟测试、修改番茄钟目标工程或提交/发布代码。仓库内其他未提交改动保留。

## 实现范围

- `service.ts`、`verification.ts`：未验证项先只读诊断，自动缺口进入准备，再自动独立复验；混合缺口先完成自动部分，明确业务缺陷仍进入原修复流程。
- `execution.ts`、`store.ts`、`shared/engineering.ts`：准备独立预算、同条件无进展保护、审计记录和中断断点。准备不增加或重置 `repairRound`，继续执行保持功能串行与最终人工验收。
- `files.ts`、`command-supervisor.ts`：测试资料和新增 `test:*` 的受限写入、必要开发依赖安装、受保护源码检查、隔离用户目录、有界命令和宿主退出清理。已有断言保留，业务代码由原开发阶段修复。
- `VerificationProgress.tsx`、`EngineeringPage.tsx`、`engineering.css`：展示诊断、准备、复验、剩余条件和实际准备结果；沿用 UI 1.6。
- 证据关联源码及锁文件指纹，区分单元/Mock、实机、桌面、时长和历史记录。准备总结不能判为通过，源码或确认范围变化会使旧通过证据失效。

详细流程和自动处理边界见[功能说明](../VERIFICATION_PREPARATION.md)。

## 已实际运行

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| `npm run test:verification`（最后一轮） | 退出码 0 | 包含 `npm run build` / TypeScript 检查、证据/预算回归、准备编排、真实进程清理及真实 Electron UI。 |
| `verification-preparation.cjs` | 通过 | 夹具驱动真实 service/store/工具，实际生成断言脚本并独立执行；实际 npm 安装项目内离线开发依赖。覆盖缺脚本、缺依赖、外部/混合缺口、业务缺陷路由、无进展/预算、首次请求及写入后取消、重启恢复、源码/锁文件失效和权限边界。 |
| `verification-processes.cjs` | 通过 | 实际启动短时 Node 子进程，检查取消与宿主突然退出后的进程终止和孤立资料清理。 |
| `verification-preparation-smoke.cjs` | 通过 | 真实 Electron/IPC/持久化、本地协议回复；检查三个自动阶段、真实生成/执行脚本、剩余外部条件、重启后重新执行、键盘与明暗主题。 |
| `node scripts/verification-evidence-smoke.cjs` | 退出码 0 | 原待补验证、仅重新验证入口、最终验收关卡及两种窗口尺寸回归。 |
| `node scripts/engineering-smoke.cjs`（独立重跑） | 通过 | 首次全量中出现重启白屏超时，独立重跑通过；保留原失败记录，不宣称从未失败。 |
| execution-plan、research、roundtable、decision、discussion-budget、novice 六个脚本 | 通过 | 从被全量失败截断的后续套件逐项运行，检查串行计划、讨论/决策/原型/确认与持久化等原有行为。 |
| 本次目标文件 `git diff --check` | 通过 | 未处理目标工程原有日志中的无关尾空格。 |

编排测试通过表示确定性回复下的路由、权限、预算及恢复满足断言；真实运行验证表示脚本、依赖安装、进程和 Electron 交互实际发生。二者均不代表真实付费模型的自主规划成功率或用户最终验收完成。

1280×840、860×600 与暗色的固定尺寸截图已逐张查看：状态和缺口可读，窄窗口内容可滚动，底部继续验证操作可达。截图与本次 UI 源码/构建指纹见[布局基线](../ui/baseline-v1.6/verification-preparation/evidence.json)。这些是布局回归图，不是最大化操作教程。

## 全量回归遗留

本次运行过两次 `npm test`，**未得到全量通过结果**。第二次停止于 `scripts/project-library-smoke.cjs:125`：

`continue action remains visible in the first viewport`

独立重跑 `project-library-smoke.cjs` 同样失败。该断言针对项目库首屏“继续开发”操作可见性，相关 `ProjectManager.tsx` 未由本次功能编辑。当前仓库同时存在该页面及其他功能的未提交改动，尚未确认失败归因；本次保留现场，没有覆盖页面或放宽断言。基础全量回归因此仍有此未解决项。

日志保存在本地 `.runtime/verification-preparation/`：`verification-suite-final.log`、`evidence-smoke-final.log`、`npm-test.log`、`npm-test-final.log`、`engineering-recheck.log`、`project-library-recheck.log`、`tail-suite.log`。对应摘要与当前关键文件 SHA256 另存于[检查结果](2026-09-28-verification-preparation-results.json)。工作区有并发改动，结果仅对应记录的源码/构建状态，不代表后续修改自动通过。

## 尚未真实验证

- 真实收费模型自主诊断与生成复杂 Electron 冒烟脚本的成功率。
- npm 公网下载安装：本次安装路径使用项目内离线依赖，但执行了真实 npm 安装命令。
- 任意目标应用的操作系统桌面鼠标交互、缺失设备或跨平台能力；菜单回调/Mock 不代替这些证据。
- 长时间精度、完整 25 分钟测试及用户最终业务验收。

缺目标平台、设备、凭据、明确授权或观察能力时仍保留未验证。网络失败、未知诊断和准备预算耗尽显示技术阻塞及实际结果，不一概要求人工，也不会伪造通过。
