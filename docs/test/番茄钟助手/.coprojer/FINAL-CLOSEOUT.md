# 番茄钟助手收口记录

## 已完成
- Electron 使用目标目录 `.runtime` 隔离 userData、sessionData、crashDumps、logs；preload 提供安全 notify IPC。
- 计时快照持久化 mode、剩余秒数和本组 completedInSet，重启后恢复且保持暂停。
- 完成专注记录入账；每4个专注切长休息；手动结束不入账。
- 设置统一为秒输入，默认专注1500、短休息300、长休息900；范围1-86400并提示错误。
- 本地保存设置、历史、主题；统计今日番茄数和时长；清空需确认。
- 音效/音量、桌面通知、亮暗主题、键盘焦点、减少动态效果、响应式布局。

## 实际命令
- `npm run typecheck` 退出码 0
- `npm run build` 退出码 0
- `npm test` 退出码 0，3/3 通过（真实导入 model）

## 未验证
- 本环境尚未完成人工桌面截图与 Playwright Electron 交互；需最终人工验收时检查 1280x840、860x600 及系统通知权限。

## 主智能体人工 QA（2026-09-15）

- 本地 Vite 预览：`npm run dev -- --host 127.0.0.1 --port 4178`，Vite 8.3.0 在 `http://127.0.0.1:4178/` 启动。
- Playwright+Chrome 脚本 `.runtime/qa.mjs` 实际打开页面，切换计时/设置/统计，提交 0 秒错误，设置焦点 1 秒并开始；等待约 1.2 秒后页面显示「今日完成 1 个番茄」并进入短休息 05:00。
- 生成截图：`output/playwright/main-timer.png`、`settings.png`、`statistics.png`、`exception.png`、`timer-completed.png`。
- Electron `_electron.launch` 可取得窗口句柄并加载页面，但窗口截图在等待字体阶段超时 30 秒；随后脚本退出码 1。该 Electron 截图证据不通过，不能冒充已取得桌面截图。浏览器截图仅证明渲染页面与短时计时流程，不替代 Electron 桌面人工验收。
- 目标目录独立复核：`npm run typecheck`、`npm run build`、`npm test` 均 exit 0（3 个真实 model 测试）。

## 收口补丁与最终 QA 追加

- 修复周期到期回调的重复入账竞态：同一 interval 生命周期只允许一次 finish，避免一次番茄写入多条历史。
- 目标目录复跑：`npm run typecheck` exit 0；`npm run build` exit 0（16 modules）；`npm test` exit 0（3/3）。
- `node .runtime/qa-persistence.mjs` exit 0：短时焦点周期完成后刷新页面，统计仍显示 1 个番茄；视口 860×600。
- `node .runtime/qa-browser-final.mjs` exit 0：真实 Chrome 页面生成主计时、设置、异常输入、统计四张最终截图；视口 1280×840。
- 最终截图：`output/playwright/main-timer-final.png`、`settings-final.png`、`exception-final.png`、`statistics-final.png`。
- Electron `_electron` 窗口可取得句柄，但截图等待字体超时；系统通知权限和 Electron 桌面截图仍未通过本环境人工验证。
- 收口后加入 `app.disableHardwareAcceleration()` 和 `--disable-gpu`，再次运行 `.runtime/qa.mjs` exit 0，Electron Playwright 取得窗口并生成 `electron-main.png`、`electron-settings.png`、`electron-exception.png`、`electron-statistics.png`。
- 独立验证报告：`VERIFICATION-FINAL-2.md`。其命令、浏览器持久化与截图检查均通过。
- 主智能体追加 Electron Playwright 流程：`node .runtime/qa-electron-flow.mjs` exit 0，1 秒焦点自然完成后今日完成 1 个番茄，reload 后记录仍存在，1280×840。
- 主智能体追加四周期流程：`node .runtime/qa-four-cycle.mjs` exit 0，连续四个 1 秒焦点并完成短休息后页面进入长休息。
- 以上脚本均使用目标目录 Electron 二进制和 `.runtime` 隔离数据路径；系统通知是否被 Windows 展示、音频是否被实际扬声器播放仍属于人工环境差异。
