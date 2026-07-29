# 本地 AI 小说工作台开发说明

本说明对应 `自动小说生成系统开发方案.md` 的工作包 A-J 的当前本地进度：底座接入、可观察执行底座、四角色执行层、Reference Corpus、从零开书、导入续写、风格学习、Skills 注册、ReviewGate/StatePatch 记录、StoryState 运行时聚合和全量可视化可用版。

## 目标口径

- 本地 Web 开发模式运行原 AI-Novel-Writing-Assistant UI。
- Postgres 作为唯一主事实源。
- Qdrant 只作为语义索引服务。
- OpenAI 作为第一模型接口，key 由本机 `.env` 配置。

## 环境

- Node.js：项目要求 `^20.19.0 || ^22.12.0 || >=24.0.0`。
- pnpm：项目要求 `>=10.6.0`。
- Postgres：本机已使用 `postgresql://shiro@127.0.0.1:5432/ai_novel` 跑通。
- Qdrant：默认地址 `http://127.0.0.1:6333`。

## 本机配置

`server/.env` 使用本机连接串：

```env
AI_NOVEL_DATABASE_MODE=postgresql
DATABASE_URL=postgresql://shiro@127.0.0.1:5432/ai_novel
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=ai_novel_chunks_v1
OPENAI_BASE_URL=<OpenAI 兼容接口地址>/v1
OPENAI_MODEL=gpt-5.4-mini
EMBEDDING_PROVIDER=qwen
EMBEDDING_MODEL=qwen3.7-text-embedding
EMBEDDING_BATCH_SIZE=20
QWEN_BASE_URL=<Qwen OpenAI-compatible embedding endpoint>/v1
```

`OPENAI_API_KEY` / `QWEN_API_KEY` 不写入仓库。需要生成正文、embedding 或 RAG 入库时，在 `server/.env` 本地填写。当前本机已用 OpenAI 兼容接口和 `gpt-5.4-mini` 跑通真实模型 smoke，并用 Qwen embedding 跑通 RAG 语义索引。

## 初始化数据库

Postgres migration 链已整理为可在空库上直接 `prisma migrate deploy`：早期 SQLite/重复 backfill 迁移保留历史名称但改为 no-op 或幂等补列，后续 PostgreSQL baseline 和增量迁移负责真实结构。开发模式优先使用迁移链初始化，只有在调试历史库差异时才考虑 `prisma:push`。

```bash
createdb -h 127.0.0.1 -U shiro ai_novel
DATABASE_URL=postgresql://shiro@127.0.0.1:5432/ai_novel \
AI_NOVEL_DATABASE_MODE=postgresql \
pnpm --filter @ai-novel/server prisma:deploy
```

已经通过临时空库 `ai_novel_migrate_smoke` 验证 72 个 Postgres migrations 可完整部署，并验证存在以下方案基础表：

- `batch_jobs`
- `checkpoints`
- `model_call_logs`
- `review_gate_results`
- `state_patches`
- `skills`
- `skill_versions`
- `project_skills`
- `reference_corpora`
- `reference_chunks`

## Qdrant

启动 Qdrant 后，现有 `VectorStoreService.ensureCollection()` 会按 embedding 维度创建或校验 `QDRANT_COLLECTION`，并确保 payload indexes。

Docker 可用时：

```bash
docker run --rm -p 6333:6333 -p 6334:6334 qdrant/qdrant:latest
```

若暂时不启动 Qdrant，Web 和基础 Postgres 工作台仍可启动；涉及导入索引、语义召回、RAG 写入的功能会在访问 Qdrant 时失败。

## 启动

```bash
pnpm install
AI_NOVEL_DATABASE_MODE=postgresql \
DATABASE_URL=postgresql://shiro@127.0.0.1:5432/ai_novel \
pnpm dev
```

默认地址：

- Web UI: `http://localhost:5173/`
- AI Workbench: `http://localhost:5173/ai-workbench`
- API: `http://localhost:3000/api`
- Health: `http://localhost:3000/api/health`

## AI Workbench API

当前新增统一入口：

- `GET /api/ai-workbench/production-chain`
- `GET /api/ai-workbench/story-state?novelId=<id>&chapterOrder=<optional>`
- `GET /api/ai-workbench/continuation-context?novelId=<id>&mode=<direct|position|outline|style>`
- `POST /api/ai-workbench/continuation/generate`
- `POST /api/ai-workbench/from-zero/open-book`
- `POST /api/ai-workbench/from-zero/generate-book`
- `GET/POST/PATCH /api/ai-workbench/batch-jobs`
- `POST /api/ai-workbench/batch-jobs/:id/start`
- `POST /api/ai-workbench/batch-jobs/:id/resume`
- `POST /api/ai-workbench/batch-jobs/:id/cancel`
- `GET /api/ai-workbench/checkpoints`
- `GET/POST /api/ai-workbench/model-call-logs`
- `GET/POST /api/ai-workbench/review-gate-results`
- `GET/POST/PATCH /api/ai-workbench/state-patches`
- `GET/POST /api/ai-workbench/skills`
- `GET/PUT /api/ai-workbench/projects/:novelId/skills`

`story-state` 只从 Postgres 聚合运行时快照，不引入独立 StoryState 数据库。当前返回最新快照、覆盖率、章节树、启用 Skills、StyleProfile、角色/关系、开放冲突、时间线、伏笔/兑现账本、待处理 StatePatch/ReviewGate、质量债，以及以下确定性检查基础：

- 死亡/离场角色再出现
- 同一时间地点冲突
- 伏笔/钩子逾期
- 核心角色缺席
- 时间线倒退
- 资源/道具持有人冲突
- 能力/境界设定冲突
- 主线/伏笔过早兑现
- 重复事件
- Skill 规则冲突

StoryState 还会从当前启用 Skills 与已绑定 StyleProfile 派生 `styleSkillConflicts`：当 Skill 声明 `tone`、`style_contract` 或 `anti_ai_policy` 等风格契约冲突键，且当前小说/卷/章绑定了 StyleProfile 时，运行时快照会给出 Skill × StyleProfile 提示、证据、优先级/强度信息和建议动作。该结果只由 Postgres 中的 `project_skills`、`skills`、`skill_versions`、`style_profiles`、`style_bindings` 聚合生成，不新增表，也不把未绑定的可用 StyleProfile 纳入冲突。

质量债不新增业务表，运行时从 ReviewGate 未通过/需确认结果、待处理 StatePatch、确定性检查问题派生，按 `blocking/error/warning/info` 排序，并在 StoryState 面板集中展示证据、章节、来源和建议动作。

