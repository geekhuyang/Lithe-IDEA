# CodeBuddy JetBrains 插件逐文件功能分析（4.12.41911495-8d24ca2b）

> 基准：`D:\Downloads\coding-copilot-jetbrains-4.12.41911495-8d24ca2b.zip`
> 解包位置：`.artifacts/jetbrains-plugin/`
> 本文逐文件（或逐类）说明其提供的功能；文件名后为体积。
> 相关文档：`codebuddy-jetbrains-plugin-features.md`（按功能域组织的清单与实现对比）

## 0. 总量概览

| 部分 | 文件数 | 体积 | 说明 |
|---|---|---|---|
| 插件包顶层 | 42 | 约 220 MB | 5 个平台 fusion 二进制 + 各平台 ripgrep + 40 余个依赖 jar + vsix |
| 主 jar（`instrumented-code-icc-extensions`） | 928 条目 | 1.6 MB | 449 个顶层类 + 176 个内部/匿名类 + 描述与资源 |
| vsix（`vsix/extension/`） | 292 | 56.6 MB | 内置 VS Code 扩展：业务 bundle、聊天页资源、技能、MCP 集成、原生模块 |

---

## 1. 插件包顶层

### 1.1 `bin/` —— 扩展宿主（fusion，Node SEA 单文件可执行）

| 文件 | 体积 | 功能 |
|---|---|---|
| `fusion-win-x64.exe` | 41.9 MB | Windows x64 扩展宿主：运行 vsix 扩展，提供 `vscode` API 实现，经 stdio JSON-RPC 与 IDE 通信 |
| `fusion-linux-x64` | 56.2 MB | Linux x64 同上 |
| `fusion-linux-arm64` | 54.1 MB | Linux ARM64 同上 |
| `fusion-macos-x64` | 52.3 MB | macOS x64 同上 |
| `fusion-macos-arm64` | 46.7 MB | macOS ARM64 同上 |

### 1.2 `devtools/` —— 搜索后端

| 文件 | 功能 |
|---|---|
| `linux/x64`、`linux/arm64`、`macos/x64`、`macos/arm64`、`win/x64` 下的 `node_modules/@vscode/ripgrep/bin/rg`（或 `rg.exe`） | 各平台 ripgrep 二进制，供 `search_content` 工具做高速正则检索 |

### 1.3 `lib/` —— Java 依赖

| 类别 | 代表文件 | 功能 |
|---|---|---|
| 插件本体 | `instrumented-code-icc-extensions-4.12.41911495.jar`（1.6 MB） | 全部 IDE 侧逻辑（见第 2 章） |
| 插件元数据 | `searchableOptions-4.12.41911495.jar` | IDE 设置搜索索引 |
| JSON | `fastjson2-2.0.63.jar` | RPC 与配置的 JSON 序列化 |
| Markdown / HTML / PDF | `flexmark-*`、`markdown-0.1.45.jar`、`jsoup-1.14.3.jar`、`openhtmltopdf-*`、`pdfbox-2.0.24.jar`、`fontbox-2.0.24.jar`、`xmpbox-2.0.24.jar`、`graphics2d-0.32.jar` | 会话内 Markdown 渲染、HTML 解析、导出 PDF |
| 编辑器组件 | `rsyntaxtextarea-3.3.2.jar` | 代码预览/片段高亮 |
| 差异与工具 | `java-diff-utils-4.12.jar`、`commons-io`、`commons-lang3`、`commons-text`、`commons-logging`、`autolink-0.6.0.jar`、`icu4j-59.1.jar`、`java-uuid-generator` | 文本 diff、IO/字符串/国际化/UUID |
| LSP | `org.eclipse.lsp4j-0.21.0.jar`、`org.eclipse.lsp4j.jsonrpc-0.21.0.jar` | LSP 协议与 JSON-RPC（供 `lsp` 工具） |
| 遥测 | `opentelemetry-*`（api / sdk / sdk-common / sdk-logs / sdk-metrics / sdk-trace / exporter-otlp / exporter-common / context / extension-autoconfigure-spi） | OTLP 遥测上报（对应 `CustomTracer` / `ResilientSpanExporter`） |
| 网络 | `okhttp-4.12.0.jar`、`okio`（随包） | 扩展侧 HTTP 客户端 |

### 1.4 `vsix/` —— 内置 VS Code 扩展

| 文件 | 功能 |
|---|---|
| `extension.vsixmanifest`（2.8 KB） | VSIX 包清单（标识、版本、目标产品） |
| `[Content_Types].xml`（1.8 KB） | OPC 包内容类型声明 |
| `extension/`（292 文件，56.6 MB） | 扩展本体（见第 3 章） |

---

## 2. 主 jar 内文件（IDE 侧，449 个顶层类 + 176 个内部类）

### 2.1 描述与资源

