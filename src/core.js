/**
 * 纯算法层：不读文件、不发网络请求、不依赖 DSH。
 *
 * 所有输入由工具层（tools.js）传入，函数确定、可单测（test/core.test.js）。
 * 分四类能力：
 *   1) 热度计算：computeTrends / industryWind（只看本次快照，不算增长率）；
 *   2) 岗位匹配：fitRole / diagnose / benefitOf / skillClosure / planRoadmap；
 *   3) 文档渲染：renderProfileCard / renderRadarMarkdown / renderDirectionReport / renderChecklist；
 *   4) 小工具：clamp / mean / heatBar / metricCell 等内部辅助。
 *
 * 具体数据来源见 src/knowledge.js（运行时知识）和 src/public-api.js（公开 API 采集）。
 */

/** 把数值限制在 [min, max]，让打分收敛到合法区间（越界会导致排序失真）。 */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 算术平均；空数组返回 0，避免 NaN 传播到最终打分。 */
function mean(values) {
  if (!values.length) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * 技术热度打分：只用本次快照的当前值，不读历史、不算增长率。
 *
 * 流程：
 *   1. 每个指标在本批话题内做 log1p 归一化：0 = 本批最低，1 = 本批最高；
 *      只在该指标有值的话题之间比较，缺值不按 0 计入；
 *   2. 按来源权重加权平均；某话题缺某指标时，该指标权重不进分母，
 *      避免"只有 1 个来源"的样本被系统性压低；
 *   3. 输出 0–1 的热度分 + 覆盖指标数（sample_n/sample_total）+ 证据链。
 *
 * @param {object} currentByTopic {[topicId]: {github_stars, npm_downloads_7d, ..., _evidence}}
 * @param {object} weights 来源权重，可覆盖默认值
 * @returns {Array<{id, score, sample_n, sample_total, metrics, evidence}>} 按 score 降序
 */

/**
 * 多来源指标权重与来源标注。指标键名即快照里的字段名；采集器只写入自己
 * 真正拿到的指标，拿不到的（如某技能没有对应 PyPI 包）留空，由下面的
 * 指标自动发现逻辑跳过，避免把"缺数据"当成 0 拉低分数。
 */
const DEFAULT_TREND_WEIGHTS = {
  github_stars: 0.28,       // 该主题 top 仓库 star 数（生态关注度）
  github_prs: 0.08,         // 该主题相关 PR 数（开发活跃度，仅明确 repo 时有）
  npm_downloads_7d: 0.20,   // npm 周下载（JS 生态使用强度）
  pypi_downloads_7d: 0.20,  // PyPI 周下载（Python 生态使用强度）
  maven_version_count: 0.05,// Maven Central 版本数（Java 生态版本活跃度，非下载量）
  so_questions_7d: 0.11,    // StackOverflow 近 30 天问题数
  hn_mentions_7d: 0.08,     // Hacker News 近 30 天帖子数
}

/** 从指标键名推导来源名，供证据链接标注（github/npm/pypi/maven/stackoverflow/hn/other）。 */
function metricToSource(key) {
  if (key.startsWith('github')) return 'github'
  if (key.startsWith('npm')) return 'npm'
  if (key.startsWith('pypi')) return 'pypi'
  if (key.startsWith('maven')) return 'maven'
  if (key.startsWith('so_')) return 'stackoverflow'
  if (key.startsWith('hn_')) return 'hn'
  return 'other'
}

/**
 * 实现见上方流程说明。核心设计点：
 * - 指标自动发现：只统计"至少一个话题拿到值且配置了权重"的指标；
 * - 归一化只对有值的条目做，缺值话题在该指标上没有 normalized 值，
 *   后续加权时直接跳过，不会被当成最低分；
 * - 全批同一指标值相等时给 0.5 中性分，避免除零和分数塌缩。
 */
export function computeTrends(currentByTopic, weights = {}) {
  const w = { ...DEFAULT_TREND_WEIGHTS, ...weights }
  const metricSet = new Set()
  for (const entry of Object.values(currentByTopic)) {
    for (const key of Object.keys(entry)) {
      if (key !== '_evidence' && w[key] !== undefined) metricSet.add(key)
    }
  }
  const keys = [...metricSet].sort() // 固定排序保证每次输出列顺序一致
  const topics = Object.keys(currentByTopic)
  const normalized = Object.fromEntries(topics.map((id) => [id, {}]))

  // 逐指标归一化：先过滤出有数值的条目，再在 log 空间做 min-max 缩放。
  for (const key of keys) {
    const entries = topics
      .map((id) => [id, Number(currentByTopic[id]?.[key])])
      .filter(([, value]) => Number.isFinite(value))
    if (!entries.length) continue
    // log1p 压住大数值的长尾，让 star 数这类指标和下载量在同一尺度上比较。
    const logs = entries.map(([, value]) => Math.log1p(Math.max(0, value)))
    const min = Math.min(...logs)
    const max = Math.max(...logs)
    for (const [id] of entries) {
      const value = Number(currentByTopic[id][key])
      const logValue = Math.log1p(Math.max(0, value))
      // 该指标在本批没有区分度时给 0.5 中性分，避免全 0 让分数塌缩。
      normalized[id][key] = max - min < 1e-9 ? 0.5 : (logValue - min) / (max - min)
    }
  }

  // 逐话题加权聚合 + 收集证据链。
  return topics.map((id) => {
    const evidence = []
    const metrics = {}
    let weighted = 0
    let weightSum = 0
    for (const key of keys) {
      const value = currentByTopic[id]?.[key]
      if (!Number.isFinite(Number(value))) continue // 缺指标：跳过，不按 0
      metrics[key] = Number(value)
      const url = currentByTopic[id]?._evidence?.[key]
      if (url) evidence.push({ source: metricToSource(key), metric: key, url, value: Number(value) })
      weighted += (w[key] || 0) * normalized[id][key]
      weightSum += w[key] || 0 // 缺指标时该权重不进分母——避免少来源样本被压低
    }
    const score = weightSum > 0 ? weighted / weightSum : 0
    return {
      id,
      score: Number(score.toFixed(4)),
      sample_n: Object.keys(metrics).length, // 实际拿到几个指标
      sample_total: keys.length,             // 本批一共发现几个指标
      metrics, // 原始值，供展示与核对
      evidence, // {source, metric, url, value}[]，供引用来源
    }
  }).sort((a, b) => b.score - a.score)
}

/**
 * 行业风向：把技术热度按运行时岗位画像的 family 聚合。
 *
 * 这是"行业层面"的视角——单个技术热不热看热度榜，一类方向整体如何看这里。
 * family 来自 career_explore 写入的 roles（模型依据公开数据构造），没有静态行业表。
 * 只有快照里的技术 id 能映射到某岗位的 skill id 时才计入，映射不到的不硬凑。
 * 档位：avg≥0.66 高、≥0.33 中、否则低。
 *
 * @param {object} snapshot 热度快照（items[] 含 id/score）
 * @param {object[]} roles 运行时岗位画像
 */
export function industryWind(snapshot, roles = []) {
  const familyBySkill = {}
  // ① 先建 skill_id → family 反查表（一个技能属于多个岗位时取第一个）。
  for (const role of roles || []) {
    if (!role?.family) continue
    for (const rs of role.skills || []) {
      if (!familyBySkill[rs.id] && role.family) familyBySkill[rs.id] = role.family
    }
  }
  // ② 遍历快照，把能映射到 family 的技术累加到对应分组。
  const groups = {}
  for (const item of snapshot?.items || []) {
    const family = familyBySkill[item.id]
    if (!family) continue // 映射不到不硬凑
    const g = groups[family] || (groups[family] = { family, score_sum: 0, count: 0, skills: [] })
    g.score_sum += Number(item.score) || 0
    g.count += 1
    g.skills.push(item.id)
  }
  // ③ 求平均、定档、按平均热度降序。
  return Object.values(groups).map((g) => {
    const avg = g.score_sum / g.count
    return {
      family: g.family,
      avg_score: Number(avg.toFixed(4)),
      skill_count: g.count,
      skills: g.skills,
      level: avg >= 0.66 ? '高' : avg >= 0.33 ? '中' : '低',
    }
  }).sort((a, b) => b.avg_score - a.avg_score)
}

/** 热度条：用方块字符把 0–1 的热度分画成条形图，满格为本批最高（12 格）。 */
function heatBar(score, maxScore) {
  const width = 12
  const n = clamp(Math.round(((Number(score) || 0) / (maxScore || 1)) * width), 0, width)
  return '█'.repeat(n) + '·'.repeat(width - n)
}

/** 相对本批最高值的档位：≥0.75 高、≥0.4 中、否则低；只表达"在本批里靠前/居中/靠后"。 */
function heatLevel(score, maxScore) {
  const ratio = (Number(score) || 0) / (maxScore || 1)
  return ratio >= 0.75 ? '高' : ratio >= 0.4 ? '中' : '低'
}

/** 热度数字格式化：千分位；非数值显示 —（破折号），不显示 NaN。 */
function fmtNumber(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US')
}

/** 原始指标列：固定顺序、固定中文名，保证每次生成的表格列稳定。 */
const METRIC_COLUMNS = [
  ['github_stars', 'GitHub stars'],
  ['npm_downloads_7d', 'npm 周下载'],
  ['pypi_downloads_7d', 'PyPI 周下载'],
  ['maven_version_count', 'Maven 版本数'],
  ['so_questions_7d', 'SO 30 天问题'],
  ['hn_mentions_7d', 'HN 30 天帖子'],
]

/**
 * 单个指标单元格：有证据 URL 就把数值渲染成可点链接，有原值没链接就显示数字，
 * 都没有显示 —（缺失不按 0 计）。供原始指标表使用（现版本 radar 已不渲染该表，
 * 但函数保留给未来需要核对原始数据的场景）。
 */
function metricCell(item, key) {
  const evidence = (item.evidence || []).find((e) => e.metric === key)
  if (evidence && evidence.value != null) return `[${fmtNumber(evidence.value)}](${evidence.url})`
  const value = item.metrics?.[key]
  if (value == null) return '—'
  return fmtNumber(value)
}

/** 掌握度档位：把 0–5 的掌握度转成短标签（熟练/已掌握/能做/入门/未开始）。 */
function masteryLabel(m) {
  if (m >= 5) return '熟练'
  if (m >= 4) return '已掌握'
  if (m >= 3) return '能做'
  if (m > 0) return '入门'
  return '未开始'
}

/** 岗位要求的技能重要度（1–5）；不属于该岗位返回 0。 */
function importanceFor(role, skillId) {
  const rs = (role?.skills || []).find((s) => s.id === skillId)
  return rs?.importance || 0
}

/**
 * 个人画像卡片：把 profile、目标岗位与技能基础渲染成固定表格。
 * 所有工作区文档共用这一节，确保用户看到的是"按自己的情况算出来的"内容。
 *
 * 如果关键画像字段（专业/年级/技能）全空且没有目标岗位，
 * 返回带 __HITL_PROFILE_NEEDED__ 标记的提示行，由上层决定是否询问用户。
 *
 * @param {object} profile 用户画像
 * @param {object|null} role 目标岗位（来自运行时知识）
 * @param {object} skillsById 技能 id → 技能定义 索引（把 id 显示成中文名）
 * @returns {string[]} Markdown 行数组（调用方 join('\n')）
 */
export function renderProfileCard(profile = {}, role = null, skillsById = {}) {
  const lines = ['## 个人画像', '']
  const major = String(profile?.major || '').trim()
  const grade = String(profile?.grade || '').trim()
  const skillEntries = Object.entries(profile?.skills || {})
  // 关键字段全空且未选岗位：返回 HITL 标记，而不是编造一份通用画像。
  if (!major && !grade && !skillEntries.length && !role) {
    lines.push('> __HITL_PROFILE_NEEDED__：请提供专业、年级、技能基础与目标岗位')
    return lines
  }
  // 截止时间换算成剩余周数（向下取整到周），NaN 时不显示。
  const weeks = profile?.deadline
    ? Math.ceil((Date.parse(profile.deadline) - Date.now()) / (7 * 86400000))
    : null
  // 技能按掌握度降序，最多显示 8 个；用技能定义里的中文名替代 id。
  const skillText = skillEntries
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, 8)
    .map(([id, v]) => `${skillsById[id]?.name || id} ${masteryLabel(Number(v))}(${Number(v) || 0}/5)`)
    .join('、') || '未填写'
  const prefText = (profile?.preference || []).join('、') || '未填写'
  const jobText = (role?.typical_jobs || []).slice(0, 3).join(' / ') // 真实职位名，最多 3 个
  lines.push('| 项目 | 内容 |', '| --- | --- |')
  lines.push(`| 专业 / 年级 | ${major || '未填写'} · ${grade || '未填写'} |`)
  lines.push(`| 岗位方向 | ${profile?.direction_label || profile?.direction || '未选择'} |`)
  lines.push(`| 目标岗位 | ${role ? role.name : '未选择'}${jobText ? `（${jobText}）` : ''} |`)
  lines.push(`| 每周投入 | ${profile?.hours_per_week ? `${Number(profile.hours_per_week)} 小时` : '未填写'} |`)
  lines.push(`| 截止时间 | ${profile?.deadline || '未填写'}${Number.isFinite(weeks) && weeks != null ? `（约 ${weeks} 周）` : ''} |`)
  lines.push(`| 技能基础 | ${skillText} |`)
  lines.push(`| 偏好 | ${prefText} |`)
  return lines
}

