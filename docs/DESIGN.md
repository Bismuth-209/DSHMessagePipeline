# DSH Message Pipeline（消息管道）插件：设计方案 v0.1（历史稿）

> **公开版说明**：本文是 2026-10-22 v0.1 的设计原稿，保留当时的内部代号与本地开发布局——当时内部 id/存储文件名为 `workspace-pipeline`，包名暂定 `@local/dsh-workspace-pipeline`；公开版本已统一为 `message-pipeline` / `dsh-message-pipeline`，文中 `plugin/` 子目录在公开仓库中也已扁平化为仓库根。正文作为实现决策的历史记录保留，未逐字回改。

- 日期：2026-10-22
- 目标：DSH `@deepseek-ai/dsh` 0.2.1-rc.2（本机 desktop profile，Web GUI）
- 一句话：把「工作区」显式连成可命名、可启停的信息管道，让**普通根会话**能在「本工作区 + 同一管道的其他工作区」范围内点对点发送跨会话消息；不同管道之间**不传递**。
- 插件名（暂定）：`@local/dsh-workspace-pipeline`，Host 服务键 `workspacePipelines`，存储 domain `workspace-pipeline` v1。

---

## 0. TL;DR

1. **DSH 今天没有通用的会话间消息**。唯一通道 Agent Team 只覆盖「Lead 根会话 ↔ 其直接子会话」，跨工作区、跨无关会话都不存在（`dsh-experimental-agent-team/README.md:203-208`）。本插件补齐这一层。
2. **可达性 = 一次集合判定，不需要多跳寻路**：`可达工作区 = {自己的工作区} ∪ 同属任一启用管道的工作区`。a∈P1、b∈P1∩P2、c∈P2 时，a 与 c 不同属任何管道 ⇒ 永不可达；b 无需中转，也**禁止**中转。传递性从结构上被消除。
3. **消息模型复用目标会话的持久日志**：投递就是向目标 Agent 的 inbox 送一条 `user/message`（source 复用内置 `agent-message`），首块是 `Cross-workspace message from <workspace>/<session> (...):`。目标的 Session 日志即天然收据，不需要自建消息存储来保证不丢。
4. **默认不唤醒**：目标不活跃时消息只持久进插件 outbox，等目标下次被创建（`agent/created`）时按 FIFO 自动注入；发送方显式 `wake=true` 才冷启动目标 Agent（`ctx.sessionController.resolveAgent`）后投递。
5. **管理面只给用户**：模型只能 `pipe_list`（看管道与可达目标）和 `pipe_send`；管道的创建/连接/启停/删除只在侧边栏面板里做。
6. **单进程、本机**：同一 DSH Host 内所有工作区共享进程，因此是进程内直投；不做跨 DSH 实例/远程转发（本版明确不支持）。
7. 代码量估计：Host ~700–900 行（domain + 路由 + 投递 + 2 个工具 + 命令），Client ~400–600 行（面板 + 提示 chip），0 行 Python。

---

## 1. 先澄清：DSH 现有能力与本次要新增的能力

| 能力 | 现状 | 证据 |
|---|---|---|
| Workspace = 项目目录，稳定 id，会话按 cwd 归属 | 已有，`ctx.workspaceRegistry` | `dsh-workspace/README.md:12,73,103` |
| Session = 追加写事件日志；可有/无活 Agent | 已有，`ctx.sessions` / `ctx.sessionQuery` | `dsh-session/README.md:12,40` |
| live Agent 投递 | 已有：`agent.steer/followup/inject` | `dsh-agent/README.md:47` |
| 冷会话恢复 | 已有：`ctx.sessionController.resolveAgent(sessionId)`（要求 header 有 cwd，拒绝 subagent 会话） | `dsh-api-session-controller/lib/index.js:3037,392-403,93` |
| 跨会话消息 | **只有 Team 内**（根会话 ↔ 直接子会话），且同一 cwd | `dsh-experimental-agent-team/README.md:203-208`；`lib/index.js:1586-1614` |
| 同工作区任意两个根会话互发 | **不存在** | 同上；Team membership 只认 `parentSession` 关系 |
| 工作区之间的连接/管道 | **不存在** | `dsh-workspace` 无 link/folder 概念；侧栏树的嵌套只是路径祖先推导 |

> 重要：用户此前问“同工作区不是本来就可以互发吗？”——**不能**。本插件的第一层价值就是补上“同工作区默认互通”，第二层才是管道。

---

## 2. 需求确认（2026-10-22 已拍板）

| 维度 | 决定 |
|---|---|
| 管道语义 | **超边**：管道 = 一组工作区，组内两两可达；不同管道不传递 |
| 同工作区 | 所有**普通根会话**两两可达，无需管道；**subagent / teammate 子会话不参与**（不可作发送方，也不可作目标） |
| 寻址 | **工作区 + 会话**（会话标题或 SessionId）点对点；不做广播 |
| 投递语义 | 默认**只持久排队不唤醒**；发送方可 `wake=true` 冷启动目标 |
| 消息形态 | user 角色消息 + 发送者前缀，触发/续接目标回合 |
| 安全 | 仅靠图可达性授权；限制字节数、目标积压、频率；禁止附件/路径引用 |
| 管理入口 | 侧边栏“管道”面板（勾选工作区、命名、启停）；会话内显示“当前可达工作区”提示 |
| 模型权限 | 模型**只能查看**现有管道与可达目标，不能建/改/删管道 |
| 范围 | 仅同一 DSH 进程内的本地工作区；另加独立审计日志（管道级消息时间线） |

