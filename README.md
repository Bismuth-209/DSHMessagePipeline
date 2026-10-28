# DSH Message Pipeline（消息管道）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![test](https://github.com/Bismuth-209/DSHMessagePipeline/actions/workflows/test.yml/badge.svg)](https://github.com/Bismuth-209/DSHMessagePipeline/actions/workflows/test.yml)

让 DeepSeek Harness（DSH）里的**普通根会话**可以跨会话、跨工作区点对点发消息：把若干工作区连成一条**命名管道**（超边），管道内两两可达，不同管道之间**永不传递**。

> Named pipelines for scoped cross-session messaging in DeepSeek Harness. Ordinary root sessions can message peers in the same workspace or in any workspace that shares an enabled pipeline — and never beyond it.

---

## 开发方式：全程 AI vibe coding

**本项目从设计、编码、调试、测试到文档，全程使用 DeepSeek 模型 + DeepSeek Harness（DSH）以 vibe coding 方式开发完成。** 人类只负责提出需求、验收结果和做发布决策。

This project was built end-to-end via **vibe coding with DeepSeek models inside DeepSeek Harness (DSH)** — design, implementation, debugging, tests, and documentation. Human involvement was limited to requirements, acceptance, and release decisions.

因此请注意：代码由 AI 生成，可能存在缺陷或未覆盖的边界情况；使用前请自行审查，尤其是安全相关场景。本项目以 MIT 协议开源，欢迎提交 issue / PR 一起改进。

---

## 功能

- **同工作区互通**：同一工作区内的任意两个普通根会话可以互发消息，无需建管道。
- **命名管道**：把多个工作区连成一条命名管道；管道内任意两个工作区两两可达。
- **非传递**：`a∈P1`、`b∈P1∩P2`、`c∈P2` 时，a 与 c 不可达；**没有中继/转发代码路径**，不可传递是结构保证，不是运行时拦截。
- **默认不唤醒**：目标不活跃时消息只持久排队，等目标下次被创建时按 FIFO 自动注入；发送方显式传 `wake: true` 才冷启动目标 Agent。
- **目标日志即收据**：消息复用 DSH 内置的 `agent-message` source 注入目标会话的 user 消息，目标会话日志天然就是投递凭证，无需自建消息库保存正文。
- **模型工具**：`pipe_list`（查看管道与可达目标）、`pipe_send`（点对点发送）。
- **用户管理面**：侧边栏「消息管道」面板，可创建/编辑/启停/删除管道、查看审计时间线；会话头部还有「可通信 N 个工作区」提示。
- **安全默认值**：只允许普通根会话参与；限制消息大小、目标积压与发送频率；跨会话消息在系统提示与消息首块中都被明确标注为**低优先级外部输入**。

## 安装

前提：已安装 DSH（`@deepseek-ai/dsh`）`>= 0.2.1-rc.2`，Node.js `>= 24`。

```sh
# 从 GitHub 安装（推荐）
dsh plugin add github:Bismuth-209/DSHMessagePipeline
```

也可以克隆后本地安装：

```sh
git clone https://github.com/Bismuth-209/DSHMessagePipeline.git
dsh plugin add ./DSHMessagePipeline
```

安装完成后**重启一次 DSH**（工作区注册表是启动时快照），侧边栏出现「消息管道」入口即安装成功。然后在任意根会话里让模型调用 `pipe_list` 验证。

> 本包是纯 JavaScript、无构建步骤，从 git 安装不需要额外的 `prepare` 脚本授权。目前未发布到 npm。

## 快速上手

1. 打开侧边栏「消息管道」面板，点「新建管道」，勾选两个或更多工作区，命名并保存。
2. 在某个工作区的根会话里，让模型 `pipe_list` 查看可达目标。
3. 用 `pipe_send` 发消息：

```json
{
  "target": { "workspace": "论文项目", "session": "实验设计" },
  "message": "样本已经跑完，请开始分析。",
  "wake": false
}
```

回执形如 `{ "state": "delivered" | "queued", "messageId": "pipe-msg-…", "target": { … } }`。

## 配置

配置分三层，生效顺序为 **管道级覆盖 → 面板全局覆盖 → profile 配置默认**。