/**
 * 个性化优先级：岗位要求 × 你的掌握度。
 * 目标岗位要求越高、你越没掌握，优先级越高（0–1）；
 * 非目标岗技能只作"已自学"标记（给 0.05 的小正值，避免完全沉底）。
 */
export function personalPriority(profile = {}, role = null, skillId) {
  const importance = importanceFor(role, skillId)
  const mastery = masteryOf(profile, skillId)
  if (importance > 0) return Number(((importance / 5) * (1 - mastery / 5)).toFixed(3))
  return mastery > 0 ? 0.05 : 0
}

/** 关系说明：这条技术为什么与当前用户有关（目标岗要求 / 已自学 / 无关）。 */
function relationOf(profile = {}, role = null, skillId) {
  const importance = importanceFor(role, skillId)
  const mastery = masteryOf(profile, skillId)
  if (importance > 0) return `目标岗要求·重要度 ${importance}/5·${masteryLabel(mastery)}`
  if (mastery > 0) return `非目标岗·已自学 ${mastery}/5`
  return '非目标岗要求'
}

/** 建议动作：根据重要度与掌握度给出"优先补 / 保持 / 可选 / —"。 */
function actionOf(profile = {}, role = null, skillId) {
  const importance = importanceFor(role, skillId)
  const mastery = masteryOf(profile, skillId)
  if (importance > 0 && mastery < 4) return '优先补' // 目标岗要求但还没掌握（≥4 视为已掌握）
  if (importance > 0) return '保持'
  return mastery > 0 ? '可选' : '—'
}

