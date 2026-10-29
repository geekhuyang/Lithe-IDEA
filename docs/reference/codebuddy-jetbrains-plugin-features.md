# CodeBuddy JetBrains 插件功能全集（4.12.41911495-8d24ca2b）

> 逆向分析基准：`D:\Downloads\coding-copilot-jetbrains-4.12.41911495-8d24ca2b.zip`
>
> 解包位置：`.artifacts/jetbrains-plugin/`（plugin zip）、`.artifacts/jetbrains-plugin/jar-extracted/`（主 jar 的 625 个类）、`.artifacts/jetbrains-plugin/jar-meta/`（META-INF 描述文件）
>
> 内置扩展同源副本：`Plugins/win/Official/CodeBuddy/vsix/extension/`（MIT，byte-for-byte）
>
> 分析方法：plugin.xml 声明贡献 + vsix `package.json` contributes + `product.json` 功能开关 + 运行时命令枚举（`getCommandId`） + webview 页面 UI 文案（2822 条） + 宿主契约类（ExtHost\*/MainThread\*） + `javap` 字节码与 class 字符串常量

---

## 1. 架构与运行形态

| 层 | 载体 | 职责 |
|---|---|---|
| IDE 宿主 | `instrumented-code-icc-extensions-4.12.41911495.jar`（625 类） | 工具窗、状态栏、设置页、JCEF WebView、编辑器/SCM/终端接入、RPC 服务端 |
| 扩展宿主 | `bin/fusion-win-x64.exe`（40.9MB Node SEA） | 运行内置 VS Code 扩展（vsix），把 VS Code API 调用经 JSON-RPC 转发到 IDE 侧 |
| 业务扩展 | `vsix/extension/`（56.6MB，`out/extension/index.js`） | 聊天、补全、行内聊天、MCP、规则、技能、提交信息生成等全部业务逻辑 |
| 聊天界面 | `out/webviews/`（25 个 JS chunk，本地资源） | 聊天页 UI，通过 `acquireVsCodeApi()` 与扩展宿主通信 |

通信：IDE ↔ fusion 走 stdio JSON-RPC（`ExtHost*` 在 fusion 侧、`MainThread*` 在 IDE 侧）；扩展 ↔ webview 走 postMessage。

---

## 2. IDE 侧界面贡献（plugin.xml）

| 贡献 | 声明 | 说明 |
|---|---|---|
| 工具窗 | `toolWindow id="com.tencent.code.intel.extension.WebviewBrowser" anchor="right"` | 右侧 CodeBuddy 工具窗，承载聊天 webview |
| 状态栏 | `statusBarWidgetFactory` → `FusionStatusBarFactory` / `FusionStatusWidget` | 登录态、模型状态、补全开关 |
| 设置页 | `applicationConfigurable groupId="tools"` → `ApplicationConfigurable` | IDE 设置 → Tools 下的 CodeBuddy 页 |
| 通知组 | `default`、`lowMemory`（均为 BALLOON） | 通知与低内存告警 |
| 动作 | `CodeBuddyToolsGroup`、`CleanJcefRenderCacheAction`、`OpenIdeLogAction`、`ResetPluginStatusAction`、`ToggleDeveloperToolsAction` | 工具窗内/IDE 内的维护动作 |
| 失败与降级面板 | `FusionStartFailedPanel`、`FusionStartFailureKind`、`JcefInstallHintPanel`、`LogCopyStartupActivity` | fusion 启动失败、JCEF 缺失提示、日志复制 |
| 子描述文件 | `copilot-vcs.xml`（Git 依赖；**提交信息动作与 checkin handler 被注释，未启用**）、`copilot-java.xml`、`copilot-javascript.xml`（均空）、`coding-copilot-no-jcef.xml`（JCEF 后台节流参数 provider，仅 JCEF 存在时生效） | 可选依赖的附加贡献 |

### 2.1 设置页实现（settings 包）

`ApplicationConfigurable` 下的分组：`ChatSetting`、`CompletionSetting`、`CompletionLanguageSetting`、`CodeStyleSetting`、`CommitMessageStyleSetting`、`CodeIndexSetting`、`EnvSetting`、`NetworkProxySetting`、`AdvancedSetting`、`SettingsForm`、`IConfigurable`。

### 2.2 其它 IDE 侧 UI 组件

