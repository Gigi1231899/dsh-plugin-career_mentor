/**
 * 工具定义层：原生工具的注册清单（14 个，覆盖探索/热点/规划三模式；热点方向由原生
 * ask_user_question 弹窗选择，报告为分块式热点简报含按岗位热度排序的 Skill/Plugin）。
 *
 * 约定：
 *   - 每个工具用 tool() 构造，输出统一是 JSON 字符串（out.schema: string），
 *     由 render 原样转成文本块，模型读到的是可解析的 JSON。
 *   - 返回值用 ok()/fail() 包装，带 ok、code、message 等字段，失败可定位。
 *   - 知识不来自插件包，而是工作区 knowledge.json（见 src/knowledge.js）。
 *
 * 分层调用关系：
 *   tools.js（本文件，编排 + 参数校验 + 落盘）
 *     ├─ core.js        纯算法（热度、契合、诊断、路线图、各 Markdown 渲染）
 *     ├─ directions.js  四方向 HITL 选项与查询入口
 *     ├─ knowledge.js   运行时知识的读写与推导
 *     ├─ io.js          工作区持久化（profile/快照/计划/文档）
 *     ├─ public-api.js  公开 API 采集（热度/平台动向/方向简报数据）
 *     └─ skill-plugins.js 按岗位抓取 SkillHub / Claude Code 推荐
 */

import { randomUUID } from 'node:crypto'
import {
  clamp,
  diagnose,
  fitRole,
  industryWind,
  planRoadmap,
  renderChecklist,
  renderDirectionReport,
  renderRadarMarkdown,
} from './core.js'
import { DIRECTION_OPTIONS, DIRECTION_QUESTION, directionById, resolveDirection } from './directions.js'
import {
  hasKnowledge,
  readKnowledge,
  resourcesBySkill,
  rolesById,
  skillsById,
  topicsFromSkills,
  writeKnowledge,
} from './knowledge.js'
import {
  readPlan,
  readWorkspace,
  writeChecklist,
  writeDirectionReport,
  writeDirectionsMarkdown,
  writePlan,
  writePlatformNews,
  writeProfile,
  writeRadarMarkdown,
  writeResources,
  writeReview,
  writeSnapshot,
} from './io.js'
import { fetchCategoryDemand, fetchDirectionLibraries, fetchPlatformNews, refreshData } from './public-api.js'
import { fetchSkillPlugins } from './skill-plugins.js'

/**
 * 所有工具共用的输出描述：DSH 拿到工具返回值（字符串），render 把它原样包成
 * 一个 text 内容块返回给模型。schema 声明为 string 与 ok()/fail() 的 JSON 字符串一致。
 */
const out = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * 把简化的参数声明转成标准 JSON Schema（DSH 裸注册路径要求）。
 * 这里采用"属性级 required: true"的简写，转换成对象级 required: [...]，
 * 因为 ctx.tools.register 接受的是后者——两条路径规则相反，见 SKILL 坑 P7。
 *
 * 同时设置 additionalProperties: false，杜绝模型传入未声明字段。
 *
 * @param {object} properties {字段名: {type, description, required?, items?}}
 * @returns {object} 标准 JSON Schema 对象
 */
function toJsonSchema(properties = {}) {
  const entries = Object.entries(properties)
  // ① 收集所有标了 required:true 的属性名，转成对象级 required 数组。
  const required = entries
    .filter(([, spec]) => spec && spec.required === true)
    .map(([key]) => key)
  // ② 属性定义里删掉 required 标记（它不属于 JSON Schema 的属性级规范）。
  const cleaned = Object.fromEntries(entries.map(([key, spec]) => {
    const { required: _ignored, ...rest } = spec || {}
    return [key, rest]
  }))
  return {
    type: 'object',
    properties: cleaned,
    required,
    additionalProperties: false,
  }
}

/**
 * 统一的工具定义构造器。
 * @param {string} name 工具名（career_* 前缀，DSH 工具列表里显示）
 * @param {string} description 给模型看的功能说明（何时调用、前置条件）
 * @param {object} parameters 简化参数声明（见 toJsonSchema）
 * @param {function} execute (args, exec) => JSON 字符串，业务逻辑（联网类为 async）
 * @param {number} timeoutMs 超时（联网类给 30s/45s，其余默认 20s）
 */
function tool(name, description, parameters, execute, timeoutMs = 20000) {
  return {
    name,
    description,
    parameters: toJsonSchema(parameters),
    output: out,
    timeoutMs,
    execute,
  }
}

/** 失败返回：统一 {ok:false, code, message, ...extra} 的 JSON 字符串。 */
function fail(code, message, extra = {}) {
  return JSON.stringify({ ok: false, code, message, ...extra })
}

/** 成功返回：统一 {ok:true, ...value} 的 JSON 字符串。 */
function ok(value) {
  return JSON.stringify({ ok: true, ...value })
}

/**
 * 画像合并：以工作区 profile 为底，叠加上本次工具参数里的显式字段。
 * 只覆盖非 null/undefined 的值，且 skills 做浅合并——避免"只传了一个技能
 * 就把已有掌握度清空"的常见 bug。
 *
 * @param {object} overrides 工具参数里与画像同名的字段（major/grade/skills/deadline...）
 */
function profileFromWorkspace(overrides = {}) {
  const ws = readWorkspace()
  return {
    ...ws.profile, // 底：工作区已有画像
    // 覆盖：只接受非 null/undefined 的显式参数（0 和 '' 是有效值，不过滤）
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null)),
    // skills 特殊处理：先展开工作区已有掌握度，再展开本次传入的，实现浅合并
    skills: { ...(ws.profile.skills || {}), ...(overrides.skills || {}) },
  }
}