---

## 3. 概念模型

```
Workspace (Project)            Pipeline (hyperedge)
  id: WorkspaceId               id: PipelineId
  path: canonical dir           title
  title                         workspaceIds: WorkspaceId[]
  sessionIds[]                  enabled: bool
        │                              │
        └────────────┬─────────────────┘   （一个工作区可属于多条管道）
                     │
Session (ordinary root)        Message (audit + outbox record)
  id: SessionId                 id: pipe-msg-<uuid>
  header.cwd ──► Workspace      senderSessionId / senderWorkspaceId
  header.parentSession? = 无    targetSessionId / targetWorkspaceId
  origin? = 无 (非 subagent)    pipelineId? / wake / state / attempts
  title (projection)            contentHash / bytes / createdAt / deliveredAt
```

关系规则：

1. **会话 → 工作区**：DSH 不存 workspaceId；归属 = `realpath(session.header.cwd) === workspace.path`。插件通过 `ctx.workspaceRegistry.list()` 遍历 `sessionIds` 反查（与 GUI 的 `owningGroupKey()` 同法）。
2. **工作区 → 管道**：多对多。`P1 = {a,b}`、`P2 = {b,c}` 合法；b 同时属于两条管道。
3. **管道 → 可达域**：`reach(ws) = {ws} ∪ ⋃{p.workspaceIds | p.enabled && ws ∈ p.workspaceIds}`。
4. **传递性**：`a∈P1, c∈P2, a∉P2, c∉P1` ⇒ `c ∉ reach(a)`、`a ∉ reach(c)`。b 只是两条管道的成员，不是中继节点；本插件**没有任何转发/中继代码路径**，所以“禁止传递”是结构保证而非运行时拦。

---

## 4. 路由与授权（发送时一次判定）

```
pipe_send(sender, targetWs, targetSession, body, wake?)
 1. 发送方资格：live、ordinary root（parentSession 未定义、origin ≠ 'subagent'）、未归档、能映射到已注册工作区
 2. 解析目标：workspace(title|id) → Workspace；session(title|id) → 该工作区 sessionIds 中的会话
 3. 目标资格：存在、ordinary root、有 header.cwd、未归档、非 subagent 拥有
 4. 可达性：targetWs ∈ reach(senderWs)                    ← 唯一授权判据
 5. 非自投递、非空文本、≤ maxMessageBytes、目标积压 < maxQueuedPerTarget、发送频率 ≤ 限额
 6. 组帧 → 写 outbox（state=queued）→ 依据投递策略尝试投递 → 回执
```

判定表（发送方工作区视角）：

| 目标工作区 | 关系 | 结果 |
|---|---|---|
| 相同 | 默认域 | 允许 |
| 不同且同属一条启用管道 | 管道域 | 允许 |
| 不同且只通过第三条管道间接相连 | 无直接超边 | **拒绝** `PIPE_NOT_REACHABLE` |
| 任一所属管道被禁用 | 视为未连接 | 拒绝 |
| 目标会话已归档 / 无 cwd / subagent 子会话 | 不可投递 | 拒绝（带具体 code） |

---

## 5. 消息转发设计（本方案核心）

### 5.1 三种投递路径

目标 Agent 的状态决定走哪条：

| 目标状态 | wake=false（默认） | wake=true |
|---|---|---|
| **live + running** | `agent.steer(msg)`：最近 step boundary 注入，回合可能延长 | 同左 |
| **live + idle** | `agent.followup(msg)`：开新回合 | 同左 |
| **未加载（只有日志）** | 仅写 outbox，`state=queued`；等 `agent/created` 时按 FIFO 注入 | `resolveAgent(id)` 冷启动 → `followup` → `flush` |
| **被其他进程持有写锁** | 保持 queued，退避重试 | 保持 queued，最多 3 次后 `failed` |

投递成功后：`ctx.sessions.flush(targetSession)` → 成功才把 outbox 置 `delivered`（与 `dsh-schedule` 的持久化确认同一姿势，`dsh-schedule/lib/index.js:1576-1597`）。

### 5.2 组帧

复用内置 `MessageSource` 的 `agent-message`，不加新 source kind（避免 session format v2→v3 白名单与客户端 trigger 硬编码两处风险）：

```js
const msg = createUserMessage({
  content: [
    { type: 'text', text: `Cross-workspace message from ${senderWsTitle}/${senderTitle} (pipeline ${pipelineTitle}; id ${messageId}):` },
    { type: 'text', text: body },
  ],
  source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
})
```

- 目标模型看到的是 **user 消息 + 发送者前缀**，会当作外部输入继续工作。
- UI 侧会按内置 `agent-message` 渲染（“收到任务消息”标题/图标），用户能看出是跨会话来信。
- `messageId` 写进首块文本，作为**目标侧去重标记**：重试前扫描目标会话事件，若已存在同 id 的 `agent-message` user 消息则直接置 delivered，避免“flush 成功但 outbox 未提交”崩溃窗口造成重复投递。

### 5.3 outbox 状态机

```
queued ──attempt──► delivering ──flush ok──► delivered
   │                   │
   │                   └─ transient error ──► queued (backoff, attempts+1)
   └─ terminal error（归档/删除/无cwd/不可达/超限）──► dropped(reason)
attempts > 3 ──► failed(error)
```

