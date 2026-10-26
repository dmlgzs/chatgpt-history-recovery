# 拾光 · ChatGPT 本地聊天记录恢复与阅读工具

使用 Node.js 从 ChatGPT Android 的 SQLite 缓存中恢复聊天记录，导出 JSON / Markdown，并通过本机网页浏览和搜索。也可从 **Codex、Chrome 缓存副本** 中寻找额外的会话或消息，按 ID 去重合并。

**已验证的 Android ChatGPT 版本：`1.2026.265`。** 其他版本应先检查数据库结构；不同版本的表名、消息格式和缓存格式可能变化。

这是独立的本地工具，与 OpenAI 官方无隶属关系。源码目录不包含真实聊天记录、账号信息、原始数据库或浏览器缓存。测试数据均由测试代码合成。

## 用途与恢复范围

- 按块序号重组消息，正确处理跨块的汉字、emoji 和长文本。
- 保留会话标题、原始消息字段、父消息关系、多个分支、工具消息、思考记录及附件引用。
- 按会话导出 JSON 和 Markdown，生成完整性、源文件哈希及异常报告。
- 用本地页面阅读、全文搜索、定位消息、复制正文或代码，并查看原始 JSON。
- 从已复制的 Chromium HTTP 缓存中解析响应，补充手机数据库缺少的消息。
- 扫描 LevelDB 副本中的会话 ID，辅助判断本地存储是否还有恢复线索。

**恢复的是输入文件中实际存在的数据。** 仅有会话标题不代表保存了正文；附件引用也不等于图片、音频或文件本身。缓存可能仅保存一页消息，页面会标注不完整或完整性未知的情况。工具不会凭空补全缺失内容，也不提供已删除 SQLite 记录的全面取证恢复。

## 环境要求

- Node.js **22.13.0 或更新版本**，需要支持 `node:sqlite` 和 SQLite FTS5 trigram。
- npm，用于安装页面依赖：`marked` 和 `dompurify`。
- 现代浏览器，用于访问本地阅读页面。

Node.js 22 的 SQLite 实验性提示不影响已验证环境下的正常运行。核心恢复脚本只依赖 Node.js 内置模块，单独导出数据无需安装页面依赖。

核心恢复和阅读服务不依赖固定的个人目录。自动采集 Codex / Chrome 副本的两个辅助脚本目前按 **Windows 默认安装目录** 查找；其他位置可以手动复制缓存后传入 `--cache`。

## 快速开始

先从有权访问的 Android 应用数据备份中取得聊天记录 SQLite 数据库。数据库文件名因账户而异，不要求重命名；如果备份中存在同名 `-wal`、`-shm` 文件，请保持它们与数据库位于同一目录。建议在应用完全停止后取得一致备份。

在本项目目录运行：

```sh
npm ci
node scripts/recover.mjs --db "./data/conversations.db"
npm start
```

其中 `./data/conversations.db` 是示例路径，请替换为自己的备份路径。打开 **http://127.0.0.1:5183** 阅读恢复结果。

也可把唯一的 `.db` / `.sqlite` / `.sqlite3` 文件放在项目根目录，然后运行：

```sh
npm run recover
npm start
```

首次 `npm start` 若找不到 `recovered/archive.sqlite`，会尝试自动恢复项目根目录中的唯一数据库。根目录存在多个数据库时，需要先通过 `--db` 明确选择。

## 兼容的 Android 数据库结构

`1.2026.265` 的已验证结构包含：

| 表 | 主要字段 | 用途 |
| --- | --- | --- |
| `DBConversation` | `id`、`conversation` | 会话 ID 和 JSON 元数据 |
| `DBMessage` | `id`、`conversationId` | 消息 ID 和所属会话 |
| `DBMessageChunk` | `messageId`、`chunkIndex`、`chunk` | 分块保存的消息 JSON 字节 |

恢复脚本先复制数据库及可用 WAL/SHM，随后只对**复制件**建立 SQLite 只读连接和读取事务，不直接用 SQLite 打开原库。它将同一消息的字节块排序、拼接后，再严格解码 UTF-8 和解析 JSON。

