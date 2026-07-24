<p align="center">
  <img src="assets/llama-ventures-logo.svg" alt="Llama Ventures" width="280">
</p>

<h1 align="center">@llamaventures/cli</h1>

<p align="center">
  <strong>Llama Ventures 的 CLI 与 MCP server。</strong><br/>
  一个包、两个可执行文件：<code>llama</code>——给人和脚本用的 CLI；
  <code>llama-mcp</code>——带 55 个类型化工具的 stdio MCP server，任何
  MCP 原生 agent 都能接。两者共享同一认证链、同一 HTTP 客户端、同一错误格式，
  连接 <a href="https://command.llamaventures.vc">command.llamaventures.vc</a>。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@llamaventures/cli"><img alt="npm" src="https://img.shields.io/npm/v/@llamaventures/cli?label=npm&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#给华人创业者向-llama-pitch">🚀 向 Llama pitch（无需账号）</a> ·
  <a href="#安装">安装</a> ·
  <a href="#认证">认证</a> ·
  <a href="#接入你的-ai-系统">接入你的 AI</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

> **公开源码、低摩擦安装；不是开源产品。** 大多数命令需要 Llama Ventures
> 团队账号（token 由团队管理员在 `/settings/tokens` 签发）。
> **唯一例外是公开的 `pitch` 命令族**——见下一节。

## 给华人创业者：向 Llama pitch

