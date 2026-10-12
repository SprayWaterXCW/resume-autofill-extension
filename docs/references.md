# 开源项目参考与设计取舍

主参照是 **Browser Use**：Python 对照实验直接依赖其库，把浏览器会话、Agent 循环与动作注册接到虚构本地招聘页。日常 Chrome 工具栏入口复用本项目的 Agent 核心，采用扩展执行层，因为它需要直接处理用户已打开的标签页。其他项目用于评测、复杂控件和恢复能力的对照。没有复制这些项目的实现代码；效果仍由自己的独立评测判定。

2026-10-04 增加对 `CCC-Zach/resume-autofill-agent`、`jayzuccarelli/autofill`、`17nbist/jobApplier`、`recepsuluker/langhire` 的源码调研，逐个固定提交版本并检查许可证。详细证据和复用取舍见 [本轮报告](../reports/github-resume-agents-2026-10-04.md)。本轮独立实现资料来源检查、结构化映射计划与复扫失效；没有复制第三方的站点配置或投递动作。[第七课](lessons/07-evidence-and-readonly-plans.md)解释相关技术。

| 来源 | 值得学习的流程 | 本项目的对应实现或计划 |
| --- | --- | --- |
| [Browser Use](https://github.com/browser-use/browser-use) 与[自定义工具文档](https://docs.browser-use.com/open-source/customize/tools/add) | `Agent → BrowserSession → Tools` 的浏览器闭环、DOM 观察、工具执行、步骤轨迹 | 已在 `browser_use_adapter/` 建立本地试运行；使用其真实 Agent、Browser 和 Tools，注册两个领域动作，并对真实动作表做白名单检查 |
| [Browser Agent](https://github.com/uiuing/browser-agent) | 集中式工具注册、类型校验、DOM 后置条件、运行轨迹、浏览器扩展与测试环境分离 | 实现单一工具入口、Zod 校验、后置检查；当前标签页扩展已接入本地虚构 DOM |
| [BrowserGym](https://github.com/ServiceNow/BrowserGym) | `reset → observe/step → reward/termination` 的可重复任务环境和独立评测 | `SyntheticFormEnvironment.reset/step/evaluate` 与 `npm run bench` |
| [Stagehand](https://github.com/browserbase/stagehand) | 区分观察、动作与结构化提取；把复杂页面操作拆成可检查的原语 | 当前拆分观察、决策、动作与验证；以后参考 `observe/act/extract` 处理 DOM 和控件 |
| [ReAct 论文](https://arxiv.org/abs/2210.03629) | 在推理、动作与环境反馈之间反复交替 | `runner.js` 每轮重新观察，并将失败反馈给下一轮决策 |
| [Nanobrowser](https://github.com/nanobrowser/nanobrowser) | Chrome 扩展中的 Planner/Navigator 分工和长任务恢复 | 保留为后续比较方案；先证明单 Agent 闭环有效，再决定是否拆角色 |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | 显式状态、持久化、可恢复执行与人工介入 | 后续长网页任务的检查点和恢复；第一阶段先有清晰状态边界 |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js) | 工具、守卫、会话和轨迹的通用 Agent 结构 | 对照检查我们的工具和轨迹设计；是否作为直接依赖要等浏览器运行环境适配验证 |

## 两条浏览器接入路径

第一阶段的小内核保留为明确的任务契约和评测基线。Browser Use 对照实验使用其 SDK 负责浏览器控制、页面观察、模型决策和动作循环；我们收窄其工具注册表并独立判分。普通 Chrome 工具栏入口则使用现有 `runAgent` 闭环，通过 `activeTab` 和 `scripting` 控制用户选中的标签页，并从本机服务获取模型决策；本地填写和 0.4 真实页扫描均已有实际 Chrome 验证。Browser Use 默认包含通用点击、导航和脚本动作，因此不能把框架本身视为“绝不提交”的保证。

## 下一阶段的对照实验

同一批合成页面至少用两种决策器测试：脚本化替身和真实 LLM。比较任务完成率、无效工具调用率、平均步骤数、模型耗时、费用和危险动作拦截情况。脚本替身只用于证明运行时；真正的语义泛化必须由**未见过的新标签和新布局**来检验，例如“毕业学校／毕业院校”“奖项与竞赛合并／分区”。
