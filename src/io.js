/**
 * 工作区持久化层：负责所有"落盘"操作。
 *
 * 所有路径都相对 workspaceRoot() 计算，绝不写进 DSH 安装目录或 profile 目录。
 * 这是修复"桌面端数据写到 C 盘"问题的关键：根目录来自会话的 workingDirectory，
 * 由 index.js 在每次工具执行前调用 setWorkspaceRoot() 注入。
 *
 * 文件布局（都在当前工作区根目录下）：
 *   profile.json                  用户画像
 *   knowledge.json                运行时岗位/技能知识（由 career_explore 写入）
 *   snapshots/<date>.json          技术热度快照
 *   platform-news/<date>.json      平台动向快照
 *   direction-report/<date>-<dir>.json 方向简报原始数据（供同日缓存复用）
 *   plans/<plan_id>.json           学习路线图（每次 plan/review 生成新文件）
 *   reviews/<week_index>.json      每周复盘记录
 *   radar.md / directions.md / checklist.md / resources.md  渲染后的 Markdown 文档
 *   各 .md 同级的 <name>.history/   文档覆盖前的历史备份
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 工作区根目录来源（优先级从高到低）：
//   1) 环境变量 CAREER_MENTOR_WORKSPACE（显式覆盖，测试用临时目录也是靠它）
//   2) 每次工具调用时注入的「会话工作目录」——来自 DSH workingDirectory 服务的
//      get(exec.agent.session)，这才是桌面端用户在 UI 里打开的工作区。
//   3) 进程 cwd 兜底（仅 web profile / CLI 场景）。
// 绝不能写进 DSH 桌面端安装目录或 profile 目录。
let sessionWorkspaceRoot = null

/**
 * 由插件入口（index.js 的 withWorkspace）在每次工具调用前注入当前会话的工作目录。
 * 传 null/undefined 时清空为 null —— "复位"和"赋值"一样重要，防止跨会话路径泄漏。
 * path.resolve 把相对路径转成绝对路径，避免工具间 cwd 不一致。
 * @param {string|null} root
 */
export function setWorkspaceRoot(root) {
  sessionWorkspaceRoot = root && typeof root === 'string' ? path.resolve(root) : null
}

/**
 * 解析当前工作区根：环境变量 > 会话注入 > 进程 cwd。
 * 本模块所有其他函数都通过它拿根目录，不直接读 process.cwd()。
 * @returns {string} 绝对工作区路径
 */
function workspaceRoot() {
  const explicit = process.env.CAREER_MENTOR_WORKSPACE
  if (explicit) return path.resolve(explicit)
  if (sessionWorkspaceRoot) return sessionWorkspaceRoot
  return path.resolve(process.cwd())
}

/**
 * 递归创建目录（等价于 mkdir -p）。
 * 写入任何文件前都先调用，保证 snapshots/plans 等子目录不存在时也能直接写。
 */
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/**
 * 读 JSON，文件缺失或损坏都返回 fallback，避免单个坏文件让整个工具崩掉。
 * 这是"降级不是崩溃"原则的基础：画像坏了的字段退回默认值，工具照常工作。
 * @param {string} file 绝对路径；为空时直接返回 fallback
 * @param {*} fallback 文件不存在/解析失败时的返回值
 */