如果你是创业者、EA、或者帮老板探索的助理，**不需要 token、不需要找人介绍**——
我们专门为外部 pitch 留了一条公开通道。它跟
[command.llamaventures.vc/external-agent](https://command.llamaventures.vc/external-agent)
网页版聊的是同一个 intake agent，结构化提取、12 维投资判断都是同一套，
只是入口换成了你的终端,或者你自己的 AI 助手。

```bash
npm i -g @llamaventures/cli                          # 不需要 Llama 账号
llama pitch start --name "张三" --email "you@yourstartup.com"
llama pitch say "我们做 X，目标 Y，团队背景 Z..."
llama pitch upload ./deck.pdf
llama pitch                                          # 或直接进交互式 REPL
```

**也可以让你自己的 AI agent 帮你 pitch（A2A）**：把本包的 MCP server 挂到
Claude / Cursor / 任何 MCP 客户端上（配置见 [MCP server](#mcp-server)），
告诉它"帮我 pitch Llama Ventures"，它会用 `pitch_*` 工具跟我们的 intake
agent 对话。服务端有速率限制（单 IP / 单邮箱 / 单 session）。
Pitch 完成后档案自动进我们团队的 inbox，我们会主动联系你。

> Llama Ventures 投什么？看 [llamaventures.vc](https://llamaventures.vc)——
> AI、Pre-seed 到 Series A、$3-5M 票，跨美中。**懂得让 AI 帮你干活的
> founder，我们爱看。**

## 安装

```bash
npm i -g @llamaventures/cli    # Node 18+；llama-mcp 也会一起装上 PATH
llama --version
llama version --json           # 包版本、源码 commit 与固定的 Core API 契约
llama auth status              # 会跑一次 /api/me 验证
```

## 认证

客户端按下面的顺序找凭证，每次调用都查一遍：

| # | 来源 | 适合谁 |
|---|------|--------|
| 1 | `llama auth login`（OAuth，存 OS Keychain，自动刷新） | **所有人的推荐方式** |
| 2 | `gcloud auth print-identity-token` | 已配好 gcloud 的机器 |
| 3 | `$LLAMA_TOKEN` 环境变量 | CI、云上 sandbox agent |
| 4 | `~/.llama/token`（mode `0600`） | 长期 PAT |
| 5 | `~/.llama-command/config.json` | v0.1 老路径，自动迁移 |

```bash
llama auth login          # 浏览器登录；token 自动刷新、重启不丢
llama auth logout         # 服务端吊销 + 清空本地
llama token set llc_…     # /settings/tokens 签发的 PAT——落盘前先验证
llama auth status         # 看当前身份和生效的认证方式
```

> **没账号？** 找你在 Llama Ventures 的对接人——任何邮箱都可以被签发 token。

## 接入你的 AI 系统

这个包是 Llama Command 的**官方集成面**。自研 agent、LLM 应用都从这里接——
**不要直接调 HTTP API**：CLI/MCP 层负责认证链、稳定的 `Error[…]` 错误契约、
以及 schema 变化时的前向兼容（[SemVer](#稳定性)）；裸 API 没有这些承诺。

1. **拿凭证**——`llama auth login`；无人值守系统用 PAT（`llama token set`
   或 `$LLAMA_TOKEN`）。
2. **安装**——`npm i -g @llamaventures/cli`。
3. **接线**——MCP 原生 agent 指向 `llama-mcp`（[各客户端配置](#mcp-server)）；
   其它形态子进程调用 `llama …`。
4. **让 agent 自我入职**——会话开始跑一次 `llama agent-onboard`（或 MCP 的
   `agent_briefing` prompt），拿到服务端下发的 Agent Runtime Contract，
   与线上永远同步。
5. **验证**——`llama auth status`，然后 `llama deal search "<随便什么>"`。

## CLI

CLI 是 canonical 接口——认证、错误格式、schema 前向兼容都由它处理。
写脚本也优先用 CLI。

```bash
llama deal search "acme ai"            # 找 deal（deal list 用同一套过滤参数）
llama deal show <dealId>
llama deal feed <dealId>               # 该 deal 的全部贡献，最新在前
llama activity new-deals --since 24h   # 最近新建的 deal
llama activity updated-deals --since 7d # 按 deal 聚合的实质更新
llama deal create "Acme AI" --source alex --deal-owner owner@llamaventures.vc --source-direction Outbound --status Interested
llama deal ingest <dealId> --file packet.json  # 多条 facts + 可选 Feed note，一次提交且可安全重试
llama deal fact add <dealId> --category funding --claim "Raised a seed round" --source "deck p3" --source-url https://...
llama deal update <dealId> status Diligence
llama post <dealId> "备注内容"
llama post <dealId> "@name 请回复" --cue  # 仅在用户明确授权后使用
llama brief add-text <dealId> --heading "..." --body "..."
llama wiki search "<查询词>"
llama wiki save <slug> --title "..." --content "..."
llama mentions
llama agent-onboard                    # 服务端下发的 agent 工作契约
```

Status 语义——`Interested`：接触前先记录关注 · `Outreached`：已联系、
尚无回应 · `Sourced`：已有真实关系信号。`sourceDirection` 是独立维度：
`Inbound` 流入，`Outbound` 我们主动。

处理 deck、会议笔记、邮件或研究材料时，优先使用 `deal ingest`，不要循环调用
`deal fact add`。JSON 对象支持 `source`、最多 50 条 `facts`、可选 `note` 和可选
`idempotencyKey`。服务端会原子提交整个材料包、把常见 category 别名归一到固定分类，
并跳过来源一致的精确重复。只有真正的单条事实才用 `deal fact add`。

Facts 的正文用 `claim`。`source` 是人可读来源标签，`sourceUrl` 是 canonical
证据 URL；两者都会从 API 回显。`dealOwner` 请用 `/api/field-options`
里的精确 `dealOwner` 值、用户邮箱，或数字 user id。

`llama --help` 看分组索引，`llama help all` 看全部 100+ 命令。
所有删除默认软删除、有审计记录。

### 错误码

| 前缀 | 含义 | 恢复 |
|------|------|------|
| `Error[NO_AUTH]` | 没找到任何凭证 | `llama auth login` 或 `llama token set` |
| `Error[UNAUTHORIZED]` | 服务端拒绝了凭证 | token 被吊销 / 过期 / 账号不对 |

MCP server 在 `isError: true` 内容里返回相同前缀。认证请求会向 Command
发送有界、脱敏的遥测；`llama eval good|bad --last` 把真实搜索变成评测反馈。

## MCP server

`llama-mcp` 是 stdio MCP server，55 个类型化工具镜像 CLI 最常用的命令面。
每个工具具名、有边界——**故意不提供**通用 API passthrough。认证链与 CLI
完全一致。精确工具清单以 `tools/list` 为准：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | llama-mcp
```

<details>
<summary><strong>Claude Desktop</strong></summary>

`~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）：

```json
{ "mcpServers": { "llama": { "command": "llama-mcp" } } }
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add llama -- llama-mcp
```
</details>

<details>
<summary><strong>Cursor / 任何 stdio MCP 客户端</strong></summary>

把客户端指向 `llama-mcp` 可执行文件（`which llama-mcp`），JSON 结构同上。
无需协议扩展、无需 transport flag。
</details>

> 新 agent？跑 `llama agent-onboard`（CLI）或拉 `agent_briefing` prompt
> （MCP），拿服务端的工作契约。包内
> [`AGENT_BRIEFING.md`](AGENT_BRIEFING.md) 只是离线兜底。

## 稳定性

- **[SemVer](https://semver.org)**：改名/删命令 → major；新工具/命令/flag
  → minor；修 bug → patch。
- **公开契约**：wire format（Bearer / X-Llama-Token）和 `Error[…]` 前缀
  在 major 版本内不变。
- **故意没有裸 API passthrough**——需要的 wrapper 还没有就开 issue，
  不要直接调 HTTP API。

## 安全

- 通过 npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers)
  （OIDC）+ `--provenance` 发布——不存在可泄漏的 npm token。
- CLI 零运行时依赖；MCP server 只依赖 `@modelcontextprotocol/sdk`，pin 死版本。
- main 分支保护、Dependabot、secret scanning、push protection 全开。
- Token：本地 `~/.llama/token` mode `0600`；服务端只存 sha256 hash。

报告安全漏洞请走
[GitHub 私密通道](https://github.com/Llama-Ventures/llama-cli/security/advisories/new)，
不要发公开 issue。详见 [`SECURITY.md`](SECURITY.md)。

## 贡献与 License

Llama Ventures 内部维护，团队 PR 欢迎（见 [`CONTRIBUTING.md`](CONTRIBUTING.md)）。
外部:文档错漏类 issue 欢迎；想让我们看到你的项目请走
[pitch 通道](#给华人创业者向-llama-pitch)。

[MIT](LICENSE) — © 2026 Llama Ventures, Inc.
