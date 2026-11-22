# `profile.json` 字段说明

> `profile.json` 是 JSON 格式，**不能内嵌注释**（JSON 标准不支持注释，加了会导致 `JSON.parse` 失败）。因此把字段说明单独放在这里；模板中的每个字段都对应工作区根目录下的那份画像文件，由 `src/io.js` 读写。

## 字段逐项解释

| 字段 | 模板默认值 | 含义 | 谁写入 | 谁读取 |
| --- | --- | --- | --- | --- |
| `schema_version` | `1` | 画像结构版本号，便于将来迁移数据结构时判断是否需要升级 | 模板 / 首次初始化 | `readWorkspace()` 原样返回给模型 |
| `major` | `""`（空） | 用户专业，如"软件工程"。为空时 `renderProfileCard()` 触发 HITL 提示 | `career_explore`（参数 major） | 画像卡片、契合度、方向兜底查询词 |
| `grade` | `""`（空） | 用户年级，如"大二"；同上，空值算"画像未建立" | `career_explore`（参数 grade） | 画像卡片 |
| `direction` | `null` | HITL 选定的岗位方向 id：`dev` / `ops` / `test` / `pm`。**为 null 时 `hitl_needed=true`，进入热点模式前必须弹窗选方向** | `career_set_direction`、`career_direction_report` | `workspace_context`、`skill_plugins`、`direction_report` |
| `direction_label` | `null` | 方向的中文标签（开发/运维/测试/产品经理），仅用于展示 | 同上 | 画像卡片、简报标题 |
| `skills` | `{}`（空对象） | 技能掌握度映射：`{ skill_id: 0–5 }`。0 未开始、3 能做、4 已掌握、5 熟练；≥4 在规划时视为已完成 | `career_explore`、`career_review` | `fitRole` / `diagnose` / `planRoadmap` / 资源推荐 |
| `goal_role` | `null` | 目标岗位 id，来自运行时知识 `knowledge.json` 里的 `roles[].id`。**为空时禁止规划**；存在时进入规划模式 | `career_set_goal` | `workspace_context`、诊断、路线图、简报"下一步" |
| `preference` | `[]`（空数组） | 工作偏好：`coding` / `analysis` / `communication` 等，用于 `fitRole` 的偏好契合分 | `career_explore`（参数 preference） | `fitRole`、画像卡片 |
| `hours_per_week` | `10` | 每周可投入学习小时数，默认 10。用于把工时换算成周数（最短学习周数、阶段切分） | `career_explore` / `career_plan` | `fitRole.min_weeks`、`planRoadmap` |
| `deadline` | `null` | 目标截止日期（ISO 日期字符串，如 `2027-09-01`）。**规划工具必须绑定它**：`weeksUntil()` 用它算 `horizonWeeks`，已过期则报 `DEADLINE_PASSED` | `career_explore` / `career_plan` | `career_plan` / `career_review` / 画像卡片 |
| `negative_roles` | `[]`（空数组） | 用户否定过的岗位 id 列表；`fitRole` 对命中项扣 0.4 分，实现"重排候选" | 会话中累积（负反馈） | `fitRole` |
| `updated_at` | `null` | 画像最后更新时间戳（ISO 8601），每次 `writeProfile` 都会刷新 | 所有写画像的工具 | 调试 / 展示 |

## 与运行时知识的关系

`profile.json` 只放"用户自己的情况"；岗位和技能的定义（id、名称、前置关系、工时、别名）不在这里，而在同一工作区的 `knowledge.json`，由 `career_explore` 依据实时公开信号构造后写入。`skills` / `goal_role` 只是指向那份知识的 id 引用——如果改了 `knowledge.json` 里的技能 id，画像里的对应键也要跟着改，否则会变成"悬空引用"。

## 初始化与覆盖优先级

1. 工作区平坦目录下的 `profile.json` 若不存在，`readWorkspace()` 返回 `{ schema_version: 1, skills: {}, negative_roles: [] }` 作为内存兜底，`initialized: false`。
2. 工具参数里显式传入的字段（`major` / `skills` / `deadline` 等）通过 `profileFromWorkspace()` 浅合并到工作区画像上；只覆盖非 null/undefined 的值，`skills` 再做一次浅合并，避免"只传一个技能就把已有掌握度清空"。
3. 工作区根目录的优先级：`CAREER_MENTOR_WORKSPACE` 环境变量 > 会话 `workingDirectory` 注入的路径 > 进程 cwd。
