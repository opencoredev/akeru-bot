export type LanguagePreference = "system" | string;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type TranslationCatalog = Readonly<Record<string, string>>;
export type PluralForms = Readonly<
  Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }
>;

export const availableLanguages = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
] as const;

export const englishCatalog = {
  "API key": "API key",
  Actions: "Actions",
  "Add Environment": "Add Environment",
  "Add attachment": "Add attachment",
  "Add environment": "Add environment",
  "Add new project": "Add new project",
  "Add project": "Add project",
  "Add project starts in": "Add project starts in",
  "Akeru Bot runs locally. Provider prompts and enabled online features still send data to their listed services.":
    "Akeru Bot runs locally. Provider prompts and enabled online features still send data to their listed services.",
  "All environments": "All environments",
  "All projects": "All projects",
  "All providers": "All providers",
  "Allow camera": "Allow camera",
  "Allow camera access to scan an environment pairing QR code.":
    "Allow camera access to scan an environment pairing QR code.",
  "Allow once": "Allow once",
  "Allow session": "Allow session",
  Analytics: "Analytics",
  "Anonymous analytics": "Anonymous analytics",
  App: "App",
  "Approval needed": "Approval needed",
  Archive: "Archive",
  "Archived chats": "Archived chats",
  "Ask anything…": "Ask anything…",
  "Authorization code": "Authorization code",
  "Auto-show floating preview": "Auto-show floating preview",
  "Base URL (optional)": "Base URL (optional)",
  "Bot browser access": "Bot browser access",
  "Bot channels": "Bot channels",
  "Bot stopped responding": "Bot stopped responding",
  "Bot work or routine": "Bot work or routine",
  Browser: "Browser",
  "Browser connection failed": "Browser connection failed",
  Build: "Build",
  "Camera access needed": "Camera access needed",
  "Camera access was denied for this app. Open Settings to enable it.":
    "Camera access was denied for this app. Open Settings to enable it.",
  "Camera permission is required to scan a QR code.":
    "Camera permission is required to scan a QR code.",
  "Cancel chat settings": "Cancel chat settings",
  Catalog: "Catalog",
  Channels: "Channels",
  "Chat list options": "Chat list options",
  "Chat settings": "Chat settings",
  "Chat unavailable": "Chat unavailable",
  Chats: "Chats",
  "Check OAuth": "Check OAuth",
  "Check key": "Check key",
  "Checking…": "Checking…",
  "Clear caches": "Clear caches",
  "Clear search": "Clear search",
  "Clearing caches never removes environment connections, credentials, account data, or appearance preferences.":
    "Clearing caches never removes environment connections, credentials, account data, or appearance preferences.",
  "Client Storage": "Client Storage",
  "Client storage is temporarily unavailable. Try again after restarting the app.":
    "Client storage is temporarily unavailable. Try again after restarting the app.",
  "Close scanner": "Close scanner",
  "Close settings": "Close settings",
  "Code & Diffs": "Code & Diffs",
  "Code font": "Code font",
  "Collapse user input": "Collapse user input",
  "Color scheme": "Color scheme",
  Configuration: "Configuration",
  Connect: "Connect",
  Connections: "Connections",
  Contrast: "Contrast",
  Copied: "Copied",
  "Copies the trace ID": "Copies the trace ID",
  "Copy code": "Copy code",
  "Could not save preferences. Try again.": "Could not save preferences. Try again.",
  "Custom font size": "Custom font size",
  Dark: "Dark",
  "Data portability": "Data portability",
  Decline: "Decline",
  Default: "Default",
  "Default browser appearance": "Default browser appearance",
  "Default browser viewport": "Default browser viewport",
  "Default browser zoom": "Default browser zoom",
  "Default grouping": "Default grouping",
  "Default sandbox": "Default sandbox",
  "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.":
    "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.",
  Diagnostics: "Diagnostics",
  Disconnect: "Disconnect",
  Done: "Done",
  "Double tap to show full details. Long press to copy.":
    "Double tap to show full details. Long press to copy.",
  "Downloading…": "Downloading…",
  "Enter a pairing token to start a session with this environment.":
    "Enter a pairing token to start a session with this environment.",
  Environment: "Environment",
  "Environment caches": "Environment caches",
  "Environment identification": "Environment identification",
  Environments: "Environments",
  Errors: "Errors",
  "Fallback model": "Fallback model",
  "Fill in the pending answers": "Fill in the pending answers",
  "Filter and sort chats": "Filter and sort chats",
  "Filter models": "Filter models",
  "Find a branch": "Find a branch",
  "Find a model": "Find a model",
  "Font size": "Font size",
  "Font smoothing": "Font smoothing",
  "Glass opacity": "Glass opacity",
  "Grok uses its default endpoint.": "Grok uses its default endpoint.",
  "Group by repository": "Group by repository",
  "Group by repository path": "Group by repository path",
  Health: "Health",
  "Hide whitespace changes": "Hide whitespace changes",
  "I reviewed these drafts": "I reviewed these drafts",
  "Image unavailable": "Image unavailable",
  "Inspecting cached data…": "Inspecting cached data…",
  "Interface font": "Interface font",
  "Invalid QR code": "Invalid QR code",
  "Keep monorepo paths separate.": "Keep monorepo paths separate.",
  "Keep separate": "Keep separate",
  Keybindings: "Keybindings",
  Label: "Label",
  "Last failure": "Last failure",
  Legacy: "Legacy",
  "Legacy Chat List": "Legacy Chat List",
  "Legacy models": "Legacy models",
  Legal: "Legal",
  Light: "Light",
  "Load earlier turns": "Load earlier turns",
  "Load older routine notes": "Load older routine notes",
  "Loading bot inbox…": "Loading bot inbox…",
  "Loading branches…": "Loading branches…",
  "Loading chats…": "Loading chats…",
  "Loading connections…": "Loading connections…",
  "Loading earlier turns…": "Loading earlier turns…",
  "Loading older routine notes…": "Loading older routine notes…",
  "Loading image…": "Loading image…",
  Local: "Local",
  "Local execution": "Local execution",
  "Long press to copy.": "Long press to copy.",
  "Matching repositories appear as one project.": "Matching repositories appear as one project.",
  "Maximize content": "Maximize content",
  "Model and reasoning settings": "Model and reasoning settings",
  "Model filters": "Model filters",
  More: "More",
  "My MacBook": "My MacBook",
  "New worktree": "New worktree",
  Next: "Next",
  "Next action": "Next action",
  "Next question": "Next question",
  "No branches available": "No branches available",
  "No cached data": "No cached data",
  "No chats yet": "No chats yet",
  "No limit": "No limit",
  "No matching branches": "No matching branches",
  "No matching models": "No matching models",
  "No open items.": "No open items.",
  "No project scripts": "No project scripts",
  "No results": "No results",
  "Offline cache records will appear here after environments are used.":
    "Offline cache records will appear here after environments are used.",
  "Open Akeru Bot on web or desktop to review this feedback draft.":
    "Open Akeru Bot on web or desktop to review this feedback draft.",
  "Open Settings": "Open Settings",
  "Open Settings from an environment to connect a provider.":
    "Open Settings from an environment to connect a provider.",
  "Open files": "Open files",
  "Open new terminal": "Open new terminal",
  "Open sign-in": "Open sign-in",
  "Open terminal": "Open terminal",
  "Opening chat…": "Opening chat…",
  "Opens environment settings": "Opens environment settings",
  "Opens the chat": "Opens the chat",
  "Opens the project picker": "Opens the project picker",
  "Opens the queued chat for editing": "Opens the queued chat for editing",
  "Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan control; otherwise every task runs in Build mode.":
    "Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan control; otherwise every task runs in Build mode.",
  Options: "Options",
  "Or type a custom answer": "Or type a custom answer",
  "Pairing code": "Pairing code",
  "Paste the authorization code": "Paste the authorization code",
  Pending: "Pending",
  "Pick the default workspace mode for new chats on this environment.":
    "Pick the default workspace mode for new chats on this environment.",
  Plan: "Plan",
  "Plan Mode": "Plan Mode",
  "Plan mode (legacy)": "Plan mode (legacy)",
  Plugins: "Plugins",
  Privacy: "Privacy",
  "Privacy Policy": "Privacy Policy",
  "Product feedback": "Product feedback",
  Project: "Project",
  "Project Grouping": "Project Grouping",
  "Prompt font": "Prompt font",
  Provider: "Provider",
  "Provider connection failed": "Provider connection failed",
  "Provider connections": "Provider connections",
  "Provider default": "Provider default",
  "Provider sign-in expired": "Provider sign-in expired",
  "Provider update checks": "Provider update checks",
  Providers: "Providers",
  "Queue chat": "Queue chat",
  Queued: "Queued",
  Reconnect: "Reconnect",
  "Reconnect key": "Reconnect key",
  "Remote environments": "Remote environments",
  Resolve: "Resolve",
  "Resolving…": "Resolving…",
  "Restart the app and try again.": "Restart the app and try again.",
  "Restarting…": "Restarting…",
  "Retry now": "Retry now",
  "Retry older routine notes": "Retry older routine notes",
  "Return to chat": "Return to chat",
  "Review Akeru Bot policies": "Review Akeru Bot policies",
  "Review changes": "Review changes",
  Runtime: "Runtime",
  Sandbox: "Sandbox",
  "Sandbox and browser sharing": "Sandbox and browser sharing",
  "Sandbox auto-idle": "Sandbox auto-idle",
  "Save chat settings": "Save chat settings",
  "Saving…": "Saving…",
  "Scan QR Code": "Scan QR Code",
  "Scanned QR code was not recognized.": "Scanned QR code was not recognized.",
  "Scroll to end": "Scroll to end",
  "Sets both light and dark appearances": "Sets both light and dark appearances",
  Settled: "Settled",
  "Show chat sidebar": "Show chat sidebar",
  "Show every workspace as its own project.": "Show every workspace as its own project.",
  "Show legacy models": "Show legacy models",
  "Show skills in slash menu": "Show skills in slash menu",
  "Sidebar (legacy)": "Sidebar (legacy)",
  Snoozed: "Snoozed",
  "Sort chats": "Sort chats",
  "Sort projects": "Sort projects",
  "Source control": "Source control",
  "Start chat": "Start chat",
  "Start from origin": "Start from origin",
  "Starting chat": "Starting chat",
  "Status unavailable": "Status unavailable",
  Stop: "Stop",
  "Storage unavailable": "Storage unavailable",
  "Stream token by token (legacy)": "Stream token by token (legacy)",
  Submit: "Submit",
  "Submit answer": "Submit answer",
  "Submit answers": "Submit answers",
  "Swipe left for archive and delete actions": "Swipe left for archive and delete actions",
  System: "System",
  Terminal: "Terminal",
  "Terminal font": "Terminal font",
  "Terms of Use": "Terms of Use",
  Text: "Text",
  "Text size": "Text size",
  "The environment sends this key to the selected endpoint.":
    "The environment sends this key to the selected endpoint.",
  Themes: "Themes",
  "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.":
    "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.",
  "This environment expects a trusted pairing credential before the app can connect.":
    "This environment expects a trusted pairing credential before the app can connect.",
  "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.":
    "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.",
  "Time format": "Time format",
  "Toggle inspector": "Toggle inspector",
  "Token hard stop": "Token hard stop",
  URL: "URL",
  "Unavailable for this provider": "Unavailable for this provider",
  "Up to date": "Up to date",
  "Update ready": "Update ready",
  Usage: "Usage",
  "Usage refresh": "Usage refresh",
  "Use OAuth": "Use OAuth",
  "User input needed": "User input needed",
  Version: "Version",
  "Version {version}": "Version {version}",
  Voice: "Voice",
  "Voice calls": "Voice calls",
  "Voice provider": "Voice provider",
  "Voice selection": "Voice selection",
  "Waiting for approval…": "Waiting for approval…",
  "What should we build": "What should we build",
  "Word break": "Word break",
  "Word wrap": "Word wrap",
  "Change project from {project}": "Change project from {project}",
  "Environment: {environment}": "Environment: {environment}",
  "in {project}?": "in {project}?",
  "on {environment}": "on {environment}",
  "work log": "work log",
  "{mode} appearance": "{mode} appearance",
  "{theme} dark theme": "{theme} dark theme",
  "{theme} light theme": "{theme} light theme",
  "{theme} theme": "{theme} theme",
  About: "About",
  Back: "Back",
  "Backend paired": "Backend paired",
  "Change language": "Change language",
  Connecting: "Connecting",
  Continue: "Continue",
  "Environment disconnected": "Environment disconnected",
  Host: "Host",
  Implement: "Implement",
  "Implement in a new chat": "Implement in a new chat",
  "Implementation actions": "Implementation actions",
  Navigate: "Navigate",
  "No settings found": "No settings found",
  "Open app": "Open app",
  "Open settings": "Open settings",
  "Pair with this environment": "Pair with this environment",
  "Pairing backend": "Pairing backend",
  "Pairing failed": "Pairing failed",
  "Pairing token": "Pairing token",
  "Pairing with this environment": "Pairing with this environment",
  "Pairing…": "Pairing…",
  "Paste a one-time token or pairing secret": "Paste a one-time token or pairing secret",
  "Preparing worktree": "Preparing worktree",
  Previous: "Previous",
  "Previous question": "Previous question",
  Refine: "Refine",
  "Reload app": "Reload app",
  "Reset to default": "Reset to default",
  "Reset {label} to default": "Reset {label} to default",
  "Saved on this device only. System default follows this device when English or Simplified Chinese is available.":
    "Saved on this device only. System default follows this device when English or Simplified Chinese is available.",
  "Search settings": "Search settings",
  "Send message": "Send message",
  "Sending…": "Sending…",
  "Settings sections": "Settings sections",
  "Stop generation": "Stop generation",
  "Try again": "Try again",
  "Use the language of this device": "Use the language of this device",
  "Use {language}": "Use {language}",
  "Validating the pairing link and preparing your session.":
    "Validating the pairing link and preparing your session.",
  "Verify the backend is reachable from this browser, supports CORS for hosted clients, and is served over HTTPS when opening this page from HTTPS.":
    "Verify the backend is reachable from this browser, supports CORS for hosted clients, and is served over HTTPS when opening this page from HTTPS.",
  Settings: "Settings",
  General: "General",
  Appearance: "Appearance",
  Language: "Language",
  English: "English",
  "System default": "System default",
  "Language applies only to this device.": "Language applies only to this device.",
  "English and Simplified Chinese are available.": "English and Simplified Chinese are available.",
  "User messages and bot responses are not translated.":
    "User messages and bot responses are not translated.",
  "The selected language could not load, so English is shown.":
    "The selected language could not load, so English is shown.",
  Save: "Save",
  Cancel: "Cancel",
  Close: "Close",
  Search: "Search",
  "New chat": "New chat",
  "{count} chat": "{count} chat",
  "{count} chats": "{count} chats",
  "Opens filters, archived chats, and settings": "Opens filters, archived chats, and settings",
  "Menu, filters active": "Menu, filters active",
  "Menu, no filters": "Menu, no filters",
  "Close search": "Close search",
  "Search chats": "Search chats",
  'No chats matching "{query}".': 'No chats matching "{query}".',
  "Pick a bot to start a chat.": "Pick a bot to start a chat.",
  "Bot failures appear here.": "Bot failures appear here.",
  "Bot inbox": "Bot inbox",
  "Image generation": "Image generation",
  "Controls this environment's web and desktop calls. Native mobile audio calls are not supported. Configure voice services in web or desktop Settings.":
    "Controls this environment's web and desktop calls. Native mobile audio calls are not supported. Configure voice services in web or desktop Settings.",
  "Cancel chat": "Cancel chat",
  "Close chat": "Close chat",
  "Message, or run a command…": "Message, or run a command…",
  "No messages yet": "No messages yet",
  "Ask for a look at the project, or run a command to get started.":
    "Ask for a look at the project, or run a command to get started.",
  "Searching chats…": "Searching chats…",
  "No matching chats": "No matching chats",
  "Go to bots list": "Go to bots list",
  "Image generation settings": "Image generation settings",
  "ChatGPT images": "ChatGPT images",
  "Grok images": "Grok images",
  "Default image provider": "Default image provider",
  "Image fallback order": "Image fallback order",
  "Read new replies aloud": "Read new replies aloud",
  "Quit shortcut": "Quit shortcut",
  Bots: "Bots",
  Workspace: "Workspace",
  "Privacy and data": "Privacy and data",
  Advanced: "Advanced",
  "Bot usage": "Bot usage",
  "Connecting…": "Connecting…",
  "Reconnecting…": "Reconnecting…",
  "Could not connect. Reconnecting…": "Could not connect. Reconnecting…",
  "Connection failed": "Connection failed",
  "Connection failed.": "Connection failed.",
  Connected: "Connected",
  Available: "Available",
  Offline: "Offline",
  "The environment could not be reached. Check the network connection.":
    "The environment could not be reached. Check the network connection.",
  "The environment took too long to respond.": "The environment took too long to respond.",
  "The connection to the environment was interrupted.":
    "The connection to the environment was interrupted.",
  "The environment address is not responding.": "The environment address is not responding.",
  "The environment is not ready to accept connections.":
    "The environment is not ready to accept connections.",
  "This device is no longer paired with the environment. Pair it again.":
    "This device is no longer paired with the environment. Pair it again.",
  "This connection is not set up correctly. Check its address and settings.":
    "This connection is not set up correctly. Check its address and settings.",
  "This device does not have access to the environment.":
    "This device does not have access to the environment.",
  "This environment runs a version the app does not support.":
    "This environment runs a version the app does not support.",
  "You are offline": "You are offline",
  "Connecting to {environment}…": "Connecting to {environment}…",
  "Reconnecting to {environment}…": "Reconnecting to {environment}…",
  "{environment} is unavailable": "{environment} is unavailable",
  "{environment} is disconnected": "{environment} is disconnected",
  "The app will keep retrying automatically.": "The app will keep retrying automatically.",
  "Cached data remains available. The review will load when your connection returns.":
    "Cached data remains available. The review will load when your connection returns.",
  "Cached data remains available. The terminal will load when your connection returns.":
    "Cached data remains available. The terminal will load when your connection returns.",
  "The review will load as soon as the environment is ready.":
    "The review will load as soon as the environment is ready.",
  "The terminal will load as soon as the environment is ready.":
    "The terminal will load as soon as the environment is ready.",
  "Reconnect the environment to load the review.": "Reconnect the environment to load the review.",
  "Reconnect the environment to load the terminal.":
    "Reconnect the environment to load the terminal.",
  "Trace ID:": "Trace ID:",
  "Loading settings": "Loading settings",
  Confirm: "Confirm",
  "Confirm action": "Confirm action",
  "This action requires your confirmation.": "This action requires your confirmation.",
  "Copy trace ID": "Copy trace ID",
  "Expand user input, {count} question": "Expand user input, {count} question",
  "Expand user input, {count} questions": "Expand user input, {count} questions",
  "{count} question": "{count} question",
  "{count} questions": "{count} questions",
  "{count} queued message will send automatically.":
    "{count} queued message will send automatically.",
  "{count} queued messages will send automatically.":
    "{count} queued messages will send automatically.",
  "Sort by archived date": "Sort by archived date",
  "Newest first": "Newest first",
  "Oldest first": "Oldest first",
  "Navigate up": "Navigate up",
  "Search archived chats": "Search archived chats",
  "Filter and sort archived chats": "Filter and sort archived chats",
  "Archived chat options": "Archived chat options",
  "Refresh archived chats": "Refresh archived chats",
  "Unarchive {title}": "Unarchive {title}",
  Unarchive: "Unarchive",
  "Could not load every archive": "Could not load every archive",
  "Loading archive…": "Loading archive…",
  "Try another search or environment.": "Try another search or environment.",
  "Chats you archive will appear here.": "Chats you archive will appear here.",
  "No archived chats": "No archived chats",
  "Could not update environment": "Could not update environment",
  "The environment could not be updated.": "The environment could not be updated.",
  "Delete {title}": "Delete {title}",
  Delete: "Delete",
  "Deleting…": "Deleting…",
  "Delete pending chat?": "Delete pending chat?",
  "“{title}” has not been sent yet and will be removed from the outbox.":
    "“{title}” has not been sent yet and will be removed from the outbox.",
  "Could not delete pending chat": "Could not delete pending chat",
  "The pending chat could not be removed.": "The pending chat could not be removed.",
  "The chat could not be archived.": "The chat could not be archived.",
  "The chat could not be unarchived.": "The chat could not be unarchived.",
  "The chat could not be settled.": "The chat could not be settled.",
  "The chat could not be un-settled.": "The chat could not be un-settled.",
  "The chat could not be deleted.": "The chat could not be deleted.",
  "Could not archive chat": "Could not archive chat",
  "Could not unarchive chat": "Could not unarchive chat",
  "Could not settle chat": "Could not settle chat",
  "Could not un-settle chat": "Could not un-settle chat",
  "Could not delete chat": "Could not delete chat",
  "This environment's server does not support settling yet. Update the server to use Settle.":
    "This environment's server does not support settling yet. Update the server to use Settle.",
  "This chat still needs attention. Resolve or interrupt it first, then try again.":
    "This chat still needs attention. Resolve or interrupt it first, then try again.",
  "This chat is working. Interrupt it first, then try again.":
    "This chat is working. Interrupt it first, then try again.",
  "Delete chat?": "Delete chat?",
  "“{title}” will be permanently deleted, including its terminal history.":
    "“{title}” will be permanently deleted, including its terminal history.",
  "Could not snooze chat": "Could not snooze chat",
  "This environment's server does not support snoozing yet. Update the server to use Snooze.":
    "This environment's server does not support snoozing yet. Update the server to use Snooze.",
  "This chat is waiting on you. Respond to the pending request before snoozing it.":
    "This chat is waiting on you. Respond to the pending request before snoozing it.",
  "This chat is still starting a turn. Try again once it's running.":
    "This chat is still starting a turn. Try again once it's running.",
  "The chat could not be snoozed.": "The chat could not be snoozed.",
  "Could not wake chat": "Could not wake chat",
  "This environment's server does not support snoozing yet. Update the server to wake this chat.":
    "This environment's server does not support snoozing yet. Update the server to wake this chat.",
  "The chat could not be woken.": "The chat could not be woken.",
  "Could not pin chat": "Could not pin chat",
  "This environment's server does not support pinning yet. Update the server to use Pin.":
    "This environment's server does not support pinning yet. Update the server to use Pin.",
  "The chat could not be pinned.": "The chat could not be pinned.",
  "Could not unpin chat": "Could not unpin chat",
  "The chat could not be unpinned.": "The chat could not be unpinned.",
  "Could not regenerate title": "Could not regenerate title",
  "This environment's server does not support title regeneration yet. Update the server to regenerate chat titles.":
    "This environment's server does not support title regeneration yet. Update the server to regenerate chat titles.",
  "The chat title could not be regenerated.": "The chat title could not be regenerated.",
  "Could not move chat": "Could not move chat",
  "This environment's server does not support pinned reordering yet. Update the server to reorder pins.":
    "This environment's server does not support pinned reordering yet. Update the server to reorder pins.",
  "The pinned chat could not be moved.": "The pinned chat could not be moved.",
  "Select a bot": "Select a bot",
  "Choose a bot from the sidebar or start a new task.":
    "Choose a bot from the sidebar or start a new task.",
  "New Task": "New Task",
  "Project already exists": "Project already exists",
  "Clear cache for {label}?": "Clear cache for {label}?",
  "This removes offline chats, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.":
    "This removes offline chats, server metadata, and cached branches for this environment. The saved connection and credentials stay intact.",
  "Clear Cache": "Clear Cache",
  "Clear all client caches?": "Clear all client caches?",
  "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.":
    "This removes offline data for every environment. Connections, credentials, account data, and app preferences stay intact.",
  "Clear All Caches": "Clear All Caches",
  "Update failed": "Update failed",
  "Could not import shared content": "Could not import shared content",
  Dismiss: "Dismiss",
  Retry: "Retry",
  "Could not switch branch": "Could not switch branch",
  "The branch could not be checked out.": "The branch could not be checked out.",
  "Shared content unavailable": "Shared content unavailable",
  "The shared content is no longer in the inbox. You can continue editing this chat draft.":
    "The shared content is no longer in the inbox. You can continue editing this chat draft.",
  "Some shared content was skipped": "Some shared content was skipped",
  "The shared content could not be saved.": "The shared content could not be saved.",
  "Cancel import": "Cancel import",
  "Could not cancel import": "Could not cancel import",
  "The shared content could not be restored safely.":
    "The shared content could not be restored safely.",
  "Retry import": "Retry import",
  "Retry cancel": "Retry cancel",
  "Could not queue chat": "Could not queue chat",
  "The chat could not be saved to the outbox.": "The chat could not be saved to the outbox.",
  "Could not start chat": "Could not start chat",
  "The chat could not be started.": "The chat could not be started.",
  "{count} shared image was skipped because this draft reached the attachment limit.":
    "{count} shared image was skipped because this draft reached the attachment limit.",
  "{count} shared images were skipped because this draft reached the attachment limit.":
    "{count} shared images were skipped because this draft reached the attachment limit.",
  "Could not change project": "Could not change project",
  "The shared content reservation could not be updated.":
    "The shared content reservation could not be updated.",
  "Could not save bot settings": "Could not save bot settings",
  "That snooze time has passed. Choose another time.":
    "That snooze time has passed. Choose another time.",
  "A new version has been downloaded and installs automatically the next time you leave the app. Install it now instead?":
    "A new version has been downloaded and installs automatically the next time you leave the app. Install it now instead?",
  Later: "Later",
  "Install Now": "Install Now",
  "Remove environment?": "Remove environment?",
  "Disconnect and forget {label} on this device.": "Disconnect and forget {label} on this device.",
  Remove: "Remove",
  "Start a Codex chat first": "Start a Codex chat first",
  "Send a message before you submit feedback.": "Send a message before you submit feedback.",
  "Could not send feedback to OpenAI": "Could not send feedback to OpenAI",
  "An error occurred.": "An error occurred.",
  "Feedback sent to OpenAI": "Feedback sent to OpenAI",
  "Thread ID: {id}": "Thread ID: {id}",
  OK: "OK",
  "Copy ID": "Copy ID",
  "More than one bot here is named {name}. Pick one from the @ menu to mention it.":
    "More than one bot here is named {name}. Pick one from the @ menu to mention it.",
  "Some images were not restored": "Some images were not restored",
  "{count} image was unavailable or over the attachment limit.":
    "{count} image was unavailable or over the attachment limit.",
  "{count} images were unavailable or over the attachment limit.":
    "{count} images were unavailable or over the attachment limit.",
  "Stash entry may come back": "Stash entry may come back",
  "Browser storage rejected the update.": "Browser storage rejected the update.",
  "Browser storage rejected the delete.": "Browser storage rejected the delete.",
  "Could not stash this prompt": "Could not stash this prompt",
  "Browser storage rejected the write, so the message was left in place.":
    "Browser storage rejected the write, so the message was left in place.",
  "Stashed prompt will not survive a reload": "Stashed prompt will not survive a reload",
  "Browser storage is unavailable, so the stash is kept for this session.":
    "Browser storage is unavailable, so the stash is kept for this session.",
  "Oldest stashed prompt discarded": "Oldest stashed prompt discarded",
  "The stash holds {count} prompt.": "The stash holds {count} prompt.",
  "The stash holds {count} prompts.": "The stash holds {count} prompts.",
  "Stashed images were not saved": "Stashed images were not saved",
  "The text was saved, but the images may be missing after a reload.":
    "The text was saved, but the images may be missing after a reload.",
  "Stashed images did not attach": "Stashed images did not attach",
  "The prompt was restored or deleted before its images finished saving.":
    "The prompt was restored or deleted before its images finished saving.",
  "Could not dictate": "Could not dictate",
  "Cancel reply": "Cancel reply",
  "Message {name}": "Message {name}",
  "Add to prompt": "Add to prompt",
  "Attach file": "Attach file",
  "Attach files": "Attach files",
  "Mention {name}": "Mention {name}",
  "Dictation unavailable": "Dictation unavailable",
  "{name} is working": "{name} is working",
  "Preview browser": "Preview browser",
  Bot: "Bot",
  Chat: "Chat",
  Mention: "Mention",
  Mentions: "Mentions",
  "Unknown chat": "Unknown chat",
  "Unknown bot": "Unknown bot",
  "Remove {name}": "Remove {name}",
  "Preview {name}": "Preview {name}",
  "Could not change the model": "Could not change the model",
  "Change model": "Change model",
  "Dismiss warning": "Dismiss warning",
  "Terminal context expired. Remove and re-add {label} to include it in your message.":
    "Terminal context expired. Remove and re-add {label} to include it in your message.",
  "Select one or more.": "Select one or more.",
  "Stashed prompts: {count}. Open stash.": "Stashed prompts: {count}. Open stash.",
  Stash: "Stash",
  "({count} image)": "({count} image)",
  "({count} images)": "({count} images)",
  "(empty)": "(empty)",
  "Close stash": "Close stash",
  "Stashed prompts": "Stashed prompts",
  "Nothing stashed yet. Press {shortcut} with a prompt in the composer to stash it.":
    "Nothing stashed yet. Press {shortcut} with a prompt in the composer to stash it.",
  "Nothing stashed yet.": "Nothing stashed yet.",
  "Restore stashed prompt: {snippet}": "Restore stashed prompt: {snippet}",
  "saving {count} image…": "saving {count} image…",
  "saving {count} images…": "saving {count} images…",
  "{count} image dropped": "{count} image dropped",
  "{count} images dropped": "{count} images dropped",
  "Delete stashed prompt": "Delete stashed prompt",
  "Dictation ready.": "Dictation ready.",
  "Requesting microphone access…": "Requesting microphone access…",
  "Recording dictation.": "Recording dictation.",
  "Transcribing dictation…": "Transcribing dictation…",
  "Dictation canceled.": "Dictation canceled.",
  "Dictation failed. Try again.": "Dictation failed. Try again.",
  "Cancel dictation": "Cancel dictation",
  "Stop dictation": "Stop dictation",
  "Retry dictation": "Retry dictation",
  "Start dictation": "Start dictation",
  "Dictation unavailable: {reason}": "Dictation unavailable: {reason}",
  Dictate: "Dictate",
  "Hold to dictate, or activate to toggle.": "Hold to dictate, or activate to toggle.",
  "Dismiss dictation error": "Dismiss dictation error",
  "Hold to dictate and release to finish, or activate to start and activate again to stop.":
    "Hold to dictate and release to finish, or activate to start and activate again to stop.",
  "Always allow this session": "Always allow this session",
  Approve: "Approve",
  "Create routine": "Create routine",
  Never: "Never",
  "Enable Auto Review": "Enable Auto Review",
  "Let Auto Review decide the rest of this session":
    "Let Auto Review decide the rest of this session",
  "New routine": "New routine",
  Weekdays: "Weekdays",
  Weekly: "Weekly",
  Daily: "Daily",
  "Routine approval": "Routine approval",
  "Routine failed": "Routine failed",
  "Product feedback approval": "Product feedback approval",
  "App access approval": "App access approval",
  "Command approval": "Command approval",
  "File read approval": "File read approval",
  "File change approval": "File change approval",
  "Routine details": "Routine details",
  "Product feedback draft": "Product feedback draft",
  "App access request": "App access request",
  Command: "Command",
  "File to read": "File to read",
  "File change": "File change",
  "Review routine": "Review routine",
  "{schedule} at {time}": "{schedule} at {time}",
  "{count} line": "{count} line",
  "{count} lines": "{count} lines",
  Collapse: "Collapse",
  "The request failed.": "The request failed.",
  Goal: "Goal",
  Identity: "Identity",
  "First message": "First message",
  "The key was not saved. Try again.": "The key was not saved. Try again.",
  "Connect {provider} with an API key": "Connect {provider} with an API key",
  "Finish connecting {provider}": "Finish connecting {provider}",
  "Finish signing in on the provider page.": "Finish signing in on the provider page.",
  "Copy sign-in code": "Copy sign-in code",
  "Paste authorization code": "Paste authorization code",
  "Waiting for approval": "Waiting for approval",
  "Connect your provider": "Connect your provider",
  "Use an API key": "Use an API key",
  "Connect {provider}": "Connect {provider}",
  "Give it a name": "Give it a name",
  "You will call on this bot by name every day. Pick one that sounds like a teammate.":
    "You will call on this bot by name every day. Pick one that sounds like a teammate.",
  Name: "Name",
  "Nova, Scout, Dispatch…": "Nova, Scout, Dispatch…",
  Avatar: "Avatar",
  Shape: "Shape",
  "{shape} avatar": "{shape} avatar",
  Color: "Color",
  "Preparing your provider…": "Preparing your provider…",
  "This provider is not ready. Go back and reconnect it.":
    "This provider is not ready. Go back and reconnect it.",
  "Could not create your bot.": "Could not create your bot.",
  "Set up Akeru Bot": "Set up Akeru Bot",
  "Setup steps": "Setup steps",
  "Say hello to {name}": "Say hello to {name}",
  "Your goal and the plan for it, written out. Edit it however you like, then send. This is the real conversation, not a demo.":
    "Your goal and the plan for it, written out. Edit it however you like, then send. This is the real conversation, not a demo.",
  "Waking up {name}": "Waking up {name}",
  "Step {number} of {total}": "Step {number} of {total}",
  "Skip setup": "Skip setup",
  "Skip setup?": "Skip setup?",
  "You can connect a subscription and create a bot later.":
    "You can connect a subscription and create a bot later.",
  "your bot": "your bot",
  "Message sent": "Message sent",
  "Waking {name} up": "Waking {name} up",
  "Opening your workspace": "Opening your workspace",
  "Social media": "Social media",
  Research: "Research",
  Admin: "Admin",
  "Personal planning": "Personal planning",
  "Reading what you wrote": "Reading what you wrote",
  "Working out where to start": "Working out where to start",
  "Your goal": "Your goal",
  Edit: "Edit",
  "I'll start by…": "I'll start by…",
  "What do you want help with?": "What do you want help with?",
  "One or two sentences is plenty. Your bot works the rest out from there.":
    "One or two sentences is plenty. Your bot works the rest out from there.",
  "I want my bot to…": "I want my bot to…",
  "Looks right": "Looks right",
  "your newsletter": "your newsletter",
  "Draft a first batch of posts for {focus}, in your voice":
    "Draft a first batch of posts for {focus}, in your voice",
  "Draft a first batch of posts in your voice": "Draft a first batch of posts in your voice",
  "Show them to you before anything goes out": "Show them to you before anything goes out",
  "Write more like the ones you keep": "Write more like the ones you keep",
  "I'll ask which accounts to post from once there's a draft worth posting.":
    "I'll ask which accounts to post from once there's a draft worth posting.",
  "your competitors": "your competitors",
  pricing: "pricing",
  "the market": "the market",
  "the news": "the news",
  research: "research",
  "the benchmarks": "the benchmarks",
  "Gather what is already out there on {focus}": "Gather what is already out there on {focus}",
  "Gather what is already out there on this": "Gather what is already out there on this",
  "Put it on one page you can skim": "Put it on one page you can skim",
  "Flag what changed instead of making you re-read it":
    "Flag what changed instead of making you re-read it",
  "I'll ask where that page should live once there's something on it.":
    "I'll ask where that page should live once there's something on it.",
  inbox: "inbox",
  invoices: "invoices",
  receipts: "receipts",
  expenses: "expenses",
  tickets: "tickets",
  paperwork: "paperwork",
  "Go through what is sitting in your {focus}": "Go through what is sitting in your {focus}",
  "Go through what has piled up": "Go through what has piled up",
  "Separate what actually needs you from what does not":
    "Separate what actually needs you from what does not",
  "Draft the replies and the filing for you to check":
    "Draft the replies and the filing for you to check",
  "I'll ask for access when something is ready to send.":
    "I'll ask for access when something is ready to send.",
  "your week": "your week",
  "your trip": "your trip",
  "your routine": "your routine",
  "your budget": "your budget",
  "your meals": "your meals",
  "your training": "your training",
  "Lay out what is actually on your plate for {focus}":
    "Lay out what is actually on your plate for {focus}",
  "Lay out what is actually on your plate": "Lay out what is actually on your plate",
  "Turn it into an order you can follow": "Turn it into an order you can follow",
  "Say something when a piece slips": "Say something when a piece slips",
  "I'll ask about your calendar when putting it there would help.":
    "I'll ask about your calendar when putting it there would help.",
  "your repo": "your repo",
  "your app": "your app",
  "your site": "your site",
  "your API": "your API",
  "your database": "your database",
  "your tests": "your tests",
  "Read through {focus} to find where this belongs":
    "Read through {focus} to find where this belongs",
  "Read through the project to find where this belongs":
    "Read through the project to find where this belongs",
  "Make the smallest change that proves it works": "Make the smallest change that proves it works",
  "Show you the diff before anything else": "Show you the diff before anything else",
  "I'll ask about your setup when I need to run something.":
    "I'll ask about your setup when I need to run something.",
  "Work out what a good result looks like here": "Work out what a good result looks like here",
  "Take the first real step and show you what came of it":
    "Take the first real step and show you what came of it",
  "Adjust from what you say about it": "Adjust from what you say about it",
  "I'll ask for whatever I need, at the point I need it.":
    "I'll ask for whatever I need, at the point I need it.",
  "{first} and {second}": "{first} and {second}",
  "Pick the subscription that powers your bot": "Pick the subscription that powers your bot",
  "Say what you want help with": "Say what you want help with",
  "Give it a name and a look": "Give it a name and a look",
  "Send the first message": "Send the first message",
  "Could not send the message.": "Could not send the message.",
  "Your bot": "Your bot",
  "This view failed to load": "This view failed to load",
  "Retry this view. If it fails again, reload Akeru Bot.":
    "Retry this view. If it fails again, reload Akeru Bot.",
  "Technical details": "Technical details",
  "No additional error details are available.": "No additional error details are available.",
  "Keybindings updated": "Keybindings updated",
  "Keybindings configuration reloaded successfully.":
    "Keybindings configuration reloaded successfully.",
  "Invalid keybindings configuration": "Invalid keybindings configuration",
  "Open keybindings.json": "Open keybindings.json",
  "Unable to open keybindings file": "Unable to open keybindings file",
  "Unknown error opening file.": "Unknown error opening file.",
  Create: "Create",
  "New bot": "New bot",
  "New group": "New group",
  "Last message {time}": "Last message {time}",
  "Actions for {name}": "Actions for {name}",
  "Bot settings": "Bot settings",
  Unpin: "Unpin",
  Pin: "Pin",
  "Move up": "Move up",
  "Move down": "Move down",
  "Archive bot": "Archive bot",
  "Connect an environment first": "Connect an environment first",
  "Could not archive {name}": "Could not archive {name}",
  "Could not restore {name}": "Could not restore {name}",
  "Could not create bot": "Could not create bot",
  "Could not create group": "Could not create group",
  "No bots yet": "No bots yet",
  "Bots and groups": "Bots and groups",
  Pinned: "Pinned",
  Groups: "Groups",
  "{count} unpinned": "{count} unpinned",
  "No bots match": "No bots match",
  Archived: "Archived",
  "{count} archived": "{count} archived",
  "Archived bots": "Archived bots",
  "Restore {name}": "Restore {name}",
  Restore: "Restore",
  "Archive {name}?": "Archive {name}?",
  "{name} leaves the roster and stops taking messages. Its chat history is kept, and you can restore it from Archived at any time.":
    "{name} leaves the roster and stops taking messages. Its chat history is kept, and you can restore it from Archived at any time.",
  "{count} bot": "{count} bot",
  "{count} bots": "{count} bots",
  "(required)": "(required)",
  "Bot name": "Bot name",
  "Enter a name to create this bot.": "Enter a name to create this bot.",
  "This is how the bot appears in your roster.": "This is how the bot appears in your roster.",
  "Upload image": "Upload image",
  Creating: "Creating",
  "Create bot": "Create bot",
  "Group name": "Group name",
  "Select at least two bots.": "Select at least two bots.",
  Boss: "Boss",
  "Group boss": "Group boss",
  "Choose boss": "Choose boss",
  "Create group": "Create group",
  "A group needs at least two bots. Add another bot before you remove one.":
    "A group needs at least two bots. Add another bot before you remove one.",
  "A group needs at least two bots. Create a new bot in the roster before you remove one.":
    "A group needs at least two bots. Create a new bot in the roster before you remove one.",
  "To remove {name}, make another bot the boss first.":
    "To remove {name}, make another bot the boss first.",
  "Could not rename group": "Could not rename group",
  "Could not change group boss": "Could not change group boss",
  Specialist: "Specialist",
  "Remove {bot} from {group}": "Remove {bot} from {group}",
  "Could not remove {name}": "Could not remove {name}",
  "Add bot": "Add bot",
  "Choose bot": "Choose bot",
  "Add bot to group": "Add bot to group",
  "Could not add bot": "Could not add bot",
  "Every bot is already in this group.": "Every bot is already in this group.",
  "Delete group": "Delete group",
  'Delete "{name}"? Its bots stay in your roster.':
    'Delete "{name}"? Its bots stay in your roster.',
  "Could not delete group": "Could not delete group",
  Group: "Group",
  "{name} group sidebar": "{name} group sidebar",
  "Collapse {name} group sidebar": "Collapse {name} group sidebar",
  "Collapse ({shortcut})": "Collapse ({shortcut})",
  "Open {name} group sidebar": "Open {name} group sidebar",
  "Edit {name}": "Edit {name}",
  "Close group sidebar": "Close group sidebar",
  "Saturation and brightness": "Saturation and brightness",
  Hue: "Hue",
  Hex: "Hex",
  "Avatar color hex value": "Avatar color hex value",
  "Avatar color": "Avatar color",
  "Use {color}": "Use {color}",
  "Choose a custom avatar color. Current color {color}":
    "Choose a custom avatar color. Current color {color}",
  "Avatar source": "Avatar source",
  Upload: "Upload",
  "Avatar preview": "Avatar preview",
  "Choose image": "Choose image",
  "Could not save": "Could not save",
  "Image too large": "Image too large",
  "Could not read image": "Could not read image",
  Saving: "Saving",
  "Saturation {saturation}%, brightness {brightness}%, {hex}":
    "Saturation {saturation}%, brightness {brightness}%, {hex}",
  "Create your first bot": "Create your first bot",
  "A bot is a teammate you chat with. It keeps its own instructions, memory, tools, and schedule, so you can give it a job once and come back to it.":
    "A bot is a teammate you chat with. It keeps its own instructions, memory, tools, and schedule, so you can give it a job once and come back to it.",
  "Connect an environment to create one.": "Connect an environment to create one.",
  Circle: "Circle",
  Squircle: "Squircle",
  Square: "Square",
  Pill: "Pill",
  Triangle: "Triangle",
  Hexagon: "Hexagon",
  Cloud: "Cloud",
  Drop: "Drop",
  Yesterday: "Yesterday",
  "Go to chats": "Go to chats",
  "No plugins enabled": "No plugins enabled",
  "Plugins, {status}": "Plugins, {status}",
  "Plugins · {status}": "Plugins · {status}",
  "Connect an environment": "Connect an environment",
  "{name} controls this Mac": "{name} controls this Mac",
  "Revoke Computer Use for all bots": "Revoke Computer Use for all bots",
  "Disable Computer Use for all bots": "Disable Computer Use for all bots",
  Revoke: "Revoke",
  Feedback: "Feedback",
  "{count} plugin enabled": "{count} plugin enabled",
  "{count} plugins enabled": "{count} plugins enabled",
  "Intel build on Apple Silicon": "Intel build on Apple Silicon",
  "Update available": "Update available",
  "Checking for updates…": "Checking for updates…",
  "Check for updates": "Check for updates",
  "Could not download update": "Could not download update",
  "Could not start update download": "Could not start update download",
  "Could not confirm update": "Could not confirm update",
  "Could not install update": "Could not install update",
  "Could not check for updates": "Could not check for updates",
  "Dismiss provider update notice": "Dismiss provider update notice",
  "Dismiss until provider status changes": "Dismiss until provider status changes",
  "Toggle main sidebar": "Toggle main sidebar",
  "Toggle main sidebar ({shortcut})": "Toggle main sidebar ({shortcut})",
  "1 of {count}": "1 of {count}",
  "Add a project before you message a bot.": "Add a project before you message a bot.",
  "Add a reachable backend manually to start working from this browser.":
    "Add a reachable backend manually to start working from this browser.",
  "Allow app access?": "Allow app access?",
  "Approval required": "Approval required",
  "Audio could not play. Retry, or check voice settings.":
    "Audio could not play. Retry, or check voice settings.",
  "Cancel delegation to {name}": "Cancel delegation to {name}",
  "Change reaction, {emoji} selected": "Change reaction, {emoji} selected",
  "Change this file?": "Change this file?",
  "Choose a reaction": "Choose a reaction",
  "Choose an active group boss in the group sidebar.":
    "Choose an active group boss in the group sidebar.",
  "Close image preview": "Close image preview",
  "Collapse (Esc)": "Collapse (Esc)",
  "Collapse {name} browser": "Collapse {name} browser",
  "Connect a provider in Settings > Providers so this group can reply.":
    "Connect a provider in Settings > Providers so this group can reply.",
  "Connect an environment to get started": "Connect an environment to get started",
  "Connecting bot…": "Connecting bot…",
  "Coordinating work": "Coordinating work",
  Copy: "Copy",
  "Could not approve procedure": "Could not approve procedure",
  "Could not assign {name}": "Could not assign {name}",
  "Could not cancel delegation": "Could not cancel delegation",
  "Could not create routine": "Could not create routine",
  "Could not delete routine": "Could not delete routine",
  "Could not enable routine": "Could not enable routine",
  "Could not load errors": "Could not load errors",
  "Could not open Routines": "Could not open Routines",
  "Could not pause routine": "Could not pause routine",
  "Could not resume routine": "Could not resume routine",
  "Could not save routine": "Could not save routine",
  "Could not send to {channel}": "Could not send to {channel}",
  "Could not start dry run": "Could not start dry run",
  "Could not start routine": "Could not start routine",
  "Could not update reaction": "Could not update reaction",
  "Delegation to {name}": "Delegation to {name}",
  "Dismiss error": "Dismiss error",
  "Editing files": "Editing files",
  "Entering text": "Entering text",
  "Expand {name} browser": "Expand {name} browser",
  "Expanded image preview": "Expanded image preview",
  "Failed to copy message": "Failed to copy message",
  "Failure details unavailable": "Failure details unavailable",
  "Group boss unavailable": "Group boss unavailable",
  "Hard stop": "Hard stop",
  Install: "Install",
  "Loading bot…": "Loading bot…",
  "Loading errors": "Loading errors",
  "MCP servers: {count}": "MCP servers: {count}",
  "{count} open": "{count} open",
  Manage: "Manage",
  "More message actions": "More message actions",
  "Next image": "Next image",
  "Next: {action}": "Next: {action}",
  "No errors": "No errors",
  "No provider is connected": "No provider is connected",
  Open: "Open",
  "Open Plugins": "Open Plugins",
  "Open Providers": "Open Providers",
  "Could not resolve this item": "Could not resolve this item",
  "Paused. Fix the cause in Bot inbox, then resume it.":
    "Paused. Fix the cause in Bot inbox, then resume it.",
  "Fix this in Plugins on the desktop or web app.":
    "Fix this in Plugins on the desktop or web app.",
  "Open chat": "Open chat",
  "Open the desktop app to view the browser.": "Open the desktop app to view the browser.",
  "Open {name} bot sidebar": "Open {name} bot sidebar",
  "Open {name} browser": "Open {name} browser",
  "Open {name} chat": "Open {name} chat",
  "Opening a page": "Opening a page",
  "Opening page…": "Opening page…",
  "Pause readout": "Pause readout",
  "Preparing audio": "Preparing audio",
  "Previous image": "Previous image",
  Question: "Question",
  React: "React",
  "React {emoji}": "React {emoji}",
  "Reactions are unavailable until this chat is ready":
    "Reactions are unavailable until this chat is ready",
  "Read aloud": "Read aloud",
  "Read this file?": "Read this file?",
  "Reading a source": "Reading a source",
  "Reading the page": "Reading the page",
  "Remove your {emoji} reaction": "Remove your {emoji} reaction",
  "Remove {emoji}": "Remove {emoji}",
  Reply: "Reply",
  "Reply playback": "Reply playback",
  "Reply to message": "Reply to message",
  "Result unavailable": "Result unavailable",
  Resume: "Resume",
  "Resume readout": "Resume readout",
  "Resuming…": "Resuming…",
  "Retry readout": "Retry readout",
  "Review product feedback": "Review product feedback",
  "Routine draft created": "Routine draft created",
  "Routine draft saved": "Routine draft saved",
  Routines: "Routines",
  "Run this command?": "Run this command?",
  "Running a command": "Running a command",
  "Running checks": "Running checks",
  "Runs once": "Runs once",
  "Scroll to latest message": "Scroll to latest message",
  "Searching the web": "Searching the web",
  Send: "Send",
  "Send feedback": "Send feedback",
  "Send this reply to {channel}?": "Send this reply to {channel}?",
  "Sent to {channel}": "Sent to {channel}",
  "Set up": "Set up",
  "Set up Composio first": "Set up Composio first",
  "Stop readout": "Stop readout",
  "The browser appears when the bot opens a page.":
    "The browser appears when the bot opens a page.",
  "The page did not load.": "The page did not load.",
  Today: "Today",
  Unavailable: "Unavailable",
  "Unavailable bot": "Unavailable bot",
  "Usage unavailable": "Usage unavailable",
  "Usage unavailable for {name}": "Usage unavailable for {name}",
  "Use the computer?": "Use the computer?",
  "Using the page": "Using the page",
  "View details": "View details",
  Working: "Working",
  "Write a custom answer…": "Write a custom answer…",
  "approval ceiling: {ceiling}": "approval ceiling: {ceiling}",
  "approval required": "approval required",
  "auto-accept edits": "auto-accept edits",
  "automatic approvals": "automatic approvals",
  blocked: "blocked",
  canceled: "canceled",
  completed: "completed",
  failed: "failed",
  "full access": "full access",
  "memory: {scopes}": "memory: {scopes}",
  "no approvals": "no approvals",
  "no sandbox": "no sandbox",
  "no user computer": "no user computer",
  none: "none",
  queued: "queued",
  running: "running",
  "tools: {tools}": "tools: {tools}",
  "user computer": "user computer",
  "{action} {name}": "{action} {name}",
  "{botName} did not reply. {title}.": "{botName} did not reply. {title}.",
  "{label}, elapsed time updating": "{label}, elapsed time updating",
  "{name} browser": "{name} browser",
  "{name} chat": "{name} chat",
  "{name} group chat": "{name} group chat",
  "{name} plugin": "{name} plugin",
  "{name}'s browser": "{name}'s browser",
  "{sandbox} sandbox": "{sandbox} sandbox",
  "{text}. Open Routines": "{text}. Open Routines",
  "{tokens} tokens": "{tokens} tokens",
  "{tokens} tokens billed to {name}": "{tokens} tokens billed to {name}",
  "Bot settings saved": "Bot settings saved",
  "Bot settings breadcrumb": "Bot settings breadcrumb",
  "This bot is no longer available.": "This bot is no longer available.",
  "Discard unsaved bot settings?": "Discard unsaved bot settings?",
  "Shown in the roster, the chat header, and anywhere this bot speaks.":
    "Shown in the roster, the chat header, and anywhere this bot speaks.",
  "Change bot avatar": "Change bot avatar",
  "What you call this bot in chats and mentions.": "What you call this bot in chats and mentions.",
  "An optional role, such as research, marketing, or admin.":
    "An optional role, such as research, marketing, or admin.",
  "Bot label": "Bot label",
  "Research, marketing, admin": "Research, marketing, admin",
  Description: "Description",
  "A note to yourself about what this bot is for. Searchable from the roster.":
    "A note to yourself about what this bot is for. Searchable from the roster.",
  "Bot description": "Bot description",
  "What this bot is for": "What this bot is for",
  "What it does": "What it does",
  "Voice and personality": "Voice and personality",
  Personality: "Personality",
  "Choose how this bot usually sounds. It is a baseline, not a costume. The bot still adapts to you and to the task, so serious work stays serious in every mode.":
    "Choose how this bot usually sounds. It is a baseline, not a costume. The bot still adapts to you and to the task, so serious work stays serious in every mode.",
  "Let this bot take subscription voice calls. Voice must also be enabled in Settings.":
    "Let this bot take subscription voice calls. Voice must also be enabled in Settings.",
  "Disable voice calls for {name}": "Disable voice calls for {name}",
  "Enable voice calls for {name}": "Enable voice calls for {name}",
  Model: "Model",
  "The provider and model this bot runs on.": "The provider and model this bot runs on.",
  "No model yet": "No model yet",
  Reasoning: "Reasoning",
  "How much thinking this bot spends before it answers.":
    "How much thinking this bot spends before it answers.",
  "Stop this bot once it has spent this many tokens. Leave empty for no limit.":
    "Stop this bot once it has spent this many tokens. Leave empty for no limit.",
  "This provider reports occupancy rather than tokens, so a token limit does not apply.":
    "This provider reports occupancy rather than tokens, so a token limit does not apply.",
  "What this bot has spent so far.": "What this bot has spent so far.",
  "Where this bot runs commands and edits files.": "Where this bot runs commands and edits files.",
  "Sandbox provider": "Sandbox provider",
  Tools: "Tools",
  "Which workspace tools this bot may reach.": "Which workspace tools this bot may reach.",
  "Manage bot tools": "Manage bot tools",
  "No workspace tools": "No workspace tools",
  "{enabled} of {total} enabled": "{enabled} of {total} enabled",
  "Which subscription this bot uses to create images. The chat model above stays the same.":
    "Which subscription this bot uses to create images. The chat model above stays the same.",
  "Image provider": "Image provider",
  "Open image generation settings": "Open image generation settings",
  "Image settings": "Image settings",
  Memory: "Memory",
  "Facts this bot keeps between chats.": "Facts this bot keeps between chats.",
  "Manage bot memory": "Manage bot memory",
  "Facts and history": "Facts and history",
  "Where this bot answers outside Akeru Bot.": "Where this bot answers outside Akeru Bot.",
  "Manage bot channels": "Manage bot channels",
  "No channels": "No channels",
  "{connected} of {total} connected": "{connected} of {total} connected",
  Saved: "Saved",
  "Unsaved changes": "Unsaved changes",
  "Open bot settings": "Open bot settings",
  "App default": "App default",
  "Unavailable: {reason}": "Unavailable: {reason}",
  "{name} bot sidebar": "{name} bot sidebar",
  "Collapse {name} bot sidebar": "Collapse {name} bot sidebar",
  "Open sidebar ({shortcut})": "Open sidebar ({shortcut})",
  "Open sidebar": "Open sidebar",
  "{name} overview": "{name} overview",
  "Close bot sidebar": "Close bot sidebar",
  "Could not update channel": "Could not update channel",
  "Could not unassign channel": "Could not unassign channel",
  "{name} channels": "{name} channels",
  "Connect an environment first.": "Connect an environment first.",
  "Loading channel access": "Loading channel access",
  "This client does not have permission to manage channels.":
    "This client does not have permission to manage channels.",
  "Set up a channel connection first.": "Set up a channel connection first.",
  "Set up channels": "Set up channels",
  Assigned: "Assigned",
  "Needs reconnect": "Needs reconnect",
  "Disconnected · {name}": "Disconnected · {name}",
  "Assigned to {name}": "Assigned to {name}",
  Unassigned: "Unassigned",
  "Open provider": "Open provider",
  Unassign: "Unassign",
  "Manage connections": "Manage connections",
  "Disabled for the workspace": "Disabled for the workspace",
  "Disable {name} for this bot": "Disable {name} for this bot",
  "Enable {name} for this bot": "Enable {name} for this bot",
  "Close bot tools": "Close bot tools",
  "Choose which workspace tools this bot can use.":
    "Choose which workspace tools this bot can use.",
  "Search tools": "Search tools",
  "Search bot tools": "Search bot tools",
  "Enable all": "Enable all",
  "Disable all": "Disable all",
  "No workspace tools are installed.": "No workspace tools are installed.",
  "No tools match your search.": "No tools match your search.",
  "MCP servers": "MCP servers",
  "Loading…": "Loading…",
  "No usage": "No usage",
  Input: "Input",
  Output: "Output",
  Observer: "Observer",
  Reflector: "Reflector",
  Cap: "Cap",
  "{consumed} / {limit} tokens": "{consumed} / {limit} tokens",
  "No cap": "No cap",
  "Estimated cost": "Estimated cost",
  "Estimated from reported model usage; this is not subscription spend.":
    "Estimated from reported model usage; this is not subscription spend.",
  "Subscription pool": "Subscription pool",
  "{percent}% of pool": "{percent}% of pool",
  Reserved: "Reserved",
  "Some provider usage is unavailable.": "Some provider usage is unavailable.",
  "Personality for {name}": "Personality for {name}",
  "How {name} might sound": "How {name} might sound",
  "An illustration of the band, not a live reply.":
    "An illustration of the band, not a live reply.",
  Chill: "Chill",
  "Short, relaxed messages. Lowercase reads as natural, like a teammate texting.":
    "Short, relaxed messages. Lowercase reads as natural, like a teammate texting.",
  "on it. migration step timed out again. want me to retry, or find out why first?":
    "on it. migration step timed out again. want me to retry, or find out why first?",
  Relaxed: "Relaxed",
  "Relaxed and direct. Casual wording can sit next to serious thinking.":
    "Relaxed and direct. Casual wording can sit next to serious thinking.",
  "Looking now. The migration step timed out again. Want a retry, or should I find the cause first?":
    "Looking now. The migration step timed out again. Want a retry, or should I find the cause first?",
  Balanced: "Balanced",
  "Natural and direct. Follows your tone and the task more than either endpoint.":
    "Natural and direct. Follows your tone and the task more than either endpoint.",
  "Checking now. The migration step timed out again. I can retry it or trace the cause.":
    "Checking now. The migration step timed out again. I can retry it or trace the cause.",
  Composed: "Composed",
  "Clear and composed replies, loosening up when you do.":
    "Clear and composed replies, loosening up when you do.",
  "I'm checking that now. The migration step timed out again. I can retry the deploy, or trace the cause before we try again.":
    "I'm checking that now. The migration step timed out again. I can retry the deploy, or trace the cause before we try again.",
  Professional: "Professional",
  "Concise and professional, using contractions and ordinary words. Never corporate.":
    "Concise and professional, using contractions and ordinary words. Never corporate.",
  "I'm looking into it. The migration step timed out again. I'd trace the cause before retrying, since a retry will likely hit the same timeout.":
    "I'm looking into it. The migration step timed out again. I'd trace the cause before retrying, since a retry will likely hit the same timeout.",
  "the staging deploy failed again": "the staging deploy failed again",
  "{name} is not available right now.": "{name} is not available right now.",
  "{name} is unavailable in this chat. Start a new chat to switch providers.":
    "{name} is unavailable in this chat. Start a new chat to switch providers.",
  "Search models…": "Search models…",
  "No models found": "No models found",
  "{count} model": "{count} model",
  "{count} models": "{count} models",
  "{name} is not ready yet.": "{name} is not ready yet.",
  Favorites: "Favorites",
  "{name}, new": "{name}, new",
  "New model": "New model",
  New: "New",
  "Remove from favorites": "Remove from favorites",
  "Add to favorites": "Add to favorites",
  "{model} is no longer offered by this provider. Choose another model.":
    "{model} is no longer offered by this provider. Choose another model.",
  "No longer offered by this provider": "No longer offered by this provider",
  "Your prompt contains {keyword} in the text. Remove it to change this option.":
    "Your prompt contains {keyword} in the text. Remove it to change this option.",
  On: "On",
  Off: "Off",
  Fast: "Fast",
  Normal: "Normal",
  "{label} On": "{label} On",
  "{label} Off": "{label} Off",
  "Fast mode on": "Fast mode on",
  "Settings > Providers": "Settings > Providers",
  "Keep durable facts that bots can use across chats.":
    "Keep durable facts that bots can use across chats.",
  "Private bot memory": "Private bot memory",
  "Save shared project memory automatically": "Save shared project memory automatically",
  "When off, facts shared with a project wait for your approval.":
    "When off, facts shared with a project wait for your approval.",
  "Turn on Memory to change this.": "Turn on Memory to change this.",
  ", ": ", ",
  "Durable facts": "Durable facts",
  "Facts kept beyond this chat. Clearing observations does not remove them.":
    "Facts kept beyond this chat. Clearing observations does not remove them.",
  "Facts kept beyond this chat. Clearing chat observations does not remove them.":
    "Facts kept beyond this chat. Clearing chat observations does not remove them.",
  "Durable facts unavailable.": "Durable facts unavailable.",
  "Loading durable facts…": "Loading durable facts…",
  "No durable facts in this scope yet.": "No durable facts in this scope yet.",
  "Durable fact scope": "Durable fact scope",
  "Durable export scope": "Durable export scope",
  "Edit fact": "Edit fact",
  "Delete fact": "Delete fact",
  "Fact actions": "Fact actions",
  "Replaced: {fact}": "Replaced: {fact}",
  "Replaced:": "Replaced:",
  "From {source} · Bots: {bots}": "From {source} · Bots: {bots}",
  "Created {created} · Updated {updated}": "Created {created} · Updated {updated}",
  Scope: "Scope",
  Status: "Status",
  "Source chat": "Source chat",
  None: "None",
  Created: "Created",
  "Created at": "Created at",
  "Last user message": "Last user message",
  Updated: "Updated",
  "Bots: {bots}": "Bots: {bots}",
  "this chat": "this chat",
  "another chat": "another chat",
  "this bot": "this bot",
  "another bot": "another bot",
  "{count} other bots": "{count} other bots",
  "This chat": "This chat",
  "Facts saved only for this chat.": "Facts saved only for this chat.",
  "This bot": "This bot",
  "Facts this bot keeps about you and its work.": "Facts this bot keeps about you and its work.",
  "This project": "This project",
  "Facts shared across this project.": "Facts shared across this project.",
  "All memory": "All memory",
  "Everything this chat can reach. Export only; import one scope at a time.":
    "Everything this chat can reach. Export only; import one scope at a time.",
  You: "You",
  "Bot, about you": "Bot, about you",
  Approved: "Approved",
  Rejected: "Rejected",
  Active: "Active",
  Forgotten: "Forgotten",
  Deleted: "Deleted",
  Conflicts: "Conflicts",
  Changed: "Changed",
  Skipped: "Skipped",
  Unchanged: "Unchanged",
  "Make private": "Make private",
  "Move to this bot": "Move to this bot",
  "Share with project": "Share with project",
  Reject: "Reject",
  Forget: "Forget",
  "Memory is off. Turn it on in settings to change facts.":
    "Memory is off. Turn it on in settings to change facts.",
  "This connection can read memory but not change it.":
    "This connection can read memory but not change it.",
  "Delete this fact for good?": "Delete this fact for good?",
  "It can't be restored.": "It can't be restored.",
  "Delete for good": "Delete for good",
  Keep: "Keep",
  "This fact changed somewhere else. The latest version is shown now.":
    "This fact changed somewhere else. The latest version is shown now.",
  "The fact could not be updated.": "The fact could not be updated.",
  "Export or import durable facts from the desktop or web app.":
    "Export or import durable facts from the desktop or web app.",
  "No memory saved yet": "No memory saved yet",
  Reset: "Reset",
  "Could not save memory": "Could not save memory",
  "Could not clear memory": "Could not clear memory",
  "Memory request failed.": "Memory request failed.",
  "Observational memory": "Observational memory",
  "Automatic summaries of this chat only. Clearing them keeps the bot, its notes, and durable facts.":
    "Automatic summaries of this chat only. Clearing them keeps the bot, its notes, and durable facts.",
  "No observations yet.": "No observations yet.",
  "Previous observations": "Previous observations",
  "Previous observations ({count})": "Previous observations ({count})",
  "Clear observational memory?": "Clear observational memory?",
  "This removes this chat's summaries.": "This removes this chat's summaries.",
  Clear: "Clear",
  "Clear observations": "Clear observations",
  "Markdown and observations": "Markdown and observations",
  "Start a conversation to manage memory.": "Start a conversation to manage memory.",
  "Loading memory…": "Loading memory…",
  "{count} generation": "{count} generation",
  "{count} generations": "{count} generations",
  "Memory transfer failed.": "Memory transfer failed.",
  "Transfer memory": "Transfer memory",
  "Export bot notes and chat observations, or durable facts for one scope. Review an import before anything changes.":
    "Export bot notes and chat observations, or durable facts for one scope. Review an import before anything changes.",
  "Export notes": "Export notes",
  "Durable facts: {description}": "Durable facts: {description}",
  "Export durable facts": "Export durable facts",
  "Import memory archive": "Import memory archive",
  "All-memory archives can't be imported. Export and import one scope at a time.":
    "All-memory archives can't be imported. Export and import one scope at a time.",
  "{name}: {status}, {count} / {limit} characters":
    "{name}: {status}, {count} / {limit} characters",
  "This import will replace this chat's observations.":
    "This import will replace this chat's observations.",
  "Chat observations are unchanged.": "Chat observations are unchanged.",
  "Apply import": "Apply import",
  "Imported {imported}, changed {changed}, skipped {skipped}.":
    "Imported {imported}, changed {changed}, skipped {skipped}.",
  "This archive has no durable facts to import.": "This archive has no durable facts to import.",
  "{label} ({count})": "{label} ({count})",
  "Yours:": "Yours:",
  "Not loaded": "Not loaded",
  "Archive:": "Archive:",
  Unknown: "Unknown",
  "Resolve conflict {id}": "Resolve conflict {id}",
  "Keep mine": "Keep mine",
  "Use archive": "Use archive",
  "Choose a version for {count} conflict before applying. Nothing changes until you apply.":
    "Choose a version for {count} conflict before applying. Nothing changes until you apply.",
  "Choose a version for {count} conflicts before applying. Nothing changes until you apply.":
    "Choose a version for {count} conflicts before applying. Nothing changes until you apply.",
  "Stable details this bot has learned about you.":
    "Stable details this bot has learned about you.",
  "Durable notes and working preferences owned by this bot.":
    "Durable notes and working preferences owned by this bot.",
  "This bot's private memory for the active group chat.":
    "This bot's private memory for the active group chat.",
  "Let each bot keep facts about you that only that bot uses.":
    "Let each bot keep facts about you that only that bot uses.",
  Sunday: "Sunday",
  Monday: "Monday",
  Tuesday: "Tuesday",
  Wednesday: "Wednesday",
  Thursday: "Thursday",
  Friday: "Friday",
  Saturday: "Saturday",
  "{frequency} at {time} ({timezone})": "{frequency} at {time} ({timezone})",
  Paused: "Paused",
  Draft: "Draft",
  Completed: "Completed",
  Failed: "Failed",
  Running: "Running",
  "Needs approval": "Needs approval",
  Blocked: "Blocked",
  Canceled: "Canceled",
  "Not scheduled": "Not scheduled",
  now: "now",
  "{count}m": "{count}m",
  "{count}h": "{count}h",
  "{count}d": "{count}d",
  "in {span}": "in {span}",
  "{span} ago": "{span} ago",
  Instructions: "Instructions",
  Schedule: "Schedule",
  Time: "Time",
  Day: "Day",
  Timezone: "Timezone",
  Skills: "Skills",
  Connectors: "Connectors",
  "Add a project to this environment before creating a routine.":
    "Add a project to this environment before creating a routine.",
  "{count} run": "{count} run",
  "{count} runs": "{count} runs",
  "Paused until you resume it.": "Paused until you resume it.",
  "Off until you turn it back on.": "Off until you turn it back on.",
  "Draft. Approve its procedure to schedule it.": "Draft. Approve its procedure to schedule it.",
  "No next run scheduled.": "No next run scheduled.",
  "Next run": "Next run",
  "Open {name}": "Open {name}",
  Enable: "Enable",
  Pause: "Pause",
  Test: "Test",
  "Run now": "Run now",
  "Back to routines": "Back to routines",
  "When to run": "When to run",
  "Last run": "Last run",
  "Latest run": "Latest run",
  "This routine runs only once you approve its procedure.":
    "This routine runs only once you approve its procedure.",
  "Approve procedure": "Approve procedure",
  "Loading routines": "Loading routines",
  Loading: "Loading",
  "Could not load routines.": "Could not load routines.",
  "Routines are not available for this environment.":
    "Routines are not available for this environment.",
  "No routines": "No routines",
  "Routines are recurring tasks {botName} runs on a schedule.":
    "Routines are recurring tasks {botName} runs on a schedule.",
  "Or ask {botName} in chat to set one up.": "Or ask {botName} in chat to set one up.",
  "Routines report to your chat with {botName}. Send {botName} a message to start the chat, then add a routine here.":
    "Routines report to your chat with {botName}. Send {botName} a message to start the chat, then add a routine here.",
  "Delete routine “{name}”?": "Delete routine “{name}”?",
  "This removes the schedule and its run history.":
    "This removes the schedule and its run history.",
  "Edit routine": "Edit routine",
  "Save changes": "Save changes",
  "{summary}: {detail}": "{summary}: {detail}",
  "Routine “{name}” was created": "Routine “{name}” was created",
  "“{name}” started a run": "“{name}” started a run",
  "“{name}” was canceled": "“{name}” was canceled",
  "“{name}” failed": "“{name}” failed",
  "“{name}” finished": "“{name}” finished",
  "Run provider command": "Run provider command",
  "Run provider skill": "Run provider skill",
  "{scope} skill": "{scope} skill",
  "No skills found. Try / to browse provider commands.":
    "No skills found. Try / to browse provider commands.",
  "No matching command.": "No matching command.",
  "Connect a provider to use skills.": "Connect a provider to use skills.",
  "Connect a provider to use its commands.": "Connect a provider to use its commands.",
  "Checking subscription": "Checking subscription",
  "{provider} subscription detected": "{provider} subscription detected",
  "No {provider} subscription connected": "No {provider} subscription connected",
  "Connect {provider} subscription": "Connect {provider} subscription",

  "Nothing open": "Nothing open",
  "Bot failures and memory approvals appear here.":
    "Bot failures and memory approvals appear here.",
  "Could not load the inbox": "Could not load the inbox",
  "Loading inbox": "Loading inbox",
  "Memory approval": "Memory approval",
  "Memory to save": "Memory to save",
  "Could not update memory": "Could not update memory",
  "Fact to save": "Fact to save",
  "Approve edit": "Approve edit",
  "{botName} wants to save this": "{botName} wants to save this",
  "A bot wants to save this": "A bot wants to save this",
  "Sensitive, always needs approval": "Sensitive, always needs approval",
  "Available to {bots}": "Available to {bots}",
  "Save to private memory?": "Save to private memory?",
  "Save to this bot's memory?": "Save to this bot's memory?",
  "Save to project memory?": "Save to project memory?",
  "Save to group memory?": "Save to group memory?",
  "Save to workspace memory?": "Save to workspace memory?",
  "Save to private memory": "Save to private memory",
  "Save to this bot's memory": "Save to this bot's memory",
  "Save to project memory": "Save to project memory",
  "Save to group memory": "Save to group memory",
  "Save to workspace memory": "Save to workspace memory",
  "Connect a provider in Settings > Providers so this bot can reply.":
    "Connect a provider in Settings > Providers so this bot can reply.",
  "Back to chats": "Back to chats",
  "Timestamp format": "Timestamp format",
  Shared: "Shared",
  Separate: "Separate",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
  "{count} min": "{count} min",
  "Background Activity": "Background Activity",
  "Tune the shared power policy and the background intervals that feed it.":
    "Tune the shared power policy and the background intervals that feed it.",
  "Shared policy": "Shared policy",
  "Shared background policy": "Shared background policy",
  "Controls whether background work may run after a subscribed interval fires.":
    "Controls whether background work may run after a subscribed interval fires.",
  "Git fetch interval": "Git fetch interval",
  "Git fetch interval in seconds": "Git fetch interval in seconds",
  "Decrease Git fetch interval": "Decrease Git fetch interval",
  "Increase Git fetch interval": "Increase Git fetch interval",
  "Refresh remote branch status in the background.":
    "Refresh remote branch status in the background.",
  "Provider health interval": "Provider health interval",
  "Provider health interval in seconds": "Provider health interval in seconds",
  "Decrease provider health interval": "Decrease provider health interval",
  "Increase provider health interval": "Increase provider health interval",
  "Refresh provider availability, versions, auth state, and model metadata.":
    "Refresh provider availability, versions, auth state, and model metadata.",
  "Host power monitor": "Host power monitor",
  "Active host power interval in seconds": "Active host power interval in seconds",
  "Decrease active host power interval": "Decrease active host power interval",
  "Increase active host power interval": "Increase active host power interval",
  "Poll host power state while clients are active.":
    "Poll host power state while clients are active.",
  "Idle host monitor": "Idle host monitor",
  "Idle host power interval in seconds": "Idle host power interval in seconds",
  "Decrease idle host power interval": "Decrease idle host power interval",
  "Increase idle host power interval": "Increase idle host power interval",
  "Poll host power state when no foreground client is active.":
    "Poll host power state when no foreground client is active.",
  seconds: "seconds",
  "Pause when host is locked": "Pause when host is locked",
  "Pause on host low power": "Pause on host low power",
  "Pause on client low power": "Pause on client low power",
  "Pause on battery": "Pause on battery",
  "Reset all": "Reset all",
  Additions: "Additions",
  Changes: "Changes",
  Choose: "Choose",
  "Archive exported": "Archive exported",
  "Archive partly restored": "Archive partly restored",
  "Archive restored": "Archive restored",
  "Could not choose project folder": "Could not choose project folder",
  "Could not export archive": "Could not export archive",
  "Could not import archive": "Could not import archive",
  "Could not preview archive": "Could not preview archive",
  "Could not read archive": "Could not read archive",
  "Could not use project folder": "Could not use project folder",
  "{count} restored.": "{count} restored.",
  "{count} skipped.": "{count} skipped.",
  "{count} failed.": "{count} failed.",
  "{count} partly restored.": "{count} partly restored.",
  "Enter an absolute folder path, or open Akeru Bot on desktop.":
    "Enter an absolute folder path, or open Akeru Bot on desktop.",
  "{filename}. Review what Akeru Bot will restore on this environment.":
    "{filename}. Review what Akeru Bot will restore on this environment.",
  "Folder picker unavailable": "Folder picker unavailable",
  "Missing providers": "Missing providers",
  "Not restored": "Not restored",
  "Not restored.": "Not restored.",
  "Partly restored.": "Partly restored.",
  "Not transferred": "Not transferred",
  "Project locations": "Project locations",
  "Choose an existing folder for each project. Akeru Bot links the project to the folder without copying its files.":
    "Choose an existing folder for each project. Akeru Bot links the project to the folder without copying its files.",
  "After restore, sign in to providers and reconnect imported MCP servers on this device.":
    "After restore, sign in to providers and reconnect imported MCP servers on this device.",
  "Restore failures": "Restore failures",
  "Restore preview": "Restore preview",
  "Restoring...": "Restoring...",
  "The command failed.": "The command failed.",
  "The file could not be read.": "The file could not be read.",
  "The folder could not be selected.": "The folder could not be selected.",
  "Settings breadcrumb": "Settings breadcrumb",
  Performance: "Performance",
  "Battery saver": "Battery saver",
  Hold: "Hold",
  "Double press": "Double press",
  Direct: "Direct",
  "Pauses background probes when clients are idle, the host is locked, or low power mode is active.":
    "Pauses background probes when clients are idle, the host is locked, or low power mode is active.",
  "Allows scoped background probes while any subscribed client remains connected.":
    "Allows scoped background probes while any subscribed client remains connected.",
  "Also pauses background probes when the host or client is on battery.":
    "Also pauses background probes when the host or client is on battery.",
  Download: "Download",
  "Up to Date": "Up to Date",
  "Check for Updates": "Check for Updates",
  "Update available.": "Update available.",
  "Current version of the application.": "Current version of the application.",
  "Legacy features": "Legacy features",
  "Brings back the Build/Plan toggle in the composer along with the /plan and /default commands and the Shift+Tab shortcut. While off, every chat runs in build mode.":
    "Brings back the Build/Plan toggle in the composer along with the /plan and /default commands and the Shift+Tab shortcut. While off, every chat runs in build mode.",
  "Paints assistant output token by token instead of in complete chunks. Not recommended: it is significantly slower, and long responses become harder to follow. Kept only for compatibility with the old behavior.":
    "Paints assistant output token by token instead of in complete chunks. Not recommended: it is significantly slower, and long responses become harder to follow. Kept only for compatibility with the old behavior.",
  "Turn on token-by-token output?": "Turn on token-by-token output?",
  "It is significantly slower than the default buffered output and hurts the reading experience. This switch exists only for backwards compatibility.":
    "It is significantly slower than the default buffered output and hurts the reading experience. This switch exists only for backwards compatibility.",
  "Shared uses one sandbox and browser for every bot. Separate gives each bot its own sandbox and browser profile.":
    "Shared uses one sandbox and browser for every bot. Separate gives each bot its own sandbox and browser profile.",
  "sandbox and browser sharing": "sandbox and browser sharing",
  "Change bot workspace mode?": "Change bot workspace mode?",
  "Active bot work keeps its current workspace. The next turn moves each bot into the shared workspace and browser. Files and cookies do not move.":
    "Active bot work keeps its current workspace. The next turn moves each bot into the shared workspace and browser. Files and cookies do not move.",
  "Active bot work keeps its current workspace. The next turn creates a separate workspace and browser for each bot. Shared files and cookies stay in the shared workspace.":
    "Active bot work keeps its current workspace. The next turn creates a separate workspace and browser for each bot. Shared files and cookies stay in the shared workspace.",
  "Change mode": "Change mode",
  "System default follows your browser or OS clock preference.":
    "System default follows your browser or OS clock preference.",
  "time format": "time format",
  "How often the Usage page reloads plan limits.": "How often the Usage page reloads plan limits.",
  "usage refresh": "usage refresh",
  "Set whether the diff panel ignores whitespace-only edits by default.":
    "Set whether the diff panel ignores whitespace-only edits by default.",
  "diff whitespace changes": "diff whitespace changes",
  "Hide whitespace changes by default": "Hide whitespace changes by default",
  "Also include skills in the / command menu. Skills always appear when you type $.":
    "Also include skills in the / command menu. Skills always appear when you type $.",
  "skills in slash menu": "skills in slash menu",
  "Check installed provider CLIs for newer available versions.":
    "Check installed provider CLIs for newer available versions.",
  "provider update checks": "provider update checks",
  "Check provider versions": "Check provider versions",
  "Background activity": "Background activity",
  "This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.":
    "This shared policy gates background work such as Git refreshes and provider health probes after their individual intervals elapse.",
  "Uses custom background intervals with the selected shared power policy. Current shared policy: {profile}.":
    "Uses custom background intervals with the selected shared power policy. Current shared policy: {profile}.",
  "background activity": "background activity",
  "Background activity profile": "Background activity profile",
  "Configure advanced background activity": "Configure advanced background activity",
  "Configure background activity": "Configure background activity",
  "Auto review runs safe actions and asks before sensitive ones.":
    "Auto review runs safe actions and asks before sensitive ones.",
  "local execution": "local execution",
  "Full access": "Full access",
  "Ask first": "Ask first",
  "Auto review": "Auto review",
  "Leave empty to open the Add Project browser in ~/.":
    "Leave empty to open the Add Project browser in ~/.",
  "add project base directory": "add project base directory",
  "Add project base directory": "Add project base directory",
  "Hold mode also quits on two quick presses.": "Hold mode also quits on two quick presses.",
  "quit shortcut behavior": "quit shortcut behavior",
  "Quit shortcut behavior": "Quit shortcut behavior",
  "Used when bot work or source control work does not have its own model.":
    "Used when bot work or source control work does not have its own model.",
  "text generation model": "text generation model",
  "Feedback endpoint": "Feedback endpoint",
  "Use HTTPS or loopback HTTP.": "Use HTTPS or loopback HTTP.",
  "View diagnostics": "View diagnostics",
  "Local trace file": "Local trace file",
  "Terminal logs only": "Terminal logs only",
  "{mode}. Exporting OTEL to {url}.": "{mode}. Exporting OTEL to {url}.",
  "{mode}. Exporting OTEL traces to {tracesUrl} and metrics to {metricsUrl}.":
    "{mode}. Exporting OTEL traces to {tracesUrl} and metrics to {metricsUrl}.",
  "{mode}. Exporting OTEL traces to {url}.": "{mode}. Exporting OTEL traces to {url}.",
  "{mode}. Exporting OTEL metrics to {url}.": "{mode}. Exporting OTEL metrics to {url}.",
  "{mode}.": "{mode}.",
  "Export Akeru settings, project links, and history, or restore them on another environment. Project files and credentials are not included.":
    "Export Akeru settings, project links, and history, or restore them on another environment. Project files and credentials are not included.",
  Import: "Import",
  Export: "Export",
  "Reading...": "Reading...",
  "Exporting...": "Exporting...",
  "Import Akeru archive": "Import Akeru archive",
  "The request stopped before it could finish.": "The request stopped before it could finish.",
  "{provider} is not set up": "{provider} is not set up",
  "The provider is not set up": "The provider is not set up",
  "Add {provider} in Settings > Providers, or pick another model for this bot.":
    "Add {provider} in Settings > Providers, or pick another model for this bot.",
  "Add the provider in Settings > Providers, or pick another model for this bot.":
    "Add the provider in Settings > Providers, or pick another model for this bot.",
  "{provider} is turned off": "{provider} is turned off",
  "The provider is turned off": "The provider is turned off",
  "Turn {provider} on in Settings > Providers, then send your message again.":
    "Turn {provider} on in Settings > Providers, then send your message again.",
  "Turn the provider on in Settings > Providers, then send your message again.":
    "Turn the provider on in Settings > Providers, then send your message again.",
  "{provider} is not installed": "{provider} is not installed",
  "The provider is not installed": "The provider is not installed",
  "Install {provider} from Settings > Providers, or pick another model for this bot.":
    "Install {provider} from Settings > Providers, or pick another model for this bot.",
  "Install the provider from Settings > Providers, or pick another model for this bot.":
    "Install the provider from Settings > Providers, or pick another model for this bot.",
  "{provider} is not connected": "{provider} is not connected",
  "The provider is not connected": "The provider is not connected",
  "Connect your {provider} account in Settings > Providers.":
    "Connect your {provider} account in Settings > Providers.",
  "Connect your provider account in Settings > Providers.":
    "Connect your provider account in Settings > Providers.",
  "{provider} sign-in expired": "{provider} sign-in expired",
  "Reconnect {provider} in Settings > Providers, then send your message again.":
    "Reconnect {provider} in Settings > Providers, then send your message again.",
  "Reconnect the provider in Settings > Providers, then send your message again.":
    "Reconnect the provider in Settings > Providers, then send your message again.",
  "{model} is not available on {provider}": "{model} is not available on {provider}",
  "{model} is not available on the provider": "{model} is not available on the provider",
  "This model is not available on {provider}": "This model is not available on {provider}",
  "This model is not available on the provider": "This model is not available on the provider",
  "Pick another model for this bot.": "Pick another model for this bot.",
  "{provider} limit reached": "{provider} limit reached",
  "Provider limit reached": "Provider limit reached",
  "Your {provider} plan hit its usage or rate limit. Wait for it to reset, then send your message again.":
    "Your {provider} plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
  "Your provider plan hit its usage or rate limit. Wait for it to reset, then send your message again.":
    "Your provider plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
  "Akeru usage cap reached": "Akeru usage cap reached",
  "Raise this bot's usage cap in its settings to keep chatting.":
    "Raise this bot's usage cap in its settings to keep chatting.",
  "{provider} could not respond": "{provider} could not respond",
  "The provider could not respond": "The provider could not respond",
  "Send your message again in a moment.": "Send your message again in a moment.",
  "{title}. {description}": "{title}. {description}",
  "This bot is archived": "This bot is archived",
  "Restore it from the roster to chat with it again.":
    "Restore it from the roster to chat with it again.",
  "Connection interrupted": "Connection interrupted",
  "Check the environment connection, then send your message again.":
    "Check the environment connection, then send your message again.",
  "The bot couldn’t finish that request": "The bot couldn’t finish that request",
  "Try sending it again. If it keeps happening, send feedback with the technical details.":
    "Try sending it again. If it keeps happening, send feedback with the technical details.",
  "{title}.": "{title}.",
  "Automatically read new replies in this chat on this device":
    "Automatically read new replies in this chat on this device",
  "Only new completed replies are read. History is never replayed. Your selected speech service may charge for audio.":
    "Only new completed replies are read. History is never replayed. Your selected speech service may charge for audio.",
  "This preference could not be saved on this device.":
    "This preference could not be saved on this device.",
  "Could not open the sign-in page. Try Open sign-in again.":
    "Could not open the sign-in page. Try Open sign-in again.",
  "API key saved · {baseUrl}": "API key saved · {baseUrl}",
  "API key saved": "API key saved",
  "Disconnect {provider}": "Disconnect {provider}",
  "API billing can be separate from your subscription.":
    "API billing can be separate from your subscription.",
  "Open OpenCode": "Open OpenCode",
  "Paste the API key": "Paste the API key",
  "The provider check failed. Reconnect and try again.":
    "The provider check failed. Reconnect and try again.",
  "Connect a subscription or API key. Credentials stay on this environment.":
    "Connect a subscription or API key. Credentials stay on this environment.",
  "Plus, Pro, Business, Enterprise, or Edu": "Plus, Pro, Business, Enterprise, or Edu",
  "Use your ChatGPT subscription with Codex models.":
    "Use your ChatGPT subscription with Codex models.",
  "Pro or Max": "Pro or Max",
  "Use your Claude subscription with Claude Code models.":
    "Use your Claude subscription with Claude Code models.",
  "Shared xAI login": "Shared xAI login",
  "Connect an xAI login for Grok. Akeru cannot verify SuperGrok or X Premium+.":
    "Connect an xAI login for Grok. Akeru cannot verify SuperGrok or X Premium+.",
  "Kimi For Coding plan": "Kimi For Coding plan",
  "Use Kimi coding models through your Moonshot subscription.":
    "Use Kimi coding models through your Moonshot subscription.",
  "OpenCode Go API key": "OpenCode Go API key",
  "Use OpenCode Go models with an API key from OpenCode.":
    "Use OpenCode Go models with an API key from OpenCode.",
  Missing: "Missing",
  Detected: "Detected",
  Healthy: "Healthy",
  Expired: "Expired",
  Revoked: "Revoked",
  Unsupported: "Unsupported",
  Disabled: "Disabled",
  "First request failed": "First request failed",
  Recovered: "Recovered",
  "Collapse table cells": "Collapse table cells",
  "Expand table cells": "Expand table cells",
  "Copy table": "Copy table",
  "Copy as Markdown": "Copy as Markdown",
  "Copy as CSV": "Copy as CSV",
  Details: "Details",
  "Mermaid diagram": "Mermaid diagram",
  "Rendering diagram…": "Rendering diagram…",
  "Language: {language}": "Language: {language}",
  "Disable line wrap": "Disable line wrap",
  "Wrap lines": "Wrap lines",
  "Code block actions": "Code block actions",
  "Image unavailable · {alt}": "Image unavailable · {alt}",
  "Loading image": "Loading image",
  "Unable to open file": "Unable to open file",
  "Unable to open file in browser": "Unable to open file in browser",
  "Unable to reveal file": "Unable to reveal file",
  "Failed to copy relative path": "Failed to copy relative path",
  "Failed to copy full path": "Failed to copy full path",
  "Clipboard API unavailable.": "Clipboard API unavailable.",
  "Relative path copied": "Relative path copied",
  "Full path copied": "Full path copied",
  "Open in integrated browser": "Open in integrated browser",
  "Copy relative path": "Copy relative path",
  "Copy full path": "Copy full path",
  "File options for {label}": "File options for {label}",
  "Checklist progress": "Checklist progress",
  "{done} of {total} done": "{done} of {total} done",
  "Toggle task": "Toggle task",
  "Unable to link pull request": "Unable to link pull request",
  "Unable to unlink pull request": "Unable to unlink pull request",
  "Copied error": "Copied error",
  "Copy error": "Copy error",
  "Show details": "Show details",
  "Hide details": "Hide details",
  Notifications: "Notifications",
  "Dismiss notification": "Dismiss notification",
  Sidebar: "Sidebar",
  "Displays the mobile sidebar.": "Displays the mobile sidebar.",
  "Toggle Sidebar": "Toggle Sidebar",
  "Resize Sidebar": "Resize Sidebar",
  "Drag to resize sidebar": "Drag to resize sidebar",
  "Open Settings > {destination}": "Open Settings > {destination}",
  "General > Local execution": "General > Local execution",
  "Not connected": "Not connected",
  "OAuth connected": "OAuth connected",
} as const;

