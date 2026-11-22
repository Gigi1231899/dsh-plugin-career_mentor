/**
 * 技能/插件热度层：从 SkillHub、Claude Code 获取热门技能与插件。
 *
 * 关键点：按「岗位方向」的关键词抓取，并按热度使用量统一排序，
 * 而不是给一份泛泛的全平台热榜。只读公开 API / GitHub 搜索，
 * 不登录、不绕过访问控制；单平台失败不影响另一平台。
 *
 * 数据流向：
 *   directions.js 的 skill_queries/skill_terms（或工具参数 queries）
 *     → resolveSkillQueries() 解析出 {queries, terms, source}
 *     → fetchSkillHubSkills() + fetchClaudeCodeSkills() 并发抓取
 *     → 按 usage 统一降序，产出 {platforms, top, total, stale}
 *     → tools.js 的 career_skill_plugins 直接返回 / career_direction_report 写进简报第四节
 */

import { DIRECTION_OPTIONS } from './directions.js'

const TIMEOUT_MS = 8000 // 单请求 8 秒超时：避免某个平台卡住拖垮整次工具调用
const UA = 'career-mentor/0.1 (+DSH plugin)' // 统一 User-Agent，便于公开 API 侧识别来源

/**
 * 统一的 JSON GET。
 * - signal 优先用调用方传入的（exec.signal，用户中断可传播），否则用 8s 超时信号；
 * - 非 2xx 直接抛错，由上层 allSettled / try-catch 记入失败，不伪造数据。
 * @param {string} url
 * @param {{signal?: AbortSignal, headers?: object}} options
 */
async function fetchJson(url, options = {}) {
  const signal = options.signal || AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * 解析当前岗位方向的推荐查询词。优先级：
 *   1) 显式传入的 queries（工具参数覆盖最高，方便用户追问特定工具）；
 *   2) direction id 对应的 skill_queries（来自 directions.js 的运行时查询入口）；
 *   3) 目标岗位名 / 岗位 family / 专业名兜底（没有明确方向时也能给点相关结果）。
 *
 * 返回值里 queries 用于发请求，terms 用于相关度过滤（中文+英文白名单词），
 * source 记录本次用的是哪种来源，渲染层会提示"查询词来自方向/自定义/画像"。
 *
 * @param {{direction?: string, role?: object, profile?: object, queries?: string[]}} opts
 * @returns {{direction: string|null, queries: string[], terms: string[], source: 'override'|'direction'|'fallback'}}
 */
export function resolveSkillQueries({ direction = null, role = null, profile = null, queries = null } = {}) {
  // ① 显式 overrides：过滤空串、最多取 8 个；terms 与 queries 相同（无额外白名单）。
  if (Array.isArray(queries) && queries.length) {
    const qs = queries.filter(Boolean).slice(0, 8)
    return { direction: direction || null, queries: qs, terms: qs, source: 'override' }
  }
  // ② 方向目录：id 或中文 label 都能命中 DIRECTION_OPTIONS。
  const opt = DIRECTION_OPTIONS.find((o) => o.id === direction || o.label === direction)
  if (opt?.skill_queries?.length) {
    // queries 发英文请求，terms 是中英混合相关度白名单，避免语义漂移。
    return { direction: opt.id, queries: opt.skill_queries, terms: opt.skill_terms || opt.skill_queries, source: 'direction' }
  }
  // ③ 兜底：没有方向时，用岗位名/family/专业名/方向标签拼查询词；都没有就用 developer。
  const fallback = [role?.name, role?.family, profile?.major, profile?.direction_label].filter(Boolean)
  const qs = fallback.length ? fallback : ['developer']
  return { direction: direction || null, queries: qs, terms: qs, source: 'fallback' }
}

