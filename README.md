# dsh-career-mentor

面向高校学生的就业决策纯 DSH 插件。**包内不打包任何静态岗位/技能/资源数据**——所有知识来自实时公开 API、工作区历史与会话中构造的运行时知识。

## 功能

三模式职业导师，按用户处境进入对应模式，不再揉成一条流水线：

- **探索模式**：用户不知道适合什么、不了解岗位 → 构造 3–5 个候选岗位画像与真实职位名，帮用户认识岗位
- **热点模式**：用户选定方向后 → 生成热点简报 `directions.md`（分块 + 卡片式，不堆宽表）：
  - 热门库 / 包 TOP15：名称、用途、Stars、npm/PyPI 周下载、链接（逐条展开）
  - 需求最旺盛的库/包类别：按代表包周下载合计排名，带横向热度条
  - 新工具 vs 新框架分栏：含公司归属、安装/下载地址、最新发行
  - **按该岗位热度排序的 Skill / Plugin 推荐**：SkillHub / Claude Code 按岗位关键词抓取，跨平台按使用量统一降序
- **规划模式**：岗位确认后 → 技能差距诊断 → 绑定 deadline 的路线图 → 资源 → 清单 → 每周复盘重排
- **HITL 弹窗选方向**：用 DSH 原生 `ask_user_question` 弹出岗位方向单选卡片（开发 / 运维 / 测试 / 产品经理），用户点选，不打字、不代选
- 多指标技术热度（GitHub star / PR、PyPI、npm、Maven Central 版本数、StackOverflow、HN 加权）；`radar.md` 只保留**行业风向 + 与你的关系**（已去掉怪异的 Top10 热度总榜）
- 依据实时热度构造运行时岗位/技能知识，写入 `knowledge.json`；包内零静态数据
- 工作区持久化，断网时用最近快照并标注 `stale`

## 项目结构

```text
career-mentor/
├── index.js                 插件入口：注册 14 个工具 + 注入工作区根目录 + 系统提示（HITL 工作流）
├── cordis.patch.yml         DSH bundle 补丁：声明工具插件层与 career 模式预设
├── package.json             npm 包元数据与 dsh.bundle.patch 声明
├── skills/career-mentor/SKILL.md   职业导师决策树与硬规则（career 模式按需加载）
├── API_CLAIMS.md            DSH API 核验台账（版本闸门 + 实测结论）
├── README.md                本文档
├── icon.svg / locale/       市场图标与中英文元数据
│
├── src/                     运行时代码（零构建，直接 Node ESM）
│   ├── core.js              纯算法层：热度打分、契合度、诊断、路线图、Markdown 渲染
│   │                        （无 I/O、无网络，输入全由外部传入，确定性可单测）
│   ├── directions.js        岗位方向目录：HITL 四选项、每方向的 GitHub 搜索词与
│   │                        类别代表包清单（只是查询入口，数据全部来自实时抓取）
│   ├── knowledge.js         运行时知识层：读写工作区 knowledge.json，推导话题/别名/
│   │                        资源链接（替代原来的静态 data/ 目录；不维护历史基线）
│   ├── public-api.js        联网层：多指标热度抓取 + 方向库/包采集 + GitHub Releases
│   │                        平台动向 + 失败容错
│   ├── io.js                持久化层：工作区路径解析与所有文件读写
│   └── tools.js             工具层：14 个 career_* 工具定义与参数校验
│
├── test/
│   ├── core.test.js         算法单测（内联 fixture，不依赖静态数据）
│   └── tools.test.js        工具层离线冒烟：HITL 选方向 → 探索→定岗→诊断→规划→导出→复盘
│
└── workspace-template/
    └── profile.json         首次使用的画像模板（随包携带的唯一 JSON）
```

> 设计要点：**没有 `data/` 目录**。岗位/技能/资源等知识若写死必然过时，因此全部改为运行时来源，见下方数据流。

## 分层与数据流

```text
模型（career 模式，按需加载 skills/career-mentor/SKILL.md）
   │  调用工具
   ▼
tools.js ──► core.js（纯算法）        io.js（读写当前工作区）
   │            ▲                         ▲
   │            │ 运行时知识              │ 快照 / 画像 / 计划
   ├──► knowledge.js ◄─────────────────────┘
   │            ▲
   │            │ roles/skills 由 career_explore 写入
   └──► public-api.js ──► 公开 API（多指标热度 + GitHub Releases 平台动向，不爬网页、不登录）
```

三条典型路径（按用户处境进入其一）：

1. **探索**：`workspace_context` → `explore`（模型构造 roles + skills_catalog 写入 knowledge.json）→ 用户从候选中选 → `set_goal`。
2. **热点**：`workspace_context` → 方向未定时 `ask_user_question` 弹窗点选 → `set_direction` 落盘 → `direction_report` 抓公开数据并生成热点简报（热门库/包 + 需求类别 + 新工具 vs 新框架 + 按岗位热度排序的 Skill/Plugin）。
3. **规划**：岗位已确认 → `diagnose` → `plan`（绑定 deadline）→ `recommend_resources` → `export_checklist` → 每周 `review` 重排。

`refresh_data` / `radar` 作为通用能力按需调用；`radar.md` 只含行业风向与「与你的关系」。