- 每个 target 一条串行 FIFO（内存 chain），按 `createdAt, seq` 顺序投递；同一目标的旧消息必须先于新消息。
- 启动时：加载 `queued` 记录；对每个目标，若 Agent 已 live 则立即 drain，否则等 `agent/created`。
- 投递前**重新判定可达性**：管道可能在排队期间被禁用/断开，此时置 `dropped(PIPE_UNREACHABLE)`。
- 归档目标：投递前检查 `ctx.workspaceRegistry.archivedSessionIds`；已归档直接 `dropped(PIPE_TARGET_ARCHIVED)`（归档闸门会在 pre-step 丢弃 step，绝不唤醒它）。

### 5.4 为什么不需要“消息中转”

- 所有工作区会话在**同一 Host 进程**：`ctx.agents` 是进程级 registry，跨工作区目标可以直接寻址，不需要经过任何“管道节点”。
- 非传递性由“可达 = 同一超边成员”直接保证；不存在把消息从 P1 转发到 P2 的代码路径。
- 因此“转发”在实现上只有两件事：**把消息送进目标 inbox**、**把没送到的持久重试**。没有 hop、没有路由表、没有环路检测。
- 未来若要跨 DSH 实例，才需要引入 hop=1 的中继与跨进程 outbox；本版明确不做。

---

## 6. 数据模型与持久化

### 6.1 Storage domain `workspace-pipeline` v1

> 实施修正（2026-10-22）：本插件以 `link:` 本地 bundle 方式安装，**不能 import `@deepseek-ai/dsh-storage-domain`**（DSH 包不在 profile 的解析路径上，research-pipeline 已有同样结论）。因此实现改为**自带 JSON 文件**：`$DSH_HOME/workspace-pipeline.json`（默认 `~/.dsh/workspace-pipeline.json`），原子写（临时文件 + rename），单进程写串行。若将来打包发布为正式 npm 包，可再切回 storage domain。

用 `ctx.storageDomain.open(defineDomain(...))`，`single` 布局 → 单文件 `~/.dsh/storages/workspace-pipeline.json`（与 `workspace.json` 同目录、同机制）。

```ts
global: {
  version: 1,
  pipelineIds: PipelineId[],          // 显示顺序
}

table 'pipelines' (key: PipelineId):
{
  id: PipelineId,                     // brandString(randomUUID())
  title: string,                      // 1..64
  description?: string,               // 可选
  workspaceIds: WorkspaceId[],        // 去重、顺序保留
  enabled: boolean,
  createdAt: number,
  updatedAt: number,
}

table 'messages' (key: PipeMessageId):
{
  id: 'pipe-msg-<uuid>',
  senderSessionId: SessionId,
  senderWorkspaceId: WorkspaceId,
  targetSessionId: SessionId,
  targetWorkspaceId: WorkspaceId,
  pipelineId?: PipelineId,            // 同工作区发送为空
  wake: boolean,
  state: 'queued' | 'delivered' | 'dropped' | 'failed',
  attempts: number,
  reason?: string,                    // dropped/failed 的 code
  bytes: number,
  createdAt: number,
  updatedAt: number,
  deliveredAt?: number,
}
```

- 消息正文**不写入 domain**（避免复制会话内容、避免隐私扩散）；审计只留 id/双方/状态/字节数；正文在目标会话日志里。
- 保留策略：`auditRetentionDays=30`、`auditMaxRecords=2000`，启动与每次写入后裁剪。
- 并发：单进程内所有写走一条 operation chain（同 `dsh-workspace` 的 `enqueueOperation`）；**不支持多 DSH 实例并发**（`storage-json` single 布局是 last-write-wins，`dsh-storage-json/README.md:72`）。
- 工作区被删除：监听 `domain/changed`（domain === 'workspace'）→ 从所有管道剔除未知 workspaceId，并把指向其会话的 queued 消息置 dropped。

### 6.2 为什么不用 session 投影存管道图

管道是**全局**概念（跨工作区），不属于某个会话；session projection 只适合会话内状态。用 storage domain 与 `dsh-workspace` 自身一致。

---

## 7. 插件包结构

```
workspace-pipeline/
├── PLUGIN_DESIGN.md            # 本文
└── plugin/
    ├── package.json            # @local/dsh-workspace-pipeline, dsh.bundle.patch
    ├── cordis.patch.yml        # insert: workspace-pipeline 行
    ├── icon.svg
    ├── locale/{en,zh}.json     # meta.title/description
    ├── lib/
    │   ├── index.js            # Service 入口：domain、生命周期、工具、命令、投递
    │   ├── routing.js          # reach() / resolveTarget() / 授权判定（纯函数，可单测）
    │   ├── outbox.js           # 状态机、FIFO、去重、重试、恢复
    │   └── deliver.js          # steer/followup/resolveAgent/flush 适配层
    ├── client.js               # 侧边栏管道面板 + 会话可达性 chip
    └── tests/
        ├── routing.test.mjs    # 纯逻辑：超边、非传递、禁用管道、归档目标
        └── outbox.test.mjs     # 状态机、去重、重试、恢复（stub ctx）
```

`package.json` 要点（照抄 research-pipeline 的已验证形态，`plugin/package.json:1-43`）：

```json
{
  "name": "@local/dsh-workspace-pipeline",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "engines": { "node": ">=24", "dsh": ">=0.2.1-rc.2" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-workspace", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: workspace-pipeline
      name: '@local/dsh-workspace-pipeline'
      config:
        defaultWake: false
        maxMessageBytes: 32768
        maxQueuedPerTarget: 32
        maxSendsPerMinute: 20
        auditRetentionDays: 30
        auditMaxRecords: 2000
        promptHint: true
```

