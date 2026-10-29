# CodeBuddy 插件逐文件功能比对（原插件 vs Lithe 当前实现）

> 基准文档：`codebuddy-jetbrains-plugin-file-inventory.md`（原插件 449 类 + 292 文件的逐文件清单）
> 被比对实现：`Plugins/win/Official/CodeBuddy/`（13 个 TS/TSX 文件）+ `windows/tauri/src-tauri/src/codebuddy_host.rs`
> 核实方式：对 `host/vscode-shim.ts`、`host/main.ts`、`codebuddy_host.rs` 做了 API 面扫描与关键函数实读（2026-10-26）
>
> 状态图例：✅ 已实现 · ⚠️ 存根/部分（接口在，行为空）· ❌ 未实现 · ➖ 不适用（第三方/构建产物，无需对应）

## 0. 比对基准

| 原插件层 | Lithe 对应物 |
|---|---|
| `bin/fusion-*`（Node SEA 宿主） | `host/main.ts`（Node sidecar，`bun build` 产物 `main.js`） |
| 主 jar（IDE 侧 449 类） | Rust 宿主 + 前端 pane/shim（**仅覆盖其中约 1/5 的类**） |
| vsix 扩展 | 原样 vendored（`vsix/extension/`，292 文件中的 279 个） |
| RPC（JSON-RPC over stdio） | `host/bridge.ts` + `codebuddy_host.rs` + `services/codebuddy-host-client.ts` |
| JCEF WebView | Tauri iframe + `codebuddy-webview-bridge.ts` |

---

## 1. 插件包顶层逐项

| 原文件 | 功能 | Lithe 对应 | 状态 |
|---|---|---|---|
| `bin/fusion-win-x64.exe` 等 5 个 | 运行扩展、实现 `vscode` API、stdio 通信 | `host/main.ts` sidecar | ✅（等价，单平台 win） |
| `devtools/*/rg`（5 平台 ripgrep） | `search_content` 工具的检索后端 | 无 | ❌ |
| `lib/fastjson2` | RPC JSON 序列化 | Node `JSON` / Tauri serde | ✅ |
| `lib/org.eclipse.lsp4j(+jsonrpc)` | LSP 协议（`lsp` 工具底座） | 无 | ❌ |
| `lib/opentelemetry-*`（10 个） | OTLP 遥测 | 无 | ❌ |
| `lib/flexmark/markdown/jsoup/openhtmltopdf/pdfbox` | Markdown 渲染与 PDF 导出 | 浏览器内渲染（webview 承担） | ✅（等价或不需要） |
| `lib/rsyntaxtextarea`、`java-diff-utils`、`commons-*`、`icu4j` 等 | Java 侧通用工具 | Node 侧/原生能力 | ✅ 或 ➖ |
| `META-INF/plugin.xml`（106KB） | 工具窗/设置页/状态栏/通知/动作声明 | `manifest.ts` + `extension-tool-window-registry.ts` | ⚠️ 仅工具窗，其余未声明 |
| `strings/copilot.properties` | IDE 侧文案 | 无（文案走 webview） | ➖ |
| `product.env.json`（`{"platform":"jetbrains"}`） | `ACC_PRODUCT_CONFIG` 注入 | `product-config-injection.ts`（注入完整配置，等价超集） | ✅ |

## 2. 主 jar 类逐组比对

### 2.1 入口/生命周期/动作（action、activity、listener、manager）

| 原类 | 功能 | 状态 |
|---|---|---|
| `CopilotLoginActivity` / `StartupLSAgent` | 启动期登录与语言服务 | ⚠️ sidecar 启动时激活扩展（等价），无语言服务 |
| `CodeBuddyToolsGroup` 等 5 个动作 | 清缓存/开日志/重置/开发者工具 | ❌ |
| 6 个 `Copilot*Listener` | IDE 事件监听推送扩展 | ⚠️ 仅 `onDidChangeTextDocument/ActiveTextEditor` 两个事件有定义，无真实源（无编辑器事件可听） |
| `CompletionManager`、`LocaleManager`、`LogManager`、`ThreadManager` | 补全调度/语言/日志/线程 | ⚠️ 日志有（output channel）；其余 ❌ |

### 2.2 RPC 与 devtools

| 原类 | 功能 | 状态 |
|---|---|---|
| `RPCProtocol` 等 6 类 | JSON-RPC 请求/响应/异常 | ✅ `bridge.ts`（行协议）+ `codebuddy_host_call/reply` |
| `RpcDevtoolsClient` 等 3 类 | RPC 帧录制调试 | ❌ |

### 2.3 宿主能力（MainThread\*，37 组）——逐个