/** 与用户相关的技术：目标岗位要求或用户已自学的，按个性化优先级降序。 */
function personalItems(profile, role, items) {
  return (items || [])
    .filter((item) => importanceFor(role, item.id) > 0 || masteryOf(profile || {}, item.id) > 0)
    .sort((a, b) => personalPriority(profile || {}, role, b.id) - personalPriority(profile || {}, role, a.id))
}

/**
 * 技术热度雷达 Markdown：个人画像 + 行业风向 + 与你的关系 + 口径边界。
 *
 * 重要变更：已删除原来的"Top10 热度总榜与原始指标表"——那不是行业也不是个人视角，
 * 与职业导师定位无关，还容易被模型当成市场排名引用。现在只有三块：
 *   一、行业风向（按岗位 family 聚合，仅当有岗位画像时显示）；
 *   二、与你的关系（按目标岗位缺口排序，给出关系/动作/重要度/掌握度）；
 *   三、口径与边界（声明只看当前值、不算增长率、缺指标显示 —）。
 *
 * @param {object} snapshot 最新热度快照
 * @param {object[]} wind industryWind() 的输出
 * @param {object|null} profile 用户画像
 * @param {object|null} role 目标岗位
 * @param {object} skillsById 技能索引
 */
export function renderRadarMarkdown(snapshot, wind = [], profile = null, role = null, skillsById = {}) {
  const items = (snapshot?.items || []).slice(0, 12) // 最多 12 条参与"与你的关系"
  const lines = [
    '# 技术热度雷达',
    '',
    `> 数据日期：${snapshot?.data_as_of || '未知'}｜stale：${snapshot?.stale ? 'true' : 'false'}｜口径：本次刷新快照，只比当前、不对比历史`,
    '',
    ...renderProfileCard(profile || {}, role, skillsById),
  ]

  // 有岗位画像才显示行业风向和与你的关系；不再渲染泛泛的 Top10 热度总榜。
  if (wind.length || role) {
    lines.push('', '## 一、行业风向（按岗位方向聚合）', '')
    if (wind.length) {
      lines.push('| 方向 | 平均热度 | 档位 | 覆盖技术数 | 代表技术 |', '| --- | --- | --- | --- | --- |')
      for (const g of wind) {
        lines.push(`| ${g.family} | ${Number(g.avg_score).toFixed(3)} | ${g.level} | ${g.skill_count} | ${g.skills.slice(0, 6).join(', ')} |`)
      }
      lines.push('', '> 方向由运行时岗位画像的 family 聚合而来；某方向覆盖的技术越多，结论越稳。')
    } else {
      lines.push('> 先选择目标岗位（`career_set_goal`）后，才能按你的岗位方向聚合行业风向。')
    }

    lines.push('', '## 二、与你的关系（按目标岗位缺口排序）', '')
    const related = personalItems(profile, role, items)
    if (related.length) {
      lines.push('| 技术 | 热度分 | 关系 | 建议动作 | 目标岗重要度 | 你的掌握度 |', '| --- | --- | --- | --- | --- | --- |')
      for (const item of related) {
        const importance = importanceFor(role, item.id)
        const mastery = masteryOf(profile || {}, item.id)
        lines.push(`| ${item.id} | ${Number(item.score).toFixed(3)} | ${relationOf(profile || {}, role, item.id)} | ${actionOf(profile || {}, role, item.id)} | ${importance ? `${importance}/5` : '—'} | ${mastery ? `${mastery}/5` : '—'} |`)
      }
    } else {
      lines.push('> 暂无匹配：先选择目标岗位（`career_set_goal`），或在 `career_explore` 中补充你的技能基础。')
    }
  } else {
    lines.push('', '> 暂无岗位画像：行业风向与「与你的关系」需要在 `career_explore` 生成岗位画像、`career_set_goal` 选定目标岗位后展示。')
  }

  // ③ 口径声明：明确"不读历史/不算增长率"，防止使用者误读为趋势预测。
  lines.push('', '## 三、口径与边界', '')
  lines.push('- 热度分 = 各指标在本批话题内做 `log1p` 归一化（0 = 本批最低，1 = 本批最高），再按来源权重加权平均；**不读取历史、不计算增长率**。')
  lines.push('- 缺失的指标显示 `—`，不按 0 计入，也不参与该技术的加权平均。')
  lines.push('- 热度分只说明“本批话题里谁更受关注”，不代表绝对市场份额或未来走势。')
  lines.push('- `stale: true` 表示整批采集失败；单个来源失败只会让对应单元格变成 `—`。')
  return lines.join('\n') + '\n'
}