`batch-jobs/:id/start` 使用 `batch_jobs` 驱动 1-5 章顺序执行，每章仍走现有 `ChapterRuntimeCoordinator`，并通过 `createQualityReport` 统一记录 ReviewGate。若 ReviewGate 识别高风险或需要人工确认，任务会进入 `waiting_approval`，`riskPauseRequired=true`，并把证据写入 `riskSummaryJson`；高风险 StatePatch 保持 `needs_confirmation`，低风险 StatePatch 记录为 `auto_accepted`。

`batch-jobs/:id/resume` 在恢复 `waiting_approval` 或 `riskPauseRequired=true` 的批量任务前，会检查同一批次是否仍存在 `status in (proposed, needs_confirmation)` 且 `riskLevel=high` 的 StatePatch。只要仍有未决高风险 Patch，恢复请求会返回 400，要求先在页面接受或拒绝 Patch。

批量生成会把恢复点写入 `checkpoints`：章节完成记录 `batch_progress`，ReviewGate 风险暂停记录 `risk_pause`，运行失败记录 `batch_error`。StatePatch 被接受、拒绝或撤销时会关闭关联 checkpoint；恢复或取消批量任务时也会关闭同一批次未决 checkpoint。生产链页面会展示独立 Checkpoints 面板，批量任务行也会显示最近 checkpoint。

本地 Skills 同步兼容两类来源：仓库根目录 `skills/builtin-skills.json`，以及主方案 §8.3 的目录式 `skills/*/skill.json`。`GET /api/ai-workbench/skills` 和项目 Skills 查询会先把本地 Skill 同步到 Postgres 的 `skills` / `skill_versions`；目录式 Skill 的 `promptHooks` 若指向 `prompts/*.md`，同步时会展开为实际 hook 文本供 Writer/Planner/Reviewer 运行时读取。目录式包里的 `README.md`、`state.schema.json`、`rules/*.md`、`examples/*.md` 会写入 `skills.metadataJson`，用于可审计说明、State schema 冲突检查依据和 Skills 面板展示；不新增独立 Skill 状态库。项目启用/禁用写入 `project_skills`，并按 `conflictKeysJson`、`stateRequirements` 和 `state.schema.json.properties` 做组合冲突检查。冲突检查会在当前项目所有启用 Skills 间双向重算，发现冲突键重叠或 State schema 字段重叠时，相关 `project_skills.conflictStatus=warning` 且 `conflictJson` 记录证据和建议动作。

ReviewGate 会读取当前小说启用的 Skills，将 `reviewGateChecks` 执行为结构化 `executedChecks` 写入 `review_gate_results.evidenceJson.skillReviewGate`；若审校 issue 或 audit issue 命中某个 Skill 检查项，会额外写入 `risksJson` 的 `skill_review_gate_check` 风险。ReviewGate 面板会单独展示每个 Skill 检查项的 `checked/warning/blocking` 状态、命中数和证据。

页面入口 `AI 工作台` 读取以上 API，展示生产链、StoryState、章节树、人物关系图、时间线、伏笔看板、风格分析、批量任务、模型调用、ReviewGate、StatePatch 和 Skills 注册状态。批量任务面板可创建并启动 1-5 章任务，也可对已有任务执行启动、继续、取消；章节树顶部会按书 / 卷 / 章节显示结构摘要、当前章节位置、质量均值和批量生成范围，并提供按钮切到同一生产链里的批量生成入口，不新增第二套批量任务逻辑；模型调用面板从 `model_call_logs` 派生当前列表、今日和当前项目总计的调用数、token、成本、失败数和平均耗时，并复用 `/settings/model-routes` 的任务级模型、temperature、token 上限、结构化 JSON 策略、结构化备用模型和 JSON 修复重试次数配置；StatePatch 面板可对 `proposed` 或 `needs_confirmation` Patch 执行接受或拒绝，作为批量任务恢复前的人类确认闭环，并会按 `reviewGateResultId` 合并展示关联 ReviewGate 的风险证据、必修项、建议动作和“接受/拒绝/撤销”操作项；Skills 面板可对当前小说启用/禁用本地 Skill，并展示冲突状态；StoryState 的启用 Skills 区域会显示 Skill × StyleProfile 冲突提示，供用户在批量推进前确认优先级或风格强度。人物关系图会把角色节点和关系边绘制为可点击图谱，点击节点后展示该角色关联关系、证据章节、证据文本、隐藏张力和阶段摘要，同时保留完整节点/关系边明细。伏笔看板会汇总候选/已埋设/待回收/已回收/超期等状态，并把 `overdue_hook`、`mainline_early_resolution` 等确定性检查作为超期/过早兑现预警投影出来。风格面板会在 StyleProfile 卡片中展示风格强度、学习维度、AI 腔检测规则、分析摘要和样章片段，用于对应 §10.6 的样章对比和风格检测可视化；Style Lab 仍负责试写后的偏离报告。普通章节生成和续写生成的 `GenerationContextPackage` 会保留结构化 `ragReferences`，生产链 AgentRun 面板会直接显示召回来源、chunk、score 和片段，满足“续写和生成时展示检索引用”的一期口径；Qdrant 仍只提供语义索引，片段业务事实来自 Postgres/Qdrant 检索结果投影。

批量任务风险暂停不只展示原始 JSON。批量任务行会从 `riskSummaryJson` 和最新 `checkpoints` 投影出章节、ReviewGate、风险来源、必修项、待处理 StatePatch 和恢复步骤；StatePatch 的接受/拒绝操作仍集中在 StatePatch 面板，恢复动作仍由批量任务行的“继续”按钮触发。

从零开书面板保留两条方案内路径：

- `POST /api/ai-workbench/from-zero/open-book` 创建 AutoDirector 任务，并同步记录 Workbench AgentRun：Planner 已完成任务创建，ContextBuilder / Writer / Reviewer 作为等待候选确认后的委托步骤进入生产链。该入口只做 Workbench 观测包装，不替代 AutoDirector，不复制导演逻辑；Workbench 表单的 provider/model 留空时不会向 seedPayload 注入默认覆盖，手动填写时才作为本次任务覆盖。
- `POST /api/ai-workbench/from-zero/generate-book` 直接生成一期验收样本：结构化 Planner 生成书设、角色、世界观、前 20 章大纲和前三章草稿；Writer 在章节低于 Benchmark A 下限时逐章扩写到 2500-4000 字符；结果落到现有 `novels`、`characters`、`character_relations`、`character_relation_stages`、`style_profiles`、`style_bindings`、`project_skills`、`chapters`、`chapter_summaries`、`plot_beats`、`character_timelines`、`story_timeline_events`、`timeline_hooks`、`payoff_ledger_items`，并通过统一 `createQualityReport` 写入 ReviewGateResult 和 StatePatch。该入口不再把所有新书硬编码为都市悬疑，Planner 会继承用户灵感中的题材、主角身份、核心动机和风格；章节质量检查按题材识别主线/线索推进，Benchmark A 的旧案/记者/家庭秘密只在对应悬疑输入下强化。该入口会为新书创建书级 StyleProfile，并按题材/语气启用内置 Skills；现代都市悬疑基准会启用“悬疑推理 + 冷峻克制 + 去 AI 味”。若 `enqueueIndex=true`，会为 novel、前三章、章节摘要和角色排 RAG 索引任务；Postgres 仍是唯一主事实源，Qdrant 只做语义索引。