## 安装

```bash
dsh plugin --profile <profile> add .
# 发布到 npm 后：
dsh plugin --profile <profile> add dsh-career-mentor
```

## 切换模式

安装后，在会话输入框的**模式切换器**里选择 **career（职业模式）** 即可让模型以职业导师身份工作。这个模式由 `cordis.patch.yml` 注册的 Agent Preset（`id: career`、`order: 5`）提供；预设内部按用户意图分流到探索 / 热点 / 规划三个模式（单一预设，不占三个切换器选项）。`cordis.patch.yml` 还 insert 了原生 `dsh-tool-ask-user`，用于热点模式的弹窗单选（宿主问答服务与客户端弹窗面板由 base / web-app 默认补丁提供）。

## 工作区

所有历史数据与偏好记录写在**当前工作区根目录**（DSH 会话打开的工作目录）。每次工具调用时从会话的 `workingDirectory.get(session)` 解析真实 cwd（桌面端用户在 UI 里打开的目录），不会写进 DSH 桌面端安装目录或 profile 目录：

```text
profile.json        用户画像、岗位方向（direction）与目标岗位
knowledge.json      会话中构造的运行时岗位/技能知识
snapshots/*.json    多指标技术热度快照
platform-news/*.json  AI 平台动向快照（GitHub Releases）
direction-report/*.json  方向简报原始数据快照（同日缓存复用）
radar.md            技术风向报告（个人画像 + 行业风向 + 与你的关系；已去掉 Top10 热度总榜）
directions.md       热点简报（个人画像 + 热门库/包 TOP15 + 需求类别 + 新工具 vs 新框架 + 按岗位热度排序的 Skill/Plugin + 下一步建议）
plans/*.json        学习路线图
reviews/*.json      周复盘
checklist.md        学习清单（个人画像 + 分阶段表格 + 执行说明）
resources.md        学习资源（按技能排列的表格）
```

用别的位置时可用环境变量覆盖（优先级最高）：

```bash
CAREER_MENTOR_WORKSPACE=/path/to/workspace
```

## 工具

`career_workspace_context`、`career_set_direction`、`career_direction_report`、`career_refresh_data`、`career_platform_news`、`career_explore`、`career_set_goal`、`career_radar`、`career_diagnose`、`career_plan`、`career_recommend_resources`、`career_export_checklist`、`career_review`、`career_skill_plugins`，共 14 个。

其中：

- 热点模式：`ask_user_question`（DSH 原生弹窗工具）+ `career_set_direction` + `career_direction_report`：弹窗点选方向后产出热点简报（热门库/包、需求类别、新工具 vs 新框架、按岗位热度排序的 Skill/Plugin）。
- `career_skill_plugins` 接受 `direction` / `queries`，按岗位关键词跨平台抓取并按热度使用量统一排序。
- `career_explore` 接收模型基于实时热度与运行时岗位画像构造的 `roles` 与 `skills_catalog`，作为唯一的知识入口。

## 数据来源与合规

- 热点简报（热门库/包 + 类别需求 + Skill/Plugin）只访问公开 API：GitHub 仓库搜索与官方 README 接口、npm 下载统计（api.npmjs.org）、PyPI 下载统计（pypistats.org）、SkillHub 公开接口与 GitHub 搜索；README 摘要截取开头约 120 字，不保存正文。Skill/Plugin 按岗位方向关键词抓取，各平台热度口径不同（下载 / stars / 浏览），仅作相对参考。
- 技术热度只访问实测可直连的公开 API（GitHub star/PR、PyPI、npm、Maven Central 版本数、StackOverflow、HN）；Maven 版本数不作下载量解读。
- 新工具 / 新框架的动向读 GitHub Releases API，**不爬任何网页、不爬招聘站、不做弹窗登录、不获取登录态、不绕过验证码/403**。
- "需求最旺盛的类别"由入口清单内代表包的下载合计排名，口径在文档中明示，不冒充全市场统计。
- 岗位/技能知识来自运行时运行（`career_explore` 写入），不是静态岗位库，也不编造薪资或招聘需求数字。
- 只使用公开 API 与工作区数据，不上传个人信息。
- 插件以当前 DSH 进程权限运行，请审阅源码后再安装。

## 开发状态

本机 DSH 桌面运行时 `0.2.2-rc.3`（CLI `0.2.2-rc.3`、node `24.21.0`）。弹窗能力已逐字核验 asar：base 默认补丁挂载 `dsh-user-questions`、web-app 挂载 `dsh-client-ui-user-questions`，本插件 patch 补挂 `dsh-tool-ask-user` 即可获得原生单选弹窗。20 个离线单测全过（radar 无 Top10、热点简报分块渲染含 Skill/Plugin 热度、HITL 弹窗指令、SkillHub 接口按方向解析与热度排序、探索→定岗→诊断→规划→导出→复盘）；SkillHub 真实接口（`api.skillhub.cn/api/skills`）已逐字核验，四个方向关键词实测各返回数百到数千条对口技能（如测试→单元测试自动生成、产品→PM Master 11 万下载），并按方向相关度 + 下载量重排；多指标热度与平台动向已联网实测。API 使用边界详见 `API_CLAIMS.md`。
