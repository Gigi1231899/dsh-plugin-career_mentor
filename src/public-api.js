/**
 * 联网层：只访问实测可直连的公开 API，不爬取任何网页正文、不获取登录态。
 *
 * 三类公开数据：
 *   1) 技术热度：GitHub 仓库 star / PR、PyPI、npm、Maven Central、StackOverflow、HN；
 *   2) AI 平台动向：GitHub Releases API（官方仓库的发行说明元数据，非网页抓取）；
 *   3) 方向简报采集：GitHub 仓库搜索 + README 摘要 + npm/PyPI 周下载 + 类别需求。
 *
 * 所有请求都带超时与取消信号；单源失败记入 failed，不拖垮整批。
 * Maven Central 的公开 Solr API 不提供下载量，只有版本数，因此用 versionCount
 * 作为"版本活跃度"信号并在快照里标注单位，绝不把版本数冒充下载量。
 *
 * 重要原则：拿不到数据就抛错或留 null，由上层记入失败并跳过该指标，
 * 绝不伪造 0 —— 0 会被当成"真实观测值"参与打分和排名，造成误导。
 */

import { computeTrends } from './core.js'

const TIMEOUT_MS = 8000 // 单请求超时：公开 API 偶尔很慢，不能让一次工具调用卡死
const UA = 'career-mentor/0.1 (+DSH plugin)' // 统一 User-Agent，便于 API 侧识别来源

/**
 * 统一的 JSON GET。
 * - signal 优先用调用方传入的（exec.signal，用户中断可传播到底层 fetch），
 *   否则用 8s 超时信号；
 * - 非 2xx 直接抛错（含状态码），由上层 allSettled / try-catch 记入失败。
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
      ...(options.headers || {}), // 允许调用方覆盖（GitHub README 需要 raw 类型）
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/**
 * 统一的文本 GET：GitHub README raw 接口返回的是纯文本而非 JSON。
 * 与 fetchJson 同样的超时/取消/错误处理策略。
 */
