# Llama Command CLI 2

这是 Llama Command 给 Agent 使用的最小、可审计工具界面。

CLI 2 不再保留分裂的 Deal 命令。Core 负责数据库写入、Google Drive
文件夹、Event、provenance 和幂等；Agent 不直接操作 PostgreSQL。

## 安装或升级

```bash
npm i -g @llamaventures/cli@latest
llama --version
llama auth status
```

服务端要求 CLI 2。任何 1.x CLI/MCP 请求都会收到
`426 CLI_VERSION_UNSUPPORTED` 和升级命令，不会自动退回旧 Deal API。

认证按以下顺序发现：

1. `llama auth login` 保存的 OAuth 凭证；
2. `gcloud auth login` 的本机 Google 身份；
3. `LLAMA_TOKEN`；
4. `~/.llama/token`。

## Deal 只有四个动作

```bash
llama deal search "Acme" --limit 10
llama deal read <dealId> --detail overview
llama deal create --json create.json
llama deal write --json write.json
```

`read` 是渐进式读取：

```bash
llama deal read <dealId> --detail memory
llama deal read <dealId> --detail files
llama deal read <dealId> --detail conversation
llama deal read <dealId> --detail history
llama deal read <dealId> --detail all
```

Live Deal Page 永远返回；只有任务需要时才展开其他内容。

### 创建 Deal

```json
{
  "companyName": "Acme",
  "page": {
    "website": "https://example.com",
    "stage": "Diligence"
  },
  "information": [
    {
      "type": "traction.claim",
      "labels": ["founder_reported", "unverified"],
      "subject": {"company": "Acme"},
      "value": {"arrUsd": 320000}
    }
  ],
  "origin": {
    "kind": "user",
    "originalUserUtterance": "Acme 说 ARR 大约是 32 万美元。"
  }
}
```

```bash
llama deal create --json create.json
```

Core 会补上 `operation: deal.create`，创建或复用 Drive 文件夹，并在一个
事务里写入初始 Page、Information 和 Events。

### 写入 Deal

`write` 内部只有四种 operation：

- `input.submit`：把完整原始输入保存在 Event Feed；
- `information.put`：写入一个结构化工作记忆单元；
- `page.patch`：更新人类直接看到的 Live Deal Page；
- `artifact.put`：添加不可变的 memo、HTML 或源文件。

给人看的 Page 文字必须在写入时同时提供自然的中英文：
`{"en":"natural English","zh":"自然中文"}`。Web 的语言开关从同一个
Page revision 选择对应内容，不创建中文页和英文页两套真相。公司名、枚举、URL、数字、日期、
人名和 source ID 等语言无关值继续使用 scalar；Information 和原始 Input 保留原语言与 provenance。
CLI 会在请求到达 Core 前拒绝新的 scalar Page 文案或缺少任一语言的 pair；历史 scalar 文案仍可读取。

原始用户输入示例：

```json
{
  "operation": "input.submit",
  "dealId": "<uuid>",
  "format": "text",
  "content": "完整原始输入",
  "source": {"kind": "meeting_note"},
  "origin": {
    "kind": "user",
    "originalUserUtterance": "完整原始输入"
  }
}
```

```bash
llama deal write --json write.json
```

任何源自用户的写入，都必须在 `origin.originalUserUtterance` 保存原话，
或者引用 `origin.originatingChatRecordId`。Agent 的总结不能替代原始表达。

Chat 和 Event 由系统拥有。Agent 不能自行伪造 Event 类型、顺序、作者、
时间，也没有通用的 Chat 写入工具。

## Deal Memory sidecar

Deal Memory 是与五资源 Deal 模型并行、完全解耦的领域。每个 Deal 可以有一个
人和 Agent 都能直接阅读的 Markdown Deal Story：

```bash
llama memory read <dealId>
llama memory read <dealId> --raw
llama memory write <dealId> --markdown deal-story.md
llama memory write <dealId> --markdown deal-story.md --expected-version '"read 返回的 etag"'
```

每次写入前都先读取。如果 `read` 返回任何 Story（包括空 placeholder），写入时
必须传回其不透明 `version`；只有 `404` 才表示创建时可以省略
`--expected-version`。旧版本会安全失败，不会覆盖他人的新内容。每次写入都要
重写一份连贯的当前理解，不要追加更新日志，不要重复 Live Deal Page 或 Deal
Information 字段；如果理解没有实质改善，就不要写。

Markdown 必须有非空正文和 YAML frontmatter，其中包含 `deal_id`、`uuid`、
`created`、`updated`。前三项不可更改；`updated` 必须是带时区偏移的 ISO 8601
时间，并在每次写入时严格递增。它复用同一个 `llama auth login` 身份。CLI
只调用经过认证的 Command Core adapter，不持有 sidecar URL、service token、
S3 凭证，也不直接访问数据库。

`llama deal read --detail memory` 仍表示结构化 Deal Information；
`llama memory read` 表示独立的 Markdown Deal Story。

## Deal 只有五种业务资源

1. Live Deal Page：人类看到的当前状态；
2. Deal Information：带标签与 provenance 的结构化 Agent 工作记忆；
3. Artifacts：不可变的用户上传材料；
4. Chat Records：append-only 的群聊与人机对话；
5. Deal Events：append-only、可排序、可重放的完整历史。

Fact、opinion、founder、status、archive、trash、memo section 和 artifact
kind 都只是这些资源里的字段或标签，不是新的表或新的工具。

## MCP

```bash
llama-mcp
```

MCP 的 Deal 工具同样恰好四个：

- `search_deals`
- `read_deal`
- `create_deal`
- `write_deal`

认证、skill discovery、Wiki、admin audit、preferences 和 external pitch
属于其他独立领域，不会扩大 Deal action space。Deal Memory 同样是独立领域，
对应 `get_deal_memory` 和 `update_deal_memory` 两个 MCP 工具，并不增加第五个
Occam Deal 工具。

## Agent 启动

```bash
llama agent bootstrap
llama skills search "<任务>"
llama skills show <slug>
```

Agent 在处理 Deal 前应先运行 `llama agent bootstrap`。该命令会从鉴权后的
Llama Command 服务端加载两部分私有 Brain：负责投资思考的 Investment
Framework V3，以及负责如何在 Command 工作的 Llama Command operating skill；
同时加载独立的、实时的 Live Deal Page 字段契约。所有私有内容都不会进入公开
npm 包；CLI 只是 Agent 的工具和鉴权运输层。

服务端实时 briefing 是权威合同；包内 `AGENT_BRIEFING.md` 是相同四动作
合同的离线兜底。

## 本地开发

```bash
npm install
npm test
npm run verify:release
```

发布包会绑定准确 source SHA。npm publish 与生产服务端强制最低版本是两个
独立、需要明确授权的 release 动作。
