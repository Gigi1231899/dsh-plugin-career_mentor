/**
 * DSH 工具插件入口（零构建、零宿主依赖，T4 路径 B）。
 *
 * 这个文件就是 package.json 的 main / exports["."] 指向的模块，DSH Loader
 * 加载 combo 包后按具名导出取 name / inject / apply（禁止 default export）。
 * 本文件负责两件事：
 *   1) 把 14 个工具定义逐个注册到 DSH 的工具系统；
 *   2) 登记 effect 回收函数，插件卸载/热替换时释放所有注册。
 * 三模式工作流约束已移到 skills/career-mentor/SKILL.md，由 career 预设里的
 * dsh-skill-filesystem 按需加载，不再在插件启动时全局注入。
 * 业务算法不在这里，全部在 src/ 下（tools.js 是工具清单，core.js 是算法）。
 */

import { toolDefinitions } from './src/tools.js'
import { setWorkspaceRoot } from './src/io.js'

/** 插件在 DSH 里的实例名；与 cordis.patch.yml 中 insert 行的 id/name 一致。 */
export const name = 'dsh-career-mentor'

/**
 * 硬依赖只声明 tools——DSH 在调用 apply(ctx) 前保证 ctx.tools 可用。
 *
 * workingDirectory 故意不写进 inject：它是可选增强。如果 profile 没挂该服务，
 * 把它写进 inject 会让插件停在 PENDING；现在改为在每次工具执行时通过
 * ctx.get('workingDirectory') 取，缺失则回退进程 cwd，14 个工具仍能注册。
 */
// apply之前先把tools注入到DSH上下文中，确保工具系统可用。
export const inject = ['tools']

/**
 * 包装单个工具定义：在每次执行前解析"本次会话的真实工作区根"并注入 io.js。
 *
 * 为什么必须包这一层：
 *   - 桌面端 apply() 时的 process.cwd() 是 DSH 的安装目录（C 盘），
 *     直接拿来落盘会把 profile / 快照写到错误位置；
 *   - 真实工作区在会话里，必须在 execute(args, exec) 被调用的那一刻解析。
 *
 * 实测 DSH 0.2.1-rc.3 的 exec 结构：
 *   - exec.agent 是本次调用的 Session owner，exec.agent.session 是其会话对象；
 *   - exec.signal 是取消信号，传给 wd.ensure 可让中断传播到底层。
 *   - workingDirectory.get(session) 返回会话投影里的绝对 cwd（无 I/O）；
 *     workingDirectory.ensure(agent, signal) 会校验目录存在，返回规范化路径。
 *
 * @param {object} definition 来自 src/tools.js 的工具定义（name/description/parameters/output/execute/timeoutMs）
 * @param {import('@deepseek-ai/cordis').Context} ctx DSH 插件上下文
 * @returns {object} 结构相同、但 execute 被包了一层工作区解析的工具定义
 */
function withWorkspace(definition, ctx) {
  // 先保存原始 execute，下面用闭包包一层；不要递归调用包装后的版本。
  const execute = definition.execute
  return {
    ...definition,
    // 覆盖 execute：框架实际调用的是这个"包装版"
    async execute(args, exec) {
      let root = null
      try {
        // ⚠️ 可能进 catch ①：ctx.get 虽然是函数，但调用它本身可能抛错——
        // 比如 workingDirectory 服务没注册、服务初始化失败、依赖没就绪。
        // 注意 typeof 只能保证"它是函数"，不能保证"调用不报错"。
        const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null

        if (wd && exec?.agent) {
          // ⚠️ 可能进 catch ②：wd.get 存在但调用时内部抛错——
          // 比如版本不兼容、传参形状不对、会话对象失效；
          // 另外取 exec.agent.session 这一步理论上也可能出错。
          root = typeof wd.get === 'function' ? wd.get(exec.agent.session) : null

          if (!root && typeof wd.ensure === 'function') {
            // ⚠️ 可能进 catch ③：ensure 是异步函数，可能 reject（拒绝）——
            // 比如目录不存在且创建失败、没有权限、signal 被用户取消、磁盘错误。
            // await 会把 reject 变成 throw，所以这里会跳进 catch。
            root = await wd.ensure(exec.agent, exec.signal)
          }
        }
      } catch {
        // 上面任意一步出错都到这里：root 保持 null，
        // io.js 拿到 null 会回退到进程 cwd，工具照样执行、不崩。
        root = null
      }
      setWorkspaceRoot(root)
      return execute(args, exec)
    },
  }
}


/**
 * DSH 在插件激活时调用的唯一入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 收集所有可释放对象：工具注册返回的 registration。
  const disposables = []

  // ① 注册 14 个 career_* 工具。每个都经 withWorkspace 包一层工作区注入。
  for (const definition of toolDefinitions) {
    const registration = ctx.tools.register(withWorkspace(definition, ctx))
    // 有的版本 register 返回 void；只有带 dispose 的对象才登记回收。
    if (registration && typeof registration.dispose === 'function') {
      disposables.push(registration)
    }
  }

  // ② 统一回收：DSH 的 effect 在插件卸载/热替换时先执行外层回调，
  //    我们再用 splice(0) 取出并清空数组，逐个 dispose，避免重复释放。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const item of disposables.splice(0)) {
        try {
          item.dispose()
        } catch {
          // 单个释放失败不影响其它项。
        }
      }
    })
  }
}
