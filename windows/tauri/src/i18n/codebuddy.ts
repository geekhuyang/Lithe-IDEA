export const codebuddyEnglish = {
  "codebuddy.chatTitle": "CodeBuddy",
  "codebuddy.chatEmpty":
    "Ask anything about this project. Each message runs the local CodeBuddy CLI once.",
  "codebuddy.chatPlaceholder": "Ask CodeBuddy… (Enter to send, Shift+Enter for a new line)",
  "codebuddy.send": "Send",
  "codebuddy.running": "CodeBuddy is running…",
  "codebuddy.you": "You",
  "codebuddy.assistant": "CodeBuddy",
  "codebuddy.failed": "CodeBuddy failed",
  "codebuddy.settings": "Settings",
  "codebuddy.save": "Save",
  "codebuddy.cliChecking": "Looking for the CodeBuddy CLI…",
  "codebuddy.cliReady": "CodeBuddy CLI ready",
  "codebuddy.cliMissing": "CodeBuddy CLI not found",
  "codebuddy.cliMissingHint":
    "Install the CodeBuddy CLI (npm install -g @tencent-ai/codebuddy-code) and make sure `codebuddy` is on PATH, or set its path in Settings, then reopen this window.",
  "codebuddy.cliPath": "CodeBuddy CLI path",
  "codebuddy.cliPathPlaceholder": "Leave empty to look for `codebuddy` on PATH",
  "codebuddy.generateCommit": "CodeBuddy",
  "codebuddy.openChat": "CodeBuddy: Open Chat",
  "codebuddy.CODEBUDDY_CLI_MISSING":
    "The CodeBuddy CLI was not found. Install it and add it to PATH, or set its path in the CodeBuddy window settings.",
  "codebuddy.CODEBUDDY_CLI_TIMEOUT":
    "The CodeBuddy CLI did not finish within two minutes. Try again with a smaller request.",
  "codebuddy.CODEBUDDY_CLI_EMPTY": "The CodeBuddy CLI returned no message.",
  "codebuddy.CODEBUDDY_CLI_FAILED": "The CodeBuddy CLI reported a failure.",
};

export const codebuddyChinese: Record<keyof typeof codebuddyEnglish, string> = {
  "codebuddy.chatTitle": "CodeBuddy",
  "codebuddy.chatEmpty": "向 CodeBuddy 提问本项目相关问题。每条消息会在本机运行一次 CodeBuddy CLI。",
  "codebuddy.chatPlaceholder": "向 CodeBuddy 提问…（Enter 发送，Shift+Enter 换行）",
  "codebuddy.send": "发送",
  "codebuddy.running": "CodeBuddy 运行中…",
  "codebuddy.you": "你",
  "codebuddy.assistant": "CodeBuddy",
  "codebuddy.failed": "CodeBuddy 失败",
  "codebuddy.settings": "设置",
  "codebuddy.save": "保存",
  "codebuddy.cliChecking": "正在查找 CodeBuddy CLI…",
  "codebuddy.cliReady": "CodeBuddy CLI 已就绪",
  "codebuddy.cliMissing": "未找到 CodeBuddy CLI",
  "codebuddy.cliMissingHint":
    "请安装 CodeBuddy CLI（npm install -g @tencent-ai/codebuddy-code）并确保 `codebuddy` 在 PATH 中，或在设置中指定其路径，然后重新打开本窗口。",
  "codebuddy.cliPath": "CodeBuddy CLI 路径",
  "codebuddy.cliPathPlaceholder": "留空则在 PATH 中查找 `codebuddy`",
  "codebuddy.generateCommit": "CodeBuddy",
  "codebuddy.openChat": "CodeBuddy: 打开对话",
  "codebuddy.CODEBUDDY_CLI_MISSING":
    "未找到 CodeBuddy CLI。请安装并加入 PATH，或在 CodeBuddy 窗口设置中指定路径。",
  "codebuddy.CODEBUDDY_CLI_TIMEOUT": "CodeBuddy CLI 超过两分钟未返回，请缩小请求后重试。",
  "codebuddy.CODEBUDDY_CLI_EMPTY": "CodeBuddy CLI 没有返回内容。",
  "codebuddy.CODEBUDDY_CLI_FAILED": "CodeBuddy CLI 报告失败。",
};