安装：按 research-pipeline 验证过的流程，用 `link:` 装进**独立测试 profile**（先 `pipeline-test`，不碰 desktop），确认后再加上 desktop（`plugin/README.md:57-71`）。

---

## 8. Host 侧设计

### 8.1 服务与依赖

```js
export const name = 'workspace-pipeline'
export const inject = ['agents', 'sessions', 'sessionQuery', 'sessionController',
                       'workspaceRegistry', 'storageDomain', 'tools', 'commands', 'systemPrompt']
// systemPrompt 可能需要按实际服务名调整；M0 验证
export const Config = Schema.object({ /* 见 7 的 patch */ })

export function apply(ctx, config) { /* 返回 disposer；内部 ctx.plugin(PipelineService, config) 或直接注册 */ }
```

`PipelineService` 用 `class extends Service` + `static inject` + `[Service.init]` + `ctx.effect`（`dsh-schedule` 范式）：

- 初始化顺序：打开 domain → 校正数据（剔除未知 workspaceId、裁剪 audit）→ 恢复 queued 投递任务 → 注册 `agent/created`、`domain/changed` 监听。
- 所有异步入口用 `ctx.effect` 收编，回调内部 catch + `ctx.logger.warn`（游离异步会致命，`dsh-app-boot/README.md:109-110`）。
- 关闭时：停接受新发送 → 等已在途投递 settle（≤ disposalTimeoutMs）→ 关闭 domain。

### 8.2 工具（仅 root 会话可见）

注册在 `agent.ctx` 上（`agent/created` 时判断 `session.header.parentSession === undefined && origin !== 'subagent'`），子会话看不到工具。

`pipe_list`：
```json
{ "myWorkspace": {"id":"…","title":"…"},
  "pipelines": [{"id":"…","title":"…","enabled":true,"workspaces":[{"id":"…","title":"…"}]}],
  "reachableWorkspaces": [{"id":"…","title":"…","via":"self|pipeline:<title>"}],
  "targets": [{"workspaceId":"…","workspaceTitle":"…","sessionId":"…","title":"…",
               "status":"running|idle|inactive|archived"}] }
```
参数：`workspace?`（只看某工作区）、`includeArchived?=false`。返回体对 targets 做上限（每工作区 30 条，超出给 `truncated:true`），避免撑爆上下文。

`pipe_send`：
```json
{ "target": { "workspace": "<title|id>", "session": "<title|id>" },
  "message": "<text>",
  "wake": false }
```
回执：`{ "state": "delivered|queued", "messageId": "pipe-msg-…", "target": {...} }`。
错误码：`PIPE_SENDER_NOT_ROOT`、`PIPE_SENDER_UNGROUPED`、`PIPE_NOT_REACHABLE`、`PIPE_TARGET_NOT_FOUND`、`PIPE_TARGET_ARCHIVED`、`PIPE_TARGET_SUBAGENT`、`PIPE_SELF_MESSAGE`、`PIPE_MESSAGE_TOO_LARGE`、`PIPE_TARGET_BACKLOG`、`PIPE_RATE_LIMITED`。

`pipe_list` 的 `targets` 只列**可达**工作区的会话（不可达工作区完全不出现），让模型无从“猜”目标；标题解析失败时返回候选列表。

### 8.3 Prompt 提示（可选，`promptHint`）

root 会话创建时加一段 agent-scoped 系统提示（约 40–60 token）：

> You can exchange messages with sessions in your own workspace and in workspaces connected by an enabled pipeline. Use `pipe_list` to see reachable targets, and `pipe_send` to deliver a message. Never claim a target is reachable without checking.

按 `domain/changed` 刷新；管道全空时不注入，避免无成本消耗。

### 8.4 管理命令（给 UI 用，不给模型）

`ctx.get('commands').register(...)`，`/pipe` 子命令，返回紧凑 JSON 文本供面板解析：
`/pipe list`、`/pipe create --title=… --ws=<id,…>`、`/pipe rename <id> <title>`、`/pipe set <id> --ws=+/-`、`/pipe enable|disable <id>`、`/pipe delete <id>`、`/pipe audit [<id>] [--limit=50]`。
命令 handler 从 `{ agent, rawInput }` 拿调用者；写操作要求调用者是用户会话（root）；面板通过 `ctx.remote.commands.execute(sessionId, line, [])` 调用（research-pipeline 已验证该路径，`plugin/client.js:111-114`）。

> 后续如需要更顺的 RPC，再补 Typert Remote service；v0.1 先用命令桥，减少生成物依赖。

---

## 9. Client 侧设计

| 位置 | slot | 内容 |
|---|---|---|
| 侧边栏管道页 | `sidebar.panellist` | 管道列表 + 新建/编辑/启停/删除 + 审计时间线 |
| 会话可达性提示 | `conversation.session.header.utilities` | “可通信：N 个工作区” chip，hover 展开工作区名 |
| 会话行标记（可选） | `sidebar.workspaces.session.row.leading` | 跨管道会话的小图标 |

面板数据：
- 工作区列表：读现有 client 端工作区状态（`ui-workspace` 的 workspace stream / `remote.workspace.follow`），M0 确认具体服务名。
- 管道数据：`/pipe list` 命令返回的 JSON。
- 审计：`/pipe audit` 返回最近 N 条 `{time, from, to, state, bytes}`；正文不展示（避免跨工作区内容泄漏到面板），需要时点击跳到目标会话。