| 原类 | 功能 | shim 现状 | 状态 |
|---|---|---|---|
| `MainThreadCommands` / `CommandImplementService` | 命令注册与执行 | `commands.execute` 桥通（144 命令） | ✅ |
| `MainThreadConfiguration` | 45 个设置项读写 | `getConfiguration` / `onDidChangeConfiguration` 已定义（内存默认值） | ⚠️ 无设置页、无持久化 UI |
| `MainThreadEditorsService` / **`MainThreadBulkEditsService`** | **agent 写文件的出口**（WorkspaceEdit/TextEdit） | `applyEdit: async () => true`（空实现，不落盘） | ❌ **关键缺口** |
| `MainThreadTerminalService` 等 5 类 | 终端执行（`execute_command` 出口） | `createTerminal` 返回假对象，`sendText` 无宿主 | ❌ **关键缺口** |
| `MainThreadLanguageFeaturesService` | LSP（定义/悬停/引用/补全） | 8 个 register\*Provider 返回空 Disposable | ❌ |
| `MainThreadContext` + 17 个表达式类 | `when` 子句求值引擎 | `createContextKey` 缺失 | ❌ |
| `MainThreadQuickOpen`（7 类） | 快速选择/输入框 | `showQuickPick` / `showInputBox` 已定义 | ⚠️ 待验证是否真弹 UI |
| `MainThreadMessageService` | 通知/消息 | `showErrorMessage` / `showInformationMessage` 已定义 | ⚠️ 同上 |
| `MainThreadStatusBar` | 状态栏条目 | `createStatusBarItem` 已定义（无宿主渲染） | ⚠️ |
| `MainThreadDialogs` | 模态对话框 | 未见实现 | ❌ |
| `MainThreadProgress` | 进度指示 | 未见实现 | ❌ |
| `MainThreadSCM` | Git/提交信息 | 无 | ❌ |
| `MainThreadExplorerMenusService` | 资源管理器右键 | 无 | ❌ |
| `MainThreadFileSystem` | 文件系统事件/读写 | `onDid{Save,Create,Rename,Delete}` 事件已定义（无源）；`workspace.fs` 缺失（`findFiles` MISSING） | ❌ |
| `MainThreadStorageService/PersistState` | 状态持久化 | `persistent-state.ts`（global-state.json / workspace-state.json） | ✅ |
| `MainThreadSecretState` | 敏感数据存储 | `secrets.json` 持久化（本轮实现） | ✅ |
| `MainThreadDocumentContentProviders` | 虚拟文档 | `registerTextDocumentContentProvider` 已定义 | ⚠️ |
| `MainThreadToolWindow` | 工具窗控制 | pane 打开/关闭 | ✅ |
| `MainThreadKeyBindingService` | 快捷键注册 | 无 | ❌ |
| `MainThreadLogService` | 输出通道 | `createOutputChannel` | ✅ |
| `MainThreadClipboard` | 剪贴板 | 未见实现 | ❌ |
| `MainThreadVscodeGitService` + RepoModel 7 类 | Git 仓库模型 | 无 | ❌ |
| `MainThreadWindow` / `MainThreadWorkspace` | 窗口/工作区 | 部分（`openExternal`、`asExternalUri`） | ⚠️ |
| `MainThreadLifeCycle`、`BaseProxy`、`Comments`、`EditorTabsService`、`WebviewPanelsService` 等 | 其余契约 | 部分注册为空 | ⚠️ |

### 2.4 ExtHost\* 契约（22 组）

| 原契约 | 状态 |
|---|---|
| Webviews / WebviewPanels / WebviewViews | ✅（iframe + `srcDoc` 注入 + nonce） |
| Commands / Configuration / Environment | ✅ |
| Documents / DocumentsAndEditors / Editors | ⚠️（类型与事件定义在，无真实文档模型） |
| Diagnostics / LanguageFeatures | ❌（collection 只发事件，`getDiagnostics`/`onDidChangeDiagnostics` 缺失） |
| SecretState | ✅（本轮实现持久化） |
| Authentication | ❌（`getSession` 恒返回 `undefined`，`registerAuthenticationProvider` 缺失——当前登录走 `external-link-v2` 不依赖它，但 `ide-host` 模式不可用） |
| Progress / QuickOpen / Window / Workspace / LifeCycle / Theming / Health / Comments / EditorTabs / FileSystemEventService | ⚠️/❌（多数空注册） |

### 2.5 WebView/JCEF 承载（约 60 类）

