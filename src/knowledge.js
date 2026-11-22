/**
 * 运行时知识层：不打包任何静态岗位/技能库。
 *
 * 岗位画像与技能图谱由模型在会话中依据公开技术信号 + 用户画像生成，
 * 经 career_explore 写入工作区 knowledge.json，之后所有工具从工作区读取。
 * 话题、别名、资源链接由这份运行时知识推导，因此不会有"写死的、过时的知识库"；
 * 技术热度只看本次快照的当前值，不维护历史基线。
 *
 * 数据流：
 *   career_explore 传入 roles/skills_catalog
 *     → writeKnowledge() 清洗并落盘 knowledge.json
 *     → readKnowledge() / hasKnowledge() 供其它工具判断"知识是否就绪"
 *     → skillsById / rolesById 建索引供算法查表
 *     → topicsFromSkills 推导公开 API 查询话题
 *     → resourcesForSkill / resourcesBySkill 生成搜索 URL 资源入口
 */

import path from 'node:path'
import { readJson, writeJson, workspaceRoot } from './io.js'

/**
 * knowledge.json 的绝对路径（始终在当前工作区根下）。
 * 每次调用都重新算，因为工作区根可能被 index.js 在会话间切换。
 */
function knowledgeFile() {
  return path.join(workspaceRoot(), 'knowledge.json')
}

/** 知识文件缺失/损坏时的空骨架；保持 schema_version 一致，便于将来迁移。 */
const EMPTY = { schema_version: 1, skills: [], roles: [], updated_at: null, source: null }

/**
 * 读运行时知识；文件不存在或 JSON 损坏时返回 EMPTY 骨架（不抛错）。
 * 调用方用 hasKnowledge() 判断是否真的有内容。
 */
export function readKnowledge() {
  return readJson(knowledgeFile(), EMPTY)
}

/**
 * 判断运行时知识是否"就绪"：roles 和 skills 都必须是非空数组。
 * 只有一半（例如只有岗位没有技能定义）不算就绪，避免下游算法拿到悬空引用。
 */
export function hasKnowledge() {
  const k = readKnowledge()
  return Array.isArray(k.roles) && k.roles.length > 0 && Array.isArray(k.skills) && k.skills.length > 0
}

/**
 * 写入运行时知识：做基本的清洗与校验，保证下游算法拿到的图谱是自洽的。
 *
 * 清洗步骤：
 *   1) skills：id 去空、cost_hours 限制 ≥1（默认 20）、prereq/aliases 强制转字符串数组；
 *   2) roles：只保留"至少引用了一个已知技能 id"的岗位，避免悬空技能引用；
 *      typical_jobs 最多留 6 个真实职位名（模型基于公开信号构造，不是静态岗位库）；
 *      skills[].importance 限制 ≥1（默认 3），字符串写法按 3 处理；
 *   3) 打包成带 schema_version / updated_at / source 的文档整体覆盖写入。
 *
 * @param {{skills: object[], roles: object[], source?: string}} payload
 */
export function writeKnowledge({ skills, roles, source = 'model+jobs' }) {
  // ① 清洗技能定义：id 必须非空；name 缺省用 id；工时至少 1 小时。
  const cleanSkills = (Array.isArray(skills) ? skills : []).map((s) => ({
    id: String(s.id || '').trim(),
    name: String(s.name || s.id || '').trim(),
    prereq: Array.isArray(s.prereq) ? s.prereq.map(String) : [], // 前置技能 id 列表
    cost_hours: Math.max(1, Number(s.cost_hours) || 20),
    aliases: Array.isArray(s.aliases) ? s.aliases.map(String) : [], // 别名，供相关度匹配
  })).filter((s) => s.id) // 丢掉没有 id 的无效技能

  // ② 已知技能 id 集合：用于校验岗位引用，防止岗位要求一个不存在的技能。
  const skillIds = new Set(cleanSkills.map((s) => s.id))
  const cleanRoles = (Array.isArray(roles) ? roles : []).map((r) => ({
    id: String(r.id || '').trim(),
    name: String(r.name || r.id || '').trim(),
    family: String(r.family || ''), // 岗位族，供 industryWind 聚合行业风向
    // 典型职位名（如「大模型应用工程师」）由模型结合公开技术信号构造，
    // 用于方向简报里的"技术对应岗位"，不是静态岗位库。
    typical_jobs: Array.isArray(r.typical_jobs) ? r.typical_jobs.map(String).filter(Boolean).slice(0, 6) : [],
    tags: r.tags && typeof r.tags === 'object' ? r.tags : {}, // 偏好标签：coding_level/math_level/people_facing
    trend_boost: Number(r.trend_boost) || 0, // 模型给的趋势判断分，参与 fitRole
    skills: (Array.isArray(r.skills) ? r.skills : [])
      .map((rs) => ({
        // 兼容两种写法：'python' 字符串 或 {id:'python', importance:4}
        id: typeof rs === 'string' ? rs : String(rs.id || '').trim(),
        importance: Math.max(1, Number(typeof rs === 'string' ? 3 : rs.importance) || 3),
      }))
      // 只保留引用了已知技能的条目：图谱自洽性的关键一步
      .filter((rs) => rs.id && skillIds.has(rs.id)),
  })).filter((r) => r.id && r.skills.length) // 无有效技能的岗位直接丢弃

  // ③ 整包落盘：单次 writeJson 覆盖，避免部分写入造成半新半旧的知识。
  const doc = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    source, // 'model+jobs' 表示来自模型依据实时数据构造
    skills: cleanSkills,
    roles: cleanRoles,
  }
  writeJson(knowledgeFile(), doc)
  return doc
}