/** 把快照的 items 数组转成 {topicId: item}，供 fitRole 按技能 id 查趋势分。 */
function trendMap(snapshot) {
  return Object.fromEntries((snapshot?.items || []).map((item) => [item.id, item]))
}

/**
 * 把技术热度分转成非负加权因子（0–1）：只给热度为正的技能加成，
 * 走弱的技能不惩罚（惩罚会误伤刚起步的冷门方向），供 diagnose/plan 使用。
 * 输入是快照 items 的 score（已归一化的 0–1），clamp 后过滤掉 0。
 */
function trendSignalWeights(snapshot) {
  return Object.fromEntries((snapshot?.items || [])
    .map((item) => [item.id, clamp(Number(item.score) || 0, 0, 1)])
    .filter(([, w]) => w > 0))
}

/** 本地日期 YYYY-MM-DD（UTC 日期，仅用于快照同日判断）。 */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 新计划 id：pl_<YYYYMMDD>_<uuid 前 8 位>，可读且唯一。 */
function newPlanId() {
  return `pl_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${randomUUID().slice(0, 8)}`
}

/**
 * 距截止日期还有几周（向上取整）。
 * Date.parse 失败返回 0（调用方据此报 NEED_DEADLINE/DEADLINE_PASSED）。
 */
function weeksUntil(deadline) {
  const t = Date.parse(deadline)
  if (!Number.isFinite(t)) return 0
  return Math.ceil((t - Date.now()) / (7 * 24 * 60 * 60 * 1000))
}