结构化 JSON 修复重试次数保存在 `app_settings.structuredFallback.maxRepairAttempts`，范围 0-5，默认 1。它只影响 `invokeStructuredLlmDetailed` 中 JSON 解析失败或 Schema 校验失败后的修复尝试次数，不新增独立模型配置表。

Reference Corpus 导入会生成 `chapter`、`paragraph`、`summary`、`entity_candidate`、`timeline_candidate`、`foreshadow_candidate`、`style_candidate` chunks。`entity_candidate` 汇总角色、地点、势力和物品候选，`timeline_candidate` 汇总导入章节的时间线候选；续写上下文会把它们作为结构化召回来源，Reference Corpus 面板也会把抽取结果拆成实体、时间线、伏笔和风格摘要，便于检查导入文本是否被记对。面板还会从 Postgres 的 `rag_index_jobs` 派生每个语料的最新 RAG 索引任务状态、进度、尝试次数和失败原因；召回测试会展示索引状态、语义命中数、结果数和是否回退到 Postgres 关键词召回，避免在 Qdrant 未就绪或语义未命中时误判为语料缺失。Qdrant 仍只保存语义向量，不作为业务事实源。

导入续写若当前小说尚未有正式角色，生成前会从 Reference Corpus 的角色候选自动创建少量临时角色种子，避免原章节生成流水线因“无角色”阻断；角色种子只写入现有 `characters` 表，并带 `auto_seeded_from_reference_corpus` 禁止项，后续仍由 ReviewGate/StatePatch 校准。角色候选抽取已过滤动作短语、器物短语和方位后缀，避免把“胸牌上”“转身时”“听见沈微”这类噪声写入角色表。

指定位置续写不新增独立数据源，复用 Reference Corpus 的 `chapterIndex` / `paragraphIndex`。`continuation-context` 和 `continuation/generate` 均支持 `positionCorpusId`、`positionChapterIndex`、`positionParagraphIndex`、`positionAnchorText`；前端用 1 起章节/段落输入，提交到 API 时转为 0 起索引。`mode=position` 时，ContextBuilder 会把锚点段落及其前文片段放入 `positionAnchor`，并优先作为 structured recall 展示和写入 AgentRun 元数据。

大纲续写同样复用 Reference Corpus。`mode=outline` 时，ContextBuilder 会从导入章节 chunk、corpus 摘要和伏笔候选中构造 `outlineContext`：最近章节摘要、未解伏笔/冲突候选、下一章 premise、连续性要求和推荐推进重点。生成续写章时，这些内容会写入目标章节 `expectation`，由现有 Writer 流水线读取；若目标章节已有正文，则不会覆盖已有 expectation。

风格续写复用 Reference Corpus 的 `style_candidate` chunk 和当前小说启用的 StyleProfile binding。`mode=style` 时，ContextBuilder 会构造 `styleContext`：语料风格候选、绑定画像摘要、风格强度、写作约束、避坑规则和参考样句。生成续写章时，这些内容会写入目标章节 `expectation`，并记录到 AgentRun metadata，仍由现有 Writer / Reviewer / ReviewGate 流水线处理。

导入续写生成接口 `POST /api/ai-workbench/continuation/generate` 已返回本次章节、AgentRun、ReviewGateResult、StatePatch 列表和 `continuationContext`。续写页会在生成控件下方展示“最近续写结果”，直接投影章节状态、正文长度、来源、重试次数、AgentRun id、ReviewGate 建议动作和本次 StatePatch 的状态/风险/类型，用于对应方案 §14.2 中“是否生成 StatePatch”和“是否进入 ReviewGate”的即时验收证据。完整 StatePatch 接受/拒绝仍在全局 StatePatch 面板闭环。

风格实验室的试写通过 `POST /api/ai-workbench/style-lab/test-write` 包装原 `StyleGenerationService.testWrite`。该入口不新增风格生成系统，只补 Workbench AgentRun：Planner 记录同一剧情/改写目标，ContextBuilder 记录 StyleProfile 编译来源，Writer 记录输出长度、规则数和 maturity，随后 Reviewer 立即执行风格偏离检测并把 `riskScore`、`summary`、`violations`、`appliedRuleIds` 写回同一个 AgentRun。Style Lab 页面展示试写输出、编译提示词和本次 `detectionReport`；偏离报告会投影风险分、偏离点数量、已应用规则数量、是否可自动改写，以及每条偏离的规则类型、来源、类别、规则 ID、片段、原因和建议；同一剧情/同一原文改写会在当前会话内汇总最近试写结果，展示 StyleProfile、强度、目标字数、输出长度、风险分、偏离数、规则数和 AgentRun，满足风格学习 Benchmark 中“Writer 能按 StyleProfile 生成文本”“同一剧情试写对比”和“Reviewer 是否指出偏离点”的可观察证据。

风格实验室的偏离检测通过 `POST /api/ai-workbench/style-lab/detect` 包装原 `StyleDetectionService.check`。该入口不新增风格检测系统，只补 Workbench AgentRun：Planner 记录检测目标，ContextBuilder 记录 StyleProfile/绑定/反 AI 规则来源，Reviewer 写入 riskScore、summary、violations 和 appliedRuleIds。Style Lab 页面仍展示原 `StyleDetectionReport`，同时刷新生产链面板，满足风格学习 Benchmark 中“Reviewer 是否指出偏离点”的可观察证据。

## 主方案 §14 验收矩阵

本节按 `自动小说生成系统开发方案.md` 第 14 节记录当前本机验收证据。证据只引用本地 API 返回的业务 ID、计数和状态，不记录模型网关地址或 API key。