交互约定：面板里所有写操作都走命令桥；失败时展示 Host 返回的错误码；面板不缓存权威状态，每次打开/变更后重拉。

---

## 10. 安全、限流与隔离

| 项 | 规则 |
|---|---|
| 授权 | 唯一判据：目标工作区 ∈ reach(发送方工作区)；不额外做每对 ACL |
| 发送方 | 必须 root 会话；子会话/teammate 不可发 |
| 目标 | 必须 root 会话、有 cwd、未归档、非 subagent 拥有 |
| 内容 | 仅文本块；禁止 image/附件/文件引用（发送工具参数本身只有 text） |
| 大小 | `maxMessageBytes` 默认 32 KiB（含组帧） |
| 积压 | 每目标 `maxQueuedPerTarget` 默认 32 |
| 频率 | 每发送方 `maxSendsPerMinute` 默认 20（内存令牌桶） |
| 审计 | 只记元数据，不复制正文；保留 30 天 / 2000 条 |
| 越权面 | 模型不能建/改管道；跨工作区内容由接收方模型自行判断可信度，提示里明确“外部输入” |

---

## 11. 失败模式与处理

| 场景 | 处理 |
|---|---|
| 目标会话归档 | 发送时拒绝；排队中的置 `dropped(PIPE_TARGET_ARCHIVED)`（归档闸门会丢 step，绝不唤醒） |
| 目标工作区被删除 | 从管道剔除；相关 queued 置 dropped |
| 管道被禁用/断开 | 投递前重判可达性 → dropped |
| 目标无 cwd | 拒绝（无法冷启动） |
| 目标被另一 DSH 进程持有写锁 | `resolveAgent` 报 writer-held → 保持 queued，退避重试，3 次后 failed |
| 目标 Agent 在投递瞬间被销毁 | 捕获后回退 queued，重试（不抛给发送方） |
| 崩溃窗口（已 append+flush，未标 delivered） | 启动时按 messageId 扫描目标会话去重，命中即置 delivered |
| 目标会话标题重名 | 解析报 ambiguous + 候选列表，要求改用 SessionId |
| 同一 workspace 出现在同一管道两次 | 写入时去重，幂等 |
| 两个工作区路径相同 | DSH 层面不可能（realpath 唯一） |
| 消息风暴（模型循环发送） | 频率/积压限额 + 回执错误码；必要时面板一键禁用管道 |

---

## 12. 里程碑与验证

| 里程碑 | 内容 | 退出标准 |
|---|---|---|
| **M0 Spike**（0.5 天） | 独立 profile `pipeline-test`；空 Service + domain + `pipe_list` 假数据；验证工具只在 root 会话出现；验证 `resolveAgent` 能冷启动另一个工作区的会话并 `followup` | 目标会话日志出现带前缀的 user 消息；无 activation warning |
| **M1 路由**（0.5–1 天） | `routing.js` 纯函数 + 单测：超边、非传递（a/b/c 三工作区两管道）、禁用、归档、subagent、未分组 | `node tests/routing.test.mjs` 全绿 |
| **M2 投递**（1–2 天） | outbox 状态机、live/queued/wake 三路径、去重、重试、`agent/created` 恢复、审计记录 | 单测 + 手工三工作区互通验证 |
| **M3 UI**（1–2 天） | 侧边栏面板 CRUD、会话 chip、命令桥、locale | 面板可完成建/连/启停/删；chip 随管道变化 |
| **M4 端到端**（1 天） | P1={a,b}、P2={b,c} 真实会话：a↔b、b↔c、a↛c；wake on/off；重启补投；归档目标 | 全场景通过并记录审计时间线 |

总计约 4–6 个工作日。

---

## 13. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| `sessionController.resolveAgent` 属 Host API 域，未来可能变 | 冷启动路径失效 | 收敛在 `deliver.js` 单适配层；备选 `ctx.agents.resume({resumeSessionId, agentOptions, setup})` |
| 复用 `agent-message` source，UI 显示为“任务消息” | 语义略泛化 | 可接受；要独立样式需新增 source kind（会触发 session format 迁移白名单 + 客户端 trigger 硬编码），本版不做 |
| 消息正文只存在目标会话日志 | 发送方会话里没有“已发送”副本 | 发送回执 + `pipe_list`/审计可查状态；需要时再考虑在发送方会话追加 `plugin:` 记录 |
| 命令桥较粗糙 | 面板实现依赖文本 JSON | 约束返回 schema；后续升级 Typert Remote |
| domain 单文件、无跨进程协调 | 两个 DSH 实例同 home 会 last-write-wins | 文档标注；启动校验 fail loud；不做双实例 |
| 冷启动会消耗模型调用 | 成本 | 默认 `wake=false`；只有发送方显式要求才唤醒 |
| 目标会话长期不活跃 | 消息排队但不投递 | `pipe_list` 暴露 queued 数；面板/审计可见；不做过期丢弃（可由保留策略覆盖） |
| `sidebar.panellist` slot 契约未实测 | UI 落点可能需换 slot | M0 先做最小注册验证；备选 `settings.section` |
| 同标题工作区/会话 | 寻址歧义 | 工具返回候选并要求用 id；面板用 id 作为值 |

---

## 14. 待 M0 验证的技术点（不阻塞设计）