export type MessageKey = keyof typeof englishCatalog;

function canonicalLocale(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

function isSimplifiedChinese(locale: string): boolean {
  const lower = locale.toLowerCase();
  if (lower === "zh") return true;
  if (!lower.startsWith("zh-")) return false;
  const rest = lower.slice(3);
  return (
    rest.startsWith("hans") ||
    rest === "cn" ||
    rest.startsWith("cn-") ||
    rest === "sg" ||
    rest.startsWith("sg-")
  );
}

/** Catalog id for a canonical locale, or undefined when the locale is unsupported. */
export function catalogIdForLocale(locale: string): "en" | "zh-CN" | undefined {
  const canonical = canonicalLocale(locale);
  if (!canonical) return undefined;
  const base = canonical.split("-")[0] ?? canonical;
  if (base === "en") return "en";
  if (isSimplifiedChinese(canonical)) return "zh-CN";
  return undefined;
}

export function resolveLocale(
  preference: LanguagePreference,
  deviceLocales: readonly string[] = [],
): string {
  const candidates = preference === "system" ? deviceLocales : [preference];
  for (const candidate of candidates) {
    const locale = canonicalLocale(candidate);
    if (locale && catalogIdForLocale(locale)) return locale;
  }
  return "en";
}

function interpolate(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

function lookup(catalog: TranslationCatalog, message: string): string {
  return Object.hasOwn(catalog, message) ? (catalog[message] ?? message) : message;
}

/** Translate interface copy only; user and provider content must bypass this function. */
export function translate(locale: string, message: string, params?: TranslationParams): string {
  // Synchronous callers stay on English until a loaded catalog is supplied through createTranslator.
  void locale;
  return interpolate(lookup(englishCatalog, message), params);
}

function cachedFormatter<Options extends object, Formatter>(
  create: (locale: string, options?: Options) => Formatter,
) {
  const cache = new Map<string, Formatter>();
  return (locale: string, options?: Options): Formatter => {
    const key = JSON.stringify([locale, options ?? {}]);
    const existing = cache.get(key);
    if (existing) return existing;
    const formatter = create(locale, options);
    if (cache.size >= 32) cache.delete(cache.keys().next().value ?? "");
    cache.set(key, formatter);
    return formatter;
  };
}

const numberFormatter = cachedFormatter(
  (locale: string, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options),
);
const dateFormatter = cachedFormatter(
  (locale: string, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options),
);
const pluralRules = cachedFormatter(
  (locale: string, options?: Intl.PluralRulesOptions) => new Intl.PluralRules(locale, options),
);

export function formatNumber(
  locale: string,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatter(resolveLocale(locale), options).format(value);
}

export function formatDate(
  locale: string,
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return dateFormatter(resolveLocale(locale), options).format(value);
}

function renderPlural(
  locale: string,
  count: number,
  forms: PluralForms,
  params?: TranslationParams,
  catalog: TranslationCatalog = englishCatalog,
): string {
  const category = pluralRules(locale).select(count);
  return interpolate(lookup(catalog, forms[category] ?? forms.other), {
    ...params,
    count: numberFormatter(locale).format(count),
  });
}

export function plural(
  locale: string,
  count: number,
  forms: PluralForms,
  params?: TranslationParams,
): string {
  return renderPlural(resolveLocale(locale), count, forms, params);
}

/** Catalog injection exercises other locales in tests without shipping additional languages. */
export function createTranslator(locale: string, testCatalog?: TranslationCatalog) {
  const resolvedLocale = testCatalog ? (canonicalLocale(locale) ?? "en") : resolveLocale(locale);
  const translateMessage = (message: string, params?: TranslationParams) =>
    interpolate(
      testCatalog && Object.hasOwn(testCatalog, message)
        ? lookup(testCatalog, message)
        : lookup(englishCatalog, message),
      params,
    );
  const catalog = testCatalog ?? englishCatalog;
  return {
    locale: resolvedLocale,
    t: (key: MessageKey, params?: TranslationParams) => translateMessage(key, params),
    translate: translateMessage,
    plural: (count: number, forms: PluralForms, params?: TranslationParams) =>
      renderPlural(resolvedLocale, count, forms, params, catalog),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      numberFormatter(resolvedLocale, options).format(value),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      dateFormatter(resolvedLocale, options).format(value),
  };
}

export type CatalogRegistry = Readonly<Record<string, () => Promise<TranslationCatalog>>>;

export const catalogRegistry: CatalogRegistry = Object.freeze({
  "zh-CN": () => import("./zh-CN.ts").then((mod) => mod.zhCNCatalog),
});

/** Each client owns one loader. Injected registries are for tests. */
export function createCatalogLoader(registry: CatalogRegistry = catalogRegistry) {
  const pending = new Map<string, Promise<TranslationCatalog>>();
  const listeners = new Set<() => void>();
  let selection = 0;
  let snapshot = {
    selectedLocale: "en",
    status: "ready" as "ready" | "loading" | "error",
    translator: createTranslator("en"),
  };

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async selectLocale(preference: LanguagePreference, deviceLocales: readonly string[] = []) {
      const version = ++selection;
      const candidates = preference === "system" ? deviceLocales : [preference];
      let selectedLocale = "en";
      let catalogId: "en" | "zh-CN" | string = "en";
      for (const candidate of candidates) {
        const canonical = canonicalLocale(candidate);
        if (!canonical) continue;
        const resolvedCatalog =
          catalogIdForLocale(canonical) ??
          (Object.hasOwn(registry, canonical)
            ? canonical
            : Object.hasOwn(registry, canonical.split("-")[0] ?? "")
              ? (canonical.split("-")[0] ?? "")
              : undefined);
        if (!resolvedCatalog) continue;
        selectedLocale = canonical;
        catalogId = resolvedCatalog;
        break;
      }
      if (catalogId === "en") {
        snapshot = {
          selectedLocale,
          status: "ready",
          translator: createTranslator(selectedLocale),
        };
        emit();
        return;
      }
      snapshot = { selectedLocale, status: "loading", translator: createTranslator("en") };
      emit();
      try {
        let loading = pending.get(catalogId);
        if (!loading) {
          const load = registry[catalogId];
          loading = Promise.resolve().then(async () => {
            if (!load) throw new Error(`Missing catalog loader: ${catalogId}`);
            const catalog = await load();
            const issues = validateCatalog(catalog);
            if (issues.length > 0) throw new Error(issues.join("\n"));
            return catalog;
          });
          pending.set(catalogId, loading);
        }
        const catalog = await loading;
        if (version === selection) {
          snapshot = {
            selectedLocale,
            status: "ready",
            translator: createTranslator(selectedLocale, catalog),
          };
          emit();
        }
      } catch {
        pending.delete(catalogId);
        if (version === selection) {
          snapshot = { selectedLocale, status: "error", translator: createTranslator("en") };
          emit();
        }
      }
    },
  };
}

function parameters(message: string): string {
  return [...new Set(Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1]))]
    .sort()
    .join(",");
}