| Benchmark | 主方案要求 | 当前证据 | 状态 |
|---|---|---|---|
| §14.1 从零开书 | 生成书设、角色、世界观、前 20 章大纲、前 3 章；每章 2500-4000 字；每章有钩子；ReviewGate 结构化结果 | 测试小说 `cms4eu1ah00213tu0n1ve97j9` 的从零开书 AgentRun `cms4eu1ao00223tu0up91mfd9` 覆盖 `Planner / ContextBuilder / Writer / Reviewer`；Planner 输出 `outlineChapterCount=20`；Writer 输出 `generatedChapterCount=3`，三章长度 `3080 / 3144 / 2876`，钩子数 `3`；Reviewer 输出 `reviewGateCount=3`、`statePatchCount=3`。 | 已验证 |
| §14.2 导入续写 | 导入 5 章样例并续写第 6 章；记住主角状态、承接结尾、不改核心设定、引用旧章节、生成 StatePatch | Reference Corpus `cms4f58hi008o3tu04hr4ncg3` 有 `chapterChunkCount=5` 且 `latestIndexStatus=succeeded`；召回查询返回 `semanticAvailable=true`、`semanticHitCount=8`、`keywordFallbackUsed=false`；续写 AgentRun `cms4qqnfn000r39u0h43xoakh` 覆盖四角色，ContextBuilder `recallHitCount=18`，Writer `ragReferenceCount=26`、`runtimeRagReferenceCount=8`、`workbenchRecallCount=18`，首条 Workbench 召回为 `reference_corpus / vector`，并生成 1 个关联 StatePatch。 | 已验证 |
| §14.3 风格学习 | 导入 2-3 篇样章，生成结构化 StyleProfile；按风格试写；Reviewer 指出偏离点 | StoryState 返回 `styleProfileCount=6`，当前书级 StyleProfile 学习维度为 `文风语言 / 章节结构 / 节奏爽点 / 去 AI 味`，且有样章/分析预览；生产链中存在 3 条风格学习相关 AgentRun；Style Lab 已通过试写与偏离检测 smoke，Reviewer 输出风险分、偏离点、规则 ID、片段、原因和建议。 | 已验证 |
| §14.4 Skills | 启用“悬疑推理 + 冷峻风格 + 去 AI 味”；ContextBuilder 读取状态要求；Writer 应用 prompt hook；ReviewGate 执行 Skill 检查；UI 显示 Skills 和冲突 | 当前小说启用 3 个项目 Skill：`mystery-deduction`、`cold-restrained-style`、`anti-ai-writing`；项目 Skill 冲突状态为 `ok / warning / warning`；续写 ContextBuilder 输出 `stateRequirementCount=13`、`reviewGateCheckCount=13`；Writer 输出 `appliedSkillPromptHooks.activeSkillCount=3`；Skills 面板已显示启用状态和冲突检查。 | 已验证 |
| §14.5 风险暂停 | ReviewGate 识别高风险；批量任务暂停；人工确认 UI 展示证据和操作项；StatePatch 等待确认 | 当前生产链有 `waiting_approval` AgentRun 3 条；ReviewGate 待人工确认 3 条；未决高风险 StatePatch 3 条，状态为 `needs_confirmation/proposed` 口径；批量恢复接口会在高风险 Patch 未确认时阻断；StatePatch 面板提供接受、拒绝、撤销闭环。 | 已验证 |
| §14.6 可视化 | 同一本测试小说中显示生产链、章节树、人物关系图、时间线、伏笔看板、风格面板、Skills 面板 | StoryState 覆盖状态均为 ready：`chapter_tree=6`、`characters=6`、`relations=5`、`timeline_events=12`、`foreshadow_states=45`、`style_profiles=6`、`active_skills=3`、`state_patches=3`、`review_gate=3`、`quality_debt=18`；Playwright 已验证生产链检索引用 UI 显示 `总计 26`、`Runtime RAG 8`、`Reference Corpus 18`、`vector`、`reference_corpus`。 | 已验证 |

当前仍需保持的回归重点：

- 使用 Codex runtime Node 或满足项目要求的 Node 版本运行服务端 typecheck；系统默认 Node 22.11 会触发 Prisma dev 的 ESM/CJS 兼容报错。
- 模型与 embedding 配置继续只保存在本地 `.env`；提交前继续运行密钥/端点泄漏扫描。
- Qdrant 仍只作为语义索引，验收时优先用 `reference_corpora.latestIndexStatus`、`semanticAvailable`、`keywordFallbackUsed` 和生产链 Writer 引用计数判断 RAG 是否真正生效。

## Prisma provider 注意点

`pnpm --filter @ai-novel/server typecheck` 会执行 `prisma generate`。如果没有显式传入 Postgres 环境变量，Prisma client 可能按 SQLite schema 生成。

`server/scripts/ensure-dev-prisma.cjs` 已补充运行时 provider 探测：即使 stamp 未变化，只要当前生成的 Prisma client 不能用 Postgres adapter 实例化，`pnpm dev` 会重新按 `schema.prisma` 生成 client。

## 已验证