/** 用户某技能的掌握度（0–5），非数值按 0 处理；clamp 防止越界。 */
function masteryOf(profile, skillId) {
  const value = profile?.skills?.[skillId]
  const n = Number(value)
  return Number.isFinite(n) ? clamp(n, 0, 5) : 0
}

/**
 * 技能闭包：岗位直接要求的技能 + 它们的全部前置技能（递归）。
 *
 * 用队列遍历 prereq 图（BFS）：从岗位要求的技能集合出发，
 * 每取一个技能就把它的前置技能加入集合和队列，直到队列空。
 * Set 去重保证每个技能只处理一次；规划时据此保证"学 A 前先学 A 的前提"。
 *
 * @returns {Set<string>} 需要学习的全部技能 id
 */
export function skillClosure(role, skillsById) {
  const target = new Set((role?.skills || []).map((s) => s.id))
  const queue = [...target]
  while (queue.length) {
    const id = queue.shift()
    const skill = skillsById[id]
    if (!skill?.prereq) continue
    for (const p of skill.prereq) {
      if (!target.has(p)) {
        target.add(p)
        queue.push(p)
      }
    }
  }
  return target
}

/**
 * 岗位契合度打分，多项加权：
 *   - 技能重合 50%：掌握度≥3 的核心技能权重占比（overlap / totalImportance）；
 *   - 偏好契合 30%：coding/analysis/communication 偏好与岗位 tags 匹配度；
 *   - 趋势信号 20%：该岗位相关技能在本次雷达里的热度均值（只取最高的 3 个代表整体）；
 *   - 趋势加成 20%：岗位自带 trend_boost（模型构造时给的判断分）；
 *   - 负反馈惩罚：用户否定过的岗位（negative_roles）扣 0.4。
 *
 * 唯一外部信号是技术热度（trendMap），不依赖任何 JD 数据。
 * 同时给出最短学习周数（缺口工时 / 每周小时数）作为排序参考。
 *
 * @returns {{role_id, name, fit_score, reason, gap_preview, min_weeks, trend_signal}}
 */
