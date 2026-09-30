# 开发指南

[项目首页](../README.md) · [文档索引](README.md) · [领域词汇](architecture/DOMAIN.md)

## 环境与启动

需要 Node.js 22.12+ 与 npm。克隆仓库后在根目录执行：

```powershell
npm ci
npm run dev
```

前端修改支持热更新。Windows 安装依赖后也可使用 `start-dev.cmd`；`npm start` 先构建再启动本地生产模式。模型相关操作需要在应用内配置自己的连接。

## 仓库结构

```text
src/                       Coprojer 主程序
  main/engineering/        模型协议、存储、工具与工程流程
  shared/                  主进程与界面共享的类型
  preload/                 Electron 桥接
  renderer/src/            工作台、模型配置与公共组件
examples/                  可独立运行与阅读的示例项目
  pomodoro/                番茄钟应用与自身单元测试
scripts/                   Coprojer 回归、集成验证与打包检查
  fixtures/                回归使用的受控服务和辅助资料
docs/                      用户指南与专题文档
  examples/                示例的操作流程讲解
  architecture/            领域概念与架构说明
  adr/                     架构决策记录
  verification/            具体运行的验证证据
licenses/                  第三方许可声明
```

示例中的 `tests/` 验证示例自身；`scripts/` 验证 Coprojer。生成物放在 `.runtime/`、`output/`、`out/` 或 `release/`，不作为源码提交。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 开发与热更新 |
| `npm run typecheck` | 主程序 TypeScript 检查 |
| `npm run build` | 类型检查与生产构建 |
| `npm test` | 主程序构建及回归脚本 |
| `npm run test:example` | 番茄钟示例的类型检查、单元测试与构建 |
| `npm run test:engineering` | 工程链路相关回归 |
| `npm run test:verification` | 验证与恢复相关回归 |
| `npm run test:models` | 模型配置与能力证据相关回归 |
| `npm run build:win` | 构建 Windows x64 安装包到 `release/` |

其他专题测试见根目录 [package.json](../package.json)。运行示例检查前单独安装示例依赖：

```powershell
npm --prefix examples/pomodoro ci
npm run test:example
```

## 本地资料与隔离验证

正式版应用资料位于 `%APPDATA%/Coprojer/`，开发版位于 `%APPDATA%/Coprojer-dev/`。主数据由应用管理，模型凭据经系统加密保存。

验证时使用 `COPROJER_USER_DATA` 指定独立的应用资料目录，同时复制目标工程，防止操作影响日常工作。目标工程导出的 `.coprojer/` 资料用于追踪需求和执行记录；直接编辑这些导出文件不会反向导入应用。示例仓库不提交私人会话、模型凭据或本机执行日志。

番茄钟的专项桌面脚本默认定位 `examples/pomodoro`。已有本地项目可通过 `COPROJER_POMODORO_SOURCE` 指定实际目录；真实模型验证还需要对应的 Coprojer 项目资料与有效连接，使用 `--live` 显式启用。带有本机基线依赖的审计脚本需先准备各自输入，不能作为干净克隆的默认测试。

## 验证与提交

根据修改范围选择检查：文档检查链接、图片和命令；示例代码运行示例检查；主程序行为修改运行相应回归。界面和可见窗口的检查遵循 [AGENTS.md](../AGENTS.md)，UI 设计遵循 [UI_SPEC.md](UI_SPEC.md)。

提交前检查差异和敏感信息。用户操作说明写入相应指南，版本变化写入 [CHANGELOG.md](../CHANGELOG.md)，特定运行的证据保存到 [verification/](verification/README.md)。打包内容由 [electron-builder.json](../electron-builder.json) 控制，示例不会混入主程序安装包。
