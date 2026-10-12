# 第四课：从普通 Chrome 工具栏选定页面

这一课解决的是 Agent 的“入口”和“执行器”问题。你希望在已经登录招聘网站的日常 Chrome 中点一下图标，让 Agent 处理当前标签页。Agent 不能仅凭网址判断目标：同一网址可以有多个标签页，用户也可能在运行中切换页面。因此扩展先记住 Chrome 给当前标签页的 `tabId`，每一步再核对它的实际 URL。

## 整体位置

已有的核心是 `runAgent`：观察页面、让模型决定下一步、用许可工具执行、回读页面并核验。以前 Browser Use 对照实验使用 CDP 浏览器；现在工具栏入口把浏览器执行层换为 Chrome 扩展。这是典型的“同一个 Agent 循环，接不同环境适配器”：模型决策、工具边界和评测仍然可复用。

## 四种关键技术

| 技术 | 在项目中的作用 |
| --- | --- |
| Manifest V3 action/popup | 用户点击图标，明确选择当前标签页并启动任务 |
| `activeTab` | 用户点击后临时授权该标签页；无需申请访问所有网站 |
| `chrome.scripting.executeScript` | 在选中的标签页读取 DOM 或执行经过许可的单步动作 |
| 本机 WebSocket | 扩展后台把脱敏观察送给本机模型服务，接收结构化建议；心跳保持长任务运行 |

扩展没有 `debugger` 权限。它也没有模型 API Key。API Key 留在本机 Node 服务，网页本身拿不到。模型只收到字段标签、资料字段路径及是否已填，真实值由工具根据路径读取，避免让模型复制或泄露简历原文。

## 一次运行怎么走

1. 弹窗读取当前 `tabId` 和 URL，后台确认它仍是用户选中的标签页。当前版本只允许精确的 `http://127.0.0.1:4173/?runner=browser-use` 或同页的 4174 开发端口。
2. 用户点「开始填写」。后台把这个 `tabId` 固定为本次任务目标。`ChromeDemoEnvironment.reset()` 只观察初始页面，不清空任何真实表单；测试页必须是一张空卡片。
3. `runAgent` 把页面字段的标签、卡片数、已填状态和资料目录发给模型。模型提出 `add_entry` 或 `fill_field`，并提供给用户看的简短理由。
4. `registry.js` 再检查动作语义、控件类型、资料路径和已有值。页面工具只实现添加教育卡片、填写文字字段，没有“提交”入口。
5. 扩展在同一标签页执行一步，重新读取 DOM。独立评测器核对第二张卡片、四个字段、未触发页面内置演示，以及提交控件仍被禁用。未通过就不能报告成功。
6. 弹窗显示计划、执行、核验事件。关闭弹窗后后台继续执行；WebSocket 心跳让服务工作线程在等待模型时保持活跃。

## 为什么保留 Browser Use 对照实验

Browser Use 提供成熟的浏览器 Agent 结构，适合学习它的 Agent、Browser、Tools 与浏览器状态表示。但“连接用户已经打开的普通 Chrome”有不同的浏览器权限边界。工具栏版本没有假装 Python Browser Use 直接控制默认 Chrome：它明确复用本项目的 Agent 循环，使用扩展作为受控浏览器工具。未来若实现可信的 CDP 代理，可以再评估是否直接复用 Browser Use 的浏览器层。

## 相关代码

- `agent-extension/manifest.json`、`popup.js`：权限和用户入口。
- `agent-extension/src/worker.js`：任务状态与 Agent 闭环。
- `agent-extension/src/demo-tab.js`：当前标签页观察与安全动作。
- `web-demo/agent-socket.js`：本机模型连接与 Origin 检查。
- `src/core/registry.js`：工具许可和写后回读。

官方文档：[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[WebSocket 与扩展后台](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)。