function readJson(file, fallback) {
  if (!file || !existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 写 JSON：先建目录，再以 2 空格缩进 + 末尾换行写出（便于人直接打开检查）。
 * 调用方负责构造完整对象，这里不做字段校验。
 */
function writeJson(file, value) {
  ensureDir(path.dirname(file))
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/**
 * 写文本（Markdown 文档）；覆盖前把旧版本备份到同名 .history 目录。
 *
 * 例如写 radar.md 时，旧内容会被复制成 radar.history/<ISO时间戳>.md，
 * 时间戳里的冒号和点被替换成 '-'，避免跨平台文件名非法。
 * 备份失败（只读目录等）被吞掉，不影响本次写入——历史是尽力而为的增强。
 */
function writeText(file, text) {
  ensureDir(path.dirname(file))
  if (existsSync(file)) {
    const historyDir = path.join(path.dirname(file), `${path.parse(file).name}.history`)
    ensureDir(historyDir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      copyFileSync(file, path.join(historyDir, `${stamp}.md`))
    } catch {}
  }
  writeFileSync(file, text, 'utf8')
}

/**
 * 取目录里文件名排序最后的那个（快照按日期命名，最新的即最后一份）。
 * 例：snapshots/2026-11-17.json、2026-11-19.json → 返回后者。
 * 目录不存在或没有匹配后缀的文件时返回 null。
 */
function latestFile(dir, suffix = '.json') {
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((n) => n.endsWith(suffix)).sort()
  if (!names.length) return null
  return path.join(dir, names[names.length - 1])
}

/**
 * 本地日期戳 YYYY-MM-DD（不用 toISOString 的 UTC 日期，避免时区偏差导致
 * "今天"的文件名和用户本地日期差一天）。
 */
function dateStamp() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * 汇总工作区当前状态，供 career_workspace_context 一次返回给模型：
 * 是否初始化、画像、最新快照/平台动向/方向简报/计划/复盘、清单是否存在，以及各文件路径。
 *
 * 这是"一次读取、全量返回"的设计：模型只需调一个工具就知道所有历史状态，
 * 避免每个工具各自读一遍工作区；同时 last_snapshot 等对象直接复用给下游工具。
 */
export function readWorkspace() {
  const root = workspaceRoot()
  // 先拼出所有文件路径；latestFile 负责找各目录里的最新 JSON。
  const profileFile = path.join(root, 'profile.json')
  const snapshotFile = latestFile(path.join(root, 'snapshots'))
  const platformFile = latestFile(path.join(root, 'platform-news'))
  const directionReportFile = latestFile(path.join(root, 'direction-report'))
  const planFile = latestFile(path.join(root, 'plans'))
  const reviewFile = latestFile(path.join(root, 'reviews'))
  const checklistFile = path.join(root, 'checklist.md')

  return {
    root,
    initialized: existsSync(profileFile), // 画像文件存在即视为已初始化
    // 画像损坏时退回最小骨架；last_* 损坏时退回 null。
    profile: readJson(profileFile, { schema_version: 1, skills: {}, negative_roles: [] }),
    last_snapshot: readJson(snapshotFile, null),
    last_platform_news: readJson(platformFile, null),
    last_direction_report: readJson(directionReportFile, null),
    latest_plan_id: planFile ? path.basename(planFile, '.json') : null, // 去掉扩展名即 plan_id
    last_plan: readJson(planFile, null),
    last_review: readJson(reviewFile, null),
    checklist_exists: existsSync(checklistFile),
    files: {
      profile: profileFile,
      snapshot: snapshotFile,
      platform_news: platformFile,
      direction_report: directionReportFile,
      plan: planFile,
      review: reviewFile,
      checklist: checklistFile,
    },
  }
}

/** 写画像：固定覆盖工作区根的 profile.json（最新画像只有一份）。 */
export function writeProfile(profile) {
  writeJson(path.join(workspaceRoot(), 'profile.json'), profile)
}

/** 写技术热度快照：按日期命名，同一天重复刷新会覆盖当天文件。 */
export function writeSnapshot(snapshot) {
  const file = path.join(workspaceRoot(), 'snapshots', `${dateStamp()}.json`)
  writeJson(file, snapshot)
  return file
}

/** 写平台动向快照：按日期命名，来自 GitHub Releases。 */
export function writePlatformNews(snapshot) {
  const file = path.join(workspaceRoot(), 'platform-news', `${dateStamp()}.json`)
  writeJson(file, snapshot)
  return file
}

/**
 * 方向简报原始数据快照（TOP15 库/包 + 类别需求 + 平台动向 + Skill/Plugin），
 * 文件名带方向 id：同日同方向只抓一次，之后复用本文件重新渲染 Markdown。
 */
export function writeDirectionReport(doc) {
  const file = path.join(workspaceRoot(), 'direction-report', `${dateStamp()}-${doc.direction}.json`)
  writeJson(file, doc)
  return file
}

/** 技术热度报告 Markdown：个人画像 + 行业风向 + 与你的关系（无 Top10 总榜）。 */
export function writeRadarMarkdown(markdown) {
  const file = path.join(workspaceRoot(), 'radar.md')
  writeText(file, markdown) // 覆盖前自动备份旧版本
  return file
}

/** 方向简报 Markdown：六节分块式热点简报，一页看完。 */
export function writeDirectionsMarkdown(markdown) {
  const file = path.join(workspaceRoot(), 'directions.md')
  writeText(file, markdown)
  return file
}

/**
 * 按 plan_id 读路线图。
 * 用 path.basename 做净化：即使调用方传了 '../etc/passwd'，也只会拼到 plans 目录下，
 * 防止路径穿越读到工作区外的文件。
 */
export function readPlan(planId) {
  if (!planId) return null
  const safe = path.basename(planId)
  return readJson(path.join(workspaceRoot(), 'plans', `${safe}.json`), null)
}

/** 写路线图：每次 plan/review 都是新 plan_id，因此 plans/ 下保留历史版本。 */
export function writePlan(plan) {
  writeJson(path.join(workspaceRoot(), 'plans', `${plan.plan_id}.json`), plan)
  return plan.plan_id
}

/** 写每周复盘：按周次命名（如 1.json）；同周复盘会覆盖。 */
export function writeReview(review) {
  writeJson(path.join(workspaceRoot(), 'reviews', `${review.week_index}.json`), review)
  return review.week_index
}

/** 写学习清单 Markdown（五列表格）。 */
export function writeChecklist(markdown) {
  const file = path.join(workspaceRoot(), 'checklist.md')
  writeText(file, markdown)
  return file
}

/** 写资源推荐 Markdown（按技能的搜索链接表）。 */
export function writeResources(markdown) {
  const file = path.join(workspaceRoot(), 'resources.md')
  writeText(file, markdown)
  return file
}

/** 检查某个 plan 文件是否真的存在（readPlan 返回 null 无法区分"不存在"与"损坏"）。 */
export function planFilePath(planId) {
  if (!planId) return null
  const file = path.join(workspaceRoot(), 'plans', `${path.basename(planId)}.json`)
  return existsSync(file) ? file : null
}

// 供 knowledge.js 与测试复用底层原语，避免重复实现路径/JSON 逻辑。
export { workspaceRoot, writeJson, readJson, existsSync, path, renameSync }