/**
 * 从 SkillHub 真实 API 抓取某岗位方向的热门技能。
 *
 * 端点来自 skillhub.cn 前端 bundle（不是猜测的地址）：
 *   GET https://api.skillhub.cn/api/skills
 *     ?page=1&pageSize=N&sortBy=score&order=desc&keyword=...
 * 响应结构：{ code: 0, data: { skills: [...], total } }。
 *
 * 为什么要做二次相关度重排：keyword 搜索有语义漂移（如 "product"
 * 命中商品图而非产品经理技能），所以抓回来后用方向白名单词打分，
 * 零相关的直接丢弃，先按相关度、再按下载量排序。
 *
 * @param {string[]} queries 发请求的关键词（英文为主）
 * @param {number} limit 每个平台保留条数
 * @param {AbortSignal} signal 取消信号
 * @param {string[]} terms 相关度白名单词（中文+英文）
 */
async function fetchSkillHubSkills(queries, limit, signal, terms = []) {
  // 相关度词为空时退回 queries，保证一定能打分。
  const termList = terms.length ? terms : queries
  const base = 'https://api.skillhub.cn/api/skills'
  const collected = new Map() // 用 slug/name 去重，同一技能只保留第一次抓到的记录

  // 取前两个查询词分别搜，扩大样本；每个词失败都只是跳过，不影响另一个。
  for (const kw of termList.slice(0, 2)) {
    const url = `${base}?page=1&pageSize=${Math.max(limit, 10)}&sortBy=score&order=desc&keyword=${encodeURIComponent(kw)}`
    try {
      const data = await fetchJson(url, { signal })
      if (data?.code !== 0) continue // API 业务错误码：跳过该词
      for (const item of data?.data?.skills || []) {
        const slug = item.slug || item.name
        if (!slug || collected.has(slug)) continue
        collected.set(slug, item)
      }
    } catch {
      // 单个关键词失败不影响其它关键词，也不记入 failed（结构层容忍）。
    }
  }

  // 相关度打分：把名称、slug、简介拼成小写字符串，命中一个白名单词 +1。
  const relevance = (item) => {
    const hay = `${item.name || ''} ${item.slug || ''} ${item.description_zh || item.description || ''}`.toLowerCase()
    let score = 0
    for (const t of termList) if (hay.includes(String(t).toLowerCase())) score += 1
    return score
  }

  return [...collected.values()]
    .map((item) => ({
      name: item.name || item.slug,
      // 用前端搜索页链接而不是 api.skillhub.cn 的 homepage：后者不是用户可点的技能页。
      url: `https://www.skillhub.cn/skills?keyword=${encodeURIComponent(item.slug || item.name || '')}`,
      usage: Number(item.downloads ?? item.installs ?? 0), // 下载/安装量作热度；缺失按 0（仅在排序用，不冒充事实展示）
      usage_label: '下载',
      rating: Number(item.score || 0),
      note: String(item.description_zh || item.description || '').replace(/\s+/g, ' ').slice(0, 80),
      platform: 'skillhub',
      query: termList.slice(0, 2).join(' / '),
      _rel: relevance(item), // 临时字段：排序后移除，不暴露给输出
    }))
    // 零相关直接丢弃：关键词命中但与岗位无关（如 product → 商品图）。
    .filter((x) => x._rel > 0)
    // 先按方向相关度，再按下载量：保证"对口"优先于"单纯热门"。
    .sort((a, b) => (b._rel - a._rel) || (b.usage - a.usage))
    .slice(0, limit)
    .map(({ _rel, ...rest }) => rest) // 去掉内部打分字段
}

/**
 * 从 GitHub 搜索 Claude Code 生态里与岗位相关的热门 skill/plugin。
 * 查询串固定前缀 "claude code skill " + 方向词，按 stars 排序（热度代理）。
 *
 * 二次过滤的原因：GitHub 搜索会返回只有 "claude"/"skill" 字样的泛泛仓库，
 * 所以要求仓库名或简介至少命中一个岗位词（把多词查询拆成单词再匹配）。
 *
 * @param {string[]} queries 方向查询词（如 ['frontend','backend']）
 * @param {number} limit 保留条数
 * @param {AbortSignal} signal 取消信号
 */