| 文件 | 功能 |
|---|---|
| `META-INF/MANIFEST.MF` | jar 清单 |
| `META-INF/plugin.xml`（106 KB） | 插件主描述：工具窗、状态栏、设置页、通知组、动作、依赖与可选 config-file |
| `META-INF/copilot-vcs.xml` | 可选 Git 依赖描述（提交信息动作与 checkin handler **已注释，未启用**） |
| `META-INF/copilot-java.xml`、`META-INF/copilot-javascript.xml` | 语言可选依赖描述（均空） |
| `META-INF/coding-copilot-no-jcef.xml` | JCEF 存在时生效的附加描述：Chromium 后台节流参数 provider |
| `META-INF/pluginIcon.svg` | 插件图标 |
| `strings/copilot.properties` | IDE 侧界面文案（英文基准） |
| `product.env.json` | 注入扩展的产品配置（`{"platform":"jetbrains"}`），经 `ACC_PRODUCT_CONFIG` 传递 |

### 2.2 类：入口、生命周期与动作

| 包 | 类 | 功能 |
|---|---|---|
| `activity` | `CopilotLoginActivity`、`StartupLSAgent` | 启动期活动：登录态初始化、语言服务代理启动 |
| `action` | `CodeBuddyToolsGroup`、`CleanJcefRenderCacheAction`、`OpenIdeLogAction`、`ResetPluginStatusAction`、`ToggleDeveloperToolsAction` | 工具窗动作组；清理渲染缓存、打开 IDE 日志、重置插件状态、开发者工具开关 |
| `action/base` | `BaseAnAction` | 动作基类（统一可用性/异步执行） |
| `listener` | `CopilotAppLifecycleListener`、`CopilotCommandListener`、`CopilotEditorFactoryListener`、`CopilotLookupManagerListener`、`CopilotPluginLoadListener`、`WorkspaceRootsChangeListener` | 应用/命令/编辑器/查找/插件加载/工作区根变更监听 |
| `manager` | `CompletionManager`、`LocaleManager`、`LogManager`、`ThreadManager` | 补全调度、语言环境、日志、线程池管理 |

### 2.3 类：RPC 协议与 devtools

| 包 | 类 | 功能 |
|---|---|---|
| `apibridge/rpcprotocol` | `RPCProtocol`、`RPCProtocolData`、`RPCProtocolReq`、`RPCProtocolRsp`、`RPCRemoteException`、`RpcProtocolDataReader` | IDE ↔ fusion 的 JSON-RPC 协议实现（请求/响应/异常/读帧） |
| `apibridge/rpcdevtools` | `RpcDevtoolsClient`、`RpcDevtoolsSupport`、`RpcFrameRecorder` | RPC 开发调试工具与帧录制 |

### 2.4 类：宿主能力（ExtHost\* 在 fusion 侧的对端）

| 包 | 类 | 功能 |
|---|---|---|
| `apibridge/extension/mainthread/command` | `MainThreadCommands`、`MainThreadCommandImplementService` | 命令执行与命令注册实现 |
| `…/configuration` | `MainThreadConfiguration` | 配置读写（45 个设置项落点） |
| `…/context` + `context/contextexpression`（17 类） | `MainThreadContext`、`ContextAndExpression`、`ContextEqualsExpression`、`ContextInExpression`、`ContextRegexExpression` 等 | VS Code `when` 子句在 IDE 侧的求值引擎（与/或/非/等于/大于/正则/In 等） |
| `…/documents`、`…/documentcontent` | `MainThreadDocumentsService`、`MainThreadDocumentContentProviders` | 文档内容与虚拟文档提供者 |
| `…/editors` + `editors/model` | `MainThreadEditorsService`、`MainThreadBulkEditsService`、`DecorationOptionsParser` + `WorkspaceEditDto`、`TextEditDto`、`DocumentEdit`、`TextDocumentShowOptions` | **代码编辑落地**：WorkspaceEdit / TextEdit 应用到真实编辑器（agent 写文件的出口） |
| `…/editortabs` | `MainThreadEditorTabsService` | 编辑器标签组状态 |
| `…/languagefeature` | `MainThreadLanguageFeaturesService` | LSP 能力（补全/悬停/定义/引用/符号） |
| `…/quickopen`（7 类） | `MainThreadQuickOpen`、`QuickInputSession`、`QuickModalSelectorSession`、`TransferQuickPickItem` 等 | 快速选择/输入框（模型选择器、文件选择器） |
| `…/dialogs` | `MainThreadDialogs` | 模态对话框（确认、输入） |
| `…/message` + `model` | `MainThreadMessageService`、`MainThreadMessageCommand`、`MainThreadMessageOptions` | 通知与消息（含操作按钮） |
| `…/progress` | `MainThreadProgress` | 进度指示 |
| `…/scm` | `MainThreadSCM`、`SCMMenuContext` | SCM（Git）面板与提交信息入口 |
| `…/explorer` | `MainThreadExplorerMenusService`、`ExplorerMenuContext` | 资源管理器上下文菜单 |
| `…/filesystem` | `MainThreadFileSystem` | 文件系统读写与事件 |
| `…/storage`（2 类） | `MainThreadStorageService`、`MainThreadStoragePersistState` | 扩展状态持久化 |
| `…/secretstate` | `MainThreadSecretState`、`SecretStorage` | 敏感数据（token）存储 |
| `…/statusbar` | `MainThreadStatusBar`、`FusionStatusWidget` | 状态栏条目与 CodeBuddy 状态组件 |
| `…/terminal`（5 类） | `MainThreadTerminalService`、`MainThreadTerminalShellIntegration`、`Terminal`、`TerminalManager`、`TerminalLaunchConfig` | 终端创建、命令执行、Shell 集成（`execute_command` 出口） |
| `…/toolwindow`（3 类） | `MainThreadToolWindow`、`CustomPopupAction`、`ToolwindowMenuContext` | 工具窗控制与菜单 |
| `…/keybinding` | `KeyBindingService`、`KeyBindingRule`、`MenuRule` | 快捷键与菜单规则注册 |
| `…/log` | `MainThreadLogService` | 输出通道日志 |
| `…/clipboard` | `MainThreadClipboard` | 剪贴板读写 |
| `…/extensions` + `RepoModel`（7 类） | `MainThreadVscodeGitService`、`VscodeGitCommitWatcher`、`Repository`、`Branch`、`Commit`、`Remote`、`UpstreamRef`、`RepositoryState` | Git 仓库模型与提交监听（提交信息生成的数据源） |
| `…/window`、`…/workspace` | `MainThreadWindow`、`MainThreadWorkspace`、`SearchOption` | 窗口与工作区（含文件搜索） |
| `apibridge/extension/extension/*`（22 个 ExtHost 契约实现） | `ExtHostCommands`、`ExtHostConfiguration`、`ExtHostDiagnostics`、`ExtHostDocuments(AndEditors)`、`ExtHostEditorTabs`、`ExtHostEditors`、`ExtHostFileSystemEventService`、`ExtHostHealth`、`ExtHostLanguageFeatures`、`ExtHostLifeCycle`、`ExtHostProgress`、`ExtHostQuickOpen`、`ExtHostSecretState`、`ExtHostStatusBar`、`ExtHostTheming`、`ExtHostWebviews`、`ExtHostWebviewPanels`、`ExtHostWebviewViews`、`ExtHostWindow`、`ExtHostWorkspace`、`ExtHostComments`、`MainThreadStorage` | fusion 侧的 VS Code API 契约层（`vscode.*` 能力在 fusion 的实现，再转发到 IDE） |

