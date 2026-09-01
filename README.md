# AI 小说创作工作台 / AI Novel Production Engine
一个面向长篇小说创作的 AI Native 开源项目。

当前开发主线：
`AI Workbench + Creative Hub + 自动导演开书 + Reference Corpus + StoryState + Skills + 写法引擎`

![Monorepo](https://img.shields.io/badge/Monorepo-pnpm%20workspace-3C873A)
![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB)
![Backend](https://img.shields.io/badge/Backend-Express%20%2B%20Prisma-111827)
![LangChain](https://img.shields.io/badge/AI-LangChain-0EA5E9)
![LangGraph](https://img.shields.io/badge/Agent-LangGraph-7C3AED)
![Editor](https://img.shields.io/badge/Editor-Plate-7C3AED)
![Database](https://img.shields.io/badge/Database-PostgreSQL%20%2B%20Prisma-111827)
![Vector DB](https://img.shields.io/badge/RAG-Qdrant-E63946)


## ✨ 项目简介

这是一个**面向长篇小说完成度的 AI 生产系统**，不是普通的"你写一句、AI 补一句"聊天壳子。

它的核心做法是：

- 👉 用一句灵感启动整本书的规划，AI 自动给出方向 / 世界 / 角色 / 卷战略 / 章节任务
- 👉 在 AI Workbench 里统一管理从零开书、导入续写、风格学习、批量生成、风险暂停和人工确认
- 👉 把章节生成、审核、修复、状态回灌串成可暂停可恢复的生产链
- 👉 把拆书、导入语料、知识库、写法引擎、Skills、角色资源账本、世界手册都做成可召回的长期资产
- 👉 提供漫画、短剧等衍生工坊围绕已完成的小说内容做视觉与剧本延展
- 👉 配套公开介绍站、生产链深度文档和按阶段的恢复手册

适合**完全不懂写作的新手**走完一本长篇，也适合研究 AI Native 应用、Agent Workflow、LangGraph 编排和长链路任务的开发者参考。

## Windows 桌面版

当前 `novel-forge` 开发重点是本地 Web 工作台，优先按下文 `pnpm dev` 跑起来并访问 `/ai-workbench`。

如果你只是想体验上游项目的桌面安装包，可以参考上游发布入口：

- 下载入口：[GitHub Releases](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant/releases)
- 最新版本页：[Latest Release](https://github.com/ExplosiveCoderflome/AI-Novel-Writing-Assistant/releases/latest)
- 建议优先下载 `Setup.exe` 安装版；如果你不想安装，或者想放在 U 盘 / 临时目录里直接运行，再选择 `portable` 版本
- 公开介绍站：[GitHub Pages 介绍站](https://explosivecoderflome.github.io/AI-Novel-Writing-Assistant/) 提供功能预览、模块文档和使用指南

## 用 Codex 持续创作长篇：Ani Book Skill

如果你希望直接在 Codex 的本地工作区推进小说，可以使用 [Ani Book Skill](https://github.com/ExplosiveCoderflome/ani-book-skill)。它将方向判断、故事发动机、章节推进、审校修复和连续性管理组织为一条可恢复、可追溯的长篇创作流程。

这是一条与本项目互补的创作入口：

- 需要可视化创作工作台、模型配置、运行实况与小说资产管理：使用本仓库。
- 希望在 Codex 中通过本地文件、阶段工件和 Skill 直接持续创作：前往 [Ani Book Skill](https://github.com/ExplosiveCoderflome/ani-book-skill)。

## 项目定位

很多 AI 写作工具的使用方式其实差不多：你输入一句 Prompt，它回你一段正文，不满意就重试。写短篇还行，写长篇容易越写越散。

这个仓库是"AI 导演式长篇小说生产系统"，核心产品判断是：

- 目标用户优先是完全不懂写作的新手，而不是熟悉结构设计的资深作者
- 优先解决"如何把整本书写完"，再逐步优化"写得多精巧"
- AI 不只是补全文本的模型，而是参与规划、判断、调度、执行和追踪的系统角色

如果你在找下面这类项目，这个仓库会更值得关注：

- 想验证 AI 是否真的能参与整本小说生产，而不是只写单段文案
- 想研究 AI Native Product、Agent Workflow、LangGraph 编排怎样落到真实创作业务
- 想把世界观、角色、拆书、知识库、写法控制、章节生成、质量修复串成一套稳定工作流

## 现在已经能做什么

### 1. AI Workbench：自动小说生成系统入口

- 新增 `/ai-workbench` 页面，把生产链、StoryState、章节树、人物关系图、时间线、伏笔、风格、Skills、模型调用、ReviewGate、StatePatch、批量任务放进同一工作台
- 支持两类入口：**从零开书**和**导入续写**；从零开书可以生成书设、角色、世界观、前 20 章大纲和前三章样稿，导入续写可以基于已导入语料续写指定章节
- Workbench 以 `Planner / ContextBuilder / Writer / Reviewer` 四角色组织执行记录，每一步输入、输出、模型调用、召回引用和审校结果都可以回看
- 批量生成支持手动设置章节范围和批次数量，遇到高风险 ReviewGate 或 StatePatch 会进入 `waiting_approval`，等待人工确认后再继续
- 页面提供可观察证据：生成是否引用旧章节、是否写入 StatePatch、是否触发 ReviewGate、是否存在质量债、是否有 checkpoint 可恢复

### 2. Reference Corpus：导入续写与仿写基础

- 可导入外部小说样章、章节片段或参考文本，生成章节、段落、摘要、实体候选、时间线候选、伏笔候选、风格候选等结构化 chunk
- 续写支持直接续写、指定位置续写、大纲续写和风格续写；指定位置续写会使用章节/段落/锚点文本定位上下文
- 导入语料通过 Postgres 保存业务事实，通过 Qdrant 做语义索引；生成时会展示召回片段、来源、分数和使用原因
- 当目标小说还没有正式角色时，系统可以从语料角色候选生成少量临时角色种子，避免续写流水线因“无角色”阻断
- 适用于同世界续写、按样章语气续写、在导入章节后继续第 N 章、基于旧稿重建上下文后再写

### 3. StoryState：长文一致性运行时

- StoryState 从 Postgres 聚合当前书的章节树、角色/关系、时间线、伏笔/兑现账本、StyleProfile、启用 Skills、ReviewGate、StatePatch 和质量债
- 内置确定性检查包括死亡/离场角色再出现、地点时间冲突、伏笔逾期、核心角色缺席、时间线倒退、资源持有人冲突、能力设定冲突、主线过早兑现、重复事件、Skill 规则冲突
- 质量债会按 blocking/error/warning/info 排序，指出来源、章节、证据和建议动作，帮助批量生成前先处理阻断项
- 人物关系图、时间线、伏笔看板、章节树不是静态展示，而是直接读取运行时状态，用于检查长文前后一致性

### 4. Skills 系统：题材与写作能力插件化

- 新增本地 Skills 注册与项目启用机制，支持 `skills/builtin-skills.json` 和目录式 `skills/*/skill.json`
- Skill 可以声明 prompt hooks、状态要求、ReviewGate 检查项、冲突键、规则说明、示例和 state schema
- 当前内置方向覆盖多种网文题材与横向能力，例如悬疑推理、冷峻克制风格、去 AI 味等；项目可以按小说启用/禁用组合
- 系统会检查 Skill 之间的冲突键、State schema 字段冲突，以及 Skill 与 StyleProfile 的风格契约冲突
- Writer 会读取启用 Skill 的 hook，ReviewGate 会执行 Skill 检查并把命中证据写入审校结果

### 5. 风格学习、仿写与 Style Lab

- 写法引擎不再只是提示词里的一段说明，而是可保存、编辑、绑定、试写、复用的长期资产
- 可从导入样章或现有文本生成结构化 StyleProfile，选择学习文风语言、章节结构、节奏爽点、去 AI 味等维度
- Style Lab 支持按当前 StyleProfile 试写同一剧情，并立即执行风格偏离检测
- 偏离报告会展示风险分、偏离点、命中规则、证据片段、原因和建议，便于判断“像不像样章”
- 风格画像可与 Skills 同时参与 Writer、Reviewer、ReviewGate，而不是只在某一次生成 prompt 中临时出现

### 6. ReviewGate、StatePatch 与人工确认闭环

- ReviewGate 将任务适配、连续性、风格、可读性、状态补丁安全性拆成结构化评分
- 高风险设定变更、角色死亡、核心真相揭露、状态写入等不会直接自动入账，而是生成 `needs_confirmation` StatePatch
- StatePatch 面板支持接受、拒绝、撤销，并会联动关闭或保留关联 checkpoint
- 批量任务恢复前会检查未处理的高风险 StatePatch，避免 AI 在用户未确认的状态上继续扩写
- 适合“AI 批量推进，人类确认关键节点”的创作方式

### 7. AI 自动导演开书与四种运行模式

- 从一句灵感直接进入自动导演，无需先手写世界观、主线、角色和卷纲；系统先整理项目设定、对齐书级 framing，再生成多套整本方向和对应标题组
- 方向不满意时可以继续生成、定向修订某一套方案、或只重做某套方案的标题组，避免"满意就确认 / 不满意就整批重来"
- 自动导演提供四种运行模式：**先准备到可开写**（推荐第一本书）、**全书自动成书**、**按范围执行**（全书 / 前 N 章 / 第 1 卷）、**正文后去 AI 检测与修正**（叠加质量闭环）
- 全自动驾驶模式下遇到模型不可用、配额耗尽、连续修复失败、要求重新规划等情况会主动停下，而不是无限重试；所有状态保存到导演跟进，可从原检查点恢复
- 全自动模式下每批章节完成后自动确认 pending 候选角色，角色进入正式名册并触发动态重建，消除后续章节角色一致性漂移
- 链路覆盖书级方向、故事宏观规划、本书世界、角色准备、卷战略 / 卷骨架、节奏板、章节清单、章节细化、章节执行、审核、修复，每一阶段都支持检查点恢复、接管和换模型重试

### 8. Creative Hub 与 Agent Runtime

- 统一创作中枢承载对话、追问、规划、工具调用、任务状态和回合总结，不再是分散的功能按钮
- 系统内有明确的 Planner、Tool Registry、Runtime、审批节点、状态卡片和中断恢复链路；自然语言意图会被路由到对应的自动导演阶段或章节任务
- 浏览器暂停通知：到达 checkpoint 时弹出系统通知，长链路任务挂机更安心

### 9. 整本生产主链与章节执行

- 单章运行时、章节执行和整本批量 pipeline 收敛到同一条主链
- 章节生成上下文按本章参与者精准筛选角色资源账本，避免把全部角色塞进 prompt；高风险已入账与待确认提案分别走不同审计代码，正文不会把待确认资源写成既成事实
- 章节执行链覆盖正文生成、AI 审核、可修复问题处理、质量债务记录、角色状态 / 事实 / 伏笔回灌、下一章入口
- LLM 限速器修复内存泄漏：provider 配置变更时淘汰旧限速器，长期运行内存稳定

### 10. 拆书工作台与角色形象演变

- 拆书角色档案分**简要 / 标准 / 深入 / 完整**四档，深入和完整档案会回溯原文片段补全维度
- **角色形象演变**：按 25% / 50% / 75% / 100% 覆盖率增量扫描出场章节，沉淀每章外貌、服装、状态和场景锚点，并基于章节快照生成同一角色阶段形象图；提取的短外貌词条放入待确认区，勾选后融合到角色档案
- 章节形象图可引用角色基础形象图，保持脸型 / 发型 / 标志细节一致
- 拆书还提供双栏阅读、章节证据回溯、范围定向分析、token 预算守卫、稿件诊断模式

### 11. 本书世界、角色、知识库联动 + RAG

- 世界观从大段设定文本升级为可生成 / 复用 / 同步的本书世界；地图、势力图谱会进入章节上下文
- 拆书结果和知识库文档通过 RAG 回灌到规划、续写和正文生成
- RAG 索引流式并行：Embedding 与 Qdrant 写入并发可调；拆书产物入 facets 索引让召回包含拆书结论；chunk hash 去重防止重建产生重复向量；retrieval trace 后端可追踪召回为什么命中

### 12. 漫画与短剧衍生工坊

- **漫画工作台**：场景一致性、角色视觉资产、视觉锚点控制；分镜与角色面板支持图像生成确认弹窗，避免误触消耗额度
- **短剧改编生产管线 v3**：从小说内容衍生短剧剧本和镜头
- 衍生工坊不在主链跑通前打开——它们消费的是小说已生成的章节、角色和场景

### 13. 公开介绍站与文档体系

- GitHub Pages **公开介绍站**（端口 4173）展示主链、产品截图、文档入口与下载链接
- 文档站提供本地全文搜索、面包屑、文内目录、上 / 下一篇导航、tip / warn / checkpoint 提示块、GFM 表格
- 33 篇公开文档：项目介绍、安装与准备、常见问题、故障排查、第一本小说实操路径、按阶段恢复手册、端到端生产链、自动导演阶段全景、章节执行链、知识与 RAG 召回链 + 模块说明
- 模块文档配套真实产品截图；自动导演阶段名用中文表达，技术别名对照表保留在自动导演阶段全景文末供开发者查阅

### 14. 模型路由与本地运行

- 支持 OpenAI、DeepSeek、SiliconFlow、xAI 等多提供商；规划、正文、审阅、拆书等链路可按任务拆开路由
- 当前开发口径优先使用 PostgreSQL 作为主事实源；Qdrant 只作为语义索引服务
- RAG 并发数、限速等运行时参数从 .env 迁到设置面板，改完即生效无需重启
- Monorepo 拆分（pnpm workspace），桌面版 / 介绍站 / 服务端 / 客户端独立可构建


## 典型使用路径

1. 打开 `AI 工作台`，选择从零开书、导入续写、指定位置续写、大纲续写或风格续写。
2. 如果是从零开始，输入灵感并选择需要的题材 Skills，先生成书设、角色、世界观、前 20 章大纲和样稿。
3. 如果是续写/仿写，先导入参考语料到 Reference Corpus，检查实体、时间线、伏笔和风格候选是否被正确抽取。
4. 进入 `StoryState`、`章节树`、`人物图谱`、`时间线`、`伏笔`、`风格` 和 `Skills` 标签，确认长文上下文是否稳定。
5. 手动设置批量生成范围和章节数量，让 AI 连续推进；遇到 ReviewGate 高风险或 StatePatch 关键变更时，由人类确认。
6. 需要更完整的开书流程时，再进入原有自动导演链路，逐步完成项目设定、故事宏观规划、本书世界、角色准备、卷战略和拆章。
7. 生成后通过 ReviewGate、StatePatch、质量债和模型调用面板复盘质量、成本和可恢复 checkpoint。

## 当前长篇生成能力支撑图

![当前长篇生成能力支撑图](./images/流程图.svg?v=1)

- 开书定盘负责先把这本书“要写成什么样”说清楚，避免后面越写越散。
- 整本控制层和卷级规划层负责把长篇拆成可推进、可回看、可调整的结构，而不是一次性写死。
- 角色、世界观、写法、知识库和质量控制一起托住单章生成，让每一章都尽量还在同一本书里。
- 每写完一章，系统都会把新状态回灌回去，继续影响后续章节、卷级节奏和必要时的重规划。

## 最新更新

完整历史更新见 [docs/releases/release-notes.md](./docs/releases/release-notes.md)。

### 2026-07-29

- 新增 AI Workbench 本地开发版：统一展示生产链、StoryState、章节树、人物关系图、时间线、伏笔、风格、Skills、模型调用、ReviewGate、StatePatch、批量任务和 checkpoint。
- 新增 Reference Corpus 导入续写能力：支持直接续写、指定位置续写、大纲续写、风格续写，并展示召回片段与使用原因。
- 新增 Skills 注册与项目启用机制，支持本地内置 Skills、目录式 Skill 包、冲突检查、Writer prompt hook 和 ReviewGate Skill 检查。
- 新增风格学习与 Style Lab 闭环：样章生成 StyleProfile，按风格试写，并由 Reviewer 输出偏离检测报告。
- 当前 Workbench 开发口径以 PostgreSQL 为主事实源，Qdrant 只作为语义索引。

### 2026-07-17

- 左侧导航菜单会在固定高度内独立滚动，窗口高度较小时也可以访问底部的系统入口。
- README 在桌面版入口后直接展示 [Ani Book Skill](https://github.com/ExplosiveCoderflome/ani-book-skill)，方便想在 Codex 本地工作区里直接推进长篇中文小说的人选择适合自己的创作入口。

> 查看完整更新历史：[docs/releases/release-notes.md](./docs/releases/release-notes.md)

## 功能预览
### 功能概览中的95%以上编写都是AI完成

下面这组截图优先展示当前版本正在使用的单书工作流：从自动导演开书，到项目设定、故事宏观规划、角色准备、卷战略、节奏拆章、章节执行，再到质量修复，已经开始收成一条连续推进链，而不是一组彼此割裂的演示页。

### AI Workbench

AI Workbench 是当前新增的自动小说生成系统入口，路径为 `/ai-workbench`。它把从零开书、导入续写、风格续写、批量生成、StoryState、Skills、ReviewGate、StatePatch、模型调用和 checkpoint 放在一个页面中，方便开发者检查 AI 是否真的按“规划 -> 上下文 -> 写作 -> 审校 -> 状态回灌”的链路执行。

当前工作台更偏本地开发与验收界面：重点不是做一个简化聊天框，而是把长文生成中最容易失控的部分可视化，包括旧章节召回、人物关系、时间线、伏笔、风格画像、质量债、人工确认点和批量任务恢复。

### 提示词编辑器

提示词编辑器用于调试和维护产品级 AI 任务的提示词资产。正文生成提示词支持本书范围的高级模板编辑，可以用可视化引用标签插入书级合约、章节任务、角色事实、时间线、运行变量和槽位规则，并通过预览检查最终 messages 与上下文注入结果；需要验证效果时，也可以选择模型直接测试当前草稿产出。

![提示词编辑器](./images/ScreenShot_2026-07-08_140153_328.png)

### Creative Hub

统一承载对话、规划、工具执行和创作推进的创作中枢。

![创作中枢](./images/创作中枢.png)

### 自动导演模式

自动导演创建页现在会把一句灵感、导演起始参数、书级 framing、模型设置和运行方式收进同一面板；进入方向选择后，不只是给你两套整本方案，还会配套书名组选项、推荐理由和定向重做入口，适合先把这本书“该怎么开”定下来。

![自动导演创建](./images/导演模式-创建.png)

![自动导演选择方向](./images/导演模式-选择方向.png)

![自动导演执行中](./images/导演模式-创建中.png)

![自动导演交接与继续执行](./images/导演模式-编辑.png)

### 项目设定

项目设定已经挂到单书工作台的连续流程里：左侧能直接看到当前步骤与整体进度，上方能看到 AI 接管状态，正文区则集中处理标题、简介、书级 framing、写法确认和本书真正会用到的世界边界。

![项目设定](./images/write/项目设定.png)

### 故事宏观规划

故事宏观规划不再只是大段摘要，而是先把故事引擎、推进与兑现摘要、长期对立和前 30 章承诺压成后续可继承的书级引导层，先保证整本主线能推，再把卷级和章节级规划建在这套底盘上。

![故事宏观规划](./images/write/故事宏观规划.png)

### 角色准备

角色准备页现在更像角色工作台而不是角色表单：会先盘点目标区段的核心角色，再给出 AI 阵容方案、结构关系网和动态角色系统，减少开书后角色断档、功能位缺失和关系推进失速。

![角色准备](./images/write/角色准备.png)

### 卷战略 / 卷骨架

卷战略阶段已经开始显式区分“卷战略、卷骨架、节奏板、拆章节”四个阶段完成度。系统会先判断当前是不是已经具备继续推进条件，再生成卷战略建议、审查卷骨架，并把版本控制与影响分析收进同一页。

![卷战略 / 卷骨架](./images/write/卷战略.png)

### 节奏 / 拆章

节奏 / 拆章现在把节奏段列表、批量细化、单章标题、摘要、章节目标和任务单放进同一工作区；可以按当前可见章节或指定范围连续细化，也可以对摘要和目标做局部 AI 修正，更适合连载网文式的持续推进。

![节奏 / 拆章](./images/write/节奏拆章.png)

### 章节执行

章节执行页现在更像主写作工作台：左侧是章节卡片与下一步状态，中间是已保存正文和版本区，右侧则把执行计划、正文写作、审核、修复、状态同步和伏笔回填收在同一套动作面板里，适合逐章推进。

![章节执行](./images/write/章节执行.png)

### 质量修复

质量修复已经从零散按钮收成独立工作台：可以围绕当前章节执行审核、执行修复、生成钩子，并结合当前批次、质量阈值和 AI 输出继续往后处理，适合把“写完之后怎么稳住质量”也纳入主流程。

![质量修复](./images/write/质量修复.png)

### 正文修改

当一章已经写出正文后，还可以进入独立正文编辑器继续局部改写。正文修改页会把任务单、审计结果和修复链路继续挂在这章身上，避免用户在“主写作区”和“精修区”之间断掉上下文。

![正文修改](./images/正文修改.jpeg)

### 小说列表

从这里进入开书、管理、编辑和整本生产。

![小说列表](./images/小说列表.png)

### 拆书分析

拆书分析已经不只是生成一篇读后感：可选快速 / 标准 / 完整三档拆书，覆盖题材定位、剧情结构、人物系统、世界设定和写法技法；角色档案支持简要 / 标准 / 深入 / 完整四档深度，还能按 25% / 50% / 75% / 100% 覆盖率对角色做形象演变的增量扫描，生成跨章节一致的参考图。拆书结论可以直接发布到知识库、一键转成写法资产，或把角色升格进基础角色库，让“拆一本书”变成后续创作能反复调用的长期资产，而不是看完就忘的一次性笔记。

![拆书分析](./images/拆书.png)

### 知识库

统一管理文档、索引、重建任务和检索能力。

![知识库](./images/知识库.png)

### 世界观

世界观不再只是描述文本，而是能生成世界骨架、维护世界手册，并绑定为每本小说自己的本书世界上下文。

![世界观](./images/世界观.png)

### 角色库

统一维护角色基础档案与小说内角色信息。

![角色库](./images/角色库.png)

### 类型管理

集中维护题材与类型资产，让故事规划、角色准备和正文生成共享同一套题材语言。

![类型管理](./images/类型管理.jpeg)

### 流派管理

把推进模式、兑现方式和冲突边界收成可复用的流派模式资产，让整本书更容易保持读者预期。

![流派管理](./images/流派管理.jpeg)

### 标题工坊

批量生成、筛选和微调书名与标题方向，降低新手在开书命名阶段的试错成本。

![标题工坊](./images/标题工坊.jpeg)

### 写法引擎与反 AI 规则

统一管理写法资产、风格约束和反 AI 规则，让正文更像作品本身，而不是模板式补全文本。

![写法引擎与反 AI 规则](./images/写法引擎与反AI规则.jpeg)
![配置写法引擎的效果](./images/ScreenShot_2026-04-22_154855_026.png)

### 任务中心

查看拆书、知识库重建和其他后台任务的排队、执行与失败状态。

![任务中心](./images/任务中心.png)

### 模型配置

为不同能力配置不同模型，减少一套模型硬吃所有任务的成本。

![模型配置](./images/模型配置.png)

## 快速开始

### 环境要求

- Node.js `^20.19.0 || ^22.12.0 || >=24.0.0`
  推荐直接使用 `20.19.x LTS`
- pnpm `>= 10.6`
  推荐直接使用仓库声明的 `pnpm@10.6.0`
- PostgreSQL
  当前 AI Workbench 开发口径使用 Postgres 作为主事实源
- 至少一组 OpenAI-compatible LLM API Key
  用于从零开书、续写、风格试写和 ReviewGate
- 如果要完整体验 Reference Corpus / RAG / 导入续写，再额外准备 Qdrant 和 Embedding API Key

### 1. 安装依赖

```bash
pnpm install
```

默认的 `pnpm install` 现在只准备 Web / Server 开发所需依赖，不会在首次安装时强制下载 Electron 桌面运行时。

- 如果你只是运行现有 Web / Server 开发流，到这里就够了
- 如果你要启动桌面端开发壳，首次运行 `pnpm dev:desktop` 时会自动补拉 Electron 运行时
- 如果你想提前完成这一步，也可以手动执行：

```bash
pnpm run prepare:desktop-runtime
```

桌面端运行时首次下载需要可访问 Electron 分发源的网络环境；如果你所在网络无法访问 GitHub Releases，建议先配置代理或镜像后再执行桌面端命令。

如果你在 Windows 上执行 `pnpm install` 时卡在 `prisma preinstall`，通常先检查这两类问题：

1. Node 版本过低
   Prisma 7 目前要求 Node `^20.19.0 || ^22.12.0 || >=24.0.0`。如果你还在 `20.0 ~ 20.18`，建议先升级到 `20.19.x LTS` 再安装。
2. `script-shell` 被配置成了交互式 shell
   如果全局 `npm/pnpm script-shell` 被设成了 `cmd.exe /k` 之类会保留提示符的形式，Prisma 的 lifecycle script 可能不会自动退出，看起来就像安装“卡死”在：
   `node_modules/.../prisma>`

可以先运行下面几条命令自查：

```bash
node -v
pnpm config get script-shell
npm config get script-shell
```

如果 `script-shell` 返回的是带 `/k` 的 `cmd.exe`，建议删除这项配置后重新打开终端：

```bash
npm config delete script-shell
pnpm config delete script-shell
```

然后重新执行：

```bash
pnpm install
```

### 2. 配置环境变量

这个仓库通过 pnpm workspace 分别启动前后端，所以环境变量也是按子包读取的：

- 服务端运行在 `server/` 工作目录，默认读取 `server/.env`
- 前端运行在 `client/` 工作目录，默认读取 `client/.env` / `client/.env.local`
- 根目录 `.env.example` 目前更适合当“总览参考”，不是 `pnpm dev` 默认读取的主入口

#### 2.1 服务端环境变量

先复制服务端示例文件：

```bash
# macOS / Linux
cp server/.env.example server/.env

# Windows PowerShell
Copy-Item server/.env.example server/.env
```

最少建议先确认这些项目：

- `AUTH_USERNAME`、`AUTH_PASSWORD_HASH`、`AUTH_SESSION_SECRET`
  Web 工作台登录凭据。先运行 `pnpm auth:hash-password` 生成密码哈希，再用 `openssl rand -base64 48` 生成独立的会话密钥；不要把明文密码写进环境变量
- `AI_NOVEL_DATABASE_MODE=postgresql`
  当前 Workbench 推荐固定使用 PostgreSQL
- `DATABASE_URL`
  指向本机 Postgres，例如 `postgresql://postgres:postgres@127.0.0.1:5432/ai_novel`
- `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`
  用于主模型调用；兼容 OpenAI 协议的网关也可以使用
- `EMBEDDING_PROVIDER`、`EMBEDDING_MODEL`
  用于 Reference Corpus 和 RAG 索引
- `QDRANT_URL`、`QDRANT_API_KEY`
  只有要启用 Qdrant / RAG 时才需要

注意：

- 除健康检查和登录接口外，所有 API 默认都要求有效登录会话；连续 5 次登录失败会锁定该来源 15 分钟
- 登录会话使用 `HttpOnly` Cookie，生产环境必须通过 HTTPS 访问；`CORS_ORIGIN` 只保留实际使用的前端地址
- `OPENAI_API_KEY`、`QWEN_API_KEY`、`DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY` 这类变量只写入本地 `server/.env`，不要提交到仓库
- 项目启动后，也可以在页面中配置模型供应商和默认模型

#### 2.2 前端环境变量

大多数本地开发场景，其实不需要单独创建前端 env。

因为前端开发模式下默认会把 API 指到：

```text
http(s)://当前页面 hostname:3000/api
```

这也包括“同一台机器启动服务，然后用局域网 IP 在别的设备上访问”的场景。
例如页面开在 `http://192.168.0.37:5173`，前端默认会自动把 API 指到：

```text
http://192.168.0.37:3000/api
```

只有在这些场景下，才建议创建 `client/.env`：

- 前端和后端不在同一台机器
- 你想把前端显式指向别的 API 地址
- 你需要固定 `VITE_API_BASE_URL`

如果你已经复制了 `client/.env.example`，又发现浏览器请求都跑到了 `http://localhost:3000/api`，通常就是因为你把 API 显式固定死了。对同机 / 局域网访问，建议直接删除或注释掉 `VITE_API_BASE_URL`。

示例：

```bash
# macOS / Linux
cp client/.env.example client/.env

# Windows PowerShell
Copy-Item client/.env.example client/.env
```

内容通常只需要：

```env
# 同机 / 局域网访问时，通常不需要这一行
# VITE_API_BASE_URL=http://localhost:3000/api
```

#### 2.3 模型供应商并不一定要写死在 env

当前项目已经支持在页面里配置模型相关设置：

- `/settings`
  配置供应商 API Key、默认模型、连通性测试
- `/settings/model-routes`
  给不同任务分配不同 provider / model
- `/knowledge?tab=settings`
  配置 Embedding provider、Embedding model、集合命名和自动重建策略

所以环境变量里的 `OPENAI_MODEL`、`DEEPSEEK_MODEL`、`EMBEDDING_MODEL` 等，更适合当作：

- 启动默认值
- 数据库里还没保存设置时的回退值

### 3. 启动开发环境

首次使用 Postgres 时，先创建数据库：

```bash
createdb ai_novel
```

如果你希望用迁移链初始化空库，可以执行：

```bash
AI_NOVEL_DATABASE_MODE=postgresql \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/ai_novel \
pnpm --filter @ai-novel/server prisma:deploy
```

开发模式也会在服务端启动时自动执行 Prisma generate / db push，用于让本地 schema 保持可运行。

```bash
pnpm dev
```

如果你已经复制好了 `server/.env` 和 `client/.env`，并且 Postgres 数据库已创建，默认就是直接运行这一条。
开发脚本会自动执行 Prisma generate / db push；如果你需要严格使用迁移链初始化空库，可以在启动前手动执行上面的 `prisma:deploy`。

默认情况下：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`
- API：`http://localhost:3000/api`
- AI Workbench：`http://localhost:5173/ai-workbench`

建议第一次启动后先做这几步：

1. 打开 `http://localhost:5173/settings`，至少配置一组可用的模型供应商 API Key
2. 打开 `http://localhost:5173/settings/model-routes`，检查各任务实际使用的模型路由
3. 如果要启用导入续写 / RAG，打开 `http://localhost:5173/knowledge?tab=settings`，保存 Embedding / Collection 设置
4. 打开 `http://localhost:5173/ai-workbench`，选择从零开书、导入续写、风格试写或批量生成

### 4. 如果你使用 Qdrant Cloud

如果你只是先体验主流程，其实可以先跳过 Qdrant，直接在 `server/.env` 里设：

```env
RAG_ENABLED=false
```

如果你要启用 Qdrant Cloud，可以按下面的最小流程来：

1. 到 [Qdrant Cloud](https://cloud.qdrant.io/) 注册账号。
2. 在 `Clusters` 页面创建一个集群。
   测试阶段用 Free cluster 就够了。
3. 集群创建完成后，到集群详情页复制 Cluster URL。
4. 在集群详情页的 `API Keys` 中创建并复制一个 Database API Key。
   这个 key 创建后通常只展示一次，建议立即保存。
5. 把它们写入 `server/.env`：

```env
QDRANT_URL=https://your-cluster.region.cloud.qdrant.io:6333
QDRANT_API_KEY=your_database_api_key
```

6. 启动项目后，再去 `知识库 -> 向量设置` 页面选择 Embedding provider / model，并保存集合设置。

对这个项目来说，`QDRANT_URL` 建议直接填 REST 地址，也就是带 `:6333` 的地址。

如果你想手动验证连通性，可以用：

```bash
curl -X GET "https://your-cluster.region.cloud.qdrant.io:6333" \
  --header "api-key: your_database_api_key"
```

你也可以把集群地址后面拼上 `:6333/dashboard` 打开 Qdrant Web UI。

Qdrant 官方文档：

- [Create a Cluster](https://qdrant.tech/documentation/cloud/create-cluster/)
- [Database Authentication in Qdrant Managed Cloud](https://qdrant.tech/documentation/cloud/authentication/)
- [Cloud Quickstart](https://qdrant.tech/documentation/cloud/quickstart-cloud/)

### 5. 可选初始化

下面这些都不是首次启动 `pnpm dev` 的前置步骤：

```bash
pnpm db:seed
pnpm db:studio
```

## 常用命令

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
# 初始化或更新 Postgres 空库
pnpm --filter @ai-novel/server prisma:deploy
# 仅在你开发/调整 Prisma schema 时再手动使用
pnpm db:migrate
pnpm db:seed
pnpm db:studio
pnpm --filter @ai-novel/server test
pnpm --filter @ai-novel/server test:routes
pnpm --filter @ai-novel/server test:book-analysis
```

## 技术栈与架构

### 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19、Vite、React Router、TanStack Query、Plate |
| 后端 | Express 5、Prisma、Zod |
| AI 编排 | LangChain、LangGraph |
| 数据库 | PostgreSQL（当前 Workbench 主事实源）、SQLite（兼容开发模式） |
| RAG | Qdrant、Reference Corpus、Embedding 检索 |
| 工程形态 | pnpm workspace Monorepo |

### Monorepo 结构

```text
client/   React + Vite 前端，包括 AI Workbench 页面
server/   Express + Prisma + Agent Runtime + Creative Hub + Workbench 服务
shared/   前后端共享类型与协议
skills/   本地内置 Skills 和目录式 Skill 包入口
images/   README 与产品预览截图
scripts/  启动和辅助脚本
docs/     设计文档、开发说明、模块计划与历史归档
```

更细的文档分区说明可以看 [docs/README.md](./docs/README.md)。

### 当前系统关注点

- `AI Workbench` 负责从零开书、导入续写、批量生成、风格试写和生产链可观察性
- `StoryState` 负责长文一致性聚合，包括章节树、人物关系、时间线、伏笔、质量债和冲突检查
- `Reference Corpus` 负责导入样章/旧稿后的结构化抽取、语义索引和续写召回
- `Skills` 负责题材、风格和写作能力插件化，并参与 Writer prompt hook 与 ReviewGate 检查
- `Creative Hub / Novel Production` 负责原有自动导演、整本生产主链和章节执行
- `Style Engine` 负责写法资产、StyleProfile、风格试写、偏离检测和反 AI 协同

## 当前优化方向

当前重点是把“写得稳、前后一致、可控”落实到本地 Web 工作台，而不是继续堆彼此割裂的生成按钮。

- 稳定 AI Workbench 的从零开书、导入续写、批量生成、风险暂停和恢复闭环
- 强化 Reference Corpus 召回质量，让续写能明确引用旧章节、样章风格、时间线和伏笔
- 扩展 Skills 体系，让不同中文网文方向可以作为可启用、可审计、可冲突检查的能力包
- 提高 StoryState 的一致性检查覆盖率，把人物、时间线、伏笔、设定和资源状态都纳入生成前检查
- 持续优化 Style Lab 和写法引擎，让仿写/风格模仿能被试写、检测、对比和修正

## 交流反馈

如果你想反馈问题、交流使用体验，或者讨论自动导演、整本生产主链、写法引擎等方向，可以扫码加入 QQ 群。

![QQ 群二维码](./images/群2.png)

## 贡献方式

如果你想参与这个项目，最有价值的贡献方向包括：

- 提升整本生产稳定性
- 改善新手开书体验和自动导演成功率
- 强化写法引擎、知识库回灌和世界观一致性链路
- 补充测试、错误回放和运行时可观察性

欢迎直接提 Issue 或 Pull Request。
提交 Pull Request 即表示你确认自己有权提交该内容，并已阅读且同意 [CLA.md](./CLA.md)；如果包含第三方代码、素材、AI 生成内容或其他受许可证约束的内容，请在 PR 中明确说明来源和许可证。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 致谢

感谢提交修复 Pull Request 的贡献者 [@ystyleb](https://github.com/ystyleb)。


## 说明

- 这是一个持续快速迭代中的 AI Native 创作系统，功能边界仍在演化。
- README 优先描述当前最值得体验、最能代表方向的能力，而不是列出全部历史实现细节。
- 如果你更关心阶段目标、优先级和后续优化计划，请直接查看 [TASK.md](./TASK.md)。

## License

本项目采用双许可证授权模式：

- 默认情况下，本项目基于 GNU Affero General Public License v3.0 (AGPLv3) 授权，详见 [LICENSE](./LICENSE)；归属与附加说明见 [NOTICE](./NOTICE)。
- 服务型商用：将本项目（或其修改版本）作为后端以 SaaS、托管或其他形式向第三方提供服务，须通过作者获取商业授权许可。
- 请遵守开源协议条款，并在适用场景下取得相应授权。

贡献说明：新贡献默认按 [CLA.md](./CLA.md) 提交，可随项目按 AGPL-3.0-only 分发，并可纳入项目维护者另行提供的商业授权；详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