export function fitRole(profile, role, skillsById, trendMap = {}) {
  const roleSkills = role.skills || []
  const totalImportance = roleSkills.reduce((a, s) => a + (s.importance || 1), 0) || 1
  let overlap = 0
  let gapPoints = 0
  const gapPreview = []

  // ① 逐技能算重合度与缺口：掌握≥3 算已具备核心能力；缺口 = 重要度×(1−掌握度/5)。
  for (const rs of roleSkills) {
    const m = masteryOf(profile, rs.id)
    const imp = rs.importance || 1
    if (m >= 3) overlap += imp
    const gap = imp * (1 - m / 5)
    gapPoints += gap
    if (m < 4) gapPreview.push({ id: rs.id, name: skillsById[rs.id]?.name || rs.id, gap: Number(gap.toFixed(2)) })
  }

  // ② 偏好契合：用户选了 coding 就看岗位 coding_level（/5），
  //    analysis 看 math_level（/10），communication 看 people_facing（/10），累加后 clamp 到 0–1。
  const pref = new Set(profile.preference || [])
  const tags = role.tags || {}
  let fit = 0
  if (pref.has('coding')) fit += (tags.coding_level || 0) / 5
  if (pref.has('analysis')) fit += (tags.math_level || 0) / 10
  if (pref.has('communication')) fit += (tags.people_facing || 0) / 10
  fit = clamp(fit, 0, 1)

  // ③ 趋势信号：只取热度最高的 3 个技能代表整体，避免冷门长尾稀释信号。
  const trendValues = roleSkills
    .map((s) => trendMap[s.id]?.score || 0)
    .sort((a, b) => b - a)
    .slice(0, 3)
  const trend = mean(trendValues)

  // ④ 综合打分 + 负反馈惩罚，clamp 到 0–1。
  const negativePenalty = (profile.negative_roles || []).includes(role.id) ? 1 : 0
  const score = clamp(
    0.5 * (overlap / totalImportance) + 0.3 * fit + 0.2 * clamp(trend, -1, 1) + 0.2 * (role.trend_boost || 0) - 0.4 * negativePenalty,
    0,
    1
  )

  // ⑤ 最短学习周数：缺口技能的总工时（工时分×缺口系数）/ 每周投入小时数，至少 1 周。
  const hours = Math.max(1, Number(profile.hours_per_week) || 10)
  const totalCost = gapPreview.reduce((sum, g) => {
    const skill = skillsById[g.id]
    return sum + (skill?.cost_hours || 20) * (g.gap || 1)
  }, 0)
  const minWeeks = Math.max(1, Math.ceil(totalCost / hours))

  return {
    role_id: role.id,
    name: role.name,
    fit_score: Number(score.toFixed(3)),
    reason: `已掌握 ${overlap}/${totalImportance} 权重的核心技能；标签契合 ${(fit * 100).toFixed(0)}%；相关技能平均热度 ${trend.toFixed(2)}。`,
    gap_preview: gapPreview.sort((a, b) => b.gap - a.gap).slice(0, 3).map((g) => g.name), // 只展示前 3 个缺口的中文名
    min_weeks: minWeeks,
    trend_signal: trend > 0.5 ? '相关技能热度较高' : trend > 0.2 ? '相关技能热度一般' : '相关技能热度偏低',
  }
}

/**
 * 差距诊断：把岗位要求的技能排成"每学习小时收益"的优先级。
 *
 * priority = 缺口 × 热度加权 / 学习成本
 *   - gap = 重要度 × (1 − 掌握度/5)：越重要、越不会，缺口越大；
 *   - boost = 1 + 热度信号（0–1）：技术热度为正才加成，走弱不惩罚；
 *   - cost = 技能定义里的 cost_hours（缺省 20）。
 * 收益大、成本低、技术热度高的排前面；不依赖 JD。
 *
 * @returns {{top3: object[], all: object[]}}
 */
export function diagnose(profile, role, skillsById, signalWeights = {}) {
  const items = (role.skills || []).map((rs) => {
    const skill = skillsById[rs.id]
    const m = masteryOf(profile, rs.id)
    const importance = rs.importance || 1
    const gap = importance * (1 - m / 5)
    const cost = skill?.cost_hours || 20
    const boost = 1 + (signalWeights[rs.id] || 0)
    const priority = (gap * boost) / Math.max(1, cost)
    return {
      skill_id: rs.id,
      name: skill?.name || rs.id,
      gap: Number(gap.toFixed(2)),
      cost_hours: cost,
      priority: Number(priority.toFixed(4)),
      reason: signalWeights[rs.id] ? '该技能技术热度为正' : '来自岗位画像要求',
      source: signalWeights[rs.id] ? ['role', 'trend'] : ['role'], // 证据来源标注
    }
  })
  items.sort((a, b) => b.priority - a.priority)
  return { top3: items.slice(0, 3), all: items }
}

/** 规划排序用的单点收益：缺口 × 热度加权（成本在调用处单独相除得到"收益/成本"）。 */
export function benefitOf(skillId, importance, profile, signalWeights = {}) {
  const m = masteryOf(profile, skillId)
  return (importance || 1) * (1 - m / 5) * (1 + (signalWeights[skillId] || 0))
}

/** 构造带 code 的环检测错误，供上层返回 GRAPH_CYCLE 而不是崩溃。 */
function cycleError() {
  const err = new Error('GRAPH_CYCLE')
  err.code = 'GRAPH_CYCLE'
  return err
}

/**
 * 按截止时间生成学习路线图：
 *   1. 掌握度≥4 的技能视为已完成，其余连同前置技能（skillClosure）构成待学集合；
 *   2. 拓扑排序：每轮只在"前置已满足"的技能里挑性价比最高的（benefit/cost），
 *      无候选说明 prereq 成环，抛 GRAPH_CYCLE；
 *   3. 把有序技能按工时切成若干阶段，每阶段约 2 周且不超过 horizonWeeks；
 *   4. 每阶段带产出物与验收标准，保证可执行而非抽象清单。
 *
 * @param {object} profile 用户画像（skills / hours_per_week）
 * @param {object} role 目标岗位
 * @param {object} skillsById 技能索引
 * @param {number} horizonWeeks 距截止日期的周数，决定阶段数上限；<1 抛 DEADLINE_PASSED
 * @param {object} signalWeights 技术热度加权（正值加成）
 * @returns {{stages: object[], coverage: number, sequence: string[]}}
 */