- 行内提示：`CopilotInlayRender`、`CopilotInlayPresentation`、`InlineChatGutterIcon`、`GutterIconInfo`
- 悬浮/弹出：`PopUpPanel`、`DiffPopUpPanel`、`CompletionPreviewInsertionHint`、`CommentInLayPanel`
- 加载与占位：`LoadingPlaceholder`、`LoadingPanel`、`TextBackgroundPanel`、`ButtonBuilder`
- 调试侧栏：`CopilotDebugWindow`
- 通用控件：`HoverButton`、`RoundPanel`、`RoundedLineBorder`、`RoundLabel`
- WebView 承载：`WebviewBrowser`、`WebviewPanel`、`WebviewPanelFileEditor`（可作为编辑器标签页）、`VirtualHost`（本地资源虚拟域）、`WebviewRecoveryPolicy`、`ChatFontSizeChangeNotifier`、拖放（`AwtFileDropTargetListener`）、CDP（`CdpClient`/`CdpTracer`/`CdpProfiler`）

---

## 3. vsix 声明的界面贡献（package.json `contributes`）

- **视图容器**：`activitybar` → `coding-copilot-chat`（标题 CodeBuddy，图标 `resources/copilot.svg`）
- **视图**：`coding-copilot-chat` → `coding-copilot.webviews.chat`（type: webview，initialSize 1）
- **图标**：14 个 `icons` + 1 个 `iconFonts`
- **子菜单（4）**：`codingcopilot`、`codingcopilot.explorer`、`codingcopilot.terminal`、`shortcuts`
- **命令（声明 36）**、**快捷键（16）**、**设置项（45）**、**菜单入口（7 处）**、**authentication**：`{ label: "TencentCloud", id: "codingcopilot" }`

### 3.1 菜单入口（7 处）

| 位置 | 条目 |
|---|---|
| `view/title`（11） | 新建会话、会话历史、设置、在浏览器打开、预览、复制用户 ID、复制版本信息、切换聊天模式、新窗口打开、MCP 市场、规则管理 等（均要求 `codingcopilot.authenticated`） |
| `explorer/context`（1） | 添加到聊天 |
| `editor/context`（1） | 添加到聊天（非只读、非禁用时） |
| `editor/title/context`（1） | 添加到聊天 |
| `terminal/context`（3） | 添加到聊天 / 解释终端选中 / 修复终端选中 |
| `scm/title`（2） | **生成提交信息** / 取消生成（要求 git provider + 已登录 + 功能可用） |
| `commandPalette`（1） | 生成提交信息（`when=false`，即命令面板里隐藏） |

### 3.2 快捷键（16）

