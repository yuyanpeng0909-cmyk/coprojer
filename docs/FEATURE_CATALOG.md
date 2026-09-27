# Coprojer 功能与验证矩阵

核对日期：2026-09-27。以本次源码、已有使用说明和实际测试结果为准。主图文教程在 [README](../README.md)，执行结果在 [验证报告](verification/2026-09-27-pomodoro-walkthrough.md)。

## 如何阅读

- **实跑**：本次对真实番茄钟隔离副本实际操作，有运行结果或截图。
- **历史复查**：本次打开已有真实成果，不表示重新生成或重新完成全部验收。
- **回归**：本次 npm test 中实际运行的脚本。UI 脚本使用真实 Electron，模型/网络响应使用受控夹具；非 UI 脚本验证服务或纯逻辑。
- **入口展示**：打开实际界面但未提交该操作，不能据此宣称业务链路成功。
- **边界**：无本轮证据或明确不支持的范围，单独说明。

这些分类可同时出现。下表是产品功能清单，不把测试脚本条数当作功能数量，也不把已有功能状态当作本轮测试通过。

## 项目管理与工作台

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 新建工程 | 名称、父目录、目标；创建新的子目录 | 入口展示＋回归，截图 00 未提交 | [project-manager](../scripts/project-manager-smoke.cjs)、[novice](../scripts/novice-smoke.cjs) |
| 环境检查 | Node/npm、目录与可写性；不覆盖同名目录 | 回归 | project-manager、novice |
| 首次模型引导 | 未配置时转至模型连接，返回保留草稿 | 回归 | novice |
| 项目库搜索/排序 | 查找和排序已有项目 | 回归，截图 01 展示真实项目 | [project-library](../scripts/project-library-smoke.cjs) |
| 置顶/重命名 | 管理项目显示与优先级 | 回归 | project-library |
| 归档/恢复 | 已归档项目可查找和恢复 | 回归 | project-library |
| 项目切换与继续 | 顶部选择器、继续开发、最近项目 | 实跑＋回归 | project-library、[smoke](../scripts/smoke.cjs) |
| 打开目录 | 打开实际工程位置 | 回归；本轮使用隔离根路径 | project-manager |
| 下一步引导 | 按真实状态展示当前待办 | 实跑＋回归，截图 02 | [delivery-navigation](../scripts/delivery-navigation-smoke.cjs)、novice |
| 功能统计与待办 | 当前有效功能、已验收数、待办和列表 | 实跑＋回归；已修复合并历史误计数 | delivery-navigation |
| 阶段总览 | 七阶段导航，不自动执行/批准 | 实跑＋回归，截图 06、08、10、22 | delivery-navigation |
| 搜索和筛选 | 工作台功能列表、阶段状态筛选 | 回归 | smoke、delivery-navigation |
| 全局快捷入口 | Ctrl+N 新建，Ctrl+K 查找页面和当前功能 | 回归 | smoke |
| 布局与导航 | 单一侧栏、折叠、独立滚动、键盘焦点 | 实跑＋双尺寸回归 | smoke、delivery-navigation |

## 需求、圆桌与功能图

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 初步目标与设计意见 | 一句话目标、意见输入或推荐设计 | 回归；真实案例已有成果 | novice |
| 单模型讨论 | 流式文本、思考与工具结果，保留原始输出 | 历史复查＋回归 | [research](../scripts/research-smoke.cjs) |
| 讨论型号切换 | 显式选择已接入连接并保留历史 | 回归 | research |
| 多模型圆桌 | 提案、交叉评审、主持汇总 | 历史复查＋回归，截图 03 | [roundtable](../scripts/roundtable-smoke.cjs) |
| 实时功能图更新 | 模型工具更新结构，结束前即可查看 | 历史复查＋回归 | research、roundtable |
| 人工反馈 | 在讨论中补充需求和取舍 | 回归 | roundtable |
| 决策卡选择/自由输入 | 每次呈现当前需要用户判断的决策 | 回归 | [decision](../scripts/decision-smoke.cjs) |
| 延后决策 | 后面再说，转交后续研究；保留未决事项 | 回归 | decision、[discussion-budget](../scripts/discussion-budget-smoke.cjs) |
| 停止/继续讨论 | 保留部分输出和当前阶段 | 回归 | research、roundtable、decision |
| 重启恢复 | 决策、草稿、原思考续接，避免自动重放 | 回归 | decision、discussion-budget |
| 功能图浏览/编辑 | 缩放、定位、节点内容和编辑冲突处理 | 历史复查＋回归 | research、[engineering](../scripts/engineering-smoke.cjs) |
| 独立图窗口 | 脱离主窗口并同步数据 | 回归 | research、roundtable |
| 功能图导出 | SVG、PNG、Markdown、JSON | 回归，校验生成文件 | research |
| 子项目与范围 | 各端目录、功能、接口与职责边界 | 历史资料复查＋回归 | roundtable |
| 子项目窗口 | 按范围查看图和原型 | 回归 | roundtable |