export function planRoadmap(profile, role, skillsById, horizonWeeks, signalWeights = {}) {
  if (!horizonWeeks || horizonWeeks < 1) {
    const err = new Error('DEADLINE_PASSED')
    err.code = 'DEADLINE_PASSED'
    throw err // 工具层捕获后返回 fail('DEADLINE_PASSED', ...)
  }

  // ① 已完成集合：掌握度≥4 视为已掌握，不再排入学习。
  const done = new Set(
    Object.entries(profile.skills || {})
      .filter(([, v]) => Number(v) >= 4)
      .map(([k]) => k)
  )
  // ② 待学集合：技能闭包的补集；importance 缺省 3（前置技能可能不在岗位要求里）。
  const need = new Map()
  const target = skillClosure(role, skillsById)
  for (const id of target) {
    if (done.has(id)) continue
    const rs = (role.skills || []).find((s) => s.id === id)
    const importance = rs?.importance || 3
    need.set(id, importance)
  }

  // ③ 拓扑排序：每轮挑"前置已满足"里收益/成本最高者。
  const sequence = []
  while (need.size) {
    const candidates = [...need.entries()].filter(([id]) => {
      const prereq = skillsById[id]?.prereq || []
      // 前置要么已完成，要么不在待学集合里（说明已处理过/无需学）。
      return prereq.every((p) => done.has(p) || !need.has(p))
    })
    if (!candidates.length) throw cycleError() // 候选为空 = prereq 图成环
    candidates.sort((a, b) => {
      const ratioA = benefitOf(a[0], a[1], profile, signalWeights) / Math.max(1, skillsById[a[0]]?.cost_hours || 20)
      const ratioB = benefitOf(b[0], b[1], profile, signalWeights) / Math.max(1, skillsById[b[0]]?.cost_hours || 20)
      return ratioB - ratioA // 降序：性价比高的优先
    })
    const [chosen] = candidates[0]
    sequence.push(chosen)
    done.add(chosen) // 标记为已完成，解锁依赖它的后续技能
    need.delete(chosen)
  }

  // ④ 切阶段：总工时 / (每周小时×2) = 阶段数（每阶段约 2 周），clamp 到 [1, horizonWeeks]。
  const totalCost = sequence.reduce((sum, id) => sum + (skillsById[id]?.cost_hours || 20), 0)
  const hours = Math.max(1, Number(profile.hours_per_week) || 10)
  const stageCount = clamp(Math.ceil(totalCost / (hours * 2)), 1, horizonWeeks)
  const budget = Math.max(1, Math.ceil(totalCost / stageCount)) // 每阶段的工时预算
  const stages = []
  let bucket = []
  let bucketCost = 0

  // flush：把当前 bucket 固化成一个阶段；周次按阶段序号推进（第 1–2 周、第 3–4 周…）。
  const flush = () => {
    if (!bucket.length) return
    const start = stages.length * 2 + 1
    const end = Math.min(horizonWeeks, start + 1)
    const names = bucket.map((id) => skillsById[id]?.name || id)
    stages.push({
      index: stages.length + 1,
      weeks: start === end ? `第 ${start} 周` : `第 ${start}–${end} 周`,
      goal: `补齐 ${names.join('、')}`,
      skills: [...bucket],
      deliverable: `完成一个能体现 ${names.slice(0, 2).join('、')} 的小项目，并写出实现说明。`,
      acceptance: '项目可运行；能说清关键步骤；用 10 个自测问题或用例验证。',
      sources: ['role', 'roadmap'], // 证据来源标注
    })
    bucket = []
    bucketCost = 0
  }

  // 按 sequence 顺序装桶，达到预算且还有阶段额度就 flush；最后剩余项统一 flush。
  for (const id of sequence) {
    bucket.push(id)
    bucketCost += skillsById[id]?.cost_hours || 20
    if (bucketCost >= budget && stages.length < stageCount - 1) flush()
  }
  flush()

  // ⑤ 覆盖率：已排入序列的技能重要度之和 / 岗位要求总重要度，clamp 到 0–1。
  //    这里只统计能在技能定义里查到的技能（skill.cost_hours 存在视为有效定义）。
  const covered = sequence.reduce((sum, id) => {
    const skill = skillsById[id]
    const imp = (role.skills || []).find((s) => s.id === id)?.importance || 3
    return sum + imp * (skill?.cost_hours ? 1 : 0)
  }, 0)
  const targetImportance = (role.skills || []).reduce((sum, s) => sum + (s.importance || 1), 0) || 1

  return {
    stages,
    coverage: Number(clamp(covered / targetImportance, 0, 1).toFixed(2)),
    sequence,
  }
}

/**
 * 生成"方向简报"：HITL 选定岗位方向后的一页式报告，回答三件事——
 *   ① TOP15 热门库/包（项目名、README 摘要、Stars、下载量、链接）
 *   ② 需求最旺盛的库/包类别（代表包周下载合计）
 *   ③ 新工具 vs 新框架分栏展示（含公司归属、安装/下载地址）
 * 另加两节：④ 按岗位热度排序的 Skill/Plugin 推荐（零命中整节不渲染，
 * 白名单只认 skillhub / claude-code）；⑤ 下一步（按画像给缺口）；⑥ 口径与边界。
 *
 * 每个结论都带可点击的官方链接；解释只复述采集到的结构化事实不编造；
 * 全部基于本次抓取的当前值，不引用历史基线、不渲染增长率。
 *
 * @param {object} opts {direction, profile, role, skillsById, libraries, demand, platforms, skillPlugins}
 * @returns {string} Markdown 全文
 */
