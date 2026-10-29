export const codebuddyEnglish = {
  "codebuddy.chatTitle": "CodeBuddy",
  "codebuddy.chatEmpty":
    "The CodeBuddy chat opens here once the extension creates its webview. If nothing appears, the extension is still starting.",
  "codebuddy.hostStarting": "Starting the CodeBuddy extension host…",
  "codebuddy.hostReady": "CodeBuddy ready · {count} commands",
  "codebuddy.hostFailed": "The CodeBuddy extension host failed to start.",
  "codebuddy.hostExited": "The CodeBuddy extension host exited.",
  "codebuddy.retry": "Retry",
  "codebuddy.hostStartingHint":
    "The vendored CodeBuddy VS Code extension runs in a local Node sidecar. Node must be on PATH or configured in the extension settings.",
  "codebuddy.CODEBUDDY_NODE_NOT_FOUND":
    "Node.js was not found. Install Node.js and add it to PATH, then reopen this window.",
  "codebuddy.CODEBUDDY_EXTENSION_MISSING":
    "The vendored CodeBuddy extension is missing from the installation.",
  "codebuddy.CODEBUDDY_HOST_ENTRY_MISSING":
    "The CodeBuddy bridge entry is missing. Rebuild the application so the host is compiled.",
  "codebuddy.CODEBUDDY_HOST_START_TIMEOUT":
    "The CodeBuddy extension host did not become ready in time. Check the log below and retry.",
  "codebuddy.CODEBUDDY_HOST_SPAWN_FAILED": "Could not start the CodeBuddy extension host.",
  "codebuddy.CODEBUDDY_HOST_EXITED": "The CodeBuddy extension host exited unexpectedly.",
  "codebuddy.signInTitle": "Sign in to CodeBuddy",
  "codebuddy.signInDescription":
    "Sign in to use AI chat and completion. A browser window will open to finish the sign-in; the panel updates automatically afterwards.",
  "codebuddy.signInAction": "Sign in with your browser",
  "codebuddy.signInLater": "Later",
  "codebuddy.actionNewChat": "New chat",
  "codebuddy.actionSettings": "Settings",
  "codebuddy.actionLogout": "Sign out",
};

export const codebuddyChinese: Record<keyof typeof codebuddyEnglish, string> = {
  "codebuddy.chatTitle": "CodeBuddy",
  "codebuddy.chatEmpty": "扩展创建聊天 WebView 后将在此显示。若暂无内容，说明扩展仍在启动中。",
  "codebuddy.hostStarting": "正在启动 CodeBuddy 扩展宿主…",
  "codebuddy.hostReady": "CodeBuddy 已就绪 · {count} 个命令",
  "codebuddy.hostFailed": "CodeBuddy 扩展宿主启动失败。",
  "codebuddy.hostExited": "CodeBuddy 扩展宿主已退出。",
  "codebuddy.retry": "重试",
  "codebuddy.hostStartingHint":
    "内置的 CodeBuddy VS Code 扩展运行在本地 Node sidecar 中。需要 Node 在 PATH 中，或在扩展设置里指定路径。",
  "codebuddy.CODEBUDDY_NODE_NOT_FOUND":
    "未找到 Node.js。请安装 Node 并加入 PATH，然后重新打开本窗口。",
  "codebuddy.CODEBUDDY_EXTENSION_MISSING": "安装包中缺少内置的 CodeBuddy 扩展。",
  "codebuddy.CODEBUDDY_HOST_ENTRY_MISSING": "缺少 CodeBuddy 桥接入口。请重新构建应用以编译宿主。",
  "codebuddy.CODEBUDDY_HOST_START_TIMEOUT":
    "CodeBuddy 扩展宿主未能在时限内就绪。请查看下方日志后重试。",
  "codebuddy.CODEBUDDY_HOST_SPAWN_FAILED": "无法启动 CodeBuddy 扩展宿主。",
  "codebuddy.CODEBUDDY_HOST_EXITED": "CodeBuddy 扩展宿主意外退出。",
  "codebuddy.signInTitle": "登录 CodeBuddy",
  "codebuddy.signInDescription":
    "登录后即可使用 AI 聊天与代码补全。点击下方按钮将打开浏览器完成登录，登录后面板会自动更新。",
  "codebuddy.signInAction": "通过浏览器登录",
  "codebuddy.signInLater": "稍后再说",
  "codebuddy.actionNewChat": "新建会话",
  "codebuddy.actionSettings": "设置",
  "codebuddy.actionLogout": "退出登录",
};
