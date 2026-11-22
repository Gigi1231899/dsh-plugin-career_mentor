/**
 * 岗位方向目录（HITL 选项 + 查询入口清单）。
 *
 * 定位与 public-api.js 的 DEFAULT_AI_PLATFORMS 相同：这不是"静态岗位/技能知识库"，
 * 而是"去哪里查公开数据"的入口清单——四个方向的 GitHub 搜索词与
 * 代表包列表只用于向公开 API 发起查询，真实数据（stars / 下载量 /
 * README）永远来自抓取结果；类别排名完全由本次抓取的下载量计算。
 * 调用方（career_direction_report 的 queries 参数）可随时覆盖搜索词。
 *
 * 这个文件被三处消费：
 *   1) tools.js：workspace_context 暴露 DIRECTION_OPTIONS 给模型构造弹窗；
 *   2) tools.js：set_direction / direction_report 用 resolveDirection 归一化输入；
 *   3) skill-plugins.js：用 skill_queries / skill_terms 抓对口 Skill/Plugin。
 */

/**
 * HITL 四个岗位方向选项。数组顺序即弹窗顺序（no=1..4）。
 *
 * 每个字段的用途：
 * - no：弹窗里显示的序号，也接受用户回传数字 1–4；
 * - id：内部稳定标识（dev/ops/test/pm），落盘到 profile.direction；
 * - label：中文短标签，作为弹窗 option.label 和报告标题；
 * - description：一句话说明，作为弹窗 option.description；
 * - skill_queries：抓取 SkillHub / Claude Code 用的英文关键词（也用于 GitHub skill 搜索）；
 * - skill_terms：相关度白名单词，用于把 "product" 命中商品图之类的语义漂移过滤掉。
 */
export const DIRECTION_OPTIONS = [
  {
    no: 1, id: 'dev', label: '开发',
    description: '把想法做成可运行的软件：前端 / 后端 / AI 应用开发。',
    skill_queries: ['frontend', 'backend', 'coding', 'code review', 'refactor'],
    skill_terms: ['前端', '后端', '开发', '代码', '编程', '重构', 'review', 'frontend', 'backend', 'coding', 'code'],
  },
  {
    no: 2, id: 'ops', label: '运维',
    description: '让系统稳定跑在生产环境：容器编排、IaC、监控可观测。',
    skill_queries: ['kubernetes', 'devops', 'docker', 'monitoring', 'sre'],
    skill_terms: ['运维', '部署', '容器', '监控', 'k8s', 'kubernetes', 'devops', 'docker', 'ci', 'cd', 'sre', '可观测', '监控'],
  },
  {
    no: 3, id: 'test', label: '测试',
    description: '用自动化保证质量：UI / 接口 / 单元与性能测试。',
    skill_queries: ['testing', 'playwright', 'e2e', 'unit test', 'qa'],
    skill_terms: ['测试', '单元', '自动化', '质量', '性能测试', 'e2e', 'qa', 'test', 'playwright', 'pytest', 'junit'],
  },
  {
    no: 4, id: 'pm', label: '产品经理',
    description: '把需求变成文档与看板：原型、汇报自动化、数据分析。',
    skill_queries: ['product manager', 'prd', 'prototyping', 'productivity', 'roadmap'],
    skill_terms: ['产品经理', '产品', '需求', '原型', 'prd', 'roadmap', 'product manager', 'productivity', '看板', '数据分析'],
  },
]

/**
 * 工作区没有 direction 时给模型的问题文本（HITL）。
 * 注意：实际呈现走原生 ask_user_question 弹窗，模型应把本问题作为弹窗 question、
 * 把 DIRECTION_OPTIONS 的 label/description 作为弹窗选项，而不是让用户打字回复数字。
 * 文本里列出四节报告内容，让用户知道点选后会得到什么。
 */
export const DIRECTION_QUESTION = [
  '请选择你的岗位方向（用 ask_user_question 弹出卡片，四个选项：开发 / 运维 / 测试 / 产品经理）。',
  '选定后将进入热点模式，生成该方向：',
  '- 热门库 / 包 TOP15（名称、用途、Stars、下载量、链接）',
  '- 需求最旺盛的库 / 包类别',
  '- 新工具 vs 新框架分开展示（含公司归属、安装/下载地址）',
  '- 按该岗位热度排序的 Skill / Plugin 推荐',
].join('\n')

/**
 * 每个方向的查询入口（真正的数据来自抓取，不来自这里）。
 *
 * - github_queries：GitHub 仓库搜索词（sort=stars），多条查询合并去重后取 TOP N，
 *   由 public-api.js 的 fetchDirectionLibraries() 消费；
 * - categories：需求类别清单，每个类别给一组 npm / PyPI 代表包名，
 *   由 fetchCategoryDemand() 并发抓周下载量后按合计排名；
 * - blurb：一句话方向说明，渲染在热点简报标题下方；
 * - id/no/label：与 DIRECTION_OPTIONS 对应，用于展示。
 */