原生移动端或设备工具链构建不在当前交付范围；多端规划不代表能自动打包任意平台。

## 原型与需求基线

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 原型生成/迭代 | 原型前端角色生成 HTML，反馈后更新 | 历史复查＋回归 | [prototype-html](../scripts/prototype-html.cjs)、[design-lifecycle](../scripts/design-lifecycle.cjs)、research |
| 独立设计通道 | 设计可在讨论期间推进 | 回归 | research |
| 交互预览 | 沙箱 HTML、桌面/移动视图 | 历史复查＋回归，截图 04 | research |
| 历史版本 | 回看已有版本；停止/失败保留旧稿 | 历史复查＋回归 | design-lifecycle、research |
| 原型独立窗口与导出 | 拖出或打开独立窗口、导出产物 | 历史复查＋回归，截图 05 | research |
| 原型验收 | 固定选定版本，多界面逐个确认 | 回归；本例沿用已有基线 | novice |
| PRD 自动提取 | 完整读取已选原型，生成 PRD/候选功能 | 回归；本例为既有文档 | novice |
| PRD 失败恢复 | 保留已确认原型和原文档，允许重试 | 回归 | novice |
| 统一规格审阅 | PRD、模块、功能 Spec，搜索定位与目录 | 历史复查＋回归，截图 06 | delivery-navigation |
| 本地阅读标记 | 已核对仅记录阅读进度，不等于批准 | 回归 | delivery-navigation |
| 需求基线确认 | 内容/版本改变时拒绝旧确认 | 历史复查＋回归 | engineering、novice |
| 版本固定与变化失效 | 已确认任务绑定原型；后续变更重新审阅 | 回归 | [context-skills](../scripts/context-skills.cjs)、novice |

本例没有完成原型与真实应用的全面视觉一致性验收；历史 KIMIK3 原型与 Electron 运行图分别保存。

## 方案、执行、独立验证与验收

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 单项方案 | 生成、编辑、任务拆分、确认 | 历史复查＋回归，截图 08 | engineering |
| 批量准备 | 并发准备方案，保留成功项，失败项单独重试 | 回归 | novice |
| 批量审阅开工 | 最多 8 项，包含未完成前置依赖，阻止过期批准 | 回归；本轮真实运行单项 | novice |
| 看板批量菜单 | 按阶段选项、选择/确认、键盘和轻关闭 | 回归，截图 07 展示真实状态 | [execution-plan](../scripts/execution-plan-smoke.cjs) |
| 执行顺序 | 生成/修正顺序、依赖排序兜底、保存和恢复 | 历史复查＋回归 | execution-plan |
| 开工前守卫 | 循环/缺失依赖、非本期功能、缺失目录不得执行 | 回归 | engineering、execution-plan |
| 串行开发 | 读取已确认依据后修改真实工程 | 实跑＋回归，截图 09 | engineering、novice |
| 文件与命令工具 | 目录、文本读写、npm/Node；权限按角色配置 | 实跑＋回归 | engineering、context-skills |
| 执行日志 | 实际调用、命令输出、错误与阶段 | 实跑＋回归，截图 09、10 | engineering |
| 文件差异 | 新增/修改/删除的文本前后对比 | 实跑＋回归，截图 12 | engineering |
| 独立验证 | 阅读实际文件、运行检查、逐项证据 | 实跑＋回归，截图 10、11 | engineering |
| 防止虚假通过 | 无实际检查、失败命令、源码变化时不接受旧结论 | 回归 | engineering、[execution-budget](../scripts/execution-budget.cjs) |
| 自动修复 | 开发修复后重新验证，最多 3 轮 | 回归证明上限；真实统计运行 0 轮 | engineering、execution-budget |
| 步数预算暂停 | 保存开发/验证阶段、工具回合和检查结果 | 回归 | execution-budget |
| 检查点继续 | 重启后从原阶段继续，已写文件不重放 | 回归 | execution-budget |
| 证据过期处理 | 源码、需求、原型或配置改变，丢弃旧证据重查 | 回归 | execution-budget |
| 停止及中断恢复 | 取消模型/命令，保留进度，不自动重新开工 | 回归 | engineering、execution-budget |
| 退回修改 | 输入原因后退回开发/验证 | 回归；本次无须退回统计功能 | engineering |
| 最终验收 | 对照证据实际试用，记录已完成 | 实跑＋回归，截图 22 | engineering、novice |
| 验收后继续队列 | 通过当前项后推进已确认的下一项 | 回归；本次只验收，未启动下一项 | novice |
| HTTP 项目预览 | 启动、打开、停止、重启和固定端口 | 回归 | engineering |
| 原生项目外部运行 | 本机启动 Electron 目标并检查 UI | 实跑，截图 13–15；非内置 HTTP 预览 | 本轮独立 UI 记录 |