/** Validate a complete catalog before making a language available. */
export function validateCatalog(catalog: TranslationCatalog): string[] {
  const issues: string[] = [];
  for (const [key, source] of Object.entries(englishCatalog)) {
    if (!Object.hasOwn(catalog, key)) {
      issues.push(`Missing message: ${key}`);
    } else if (parameters(catalog[key] ?? "") !== parameters(source)) {
      issues.push(`Parameter mismatch: ${key}`);
    }
  }
  for (const key of Object.keys(catalog)) {
    if (!Object.hasOwn(englishCatalog, key)) issues.push(`Unknown message: ${key}`);
  }
  return issues;
}

/** Stable connection failure codes, mirrored from the connection model. */
export type ConnectionFailureMessageCode =
  | "network"
  | "timeout"
  | "transport"
  | "endpoint-unavailable"
  | "remote-unavailable"
  | "authentication"
  | "configuration"
  | "permission"
  | "unsupported";

/** Explanatory copy for a connection failure code. Pass the result to `t`. */
export function connectionFailureMessage(code: ConnectionFailureMessageCode): MessageKey {
  switch (code) {
    case "network":
      return "The environment could not be reached. Check the network connection.";
    case "timeout":
      return "The environment took too long to respond.";
    case "transport":
      return "The connection to the environment was interrupted.";
    case "endpoint-unavailable":
      return "The environment address is not responding.";
    case "remote-unavailable":
      return "The environment is not ready to accept connections.";
    case "authentication":
      return "This device is no longer paired with the environment. Pair it again.";
    case "configuration":
      return "This connection is not set up correctly. Check its address and settings.";
    case "permission":
      return "This device does not have access to the environment.";
    case "unsupported":
      return "This environment runs a version the app does not support.";
  }
}