export const DIRECTIONS = {
  dev: {
    id: 'dev',
    no: 1,
    label: '开发',
    blurb: '把想法做成可运行的软件：前端 / 后端 / AI 应用开发。',
    github_queries: ['topic:llm', 'topic:frontend', 'topic:backend'],
    categories: [
      // AI/LLM 生态：npm 与 PyPI 双生态都给代表包
      { id: 'ai-llm', label: 'AI / LLM 应用', npm: ['langchain', 'openai'], pypi: ['openai', 'langchain', 'transformers'] },
      // Web 框架与构建工具
      { id: 'web', label: 'Web 框架与构建', npm: ['react', 'vue', 'next', 'vite', 'express'], pypi: ['fastapi', 'django', 'flask'] },
      // 数据存储与数据处理
      { id: 'data', label: '数据与存储', npm: ['prisma', 'mongoose'], pypi: ['pandas', 'numpy', 'sqlalchemy'] },
    ],
  },
  ops: {
    id: 'ops',
    no: 2,
    label: '运维',
    blurb: '让系统稳定跑在生产环境：容器编排、IaC 自动化、监控可观测。',
    github_queries: ['topic:kubernetes', 'topic:devops', 'topic:infrastructure-as-code'],
    categories: [
      { id: 'container', label: '容器与编排', npm: ['dockerode'], pypi: ['docker', 'kubernetes'] },
      { id: 'iac', label: 'IaC 与自动化', npm: [], pypi: ['ansible', 'fabric'] }, // npm 无代表包，空数组不是 0 下载
      { id: 'observability', label: '监控与可观测', npm: ['opentelemetry-api'], pypi: ['prometheus-client', 'opentelemetry-api'] },
    ],
  },
  test: {
    id: 'test',
    no: 3,
    label: '测试',
    blurb: '用自动化保证质量：UI / 接口 / 单元与性能测试。',
    github_queries: ['topic:testing', 'topic:e2e-testing', 'topic:unit-testing'],
    categories: [
      { id: 'ui-e2e', label: 'Web UI 自动化', npm: ['playwright', 'puppeteer', 'cypress', 'selenium-webdriver'], pypi: ['playwright', 'selenium'] },
      { id: 'unit', label: '单元 / 组件测试', npm: ['jest', 'vitest', 'mocha'], pypi: ['pytest'] },
      { id: 'api', label: '接口 / HTTP 测试', npm: [], pypi: ['requests', 'httpx'] },
    ],
  },
  pm: {
    id: 'pm',
    no: 4,
    label: '产品经理',
    blurb: '把需求变成文档与看板：原型、汇报自动化、数据分析。',
    github_queries: ['topic:productivity', 'topic:project-management', 'topic:prototyping'],
    categories: [
      { id: 'docs', label: '文档与汇报自动化', npm: [], pypi: ['python-docx', 'python-pptx', 'openpyxl', 'jinja2'] },
      { id: 'analysis', label: '数据分析与看板', npm: [], pypi: ['pandas', 'matplotlib', 'streamlit'] },
      { id: 'prototype', label: '原型与图表', npm: ['mermaid', '@excalidraw/excalidraw'], pypi: [] },
    ],
  },
}

/**
 * 把用户/模型的输入归一化成 DIRECTION_OPTIONS 里的一项。
 *
 * 接受三种写法：
 *   1) 数字 1–4（number 或字符串），如 2 / '2' → ops；
 *   2) 方向 id（大小写不敏感），如 'OPS' → ops；
 *   3) 中文标签，如 '运维' → ops。
 * 识别不了返回 null，由调用方决定 HITL 重问或报 UNKNOWN_DIRECTION。
 *
 * @param {number|string|null|undefined} input
 * @returns {object|null} 命中的方向选项（含 no/id/label/...），或 null
 */
export function resolveDirection(input) {
  // null / undefined / 空串统一视为"未选"，交给上层触发 HITL。
  if (input === null || input === undefined) return null
  // 数字直接 String 化；字符串去掉首尾空白。
  const raw = typeof input === 'number' ? String(input) : String(input).trim()
  if (!raw) return null
  // 纯数字走序号匹配（1=dev,2=ops,3=test,4=pm），避免 "1" 被当成 id。
  if (/^\d+$/.test(raw)) {
    const no = Number(raw)
    return DIRECTION_OPTIONS.find((o) => o.no === no) || null
  }
  // 非数字：统一小写后匹配 id（dev/ops/...），同时兼容中文 label。
  const key = raw.toLowerCase()
  return DIRECTION_OPTIONS.find((o) => o.id === key || o.label === raw || o.label === key) || null
}

/**
 * 渲染用：按 id 取方向目录条目（github_queries / categories / blurb）。
 * 找不到返回 null，调用方需判空，避免渲染函数拿到 undefined 崩溃。
 * @param {string} id 方向 id
 */
export function directionById(id) {
  return DIRECTIONS[id] || null
}