### 2.5 类：WebView / JCEF 承载

| 包 | 类 | 功能 |
|---|---|---|
| `…/webview`（11） | `WebviewBrowser`、`WebviewService`、`WebviewMessageRouter`、`WebviewNavigationRouter`、`WebviewPendingMessageQueue`、`WebviewRuntimeScriptRunner`、`MainThreadWebviewPanelsService`、`MainThreadWebviewsViewsService`、`NavigationState`、`ChatFontSizeChangeNotifier`、`JcefCacheCleaner` | 聊天面板浏览器组件、消息路由、运行时脚本注入、字体变更通知、缓存清理 |
| `…/webview/manager`（7） | `WebviewManager`、`WebviewHost`、`ToolWindowWebviewHost`、`EditorTabWebviewHost`、`WebviewContext`、`WebviewState`、`WebviewHandleAliases` | WebView 宿主抽象（工具窗 / 编辑器标签两种宿主） |
| `…/webview/editor`（11） | `WebviewPanelFileEditor`、`WebviewPanelFileEditorProvider`、`WebviewPanelVirtualFile`、`WebviewPanelRegistry`、`WebviewPanelTabs`、`WebviewPanelIcons`、`WebviewPanelViewState(Tracker)`、`ViewColumnMapper` 等 | 把 WebView 作为 IDE 编辑器标签页打开 |
| `…/webview/jcef`（10） | `CBCefBrowser`、`JcefEnvironmentConfigurator`、`JcefBackgroundThrottlingArguments`、`WebviewCefHandlerRegistrar`、`BlankContentDetector`、`BlankContentCore`、`SourceRenderingDetector`、`CefHealthSignals`、`CefHostProbe`、`JcefCacheCleanupAction` | JCEF 环境配置、后台节流参数、白屏检测与恢复、健康探测 |
| `…/webview/html` | `CspNonceExtractor`、`WebviewHtmlInjector` | **提取页面 CSP nonce 并注入桥接脚本**（与 Lithe 的 `buildWebviewDocument` 同职责） |
| `…/webview/resource`（6） | `FileResourceHandler`、`InMemoryResourceHandler`、`StatusResourceHandler`、`MimeTypeResolver`、`GzipSupport`、`WebviewResourceConfig` | 本地资源服务（文件/内存/gzip/MIME） |
| `…/webview/vhost` | `VirtualHost`、`VirtualHostService`、`ResourceCache` | 虚拟域承载本地资源（等价于 `convertFileSrc` 的资产域） |
| `…/webview/dnd` | `AwtFileDropTargetListener`、`DragDataResolver`、`DragOperationRegistry` | 拖放文件到 WebView |
| `…/webview/cdp` | `CdpClient`、`CdpTarget`、`CdpTracer`、`CdpProfiler` | CDP 调试与性能采样 |
| `…/webview/ui` | `WebviewPanel`、`LoadingPlaceholder`、`TextBackgroundPanel`、`ButtonBuilder` | WebView 容器与加载占位 UI |
| `…/webview/recovery` | `WebviewRecoveryPolicy` | WebView 白屏/卡死恢复策略 |
| `…/webview/telemetry` | `WebviewTelemetryReporter` | WebView 侧遥测 |
| `…/webview/util` | `ClipboardReader`、`FileUrlNormalizer`、`WebviewResourcePath` | 剪贴板读取、文件 URL 规范化 |