- `AI_NOVEL_DATABASE_MODE=postgresql DATABASE_URL=<local postgres> pnpm --filter @ai-novel/server typecheck`
- `pnpm --filter @ai-novel/server typecheck`
- `pnpm --filter @ai-novel/shared build`
- `pnpm --filter @ai-novel/client typecheck`
- `pnpm --filter @ai-novel/client build`
- `pnpm dev` 可启动 server/client/shared
- `GET /api/health` 返回成功
- 2026-07-28 当前回归：使用 Codex runtime Node 以 Postgres 模式运行 `pnpm --filter @ai-novel/server typecheck` 通过，`pnpm --filter @ai-novel/client typecheck`、`pnpm --filter @ai-novel/shared build`、`pnpm --filter @ai-novel/client build` 均通过；`GET /api/health` 返回 `status=ok`，`GET /api/rag/health` 返回 Qwen embedding 与 Qdrant 均 `ok=true`。
- 公开 API smoke 已验证 §12 OpenAI 与模型路由：`GET /api/llm/model-routes` 返回 `taskTypeCount=11`、`routeCount=11`，11 个任务路由均为 `provider=openai`、`model=gpt-5.4-mini`、`requestProtocol=openai_compatible`、`structuredResponseFormat=json_schema`，且都设置了 `temperature=0.45`、`maxTokens=12000`；`POST /api/llm/model-routes/connectivity` 对 11 个任务的 plain 与 structured 调用均返回 `ok=true`，structured 检测显示 `strategy=json_schema`、`nativeJsonObject=true`、`nativeJsonSchema=true`、`profileFamily=openai`；结构化备用模型接口返回 `enabled=false`、`maxRepairAttempts=1`；生产链模型调用日志能看到真实 `openai / gpt-5.4-mini` 调用、token 与 latency
- 2026-07-28 追加验证：`server/.env` 已接入本机 OpenAI-compatible 网关，`OPENAI_MODEL=gpt-5.4-mini`；`GET /api/health` 返回 `status=ok`，`POST /api/llm/model-routes/connectivity` 对 11 个任务路由均返回 `ok=true`，plain 调用延迟约 1916ms，structured JSON Schema 调用延迟约 1464ms，`requestProtocol=openai_compatible`、`strategy=json_schema`、`nativeJsonObject=true`、`nativeJsonSchema=true`、`profileFamily=openai`。原始接口地址和 API key 仅保存在本机 `.env`，不写入文档。
- 2026-07-28 再验证：本机 `server/.env` 的 OpenAI-compatible 网关配置完整，`OPENAI_BASE_URL` 为有效 URL 且带 `/v1` 后缀，`OPENAI_API_KEY` 已配置，`OPENAI_MODEL=gpt-5.4-mini`；`POST /api/llm/model-routes/connectivity` 返回 11/11 条路由 `ok=true`，plain 和 structured 各 11/11 成功，协议为 `openai_compatible`，结构化策略为 `json_schema`，平均延迟约 1386ms；对 `shared/client/server/docs/skills` 的脱敏扫描未发现原始接口地址或 API key 泄漏。
- 2026-07-28 追加环境限制：本机 Docker Desktop 可启动，但当前未缓存 `qdrant/qdrant:latest`，从 Docker Hub 拉取镜像时返回 registry EOF；因此本轮只验证了基础 Web/Postgres/模型路由，Qdrant 语义索引需待镜像或本地 Qdrant 服务可用后再补充 RAG 入库/召回 smoke。
- 2026-07-28 追加验证工作包 A/D/F 的 RAG 诊断闭环：使用代理从 GitHub release 下载并启动 `Qdrant v1.18.3` macOS arm64 二进制，`GET http://127.0.0.1:6333/healthz` 返回成功；对现有 Reference Corpus 执行 reindex 后，RAG worker 能进入真实索引流程，但当前 OpenAI-compatible 网关 `/v1/models` 未暴露 embedding 模型，`/v1/embeddings` 对 `text-embedding-3-small` 返回 503，导致 `RagIndexJob` 5 次重试后 `failed`，Reference Corpus `latestIndexStatus=failed`，Qdrant collection 仍为空。为避免模型路由全绿但 RAG 不可用的误判，`POST /api/llm/model-routes/connectivity` 已增加 `ragEmbedding` 探针，模型路由页会显示“RAG 向量异常”和 provider/model/错误；Playwright 截图保存到 `output/playwright/model-routes-rag-embedding-connectivity.png`。该验证证明 Qdrant 服务可达和失败诊断可见，但不替代 Qdrant 语义入库/召回成功验收。
- 2026-07-28 追加验证工作包 D/F 的 Reference Corpus 召回可观察性：`POST /api/ai-workbench/reference-corpora/:id/recall` 在语料索引状态为 `idle` 时返回 `latestIndexStatus=idle`、`semanticAvailable=false`、`semanticHitCount=0`、`keywordFallbackUsed=true` 和明确 notice；使用现有语料查询“林澈 Z-17 南桥”命中 5 条 Postgres 关键词 chunk，UI 召回面板会显示“Postgres 关键词回退”及原因。该验证不替代 Qdrant 语义入库验收，只补齐 Qdrant 未就绪时的用户可见状态。
- 2026-07-28 追加验证工作包 A/D/F 的 Qwen embedding 闭环：本地 `server/.env` 和 Postgres `AppSetting` 已切到 `EMBEDDING_PROVIDER=qwen`、`EMBEDDING_MODEL=qwen3.7-text-embedding`，`EMBEDDING_BATCH_SIZE=20` 以符合接口批量上限；`POST /api/llm/model-routes/connectivity` 返回 `ragEmbedding.ok=true`、`vectorSize=1024`，`GET /api/rag/health` 返回 embedding 与 Qdrant 均正常。对现有 Reference Corpus `Benchmark B 导入续写样例` 重新 reindex 后，`reference_corpora.latestIndexStatus=succeeded`、Qdrant `ai_novel_chunks_v1` 写入 22 个 points、`KnowledgeChunk` 记录 22 条 `qwen / qwen3.7-text-embedding` 向量元数据；召回查询“林澈 Z-17 南桥”返回 `semanticAvailable=true`、`semanticHitCount=8`、`keywordFallbackUsed=false`，首条结果来自 `vector`。
- 2026-07-28 追加修正工作包 F / §14.2 的续写召回闭环：`ContinuationGenerationService` 会把 `continuationContext.recallHits` 的 Top 片段写入目标章节 `expectation`，让 Writer 流水线实际获得导入语料的连续性/风格召回约束；Writer AgentRun 输出同时记录 runtime RAG 和 Workbench Reference Corpus recall 的计数与小型样本。生产链 `outputJson` 截断逻辑已改为可解析 JSON 压缩，避免长日志被截断成坏 JSON。真实模型 smoke 生成第 8 章后，`ContextBuilder.recallHitCount=18`，`Writer.ragReferenceCount=26`，其中 `workbenchRecallCount=18`，`workbenchRecallReferences[0].ownerType=reference_corpus`、`source=vector`，ReviewGate 进入 `waiting_approval` 并生成 1 个待确认 StatePatch。
- 2026-07-28 追加验证生产链 UI 的检索引用展示：Playwright 打开 `/ai-workbench`，按小说 `cms4eu1ah00213tu0n1ve97j9` 过滤并切到 `生产链` 标签后，Writer 步骤显示 `检索引用`、`总计 26`、`Runtime RAG 8`、`Reference Corpus 18`，并在引用卡片中展示 `vector`、`reference_corpus` 和语料标题 `Benchmark B 导入续写样例`。这证明 Writer 实际使用的 runtime RAG 与 Workbench Reference Corpus 召回不仅写入 AgentRun，也已进入可视化面板。
- 2026-07-28 追加本地安全修正：`server/src/llm/debugLogging.ts` 不再把具体 `baseURL` 写入控制台或专用 LLM session log，只记录 `baseURLConfigured=true` / `baseURLConfigured: true`。这不改变模型路由或调试开关，只避免本地 OpenAI-compatible 网关地址、Qwen embedding 地址等端点进入日志。服务端 typecheck、模型路由连通和密钥/端点泄漏扫描均通过。
- `GET /api/ai-workbench/production-chain?limit=3` 返回成功
- `GET /api/ai-workbench/story-state?novelId=<id>&limit=10` 返回成功；空小说会显示 `not_enough_data` 覆盖状态
- `GET /api/ai-workbench/story-state` 已验证返回章节树、绑定 StyleProfile、人物关系、时间线事件、伏笔/兑现账本；临时 smoke 数据已清理
- 公开 API smoke 已验证章节树满足 §10.2 的可用字段：`chapterTree[0]` 返回标题、摘要、目标、钩子、生成状态、字数、质量分和连续性分；对应 UI 章节树会在章节标题下展示摘要、目标和钩子；临时 smoke 数据已清理
- Playwright 已补充验证 §10.2 / §14.6 章节树可视化：使用小说 `cms4eu1ah00213tu0n1ve97j9` 和章节号 `6` 打开 `章节树` 标签，页面显示书名 `雨夜旧卷`、卷数、章节数、已有正文数、质量均值、批量生成范围；当前章节位置显示 `未分卷 / 第 6 章`，第 6 章行带 `当前` 标记；点击 `打开批量生成入口` 会切到 `生产链` 标签，并显示现有 `批量生成入口` 表单、1-5 章限制和风险暂停说明；截图保存到 `output/playwright/ai-workbench-chapter-tree-current.png`
- `POST /api/ai-workbench/from-zero/open-book` 已验证可创建 AutoDirector 任务和 Workbench AgentRun：返回 `autoDirectorTaskId`、`agentRunId`，任务进入 `queued`，`currentItemKey=auto_director`；临时 smoke 数据已清理
- 真实模型 smoke 已验证 §14.1 Benchmark A：输入“现代都市悬疑、失业记者、十年前旧案与家庭有关”，使用本地 OpenAI 兼容接口和 `gpt-5.4-mini`，生成 20 章大纲、7 个角色、前 3 章正文；前三章正文长度分别为 3388、3022、3135 字符，均有章末钩子并推进旧案/记者/家庭线索；AgentRun 角色为 Planner、ContextBuilder、Writer、Reviewer；生成 3 条 ReviewGateResult 和 3 条 StatePatch，其中 2 条低风险自动接受、1 条高风险进入人工确认；临时 smoke 数据已清理
- 真实模型 smoke 已验证从零开书产物可被 §14.6 可视化读取：直接生成 1 章验收样本后，生成检查返回 `characterRelationCount=4`、`styleProfileCount=1`、`activeSkillCount=3`、`timelineEventCount=4`、`foreshadowCandidateCount=6`；数据库实际写入 `relationCount=4`、`stageCount=4`、`styleProfileCount=1`、`styleBindingCount=1`、`activeProjectSkillCount=3`、`hookCount=6`、`payoffCount=6`；StoryState 返回 `relationCount=4`、`styleProfileCount=1`、`activeSkillCount=3`、`activeSkillSlugs=mystery-deduction/cold-restrained-style/anti-ai-writing`、`chapterTreeCount=1`、`eventCount=4`、`hookCount=6`、`payoffItemCount=6`、`characterCount=5`，对应人物关系图、风格面板、Skills 面板、章节树、时间线和伏笔看板；临时 smoke 数据已清理
- Playwright 已补充验证 §10.3 / §14.6 人物关系图交互：使用小说 `cms4eu1ah00213tu0n1ve97j9` 打开 `人物图谱` 标签，页面显示 6 个角色节点、5 条可连线关系和 SVG 连线；点击 `林澈` 节点后，选中节点证据面板切换到主角，展示证据章节 `第 7 章` 以及与许照、唐小满、周启山、赵长明、林国平的关系证据、隐藏张力和阶段摘要；截图保存到 `output/playwright/ai-workbench-relationship-graph.png`
- `POST /api/ai-workbench/batch-jobs` 与 `POST /api/ai-workbench/batch-jobs/:id/cancel` 返回成功；临时 smoke 数据已清理
- 真实模型 smoke 已验证 §4.2 批量生成和 §14.5 风险暂停的实际运行链路：在小说 `cms4eu1ah00213tu0n1ve97j9` 临时插入 1 个空白第 7 章，创建 `requestedChapterCount=1` 的 `batch_generation_smoke` 后调用 `POST /api/ai-workbench/batch-jobs/:id/start`；任务从 `queued` 进入 `running`，执行 `generating_chapters` 和 `reviewing` 后到达 `waiting_approval`，`completedChapterCount=1`、`riskPauseRequired=true`、`currentStep=第 7 章触发 ReviewGate 风险暂停`；生产链可见同一 AgentRun 的 `Planner / ContextBuilder / Writer / Reviewer` 四角色步骤，ReviewGate 为 `pass=false`、`recommendedAction=ask_user`、`needsHumanConfirmation=true`，关联 `StatePatch` 数量 1，最新 checkpoint 为 `risk_pause/open` 且 `resumeStep=resolve_pending_state_patch_then_resume_batch`；临时章节、BatchJob、AgentRun、ReviewGate、StatePatch、checkpoint、QualityReport 和章节派生产物已清理为 0
- `POST /api/ai-workbench/batch-jobs/:id/resume` 对未确认 `proposed|needs_confirmation` 高风险 StatePatch 返回阻断；Patch 更新为 `accepted` 后可恢复进入 `queued`；临时 smoke 数据已清理
- `checkpoints` 已完成 Prisma schema、Postgres/sqlite migration、生产链快照和 UI 面板接入；Postgres 空库 `prisma:deploy` 已验证会创建 `checkpoints` 与其他 Workbench 基础表
- 服务层 smoke 已验证 ReviewGate 低风险写入并自动应用 `auto_accepted` StatePatch，且可 `reverted` 恢复章节生命周期；高风险写入 `needs_confirmation` StatePatch，人工 `accepted` 后能应用章节生命周期 Patch；临时 smoke 数据已清理
- 服务层 smoke 已验证 `ReviewGateResult.scoreJson` 写入方案 §3.4 五项评分：`taskFit`、`continuity`、`style`、`readability`、`statePatchSafety`，并保留 `legacyQualityScore`；临时 smoke 数据已清理
- 服务层 smoke 已验证 `mode=outline` 续写上下文可从 5 章 Reference Corpus 生成 `outlineContext`，包含导入章节数、伏笔候选和下一章 premise；临时 smoke 数据已清理
- 服务层 smoke 已验证 `mode=style` 续写上下文可从 Reference Corpus `style_candidate` 和小说级 StyleProfile binding 生成 `styleContext`，包含风格候选、绑定画像和风格强度；临时 smoke 数据已清理
- 公开 API smoke 已验证工作包 F / §6.2-§6.3 的续写上下文多模式可见性：复用小说 `cms4eu1ah00213tu0n1ve97j9` 和语料 `cms4f58hi008o3tu04hr4ncg3`，`mode=position` 返回 `positionAnchor.resolvedChunkId`、锚点前后文长度 93/131、`recallHitCount=15`，首条召回 reason 为“指定位置锚点”；`mode=outline` 返回 `importedChapterCount=5`、`chapterSummaryCount=5`、`unresolvedForeshadowCount=12`、`requiredContinuityCount=3`、`recallHitCount=13`，首条召回 reason 为“大纲续写参考”；`mode=style` 返回 `activeStyleProfileCount=1`、`styleCandidateCount=1`、`styleIntensity=0.85`、`requiredContinuityCount=6`、`avoidPatternCount=3`、`recallHitCount=13`，首条召回 reason 为“风格续写参考”；这证明 UI 所需的召回片段和使用原因均由同一 Reference Corpus/StoryState 派生，不新增数据源
- Playwright 已补充验证工作包 F / §6.3 / §14.2 的续写召回可视化：使用小说 `cms4eu1ah00213tu0n1ve97j9`、章节号 `6` 打开 `续写上下文` 标签，页面显示来源 `Benchmark B 导入续写样例`、续写强约束、13 条 `引用片段与原因`，其中包含第 2-5 章、summary、timeline/entity/foreshadow/style 候选，并逐条展示“使用原因”；最近续写结果区也复用同一卡片显示本次生成实际保存的 `continuationContext.recallHits`，便于确认生成章节引用了哪些旧章节和为什么引用。截图保存到 `output/playwright/ai-workbench-continuation-recall-reasons.png`
- 真实模型 smoke 已验证 §14.2 Benchmark B：导入 5 章 `A17卷宗前五章`，生成第 6 章，模型 `gpt-5.4-mini`；生成内容记得主角 `林序`、延续 `A17卷宗`/`槐安路九号` 设定、接上第 5 章门外脚步/铁柜异响钩子，`continuationContext` 返回 `referenceCorpusCount=1`、`recallHitCount=13`、`outlineImportedChapterCount=5`、`unresolvedForeshadowCount=6`；AgentRun 角色为 Planner、ContextBuilder、Writer、Reviewer；ReviewGateResult 在高风险/必修项存在时返回整体门禁 `pass=false`、`needsHumanConfirmation=true`、`recommendedAction=ask_user`，并在 `evidenceJson` 区分 `qualityPass` 与 `gatePass`；生成 1 个 `riskLevel=high` 且 `status=needs_confirmation` 的 StatePatch；临时 smoke 数据已清理
- 服务层 smoke 已验证 ReviewGate `pass` 语义对齐方案 §3.4：质量分通过但命中“旧案真相揭晓 / 核心设定改变 / 角色死亡”等确定性高风险时，`qualityPass=true`、`gatePass=false`、`ReviewGateResult.pass=false`、`needsHumanConfirmation=true`，StatePatch 保持 `needs_confirmation/high`；临时 smoke 数据已清理
- 服务层 smoke 已验证 Reference Corpus 角色候选过滤：测试文本只保留 `林序`、`沈微`，未再把“胸牌上”“转身时”“听见沈微”写入角色候选；临时 smoke 数据已清理
- 服务层 smoke 已验证 Reference Corpus 导入会生成 `timeline_candidate` chunk，且续写上下文可把它作为结构化召回来源；临时 smoke 数据已清理
- 服务层 smoke 已验证 StoryState `qualityDebt` 可从失败 ReviewGate 和高风险 StatePatch 聚合出阻断质量债；临时 smoke 数据已清理
- Playwright 已补充验证工作包 I / §9 / §14.5 的质量债可操作性：使用小说 `cms4eu1ah00213tu0n1ve97j9`、章节号 `6` 打开 `StoryState` 标签，质量债面板显示 9 项质量债、5 项 blocking，并将来源映射为 `确定性检查`、`StatePatch`、`ReviewGate`、`Skill × StyleProfile`；每项展示 `来源 ID`、类别、章节定位、更新时间、建议动作和证据。高风险 StatePatch 显示“接受或拒绝 Patch”，ReviewGate 待确认显示“人工确认”，伏笔逾期显示“生成前复核”。截图保存到 `output/playwright/ai-workbench-quality-debt-actionability.png`
- 公开 API smoke 已验证 StoryState 确定性检查的 `timeline_regression` 会直接扫描 `story_timeline_events`：当后续章节 `storyDayIndex` 早于前序已确认事件且不是明确回忆/倒叙时，返回 `status=warning`、`coverage=ready`、`totalIssues=1`；临时 smoke 数据已清理
- 公开 API smoke 已验证工作包 I / §9.4 的 10 类确定性检查均能从 Postgres 派生并进入 StoryState 质量债：临时插入带 marker 的角色、时间线事件、伏笔、核心角色分配、开放冲突、资源账本/事件和兑现账本后，`GET /api/ai-workbench/story-state?chapterOrder=6` 返回 `inactive_character_appearance`、`location_time_conflict`、`overdue_hook`、`core_character_absence`、`timeline_regression`、`resource_holder_conflict`、`ability_setting_conflict`、`mainline_early_resolution`、`repeated_event`、`skill_rule_conflict` 全部 `totalIssues>0`，其中阻断项覆盖死亡/离场角色再出现、同一时间地点冲突、伏笔逾期、核心角色缺席和能力设定冲突；`qualityDebt` 中 `source=deterministic_check` 的 category 覆盖全部 10 个检查 key；临时一致性 smoke 数据已清理为 0
- HTTP API smoke 已验证 §10.4 时间线可视化补齐事件摘要和冲突预警：StoryState API 返回 `timeline.events[].summary`；当第 2 章事件 `storyDayIndex=1` 早于第 1 章事件 `storyDayIndex=3` 且不是明确回溯事件时，`timeline_regression` 返回 `status=warning`、`totalIssues=1`，页面时间线卡展示摘要并在右侧汇总 `timeline_*` 确定性检查问题；临时 smoke 数据已清理
- UI 类型检查已验证 §10.5 伏笔看板补齐状态总览和超期预警投影：看板从 `foreshadowStates`、`timeline.hooks`、`payoffItems` 汇总状态，并展示 `overdue_hook` / `mainline_early_resolution` 等确定性检查问题；临时 smoke 数据已清理
- 服务端和客户端类型检查已验证 §10.6 风格面板补齐 AI 腔检测和样章对比投影：StoryState 的 `styleProfiles` 返回 `sourceRefId`、样章片段、分析摘要和反 AI 规则键，UI 在 StyleProfile 卡片中展示规则数、规则键、分析摘要和样章片段；临时 smoke 数据已清理
- `POST /api/ai-workbench/skills` 可注册本地 Skill，测试记录已清理
- 本地内置 Skills 可自动同步：覆盖主方案 §8.5 的 11 个题材 Skills，并补充 Benchmark D 需要的 2 个横向 Skill（`cold-restrained-style`、`anti-ai-writing`）；目录式 `skills/*/skill.json` 也可同步，且 `promptHooks`、`README.md`、`state.schema.json`、`rules/*.md`、`examples/*.md` 已验证会写入 Postgres，Writer 可读取展开后的 hook 文本，Skills 面板可看到目录包资产和 schema 字段；项目 Skill 启用/禁用、conflictKeys 冲突 warning，以及仅由 `state.schema.json.properties` 重叠触发的 State schema 冲突 warning 均已通过 smoke；临时 smoke 数据已清理
- 服务层 smoke 已验证 §14.4 Benchmark D 的“悬疑推理 + 冷峻风格 + 去 AI 味”组合可启用并进入运行时摘要：`activeSkillCount=3`、`stateRequirementCount=13`、`writeHookCount=3`、`reviewGateCheckCount=13`，冲突状态包含 `warning`；临时 smoke 数据已清理
- 服务层 smoke 已验证启用“悬疑推理” Skill 后，ReviewGate 会写入 `skillReviewGate.executedChecks`，命中 `fair_clue` 时生成 `skill_review_gate_check` 高风险并要求人工确认；临时 smoke 数据已清理
- 服务层 smoke 已验证风险暂停批量任务快照会返回 `riskSummaryJson` 和最新 `risk_pause` checkpoint，UI 批量任务行可据此展示风险证据、必修项、待处理 StatePatch 与恢复步骤；StatePatch 面板会继续用同一生产链快照中的 `reviewGateResultId` 投影 ReviewGate 风险证据和必修项，满足 §14.5 “人工确认 UI 展示证据和操作项”；公开 API smoke 已验证 `production-chain` 同时返回关联 ReviewGate 与 `needs_confirmation/high` StatePatch，且 `risksJson`/`requiredFixesJson` 各包含 1 条可投影证据；临时 smoke 数据已清理
- 真实模型 smoke 已验证 Style Lab 试写 Workbench 包装入口，使用本地 OpenAI 兼容接口和 `gpt-5.4-mini`：试写返回 `outputLength=134`、`compiledRuleCount=8`；试写接口会在同一个 AgentRun 内继续执行 Reviewer 风格偏离检测，并返回 `detectionReport` 供 UI 直接展示，AgentRun 角色为 Planner、ContextBuilder、Writer、Reviewer；临时 smoke 数据已清理
- 真实模型 smoke 已验证 Style Lab 偏离检测会记录 Workbench AgentRun，生产链中可看到 Planner、ContextBuilder、Reviewer；本次检测 `riskScore=8`、`violationCount=1`，且在原生 `json_schema` 不兼容时成功降级到 `json_object` 并完成一次 JSON repair；临时 smoke 数据已清理
- 真实模型 smoke 已验证 §14.3 Benchmark C 的样章导入到风格学习闭环：导入 3 段都市悬疑短样章到 Reference Corpus 后生成 StyleProfile，`sourceType=from_text`、`sourceRefId=reference_corpus:<id>`、`analysisMarkdown` 非空、`selectedExtractionPresetKey=imitate`、生成 3 个 extraction preset 和 4 条反 AI 规则键；随后 Style Lab 用该 StyleProfile 对新剧情试写，返回 `outputLength=359`、`appliedRuleCount=8`，并在同一 AgentRun 内给出 Reviewer detection report；另用明显偏离的热血口号文本触发偏离检测，返回 `riskScore=92`、`violationCount=5`，首条高风险证据指向“禁止总结主题”，满足“结构化风格画像、按风格试写、Reviewer 指出偏离位置和原因”的验收口径；临时 corpus、StyleProfile、AgentRun 已清理
- Playwright 已补充验证工作包 G / §7.4 / §10.6 / §14.3 的风格偏离报告可操作性：使用小说 `cms4eu1ah00213tu0n1ve97j9` 和书级 StyleProfile `雨夜旧卷 开书风格画像` 在 Style Lab 运行 300 字短场景试写，页面返回 415 字试写输出、Writer 编译提示词 `structured / 规则 8`，Reviewer 偏离报告显示 `风险 12`、`偏离点 3`、`已应用规则 8`、`可自动改写`，并逐条展示偏离来源、类别、规则 ID、片段、原因和建议；截图保存到 `output/playwright/ai-workbench-style-detection-actionability.png`
- Playwright 已补充验证工作包 G / §7.4 的同一剧情试写对比：使用同一小说和书级 StyleProfile 运行 220 字短场景试写，页面返回 232 字输出、`风险 6`、`偏离 3`、`规则 8`，同一剧情试写对比栏从 `0 条` 更新为 `1 条`，并展示 StyleProfile、强度 80%、目标 220 字、输出 232 字、AgentRun 和试写正文；截图保存到 `output/playwright/ai-workbench-style-same-plot-comparison.png`
- 公开 API smoke 已验证 §14.5 Benchmark E 风险暂停闭环：批量任务可进入 `waiting_approval`，`riskPauseRequired=true`，ReviewGate `pass=false` 且 `needsHumanConfirmation=true`，高风险 StatePatch 保持 `needs_confirmation`；未确认时 `POST /api/ai-workbench/batch-jobs/:id/resume` 返回 400，提示先接受或拒绝高风险 StatePatch；生产链快照可同时看到 batch、ReviewGate、StatePatch；临时 smoke 数据已清理
- Playwright 打开 `/ai-workbench` 可看到 AI Workbench 页面、统计卡、从零开书表单、全量标签页、StoryState 空态和 Skills 注册表；浏览器二进制使用代理安装，Chrome 主体可用，headless shell 下载在本机网络下曾发生 SSL 重试中断，最终 UI 检查使用 headed Chrome for Testing 完成
- Playwright 浏览器级验证已覆盖 §14.6 可视化面板：使用小说 `cms4eu1ah00213tu0n1ve97j9`（4 章、3 条 AgentRun、4 条 ReviewGate、4 条 StatePatch、5 条人物关系、12 条时间线事件、18 条 TimelineHook、21 条 PayoffLedgerItem、3 个启用 Skill），逐项打开并确认 `生产链`、`章节树`、`人物图谱`、`时间线`、`伏笔`、`风格`、`Skills`、`模型调用`、`ReviewGate`、`StatePatch` 标签页均有真实数据渲染；可见 Planner/ContextBuilder/Writer/Reviewer 执行链、章节状态与摘要、人物关系边、时间线事件和预警、伏笔状态总览和超期阻断、StyleProfile AI 腔检测与样章对比、Skill 注册/冲突/目录资产、模型路由与 token 统计、ReviewGate 风险证据和 StatePatch 人工确认操作项；截图已保存到 `output/playwright/ai-workbench-*.png`，浏览器 console warning/error 为 0