export function renderDirectionReport({ direction = null, profile = null, role = null, skillsById = {}, libraries = null, demand = null, platforms = null, skillPlugins = null } = {}) {
  const label = direction?.label || profile?.direction_label || '未指定方向'

  /** 下载量文本：npm / PyPI 各带官方核对链接的格式化值；都没取到返回 null（渲染层显示指标缺失）。 */
  const downloadText = (downloads) => {
    const parts = []
    if (downloads?.npm?.value != null) parts.push(`npm ${fmtNumber(downloads.npm.value)}`)
    if (downloads?.pypi?.value != null) parts.push(`PyPI ${fmtNumber(downloads.pypi.value)}`)
    return parts.join(' · ') || null
  }

  /** 安装地址单元格：URL 渲染成可点链接，命令渲染成行内代码，空值显示 —。 */
  const installCell = (install) => {
    const text = String(install || '').trim()
    if (!text) return '—'
    return /^https?:\/\//.test(text) ? `[安装/下载](${text})` : `\`${text}\``
  }

  // 平台展示名 + 白名单：任何其它平台键（包括旧缓存里的 codebuddy）都不渲染。
  const platformName = { skillhub: 'SkillHub', 'claude-code': 'Claude Code' }

  const lines = [
    `# ${label}方向 · 热点简报`,
    '',
    // 头部给四类数据的日期，便于判断哪些部分陈旧/缺失。
    `> 生成日期：${new Date().toISOString().slice(0, 10)}｜库/包：${libraries?.data_as_of || '未抓取'}｜类别：${demand?.data_as_of || '未抓取'}｜工具：${platforms?.data_as_of || '未抓取'}｜技能插件：${skillPlugins?.data_as_of || '未抓取'}`,
    '',
    ...renderProfileCard(profile || {}, role, skillsById),
  ]
  if (direction?.blurb) lines.push('', `> ${label}方向：${direction.blurb}`)

  // ① 热门库/包：用「榜单条目卡片」逐条展开，而不是一张宽表。
  //    每条含：可点名称、README 摘要（压缩到 120 字）、Stars、下载量。
  lines.push('', '---', '', '## 一、热门库 / 包 TOP15', '')
  lines.push('> 按 GitHub stars 排序，stars 体现生态关注度；下载量体现真实使用强度。两者都看，避免只看星标。', '')
  const libs = (libraries?.items || []).slice(0, 15)
  if (!libs.length) {
    lines.push('> 样本不足：本次未抓到库/包数据，检查网络后重试 `career_direction_report`。')
  } else {
    libs.forEach((item, i) => {
      const stars = item.stars != null ? `⭐ ${fmtNumber(item.stars)}` : null
      const dl = downloadText(item.downloads)
      const metrics = [stars, dl].filter(Boolean).join('　｜　') || '指标缺失'
      const summary = String(item.readme_summary || item.description || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '暂无简介'
      lines.push(`**${i + 1}. [${item.name}](${item.url})**`)
      lines.push(`　${summary}`)
      lines.push(`　<sub>${metrics}</sub>`)
      lines.push('')
    })
  }

  // ② 需求类别：用「横向热度条 + 代表包」呈现，强弱一眼可见。
  //    total_downloads 为 null 时显示 —（样本不足），不冒充 0；热度条以最大值为 20 格满格。
  lines.push('---', '', '## 二、需求最旺盛的库 / 包类别', '')
  lines.push('> 按类别内代表包的 npm / PyPI 周下载合计排名，反映该方向真实用工需求强弱。', '')
  const cats = demand?.categories || []
  if (!cats.length) {
    lines.push('> 样本不足：类别目录为空或抓取失败。')
  } else {
    const maxTotal = Math.max(1, ...cats.map((c) => Number(c.total_downloads) || 0))
    cats.forEach((cat, i) => {
      const total = Number(cat.total_downloads)
      const bar = Number.isFinite(total) ? '█'.repeat(Math.max(1, Math.round((total / maxTotal) * 20))) : ''
      const reps = (cat.packages || []).filter((p) => p.value != null).slice(0, 5)
        .map((p) => `[${p.name}](${p.url})`).join(' · ') || '样本不足'
      lines.push(`**${i + 1}. ${cat.label}**　\`${cat.total_downloads != null ? fmtNumber(total) : '—'} 次/周\``)
      lines.push(`　${bar}`)
      lines.push(`　代表包：${reps}`)
      lines.push('')
    })
  }

  // ③ 新工具 vs 新框架：按 kind 分栏，每条含公司归属、最新版本（可点）、发行日期、用途、安装地址。
  const platformItems = platforms?.items || []
  const tools = platformItems.filter((p) => p.kind !== 'framework') // 非 framework 视为工具
  const frameworks = platformItems.filter((p) => p.kind === 'framework')
  const renderPlatformBlock = (title, items, emptyText) => {
    lines.push(`### ${title}`, '')
    if (!items.length) { lines.push(`> ${emptyText}`, ''); return }
    for (const p of items) {
      const release = p.tag ? `[${p.tag}](${p.release_url})` : '—'
      const note = String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      lines.push(`- **${p.name}**　·　归属：${p.company || '—'}　·　最新：${release}（${p.released_at || '—'}）`)
      lines.push(`  - 用途：${note || '—'}`)
      lines.push(`  - ${installCell(p.install)}`)
    }
    lines.push('')
  }
  lines.push('---', '', '## 三、新工具 vs 新框架', '')
  lines.push('> 工具偏向「拿来即用」，框架偏向「在其上构建」；两者分开列出，各带公司归属与安装/下载地址。', '')
  renderPlatformBlock('3.1 新工具', tools, '暂无工具类发行数据')
  renderPlatformBlock('3.2 新框架', frameworks, '暂无框架类发行数据')

  // ④ 按岗位方向的 skill/plugin 热度推荐：按使用量跨平台统一排序。
  //    没有任何命中时不渲染这一节（也不摆"样本不足"空表），避免无意义的占位。
  const top = skillPlugins?.top || []
  // 白名单：只认 SkillHub 与 Claude Code，任何其它平台键（含旧缓存）一律不渲染。
  const allowed = top.filter((item) => Object.hasOwn(platformName, item.platform))
  if (allowed.length) {
    lines.push('---', '', '## 四、按岗位的 Skill / Plugin 热度推荐', '')
    if (skillPlugins?.queries?.length) {
      // 查询词来源标注：方向 / 自定义覆盖 / 画像兜底，让用户知道推荐依据。
      lines.push(`> 查询词（来自${skillPlugins.query_source === 'direction' ? `「${label}」方向` : skillPlugins.query_source === 'override' ? '自定义' : '画像'}）：${skillPlugins.queries.map((q) => `\`${q}\``).join(' ')}`, '')
    }
    allowed.forEach((item, i) => {
      const plat = platformName[item.platform]
      const usage = `${item.usage_label || '热度'} ${fmtNumber(item.usage)}`
      const note = String(item.note || '').replace(/\s+/g, ' ').trim().slice(0, 70)
      lines.push(`**${i + 1}. [${item.name}](${item.url})**　·　${plat}　·　🔥 ${usage}`)
      if (note) lines.push(`　${note}`)
      lines.push('')
    })
    // 覆盖统计只列真正有结果的白名单平台，0 结果或其它平台不出现。
    const byPlat = Object.entries(skillPlugins?.platforms || {})
      .filter(([k, v]) => Object.hasOwn(platformName, k) && Number(v.total) > 0)
      .map(([k, v]) => `${platformName[k]} ${v.total}`).join(' · ')
    if (byPlat) lines.push(`<sub>覆盖：${byPlat}</sub>`, '')
  }

  // ⑤ 下一步：有目标岗位就按画像给 top3 缺口；没有就引导先 explore 构造候选岗位。
  lines.push('---', '', '## 五、下一步（结合你的画像）', '')
  if (role) {
    const gaps = diagnose(profile || {}, role, skillsById, {}).top3 // 不加热度信号，纯看画像缺口
    if (gaps.length) {
      lines.push('| 优先补的技能 | 缺口 | 预计学时 |', '| --- | --- | --- |')
      for (const g of gaps) lines.push(`| ${g.name} | ${g.gap} | ${g.cost_hours} 小时 |`)
      lines.push('', '> 缺口 = 目标岗位要求 × 未掌握程度；完整路线图用 `career_plan`（需绑定 deadline）。')
    } else {
      lines.push('> 目标岗位暂无可诊断的技能缺口，可用 `career_radar` 跟进技术风向。')
    }
  } else {
    lines.push('- 下一步用 `career_explore` 构造该方向的候选岗位，选定 goal_role 后可进入规划模式。')
    lines.push('- 追问某个库/工具的用法时，只引用上方链接，不新增事实。')
  }

  // ⑥ 口径与边界：防止把相对热度误读为市场统计，声明不做历史对比。
  lines.push('', '## 六、口径与边界', '')
  lines.push('- 库/包按 GitHub stars 排序，下载量来自 npm / PyPI 近 7 天统计，点击名称可核对来源；`—` 表示没取到，不算 0。')
  lines.push('- 类别排名为类别内代表包周下载合计，只是查询入口，不代表全市场统计。')
  lines.push('- 新工具 / 新框架的划分来自入口清单标注（kind），公司归属为公开常识标注，最新发行来自 GitHub Releases。')
  lines.push('- Skill / Plugin 按岗位方向关键词抓取，跨平台按使用量（下载 / stars / 浏览）统一降序；不同平台热度口径不同，仅作相对参考。')
  lines.push('- `stale: true` 表示对应部分整批抓取失败；本报告只反映抓取当天的当前值，不做历史对比、不计算增长率。')
  return lines.join('\n') + '\n'
}

/**
 * 把路线图渲染成 Markdown：开头给口径，正文是分阶段表格（五列），末尾给执行说明。
 * 资源由调用方提供（resourcesBySkill 生成的搜索链接），最多每阶段显示 3 条。
 *
 * @param {object} plan 路线图（stages[] 含 index/skills/weeks/acceptance）
 * @param {object} resourcesBySkill {skillId: resources[]}
 * @param {object} meta {data_as_of, stale, plan_id, profile, role, skillsById}
 */
export function renderChecklist(plan, resourcesBySkill = {}, meta = {}) {
  const lines = [
    '# 学习清单',
    '',
    `> 数据日期：${meta.data_as_of || '未知'}｜stale：${meta.stale ? 'true' : 'false'}｜计划：${meta.plan_id || '—'}`,
    '',
    ...renderProfileCard(meta.profile || plan.profile_snapshot || {}, meta.role || null, meta.skillsById || {}),
    '',
    '## 分阶段路线图',
    '',
    '| 阶段 | 技能 | 资源 | 建议完成时间 | 验收标准 |',
    '| --- | --- | --- | --- | --- |',
  ]
  // 逐阶段：把该阶段每个技能的资源链接拼起来，最多取前 3 条，没有显示"样本不足"。
  for (const stage of plan.stages || []) {
    const links = []
    for (const id of stage.skills || []) {
      for (const r of resourcesBySkill[id] || []) {
        links.push(`[${r.title}](${r.url})`)
      }
    }
    lines.push(
      `| ${stage.index} | ${(stage.skills || []).join(', ')} | ${links.slice(0, 3).join(' / ') || '样本不足'} | ${stage.weeks} | ${stage.acceptance} |`
    )
  }
  lines.push('', '## 执行说明', '')
  lines.push('- 每个阶段约 2 周，按顺序推进；前一阶段的验收标准通过后再进入下一阶段。')
  lines.push('- 资源链接是按技能名生成的搜索入口，点开后再挑选当前可用的教程与项目。')
  lines.push('- 每周复盘时调用 `career_review` 记录完成情况，路线图会按剩余时间自动重排。')
  return lines.join('\n') + '\n'
}