### 2.6 类：工具窗、状态栏与降级 UI

| 包 | 类 | 功能 |
|---|---|---|
| `apibridge/toolwindow` | `ToolWindowHelper`、`FusionStartFailedPanel`、`FusionStartFailureKind`、`JcefInstallHintPanel`、`LogCopyActionListener`、`LogCopyStartupActivity` | 工具窗装配；fusion 启动失败面板、JCEF 缺失提示、日志复制 |
| `ui/statusbar` | `CopilotStatusBarWidget`、`LoadingPanel` | 状态栏组件与加载指示 |
| `ui/pane` | `RoundPanel`、`RoundLabel`、`HoverButton`、`RoundedLineBorder` | 圆角面板/标签/悬浮按钮等通用控件 |
| `ui/inlay`、`ui/inlayhints` | `CopilotInlayRender`、`CopilotInlayPresentation` | 行内补全渲染与 Inlay Hints 呈现 |
| `ui/inline` | `InlineChatGutterIcon`、`GutterIconInfo` | 行内聊天的编辑器槽位图标 |
| `ui/hintpop` | `PopUpPanel`、`DiffPopUpPanel`、`CompletionPreviewInsertionHint` | 悬浮提示、diff 弹窗、补全插入提示 |
| `ui/cr` | `CommentInLayPanel` | AI 代码评审的编辑器内评论面板 |
| `ui/sidebar/conversation/*` | `ChatConstant`、`CodeReviewChooseByNamePanel`、`CodeReviewFileChooserDialog`、`CodeReviewGotoFileModel`、`CodeReviewCommentUpdateNotifier`、`AICRCommentsPersistState` | 会话常量；评审文件选择/跳转、评论更新通知与持久化 |
| `ui/sidebarwebview/*` | `ChatUri`、`WebUrlUtil` | 聊天页 URI 与 URL 工具 |
| `ui/sidebar` | `CopilotDebugWindow` | 调试侧栏 |

### 2.7 类：补全、行内与诊断

| 包 | 类 | 功能 |
|---|---|---|
| `manager/code/completion`（6） | `CompletionItemsProviderV2`、`LanguageCompletionHandler`、`BaseCompletionHandler`、`JavaCompletionHandler`、`JavaScriptCompletionHandler`、`FallbackCompletionProvider` | 补全条目提供与语言特化处理、降级兜底 |
| `apibridge/extension/extension/languagefeatures/inlinecompletion` | `InlineCompletionProvider`、`IdentifiableInlineCompletions`、`InlineCompletionContext` | 行内补全（NES）提供与上下文 |
| `apibridge/extension/extension/languagefeatures` | `ExtHostLanguageFeatures`、`CodeLensInlayManager`、`InlineCompletionReconciler` | CodeLens 行内管理与补全协调 |
| `apibridge/Decoration`（+ bean 7 / processor） | `DecorationService`、`NesGutterIconRender`、`TextAttributesProcessor`、`DecorationOptions`、`MarkdownString`、`ThemeDecorationRenderOptions` 等 | 编辑器装饰（NES 槽位图标、主题化文本属性） |
| `apibridge/listener` | `DiagnosticsAsyncFileListener` | 诊断信息变更监听（`read_lints` 数据源） |
| `renderer` | `CodeReviewCommentGutterIconRenderer`、`InlineChatGutterIconRenderer` | 评审评论与行内聊天的槽位渲染器 |

### 2.8 类：node 进程、遥测与配置

