# Coprojer 文档索引

更新：2026-09-28。产品概览和启动命令见[项目 README](../README.md)，开发批次见[更新记录](../CHANGELOG.md)。

## 入门与使用

| 文档 | 内容 |
| --- | --- |
| [新手入门](ONBOARDING.md) | 首次配置、真实项目进度、逐页引导与恢复 |
| [工程指南](ENGINEERING_GUIDE.md) | 开发阶段、停止恢复、资料、验证及验收边界 |
| [功能与验证矩阵](FEATURE_CATALOG.md) | 产品入口、能力范围与测试索引 |
| [需求工作区](REQUIREMENTS_WORKSPACE.md) | 需求、原型、功能图和规格 |
| [圆桌与多端](ROUNDTABLE.md) | 多模型讨论、人工决定及子项目 |

## 模型、智能体与监控

| 文档 | 内容 |
| --- | --- |
| [阿里云快速导入](ALIYUN_IMPORT.md) | 型号识别、额度保护、装配与凭据边界 |
| [能力榜单推荐](MODEL_RECOMMENDATIONS.md) | 已接入候选、来源证据、策略与确认应用 |
| [实例推理设置](AGENT_REASONING.md) | 已适配型号、推理档位/预算与 AA 对齐 |
| [模型流量监控](MODEL_TRAFFIC.md) | 请求、Token、失败率、耗时及统计口径 |
| [智能体与技能](AGENT_SKILLS.md) | 角色、实例配置、专属技能及团队隔离 |

## 验证与开发

- [验证条件自动准备](VERIFICATION_PREPARATION.md)：缺口诊断、有限准备、独立复验、失败保留与恢复。
- [2026-09-28 发布验证](verification/2026-09-28-release.md)：本次发布范围、分段回归、文档与敏感信息检查。
- [长任务上下文修复](verification/2026-09-28-long-task-context.md)：大工具组、摘要扁平化、归档和恢复。
- [长任务无进展保护](verification/2026-09-28-execution-convergence.md)：显式未完成处理、重复失败暂停、受控回归及真实运行边界。
- [原生检查审计](verification/2026-09-28-native-preparation-audit.md)：实际桌面检查、未完成证据与保留失败。
- [2026-09-27 案例记录](verification/2026-09-27-pomodoro-walkthrough.md)：历史番茄钟续跑与全窗口截图。
- [UI 1.6 规范](UI_SPEC.md)与[开发约定](../AGENTS.md)：风格、布局、测试显示器和截图要求。

受控协议测试、真实模型调用、原生桌面操作和人工验收分别记录。历史报告保持原日期和当时结论，本次发布报告不把旧结果改写成新的实测。