/**
 * 把技能数组转成 {id: skill} 索引，供 O(1) 查找。
 * 算法层（fitRole/diagnose/planRoadmap）都接收这个索引而不是数组。
 */
export function skillsById(k = readKnowledge()) {
  return Object.fromEntries((k.skills || []).map((s) => [s.id, s]))
}

/**
 * 把岗位数组转成 {id: role} 索引，供 set_goal / diagnose / plan 校验 role_id。
 */
export function rolesById(k = readKnowledge()) {
  return Object.fromEntries((k.roles || []).map((r) => [r.id, r]))
}

/**
 * 从运行时技能图谱推导公开 API 查询话题，无需静态 topics.json。
 * 每个技能映射成 6 类采集任务需要的键：github_query / npm_package / so_tag / hn_query，
 * pypi_package / maven_artifact 缺省用 id（采集器会自行处理取不到的情况）。
 * @param {object} k 运行时知识对象
 * @param {number} limit 最多取几个技能（默认 12，控制 API 请求量）
 */
export function topicsFromSkills(k = readKnowledge(), limit = 12) {
  return (k.skills || []).slice(0, limit).map((s) => ({
    id: s.id,
    name: s.name,
    github_query: s.name || s.id, // GitHub 搜名称，命中率高于 id
    npm_package: s.id,
    so_tag: s.id,
    hn_query: s.name || s.id,
  }))
}

/**
 * 从技能 id + name + aliases 生成别名映射，供相关度/关键词匹配使用。
 * 例：{ rag: ['rag', 'RAG', '检索增强'] }。
 */
export function aliasesFromSkills(k = readKnowledge()) {
  return Object.fromEntries((k.skills || []).map((s) => [
    s.id,
    [s.id, s.name, ...(s.aliases || [])].filter(Boolean),
  ]))
}

/**
 * 用搜索 URL 模板即时生成一个技能的学习资源，无需静态 resources.json。
 * 好处是链接永远指向平台当前搜索结果，不会像写死的课程链接那样失效。
 *
 * 三条资源按学习路径排序，工时按 4:4:2 分配（总计约等于 costHours）：
 *   - B站视频搜索（入门，40%）
 *   - GitHub 开源项目搜索（实战，40%）
 *   - Bing 官方文档搜索（查漏，20%）
 * encodeURIComponent 保证中文技能名在 URL 里安全。
 */
export function resourcesForSkill(skill, costHours) {
  const term = encodeURIComponent(skill?.name || skill?.id || '')
  const hours = Math.max(1, Number(costHours) || 20)
  return [
    { type: 'bilibili', title: `${skill?.name || skill?.id} 入门（B站搜索）`, url: `https://search.bilibili.com/all?keyword=${term}`, hours: Math.max(1, Math.round(hours * 0.4)) },
    { type: 'github', title: `${skill?.name || skill?.id} 开源项目（GitHub 搜索）`, url: `https://github.com/search?q=${term}&type=repositories`, hours: Math.max(1, Math.round(hours * 0.4)) },
    { type: 'doc', title: `${skill?.name || skill?.id} 文档资料`, url: `https://www.bing.com/search?q=${term}%20official%20docs`, hours: Math.max(1, Math.round(hours * 0.2)) },
  ]
}

/**
 * 批量生成资源：把 skillIds 列表映射成 {skillId: resources[]}。
 * 技能定义查不到时用 {id} 兜底，仍能给出搜索链接（只是没有中文名和工时）。
 */
export function resourcesBySkill(k = readKnowledge(), skillIds = []) {
  const byId = skillsById(k)
  return Object.fromEntries((skillIds || []).map((id) => [
    id,
    resourcesForSkill(byId[id] || { id }, byId[id]?.cost_hours),
  ]))
}

// 导出路径函数供外部/测试断言知识文件位置。
export { knowledgeFile }