| 包 | 类 | 功能 |
|---|---|---|
| `apibridge/nodeprocess` | `NodeRunner`、`NodeProjectService`、`NodeProjectStartUpActivity` | **启动/管理 fusion 子进程**（含 `ACC_PRODUCT_CONFIG` 注入、崩溃重启） |
| `apibridge/report`（+ model） | `FusionTelemetrySpanService`、`FusionTelemetryMeterService`、`FusionTelemetryMeterEvent`、`Event` | 遥测 span/metric 上报 |
| `telemetry` | `CustomTracer`、`ResilientSpanExporter` | OTLP tracer 与容错导出器 |
| `apibridge/configuration`（+ item 6） | `SettingService`、`ConfigurationStringItem`、`ConfigurationBoolItem`、`ConfigurationNumberItem`、`ConfigurationArrayItem`、`ConfigurationObjItem`、`ConfigurationBaseItem` | 设置项的类型化封装 |
| `apibridge/constant` | `InternalCommandConst`、`TextAttributesSetting` | 内部命令常量与文本属性设置 |
| `settings`（12） | 见功能文档 §2.1 | IDE 设置页各分组 |
| `impl`、`impl/auth` | `CopilotSettingsService`、`GFCopilotService`、`InlayService`、`CodeReviewCommentInLayService`、`AuthCallback`、`AccountChangeCallback` | 服务实现与登录/账号变更回调 |
| `api` | `ICopilotSettingsService`、`IGFCopilotService`、`IInlayService` | 服务接口 |
| `handle` | `CodeEscapeHandler`、`CodeUserInputHandler`、`CopilotErrorHandler`、`CustomProxySelector` | 代码转义、用户输入处理、错误处理、代理选择 |
| `filter` | `GitIgnoreFileFilter` | 遍历时遵守 `.gitignore` |
| `callback` | `ObjectCallback`、`ObjectRunnable` | 通用回调与可执行对象 |

### 2.9 类：模型与工具

| 包 | 类 | 功能 |
|---|---|---|
| `bean/item`（17） | `CodeReviewComment`、`CodeReviewDiffContext`、`CodeReviewFunction`、`CodeReviewRequestFile`、`CodeReviewRequestRange`、`CodeReviewResult`、`CodeReviewTask`、`CodeReviewTaskResultLevelEnum`、`InlayColorItem`、`PairedSymbolBean`、`Position`、`Range`、`RepairSymbol`、`ReviewCommitRequestExtras`、`SelectedCompletionInfo`、`TextSegment`、`VirtualFileUriBean` | 评审、补全、位置/区间、符号配对等数据结构 |
| `bean/request/Rpc/cr` | `BaseReviewCommitReportParams`、`CodeReviewTriggerResultRpcRequest` | 评审触发与上报参数 |
| `bean/product`、`bean/proxy`、`bean/request` | `Telemetry`、`ProxyConfiguration`、`BaseRequest` | 遥测、代理配置、请求基类 |
| `common`（11） | `ChatLanguage`、`CodeStyle`、`Edition`、`EditorCommandName`、`Indent`、`InlayAcceptMode`、`InlayDisplayMode`、`Language`、`PluginInfo`、`Resources`、`SdkIcons` | 语言/代码风格/缩进/补全接受与显示模式/图标等枚举与常量 |
| `util`（38） | `ApplicationUtils`、`BracketMatcher`、`ClassUtils`、`CollectionUtils`、`ColorUtils`、`CommandUtils`、`ComponentUtils`、`CompressUtils`、`CopilotEditorUtils`、`CopilotProjectUtils`、`DeviceUtils`、`DocumentUtils`、`FileUtils`、`FuzzyMatchResult`、`FuzzyMatcherUtil`、`HintUtils`、`IconsUtils`、`JsonRpcUtils`、`LanguageUtils`、`LineNumberUtils`、`NetworkUtils`、`PaintUtils`、`PluginDescriptorLite`、`PluginDescriptorProvider`、`PluginUtils`、`ProcessUtils`、`ProjectDiffUtils`、`PsiUtils`、`ReflectUtil`、`RegexUtils`、`ShortCutUtils`、`StringEncryptUtils`、`StringUtils`、`ThemeUtils`、`TimeUtils`、`URLUtils`、`UUIDUtils`、`VfsUtils` | 通用工具：括号匹配、模糊搜索、压缩、加密、反射、快捷键、主题、VFS、进程等 |
| `apibridge/util`（20） | `EditorUtils`、`FusionActionUtils`、`FusionEnvUtils`、`FusionProductUtils`、`FusionTextUtils`、`PsiConverter`、`UriComponentConverter`、`JcefModuleInstaller`、`UpdatePluginTask`、`FusionCaretListener`、`FusionDocumentListener`、`FusionSelectionListener`、`FusionFileChangeListener`、`FusionProjectListener`、`FusionEditorFactoryListener`、`FusionEditorListener`、`FusionVisibleAreaListener`、`FusionApplicationListener`、`FusionStatusBarFactory`、`TerminalSettingUtils` | 融合层工具与各类 IDE 事件监听器（光标/文档/选区/文件/项目/编辑器/可视区） |
| `apibridge/util/resolver`（6） | `SymbolResolver`、`JAVASymbolResolver`、`KOTLINSymbolResolver`、`GoSymbolResolver`、`PythonSymbolResolver`、`JSSymbolResolver` | 各语言符号解析（供 `lsp` / 定义跳转） |
| `apibridge/extension/extension/editortabs/data`（18） | `EditorTabDto`、`EditorTabGroupDto`、`TabInputDto`、`TextDiffInputDto`、`NotebookInputDto`、`WebviewInputDto`、`ChatEditorInputDto` 等 | 编辑器标签与输入类型的 DTO |
| `apibridge/extension/extension/documentsandeditors/data`（6） | `ModelAddedData`、`ModelChangedEvent`、`ModelContentChange`、`DocumentsAndEditorsDelta`、`EditReasons`、`TextEditorAddData` | 文档与编辑器变更事件数据 |
| `apibridge/extension/extension/comments/CommentParams`（4） | `CommentItem`、`CommentParams`、`Position`、`Range` | 评论数据结构 |
| `apibridge/extension/mainthread/explorer`、`scm`、`toolwindow` 的 `*MenuContext` | — | 各类菜单上下文（右键菜单入参） |