/**
 * Translated connection status built from the phase and stable failure code.
 * Raw diagnostics stay out of this string; show them separately.
 */
export function translateConnectionStatus(
  translateMessage: (message: MessageKey) => string,
  connection: {
    readonly phase: "available" | "offline" | "connecting" | "reconnecting" | "connected" | "error";
    readonly errorCode?: ConnectionFailureMessageCode | null;
  },
): string {
  const reason = connection.errorCode
    ? translateMessage(connectionFailureMessage(connection.errorCode))
    : null;
  switch (connection.phase) {
    case "available":
      return translateMessage("Available");
    case "offline":
      return translateMessage("Offline");
    case "connecting":
      return translateMessage("Connecting…");
    case "connected":
      return translateMessage("Connected");
    case "reconnecting":
      return reason
        ? `${translateMessage("Could not connect. Reconnecting…")} ${reason}`
        : translateMessage("Reconnecting…");
    case "error":
      return reason
        ? `${translateMessage("Connection failed.")} ${reason}`
        : translateMessage("Connection failed");
  }
}

/** The translated status plus the raw diagnostic, for surfaces with no separate error slot. */
export function translateConnectionStatusWithDiagnostic(
  translateMessage: (message: MessageKey) => string,
  connection: Parameters<typeof translateConnectionStatus>[1] & {
    readonly error?: string | null;
  },
): string {
  const status = translateConnectionStatus(translateMessage, connection);
  const failed = connection.phase === "error" || connection.phase === "reconnecting";
  return failed && connection.error ? `${status} (${connection.error})` : status;
}