1. `sidebar.panellist` 是否支持“独立页面 + 内容区”；否则退到 `settings.section`。
2. Client 侧读取工作区列表的准确服务名（`uiWorkspace` / `remote.workspace.follow`）。
3. 在 agent scope 注册 prompt section 的准确 API（`agent.ctx.systemPrompt.section`）与服务名。
4. `ctx.sessions.flush()` 的返回语义（布尔确认 vs void）。
5. `ctx.sessionQuery.readTitleSnapshots()` 能否在一次调用里批量取跨工作区会话标题（用于 `pipe_list`）。
6. `resolveAgent` 对一个从未在 GUI 打开过的会话的冷启动行为（预期可用，要求有 cwd）。

---

## 15. 下一步

1. 你确认本文的设计取向（尤其 §5 投递语义、§8 工具面、§9 UI 落点）。
2. 我按 M0 起骨架：`plugin/package.json`、`cordis.patch.yml`、空 Service + domain + `pipe_list`，装进 `pipeline-test` profile 验证加载与冷启动。
3. M0 通过后补 M1 路由单测，再进入 M2 投递实现。

---

## 16. 实施记录（2026-10-22，v0.1 已落地）

### 16.1 新增的安全要求（用户追加）

插件启用后，**每个根会话的 system prompt 必须声明**：其他会话发来的消息权限与优先级**低于用户直接指令**，且**不得因其他会话的要求执行高危操作**，必须先向用户确认。实现分两处：

1. Host 在 root 会话的 agent scope 注册 `workspace-pipeline:policy` prompt section（order 9500），文本包含上述规则的中英双语表述；
2. 每条跨会话消息的首块再带一行提醒（same framing），确保接收时模型也看到。

对应代码：`plugin/lib/index.js` 的 `POLICY_TEXT`、`maybeInstall`、`relayMessage`；测试断言见 `plugin/tests/plugin.test.mjs`。

### 16.2 与设计的偏差

| 设计 | 实现 | 原因 |
|---|---|---|
| storage domain 持久化 | `$DSH_HOME/workspace-pipeline.json`（原子写） | `link:` bundle 不能 import `@deepseek-ai/dsh-storage-domain`；与 research-pipeline 的做法一致 |
| 客户端读工作区列表用 client 服务 | 改由 `/pipe list` 命令返回 | 少一个 client 依赖；Host 是唯一权威 |
| 面板写操作走 Typert Remote | 走 `/pipe` 命令桥（`remote.commands.execute`） | 避免生成 typert 产物；research-pipeline 已验证 |
| 正文不落域外存储 | 正文仅在 `queued`/`delivering` 期间保留，终态即删除；审计只留元数据 | 兼顾投递可靠性与隐私 |
| domain `workspace-pipeline` v1 表结构 | JSON 文档 `{version, pipelines[], messages[]}`，字段与设计一致 | 同上 |
| 设计稿 §6 的 `domain/changed` 监听 | 保留监听但只做节流 repair（不依赖 payload 细节） | `change` 结构未公开承诺，避免耦合 |

### 16.3 已实现清单

- Host：可达性路由、目标寻址（标题/id/path、歧义候选）、单目标 FIFO outbox、live/running→steer、live/idle→followup、inactive→排队、`wake=true`→`sessionController.resolveAgent` 冷启动、`sessions.flush` 后落 delivered、重试退避与去重（目标日志按 messageId 扫描）、归档/删除/断链的 drop、审计裁剪、工作区变更对账。
- 工具：`pipe_list`、`pipe_send`（仅注册在 root 会话 agent scope）。
- 命令：`/pipe list|info|create|update|setEnabled|delete|audit`（JSON op；写操作要求 root 会话）。
- 客户端：`sidebar.panellist` 面板入口 + `main` 页面（创建/编辑成员/启停/删除/审计）、`conversation.session.header.utilities` 可达性 chip。
- 包：`package.json`（bundle + client 声明）、`cordis.patch.yml`、locale、icon、README。

### 16.4 验证结果

| 验证 | 结果 |
|---|---|
| `node tests/routing.test.mjs` | 通过：超边、非传递、禁用管道、寻址歧义、输入校验 |
| `node tests/store.test.mjs` | 通过：归一化、CRUD、消息状态数据操作、裁剪、对账、文件往返与损坏回退 |
| `node tests/plugin.test.mjs` | 通过：root 才能装工具、系统提示含双语安全规则、A↔B 直投、A↛C、B→C、排队后 `agent/created` 补投、`wake=true` 冷启动、归档拒绝、自投递拒绝、命令 CRUD、审计、持久化、dispose 反注册 |
| 测试 profile 启动 | `pipeline-test` 组合包含 `workspace-pipeline` 行与全部配置 |
| 测试实例 `http://127.0.0.1:3099` | 页面 200；boot 图包含 `@local/dsh-workspace-pipeline/client.js`；该 combo 资源 200 且包含客户端代码 |

### 16.5 尚未验证 / 下一步

1. **GUI 目视**：侧边栏图标、面板布局、chip 位置未经浏览器截图确认（slot 结构照 schedule/plugin-manager 先例实现）。
2. **安装到 desktop profile**：目前只装在隔离的 `pipeline-test`；是否在你的桌面 profile 启用待你确认。
3. 冷启动耗时与 `deliveryTimeoutMs` 的实测调参。

### 16.6 真实端到端测试（2026-10-23）