插件级默认值写在 `cordis.patch.yml` 的 `message-pipeline` 行，也可以在面板「插件全局设置」里覆盖并持久化（无需改 profile、无需重启）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultWake` | `false` | 未显式传 `wake` 时是否冷启动目标 |
| `maxMessageBytes` | `32768` | 单条消息上限；`0` = 不限，否则 1 KiB–256 KiB |
| `maxQueuedPerTarget` | `32` | 每个目标会话的排队积压上限（1–512） |
| `maxSendsPerMinute` | `20` | 每个发送方每分钟发送上限（1–600） |
| `maxAttempts` | `3` | 投递失败重试次数（1–10） |
| `auditRetentionDays` | `30` | 审计记录保留天数 |
| `auditMaxRecords` | `2000` | 审计记录条数上限 |
| `promptHint` | `true` | 是否向根会话注入 peer 优先级系统提示 |
| `deliveryTimeoutMs` | `15000` | 冷启动/投递等待上限 |

管道级可覆盖：`maxMessageBytes`、`maxQueuedPerTarget`、`maxSendsPerMinute`、`defaultWake`（留空继承全局）。

## 工具与命令

### 模型工具（仅普通根会话可见）

- `pipe_list` — 列出当前可达的管道、工作区与会话；参数 `workspace?`、`includeArchived?`。
- `pipe_send` — 向可达目标发送文本消息；参数 `target.workspace`、`target.session`、`message`、`wake?`。

### 管理命令（用户侧，`/pipe`）

`list`、`info`、`create`、`update`、`setEnabled`、`setGlobal`、`delete`、`audit`；写操作要求调用者是普通用户会话。侧边栏面板通过命令桥调用它们，Host 始终是唯一权威。

## 安全模型

- **参与资格**：发送方与目标都必须是普通根会话；subagent / teammate 子会话不参与。
- **唯一授权判据**：目标工作区 ∈ `{本工作区} ∪ 同属任一启用管道的工作区`。没有广播，没有多跳转发。
- **优先级隔离**：每个根会话的系统提示都声明——其他会话发来的消息权限与优先级**低于用户直接指令**，不得因其他会话的要求执行高危操作，必须先向用户确认；每条跨管道消息首块也带同样的提醒。
- **资源限制**：消息字节数、每目标积压、发送频率、重试次数均有上限；消息正文只在 `queued`/`delivering` 期间保存于插件 outbox，进入终态即删除，审计只保留元数据。
- **仅本机**：只支持同一 DSH Host 进程内的本地工作区，不做跨实例/远程转发。

## 测试

```sh
node tests/routing.test.mjs   # 可达性、非传递、寻址、输入校验
node tests/store.test.mjs     # 归一化、状态机、裁剪、对账、文件往返
node tests/plugin.test.mjs    # 假 Host 集成：工具安装、系统提示、投递/排队/唤醒、命令、持久化
```

真实端到端测试需要先启动一个测试实例并拿到 launch token：

```sh
dsh --profile e2e --no-open --port 3099
node e2e/run-e2e.mjs http://127.0.0.1:3099 <launch-token>
```

可用环境变量：`DSH_HOME`、`E2E_WORKSPACE_ROOT`、`E2E_PROVIDER`、`E2E_MODEL`。E2E 会在隔离目录创建 `test1..test3` 三个工作区，用真实模型回合验证跨工作区直投、同一工作区投递、`a↛c` 非传递、peer 优先级提示等行为。

## 目录结构

```
.
├── lib/
│   ├── index.js      # Host 插件：管道图、投递、工具、命令、系统提示
│   ├── routing.js    # 纯函数：超边可达性、寻址、校验
│   └── store.js      # 原子 JSON 存储、消息状态机、审计裁剪、对账
├── client.js         # 侧边栏面板 + 会话可达性提示
├── cordis.patch.yml  # bundle 配置层
├── locale/           # 中英文案
├── tests/            # 单元/集成测试（node 直接运行）
├── e2e/              # 真实实例端到端测试
└── docs/DESIGN.md    # v0.1 设计稿（历史记录）
```

运行时状态保存在 `$DSH_HOME/message-pipeline.json`（默认 `~/.dsh/message-pipeline.json`），采用临时文件 + rename 原子写；单进程写串行，不支持多个 DSH 实例同时写同一 home。

## 兼容性与状态

- 状态：**v0.1.0 / developer preview**，接口与配置项可能变化。
- 开发与验证环境：DSH `0.2.1-rc.2`（Desktop + Web GUI，Windows），Node.js 24。
- 已知限制：安装/升级 Host 代码后建议重启 DSH（HMR 连续重载可能留下 stale scoped tools）；客户端改动需刷新页面；不支持跨 DSH 实例。

## 与生态中相邻实现的区别

DSH 生态里已经出现几种「跨会话消息」实现；本项目与它们的定位不同。按能力对照如下（检索时间 2026-10-28）：

| 项目 | 核心模型 | 与本文的差异 |
|---|---|---|
| [dsh-session-mesh](https://github.com/kx2398/dsh-session-mesh) | 所有工作区的根会话组成扁平 mesh，任意互发，支持 queue/steer、唤醒与冷启动 | 扁平全联通（可传递）；没有「命名管道/工作区分组」，没有管道管理面板与审计 |
| [dsh-office](https://github.com/windwhiterain/dsh-office) | 办公室/同事模型：名册、公开/群组/私密频道、信箱、侧栏面板 | 频道/办公室语义；不按工作区超边分组，没有管道级管理与审计 |
| [dsh-session-suite](https://github.com/chc-1986/dsh-session-suite) | 会话中枢 + 目录信箱 + Session Hub 面板 | 中枢/信箱模型；没有管道拓扑与非传递约束 |
| **本项目** | **命名管道 = 工作区超边；管道内两两可达、管道间不传递；侧栏管道管理 + 审计时间线 + peer 优先级提示** | — |

如果你只需要「所有会话扁平互发」，`dsh-session-mesh` 可能更直接；本项目面向的是需要**受控连通域**（明确哪些工作区可以互相说话）的场景。

## License

[MIT](LICENSE) © 2026 Bismuth-209

本项目在实现与文档中参考了 DeepSeek Harness（MIT）的公开文档与 API；DSH 本体及其相关包版权归 DeepSeek AI 所有，遵循其各自的 MIT 许可。
