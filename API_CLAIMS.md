# API 声明台账

版本闸门状态：**部分核验**（本机 asar 逐字核验 + 真实组合装配验证）。

- 真实 DSH 桌面运行时：`D:\Application\dsh`，CLI 报告 `0.2.2-rc.3`，`runtime.json` 报告 `desktopVersion: 0.2.2-rc.3`、`node: 24.21.0`。
- 无 DSH 源码 checkout，无法运行 `dsh-api-probe.py`；改用 asar 解包逐字核验关键 API，并用临时 profile 的真实 `--dump-config` 完成组合装配冒烟。
- 实测发现：`import { defineTool } from '@deepseek-ai/dsh-tools'` 从外部插件目录解析失败（技能坑 P19），故走 T4 路径 B：零宿主包依赖，直接 `ctx.tools.register(ToolDefinition)`。

本插件最初参考技能快照 `dsh-v0.2.2-alpha.2 / f3803c969`，当前以本机 `0.2.2-rc.3` 核验结果为准。

| ID | 声明 | 等级 | 状态 | 依据 | 风险/降级 |
| --- | --- | --- | --- | --- | --- |
| C01 | 函数式插件具名导出 `name` / `inject` / `apply`，禁止 default export | S | 未核验 | skill `02-templates.md` T3、`07-conventions.md` | 若 Loader 行为变更，插件可能不加载；先查 DSH 版本发布说明 |
| C02 | `inject: ['tools']` 后可用 `ctx.tools` | S | 未核验 | skill `02-templates.md` T3 | 缺服务会停在 PENDING；用 `dsh --dump-config` 查 |
| C03 | `ctx.tools.register(ToolDefinition)` 裸注册路径 | S | 启动已验证加载入口 | 真实 web profile 启动日志 | 工具参数/输出需在会话中再实测 |
| C04 | 裸注册使用标准 JSON Schema，根 `type:'object'`、`required: []` | S | 部分核验 | skill `02-templates.md` T4 | 若 DSH 校验拒绝，按错误文案调整 |
| C05 | `output.schema: { type: 'string' }` + `render` 返回文本块 | S | 部分核验 | skill `05-pitfalls.md` P19 后改走 T4 | 若渲染异常，改为 object schema 或字符串内容块 |
| C12 | 不 import `@deepseek-ai/dsh-tools` | S | 实测必要 | 启动日志 `Cannot find package '@deepseek-ai/dsh-tools'` | 保持零依赖路径 |
| C06 | `output.render(args, value)` 返回 ContentBlock 数组 | S | 未核验 | skill `03-api-cookbook.md` | 返回文本块最稳 |
| C07 | `ctx.effect` 可注册一次性副作用回收 | M | 未核验 | skill `05-pitfalls.md` P10 | 若不存在，移除 effect 包裹并直接注册 |
| C08 | `ctx.get('systemPrompt')` 可选获取系统提示服务 | M | 未核验 | skill `08-cheatsheet.md` | 已移除启动即注入的系统提示段 |
| C09 | career 预设挂 `dsh-skill-filesystem` 按需加载 skill | M | 未核验（需真机 `--dump-config` + 会话验证） | skill `10c-casebook-services.md` 坑 A2；archify 先例 | `bundledSkillDir` 解析用 `createRequire(baseUrl)`；若挂 preset 不生效，退回顶层 insert 或在 persona 保留摘要 |
| C10 | `cordis.patch.yml` 的 `dsh.bundle.patch` 指向打包补丁 | S | 未核验 | skill `02-templates.md` T3 | 漏了会装上但工具不生效 |
| C13 | `profileContext.cwd` 在桌面端不是用户工作区（是启动目录/profile 目录） | M | 源码 + 用户实测 | 桌面端写到了 C 盘 DSH 目录；`profileContext.cwd` 只是 session header.cwd | **不可**用它定位工作区，已废弃此方案 |
| C14 | 会话工作区来自 `workingDirectory.get(session)` / `ensure(agent, signal)` | M | asar 源码已核验 | `dsh-working-directory/lib/index.js`：`get(session)` 返回会话投影 cwd；`dsh-tool-working-directory` 内置工具用 `exec.agent` + `ctx.workingDirectory.ensure(exec.agent, exec.signal)` | 工具执行时用 `ctx.get('workingDirectory')` + `exec.agent.session`，在调用前注入 io.js |
| C15 | Agent Preset 由 `name:'@deepseek-ai/dsh-agent-preset'` 的 patch 条目注册 | M | 组装已验证 | `--dump-config` 中 `preset-standard/ptc/minimal/cordis` 同构，新增 `preset-career` 后可见 `id: career` | UI 文案 i18n 未核验 |
| C16 | 静态 knowledge base 已移除，运行时知识来自工作区 `knowledge.json` | S | 9/9 测试通过 | `src/knowledge.js` + `test/*.test.js` | 模型须在 explore 传 roles/skills_catalog |
| C17 | 方向简报采集只用公开 API：GitHub 搜索/README、npm 下载（api.npmjs.org）、PyPI 下载（pypistats.org）、GitHub Releases | M | 离线单测通过，联网采集待首次真实调用回归 | `src/public-api.js`（fetchDirectionLibraries / fetchCategoryDemand） | 单源失败记入 failed 不拖垮整批；GitHub 未认证配额 60 次/小时，TOP15 ≈ 3 搜索 + 15 README，同日同方向默认走缓存 |
| C18 | `src/directions.js` 方向目录只是查询入口清单（HITL 四选项 + 搜索词 + 类别代表包），不是静态知识库；排名由本次抓取值计算 | S | 设计约定 | `src/directions.js` + SKILL.md | 搜索词可被 `career_direction_report.queries` 覆盖；类别清单变更随插件版本更新 |
| C19 | 原生弹窗单选工具 `ask_user_question` 由 `@deepseek-ai/dsh-tool-ask-user` 注册（默认 mode=legacy） | M | asar 源码 + 装配已核验 | `dsh-tool-ask-user/src/index.ts`：`defineTool({name:'ask_user_question'})`，`inject=['tools','userQuestions']`；临时 profile `--dump-config` 见 `tool-ask-user` 行且无 PENDING | 需在真实会话中让模型调用一次确认弹窗呈现 |
| C20 | 问答宿主服务与客户端弹窗面板由默认补丁挂载，无需自建 client/React | M | asar 默认补丁逐字核验 | `dsh-base/cordis.patch.yml` 有 `user-questions`；`dsh-web-app/cordis.patch.yml` 有 `ui-user-questions`（`dsh-client-ui-user-questions`） | 若未来默认补丁移除，需在插件 patch 自行 insert 两行 |
| C21 | client UI 组件不收到 `ctx`，通过 `ctx.slots.inject` + `ctx.slots.register` 挂载；组件只收标准 props | S | skill 文档核验 | `04-ui-and-slots.md` §9.4 | 本插件未自建 client，仅记录备用；当前 `ask_user_question` 已满足弹窗需求 |
| C22 | SkillHub 真实公开接口为 `GET https://api.skillhub.cn/api/skills?page&pageSize&sortBy&order&keyword`，响应 `{code:0,data:{skills,total}}`；`www.skillhub.cn` 是网页端，其 `/api/*` 返回 SPA HTML 不是 JSON | M | 实测核验（首页 bundle + 直连） | skillhub.cn 前端 `skill-hub.mt5ocsdm.js` 的 `fetchSkillsPage()`：`Oy="https://api.skillhub.cn"` + `/api/skills?...`；四方向关键词实测各返回 400~4600 条 | 关键词搜索有语义漂移（product→商品图），已用方向词二次相关度重排；接口变更时抓不到会显示样本不足，不编造 |
| C23 | SkillHub 技能热度字段为 `downloads`（周/累计下载），无关卡登录 | S | 实测核验 | 四个方向实测返回 downloads 1~11 万，字段 `name/slug/description_zh/downloads/score` 均存在 | 用户可点链接用 `www.skillhub.cn/skills?keyword=<slug>` 搜索页 |

拿到 DSH 源码路径后，用 DSH 插件开发技能里附带的 `dsh-api-probe.py` 探针脚本核验本机版本 API。

如探针报告 STALE，按报告逐条更新本表与 `index.js`。