**环境**：`test/test1`、`test/test2`、`test/test3` 三个真实工作区；`pipeline-test` web 实例（端口 3099，真实 `deepseek-account/deepseek-flash` 模型回合）；通过网关 unary RPC（`POST /api/<namespace>/<method>` + 启动 token 换 cookie）自动创建 workspace/session、下发 prompt、读取磁盘 session 日志校验。

**拓扑**：P1 = {test1, test2}，P2 = {test2, test3}；test1 还有一个同工作区冷会话 s1b。

**由模型真实调用工具完成并通过的断言**：

- test1 → test2 跨工作区消息送达（P1），消息带发送者前缀与 peer 优先级提醒；
- test2 → test3 跨工作区消息送达（P2）——b 同时属于两条管道；
- test1 → test3 被拒绝：工具返回 `PIPE_NOT_REACHABLE`，test3 日志中不存在该消息（**非传递性**成立）；
- test1 → test1 同工作区冷会话 s1b 送达（无需管道）；
- 四个 `pipe_list`/`pipe_send` 调用全部返回合法、非错误结果；
- 插件 store 记录 2+ 条管道、≥3 条 delivered 消息，终态不保留正文。

**发现并修复的真实缺陷**：工具返回对象含 `undefined` 字段（可选标题/错误原因）时，宿主判定 "value is not lossless JSON"，模型收到的是工具错误——消息实际已投递但回执不可用。修复：新增 `losslessJson()` 投影（剔除 `undefined`、归一化 `NaN`/`-0`、数组槽位转 null），两个工具出口统一经过它；单测增加 `assertLossless` 断言；修复后真实 E2E 全绿。

**复现方式**：

```powershell
dsh --profile pipeline-test --no-open --port 3099   # 记下打印的 token
node e2e/run-e2e.mjs http://127.0.0.1:3099 <token>
```

测试产生的工作区（test1/2/3）、会话与插件 store 中的 `P1/P2/P1-mvkehr09/P2-mvkehr09` 管道会保留在 `~/.dsh`，可在面板中删除；测试实例已关闭。

### 16.7 安装到 desktop profile（2026-10-23）

- 已通过 `dsh plugin --profile desktop add link:<本地仓库>/plugin` 安装：`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均包含当时的本地包名（`@local/...`）。
- desktop profile 由 Electron 独占，CLI 拒绝 `--dump-config`；改为在运行实例中验证：重启后 `pipe_list` 返回 `default-workspace`、0 管道、同工作区 8 个目标；`pipe_send` 出现在会话工具列表；当前会话系统提示（`system/message` seq 1641）包含双语 peer 优先级规则。
- HMR 可以在不重启时加载新增 bundle（首次安装时工具与提示立即出现），但**工作区注册表是启动时快照**：长时间运行的实例内存注册表可能不含新工作区/新会话，表现为 `PIPE_SENDER_UNGROUPED`。本次遇到，重启 desktop 后恢复。结论：安装/升级本插件后重启一次 desktop 应用。
- 启动对账新增规则：管道若因工作区被移除而失去全部成员，则载入时删除（`repairStore`），避免桌面端出现空管道；有单测覆盖。为便于排障，发送方无法归属工作区时错误里附带 `diagnostics`（会话、cwd、注册表可见工作区）。
- 测试残留：store 保留 9 条已投递审计记录；4 条测试管道已被新规则清理；test1-3 工作区与测试会话保留在 sidebar。

### 16.8 客户端面板首轮目视问题修复（2026-10-23）

目视验收报告的两个现象：点“工作区管道”后侧边栏出现“请先打开一个会话，再管理管道。”、左侧无法点击其他页面、右侧空白。定位到两个客户端实现问题：

1. **布局越界**：`main` slot 在 `centerCol`（`display:flex; flex-direction:column; overflow:hidden`）内渲染；面板根节点用了 `position:absolute; inset:0`，在非定位容器下相对视口铺满整窗，覆盖侧栏并拦截点击，右侧看起来空白。修复：根节点改为正常流 `flex:1 1 auto; min-height:0; height:100%; overflow:auto; box-sizing:border-box`。
2. **错误依赖当前会话**：面板通过 `uiSession.current` 取会话执行 `/pipe` 命令；打开全局面板时没有当前会话就进入空态。修复：新增 `commandSessionId()`——优先当前会话，否则从客户端 `sessions.list` 快照取最近更新的会话。命令执行会给该会话追加 `command/run`、`command/done` 日志事件（不调用模型），这是命令桥的既有语义。

验证：改后客户端 bundle 在测试实例中确认包含 `commandSessionId`、不再含绝对定位；desktop 侧 Host 插件已重载。客户端文件需要**页面刷新**后生效（未运行 dev:web，不存在自动热替换）。

### 16.9 第二轮目视：命令注入与主题颜色（2026-10-23）

截图显示布局已正常，但仍有：
- `操作失败: cannot get property "remote.commands" without inject` → Cordis 客户端访问 `ctx.remote.commands` 必须把命名空间服务名加入 `inject`（schedule 同样注入 `remote.schedule`）。修复：`inject` 增加 `'remote.commands'`。这也是工作区多选为空的直接原因——`/pipe list` 命令没执行成功，`workspaces` 数组为空。
- 白字白底：原实现用 `--dsh-text`/`--dsh-border`/`--dsh-input-bg` 这类不存在的变量，fallback 是偏白的 `#eee`/白色半透明，在浅色主题下不可读。修复：改用 DSH 设计 token —— `--dsw-alias-label-primary` / `label-tertiary` / `border-l3` / `bg-layer-1` / `bg-l1` / `button-primary-fill` / `button-primary-hover` / `label-primary-foreground` / `state-error-primary` / `interactive-bg-hover` / `interactive-bg-hover-accent`，并保留中性半透明 fallback（不再假设深色底）。