---

## 3. vsix 扩展逐文件（`vsix/extension/`，292 文件）

### 3.1 包根与元数据

| 文件 | 体积 | 功能 |
|---|---|---|
| `package.json` | 38.4 KB | 扩展清单：`main=out/extension/index.js`、activationEvents、contributes（视图/命令/菜单/快捷键/设置/图标） |
| `package.nls.json` | 13.5 KB | 英文文案基线（`%command.xxx%` 引用） |
| `package.nls.zh-cn.json` | 12.5 KB | 简体中文文案 |
| `package.nls.zh-tw.json` | 12.0 KB | 繁体中文文案 |
| `product.json` | 118.1 KB | **产品配置主文件**：72 个 `productFeatures`、15 个 agent、22 个 prompts、认证段（`external-link-v2` + `prefixPath=/plugin`）、2 个内置子代理、端点与模型表 |
| `product.internal.json` | 118.3 KB | 内部环境产品配置变体 |
| `product.external.json` | 230.0 KB | 外部环境（海外）产品配置变体 |
| `LICENSE.txt` | 1.0 KB | MIT 许可 |
| `readme.md` | 15.5 KB | 扩展说明 |
| `changelog.md` | 57.9 KB | 版本变更记录 |
| `cell.yml` | 0.3 KB | 构建/运行单元配置 |
| `.env` | — | 运行环境变量样例（含 `OPENAI_API_KEY` 占位） |
| `.env.example` | — | 环境变量示例 |
| `eslint.config.mjs` | 0.3 KB | 源码 lint 配置（随包，运行时不使用） |
| `server.js` | 2.0 MB | 独立打包的服务端 bundle：含遥测事件名全集（`chat_*`/`completion_*`/`commit_*`/`code_edit`/`mcp_*`/`plugin_*`/`rules_*`/`checkpoint_*`）、MCP 服务端与 genie 相关实现 |
| `server.js.map` | 9.0 MB | 上述 bundle 的 sourcemap（随包分发） |

### 3.2 `l10n/` —— 本地化

| 文件 | 功能 |
|---|---|
| `bundle.l10n.en.json`（23.9 KB）、`bundle.l10n.zh-cn.json`（22.1 KB）、`bundle.l10n.zh-tw.json`（22.1 KB） | 251 条运行时文案（登录/登出、更新、权限确认、会话导入导出、任务完成、许可证、技能校验等），由 shim 的 `l10n` 加载 |

### 3.3 `out/extension/` —— 业务主体

| 文件 | 体积 | 功能 |
|---|---|---|
| `index.js` | 20.9 MB | **扩展主 bundle**：activate/deactivate、DI 容器（CellJS）、144 条命令、AgentDispatcher / AgentContextBuilder / ToolProviderImpl / SubagentManager、工具实现（write_to_file / replace_in_file / search_* / execute_command / lsp / mcp …）、产品配置同步、认证与会话存储、遥测 |
| `530.index.js` | 26.5 KB | 分包：按需加载的能力模块 |
| `790.index.js` | 68.1 KB | 分包（较大功能模块） |
| `982.index.js` | 19.5 KB | 分包 |
| `598.index.js` | 4.6 KB | 分包 |
| `378.index.js` | 0.1 KB | 分包占位 |
| `zip-entry-guard.js` | 5.9 KB | 解压时的路径穿越（Zip Slip）防护 |
| `zip-extract.worker.js` | 2.6 KB | 解压 worker（配合上述守卫） |
| `tree-sitter.wasm` | 182 KB | Tree-sitter 运行时（代码结构解析底座） |
| `wasm/tree-sitter-{c,cpp,go,java,javascript,python,ruby,tsx,typescript}.wasm` | 175 KB–1.7 MB | 各语言语法解析器（供 `list_code_definition_names`、codebase 索引、LSP 兜底） |

#### 3.3.1 `builtin/` —— 内置技能（Skill）

| 技能 | 文件 | 功能 |
|---|---|---|
| buddy-multimodal-generation | `SKILL.md`、`scripts/buddy-cloud.py`（20 KB） | 多模态生成（图片/界面）技能，调云端生成服务 |
| lsp-code-analysis | `SKILL.md`（14 KB） | 基于 LSP 的代码分析技能 |
| skill-creator | `SKILL.md`、`scripts/init_skill.py`、`package_skill.py`、`quick_validate.py`、`LICENSE.txt` | 技能创建/打包/校验工具链 |

#### 3.3.2 `wecom-skills/` —— 企业微信技能（12 组）