工具命令不是系统级沙箱；模型能力和质量也不能由脚本夹具证明。详情见 [工程指南](ENGINEERING_GUIDE.md)。

## 共享上下文与本地记录

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 资料树和正文 | 查看来源、阶段、状态和修订号 | 实跑＋回归，截图 16 | context-skills、novice |
| 补充资料 | 增加工程补充，不篡改已确认基线 | 回归 | novice |
| 归档/恢复 | 工程补充和执行总结可归档；核心基线受保护 | 回归 | novice |
| 任务定向取材 | 当前功能、依赖、公共资料、子项目边界 | 回归＋真实执行使用 | context-skills |
| 长文分页与版本 | 索引、完整读取、版本变化从头重读 | 回归 | context-skills |
| 资料预算 | 可配置字符预算，必需约束超限报错 | 回归 | context-skills |
| 调用取材溯源 | 模型、资料 ID、技能版本/哈希和注入量 | 实跑＋回归 | context-skills、agent-skills |
| 工程资料导出 | 功能、需求、讨论、上下文、活动 Markdown 与原型 JSON | 实跑＋回归；本次不公开完整私有记录 | engineering、research |
| 本地持久化 | 应用资料、项目选择、旧偏好兼容 | 实跑＋重启回归 | smoke、engineering |

资料字符预算不是模型 token 账单；导出 Markdown 不是可反向导入的主数据接口；日志有数量与长度上限。

## 模型、角色与技能

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 自定义连接与预设 | 地址、Key、模型 ID、协议，编辑/删除 | 入口展示＋回归，截图 17、17a | engineering、novice |
| 三种协议 | Chat Completions、Responses、Anthropic，流式/普通响应 | 回归；真实案例调用 Chat 协议 | engineering、research、roundtable |
| 模型列表和手填 | 查询服务列表，失败仍可手填 | 回归 | novice、general-assistant-smoke |
| 连接/能力检查 | 文本回复；无工程副作用的工具往返与 JSON | 回归；本轮不批量探测所有已有账户 | novice |
| 系统加密密钥 | 本机加密存储，不返回前端 | 回归；截图隐藏输入和服务地址 | engineering |
| 连接复用 | 复用地址/协议/密钥新增型号 | 回归 | [general-assistant-smoke](../scripts/general-assistant-smoke.cjs) |
| 型号名称 | 显示模型 ID，保留同名不同连接 | 实跑＋回归 | [model-names](../scripts/model-names-smoke.cjs) |
| 默认/单次助手模型 | 下一次覆盖，发送后返回默认；保留实际使用信息 | 实跑＋回归，截图 21 | [general-assistant](../scripts/general-assistant.cjs)、general-assistant-smoke |
| 模型错误反馈 | 格式、连接和服务错误，保留执行进度 | 回归 | [model-errors](../scripts/model-errors.cjs) |
| 四职责多实例 | 规划、原型、开发、验证；按实例选模型/工具 | 实跑＋回归，截图 18 | [agent-configuration](../scripts/agent-configuration-smoke.cjs) |
| 模型配置建议 | 从已接入型号生成预览，再确认应用 | 回归 | [agent-skills](../scripts/agent-skills.cjs)、agent-configuration |
| 本地技能导入 | SKILL.md/兼容旧清单，预览资源与权限后安装 | 入口展示＋回归，截图 19 | agent-skills、agent-configuration |
| 公开 GitHub 导入 | 固定提交版本、预览再安装 | 回归；无私有仓库凭据支持 | agent-skills、agent-configuration |
| 联网技能推荐 | 需求→搜索词→公开索引/正文核对→候选 | 回归使用受控服务；本轮未对真实推荐质量评级 | general-assistant、agent-configuration |
| 技能启停/更新/移除 | 仅当前实例，内置技能保护 | 回归 | agent-skills |
| 按需读取与隔离 | 先索引后分页，固定版本，不能读取其他实例技能 | 回归＋实际角色读取 | agent-skills、context-skills |
| 推荐记录持久化 | 按实例恢复，失败保留旧结果，可清空 | 回归 | general-assistant、general-assistant-smoke |