async function fetchClaudeCodeSkills(queries, limit, signal) {
  const q = queries.join(' ')
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent('claude code skill ' + q)}&sort=stars&order=desc&per_page=${limit}`
  try {
    const data = await fetchJson(url, { signal, headers: { 'User-Agent': UA } })
    // 把 'unit test' 这样的词组拆成单词，降低命中门槛。
    const terms = queries.flatMap((x) => String(x).split(/\s+/)).filter(Boolean)
    return (data.items || [])
      .map((repo) => ({
        name: repo.name,
        url: repo.html_url,
        usage: Number(repo.stargazers_count || 0), // stars 作为热度代理
        usage_label: 'Stars',
        rating: 0, // GitHub 搜索没有评分字段，显式置 0 而不是伪造
        note: String(repo.description || '').slice(0, 80),
        platform: 'claude-code',
        query: q,
      }))
      // 至少命中一个岗位词，排除泛泛的 "claude code skill" 仓库。
      .filter((item) => {
        const hay = `${item.name} ${item.note}`.toLowerCase()
        return terms.some((t) => hay.includes(t.toLowerCase()))
      })
      .slice(0, limit)
  } catch {
    return [] // 单平台失败返回空数组，由 fetchSkillPlugins 汇总为部分结果
  }
}

/**
 * 按岗位方向抓取两平台（SkillHub + Claude Code）热门技能/插件，
 * 跨平台统一按热度使用量降序，并给出 TOP 榜。
 *
 * @param {object} opts
 * @param {string} opts.direction 方向 id（dev/ops/test/pm）
 * @param {object} opts.role 目标岗位（含 name/family）
 * @param {object} opts.profile 用户画像（major/direction_label 兜底用）
 * @param {string[]} opts.queries 显式查询词覆盖
 * @param {number} opts.limit 每平台数量
 * @param {AbortSignal} opts.signal 取消信号
 * @returns {{data_as_of: string, direction: string|null, direction_label: string|null,
 *            queries: string[], query_source: string, platforms: object,
 *            top: object[], total: number, stale: boolean}}
 */
export async function fetchSkillPlugins({ direction = null, role = null, profile = null, queries = null, limit = 6, signal } = {}) {
  // ① 统一解析查询词：覆盖 > 方向 > 画像兜底。
  const resolved = resolveSkillQueries({ direction, role, profile, queries })
  // GitHub 搜索空间有限：取前两个方向词拼串，避免查询串过长命中率下降。
  const ghQuery = resolved.queries.slice(0, 2).join(' ')

  // ② 两平台并发抓取：一个失败不影响另一个（各自内部都有 try-catch）。
  const [skillhub, claudeCode] = await Promise.all([
    fetchSkillHubSkills(resolved.queries, limit, signal, resolved.terms),
    fetchClaudeCodeSkills([ghQuery], limit, signal),
  ])

  // ③ 按平台归档：渲染层依赖这两个固定键（白名单见 core.js 的 platformName）。
  const byPlatform = {
    skillhub: skillhub,
    'claude-code': claudeCode,
  }
  // ④ 跨平台合并、去无效项、统一按 usage 降序（不同平台口径不同，只作相对参考）。
  const all = [...skillhub, ...claudeCode]
    .filter((x) => x && x.name)
    .sort((a, b) => (b.usage || 0) - (a.usage || 0))

  // ⑤ 汇总返回：top 是跨平台榜单（取 limit 条），platforms 保留各平台原始条目与数量，
  //    stale=true 表示两个平台都没抓到（渲染层据此决定是否显示该节）。
  return {
    data_as_of: new Date().toISOString().slice(0, 10),
    direction: resolved.direction,
    direction_label: DIRECTION_OPTIONS.find((o) => o.id === resolved.direction)?.label || null,
    queries: resolved.queries,
    query_source: resolved.source, // 'override' | 'direction' | 'fallback'
    platforms: Object.fromEntries(Object.entries(byPlatform).map(([k, items]) => [k, { items, total: items.length }])),
    top: all.slice(0, limit),
    total: all.length,
    stale: all.length === 0,
  }
}
