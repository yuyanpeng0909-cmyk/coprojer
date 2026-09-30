# 示例项目

这些项目用于理解 Coprojer 如何组织需求、原型、开发、验证与验收，也可独立运行和测试。

| 示例 | 内容 | 阅读入口 |
| --- | --- | --- |
| [番茄钟助手](pomodoro/README.md) | Electron、React、TypeScript；计时状态机、桌面交互、单元测试 | [完整流程讲解](../docs/examples/pomodoro.md) |

示例源码与自身测试放在同一目录，流程讲解放在 `docs/examples/`。Coprojer 主程序的回归脚本位于 `scripts/`。

运行示例代码不需要模型 API Key；通过 Coprojer 重新组织开发时，配置自己的模型连接并使用独立项目目录。示例不会自动导入作者的历史会话、原型或验收状态。