/** 14 个工具定义按调用顺序排列；导出供 index.js 注册和 test 断言。 */
const defs = [
  /* ------------------------------------------------------------------ *
   * ① career_workspace_context —— 每次职业请求的第一步，无参数。
   * 一次返回：画像状态、知识是否就绪、HITL 方向选择状态、四方向弹窗选项、
   * 三模式提示、上次快照/简报/计划/复盘日期。模型据此分流，不必逐个工具试探。
   * ------------------------------------------------------------------ */
  tool(
    'career_workspace_context',
    'Read the current career workspace state, including whether runtime role/skill knowledge is ready and whether the HITL direction choice is pending. Call this first for every career-related request; it takes no parameters.',
    {},
    () => {
      const ws = readWorkspace() // 画像 + 各目录最新文件（见 io.js）
      const k = readKnowledge()
      const hasDirection = Boolean(ws.profile?.direction)
      return ok({
        // 基础状态
        initialized: ws.initialized,
        root: ws.root,
        knowledge_ready: hasKnowledge(),
        knowledge_roles: (k.roles || []).length,
        knowledge_skills: (k.skills || []).length,
        knowledge_updated_at: k.updated_at || null,
        // 画像关键字段
        goal_role: ws.profile?.goal_role || null,
        direction: ws.profile?.direction || null,
        direction_label: ws.profile?.direction_label || null,
        // HITL：方向未定时为 true，模型必须先弹窗选方向再进热点模式
        hitl_needed: !hasDirection,
        // 弹窗选项：把 label/description 直接给模型，供其构造 ask_user_question 的 options。
        direction_options: DIRECTION_OPTIONS.map((o) => ({ no: o.no, id: o.id, label: o.label, description: o.description })),
        direction_question: DIRECTION_QUESTION,
        // 给模型的操作指令：未定时强调"必须弹窗、不得文本回复数字、不得代选"
        hitl_instruction: !hasDirection
          ? '方向未定：进入热点模式前，必须调用原生 ask_user_question 弹出单选卡片（不要用文本要求回复数字）。用 direction_options 的 label 作选项 label、description 作选项 description，question 用中文提问选择岗位方向。用户点选后调 career_set_direction 落盘。'
          : '方向已定：可直接进入热点模式（career_direction_report）；若有 goal_role 也可进入规划模式。',
        // 三模式分流入参提示（给模型看的"什么时候调什么工具"）
        mode_hints: {
          explore: '用户不知道适合什么、不了解岗位 → career_explore（不生成热点简报、不做规划）',
          hotspot: '用户已选方向 → ask_user_question 选方向（若未定）→ career_set_direction → career_direction_report（含按岗位热度排序的 skill/plugin 推荐）',
          plan: '岗位已确认（goal_role 存在）→ career_diagnose → career_plan → 资源/清单/复盘',
        },
        skills: ws.profile?.skills || {},
        deadline: ws.profile?.deadline || null,
        hours_per_week: ws.profile?.hours_per_week || null,
        // 历史状态日期：让模型知道数据是否陈旧/缺哪部分
        last_snapshot_date: ws.last_snapshot?.data_as_of || null,
        last_platform_news_date: ws.last_platform_news?.data_as_of || null,
        last_direction_report_date: ws.last_direction_report?.data_as_of || null,
        latest_plan_id: ws.latest_plan_id,
        last_review_week: ws.last_review?.week_index ?? null,
        checklist_exists: ws.checklist_exists,
      })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ② career_refresh_data —— 会话首次分析前刷新一次技术热度。
   * 同日快照默认复用（避免限流和会话内数据前后不一致）；force_refresh 才重抓。
   * 话题默认来自运行时技能图谱，知识未就绪时用 topics 参数显式传入。
   * ------------------------------------------------------------------ */
  tool(
    'career_refresh_data',
    'Refresh public technology signals once per user session. Topics come from runtime skill knowledge, or from the optional topics argument when knowledge is not ready. Call before explore, diagnose or plan. Use force_refresh=true when the user explicitly asks for the latest data.',
    {
      force_refresh: { type: 'boolean', description: 'Force a fresh fetch even if today snapshot exists.' },
      limit: { type: 'integer', description: 'Maximum number of topics to refresh. Default 12.' },
      topics: { type: 'array', items: { type: 'string' }, description: 'Optional technology names to query when runtime skill knowledge is empty.' },
    },
    async (args, exec) => {
      const ws = readWorkspace()
      const force = args.force_refresh === true
      // ① 同日快照复用：不重新联网，直接返回已有 items（最多 10 条）。
      if (!force && ws.last_snapshot?.data_as_of === today()) {
        return ok({ reused: true, fetched_at: ws.last_snapshot.fetched_at, data_as_of: ws.last_snapshot.data_as_of, items: (ws.last_snapshot.items || []).slice(0, 10) })
      }
      const k = readKnowledge()
      // 话题优先来自运行时技能图谱；知识还没建立时退回调用方显式传入的 topics。
      let topics = topicsFromSkills(k, args.limit || 12)
      if (!topics.length && Array.isArray(args.topics) && args.topics.length) {
        // 把字符串话题补成 6 类采集器需要的完整 topic 对象（键名同技能 id）。
        topics = args.topics.slice(0, args.limit || 12).map((name) => ({
          id: String(name), name: String(name),
          github_query: String(name), npm_package: String(name),
          so_tag: String(name), hn_query: String(name),
        }))
      }
      if (!topics.length) {
        return fail('NO_TOPICS', 'No technology topics available. Call career_explore with roles/skills first, or pass topics explicitly.')
      }
      try {
        // ② 真正采集：public-api.refreshData 并发抓 6 类公开信号并调用 computeTrends 打分。
        const snapshot = await refreshData({
          topics,
          weights: {}, // 用 core.js 的默认权重
          limit: args.limit || 12,
          signal: exec?.signal, // 用户中断可传播到底层 fetch
        })
        const file = writeSnapshot(snapshot)
        return ok({
          reused: false,
          fetched_at: snapshot.fetched_at,
          data_as_of: snapshot.data_as_of,
          stale: snapshot.stale,
          failed_count: (snapshot.failed || []).length, // 部分源失败的数量
          items: (snapshot.items || []).slice(0, 10),   // 只回前 10 条给模型，完整数据在文件里
          snapshot_path: file,
        })
      } catch (err) {
        return fail('REFRESH_FAILED', String(err?.message || err))
      }
    },
    30000 // 联网类超时放宽到 30s
  ),

  /* ------------------------------------------------------------------ *
   * ③ career_platform_news —— 读 9 个 AI agent 平台官方 GitHub Releases。
   * 只拿元数据（版本/日期/发行说明/链接），不爬网页、不登录。
   * 方向确定后 career_direction_report 已包含这部分，优先用报告即可。
   * ------------------------------------------------------------------ */
  tool(
    'career_platform_news',
    'Fetch the latest moves of mainstream AI agent platforms from official GitHub Releases (public API, no web scraping), tagged as tool vs framework with company and install address. Call when the user asks what is trending / what tools are new / where to start; career_direction_report already includes this data, so prefer the report once a direction is chosen.',
    {
      limit: { type: 'integer', description: 'Maximum number of platforms to check. Default 8.' },
    },
    async (args, exec) => {
      try {
        const snapshot = await fetchPlatformNews({ limit: args.limit || 8, signal: exec?.signal })
        const file = writePlatformNews(snapshot)
        return ok({
          fetched_at: snapshot.fetched_at,
          data_as_of: snapshot.data_as_of,
          stale: snapshot.stale,
          source: snapshot.source,
          failed: snapshot.failed || [], // 单平台失败列表
          items: snapshot.items,
          platform_path: file,
          note: '如需完整的方向简报（TOP15 热门库/包 + 类别需求 + 新工具 vs 新框架），先让用户选方向并调用 career_direction_report。',
        })
      } catch (err) {
        return fail('PLATFORM_NEWS_FAILED', String(err?.message || err))
      }
    },
    30000
  ),

  /* ------------------------------------------------------------------ *
   * ④ career_explore —— 探索模式的入口：为"不知道学什么"的学生生成 3–5 候选岗位。
   * 唯一的知识写入口：模型基于实时技术信号构造 roles/skills_catalog，落盘 knowledge.json，
   * 之后 diagnose/plan/review 都复用这份知识，不再重复编造岗位定义。
   * ------------------------------------------------------------------ */
  tool(
    'career_explore',
    'Explore 3-5 suitable target roles for a student with no clear goal_role. Provide roles and skills grounded in the live tech-radar signals and the student profile; they are persisted as runtime workspace knowledge. Call when the user does not know what to learn.',
    {
      major: { type: 'string', description: 'Student major, e.g. 软件工程.' },
      grade: { type: 'string', description: 'Student grade, e.g. 大二.' },
      skills: { type: 'object', additionalProperties: true, description: 'Skill mastery map, e.g. {"python":3}.' },
      preference: { type: 'array', items: { type: 'string' }, description: 'Preferences: coding, analysis, communication.' },
      hours_per_week: { type: 'number', description: 'Weekly hours available for learning.' },
      deadline: { type: 'string', description: 'Target date in ISO format, e.g. 2027-09-01.' },
      // 下面是"运行时知识"入参：由模型依据公开信号构造，不是插件包里的静态库
      roles: {
        type: 'array',
        description: 'Runtime role candidates grounded in public tech signals. Each: {id, name, family, typical_jobs:[string] (real job titles this role maps to, e.g. 大模型应用工程师), tags, trend_boost, skills:[{id, importance}]}.',
        items: { type: 'object', additionalProperties: true },
      },
      skills_catalog: {
        type: 'array',
        description: 'Runtime skill definitions. Each: {id, name, prereq[], cost_hours, aliases[]}.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    (args) => {
      // ① 合并画像并校验必填：专业/年级/技能至少各有一个，否则让模型追问用户。
      const profile = profileFromWorkspace(args)
      const missing = []
      if (!profile.major) missing.push('major')
      if (!profile.grade) missing.push('grade')
      if (!Object.keys(profile.skills || {}).length) missing.push('skills')
      if (missing.length) return fail('NEED_MORE_INFO', 'Missing required profile fields.', { missing })

      // ② 写入运行时知识：只有当模型同时给了 roles 和 skills_catalog 时才写。
      //    这是唯一的知识入口，writeKnowledge 会清洗并过滤悬空引用（见 knowledge.js）。
      const suppliedRoles = Array.isArray(args.roles) ? args.roles : []
      const suppliedSkills = Array.isArray(args.skills_catalog) ? args.skills_catalog : []
      if (suppliedRoles.length && suppliedSkills.length) {
        writeKnowledge({ roles: suppliedRoles, skills: suppliedSkills, source: 'model+jobs' })
      }
      if (!hasKnowledge()) {
        return fail('NO_KNOWLEDGE', 'No runtime role/skill knowledge. Provide roles and skills_catalog grounded in tech radar signals, or ask the user for their target role and skills.')
      }

      // ③ 画像落盘（含时间戳），然后基于最新知识 + 快照为每个岗位打分。
      profile.updated_at = new Date().toISOString()
      writeProfile(profile)

      const ws = readWorkspace()
      const k = readKnowledge()
      const byId = skillsById(k)
      const trends = trendMap(ws.last_snapshot) // {skillId: {score,...}}，可能为空 {}
      const candidates = (k.roles || [])
        .map((role) => fitRole(profile, role, byId, trends)) // core.js 的四项加权打分
        .sort((a, b) => b.fit_score - a.fit_score)           // 契合度降序
        .slice(0, 5)                                        // 最多 5 个候选

      // ④ 返回 need_user_choice:true：明确要求用户从候选里选/否定，不能模型代选。
      return ok({
        candidates,
        need_user_choice: true,
        knowledge_updated_at: k.updated_at,
        data_as_of: ws.last_snapshot?.data_as_of || null,
        stale: Boolean(ws.last_snapshot?.stale),
      })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑤ career_set_goal —— 用户从 explore 候选里选定后，把 goal_role 落盘。
   * 用 rolesById() 校验 id 是否存在于运行时知识，防止写入悬空岗位。
   * ------------------------------------------------------------------ */
  tool(
    'career_set_goal',
    'Set the user chosen target role from runtime knowledge into workspace/profile.json. Call after the user selects a candidate from career_explore.',
    {
      role_id: { type: 'string', required: true, description: 'Role id returned by career_explore.' },
    },
    (args) => {
      const roles = rolesById() // {id: role} 索引，来自 knowledge.json
      if (!roles[args.role_id]) return fail('ROLE_NOT_FOUND', `Unknown role_id: ${args.role_id}. Call career_explore to build runtime knowledge first.`)
      const profile = profileFromWorkspace()
      profile.goal_role = args.role_id
      profile.updated_at = new Date().toISOString()
      writeProfile(profile)
      return ok({ goal_role: args.role_id, name: roles[args.role_id].name, profile_path: readWorkspace().files.profile })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑥ career_radar —— 读最新快照渲染 radar.md：个人画像 + 行业风向 + 与你的关系。
   * 已删除 Top10 总榜与原始指标表；本工具绝不重新联网，只读快照。
   * ------------------------------------------------------------------ */
  tool(
    'career_radar',
    'Read the current tech heat from the latest refreshed snapshot and render a sectioned Markdown report (profile card + heat ranking + raw metric table + industry wind + personal relevance), saved to workspace/radar.md. Current values only: no historical baseline, no growth rate. Call when the user asks what technology is hot. Never fetch again here.',
    {
      limit: { type: 'integer', description: 'Number of topics to return. Default 10.' },
    },
    (args) => {
      const ws = readWorkspace()
      if (!ws.last_snapshot) return fail('NO_SNAPSHOT', 'No snapshot found. Call career_refresh_data first.')
      const k = readKnowledge()
      // 行业风向：按运行时岗位的 family 聚合快照热度（core.industryWind）
      const wind = industryWind(ws.last_snapshot, k.roles || [])
      const goalRole = (k.roles || []).find((r) => r.id === ws.profile?.goal_role) || null
      const md = renderRadarMarkdown(ws.last_snapshot, wind, ws.profile, goalRole, skillsById(k))
      const file = writeRadarMarkdown(md) // io.js 覆盖前自动备份旧版本
      return ok({
        data_as_of: ws.last_snapshot.data_as_of,
        stale: Boolean(ws.last_snapshot.stale),
        metric_units: ws.last_snapshot.metric_units || {}, // 单位标注（版本数≠下载量）
        items: (ws.last_snapshot.items || []).slice(0, args.limit || 10),
        industry_wind: wind,
        goal_role: goalRole ? goalRole.id : null,
        profile_in_doc: Boolean(ws.profile?.major || ws.profile?.grade), // 文档里是否真的有画像
        radar_path: file,
        markdown: md,
      })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑦ career_diagnose —— 规划模式第一步：按"每学习小时收益"给出 top3 技能缺口。
   * 热度信号只做正加成（trendSignalWeights），走弱技能不惩罚。
   * ------------------------------------------------------------------ */
  tool(
    'career_diagnose',
    'Diagnose the top-3 skill gaps for the chosen role, ranked by benefit per learning hour. Call after goal_role is set.',
    {
      goal_role: { type: 'string', description: 'Optional role id; defaults to profile.goal_role.' },
      skills: { type: 'object', additionalProperties: true, description: 'Optional skill mastery overrides.' },
    },
    (args) => {
      const profile = profileFromWorkspace(args)
      const roleId = args.goal_role || profile.goal_role
      if (!roleId) return fail('NO_GOAL_ROLE', 'No goal_role. Call career_explore and career_set_goal first.')
      const role = rolesById()[roleId]
      if (!role) return fail('ROLE_NOT_FOUND', `Unknown role_id: ${roleId}`)
      const ws = readWorkspace()
      const signalWeights = trendSignalWeights(ws.last_snapshot) // {skillId: 0–1}，只含正热度
      const result = diagnose(profile, role, skillsById(), signalWeights)
      return ok({
        goal_role: roleId,
        role_name: role.name,
        top3: result.top3,
        all: result.all,
        data_as_of: ws.last_snapshot?.data_as_of || null,
        stale: Boolean(ws.last_snapshot?.stale),
      })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑧ career_plan —— 规划模式核心：按 deadline 动态生成阶段路线图。
   * 先算 horizonWeeks（过期报 DEADLINE_PASSED），再调 core.planRoadmap（拓扑排序），
   * 结果写入 plans/<新 plan_id>.json，画像也更新 deadline。
   * ------------------------------------------------------------------ */
  tool(
    'career_plan',
    'Generate a dynamic learning roadmap bounded by the user deadline and weekly hours. Call after diagnosis; never use a fixed horizon.',
    {
      goal_role: { type: 'string', description: 'Optional role id; defaults to profile.goal_role.' },
      deadline: { type: 'string', description: 'Target date in ISO format. Required if profile has none.' },
      hours_per_week: { type: 'number', description: 'Weekly learning hours.' },
      skills: { type: 'object', additionalProperties: true, description: 'Optional skill mastery overrides.' },
    },
    (args) => {
      // ① 前置校验：岗位存在 + deadline 有效且在未来。
      const profile = profileFromWorkspace(args)
      const roleId = args.goal_role || profile.goal_role
      if (!roleId) return fail('NO_GOAL_ROLE', 'No goal_role. Call career_explore and career_set_goal first.')
      const role = rolesById()[roleId]
      if (!role) return fail('ROLE_NOT_FOUND', `Unknown role_id: ${roleId}`)
      const deadline = args.deadline || profile.deadline
      if (!deadline) return fail('NEED_DEADLINE', 'A deadline is required to generate a roadmap.')
      const horizonWeeks = weeksUntil(deadline)
      if (horizonWeeks < 1) return fail('DEADLINE_PASSED', 'The deadline must be in the future.')

      // ② 画像落盘（含新 deadline）
      profile.deadline = deadline
      profile.updated_at = new Date().toISOString()
      writeProfile(profile)

      // ③ 调纯算法生成序列与阶段，捕获 GRAPH_CYCLE / DEADLINE_PASSED 等业务错误。
      const ws = readWorkspace()
      const signalWeights = trendSignalWeights(ws.last_snapshot)
      try {
        const result = planRoadmap(profile, role, skillsById(), horizonWeeks, signalWeights)
        // ④ 打包成带来源与数据日期的完整计划对象并落盘（plans/ 下保留历史版本）。
        const plan = {
          schema_version: 1,
          plan_id: newPlanId(),
          created_at: new Date().toISOString(),
          goal_role: roleId,
          deadline,
          horizon_weeks: horizonWeeks,
          coverage: result.coverage,
          stages: result.stages,
          sequence: result.sequence,
          profile_snapshot: profile, // 快照：本次规划依据的画像，便于回溯
          snapshot_ref: ws.files.snapshot, // 引用的热度快照路径
          data_as_of: ws.last_snapshot?.data_as_of || null,
          stale: Boolean(ws.last_snapshot?.stale),
        }
        writePlan(plan)
        return ok({
          plan_id: plan.plan_id, deadline, horizon_weeks: horizonWeeks,
          coverage: plan.coverage, stages: plan.stages,
          data_as_of: plan.data_as_of, stale: plan.stale,
        })
      } catch (err) {
        // err.code 可能是 GRAPH_CYCLE / DEADLINE_PASSED，原样回传给模型便于定位。
        return fail(err.code || 'PLAN_FAILED', String(err?.message || err))
      }
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑨ career_recommend_resources —— 为计划或技能列表生成 B站/GitHub/文档搜索链接。
   * 链接按技能名即时生成（不是静态课程表），建议时间优先取计划阶段的真实周次。
   * ------------------------------------------------------------------ */
  tool(
    'career_recommend_resources',
    'Recommend Bilibili, GitHub and documentation resources with suggested completion weeks for a plan or a list of skills. Links are generated from runtime skills via search URL templates.',
    {
      plan_id: { type: 'string', description: 'Plan id returned by career_plan.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Optional skill ids when no plan_id.' },
    },
    (args) => {
      const plan = args.plan_id ? readPlan(args.plan_id) : null
      const skillIds = args.skills || plan?.sequence || [] // 有计划就用它的学习序列
      if (!skillIds.length) return fail('NO_SKILLS', 'Provide plan_id or skills.')
      const k = readKnowledge()
      const skills = skillsById(k)
      const resources = resourcesBySkill(k, skillIds) // {skillId: [三种搜索链接]}
      // 建议时间优先取计划阶段的真实周次；只传技能列表时按顺序给"第 n 周"。
      const weekBySkill = {}
      for (const stage of plan?.stages || []) {
        for (const id of stage.skills || []) weekBySkill[id] = stage.weeks
      }
      const items = skillIds.map((id, index) => ({
        skill_id: id,
        name: skills[id]?.name || id, // 查不到定义时用 id 兜底
        suggested_week: index + 1,
        suggested_time: weekBySkill[id] || `第 ${index + 1} 周`,
        resources: resources[id] || [],
        sample_insufficient: !resources[id]?.length, // 无资源时标记样本不足
      }))
      // 拼 Markdown：标题 + 口径 + 五列表格（序号/技能/建议时间/资源）+ 使用说明。
      const lines = [
        '# 学习资源',
        '',
        `> 生成日期：${new Date().toISOString().slice(0, 10)}｜技能数：${items.length}｜链接为搜索入口，内容以打开结果为准`,
        '',
        '## 按技能排列',
        '',
        '| 序号 | 技能 | 建议完成时间 | 资源 |',
        '| --- | --- | --- | --- |',
      ]
      for (const item of items) {
        const links = (item.resources || [])
          .map((r) => `[${r.title}](${r.url})（约 ${r.hours} 小时）`)
          .join(' / ') || '样本不足'
        lines.push(`| ${item.suggested_week} | ${item.name} | ${item.suggested_time} | ${links} |`)
      }
      lines.push('', '## 使用说明', '')
      lines.push('- 建议顺序按学习清单的阶段推进；同一阶段的资源先各看 30 分钟，再选一个深入。')
      lines.push('- 这些链接是按技能名生成的搜索入口，不是固定课程；内容会随平台变化。')
      const markdown = lines.join('\n') + '\n'
      const file = writeResources(markdown)
      return ok({ items, resources_path: file })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑩ career_export_checklist —— 把计划导出成 checklist.md（五列阶段表）。
   * 资源来自运行时搜索链接模板，画像来自计划里的 profile_snapshot。
   * ------------------------------------------------------------------ */
  tool(
    'career_export_checklist',
    'Export the current learning checklist to workspace/checklist.md with stages, generated resources, suggested completion time and acceptance criteria.',
    {
      plan_id: { type: 'string', required: true, description: 'Plan id returned by career_plan.' },
    },
    (args) => {
      const plan = readPlan(args.plan_id)
      if (!plan) return fail('PLAN_NOT_FOUND', `Unknown plan_id: ${args.plan_id}`)
      const resourceIds = (plan.stages || []).flatMap((s) => s.skills || []) // 阶段涉及的所有技能
      const resources = resourcesBySkill(readKnowledge(), resourceIds)
      const markdown = renderChecklist(plan, resources, {
        data_as_of: plan.data_as_of,
        stale: plan.stale,
        plan_id: plan.plan_id,
        profile: plan.profile_snapshot || null, // 用规划时的画像，保证表格与计划一致
        role: rolesById()[plan.goal_role] || null,
        skillsById: skillsById(),
      })
      const file = writeChecklist(markdown)
      return ok({ checklist_path: file, bytes: Buffer.byteLength(markdown, 'utf8'), preview: markdown.split('\n').slice(0, 8).join('\n') })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑪ career_review —— 每周复盘：写回掌握度 + 记录复盘 + 用剩余周数重新规划。
   * 计划滚动更新（新 plan_id，based_on_review 指回旧计划），不是一份清单到底。
   * ------------------------------------------------------------------ */
  tool(
    'career_review',
    'Record weekly completion, update skill mastery and regenerate the remaining roadmap. Call when the user reports what was finished or unfinished.',
    {
      plan_id: { type: 'string', required: true, description: 'Plan id being reviewed.' },
      week_index: { type: 'integer', required: true, description: 'Week number in the roadmap.' },
      completed: { type: 'object', additionalProperties: true, required: true, description: 'Map of skill_id to true/false.' },
      notes: { type: 'string', description: 'Optional reflection notes.' },
    },
    (args) => {
      const plan = readPlan(args.plan_id)
      if (!plan) return fail('PLAN_NOT_FOUND', `Unknown plan_id: ${args.plan_id}`)
      const profile = profileFromWorkspace()
      // ① 写回掌握度：完成→4（已掌握），未完成→2（入门），下次规划会重排。
      for (const [skillId, done] of Object.entries(args.completed || {})) {
        profile.skills[skillId] = done === true ? 4 : 2
      }
      profile.updated_at = new Date().toISOString()
      writeProfile(profile)

      // ② 记录复盘（reviews/<week_index>.json）
      const review = {
        schema_version: 1,
        plan_id: args.plan_id,
        week_index: args.week_index,
        completed: args.completed || {},
        notes: args.notes || '',
        created_at: new Date().toISOString(),
      }
      writeReview(review)

      // ③ 复盘不只是记录：用更新后的画像 + 剩余周数重新生成路线图，
      //    让计划随实际进度滚动更新（而不是一份固定到底的清单）。
      const role = rolesById()[profile.goal_role]
      const horizonWeeks = weeksUntil(profile.deadline)
      if (!role || horizonWeeks < 1) {
        // 无法重排时仍返回复盘结果，reason 说明原因。
        return ok({ review, replan: null, reason: role ? 'DEADLINE_PASSED' : 'NO_GOAL_ROLE' })
      }
      const ws = readWorkspace()
      const signalWeights = trendSignalWeights(ws.last_snapshot)
      const result = planRoadmap(profile, role, skillsById(), horizonWeeks, signalWeights)
      const newPlan = {
        schema_version: 1,
        plan_id: newPlanId(),
        created_at: new Date().toISOString(),
        goal_role: profile.goal_role,
        deadline: profile.deadline,
        horizon_weeks: horizonWeeks,
        coverage: result.coverage,
        stages: result.stages,
        sequence: result.sequence,
        profile_snapshot: profile,
        based_on_review: { plan_id: args.plan_id, week_index: args.week_index }, // 血缘：从哪次复盘重排而来
        data_as_of: ws.last_snapshot?.data_as_of || null,
        stale: Boolean(ws.last_snapshot?.stale),
      }
      writePlan(newPlan)
      return ok({ review, replan: { plan_id: newPlan.plan_id, coverage: newPlan.coverage, stages: newPlan.stages, stale: newPlan.stale } })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑫ career_skill_plugins —— 热点模式辅助工具：按岗位方向抓 SkillHub + Claude Code
   * 热门技能/插件，按使用量统一降序。可单独调用，也可由 direction_report 内嵌。
   * ------------------------------------------------------------------ */
  tool(
    'career_skill_plugins',
    'Recommend popular skills/plugins by the chosen job direction, ranked by usage (downloads/stars) across SkillHub and Claude Code. Use in hotspot mode after the direction is chosen.',
    {
      direction: { type: 'string', description: 'Direction id/label (dev/ops/test/pm or 开发/运维/测试/产品经理); defaults to profile.direction.' },
      limit: { type: 'integer', description: 'Number of items per platform. Default 6.' },
      queries: { type: 'array', items: { type: 'string' }, description: 'Override the direction-based search keywords.' },
    },
    async (args, exec) => {
      const ws = readWorkspace()
      const profile = ws.profile || {}
      const k = readKnowledge()
      const role = (k.roles || []).find((r) => r.id === profile.goal_role) || null
      const direction = args.direction || profile.direction || null // 参数 > 画像
      // 守卫：方向、目标岗位、专业都没有时无法按岗位排序，要求用户先选方向。
      if (!direction && !role && !profile.major) {
        return fail('NO_DIRECTION', 'Choose a direction first, or pass direction/queries so recommendations can be ranked per job.')
      }
      const result = await fetchSkillPlugins({
        direction, role, profile, queries: args.queries, limit: args.limit || 6, signal: exec?.signal,
      })
      return ok(result)
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑬ career_set_direction —— HITL 落盘：用户弹窗点选后，把方向写进画像。
   * resolveDirection 接受 1–4 / id / 中文标签；非法输入报 UNKNOWN_DIRECTION，
   * 已落盘方向不被污染。落盘后 next_step 指引模型调 direction_report。
   * ------------------------------------------------------------------ */
  tool(
    'career_set_direction',
    'Persist the user-chosen HITL direction (reply by number: 1 开发 2 运维 3 测试 4 产品经理, or id dev/ops/test/pm) into workspace profile. Call right after the user answers the direction question, then call career_direction_report.',
    {
      direction: { type: 'string', required: true, description: 'Direction number 1-4 (string or id): 1=dev 开发, 2=ops 运维, 3=test 测试, 4=pm 产品经理.' },
    },
    (args) => {
      const option = resolveDirection(args.direction) // 归一化：数字/id/中文标签 → 选项对象
      if (!option) {
        return fail('UNKNOWN_DIRECTION', `Unknown direction: ${args.direction}. Valid choices: ${DIRECTION_OPTIONS.map((o) => `${o.no}=${o.label}(${o.id})`).join(', ')}.`)
      }
      const profile = profileFromWorkspace()
      profile.direction = option.id
      profile.direction_label = option.label
      profile.updated_at = new Date().toISOString()
      writeProfile(profile)
      return ok({
        direction: option.id,
        no: option.no,
        label: option.label,
        hitl_needed: false, // 方向已定：workspace_context 下一轮不会再提示弹窗
        next_step: 'career_direction_report', // 给模型的下一步指引
        profile_path: readWorkspace().files.profile,
      })
    }
  ),

  /* ------------------------------------------------------------------ *
   * ⑭ career_direction_report —— 热点模式主工具：生成六节方向热点简报。
   * 守卫：方向未定返回 NO_DIRECTION（附问题文本），绝不代选；
   * 同日同方向默认复用缓存重渲染，force_refresh 才重抓；
   * 四路并发采集（库包/类别需求/平台动向/SkillPlugin），全部落盘后渲染 directions.md。
   * ------------------------------------------------------------------ */
  tool(
    'career_direction_report',
    'Generate the direction brief for the chosen HITL direction and save it to workspace/directions.md. Contains three required sections: TOP15 popular libraries/packages (project name, README summary, Stars, weekly downloads, links), the most-demanded library/package categories (aggregated npm/PyPI weekly downloads), and new tools vs new frameworks in separate tables (company, install/download address). Requires a direction (argument or profile.direction). Same-day same-direction result is reused unless force_refresh=true.',
    {
      direction: { type: 'string', description: 'Direction number 1-4 or id (dev/ops/test/pm); defaults to profile.direction set by career_set_direction.' },
      limit: { type: 'integer', description: 'TOP N of libraries/packages. Default 15.' },
      queries: { type: 'array', items: { type: 'string' }, description: 'Override GitHub search queries for the TOP libraries, e.g. ["topic:llm"].' },
      force_refresh: { type: 'boolean', description: 'Re-fetch even if the same direction was already generated today.' },
    },
    async (args, exec) => {
      const ws = readWorkspace()
      // ① 守卫：参数方向 > 画像方向；都没有就返回问题文本要求先弹窗选方向。
      const option = resolveDirection(args.direction) || resolveDirection(ws.profile?.direction)
      if (!option) {
        return fail('NO_DIRECTION', `HITL: ask the user to choose a direction first. Question:\n${DIRECTION_QUESTION}`)
      }
      const direction = directionById(option.id) // 查方向的查询入口（github_queries/categories）
      if (!direction) return fail('UNKNOWN_DIRECTION', `No catalog entry for direction: ${option.id}`)

      // ② 同日同方向已生成过：直接复用缓存原始数据重新渲染，避免重复消耗 GitHub API 配额。
      const prev = ws.last_direction_report
      if (args.force_refresh !== true && prev && prev.direction === option.id && prev.data_as_of === today()) {
        const md = renderDirectionReport({
          direction: { id: prev.direction, label: prev.direction_label, blurb: prev.blurb },
          profile: ws.profile,
          role: (readKnowledge().roles || []).find((r) => r.id === ws.profile?.goal_role) || null,
          skillsById: skillsById(),
          libraries: prev.libraries,
          demand: prev.demand,
          platforms: prev.platforms,
          skillPlugins: prev.skillPlugins,
        })
        const mdFile = writeDirectionsMarkdown(md)
        return ok({
          reused: true, // 标记复用：告诉模型本次没有重新抓取
          direction: option.id, direction_label: option.label,
          data_as_of: prev.data_as_of, stale: prev.stale,
          libraries: prev.libraries?.items || [],
          demand: prev.demand?.categories || [],
          platforms: prev.platforms?.items || [],
          skill_plugins: prev.skillPlugins?.top || [],
          directions_path: mdFile,
          report_path: ws.files.direction_report,
        })
      }

      try {
        // ③ 四路并发采集：任一失败只记入对应 failed，不拖垮整批（各采集器内部已降级）。
        const [libraries, demand, platforms, skillPlugins] = await Promise.all([
          fetchDirectionLibraries({ direction, queries: args.queries, limit: args.limit || 15, signal: exec?.signal }),
          fetchCategoryDemand({ direction, signal: exec?.signal }),
          fetchPlatformNews({ limit: 12, signal: exec?.signal }),
          fetchSkillPlugins({ direction: option.id, profile: readWorkspace().profile, limit: 6, signal: exec?.signal }),
        ])

        // ④ 若调用时只传了方向参数、画像还没落盘，这里补写 direction/direction_label。
        const profile = profileFromWorkspace()
        if (!profile.direction || profile.direction !== option.id) {
          profile.direction = option.id
          profile.direction_label = option.label
        }
        profile.updated_at = new Date().toISOString()
        writeProfile(profile)

        const role = (readKnowledge().roles || []).find((r) => r.id === profile.goal_role) || null
        // stale 保守判断：三路主数据都 stale 才算整批陈旧（SkillPlugin 单独用 stale 字段）。
        const stale = Boolean(libraries.stale && demand.stale && platforms.stale)
        const doc = {
          schema_version: 1,
          direction: option.id,
          direction_label: option.label,
          blurb: direction.blurb || '',
          fetched_at: new Date().toISOString(),
          data_as_of: new Date().toISOString().slice(0, 10),
          stale,
          libraries, demand, platforms, skillPlugins, // 原始数据整体落盘，供同日复用重渲染
        }
        const reportFile = writeDirectionReport(doc)
        // ⑤ 渲染六节简报并落盘 directions.md（writeText 会自动备份旧版本）。
        const md = renderDirectionReport({
          direction: { id: option.id, label: option.label, blurb: direction.blurb },
          profile,
          role,
          skillsById: skillsById(),
          libraries,
          demand,
          platforms,
          skillPlugins,
        })
        const mdFile = writeDirectionsMarkdown(md)
        return ok({
          reused: false,
          direction: option.id, direction_label: option.label,
          data_as_of: doc.data_as_of, stale,
          failed: { libraries: libraries.failed, demand: demand.failed, platforms: platforms.failed, skill_plugins: skillPlugins.stale },
          libraries: libraries.items,
          demand: demand.categories,
          platforms: platforms.items,
          skill_plugins: skillPlugins.top,
          directions_path: mdFile,
          report_path: reportFile,
          markdown_preview: md.split('\n').slice(0, 8).join('\n'), // 前 8 行预览，避免返回过长
        })
      } catch (err) {
        return fail('DIRECTION_REPORT_FAILED', String(err?.message || err))
      }
    },
    45000 // 四路并发联网，超时放宽到 45s
  ),
]

/** 工具名清单：供 index.js 调试与 test 断言"14 个工具齐全"。 */
export const TOOL_NAMES = defs.map((d) => d.name)

/** 工具定义数组：index.js 逐个 register，test 直接取 execute 做离线冒烟。 */
export const toolDefinitions = defs