async function fetchText(url, options = {}) {
  const signal = options.signal || AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetch(url, {
    signal,
    headers: {
      'User-Agent': UA,
      ...(options.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.text()
}

/**
 * 时间窗口起点（Unix 秒），用于 HN / SO 等按秒过滤的接口。
 * 例：daysAgo(30) 返回 30 天前的时间戳，接口用它过滤 created_at_i / fromdate。
 */
function daysAgo(days) {
  return Math.floor(Date.now() / 1000) - days * 86400
}

/**
 * 以下每个采集器都遵循同一契约：
 *   - 输入 topic（来自 topicsFromSkills）+ signal；
 *   - 返回一个 { value: number, evidence: string }，value 是原始指标，evidence 是可点开的来源 URL；
 *   - 取不到值就抛错（由上层记入 failed 并跳过该指标），不伪造 0。
 */

/**
 * GitHub star：搜索该主题最热仓库，取 star 数，证据指向仓库主页。
 * q 限定 in:name,description 避免 topic 标签搜不到时的泛匹配；sort=stars 取第一名。
 */
async function fetchGithubStars(topic, signal) {
  const q = encodeURIComponent(`${topic.github_query || topic.id} in:name,description`)
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=1`
  const data = await fetchJson(url, { signal, headers: { 'User-Agent': UA } })
  const top = data.items?.[0]
  if (!top) throw new Error('NO_REPO') // 搜不到仓库：该指标缺失，不是 0
  return { value: top.stargazers_count || 0, evidence: top.html_url || url }
}

/**
 * GitHub open PR：仅当话题显式声明 github_repo（owner/name）时查询，
 * 否则抛 NO_REPO_DECLARED —— 不能凭主题名猜仓库，猜错会得出错误活跃度。
 */
async function fetchGithubPrs(topic, signal) {
  if (!topic.github_repo) throw new Error('NO_REPO_DECLARED')
  const q = encodeURIComponent(`repo:${topic.github_repo} is:pr is:open`)
  const url = `https://api.github.com/search/issues?q=${q}&per_page=1`
  const data = await fetchJson(url, { signal, headers: { 'User-Agent': UA } })
  // total_count 在搜索结果里，per_page=1 只取计数足够，不拉全部条目。
  return { value: data.total_count || 0, evidence: `https://github.com/${topic.github_repo}/pulls` }
}

/** PyPI 包近一周下载量（Python 生态使用强度），证据指向 pypistats 用户页。 */
async function fetchPypi(topic, signal) {
  const pkg = encodeURIComponent(topic.pypi_package || topic.id)
  const url = `https://pypistats.org/api/packages/${pkg}/recent`
  const data = await fetchJson(url, { signal })
  return { value: data.data?.last_week || 0, evidence: `https://pypistats.org/packages/${pkg}` }
}

/** npm 包近一周下载量（JS 生态使用强度），证据指向 npm 包页。 */
async function fetchNpm(topic, signal) {
  const pkg = encodeURIComponent(topic.npm_package || topic.id)
  const url = `https://api.npmjs.org/downloads/point/last-week/${pkg}`
  const data = await fetchJson(url, { signal })
  return { value: data.downloads || 0, evidence: `https://www.npmjs.com/package/${pkg}` }
}

/**
 * Maven Central：版本数（版本活跃度，非下载量）。
 * 仅当话题声明 maven_artifact 时查询；Solr 接口用 a: artifactId 检索。
 * 返回 versionCount 并在快照 metric_units 里标注 "versions (not downloads)"。
 */
async function fetchMaven(topic, signal) {
  if (!topic.maven_artifact) throw new Error('NO_ARTIFACT_DECLARED')
  const q = encodeURIComponent(`a:${topic.maven_artifact}`)
  const url = `https://search.maven.org/solrsearch/select?q=${q}&rows=1&wt=json`
  const data = await fetchJson(url, { signal })
  const doc = data.response?.docs?.[0]
  if (!doc) throw new Error('NO_ARTIFACT')
  return {
    value: doc.versionCount || 0,
    evidence: `https://central.sonatype.com/search?q=${encodeURIComponent(topic.maven_artifact)}`,
  }
}

/** Stack Overflow 近 30 天相关问题数；fromdate 用秒级时间戳，证据指向标签页。 */
async function fetchSo(topic, signal) {
  const tag = encodeURIComponent(topic.so_tag || topic.id)
  const from = daysAgo(30)
  const url = `https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&fromdate=${from}&tagged=${tag}&pagesize=1&filter=default`
  const data = await fetchJson(url, { signal })
  // total 是总数；items.length 兜底（某些响应不带 total 时用单页条数）。
  return { value: data.total || data.items?.length || 0, evidence: `https://stackoverflow.com/questions/tagged/${tag}` }
}

/** Hacker News 近 30 天相关帖子数；Algolia 接口用 numericFilters 过滤时间。 */
async function fetchHn(topic, signal) {
  const query = encodeURIComponent(topic.hn_query || topic.name || topic.id)
  const from = daysAgo(30)
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&numericFilters=created_at_i%3E${from}&hitsPerPage=1`
  const data = await fetchJson(url, { signal })
  return { value: data.nbHits || 0, evidence: `https://hn.algolia.com/?q=${query}` }
}

/**
 * 每个话题的采集任务表：[快照字段名, 来源名, 采集函数]。
 * 键名与 core.js 的 DEFAULT_TREND_WEIGHTS 一一对应，computeTrends 靠这个约定识别指标。
 */
const METRIC_TASKS = [
  ['github_stars', 'github', fetchGithubStars],
  ['github_prs', 'github', fetchGithubPrs],
  ['pypi_downloads_7d', 'pypi', fetchPypi],
  ['npm_downloads_7d', 'npm', fetchNpm],
  ['maven_version_count', 'maven', fetchMaven],
  ['so_questions_7d', 'stackoverflow', fetchSo],
  ['hn_mentions_7d', 'hn', fetchHn],
]

/**
 * 刷新技术信号：对每个话题并发请求各来源，用 allSettled 保证单点失败不影响其他。
 *
 * 流程：
 *   1. selected = 前 limit 个话题（控制请求量）；
 *   2. 每个话题对 7 个指标并发发请求；成功的写入 entry[指标名] + entry._evidence[指标名]，
 *      失败的写入 failed[{topic, source, reason}]；
 *   3. 全部话题抓完后交给 computeTrends 按"本次快照当前值"归一化打分排序；
 *   4. stale 仅在"所有话题的所有指标都失败"时为 true（整批失效），部分失败不算 stale。
 *
 * @param {{topics: object[], weights?: object, limit?: number, signal?: AbortSignal}} opts
 */
export async function refreshData({ topics, weights, limit = 12, signal } = {}) {
  const selected = (topics || []).slice(0, limit)
  const failed = []
  const currentByTopic = {}
  const sources = ['github', 'pypi', 'npm', 'maven', 'stackoverflow', 'hn']

  await Promise.all(selected.map(async (topic) => {
    // 先建 Promise 数组，再统一 allSettled：任何一个 rejection 都不会中断其他指标。
    const tasks = METRIC_TASKS.map(([key, , fn]) => [key, fn(topic, signal)])
    const settled = await Promise.allSettled(tasks.map(([, p]) => p))
    const entry = { _evidence: {} } // _evidence 是 computeTrends 约定的证据字段

    settled.forEach((result, i) => {
      const [key] = tasks[i]
      const source = METRIC_TASKS[i][1]
      if (result.status === 'fulfilled') {
        entry[key] = result.value.value
        entry._evidence[key] = result.value.evidence
      } else {
        // 记录失败原因，渲染层会把该指标显示为 —，而不是 0。
        failed.push({ topic: topic.id, source, reason: String(result.reason?.message || result.reason) })
      }
    })
    currentByTopic[topic.id] = entry
  }))

  const items = computeTrends(currentByTopic, weights) // 纯算法，见 core.js
  const fetchedAt = new Date().toISOString()
  return {
    schema_version: 3,
    metric_units: {
      // 单位标注：消费端据此显示，避免把"版本数"误读为"下载量"。
      github_stars: 'stars', github_prs: 'open PRs',
      pypi_downloads_7d: 'downloads/week', npm_downloads_7d: 'downloads/week',
      maven_version_count: 'versions (not downloads)',
      so_questions_7d: 'questions/30d', hn_mentions_7d: 'stories/30d',
    },
    fetched_at: fetchedAt,
    data_as_of: fetchedAt.slice(0, 10),
    // 所有请求都失败才算整批 stale；部分源失败只是单元格缺失。
    stale: failed.length === METRIC_TASKS.length * selected.length,
    sources,
    failed,
    items,
  }
}

/**
 * 默认观察的 AI Agent 平台（官方 GitHub 仓库）。
 *
 * 这只是"去哪读官方发行说明"的入口清单，数据全部来自 GitHub Releases API，
 * 不抓取网页；docs_url 是给用户点的官方入口，不是被访问的目标。
 * 字段说明：
 * - kind：tool / framework，决定渲染到"新工具"还是"新框架"栏；
 * - company：公司归属（公开常识标注），展示用；
 * - install：官方安装/下载入口（命令或 URL），仅展示，不代用户执行；
 * - note：一句话用途说明；repo：GitHub 仓库全名（owner/name）。
 * 调用方可通过 repos 参数覆盖 / 扩充，避免清单本身过时。
 */
export const DEFAULT_AI_PLATFORMS = [
  { id: 'langchain', name: 'LangChain', repo: 'langchain-ai/langchain', kind: 'framework', company: 'LangChain Inc.', install: 'pip install langchain', docs: 'https://python.langchain.com/docs/', note: 'LLM 应用编排框架，生态最广' },
  { id: 'langgraph', name: 'LangGraph', repo: 'langchain-ai/langgraph', kind: 'framework', company: 'LangChain Inc.', install: 'pip install langgraph', docs: 'https://langchain-ai.github.io/langgraph/', note: '有状态多智能体工作流' },
  { id: 'openai-agents', name: 'OpenAI Agents SDK', repo: 'openai/openai-agents-python', kind: 'framework', company: 'OpenAI', install: 'pip install openai-agents', docs: 'https://openai.github.io/openai-agents-python/', note: '官方轻量多智能体 SDK' },
  { id: 'adk', name: 'Google ADK', repo: 'google/adk-python', kind: 'framework', company: 'Google', install: 'pip install google-adk', docs: 'https://google.github.io/adk-docs/', note: 'Google Agent Development Kit' },
  { id: 'crewai', name: 'CrewAI', repo: 'crewAIInc/crewAI', kind: 'framework', company: 'CrewAI Inc.', install: 'pip install crewai', docs: 'https://docs.crewai.com/', note: '角色分工式多智能体' },
  { id: 'autogen', name: 'AutoGen', repo: 'microsoft/autogen', kind: 'framework', company: 'Microsoft', install: 'pip install autogen-agentchat', docs: 'https://microsoft.github.io/autogen/', note: '微软多智能体对话框架' },
  { id: 'mcp', name: 'Model Context Protocol', repo: 'modelcontextprotocol/servers', kind: 'tool', company: 'Anthropic（开放标准）', install: 'https://modelcontextprotocol.io', docs: 'https://modelcontextprotocol.io/', note: '模型与工具连接的开放协议' },
  { id: 'dify', name: 'Dify', repo: 'langgenius/dify', kind: 'tool', company: 'LangGenius', install: 'https://docs.dify.ai/getting-started/install-self-hosted', docs: 'https://docs.dify.ai/', note: '可视化 LLM 应用开发平台' },
  { id: 'ollama', name: 'Ollama', repo: 'ollama/ollama', kind: 'tool', company: 'Ollama', install: 'https://ollama.com/download', docs: 'https://ollama.com/docs', note: '本地运行大模型的命令行工具' },
]

/**
 * 采集 AI 平台最新动向：读取各官方仓库的 GitHub Releases（公开 API 元数据）。
 * 每个仓库 1 次请求，取最近一条发行版：版本号、发布时间、发行说明摘要、链接。
 * 不抓网页正文、不需要登录；失败的单平台记入 failed，但仍保留官方入口链接，
 * 让用户至少能拿到学习/实践地址。
 *
 * @param {{repos?: object[], limit?: number, signal?: AbortSignal}} opts repos 可覆盖默认清单
 */
export async function fetchPlatformNews({ repos, limit = 8, signal } = {}) {
  const selected = (repos && repos.length ? repos : DEFAULT_AI_PLATFORMS).slice(0, limit)
  const failed = []
  const items = []

  await Promise.all(selected.map(async (p) => {
    const url = `https://api.github.com/repos/${p.repo}/releases?per_page=1`
    try {
      const data = await fetchJson(url, { signal, headers: { 'User-Agent': UA } })
      // releases 接口返回数组，取第一条即最近发行版；没有发行版时 rel=null。
      const rel = Array.isArray(data) ? data[0] : null
      items.push({
        id: p.id, name: p.name,
        kind: p.kind || 'tool', company: p.company || '—',
        install: p.install || p.docs || `https://github.com/${p.repo}#readme`,
        repo: p.repo,
        repo_url: `https://github.com/${p.repo}`,
        docs_url: p.docs || `https://github.com/${p.repo}#readme`,
        note: p.note || '',
        tag: rel?.tag_name || null, // 版本号
        released_at: rel?.published_at?.slice(0, 10) || null, // 只保留日期
        release_url: rel?.html_url || `https://github.com/${p.repo}/releases`,
        release_notes: rel?.body ? String(rel.body).replace(/\s+/g, ' ').slice(0, 160) : '', // 摘要压成单行
      })
    } catch (err) {
      failed.push({ platform: p.id, reason: String(err?.message || err) })
      // 发行版读不到仍保留官方入口：用户至少能拿到学习/实践链接（不显示版本信息）。
      items.push({
        id: p.id, name: p.name,
        kind: p.kind || 'tool', company: p.company || '—',
        install: p.install || p.docs || `https://github.com/${p.repo}#readme`,
        repo: p.repo,
        repo_url: `https://github.com/${p.repo}`,
        docs_url: p.docs || `https://github.com/${p.repo}#readme`,
        note: p.note || '', tag: null, released_at: null,
        release_url: `https://github.com/${p.repo}/releases`, release_notes: '',
      })
    }
  }))

  const fetchedAt = new Date().toISOString()
  return {
    schema_version: 1,
    fetched_at: fetchedAt,
    data_as_of: fetchedAt.slice(0, 10),
    stale: failed.length === selected.length, // 全平台失败才算 stale
    source: 'github-releases-api',
    failed,
    // 按发行日期降序：最近更新的排前面。
    items: items.sort((a, b) => (b.released_at || '').localeCompare(a.released_at || '')),
  }
}

/* ------------------------------------------------------------------------- *
 * 方向简报采集器：TOP15 热门库/包 + 类别需求（周下载合计）。
 * 与上面的热度/平台采集同一原则：只访问公开 API，不爬网页正文、不登录；
 * 单点失败记入 failed，不拖垮整批，绝不把失败伪装成 0。
 * ------------------------------------------------------------------------- */

/**
 * GitHub 仓库搜索：按 star 排序，返回精简仓库信息（不返回完整 API 对象，减少体积）。
 * @param {string} query 搜索词（如 topic:llm）
 * @param {number} perPage 每页条数
 * @param {AbortSignal} signal 取消信号
 */
async function searchGithubRepos(query, perPage, signal) {
  const q = encodeURIComponent(query)
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`
  const data = await fetchJson(url, { signal, headers: { 'User-Agent': UA } })
  const repos = (data.items || []).map((r) => ({
    id: r.full_name, // owner/name 作为去重键
    name: r.name,
    full_name: r.full_name,
    stars: r.stargazers_count || 0,
    description: String(r.description || '').replace(/\s+/g, ' ').slice(0, 200),
    url: r.html_url,
    topics: (r.topics || []).slice(0, 5),
  }))
  if (!repos.length) throw new Error('NO_REPO') // 无结果：本次搜索失败，不返回空榜冒充成功
  return repos
}

/**
 * README 摘要：GitHub 官方 readme 接口拿 raw 文本，压缩为一段可读摘要。
 * 清洗链：去 HTML 注释 → 去 HTML 标签 → Markdown 链接保留文字 → 去 Markdown 符号
 * → 去 URL → 压缩空白 → 取前 140 字。失败由上层记入 failed，摘要为空字符串。
 */
async function fetchReadmeSummary(repoFullName, signal) {
  const url = `https://api.github.com/repos/${repoFullName}/readme`
  const text = await fetchText(url, { signal, headers: { 'User-Agent': UA, Accept: 'application/vnd.github.raw+json' } })
  const summary = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>|_]+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return summary
}

/** npm 包近一周下载量；包名不存在时抛错（由上层记为该源失败，显示 —）。 */
async function fetchNpmWeekly(pkg, signal) {
  const name = encodeURIComponent(pkg)
  const data = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${name}`, { signal })
  return { value: data.downloads || 0, url: `https://www.npmjs.com/package/${name}` }
}

/** PyPI 包近一周下载量；包名不存在时抛错（同上）。 */
async function fetchPypiWeekly(pkg, signal) {
  const name = encodeURIComponent(pkg)
  const data = await fetchJson(`https://pypistats.org/api/packages/${name}/recent`, { signal })
  return { value: data.data?.last_week || 0, url: `https://pypistats.org/packages/${name}` }
}

/**
 * 方向 TOP 热门库/包：
 *   1. 按方向的多条 GitHub 搜索词抓仓库（sort=stars），合并去重；
 *   2. 按 star 排序取 TOP N；
 *   3. 每个项目并发取 README 摘要与 npm/PyPI 周下载（失败即缺，显示 —）。
 *
 * failed 只记录搜索与 README 的失败；下载失败属于"该生态没有对应包"，不进 failed。
 * downloads.npm / downloads.pypi 为 null 表示没取到，渲染层显示 —，绝不冒充 0。
 *
 * @param {{direction: object, queries?: string[], limit?: number, signal?: AbortSignal}} opts
 */
export async function fetchDirectionLibraries({ direction, queries, limit = 15, signal } = {}) {
  // 显式 queries 优先（用户可覆盖默认搜索词），最多取 6 条控制请求量。
  const seeds = (Array.isArray(queries) && queries.length ? queries : direction.github_queries || []).slice(0, 6)
  const failed = []
  if (!seeds.length) {
    // 没有任何搜索词：返回带失败说明的空结果，让渲染层显示"样本不足"。
    return {
      schema_version: 1, direction: direction.id,
      fetched_at: new Date().toISOString(), data_as_of: new Date().toISOString().slice(0, 10),
      stale: true, source: 'github-search+readme+npm+pypi', failed: [{ query: '*', reason: 'NO_QUERIES' }], items: [],
    }
  }

  // ① 并发搜索：perPage 取 limit*2（上限 50），为合并去重留余量。
  const searchResults = await Promise.allSettled(seeds.map((q) => searchGithubRepos(q, Math.min(50, limit * 2), signal)))
  searchResults.forEach((r, i) => {
    if (r.status === 'rejected') failed.push({ query: seeds[i], reason: String(r.reason?.message || r.reason) })
  })

  // ② 合并去重：同一仓库（full_name 相同）只保留先出现的记录；再按 star 降序取 TOP N。
  const byName = new Map()
  for (const r of searchResults) {
    if (r.status !== 'fulfilled') continue
    for (const repo of r.value) if (!byName.has(repo.id)) byName.set(repo.id, repo)
  }
  const top = [...byName.values()].sort((a, b) => b.stars - a.stars).slice(0, limit)

  // ③ 每个项目并发补 README / npm 下载 / PyPI 下载；三者互不阻塞。
  const items = await Promise.all(top.map(async (repo) => {
    const [readme, npm, pypi] = await Promise.allSettled([
      fetchReadmeSummary(repo.full_name, signal),
      fetchNpmWeekly(repo.name, signal),
      fetchPypiWeekly(repo.name, signal),
    ])
    if (readme.status === 'rejected') failed.push({ repo: repo.full_name, source: 'readme', reason: String(readme.reason?.message || readme.reason) })
    return {
      ...repo, // id/name/full_name/stars/description/url/topics
      readme_summary: readme.status === 'fulfilled' ? readme.value : '',
      // 下载量字段带官方核对链接；失败保持 null，渲染层显示 —，不冒充 0。
      downloads: {
        npm: npm.status === 'fulfilled' ? npm.value : null,
        pypi: pypi.status === 'fulfilled' ? pypi.value : null,
      },
    }
  }))

  const fetchedAt = new Date().toISOString()
  return {
    schema_version: 1,
    direction: direction.id,
    fetched_at: fetchedAt,
    data_as_of: fetchedAt.slice(0, 10),
    stale: items.length === 0, // 一个项目都没抓到才算整批失败
    source: 'github-search+readme+npm+pypi',
    failed,
    items,
  }
}

/**
 * 类别需求聚合：对方向的每个类别抓代表包的 npm/PyPI 周下载，合计排名。
 *
 * 类别清单只是查询入口（见 src/directions.js），排名完全由本次抓取值计算。
 * 某类别一个包都没抓到时 total_downloads 为 null（样本不足），不冒充 0；
 * 抓到部分包时合计只算成功部分，并用 hit_count 标注覆盖度。
 *
 * @param {{direction: object, signal?: AbortSignal}} opts
 */
export async function fetchCategoryDemand({ direction, signal } = {}) {
  const categories = direction.categories || []
  const failed = []
  const results = await Promise.all(categories.map(async (cat) => {
    // 把 npm / pypi 两类代表包统一成 {name, eco} 列表，并发抓取。
    const packages = [
      ...(cat.npm || []).map((name) => ({ name, eco: 'npm' })),
      ...(cat.pypi || []).map((name) => ({ name, eco: 'pypi' })),
    ]
    const settled = await Promise.allSettled(packages.map((p) =>
      p.eco === 'npm' ? fetchNpmWeekly(p.name, signal) : fetchPypiWeekly(p.name, signal)))
    const items = []
    let total = 0
    let hits = 0
    settled.forEach((r, i) => {
      const p = packages[i]
      if (r.status === 'fulfilled') {
        hits += 1
        total += Number(r.value.value) || 0
        items.push({ name: p.name, eco: p.eco, value: r.value.value, url: r.value.url })
      } else {
        failed.push({ category: cat.id, package: p.name, eco: p.eco, reason: String(r.reason?.message || r.reason) })
        // 失败包仍占位，value=null，渲染层显示样本不足而不是静默消失。
        items.push({ name: p.name, eco: p.eco, value: null, url: null })
      }
    })
    return {
      id: cat.id,
      label: cat.label,
      total_downloads: hits > 0 ? total : null, // 一个都没抓到 → null，不写 0
      package_count: packages.length,
      hit_count: hits, // 覆盖度：命中数/总数
      packages: items,
    }
  }))
  const fetchedAt = new Date().toISOString()
  const anyHit = results.some((c) => c.total_downloads != null)
  return {
    schema_version: 1,
    direction: direction.id,
    fetched_at: fetchedAt,
    data_as_of: fetchedAt.slice(0, 10),
    stale: categories.length > 0 && !anyHit, // 有类别但全没抓到才 stale
    source: 'npm+pypi-downloads',
    failed,
    // 按周下载合计降序；null（样本不足）排最后（?? -1）。
    categories: results
      .sort((a, b) => Number(b.total_downloads ?? -1) - Number(a.total_downloads ?? -1)),
  }
}