遇到缺块、无块、非法 UTF-8 或 JSON 时，保留占位消息、原始字节和块数据，并在报告中记录，不静默丢弃。空会话也会保留标题和元数据。

## 命令行用法

### 恢复与导出

```sh
node scripts/recover.mjs --help
node scripts/recover.mjs --db "./data/conversations.db" --out "./my-archive"
node server.mjs --out "./my-archive" --port 5184
```

| 参数 | 说明 |
| --- | --- |
| `--db 路径` | 指定手机数据库；省略时从项目根目录寻找唯一数据库 |
| `--out 目录` | 输出目录，默认 `./recovered` |
| `--cache 目录` | 额外扫描的浏览器缓存**副本**目录，可重复传入 |
| `--force` | 重新生成输出，旧目录会重命名备份保留 |

输出先写入 `输出目录.building-*`，成功后才发布。默认拒绝覆盖已有输出。重新恢复前先停止阅读服务：

```sh
npm run recover -- --db "./data/conversations.db" --force
```

旧输出保留为 `recovered.previous-*`，失败的 `*.building-*` 目录也保留，工具不会自动删除它们。确认无需保留后再自行清理。

### 从 Codex / Chrome 缓存补充

缓存分析应当使用副本。Windows 默认目录可通过以下脚本复制：

```sh
node scripts/snapshot-codex.mjs
node scripts/snapshot-chrome.mjs
```

脚本会打印生成的 `codex-snapshots/` 子目录：

- Codex：复制已知的本地会话数据库、可用 WAL/SHM、全局状态文件和浏览器缓存。
- Chrome：遍历 `Default` / `Profile N`，复制 HTTP 缓存、本地与会话存储，以及 ChatGPT/OpenAI 相关 IndexedDB。
- 复制过程跳过锁文件和符号链接，记录复制错误及文件是否在复制时变化，不打开原数据库连接。

正在运行的应用可能在复制期间继续写入，文件检查不能保证跨文件事务一致性。建议先关闭相关应用，或使用已有的一致备份。快照可能包含浏览记录、草稿、标识符和凭据等私密信息，应仅保存在自己的设备上。

将输出目录替换到以下示例中：

```sh
node scripts/recover.mjs --db "./data/conversations.db" --cache "./codex-snapshots/codex-copy" --cache "./codex-snapshots/chrome-copy" --force
npm start
```

**不传 `--cache` 时，只处理手机数据库。** 合并规则如下：

- 按会话 ID 关联，按消息 ID 去重；不因标题相似合并。
- 相同消息优先保留手机数据库中的原始数据，缓存原始响应另外保存。
- 缓存中不属于手机原库的会话，按独立会话导入并标明来源。
- 保留缓存返回的分页标志；不把一页缓存当成完整历史。

解析支持 Chromium block-file 的独立流和块内流、Simple Cache 的常见响应体布局、Brotli / gzip / deflate，以及 ChatGPT 响应中的 `messages` / `mapping`。浏览器内部格式会变化，不保证覆盖所有版本和缓存状态。

### 辅助检查副本

先生成默认 `recovered/index.json`，再运行：

```sh
node scripts/check-codex.mjs "./codex-snapshots/codex-copy"
node scripts/scan-browser-storage.mjs "./codex-snapshots/chrome-copy"
```

`check-codex.mjs` 对比已知 Codex 库中的会话目录、线程 ID 和缺正文会话，并扫描缓存中的 ID。它依赖副本里的 `state_5.sqlite`、`thread_history_1.sqlite`、`codex-dev.db` 及对应表结构；其他 Codex 版本可能需要适配。

`scan-browser-storage.mjs` 支持 LevelDB SSTable、Snappy 压缩和跨 32 KB 日志片段拼接，寻找会话 ID 的 UTF-8 / UTF-16LE 表示。它是线索扫描工具，不是 IndexedDB 全部结构化克隆格式的完整解码器；命中 ID 也不代表一定存在正文。

检查报告写回指定的副本目录。两个脚本目前读取默认的 `recovered/index.json`；自定义归档可用主恢复脚本与服务直接处理。

## 阅读页面