技能安装不自动运行脚本，不扩张角色权限。规格、包大小和兼容边界见 [技能指南](AGENT_SKILLS.md)。

## 助手会话、偏好与团队

| 功能 | 入口与行为 | 本轮证据 | 验证入口 |
| --- | --- | --- | --- |
| 助手面板/宽视图 | 工作区内问答、操作引导、状态入口 | 实跑＋回归，截图 21 | general-assistant-smoke、[assistant-workspace-smoke](../scripts/assistant-workspace-smoke.cjs) |
| 项目/全局范围 | 会话固定所属项目，切换项目不偷偷改范围 | 实跑＋回归 | [assistant-workspace](../scripts/assistant-workspace.cjs) |
| 会话管理 | 新建、标题/消息搜索、重命名、置顶、归档/恢复 | 回归 | assistant-workspace、assistant-workspace-smoke |
| 删除会话 | 确认删除，不删除另存的偏好 | 回归 | assistant-workspace-smoke |
| 草稿/阅读位置 | 关闭面板、切换、重启后恢复 | 回归 | assistant-workspace-smoke |
| 中断不自动重放 | 回复标记中断，由用户重试 | 回归 | assistant-workspace |
| 确认偏好 | 候选预填，确认保存；项目/全局范围与编辑/删除 | 回归 | assistant-workspace、assistant-workspace-smoke |
| 团队方案 | 4–12 位成员，保留四职责，可编辑预览 | 回归 | assistant-workspace、assistant-workspace-smoke |
| 确认应用团队 | 项目专用/全局范围，列出影响，过期与忙碌守卫 | 回归；不自动开工 | assistant-workspace |
| 模型建议边界 | 只从已接入型号推荐，不声称已测质量/价格 | 回归 | assistant-workspace、agent-skills |

本轮助手对历史完成数量的自然语言概述存在不精确之处，已在教程明确以功能列表和验收状态为准；模型输出本身不是事实数据库。

## 外观与可用性

明暗主题、强调色、密度、圆角及本地持久化；侧栏折叠、键盘焦点、窗口最大化/还原、独立滚动和减少动态效果沿用 [UI 1.6](UI_SPEC.md)。本轮有真实设置入口截图 20，并通过 1280×840 / 860×600 与明暗主题回归。原笔记入口移除，旧资料保留。

## 番茄钟案例本身的功能状态

这是目标项目的功能，不要与 Coprojer 产品能力混计。

| 目标功能 | 隔离副本结束状态 | 本轮实际证据 |
| --- | --- | --- |
| 番茄计时核心（专注/短休/长休状态机） | 历史已完成 | 本轮再次检查开始/暂停/继续、周期转换与四周期长休 |
| 周期切换提醒（通知+音效） | 历史已完成 | 仅检查设置交互；未确认 OS 通知投递和声音听感 |
| 本地数据统计与复盘 | 本轮新开发并验收 | 32 测试、统计界面/磁盘一致、日期过滤、周月逻辑单测 |
| 主题切换 | 就绪 | 已有实现的深色切换/重载保留通过；未将独立功能卡批准 |
| 历史数据清空 | 方案 | 已有实现的二次确认/清空通过；未将独立功能卡批准 |
| 免打扰模式 | 方案 | 本轮未验证完整业务行为 |
| 最小化到托盘后台运行 | 就绪 | 本轮未进行系统托盘完整验收 |
| 开机自启 | 历史已完成 | 本轮未重启系统验证 |
| 番茄钟核心计时与本地复盘 | 历史已完成的组合条目 | 不与本轮统计新交付混计 |
| 开机自启历史合并记录 | 已合并历史 | 保留追溯；不计入 9 项有效功能和当前阻塞 |