`wecom-contact-lookup`、`wecom-doc-manager`（含 api-create-doc / api-edit-doc-content / api-export-document 参考）、`wecom-edit-todo`、`wecom-get-todo-detail`、`wecom-get-todo-list`、`wecom-meeting-create`（含 3 个示例）、`wecom-meeting-manage`、`wecom-meeting-query`、`wecom-msg`（含 3 个 API 参考）、`wecom-schedule`（含 5 个参考）、`wecom-smartsheet-data`（含字段格式）、`wecom-smartsheet-schema`（含字段类型）—— 每个由 `SKILL.md` + 可选 `references/*.md` 组成，供 `use_skill` 工具按需加载。

### 3.4 `out/vendor/` —— 原生模块与安全删除

| 文件 | 功能 |
|---|---|
| `genie-trash/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64.exe}` | 各平台"安全删除"原生程序：删除前移入回收站/暂存区（`safeDeleteEnabled` 设置对应） |
| `shim/node-language-shim.cjs`（0.6 KB） | Node 侧语言环境 shim |
| `shim/node-safe-delete-shim.cjs`（36.4 KB） | Node 层安全删除实现（拦截 rm/删除调用，转 genie-trash） |
| `shim/safe-delete-bulk-guard.cjs`（24.5 KB） | 批量删除守卫（超过 `safeDeleteBulkThreshold` 需确认） |
| `shim/powershell/CodeBuddy.SafeDelete.psm1`（50.5 KB）、`Initialize-CodeBuddySafeDelete.ps1` | PowerShell 侧安全删除模块与初始化脚本 |
| `shim/safe-bin/{rm,rmdir,unlink}`、`cb-del.cmd`、`cb-rd.cmd` | 覆盖 `rm/rmdir/unlink` 的 PATH 垫片 |
| `shim/safe-bin/safe-delete-{common,posix-init,bash-env}.sh`、`shell-runtime-bash-env.sh` | POSIX shell 环境的删除垫片与初始化 |
| `shim/sitecustomize.py`（66.9 KB） | Python 侧自动注入的安全删除钩子 |

### 3.5 `out/webviews/` —— 聊天页面（25 个 JS + 资源）

**JS 分包**

| 文件 | 体积 | 功能 |
|---|---|---|
| `runtime.0dadf820….js` | 6.7 KB | webpack 运行时 |
| `runtime-shims.a449a93f….js` | 15.7 KB | 浏览器/Node API 垫片 |
| `runtime-react.ceb6ff2f.chunk.js` | 374.9 KB | React 运行时 |
| `runtime-celljs.b1e7052c….js` | 501.4 KB | CellJS（DI 与消息总线）运行时 |
| `main.6480c59f.chunk.js` | 3.4 MB | 聊天页主业务：会话、消息流、模式切换、模型/智能体选择、任务与计划、工具调用展示、权限确认 |
| `components.0b8df0c9.chunk.js` | 448.6 KB | 通用 UI 组件库 |
| `ui-commons.3f9b05fa.chunk.js` | 597.4 KB | 公共界面模块（设置、MCP、规则、技能、记忆、集成连接器等面板） |
| `vendors-common.427d3853….js` | 3.3 MB | 第三方公共依赖 |
| `vendors-hljs.4d5051d8.chunk.js` | 1.05 MB | 代码高亮（highlight.js） |
| `vendors-katex.739e4fed.chunk.js` | 555.4 KB | LaTeX 公式渲染 |
| `vendors-mermaid.0d71a837.chunk.js` | 2.21 MB | 流程图/时序图渲染 |
| `vendors-aegis.ce65797d.chunk.js` | 109.6 KB | 前端监控（Aegis） |
| `vendors-otlp.c6facbd8.chunk.js` | 302.9 KB | 前端遥测（OTLP） |
| `index.9eae15d3….js` | 0.7 KB | 入口引导 |
| `index.html` | 3.5 KB | 页面骨架（含 CSP nonce 占位，由宿主注入桥接脚本） |
| `_b063-_abd8{0..3}.*.chunk.js`、`_e53f-…_abd8{0..6}.*.chunk.js`（11 个） | 0.2–0.6 KB | 按块拆分的界面片段（国际化/图标等小模块） |

**样式**：`css/main.e39a85bd.css`（1.1 MB 主样式）、`css/ui-commons.d1b4a122.css`（680 KB）、`css/vendors-common.63607b0b.css`、`css/vendors-katex.17d1624e.css`；`assets/styles/*.less`（13 个：global / reset / icon / index / seti / theme / theme-dark / theme-light / highlight-dark / highlight-light / utils-animation / utils-flex / utils-layout）。

**资源**：字体（20 个 .ttf、19 个 .woff、13 个 .woff2、seti.woff）、图片（`assets/image/`：copilot.png、copilot-avatar-light/dark、frantic-cat、hanging-out-cat、notify-cat、notify-activity、staring-cat、warning-cat、working-cat——吉祥物状态图）、SVG（`assets/svg/`：`@`/arrow/ask/craft 的明暗两版、codebuddy.svg）、`favicon.ico`。

### 3.6 `node_modules/` —— 随包依赖（7 个）