| 原类组 | 功能 | 状态 |
|---|---|---|
| `WebviewBrowser`、`WebviewMessageRouter`、`CspNonceExtractor`、`WebviewHtmlInjector`、`VirtualHost`、`FileResourceHandler` | 面板承载、桥接、nonce、本地资源域 | ✅（Tauri iframe + `convertFileSrc` + `codebuddy-webview-bridge.ts` 等价覆盖） |
| `BlankContentDetector`、`WebviewRecoveryPolicy`、`CefHealthSignals` | 白屏检测/恢复 | ❌（Tauri 无此问题，低优先） |
| `WebviewPanelFileEditor` 等 11 类 | WebView 作为编辑器标签 | ❌ |
| CDP 4 类、`dnd` 3 类、`telemetry` | 调试/拖放/遥测 | ❌ |

### 2.6 UI 实体（JetBrains 独有）

| 原类组 | 功能 | 状态 |
|---|---|---|
| 设置页 12 类 | 45 个配置项 UI | ❌ |
| 补全渲染（`CopilotInlayRender`、`CompletionItemsProviderV2`、6 个语言 handler、5 个符号解析器） | 行内补全/NES 宿主侧 | ❌ |
| 代码评审 UI（`CommentInLayPanel`、文件选择 3 类、通知/持久化 2 类、`renderer` 2 类） | AI 代码评审 | ❌ |
| 状态栏组件、`FusionStartFailedPanel`、`JcefInstallHintPanel` | 状态栏/失败提示 | ⚠️ pane 有失败态文本，无状态栏 |
| 行内聊天槽位图标、diff 弹窗、快捷键 | 行内聊天 | ❌ |

### 2.7 安全与防御

| 原类 | 功能 | 状态 |
|---|---|---|
| `GitIgnoreFileFilter` | 遍历遵守 .gitignore | ❌（`findFiles` 本身缺失） |
| `CustomProxySelector` / `ProxyConfiguration` | 代理同步 | ❌ |
| 遥测（report 3 类 + `CustomTracer`） | OTLP 上报 | ❌ |
| `StringEncryptUtils` 等 util 38 类 | 通用工具 | 按需逐个补，多数 ➖ |

## 3. vsix 文件逐组比对

| 原文件组 | Lithe | 状态 |
|---|---|---|
| `out/extension/index.js` + 5 个 chunk + wasm + tree-sitter | 原样 vendored，sidecar 加载成功（144 命令） | ✅ |
| `builtin/`（3 技能）、`wecom-skills/`（12 组）、`l10n/`、`resources/`、`out/webviews/` 全部、`node_modules/`（7 包）、`package.json`/`nls` | 原样 vendored | ✅ |
| `product.json` | 本轮从官方 zip 补齐并经 HTTP 注入生效 | ✅ |
| `product.external.json` / `product.internal.json` | 未复制 | ➖（环境变体，按需补） |
| `integration-mcp/`（12.2MB，AnyDev/EOP/Lighthouse/TCB） | **未复制** | ❌（连接器/部署类集成不可用） |
| `server.js`（2MB 服务端 bundle） | 未复制 | ➖（主 bundle 未引用，可忽略） |
| `out/vendor/` 安全删除体系（genie-trash + 4 语言垫片） | vendored 但**宿主 `execute_command` 未通**，整条链路失效 | ⚠️ |
| `.env` / `cell.yml` / `eslint.config.mjs` | 未复制 | ➖ |

## 4. 已验证可用 vs 不可用（端到端视角）

**可用（实机验证过）**：扩展激活、聊天面板渲染、双向消息桥、浏览器登录全链路（授权页打开 → token 轮询 → 蒙层自动收起 → secrets 持久化 → 重启免登录）、`env.openExternal`、产品配置注入（认证段/前缀路径）。

**接口在但为空壳（扩展不会崩，但行为缺失）**：`applyEdit`、`createTerminal`、diagnostics collection、8 个语言 provider、`authentication.getSession`、`workspace.fs`、编辑器事件源、设置项读写。

**完全缺失**：补全/NES 宿主管路、行内聊天、提交信息生成、代码评审 UI、添加到聊天各入口、设置页、状态栏、通知、快捷键、LSP、遥测、代理、GitIgnore 过滤、`when` 表达式引擎、集成 MCP、标题栏全部操作。

## 5. 修复优先级（按"用户可感知 × 成本"排序）

1. **`workspace.applyEdit` 真实现**（接 Tauri fs + 打开 diff）——解锁 agent 写代码的落盘；涉及 `MainThreadBulkEditsService` 等价物
2. **`execute_command` 终端链路**（接 Tauri shell）——解锁命令执行、测试、安全删除
3. **设置页 + 45 项配置持久化**——`workspace.getConfiguration` 已就绪，缺 UI 与存储
4. **标题栏操作**（新会话/历史/登出）——纯桥接命令转发，成本最低
5. **添加到聊天**（编辑器选区/资源管理器/终端右键）——需要选区事件源
6. **`workspace.fs` + `findFiles` + gitignore**——解锁文件类工具
7. 补全/NES、行内聊天、评审——大工程，依赖 1/2 先通
