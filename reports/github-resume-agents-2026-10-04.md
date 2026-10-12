# GitHub 简历填写 Agent 调研与本轮改进

调研日期：2026-10-04。方法：浏览 GitHub，克隆四个相关仓库的当时版本，只读源码、模板、测试和授权文件；检查本项目固定安装的 Browser Use 0.13.10。未安装或运行第三方投递程序。README 中的效果声明未当作独立验收结果。

## 1. 调研结果

| 项目与核对版本 | 源码证据 | 适合借鉴的设计 | 适配本项目时的取舍 |
| --- | --- | --- | --- |
| [CCC-Zach/resume-autofill-agent](https://github.com/CCC-Zach/resume-autofill-agent/tree/c6456b64e5a1836d1875ecc61feed2c1fa108871) | `skill/` 中的填写协议、资料模板、`profile_guard.py`、浏览器桥接脚本 | 资料来源账本、冲突状态、重复经历顺序、用户明确纠正的适用范围 | 关键填写规则主要是 Skill 文档；本项目需要把规则落成可校验的数据和运行时约束。MIT；本轮借鉴流程，独立实现 |
| [jayzuccarelli/autofill](https://github.com/jayzuccarelli/autofill/tree/a6115e4b74e5dd645bee643a1dda0d604c793c73) | `autofill/agent.py` 的 Browser Use Agent、Chroma 检索、表单快照差异与纠正记录；`evals/` | 检索召回评测、记录哪些字段缺资料、故障时保留会话 | 它会将检索出的资料文本放进模型任务，并把部分手动改动记成下次提示。我们的资料值留在工具侧；可复用偏好需要用户明确指名和限定范围。MIT |
| [17nbist/jobApplier](https://github.com/17nbist/jobApplier/tree/d025a1c6bc09a7cfbbe3580ad4a3638b110366bb) | `ai.js` 的 `mapFields`、`validateMappings`；`content-ats.js` 与配置解释器；表单夹具测试 | 模型映射后再次校验字段引用和真实选项；普通 Chrome 的入口；拆开电话号码与区号控件 | 当时版本没有找到 LICENSE；`reference/` 文档说明部分配置来自另一扩展。仅学习校验边界和测试结构，不复制代码、站点配置或资源 |
| [recepsuluker/langhire](https://github.com/recepsuluker/langhire/tree/0613cd865794196ea66e692c408d440668ac1e8d) | `backend/memory/store.py`、`extractors.py`、`shared_config.py`、`cli/apply_jobs.py` | SQLite 按域名/ATS 保存操作经验、去重、失败恢复分类、运行指标 | 它包含自动投递；这些动作不进入本项目。记忆权重 0.85/0.5 来自启发式赋值，不能解释为实测成功概率。MIT |
| [Browser Use 0.13.10](https://github.com/browser-use/browser-use/tree/0.13.10) | `agent/service.py` 的 `step`、`agent/views.py` 的 `AgentState`/`AgentHistory`、工具注册 | 观察、模型建议、动作结果、历史状态分别管理；每步重新观察；可序列化状态 | 保留其 SDK 对照实验；普通 Chrome 扩展继续采用当前标签页权限。框架默认动作集合需要按我们的禁止提交要求收窄 |

### 你提供的仓库最值得借鉴什么

[资料接入协议](https://github.com/CCC-Zach/resume-autofill-agent/blob/c6456b64e5a1836d1875ecc61feed2c1fa108871/skill/resume-autofill-agent/references/intake-and-profile.md)把来源、确认状态、冲突和临时占位答案分别记录。[填写协议](https://github.com/CCC-Zach/resume-autofill-agent/blob/c6456b64e5a1836d1875ecc61feed2c1fa108871/skill/resume-autofill-agent/references/fill-and-safety.md)强调多经历先核对顺序和数量、添加后重新读取、上传解析后检查覆盖。[显式学习协议](https://github.com/CCC-Zach/resume-autofill-agent/blob/c6456b64e5a1836d1875ecc61feed2c1fa108871/skill/resume-autofill-agent/references/calibration-and-efficiency.md)限定用户纠正的记忆范围。这些是实用的领域设计。

源码树也说明了其能力边界：它提供 Skill、参考文档、资料处理和浏览器控制脚本，没有发现与本项目任务集相当的独立表单成功率判分。其浏览器桥接允许在指定确认参数后点击不可逆控件；我们的工具契约始终排除提交。文档写有回读策略，仍需用具体网页动作和后置条件验证实际效果。

### 其他项目给我们的工程启发

- [autofill 的评测](https://github.com/jayzuccarelli/autofill/blob/a6115e4b74e5dd645bee643a1dda0d604c793c73/evals/README.md)测量资料是否进入检索上下文，区分排名丢失和切块丢失。它自述的召回结果只属于合成资料检索，不是网页填写成功率。我们的结构化资料目录应先保证全部经历可见；以后接 PDF、证书等材料，再评测检索层。
- [jobApplier 的映射校验](https://github.com/17nbist/jobApplier/blob/d025a1c6bc09a7cfbbe3580ad4a3638b110366bb/ai.js#L350)拒绝未知字段、受限制字段和不在选项列表里的答案。模型输出 JSON 之后，程序仍要检查内容是否能用于当前页面。本轮落实了引用、来源和记录位置检查；真实选项枚举及选择后核验待完成。
- [LangHire 的记忆库](https://github.com/recepsuluker/langhire/blob/0613cd865794196ea66e692c408d440668ac1e8d/backend/memory/store.py)将导航、控件操作和失败恢复按网站分类。我们将来可保存“如何打开并确认学校选项”这类操作经验，并记录观察版本与成功证据。个人事实、用户偏好和网站操作经验需要各自的存储与更新条件。
- [Browser Use 的一步执行](https://github.com/browser-use/browser-use/blob/0.13.10/browser_use/agent/service.py#L1035)把准备上下文、请求动作、执行和收尾串起来；[状态类型](https://github.com/browser-use/browser-use/blob/0.13.10/browser_use/agent/views.py#L251)包含计划、结果和暂停状态。可序列化状态是恢复能力的基础，可靠恢复还需要重新核对网页和处理重复动作。

## 2. 我们的差距与顺序

| 能力 | 调研前本项目的状态 | 本轮结果 / 后续工作 |
| --- | --- | --- |
| 实际 Agent 闭环 | 本地虚构页已完成观察、模型工具调用、执行、回读与独立判分；另有 Browser Use SDK 对照实验 | 保留；新计划层为真实页面执行准备输入 |
| 普通 Chrome 入口 | 用户选当前标签页，0.4 版本能扫描真实页结构 | 0.5 增加计划进度和逐字段建议，权限列表未增加 |
| 资料可靠性 | 目录只有 `path/label`，默认信任传入值 | 新增来源类型、确认状态、冲突阻断与明确来源选择；真实资料编辑/导入仍待接入 |
| 页面与资料的任务级映射 | 真实页诊断尚未交给模型规划 | 新增只读规划函数调用和独立校验；用两段虚构教育经历展示映射与记录缺口 |
| 多经历与奖项路由 | 原合成任务集已有要求，真实扫描已有记录索引 | 新计划支持合并/分区的记录池与数量计算；真实添加与排序动作待验证 |
| 复杂控件 | 能识别自动补全、下拉、日期等类型 | 计划明确标记控件适配需求；尚未执行打开、选择、确认和回读 |
| 恢复与记忆 | 后台中断能报告失败；缺少可靠检查点与网站经验库 | 本轮保留计划状态、检测页面变化；持久检查点与受限经验记忆是后续阶段 |
| 评测 | 32 案例合成基线、浏览器本地演示、杭州银行只读扫描 | 新增程序测试和 3 个真实模型规划样例；多网站盲测待建立 |

建议继续顺序：**接入资料库的确认与冲突预览 → 自动补全/下拉的受限工具与回读 → 多经历增补与路由 → 检查点恢复与经验记忆 → 多站点评测和项目展示。** 长任务恢复阶段再落地 LangGraph 的状态与持久化能力，并与 Browser Use 对照；本轮没有新增 LangChain/LangGraph 依赖。

## 3. 本轮实现

运行链路：

```mermaid
flowchart LR
  P[本地资料候选及来源] --> L[来源检查与冲突状态]
  L --> C[公开字段目录]
  S[当前标签页只读扫描] --> F[页面与目录快照]
  C --> F
  F --> M[LLM 提出一次结构化映射]
  M --> V[校验引用和经历位置]
  V --> R[重新扫描并核对快照]
  R --> U[工具栏展示建议和缺口]
```

- `src/core/profile-ledger.js`：明确来源，未核实、占位或模型猜测不作为可用事实；可信候选冲突时不提供值；显式来源选择可解决冲突。它检查已提供的证据状态，不自动证明材料真实。
- `src/core/fill-plan.js`：模型请求只包含字段元数据和资料目录；不包含输入值、按钮、DOM 选择器、URL 路径或真实资料值。校验未知/重复引用、资料记录和页面记录的对应位置。生成后再次扫描；结构或已填状态变化则使本次计划失效。
- `src/llm/openai-compatible-planner.js`：增加单一 `propose_form_mapping` 函数调用，使用现有模型配置和 HTTP 诊断；模型不能在该接口中提出浏览器动作或实际值。此次也修正了模型耗时计量：统计到响应正文读完，正文读取超时继续报告 `MODEL_TIMEOUT`。
- 扩展后台与本机 WebSocket：计划在后台运行，关闭弹窗后继续；扫描、规划和执行互斥；结果按标签页 ID 和精确网址关联；中断显示失败。
- 工具栏：展示观察、模型映射、程序校验、重新观察四阶段，以及字段来源、未映射项、控件适配需求和还缺几组记录。模型匹配的语义仍需检查。

计划的 `executable` 均为 `false`。真实网站执行入口仍关闭；旧插件目录未修改。面板目前使用**两段虚构教育经历**，其他字段显示资料缺失是预期结果。获奖/竞赛的完整目录仅用于本轮合成评测，尚未接入实际用户资料。

## 4. 验证与范围

- `npm test`：54 项程序测试通过，覆盖来源冲突、模型编造、串填经历、已有值保护、页面变化、WebSocket 契约、后台互斥和面板文案。测试中的模拟模型只证明运行机制。
- `npm run build:extension`：扩展 0.5 构建通过。
- `npm run eval:plan -- --output=reports/plan-model-smoke-2026-10-04.json`：使用配置的真实模型，3/3 规划样例通过：英文教育标签、获奖/竞赛合并、获奖/竞赛分区。全是虚构资料目录和合成页面元数据，未操作招聘网站。
- 这组结果尚不能代表真实学校选项选择成功、草稿已保存、真实资料已接入或跨网站成功率。当前 SHA-256 快照核对的是所扫描元数据，不能发现元数据相同的 DOM 替换、空值互换或未扫描框架中的变化；计划不能直接变成执行授权。

普通 Chrome 已重新加载扩展 0.5，并通过工具栏按钮调用真实模型与本机服务：面板显示两个已存在字段均有资料路径、教育经历仍缺一组、四个规划阶段完整。展开后看到“毕业学校 → 毕业院校（educations.0.school）”和专业路径；关闭面板后核对页面仍是一张卡片、两个空输入、已填字段 0，未执行添加或填写。实测同时调整了面板布局，让计划先于详细诊断显示，生成后滚动到计划结果；扫描与模型规划文案分别说明。

后续验收应把“模型提出正确路径”“控件接受值”“选项真正提交到组件状态”“整份任务完整”分别判分。