| 按键 | 命令 |
|---|---|
| `alt+\` | 触发补全 / 内联建议 |
| `tab` | 接受全部（completions / NES） |
| `ctrl+down` / `ctrl+right` | 逐行 / 逐词接受 |
| `escape` | 取消 |
| `ctrl+shift+enter` | 触发 NES |
| `ctrl+alt+i` | 添加到聊天（编辑器/终端选中） |
| `ctrl+i` | 行内聊天（IDE 版） |
| `alt+a` / `alt+r` / `alt+x` / `alt+z` | 行内任务 接受 / 重试 / 拒绝 / 取消（`.near` 变体） |

### 3.3 设置项（45）

分组要点：

- **补全**：`selectedCompletionModel`、`enableNextEditSuggestions`、`enableAutoCompletions`、`enableCompletionLanguage`、`generationPreference`
- **聊天提交**：`submitMessageShortcut`、`chatFontSizeMode`、`chatFontSize`
- **行内聊天**：`enableInlineChat`、`enableInlineChatAutoFormatCode`、`enableInlineChatShortcutsTip`、`enableInlineChatIDEShortcutsTip`、`toolbarOnSelection`
- **智能体**：`taskList`、`requestMaxStepLimit`、`customAgentMaxStep`、`autoRun`、`autoAcceptWebSearch`、`enabledWebSearch`
- **安全**：`safeDeleteEnabled`、`safeDeleteBulkThreshold`、`customBlacklistCommands`、`disabledSecurityCategories`
- **MCP 与生态**：`disableBuiltInMarketplace`、`autoUpdateThirdPartyMarketplaces`、`enableLsp`、`enableCraftCodeBase`、`enableCloudStudioTools`
- **Git**：`commitMessageStyle`、`commitMessageLanguage`
- **网络与企业**：`httpProxySettings`、`httpProxyURL`、`trustEnterpriseRootCa`、`endpoint`、`envRouteMode`、`envRouteCustom`、`enableClientProductPriority`
- **其它**：`enableFloatShortcut`、`enableSmartTitle`、`enableCodelens`、`standaloneTerminal`、`enableImageGen`、`enableIDENotification`、`enableModelOptimization`、`terminal.commandTimeoutMs`

---

## 4. 运行时命令全集（129）

> vsix 只对外声明 36 个；此处为 bundle 内 `getCommandId()` 与字面量枚举出的**全部**命令 id（与运行时 `commands.registered` 的 144 条一致）。

**A. 登录与账号（11）**：`login`、`auth`、`logout`、`switch.account.open`、`copy.userID`、`getAccountInfo`、`ide.accountManageMenu`、`ide.visibleProfileMenuItems`、`ide.host.authentication.init`、`mcp.oauth`、`getFreeUserUpgrade`、`getPaymentType`

**B. 会话与聊天（23）**：`chat.startNewChat`、`chatHistory`、`chat.questionHistory`、`chat.clear`、`chat.sendMessage`、`chat.summarizeConversation`、`chat.newWindowOpen`、`chat.switchChatMode`、`chat.switchChatModeV2`、`chat.explainCode`、`chat.fixCode`、`chat.generateTests`、`chat.generateTestsFromExplorer`、`chat.reviewCode`、`chat.reviewCodeFromExplorer`、`chat.summaryCode`、`chat.addTerminalSelectionToChat`、`chat.explainTerminalSelection`、`chat.fixTerminalSelection`、`addToChat`、`ide.addToChat`、`sendToChat`、`quickFix.addToChat`、`deeplink.prefillPrompt`、`isAgentBusy`、`checkChatRunning`

**C. 代码补全与 NES（12）**：`completions.trigger`、`completions.accept.all`、`completions.accept.all.after`、`completions.accept.line`、`completions.accept.word`、`completions.dismiss`、`completions.change.model`、`completions.is.enabled`、`completions.status.handler.register`、`completions.status.handler.unregister`、`autoCompletions.toggle`、`autoCompletions.language.toggle`、`nes.trigger`、`nes.accept.all`、`nes.dismiss`、`nes.toggle`

**D. 行内聊天（13）**：`inlineChat.start`、`inlineChat.process`、`inlineChat.document.code`、`inlineChat.task.accept`/`.near`、`inlineChat.task.retry`/`.near`、`inlineChat.task.reject`/`.near`、`inlineChat.task.cancel`/`.near`、`inlineChat.tip.enable`、`inlineChat.tip.disable`、`ide.inlineChat.start`

**E. Git 提交信息（3）**：`commit.message.generate`、`commit.message.cancel`、`commit.message.set`

**F. MCP（6）**：`mcpMarket`、`mcp.getSetting`、`mcp.openSettings`、`mcp.prompt`、`mcp.registerServer`、`mcp.unregisterServer`

**G. 规则与技能（3）**：`rules.manage`、`rules.show`、`ide.createRule`

**H. 设置与配置（10）**：`settings.show`、`codebuddy.settings.show`、`quickSettings.show`、`keybindings.show`、`ide.getRuntimeProductConfig`、`view.product.config`、`product.sync`、`client.product.priority.toggle`、`setBackgroundThrottling`、`ide.host.product.init`

**I. 诊断 / 更新 / 反馈（14）**：`update.check`、`checkNetworkConnectivity`、`help.document`、`issue.feedback`、`ide.submitFeedback`、`logger.show`、`logger.path.output`、`logger.package`、`logger.provideExtraPaths`、`upload.log`、`upload.log.silence`、`open.devPage`、`disable.developer.mode`、`reloadAllWindows`

**J. 浏览器 / 预览 / 外部（5）**：`openBrowser`、`preview`、`openYuanbao`、`open.floatShortcut`、`ide.jumpLink`

**K. IDE 集成与其它（17）**：`ide.workspace.fetch`、`ide.terminalChat.start`、`ide.automation.update`、`ide.figma.export`、`ide.miora.export`、`ide.miguration`、`spec.startBuild`、`codebase.manual.build.index`、`codeAction`、`codelens.action`、`getContext`、`getWebviewInfo`、`msgCenter.cornerBottomLeft.action`、`backgroundLLM.chat`、`test.sendMessageWithSummary`、`test.summaryOnly`、`test.backgroundLLM.chat`

---

## 5. 产品功能开关（`product.json` → `productFeatures`，72 项）

| 域 | 开关（默认） |
|---|---|
| 补全 | `InlineCompletions`✓、`NesCompletions`✓、`CompletionsPrefetching`✓、`CompletionsResultFusion`✓、`CursorPositonPrefetching`✓、`CompletionsRelatedSnippets`✓、`MultiFileWithPromptParam`✓、`MultiStepCompletions`✗、`MultiFileWithSeparateParams`✗、`RemoveBelowExist`✓、`TrimByIndentation`✓、`CRLFCompatible`✓、`ImportMetadataForCompletions`✓、`NesRepeatFilterV2`✓、`NesCompletionsJumpToHere`✓、`NESPrefetchingAfterEmptyCompletion`✓、`TriggerNESAfterCompletionHasBeenAccepted`✓、`NesCompletionsPrefetching`✓、`CompletionItemsForCompletions`✓、`EnhancedCompletionRequest`✗、`NesRepeatFilter`✗、`NesRangeFix`✗、`NesDocumentActiveChangeTrigger`✗、`NESNativeRenderer`✗ |
| 行内聊天 | `InlineChat`✓、`ToolbarOnSelection`（配置项） |
| 界面 | `StatusBar`✓、`CodeLens`✓、`CodeAction`✓、`FloatShortcut`✓、`TaskList`✓、`SelectComponent`✓、`UIComponentLibrary`✓、`BannerDecorativeImage`✓、`CBChatUI`✓、`GeneralSettings`✓、`AutoOpenDiffAfterEdit`✗、`FileDiffHistory`✗、`Inspiration`✗ |
| 智能体 | `Agents`✓、`Task`✓、`Plan`✓、`AskFollowupQuestion`✓、`AutoMode`✓、`SwitchBySession`✓、`requestMaxStepLimit: 2000` |
| 工具与生态 | `Mcp`✓、`McpMarket`✓、`McpInstallationGuide`✓、`Skills`✓、`SkillSecurityScan`✗、`LSP`（配置项）、`WebFetch`✓、`SummaryWebFetch`✓、`WebSearch`✓、`DynamicAddWebSearch`✓、`StandaloneTerminal`✓、`SelectImage`✓、`ImageGen`✓、`Codebase`✗、`Connector`✗ |
| 记忆与企业 | `MemoryManagement`✓、`EnableEnterpriseCustomModelPolicy`✓、`EnableEnterpriseSkillUploadPolicy`✓、`EnableLicenseExpirationCheck`✓ |
| 账号与运营 | `Billing`✓、`InternationalLogin`✓、`CustomModelsJSON`✓、`CustomModelIdPrefix`✓、`UseDefaultModelIfCurrentNotInList`✗、`Aegis`✗、`ProposalAPI`✗、`ReportAfterCancel`✗、`RequestBodyGzip`✓ |

**内置智能体（15）**：craft、plan、ask、CodeCompletion、CodeCompletionNes、CommitMessage、RemoteAgentProxy、InlineChat、agent、chat、enhance prompt、generate title、memory organize、inline-chat、terminal

**其它配置段**：`prompts`（22 条提示词模板）、`models`（15）、`links`（6）、`completion`（9）、`commands`（12）、`variables`（6）、`builtInSubagents`（2）、`builtInAgentsName`（5）、`tools`（1）、`tokenUsageThresholds`、`knowledgeBases`、`updates`、`featureToggles`、`telemetry`

---

## 6. 聊天页面（webview）功能域

> 由 `out/webviews/*.js` 抽取的 2822 条界面文案归纳（含简繁双语与错误提示）。

| 功能域 | 页面能力 |
|---|---|
| 会话模式 | 问答模式 / Agent 模式 / Max 模式；模式切换、模型选择、智能体选择 |
| 会话管理 | 新建会话、历史记录、问题历史、会话总结、清除会话、新窗口打开、会话导入/导出（zip，单条 ≤20MB） |
| 输入与附件 | 输入框、附件（数量上限、处理中状态）、`@` 引用文件/目录/终端选中、快捷命令（`/`）、关键词、重置输入框 |
| 智能体与任务 | 任务计划（Plan）、任务列表、追问（AskFollowupQuestion）、任务完成通知、步骤上限 |
| 工具与权限 | 工具调用授权确认（访问目录 / 调用 LLM / 高风险命令 / PowerShell 删除）、自动运行开关、命令黑名单 |
| MCP | MCP 市场、服务器列表、安装/配置/启用禁用、OAuth、提示词、Roots 管理、安装范围选择 |
| 规则与技能 | Rules 管理/选择（项目级）、Skills 管理（项目技能）、SKILL.md 校验、Hooks |
| 记忆与知识库 | 项目记忆、记忆整理迁移、知识库选择、Codebase 搜索（开关关闭）、LSP |
| 集成连接器 | Figma 设计稿转源码、Supabase 迁移、TCB 集成、EOP 集成、部署（沙箱/目录/最新版本/过期）、集成连接与账号选择 |
| 终端与运行 | 终端聊天、终端选中引用、运行/运行成功失败、独立终端、命令超时 |
| 预览与小程序 | 预览链接/二维码、模拟器元素选择、小程序页面重写、微信控制台日志 |
| 展示与渲染 | Markdown/LaTeX/Mermaid 渲染、代码差异与文件列表、变更预览、折叠展开、Token 用量（所有轮次/最后一轮/明细） |
| 账号与额度 | 登录方式选择、专用域登录地址、切换账号、登出确认、额度不足/购买资源、企业许可证过期、订阅 |
| 反馈与诊断 | 产品反馈、提交反馈、问题确认/已解决/未解决、错误码与错误信息、网络异常与重试、消息中心、链接过期 |
| 开发者与运维 | 开发者模式、渲染追踪/统计、产品配置查看、日志、重新加载、JCEF 渲染缓存清理 |

---

## 7. 宿主 API 契约（Lithe 需要提供的能力）

**fusion 侧（ExtHost\*，22）**：Commands、Configuration、Diagnostics、Documents、DocumentsAndEditors、EditorTabs、Editors、FileSystemEventService、Health、LanguageFeatures、LifeCycle、Progress、QuickOpen、SecretState、StatusBar、Theming、Webviews、WebviewPanels、WebviewViews、Window、Workspace、Comments

**IDE 侧（MainThread\*，37）**：Commands、CommandImplementService、Configuration、Context、Dialogs、DocumentContentProviders、DocumentsService、EditorTabsService、EditorsService、BulkEditsService、ExplorerMenusService、FileSystem、LanguageFeaturesService、LifeCycle、LogService、MessageService（含 MessageCommand/MessageOptions）、Progress、QuickOpen、SCM、SecretState、StatusBar、Storage/StorageService/StoragePersistState、TerminalService、TerminalShellIntegration、ToolWindow、VscodeGitService、WebviewPanelsService、WebviewsViewsService、Window、Workspace、Clipboard、BaseProxy

---

## 8. 与 Lithe 当前实现的对比

图例：✅ 已实现 · ⚠️ 部分 · ❌ 未实现

| # | 功能 | 状态 | 备注 |
|---|---|---|---|
| 1 | 右侧工具窗（活动栏按钮 + 面板） | ✅ | `lithe.codebuddy.chat` 工具窗 |
| 2 | 扩展激活与命令注册（144 条） | ✅ | Node sidecar + vscode API shim |
| 3 | 聊天 webview 渲染与双向消息桥 | ✅ | CSP nonce、本地资源、postMessage |
| 4 | 浏览器登录（external-link-v2）与登录引导卡片 | ✅ | 含 `env.openExternal` 桥、授权 URL |
| 5 | 会话持久化（secrets 落盘，重启免登录） | ✅ | `~/.lithe-codebuddy/secrets.json` |
| 6 | 宿主产品配置注入（`product.json` 通道） | ✅ | 认证段、端点、`/plugin` 前缀 |
| 7 | 登出 / 切换账号 / 复制用户 ID | ❌ | 命令已存在于扩展，缺 UI 入口 |
| 8 | 标题栏操作（新会话、历史、清除、设置、模式切换、MCP 市场、规则、模型切换、新窗口、重载） | ❌ | 命令已存在，缺 Lithe 侧入口 |
| 9 | 设置页（45 个配置项） | ❌ | 需 Lithe 设置面板 + `workspace.getConfiguration` 落地 |
| 10 | 状态栏 widget（登录/模型/补全状态） | ❌ | |
| 11 | 通知组与失败/降级面板 | ⚠️ | pane 仅错误横幅，无 JCEF/日志复制/低内存 |
| 12 | 提交信息生成（SCM 入口） | ❌ | 本轮刻意延后；原插件 IDE 侧动作亦已注释 |
| 13 | 添加到聊天（编辑器/资源管理器/终端/快速修复） | ❌ | 需编辑器选中区、终端选中、诊断等 API |
| 14 | 行内聊天（含 accept/retry/reject/cancel） | ❌ | |
| 15 | 代码补全与 NES（触发/逐行逐词/取消/模型切换） | ❌ | |
| 16 | MCP 市场与服务器管理（webview 内） | ⚠️ | 页面在 webview 内可渲染，但 Lithe 侧能力与配置未接 |
| 17 | 规则 / 技能 / 项目记忆（webview 内） | ⚠️ | 同上 |
| 18 | 终端聊天与终端选中引用 | ❌ | |
| 19 | 集成连接器（Figma / Supabase / TCB / 部署） | ❌ | |
| 20 | 预览（链接/二维码）与小程序相关 | ❌ | |
| 21 | 会话导入/导出、Token 用量展示 | ⚠️ | webview 内可用，宿主侧未验证 |
| 22 | 更新检查、反馈、日志打包上传 | ❌ | |
| 23 | 拖放文件到 webview、webview 作为编辑器标签、字体缩放 | ❌ | |
| 24 | IDE 维护动作（清渲染缓存/开日志/重置状态/开发者工具） | ❌ | |
| 25 | AI 代码评审（发起、文件选择、分级结果、行内评论、评论持久化） | ❌ | 命令已在扩展内，缺入口与 IDE 侧展示 |
| 26 | 代理 / Git 忽略 / 遥测 / when 表达式引擎 | ❌ | 宿主契约层，随 API 补齐 |

**统计**：✅ 6 · ⚠️ 4 · ❌ 16（按功能域，共 26 项）

---

## 9. AI 代码评审（Code Review）—— 复查补录

> 首轮按命令与菜单统计时遗漏：评审入口在 webview 会话内触发，IDE 侧有独立的 UI 与持久化体系。

| 层 | 类 / 载体 | 说明 |
|---|---|---|
| 评审结果模型 | `bean/item/CodeReviewResult`、`CodeReviewTask`、`CodeReviewTaskResultLevelEnum`（结果等级）、`CodeReviewComment`、`CodeReviewDiffContext`、`CodeReviewFunction`、`CodeReviewRequestFile`、`CodeReviewRequestRange` | 评审任务、分级结果、评论、diff 上下文、函数与范围 |
| 入口 | `chat.reviewCode`、`chat.reviewCodeFromExplorer` 命令（webview 会话内 / 资源管理器） | 发起评审 |
| 文件选择 UI | `ui/sidebar/conversation/chat/footer/file/CodeReviewChooseByNamePanel`、`CodeReviewFileChooserDialog`、`CodeReviewGotoFileModel` | 按名选择文件、文件选择弹窗、跳转到文件 |
| 评论与通知 | `ui/sidebar/conversation/chat/notifier/CodeReviewCommentUpdateNotifier`、`ui/sidebar/conversation/chat/store/AICRCommentsPersistState` | 评论更新通知、评论持久化 |
| 展示 | `ui/cr/CommentInLayPanel`（行内评论面板）、`CodeReviewDiffContext` | 编辑器内评论展示与 diff 上下文 |

对应页面文案：「通过工程分析，诊断代码出现的问题，并给出评审建议」「問題確認 / 问题已解决 / 问题未解决」「文件列表」「相关文件」「预览变更内容」等。

## 10. 其它复查补录（JetBrains 侧独有，vsix 无对应声明）

| 能力 | 载体 | 说明 |
|---|---|---|
| `when` 上下文表达式引擎 | `apibridge/extension/mainthread/context/contextexpression/*`（17 类：And/Equals/Greater/In/Not/NotIn/Regex …） | 在 IDE 侧求值 VS Code 的 `when` 子句（菜单可见性条件） |
| 编辑器事件监听 | `apibridge/util/FusionCaretListener`、`FusionDocumentListener`、`FusionSelectionListener`、`FusionFileChangeListener`、`FusionProjectListener`、`FusionEditorFactoryListener` | 光标/文档/选区/文件/项目变更推送给扩展 |
| 诊断监听 | `apibridge/listener/DiagnosticsAsyncFileListener` | 诊断信息变更 |
| 代理配置 | `bean/proxy/ProxyConfiguration` | IDE 代理设置同步给扩展（对应 `httpProxySettings` / `httpProxyURL`） |
| Git 忽略过滤 | `filter/GitIgnoreFileFilter` | 文件遍历时遵守 `.gitignore` |
| 遥测上报 | `apibridge/report/*`（FusionTelemetrySpanService / MeterService / MeterEvent）、`bean/product/Telemetry`、`apibridge/extension/mainthread/webview/telemetry/WebviewTelemetryReporter` | 性能与行为遥测 |
| 行内颜色提示 | `bean/item/InlayColorItem` | Inlay Hints 的颜色通道 |
| 公共枚举 | `common/ChatLanguage`、`CodeStyle`、`Edition`、`Indent`、`InlayAcceptMode`、`InlayDisplayMode`、`Language`、`EditorCommandName`、`SdkIcons`、`PluginInfo` | 补全接受/显示模式、语言、代码风格、版本等 |

---

## 11. Agent 执行引擎：代码编写与子代理调度

> 研究目标：agent 收到用户"写代码"请求时如何产出代码、如何把任务派给子代理。
> 证据：`out/extension/index.js` 的 `AgentContextBuilder` / `AgentDispatcher` / `ToolProviderImpl` / `SubagentManager` / `Subagent` / `streamParser`，以及 `product.json` 的 `agents` / `builtInSubagents` / `requestMaxStepLimit`。

### 11.1 主链路

```
用户输入
  → AgentContextBuilder：组装 system prompt + 工具集 + maxStepLimit + 变量
  → AgentDispatcher.dispatch({ agent, agentContext })
  → 模型流式输出（SSE）
  → streamParser 解析 tool call（兼容 Claude 风格工具名）
  → ToolProvider 查找工具实现并执行
  → 工具结果回注为下一轮输入
  → 循环，直到 attempt_completion / 步数上限 / 用户中断
```

- `maxStepLimit = 用户设置 customAgentMaxStep ?? product.requestMaxStepLimit(2000) ?? 2000`（@6844552）
- Agent 实例：`maxStepLimit ?? 100`；`maxTokenThreshold = 0.8 × model.maxInputTokens(128k)`（@7000530）

### 11.2 代码编写：工具集与落地

**写代码的 agent 及其工具集**（`product.json → agents`）：

| agent | 模型 | 工具 |
|---|---|---|
| **craft**（写代码主体） | deepseek-v4-flash / hy3 | read_file, list_dir, search_file, search_content, semantic_search, RAG_search, execute_command, **write_to_file**, **replace_in_file**, **delete_file**, unit_test, plan_attempt_completion, mcp_server |
| **plan** | deepseek-v4-flash | 同 craft（多 init / rules / help 命令） |
| ask（只读问答） | deepseek-v4-flash / hy3 | 仅前 6 个只读工具 |
| 其它 | 各自模型与提示词 | InlineChat、inline-chat、terminal、CommitMessage、CodeCompletion(Nes)、enhance prompt、generate title、memory organize、RemoteAgentProxy、agent、chat |

**工具注册表**（`DEFAULT_TOOL_PROVIDER`，`ToolProviderImpl.registerTool(name, impl, metadata)`）：

```
LIST_FILES → ListDirTool          SEARCH_FILE → SearchFileTool
SEARCH_CONTENT → SearchContentTool     READ_FILE → ReadFileTool
READ_LINTS → ReadLintsTool       REPLACE_IN_FILE → ReplaceInFileTool
WRITE_TO_FILE → WriteToFileTool   DELETE_FILES / EXECUTE_COMMAND / PLAN_ATTEMPT_COMPLETION …
```

**`ToolCallName` 枚举（29）**：list_dir、search_file、search_content、read_file、read_lints、replace_in_file、delete_file、write_to_file、execute_command、plan_attempt_completion、oj_build_command、create_tasks、update_task、list_tasks、append_task、todo_write、rule_match、read_rules、create_rule、mcp_call_tool、mcp_get_tool_description、list_code_definition_names、search_integration_tool、web_fetch、generate_wiki_docs、use_skill、web_search、**task**、update_memory
（另有 codebase_search、lsp、image_gen、conversation_search、open_result_view、connect_cloud_service、debug_issue_confirm 等）

**工具名兼容层**：模型可能输出 Claude Code 风格名（`Task/Bash/Glob/Grep/Read/Edit/Write/NotebookEdit/WebFetch/TodoWrite/WebSearch…`），内部由 `COMPATIBLE_NAME_TO_CANONICAL` 映射回规范名（@558019）。

**落到编辑器**：工具内部构造 `vscode.WorkspaceEdit`（`new WorkspaceEdit` + `Range/Position` + insert/delete/replace），再调 `workspace.applyEdit(...)`；`FileUtils` 的 `insertLine` / `clearDocumentContent` 同走此路径（@582756）。宿主侧由 `MainThreadBulkEditsService` / `MainThreadEditorsService` 应用到真实编辑器。

### 11.3 子代理（Subagent）机制

**派活工具 = `task`**（`ToolCallName.TASK = "task"`，兼容名 `Task`）。

**子代理实例**（`new Subagent(...)`，@11086363）：

```js
{
  name,                  // code-explorer / codewiki / 用户自定义
  system: { prompt },    // 独立 system prompt
  model,                 // 可 inherit 主 agent 模型
  providerType,
  toolProvider,          // 独立工具集
  agentIntent: "custom",
  maxStepLimit,          // 独立步数上限（默认 100）
  services,
  conversationId, parentConversationId   // 父子会话关联
}
```

**子代理定义格式**（`product.json → builtInSubagents`，类 SKILL.md 的 frontmatter + 正文）：

```yaml
---
name: code-explorer
description: Fast subagent specialized in codebase exploration...
tools: search_file, search_content, read_file, list_files, codebase_search, lsp
agentMode: agentic
enabled: true
enabledAutoRun: true      # 免确认自动运行
---
You are a file search specialist...   # 正文即子代理 system prompt（含"速度预算"等约束）
```

内置两个：

| 子代理 | 工具 | model | enabledAutoRun |
|---|---|---|---|
| code-explorer | search_file, search_content, read_file, list_files, codebase_search, lsp（只读） | 继承 | true |
| codewiki | generate_wiki_docs | inherit | false（需用户确认） |

**加载与注入**：`SubagentManager` 单例提供 `loadAllSubagents({agentMode:"agentic", useCache, checkEnable})`、`parseBuiltInSubagentFile(content)`、`loadBuiltInSubagent()`（product 配置 + 本地 `builtin-configs.json` 缓存）。当 `productFeatures.Task` 开启且 agent 为 CUSTOM 时，可用子代理清单连同其 system prompt 会被拼进**主 agent 的 system prompt**（变量 `subAgentPrompt`），主 agent 才知道"有哪些子代理、何时该派活"（@6840693）。

**审批隔离**：`SubagentApprovalTracker`（10s 节流）与 `trackSubagentPendingSource(..., source="subagent")` 把子代理的待确认工具调用与主会话分开记账（@1938610、@393484）。

### 11.4 防跑偏与循环刹车

| 机制 | 阈值 | 作用 |
|---|---|---|
| `maxStepLimit` | 主 2000 / 子代理默认 100（用户设置 > 产品配置 > 默认） | 总步数上限 |
| `LOOP_DETECTED_MARKER`（`[LOOP_DETECTED]`） | — | 检出重复动作后注入提醒 |
| `BLACKLIST_IDENTICAL_LIMIT` | 4 | 黑名单工具（read_file / replace_in_file / write_to_file / search_* / execute_command / web_* / use_skill / plan_create）相同调用上限 |
| `NON_BLACKLIST_IDENTICAL_LIMIT` | 40 | 其它工具相同调用上限 |
| `READ_FILE_SAME_PATH_LIMIT` | 40 | 同路径重复读取上限 |
| `READ_ONLY_EXPLORATION_LIMIT` | 40 | 连续只读探索上限，触发"必须推进"提醒 |
| `maxTokenThreshold` | 0.8 × 128k | 上下文达 80% 触发 context cutting |

### 11.5 对 Lithe 的宿主能力缺口

| 工具 | 需要的宿主能力（MainThread\*） | 当前 shim 状态 |
|---|---|---|
| write_to_file / replace_in_file / delete_file | `workspace.applyEdit` + WorkspaceEdit → BulkEditsService / EditorsService | stub，需接 Lithe 编辑器 |
| read_file / list_dir / search_* | 工作区文件访问 | 部分可用（Node 侧直读） |
| execute_command / unit_test | 终端执行 → TerminalService / TerminalShellIntegration | 未接 |
| read_lints | 诊断 → Diagnostics / LanguageFeaturesService | 未接 |
| lsp | 语言服务（定义/引用/符号）→ LanguageFeaturesService | 未接 |
| mcp_call_tool | 扩展内部自建 MCP 客户端 | 不依赖宿主 |
| **task（子代理）** | 纯扩展内部：SubagentManager + Subagent 实例 + 模型流式调用 | **已具备**（只需 product 配置正确注入） |

结论：**子代理调度是扩展自包含的**，我们只需保证 `product.json` 的 `builtInSubagents` / `requestMaxStepLimit` 通过配置注入生效；真正缺的是"写回编辑器、终端、诊断、LSP"四个宿主出口，这决定 agent 产出的代码能否落进用户文件。

## 12. 建议的实施优先级

1. **标题栏操作与账号菜单**（7、8）——成本最低，直接复用现有 `commands.execute` 桥
2. **设置页**（9）——需要 Lithe 设置面板承载 45 项配置 + shim 的 configuration 落地
3. **添加到聊天 / 提交信息生成**（12、13）——需要编辑器选中、终端、SCM 诊断等 Lithe 侧 API
4. **状态栏与通知**（10、11）——轻量，提升可发现性
5. **行内聊天与补全**（14、15）——工作量最大，需编辑器内核集成与快捷键体系
6. **生态能力**（16–23）——随宿主 API 契约补齐后逐步可用（多数在 webview 内已就绪）
