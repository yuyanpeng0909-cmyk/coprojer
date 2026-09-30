# 番茄钟助手

一个可独立运行的 Electron + React + TypeScript 示例，用于理解 Coprojer 从需求到验收的工作流程。包含应用源码与单元测试，适合先运行、再阅读、最后尝试一项小改动。

[流程讲解](../../docs/examples/pomodoro.md) · [测试场景](TESTING.md) · [Coprojer 首页](../../README.md)

## 运行

需要 Node.js 22.12+ 与 npm。在仓库根目录执行：

```powershell
cd examples/pomodoro
npm ci
npm run dev
```

`dev` 会先构建，再启动桌面应用。独立运行无需配置模型服务。应用会在 Electron 用户资料目录保存设置和历史，做实验时建议指定独立资料目录：

```powershell
npm run build
npx electron . --user-data-dir=../../.runtime/pomodoro-example
```

## 验证

在示例目录执行：

```powershell
npm run typecheck
npm test
npm run build
```

也可以回到仓库根目录运行 `npm run test:example`。详细测试范围和手动检查步骤见 [TESTING.md](TESTING.md)。

## 代码阅读顺序

| 文件 | 关注点 |
| --- | --- |
| [src/shared/timer.ts](src/shared/timer.ts) | 计时状态、绝对时间戳、阶段切换与暂停恢复 |
| [tests/timer.test.ts](tests/timer.test.ts) | 将计时规则转成可重复执行的断言 |
| [src/main/main.ts](src/main/main.ts) | Electron 窗口、持久化、托盘与系统设置 |
| [src/main/preload.ts](src/main/preload.ts) | 界面与主进程之间的桥接 |
| [src/renderer/app.tsx](src/renderer/app.tsx) | 计时、统计、设置界面及操作反馈 |
| [tests/main.test.ts](tests/main.test.ts) | 通过模拟 Electron 接口验证自启设置行为 |
| [build.mjs](build.mjs) | 将主进程、桥接和界面打包为可运行文件 |

## 用它学习 Coprojer

沿着[流程讲解](../../docs/examples/pomodoro.md)，把一个目标拆成需求、原型、方案、代码、验证证据和人工验收。建议先阅读和运行现有代码，再在独立项目中练习调整时长、修改交互或补充测试。

本目录提供可复现的公开代码示例；教程中的工作台截图展示完整工程流程，不表示打开源码后会自动恢复相同的讨论与功能状态。原始运行结果保留在[验证记录](../../docs/verification/README.md)中。