验证：新 bundle 在测试实例中确认包含 `remote.commands`、`--dsw-alias-*`，且无绝对定位；desktop Host 已重载，页面刷新后生效。

### 16.10 第三轮目视：命令结果解包与创建校验（2026-10-23）

现象：颜色与布局正常，但“连接工作区”仍为空，点“创建”没有任何反应（也没有报错）。

根因：`ctx.remote.commands.execute` 返回的是 `CommandExecution`（`{commandId, result:{kind, text}}`，参考插件 research-pipeline 也是取 `result.result.text`），本实现却把整个返回值 `JSON.stringify` 后当成命令 payload 解析，`data.workspaces` 恒为 `undefined`；“创建”又因为 `draftSelected.length === 0` 静默 `return`，于是表现为无反应。

修复：

- `commandText()` 统一解包三种返回形状——`CommandExecution`、`RemoteResult` 信封（`{ok, value|error}`）、纯文本；命令错误会作为异常透出。
- 点“创建”时若名称为空或未选工作区，显示明确错误 `panel.needSelection`（“请填写管道名称，并至少选择一个工作区”）。
- 工作区列表为空时显示 `panel.noWorkspaces` 提示，而不是一片空白。

验证：用临时契约测试覆盖三种返回形状；测试实例 bundle 含 `const execution = result.result`、`remote.commands`、新 locale key；desktop Host 重载后 `pipe_list` 正常。页面刷新后生效。

### 16.11 可配置项总表与管道级覆盖（2026-10-23，17:55 更新）

配置分三层；生效顺序 **管道覆盖 → 面板全局覆盖 → profile 配置默认**：

| 层 | 字段 | 默认 | 说明 |
|---|---|---|---|
| **插件级 / profile**（`cordis.patch.yml` 的 `workspace-pipeline` 行） | `defaultWake` | `false` | 未显式传 `wake` 时是否冷启动目标 |
| | `maxMessageBytes` | `32768` | 单条消息（正文+组帧）字节上限；**0 = 不限**，否则 1 KiB–256 KiB |
| | `maxQueuedPerTarget` | `32` | 每个目标会话的待投递积压上限，1–512 |
| | `maxSendsPerMinute` | `20` | 每个发送方每分钟发送上限，1–600 |
| | `maxAttempts` | `3` | 投递失败重试次数 |
| | `auditRetentionDays` | `30` | 审计记录保留天数 |
| | `auditMaxRecords` | `2000` | 审计记录条数上限 |
| | `promptHint` | `true` | 是否给 root 会话注入 peer 优先级系统提示 |
| | `deliveryTimeoutMs` | `15000` | 冷启动/投递等待上限 |
| **面板全局覆盖**（“插件全局设置”，持久化在插件 store，立即生效） | 同上四项 `maxMessageBytes` / `maxQueuedPerTarget` / `maxSendsPerMinute` / `defaultWake` | 继承 profile | 留空 = 继承 profile；`maxMessageBytes: 0` = 不限 |
| **管道级**（每条管道可在面板编辑；留空继承全局） | 同四项 | 继承全局 | 仅作用于该管道内的跨工作区消息 |
| **消息级**（`pipe_send` 参数） | `target.workspace` / `target.session` | — | 目标工作区（标题/路径/id）与会话（标题/id） |
| | `message` | — | 仅文本，禁止附件/路径引用 |
| | `wake` | 管道/全局默认 | 显式唤醒不活跃目标 |

规则与实现：

- 管道记录新增 `settings: {}`，只保存被覆盖的字段；更新采用**替换**语义（`settings: {}` 清空覆盖）。
- 插件 store 新增全局 `settings`（面板“插件全局设置”写入）；`/pipe setGlobal` 替换，瞬间生效，不需要改 profile 或重启。
- `/pipe list` 返回 `defaults`（生效全局）、`configDefaults`（profile 默认）、`globalSettings`（全局覆盖）与每条管道的 `settings`，面板据此显示“配置文件默认 (32768)”“继承全局 (…)”占位。
- **0 = 不限**：`maxMessageBytes: 0` 时跳过大小校验（组帧仍按原样发送）；配置文件里写 0 也合法；1–1023 视为非法（避免“几乎不限”的误配）。
- 越界/类型错误返回 `PIPE_SETTINGS_INVALID` 且带 `field`；面板与 `/pipe create|update|setGlobal` 都走同一校验。
- 单测覆盖：设置解析/越界/0 不限、存储替换语义、全局覆盖、管道级大小限制生效、同工作区不受管道覆盖影响、管道级 `defaultWake` 自动冷启动。


### 16.12 HMR 重载的已知限制（2026-10-23）

本轮为验证设置改动连续触发了多次 profile 热重载；多次重载后出现 **stale scoped tools**：旧插件实例注册在 agent scope 上的工具仍指向已失活的 ctx，调用时报 `cannot get required service "workspaceRegistry" in inactive context`（`pipe_list` 因此返回 `PIPE_SENDER_UNGROUPED`）。重启 desktop 应用后恢复。

结论（与 §16.7 一致）：**安装/升级/修改 Host 代码后重启 desktop 应用**，不要依赖 HMR 连续重载；纯客户端改动刷新页面即可。