- 按标题筛选会话，按时间或消息数量排序，区分有正文与仅标题的会话。
- `Ctrl+K` / `⌘K` 全文搜索，可限定当前会话；点击结果定位到消息。
- 切换显示工具、思考、系统及隐藏消息，查看父消息关联与分支提示。
- Markdown 标题、列表、表格和代码块，复制消息与代码，下载原始消息 JSON。
- 当前会话导出 JSON / Markdown，查看恢复报告、异常及来源说明。
- 深色主题与手机宽度布局。

页面只访问本地服务，不依赖 CDN，不自动加载正文中的远程图片。普通外部链接可由用户点击打开。HTTP 服务只绑定 `127.0.0.1`，限制访问 Host 和 Origin；无需登录账户或填写 API Key。

## 输出内容与隐私

```text
recovered/
  archive.sqlite           # 阅读、索引及完整原始消息
  source/                  # 输入数据库和可用 WAL/SHM 的复制件
  index.json               # 会话摘要与文件名映射
  report.json              # 哈希、计数、完整性及异常报告
  conversations/*.json     # 每个会话的规范化消息和 raw 原始字段
  markdown/*.md            # 可提取正文、详细消息及附件引用
  cache-sources/*.json      # 原始缓存响应和来源（使用 --cache 时）
  unparsed/                # 异常消息的原始字节与块数据（需要时）
```

导出文件名使用序号及会话 ID 哈希，避免标题中的非法文件名字符。消息分支全部保留，按父子关系与时间排列，不推断客户端当前选中的分支。

**开源源码已排除个人数据；工具运行后生成的文件不会自动脱敏。** 原始消息、标题、附件引用、来源路径和快照仍可能包含隐私或凭据。不要把输入、快照、导出、失败目录或旧备份提交到公开仓库。

`.gitignore` / `.npmignore` 已覆盖常见的数据目录及数据库扩展名，`package.json` 也限制了 npm 打包文件。但自定义输出目录仍需自行确认，发布前请运行下面的检查。

## 性能与验证

恢复逐会话处理；额外缓存扫描会遍历副本文件，耗时与缓存大小相关。阅读服务在 Worker Thread 中查询 SQLite，前端按需请求数据：

- 每段默认最多渲染 24 条消息，分页翻阅，避免整段长历史进入 DOM。
- 长消息先返回 12,000 字符；展开超过 60,000 字符的文本后按 30,000 字符分段显示。
- FTS5 trigram 支持中文/英文子串搜索，不足三个字符时回退子串扫描，短关键词在大归档上可能更慢。
- 查询参数绑定、消息索引游标、JSON 按需 gzip、详细消息延迟渲染。

```sh
npm test
npm run verify
npm run benchmark
npm run check:release
```

测试使用临时生成的数据，覆盖跨块 UTF-8、损坏/缺失块、孤立消息、分支、中文及特殊字符搜索、消息分页、缓存合并、Snappy、LevelDB 日志片段、导出和 HTTP 接口。

`verify` 需要先恢复数据；默认检查归档内的源库复制件及导出结果。自定义路径：

```sh
node scripts/verify.mjs "./my-archive/source/conversations.db" "./my-archive"
```

`benchmark` 针对默认归档启动临时本地服务，结果写入 `.test-output/performance.json`，仅供本机比较。

`check:release` 检查发布源码的文件白名单、常见个人路径和凭据形式。检查不会读取源码目录之外的聊天数据库。它是发布辅助检查，不保证识别所有隐私形式；数据文件应始终留在源码发布目录之外。

发布 Git 仓库时仅使用本目录的源码。`package.json` 的 `private: true` 用于阻止意外执行 `npm publish`，不影响把源码托管到公开 Git 仓库。

## 目录结构

```text
lib/                 # 消息提取、缓存解析、LevelDB 读取、查询 Worker
public/              # 本地聊天阅读页面
scripts/             # 恢复、复制副本、检查、核验、基准及发布检查
tests/               # 人工合成数据的自动化测试
server.mjs           # 本地 HTTP 服务
```

## 许可证

本项目采用 [MIT License](LICENSE)。依赖包保留各自许可证，通过 npm 安装，不在本源码目录中内嵌第三方依赖。