| 包 | 文件 | 功能 |
|---|---|---|
| `@parcel/watcher`（+ 5 个平台 `watcher.node`） | `index.js`、`wrapper.js`、`index.d.ts`、各平台原生绑定 | 高性能文件监听（规则/技能/记忆文件的变更监控） |
| `@tencent/qimei-node-unified` | `index.js`、4 个平台原生绑定（darwin/linux/win32 .node、.dll） | 腾讯 QIMEI 统一设备标识与埋点原生模块 |
| `detect-libc` | `lib/detect-libc.js`、`filesystem.js`、`process.js` | 检测 libc 类型（musl/glibc），用于选择原生绑定 |
| `picomatch` | `index.js`、`posix.js`、`lib/{constants,parse,picomatch,scan,utils}.js` | glob 匹配引擎（`search_file` / 忽略规则） |
| `is-glob`、`is-extglob` | `index.js` | 判断字符串是否为 glob/extglob |
| `vscode` | （占位模块） | 让 `require("vscode")` 在打包解析期可解析；运行时由 fusion/宿主注入真实实现 |

### 3.7 `resources/` —— IDE 侧图标

`copilot.png`、`copilot-mini.png`、`copilot.svg`（活动栏/工具窗图标）、`rules.svg`、`user.svg`（规则与账号图标）、`icomoon.woff`、`icon.woff`（图标字体）。

### 3.8 `integration-mcp/` —— 集成 MCP 服务器（本仓库未随 vsix 复制）

| 目录 | 文件 | 功能 |
|---|---|---|
| `anydev` | `index.js`（1.6 MB）、`chunks/index-CThK7FKz.js`（1.1 MB）等 8 个 chunk、`assets/interactive-env.html`、`interactive-env.js` | AnyDev 集成 MCP 服务（交互式环境页 + arktype/zod/valibot/effect 等校验与运行时） |
| `eop` | `index.js`（2.0 MB） | EOP 集成 MCP 服务 |
| `lighthouse` | `index.cjs`（2.4 MB） | Lighthouse/质量分析类 MCP 服务 |
| `tcb` | `index.cjs`（5.3 MB） | 腾讯云 TCB（云开发）集成 MCP 服务 |

> 说明：本仓库 `Plugins/win/Official/CodeBuddy/vsix/extension/` 未包含 `integration-mcp/`（体积 12.2 MB，属按需加载的集成工具），因此"连接器/部署类集成"在当前内置副本中不可用。

---

## 4. 与 Lithe 内置副本的差异

| 项 | 原插件 vsix | Lithe 内置副本 | 影响 |
|---|---|---|---|
| `product.json` | 有 | 有（本轮补入） | 认证段、`prefixPath=/plugin`、子代理定义依赖它 |
| `integration-mcp/`（12.2 MB） | 有 | **未复制** | 连接器/部署类集成（AnyDev/EOP/Lighthouse/TCB）不可用 |
| `.env`、`.env.example`、`cell.yml`、`eslint.config.mjs`、`server.js(.map)`、`tsconfig.tsbuildinfo` | 有 | 未复制 | 均为构建/运行辅助，不影响功能 |
| `product.external.json`、`product.internal.json` | 有 | 未复制 | 环境变体配置，默认用 `product.json` |
| `out/extension/index.js` | 有 | 有（byte-for-byte） | 业务主体一致 |

---

## 5. 文件类型统计（vsix 部分）

| 类型 | 数量 | 体积 | 用途 |
|---|---|---|---|
| `.js` | 61 | 40.8 MB | 主 bundle、分包、Web 页面、MCP 服务 |
| `.map` | 1 | 9.0 MB | server.js sourcemap |
| `.cjs` | 5 | 7.8 MB | Node 垫片与 MCP 服务 |
| `.wasm` | 10 | 6.1 MB | Tree-sitter 运行时与各语言语法 |
| `.node` | 8 | 5.7 MB | 原生模块（watcher、qimei） |
| `.exe` | 1 | 2.6 MB | Windows 安全删除程序 |
| `.css` | 4 | 1.9 MB | 聊天页样式 |
| `.dll` | 1 | 1.2 MB | Windows qimei 绑定 |
| 平台二进制（genie-trash） | 5 | 5.5 MB | 安全删除 |
| `.json` | 21 | 622 KB | 清单、文案、产品配置 |
| 字体（ttf/woff/woff2） | 52 | 1.2 MB | 页面字体 |
| `.png` | 13 | 338 KB | 吉祥物与图标位图 |
| `.md` | 44 | 268 KB | 技能定义与参考文档 |
| `.py` | 5 | 103 KB | 技能脚本与安全删除钩子 |
| `.less` | 13 | 69 KB | 样式源码 |
| `.psm1` / `.sh` / `.cmd` / `.svg` / `.html` / `.txt` / `.ico` / `.yml` / `.ts` / `.mjs` / `.xml` / 其它 | 若干 | < 200 KB | PowerShell 模块、Shell 垫片、图标、页面骨架、许可与配置 |
