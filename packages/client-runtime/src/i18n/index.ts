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
  "Syncing chats…": "Syncing chats…",
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
  "OpenAI API voice": "OpenAI API voice",
  "Transcription provider": "Transcription provider",
  "Speech provider": "Speech provider",
  "Speech voice": "Speech voice",
  "Voice API connections": "Voice API connections",
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
  "Untitled chat": "Untitled chat",
  "In {environment}": "In {environment}",
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
  "Reconnecting {count} environments…": "Reconnecting {count} environments…",
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
  "No response from {provider}": "No response from {provider}",
  "No response from {provider} for {duration}": "No response from {provider} for {duration}",
  "Working for {duration}": "Working for {duration}",
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
  "Code copied": "Code copied",
  "Couldn't copy the code. Select it and copy it manually.":
    "Couldn't copy the code. Select it and copy it manually.",
  "Checking health…": "Checking health…",
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
  "Loading bots…": "Loading bots…",
  "Could not load bots": "Could not load bots",
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
  "Let it finish": "Let it finish",
  "Let {name} finish the work": "Let {name} finish the work",
  "Ask {name} to try again": "Ask {name} to try again",
  "Change reaction, {emoji} selected": "Change reaction, {emoji} selected",
  "Change this file?": "Change this file?",
  "Choose a reaction": "Choose a reaction",
  "Choose an active group boss in the group sidebar.":
    "Choose an active group boss in the group sidebar.",
  "Close image preview": "Close image preview",
  "Open image": "Open image",
  "Save image": "Save image",
  "Copy image": "Copy image",
  "Image copied": "Image copied",
  "Could not save the image": "Could not save the image",
  "Could not copy the image": "Could not copy the image",
  "Could not reveal the image": "Could not reveal the image",
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
  "Could not let the work finish": "Could not let the work finish",
  "Could not retry the work": "Could not retry the work",
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
  "Result waiting for the next reply": "Result waiting for the next reply",
  "Result delivered to {name}": "Result delivered to {name}",
  "Waiting on delegated work": "Waiting on delegated work",
  "Delegated work": "Delegated work",
  "Delegation to {name}": "Delegation to {name}",
  "{parent} asked {child}": "{parent} asked {child}",
  Scheduled: "Scheduled",
  Retried: "Retried",
  Task: "Task",
  "Expected result": "Expected result",
  "View work": "View work",
  "View {name}'s work": "View {name}'s work",
  "Work by {name}": "Work by {name}",
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
  "No provider is ready for this bot": "No provider is ready for this bot",
  "No provider is ready for this group": "No provider is ready for this group",
  "Set up a provider": "Set up a provider",
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
  Danger: "Danger",
  "Delete bot": "Delete bot",
  "Remove {name} from the roster. Its chats stay in your history.":
    "Remove {name} from the roster. Its chats stay in your history.",
  "Delete {name}? Its chats stay in your history. This cannot be undone.":
    "Delete {name}? Its chats stay in your history. This cannot be undone.",
  "Could not delete {name}": "Could not delete {name}",
  "A group boss cannot be deleted, and every group needs at least two bots.":
    "A group boss cannot be deleted, and every group needs at least two bots.",
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
  "{name} bot sidebar": "{name} bot sidebar",
  "Collapse {name} bot sidebar": "Collapse {name} bot sidebar",
  "Open sidebar ({shortcut})": "Open sidebar ({shortcut})",
  "Open sidebar": "Open sidebar",
  "{name} overview": "{name} overview",
  "Close bot sidebar": "Close bot sidebar",
  "Could not update channel": "Could not update channel",
  "Add a project before connecting a channel.": "Add a project before connecting a channel.",
  "Choose a project": "Choose a project",
  "Choose another project": "Choose another project",
  "The project for this channel is unavailable. Choose another project to reconnect it.":
    "The project for this channel is unavailable. Choose another project to reconnect it.",
  "Could not move channel to this project": "Could not move channel to this project",
  "Project for {name}": "Project for {name}",
  "Reconnect in this project": "Reconnect in this project",
  "Move to this project": "Move to this project",
  "Reconnect in {project}": "Reconnect in {project}",
  "Repair this channel from Settings > Bot channels on the host.":
    "Repair this channel from Settings > Bot channels on the host.",
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
  "Not live": "Not live",
  "Needs attention · {name}": "Needs attention · {name}",
  "WhatsApp needs a public HTTPS address to receive messages. Give this environment a public URL, then reconnect.":
    "WhatsApp needs a public HTTPS address to receive messages. Give this environment a public URL, then reconnect.",
  "Webhook URL": "Webhook URL",
  "Check the channel": "Check the channel",
  "Update credentials": "Update credentials",
  "Another bot already uses this account. Unassign it there, then connect again.":
    "Another bot already uses this account. Unassign it there, then connect again.",
  "the bot": "the bot",
  "Could not update the credentials. The old connection is unchanged.":
    "Could not update the credentials. The old connection is unchanged.",
  "Could not connect with the new credentials or restore the old connection.":
    "Could not connect with the new credentials or restore the old connection.",
  "Could not connect with the new credentials. The old connection is unchanged.":
    "Could not connect with the new credentials. The old connection is unchanged.",
  "The old connection could not be restored.": "The old connection could not be restored.",
  "New credentials connected": "New credentials connected",
  "The old connection could not be removed. Delete it from the channel list.":
    "The old connection could not be removed. Delete it from the channel list.",
  "{name} is saved but could not connect. {reason}":
    "{name} is saved but could not connect. {reason}",
  "{name} is saved but could not connect. Try again or check the connection settings.":
    "{name} is saved but could not connect. Try again or check the connection settings.",
  "Delete {name}? Its saved credentials are removed from this environment.":
    "Delete {name}? Its saved credentials are removed from this environment.",
  "Update {name} credentials": "Update {name} credentials",
  "Telegram rejected the bot token.": "Telegram rejected the bot token.",
  "Slack rejected the bot token or app token.": "Slack rejected the bot token or app token.",
  "Discord rejected the bot token.": "Discord rejected the bot token.",
  "WhatsApp rejected the access token.": "WhatsApp rejected the access token.",
  "Photon rejected the connection credentials.": "Photon rejected the connection credentials.",
  "Could not reach {provider}. Check the network and try again.":
    "Could not reach {provider}. Check the network and try again.",
  "The project for this channel is unavailable. Choose another project.":
    "The project for this channel is unavailable. Choose another project.",
  "A reply may not have reached {provider}. Check the chat before replying again.":
    "A reply may not have reached {provider}. Check the chat before replying again.",
  "{provider} did not reconnect after a restart. Reconnect to resume.":
    "{provider} did not reconnect after a restart. Reconnect to resume.",
  "Anyone who can message this bot can ask it to work in the chosen project with its enabled tools.":
    "Anyone who can message this bot can ask it to work in the chosen project with its enabled tools.",
  "Could not update the credentials, and {name} is now unassigned from this channel. Reconnect to use the new credentials.":
    "Could not update the credentials, and {name} is now unassigned from this channel. Reconnect to use the new credentials.",
  "Save and reconnect": "Save and reconnect",
  "Send a direct iMessage to this line to test a reply.":
    "Send a direct iMessage to this line to test a reply.",
  "Send a direct WhatsApp message to this number.":
    "Send a direct WhatsApp message to this number.",
  "Send a direct Telegram message to this bot.": "Send a direct Telegram message to this bot.",
  "Send a direct message or mention {name} in a Slack channel thread.":
    "Send a direct message or mention {name} in a Slack channel thread.",
  "Send a direct message or mention {name} in a Discord server.":
    "Send a direct message or mention {name} in a Discord server.",
  "No bot": "No bot",
  Disconnected: "Disconnected",
  "Needs attention": "Needs attention",
  "Not set up": "Not set up",
  "Unassign this channel before deleting it": "Unassign this channel before deleting it",
  "Unassign the channel already connected to this bot first":
    "Unassign the channel already connected to this bot first",
  "Could not assign or restore channel": "Could not assign or restore channel",
  "Could not assign channel": "Could not assign channel",
  "Could not disconnect channel": "Could not disconnect channel",
  "Could not reconnect channel": "Could not reconnect channel",
  "{count} connection": "{count} connection",
  "{count} connections": "{count} connections",
  "Add connection": "Add connection",
  "Set up {name}": "Set up {name}",
  "No {name} connections yet.": "No {name} connections yet.",
  "Choose No bot to delete this connection.": "Choose No bot to delete this connection.",
  "Bot that answers": "Bot that answers",
  "Assign {name}": "Assign {name}",
  "Choose a bot": "Choose a bot",
  "{name} (archived)": "{name} (archived)",
  "Disabled for the workspace": "Disabled for the workspace",
  "Disable {name} for this bot": "Disable {name} for this bot",
  "Enable {name} for this bot": "Enable {name} for this bot",
  "Close bot tools": "Close bot tools",
  "Choose which workspace tools this bot can use.":
    "Choose which workspace tools this bot can use.",
  "This bot's provider cannot hand off work.": "This bot's provider cannot hand off work.",
  "It cannot send work to other bots or receive work from them.":
    "It cannot send work to other bots or receive work from them.",
  "Cannot take handed-off work": "Cannot take handed-off work",
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
  "Done by": "Done by",
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
  "None yet. Ask {botName} to create one.": "None yet. Ask {botName} to create one.",
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
  "Unlocks with": "Unlocks with",
  Models: "Models",
  "API access": "API access",
  "Published limits": "Published limits",
  "This environment": "This environment",
  Access: "Access",
  "Next step": "Next step",
  "Access details": "Access details",
  "ChatGPT Plus, Pro, Business, Enterprise, or Edu subscription.":
    "ChatGPT Plus, Pro, Business, Enterprise, or Edu subscription.",
  "Or an OpenAI API key, billed separately by OpenAI.":
    "Or an OpenAI API key, billed separately by OpenAI.",
  "Codex models.": "Codex models.",
  "A ChatGPT subscription does not include OpenAI API access.":
    "A ChatGPT subscription does not include OpenAI API access.",
  "OpenAI limits Codex use per 5-hour window and per week. The allowance depends on your plan.":
    "OpenAI limits Codex use per 5-hour window and per week. The allowance depends on your plan.",
  "Choose Connect and sign in with your ChatGPT account.":
    "Choose Connect and sign in with your ChatGPT account.",
  "Claude Pro or Max subscription.": "Claude Pro or Max subscription.",
  "Or an Anthropic API key, billed separately in the Claude Console.":
    "Or an Anthropic API key, billed separately in the Claude Console.",
  "Claude models.": "Claude models.",
  "A Claude Pro or Max subscription does not include Anthropic API access.":
    "A Claude Pro or Max subscription does not include Anthropic API access.",
  "Anthropic limits Claude use per 5-hour session and per week. Max allows more use than Pro.":
    "Anthropic limits Claude use per 5-hour session and per week. Max allows more use than Pro.",
  "Choose Connect and sign in with your Claude account.":
    "Choose Connect and sign in with your Claude account.",
  "SuperGrok or X Premium+ on your xAI account. Akeru cannot see which plan the account has.":
    "SuperGrok or X Premium+ on your xAI account. Akeru cannot see which plan the account has.",
  "Or an xAI API key, billed separately by xAI.": "Or an xAI API key, billed separately by xAI.",
  "Grok models.": "Grok models.",
  "SuperGrok and X Premium+ do not include xAI API credits.":
    "SuperGrok and X Premium+ do not include xAI API credits.",
  "xAI does not publish Grok limits that Akeru can show.":
    "xAI does not publish Grok limits that Akeru can show.",
  "Choose Connect and sign in with the xAI account that has SuperGrok or X Premium+.":
    "Choose Connect and sign in with the xAI account that has SuperGrok or X Premium+.",
  "Kimi For Coding membership.": "Kimi For Coding membership.",
  "Or a Kimi For Coding API key from the Kimi Code console.":
    "Or a Kimi For Coding API key from the Kimi Code console.",
  "Kimi coding models.": "Kimi coding models.",
  "The membership works only in coding tools. It does not include Moonshot Open Platform API credit.":
    "The membership works only in coding tools. It does not include Moonshot Open Platform API credit.",
  "Kimi sets limits by membership tier and shows them in the Kimi Code console.":
    "Kimi sets limits by membership tier and shows them in the Kimi Code console.",
  "Choose Connect and sign in with your Kimi account.":
    "Choose Connect and sign in with your Kimi account.",
  "OpenCode Go subscription API key.": "OpenCode Go subscription API key.",
  "OpenCode Go models.": "OpenCode Go models.",
  "The key is API access, but only to OpenCode Go models through OpenCode.":
    "The key is API access, but only to OpenCode Go models through OpenCode.",
  "OpenCode Go limits use per 5-hour window, per week, and per month.":
    "OpenCode Go limits use per 5-hour window, per week, and per month.",
  "Choose Connect and paste your OpenCode Go API key.":
    "Choose Connect and paste your OpenCode Go API key.",
  "Checking access": "Checking access",
  Ready: "Ready",
  "Not verified yet": "Not verified yet",
  "Login expired": "Login expired",
  "Access revoked": "Access revoked",
  "Check failed": "Check failed",
  "Wait for the health check to finish.": "Wait for the health check to finish.",
  "No action needed. A provider request succeeded.":
    "No action needed. A provider request succeeded.",
  "Choose Check key to send a health request.": "Choose Check key to send a health request.",
  "Choose Check OAuth to send a health request.": "Choose Check OAuth to send a health request.",
  "Choose Reconnect key and enter a current key.": "Choose Reconnect key and enter a current key.",
  "Choose Reconnect and sign in again.": "Choose Reconnect and sign in again.",
  "Check the key and its billing, then choose Check key.":
    "Check the key and its billing, then choose Check key.",
  "Check that the subscription is active, then choose Reconnect.":
    "Check that the subscription is active, then choose Reconnect.",
  "Missing: no OpenCode Go API key in this environment.":
    "Missing: no OpenCode Go API key in this environment.",
  "Missing: no subscription login or API key in this environment.":
    "Missing: no subscription login or API key in this environment.",
  "API key saved in this environment.": "API key saved in this environment.",
  "Subscription login saved in this environment.": "Subscription login saved in this environment.",
  "{models}, and {count} more.": "{models}, and {count} more.",
  "{models}.": "{models}.",
  "{name} is in control": "{name} is in control",
  "You are in control": "You are in control",
  "Someone else is in control": "Someone else is in control",
  "No one is in control": "No one is in control",
  "Your minute of control ran out, so the computer stopped. Resume it to continue.":
    "Your minute of control ran out, so the computer stopped. Resume it to continue.",
  "Your control ended.": "Your control ended.",
  "The computer stopped.": "The computer stopped.",
  "The computer is no longer available. The bot's work may have ended.":
    "The computer is no longer available. The bot's work may have ended.",
  "The connection dropped, so your control ended and the computer stopped.":
    "The connection dropped, so your control ended and the computer stopped.",
  "Someone else took control first.": "Someone else took control first.",
  "The computer did not accept that. Try again.": "The computer did not accept that. Try again.",
  "{name} works in a local workspace, which has no desktop to watch. Choose a Daytona sandbox in bot settings to give it a computer.":
    "{name} works in a local workspace, which has no desktop to watch. Choose a Daytona sandbox in bot settings to give it a computer.",
  "This bot's sandbox has no graphical desktop. Only Daytona sandboxes provide a computer you can watch and control.":
    "This bot's sandbox has no graphical desktop. Only Daytona sandboxes provide a computer you can watch and control.",
  "Computer control needs a Codex or Kimi For Coding engine. Claude, Grok, and OpenCode bots cannot share a computer yet.":
    "Computer control needs a Codex or Kimi For Coding engine. Claude, Grok, and OpenCode bots cannot share a computer yet.",
  "The computer starts when {name} begins work in its Daytona sandbox. Send it a message, then open the computer again.":
    "The computer starts when {name} begins work in its Daytona sandbox. Send it a message, then open the computer again.",
  "This computer is unavailable right now.": "This computer is unavailable right now.",
  "Connecting to the computer…": "Connecting to the computer…",
  "Reconnecting to the computer…": "Reconnecting to the computer…",
  "The computer is stopped.": "The computer is stopped.",
  "Waiting for the first picture…": "Waiting for the first picture…",
  "Take control": "Take control",
  "Return to {name}": "Return to {name}",
  "Control is unavailable: {reason}": "Control is unavailable: {reason}",
  "{name}'s screen": "{name}'s screen",
  "Click, type, paste, and scroll on the picture. Control lasts up to one minute, then the computer stops.":
    "Click, type, paste, and scroll on the picture. Control lasts up to one minute, then the computer stops.",
  "You see the screen the bot works on. Pictures are streamed while this window is open and are not saved.":
    "You see the screen the bot works on. Pictures are streamed while this window is open and are not saved.",
  "{name}'s computer": "{name}'s computer",
  "Open computer": "Open computer",
  "Open {name}'s computer": "Open {name}'s computer",
  "{name}'s computer is running": "{name}'s computer is running",
  "Open Akeru Bot on a desktop or in a web browser to watch or take control of it.":
    "Open Akeru Bot on a desktop or in a web browser to watch or take control of it.",
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
  "{api} key": "{api} key",
  "Key saved": "Key saved",
  "Key rejected": "Key rejected",
  "The voice provider rejected the API key. Replace the key and test it again.":
    "The voice provider rejected the API key. Replace the key and test it again.",
  "Sandbox > Local execution": "Sandbox > Local execution",
  Keyboard: "Keyboard",
  "Providers > Voice": "Providers > Voice",
  "Privacy & data": "Privacy & data",
  "Advanced > Bot inbox": "Advanced > Bot inbox",
  "About you": "About you",
  "Lasting details this bot has learned about you. It reads them in every chat.":
    "Lasting details this bot has learned about you. It reads them in every chat.",
  "Bot notes": "Bot notes",
  "Notes and working habits this bot keeps for itself across chats.":
    "Notes and working habits this bot keeps for itself across chats.",
  "Group notes": "Group notes",
  "Private notes this bot keeps about the current group chat.":
    "Private notes this bot keeps about the current group chat.",
  "{used} of {limit} characters used": "{used} of {limit} characters used",
  "Nothing saved yet. Add a note in plain text or Markdown.":
    "Nothing saved yet. Add a note in plain text or Markdown.",
  "What this bot remembers between chats. Edit anything that is wrong or out of date.":
    "What this bot remembers between chats. Edit anything that is wrong or out of date.",
  "No memory yet": "No memory yet",
  "Start a chat with this bot to see and edit what it remembers.":
    "Start a chat with this bot to see and edit what it remembers.",
  "Chat summary": "Chat summary",
  "Notes the bot writes on its own as this chat grows, so it can recall earlier parts of a long conversation. They only apply to this chat.":
    "Notes the bot writes on its own as this chat grows, so it can recall earlier parts of a long conversation. They only apply to this chat.",
  "Could not clear the chat summary": "Could not clear the chat summary",
  "Confirm clear": "Confirm clear",
  "Clear summary": "Clear summary",
  "Condensed {count} time to stay short.": "Condensed {count} time to stay short.",
  "Condensed {count} times to stay short.": "Condensed {count} times to stay short.",
  "Earlier summaries ({count})": "Earlier summaries ({count})",
  "Nothing yet. The bot starts a summary once the chat gets long.":
    "Nothing yet. The bot starts a summary once the chat gets long.",
  "Needs setup": "Needs setup",
  Error: "Error",
  "Manage plugins": "Manage plugins",
  "No tools yet": "No tools yet",
  "Turn off {name} for this bot": "Turn off {name} for this bot",
  "Turn on {name} for this bot": "Turn on {name} for this bot",
  "This bot's provider cannot hand off work. It cannot send work to other bots or receive work from them.":
    "This bot's provider cannot hand off work. It cannot send work to other bots or receive work from them.",
  "Add a plugin or an MCP server in Plugins. It shows up here, and you can turn it on or off for this bot.":
    "Add a plugin or an MCP server in Plugins. It shows up here, and you can turn it on or off for this bot.",
  "Give your teammate an identity. You can set its model and instructions next.":
    "Give your teammate an identity. You can set its model and instructions next.",
  Preview: "Preview",
  "Name your bot": "Name your bot",
  "Choose the bots in this group and which one leads.":
    "Choose the bots in this group and which one leads.",
  "No provider ready": "No provider ready",
  "{name} (default)": "{name} (default)",
  "The environment rejected the change.": "The environment rejected the change.",
  "Set up how this bot works with you.": "Set up how this bot works with you.",
  "Bot settings sections": "Bot settings sections",
  Behavior: "Behavior",
  "Model & usage": "Model & usage",
  "Download failed.": "Download failed.",
  "Update confirmation failed.": "Update confirmation failed.",
  "Install failed.": "Install failed.",
  "Automatic updates are not available in this build.":
    "Automatic updates are not available in this build.",
  "Update check failed.": "Update check failed.",
  Preferences: "Preferences",
  "How often the {link} reloads plan limits.": "How often the {link} reloads plan limits.",
  "usage page": "usage page",
  "Hosted browser sessions run in this environment and can be controlled from web, desktop, or remote clients.":
    "Hosted browser sessions run in this environment and can be controlled from web, desktop, or remote clients.",
  Enabled: "Enabled",
  Configured: "Configured",
  "API key required": "API key required",
  "Enable Browserbase": "Enable Browserbase",
  "Stored by the environment server. Add a key before enabling Browserbase.":
    "Stored by the environment server. Add a key before enabling Browserbase.",
  "Browserbase API key": "Browserbase API key",
  "Stored key - enter a new key to replace": "Stored key - enter a new key to replace",
  "Agent browser access": "Agent browser access",
  "Allow bots to use the in-app browser for research, previews, and interactive web tasks.":
    "Allow bots to use the in-app browser for research, previews, and interactive web tasks.",
  Allowed: "Allowed",
  "Allow agent browser access": "Allow agent browser access",
  "How browser use works": "How browser use works",
  "Bots can open pages and inspect them in a sandboxed preview. Browserbase is only needed for hosted sessions.":
    "Bots can open pages and inspect them in a sandboxed preview. Browserbase is only needed for hosted sessions.",
  "Read public pages and gather context.": "Read public pages and gather context.",
  "Inspect the app while you work together.": "Inspect the app while you work together.",
  "Hosted sessions": "Hosted sessions",
  "Use Browserbase when a remote browser is needed.":
    "Use Browserbase when a remote browser is needed.",
  "Data sharing": "Data sharing",
  "Share anonymous usage counts and app details. Prompts, files, and provider account IDs are excluded.":
    "Share anonymous usage counts and app details. Prompts, files, and provider account IDs are excluded.",
  "anonymous analytics": "anonymous analytics",
  "Send anonymous analytics": "Send anonymous analytics",
  "Allow feedback you submit to reach the Akeru feedback service. Submissions may be kept for up to 90 days.":
    "Allow feedback you submit to reach the Akeru feedback service. Submissions may be kept for up to 90 days.",
  "Enable product feedback": "Enable product feedback",
  "Allow calls through ChatGPT Realtime. Microphone audio and call data leave this environment during a call.":
    "Allow calls through ChatGPT Realtime. Microphone audio and call data leave this environment during a call.",
  "Enable voice calls": "Enable voice calls",
  "Backup and transfer": "Backup and transfer",
  "Other connections": "Other connections",
  "Desktop updates": "Desktop updates",
  "Signed desktop builds contact the configured release host to check for and download updates.":
    "Signed desktop builds contact the configured release host to check for and download updates.",
  Policies: "Policies",
  "Read the terms and privacy policy": "Read the terms and privacy policy",
  "Unknown condition: {name}": "Unknown condition: {name}",
  "Unknown conditions: {names}": "Unknown conditions: {names}",
  "Akeru Bot does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.":
    "Akeru Bot does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.",
  "Same keys as {labels}.": "Same keys as {labels}.",
  "Same keys as {labels}, and more.": "Same keys as {labels}, and more.",
  "Conflict. {description}": "Conflict. {description}",
  "{description} Only the one defined last will run.":
    "{description} Only the one defined last will run.",
  "Only the one defined last will run.": "Only the one defined last will run.",
  "Negate {name}": "Negate {name}",
  Not: "Not",
  "Remove condition": "Remove condition",
  "Negate group": "Negate group",
  "Remove negated group": "Remove negated group",
  Condition: "Condition",
  "Remove group": "Remove group",
  When: "When",
  Always: "Always",
  "When expression": "When expression",
  "Fix the expression above to continue editing visually.":
    "Fix the expression above to continue editing visually.",
  "Record shortcut for {command}": "Record shortcut for {command}",
  "Press keys…": "Press keys…",
  "Press the new key combination with at least one modifier. Escape cancels.":
    "Press the new key combination with at least one modifier. Escape cancels.",
  "Change shortcut for {command}, currently {keys}":
    "Change shortcut for {command}, currently {keys}",
  "Record shortcut": "Record shortcut",
  "Edit condition for {command}: {condition}": "Edit condition for {command}: {condition}",
  "Add condition for {command}": "Add condition for {command}",
  "Unknown condition": "Unknown condition",
  Custom: "Custom",
  "Discard changes to {command}": "Discard changes to {command}",
  "Discard changes": "Discard changes",
  "More actions for {command}": "More actions for {command}",
  "Remove shortcut": "Remove shortcut",
  "{count} custom": "{count} custom",
  "{count} shortcuts": "{count} shortcuts",
  "new shortcut": "new shortcut",
  "New shortcut": "New shortcut",
  "Choose a command": "Choose a command",
  Add: "Add",
  All: "All",
  Customized: "Customized",
  "No shortcuts match “{query}”.": "No shortcuts match “{query}”.",
  "You haven't changed any shortcuts yet.": "You haven't changed any shortcuts yet.",
  "No shortcuts share keys. Nothing to fix.": "No shortcuts share keys. Nothing to fix.",
  "No shortcuts yet.": "No shortcuts yet.",
  "The keybindings file was not opened.": "The keybindings file was not opened.",
  "Unable to save keybinding": "Unable to save keybinding",
  "The keybinding was not saved.": "The keybinding was not saved.",
  "Unable to remove keybinding": "Unable to remove keybinding",
  "The keybinding was not removed.": "The keybinding was not removed.",
  "Add shortcut": "Add shortcut",
  "Search commands or keys": "Search commands or keys",
  "Search shortcuts": "Search shortcuts",
  "Show shortcuts": "Show shortcuts",
  "{count} shortcut shares its keys with another command.":
    "{count} shortcut shares its keys with another command.",
  "{count} shortcuts share their keys with another command.":
    "{count} shortcuts share their keys with another command.",
  Review: "Review",
  "Your browser can claim some shortcuts before Akeru Bot sees them. The desktop app receives all of them.":
    "Your browser can claim some shortcuts before Akeru Bot sees them. The desktop app receives all of them.",
  "Show all shortcuts": "Show all shortcuts",
  "Restore default settings?": "Restore default settings?",
  "This will reset: {settings}.": "This will reset: {settings}.",
  "Couldn’t restore theme settings": "Couldn’t restore theme settings",
  "Try again.": "Try again.",
  Display: "Display",
  "Adjust the contrast of colors and borders across the interface.":
    "Adjust the contrast of colors and borders across the interface.",
  contrast: "contrast",
  "Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid.":
    "Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid.",
  "glass opacity": "glass opacity",
  "Choose how Dev environments are identified.": "Choose how Dev environments are identified.",
  "environment identification": "environment identification",
  "System monospace": "System monospace",
  "Everything outside code blocks and the terminal.":
    "Everything outside code blocks and the terminal.",
  "Interface font size": "Interface font size",
  "Only the box you write prompts in. Mono works well here.":
    "Only the box you write prompts in. Mono works well here.",
  "Prompt font size": "Prompt font size",
  "Code blocks, diffs, and file previews.": "Code blocks, diffs, and file previews.",
  "Code font size": "Code font size",
  "Terminal output, independent from code blocks and diffs.":
    "Terminal output, independent from code blocks and diffs.",
  "Terminal font size": "Terminal font size",
  "Render text with thinner grayscale anti-aliasing instead of macOS's heavier default.":
    "Render text with thinner grayscale anti-aliasing instead of macOS's heavier default.",
  "font smoothing": "font smoothing",
  "Wrap long lines in code blocks, tables, diffs, and file previews by default.":
    "Wrap long lines in code blocks, tables, diffs, and file previews by default.",
  "word wrapping": "word wrapping",
  "Wrap code, tables, diffs, and file previews by default":
    "Wrap code, tables, diffs, and file previews by default",
  "Monospace font": "Monospace font",
  "Code blocks, diffs, file previews, and the terminal.":
    "Code blocks, diffs, file previews, and the terminal.",
  Typography: "Typography",
  "Show advanced typography settings": "Show advanced typography settings",
  "{title} family": "{title} family",
  "Writes chat titles and other short background text.":
    "Writes chat titles and other short background text.",
  "Background work": "Background work",
  "background work": "background work",
  "Background work profile": "Background work profile",
  Troubleshooting: "Troubleshooting",
  "Inspect logs, resource use, and tracing for this environment.":
    "Inspect logs, resource use, and tracing for this environment.",
  "Where submitted product feedback is sent. Use HTTPS or loopback HTTP.":
    "Where submitted product feedback is sent. Use HTTPS or loopback HTTP.",
  "Connect to an environment first.": "Connect to an environment first.",
  "The server rejected these sandbox settings.": "The server rejected these sandbox settings.",
  "Bots without an override use this sandbox.": "Bots without an override use this sandbox.",
  "Akeru pauses remote sandboxes when bots are idle.":
    "Akeru pauses remote sandboxes when bots are idle.",
  "Auto-idle": "Auto-idle",
  "Sandbox providers": "Sandbox providers",
  "Run bots on the environment computer. Always available; no credentials needed.":
    "Run bots on the environment computer. Always available; no credentials needed.",
  "Connect {name}": "Connect {name}",
  "Disconnect {name}": "Disconnect {name}",
  "Connect sandbox": "Connect sandbox",
  "The server stores these credentials in its secret store.":
    "The server stores these credentials in its secret store.",
  "Leave blank to keep the saved value": "Leave blank to keep the saved value",
  Account: "Account",
  "Connect to an environment to set up {provider}.":
    "Connect to an environment to set up {provider}.",
  "Connect to an environment to set up providers.":
    "Connect to an environment to set up providers.",
  "Could not load account status.": "Could not load account status.",
  "Could not update {provider}": "Could not update {provider}",
  "The provider update command could not be started.":
    "The provider update command could not be started.",
  Instances: "Instances",
  "Refresh {provider} status": "Refresh {provider} status",
  Refresh: "Refresh",
  "Add instance": "Add instance",
  "This environment has no {provider} runtime. Update the environment server to configure it here.":
    "This environment has no {provider} runtime. Update the environment server to configure it here.",
  "{provider} provider settings": "{provider} provider settings",
  "this environment": "this environment",
  Artwork: "Artwork",
  "Version pill": "Version pill",
  Theme: "Theme",
  "Follow system": "Follow system",
  "Theme mix": "Theme mix",
  "Visible chats": "Visible chats",
  "Diff whitespace changes": "Diff whitespace changes",
  "Stream token by token": "Stream token by token",
  "Text generation model": "Text generation model",
  "Browser viewport": "Browser viewport",
  "Browser zoom": "Browser zoom",
  "Browser appearance": "Browser appearance",
  "Cloud workspaces managed by E2B. Requires an API key.":
    "Cloud workspaces managed by E2B. Requires an API key.",
  "Cloud workspaces managed by Daytona. Requires an API key.":
    "Cloud workspaces managed by Daytona. Requires an API key.",
  "Cloud workspaces in your Vercel team and project.":
    "Cloud workspaces in your Vercel team and project.",
  "Cloud workspaces managed by Upstash Box. Requires an API key.":
    "Cloud workspaces managed by Upstash Box. Requires an API key.",
  Token: "Token",
  "Team ID": "Team ID",
  "Project ID": "Project ID",
  Checking: "Checking",
  "Not installed": "Not installed",
  Main: "Main",
  "Switch to dark mode": "Switch to dark mode",
  "Switch to light mode": "Switch to light mode",
  "No routines yet. Ask a bot to do something on a schedule.":
    "No routines yet. Ask a bot to do something on a schedule.",
  "Next {time}": "Next {time}",
  "Don't create": "Don't create",
  "Switch to Auto Review. Safe actions run, sensitive ones still ask.":
    "Switch to Auto Review. Safe actions run, sensitive ones still ask.",
  "Runs as root": "Runs as root",
  "Deletes files": "Deletes files",
  "Network access": "Network access",
  Publishes: "Publishes",
  "Writes files": "Writes files",
  "Changes permissions": "Changes permissions",
  "Every day at {time}": "Every day at {time}",
  "Weekdays at {time}": "Weekdays at {time}",
  "Every {days} at {time}": "Every {days} at {time}",
  "Uses {list}": "Uses {list}",
  "The routine details did not come through. Read the bot's last message before creating it.":
    "The routine details did not come through. Read the bot's last message before creating it.",
  "No models match “{query}”.": "No models match “{query}”.",
  "No favorite models yet. Star a model to add it here.":
    "No favorite models yet. Star a model to add it here.",
  "Loading models…": "Loading models…",
  "No models available for this provider.": "No models available for this provider.",
  "No models available. Check your provider connection in Settings.":
    "No models available. Check your provider connection in Settings.",
  "Search models": "Search models",
  "Jump to original message from {name}": "Jump to original message from {name}",
  "Show less": "Show less",
  "Show full message": "Show full message",
  "Chat with your bots and start new work": "Chat with your bots and start new work",
  "Run terminals and commands on this machine": "Run terminals and commands on this machine",
  "Pairing this browser": "Pairing this browser",
  "Checking your pairing link.": "Checking your pairing link.",
  "Pair this browser": "Pair this browser",
  "Connecting to the environment.": "Connecting to the environment.",
  "This link no longer works": "This link no longer works",
  "Pairing links work once and expire after a while. Get a new link and open it on this device.":
    "Pairing links work once and expire after a while. Get a new link and open it on this device.",
  "This link is incomplete": "This link is incomplete",
  "It is missing the server address or the token. Copy the whole link and open it again.":
    "It is missing the server address or the token. Copy the whole link and open it again.",
  Paired: "Paired",
  "If the server accepted this one-time token, get a new pairing link before trying again.":
    "If the server accepted this one-time token, get a new pairing link before trying again.",
  "This browser can now use {name}.": "This browser can now use {name}.",
  "This browser can now use the environment.": "This browser can now use the environment.",
  "Paste the pairing token from your link to connect.":
    "Paste the pairing token from your link to connect.",
  "Treat pairing links like passwords. You can remove this browser later in {location}.":
    "Treat pairing links like passwords. You can remove this browser later in {location}.",
  "On the server, run {command}": "On the server, run {command}",
  "Settings > Connections": "Settings > Connections",
  Address: "Address",
  "Pairing lets this browser": "Pairing lets this browser",
  "Get a new link": "Get a new link",
  "Or, on a paired device, open Settings > Connections and select Create link.":
    "Or, on a paired device, open Settings > Connections and select Create link.",
  "New pairing token": "New pairing token",
  "Paste a token": "Paste a token",
  Pairing: "Pairing",
  "Reload page": "Reload page",
  "Authentication failed.": "Authentication failed.",
  "Paste the pairing credential from the desktop app to connect.":
    "Paste the pairing credential from the desktop app to connect.",
  "This environment accepts desktop pairing and one-time pairing tokens.":
    "This environment accepts desktop pairing and one-time pairing tokens.",
  "The desktop app manages this environment. Open it there, or paste a credential it issued.":
    "The desktop app manages this environment. Open it there, or paste a credential it issued.",
  Featured: "Featured",
  Installed: "Installed",
  "Search results": "Search results",
  Work: "Work",
  Web: "Web",
  Marketing: "Marketing",
  Design: "Design",
  Sales: "Sales",
  Support: "Support",
  Commerce: "Commerce",
  "Add key": "Add key",
  Disable: "Disable",
  "Approval pending": "Approval pending",
  "Verification pending": "Verification pending",
  "No sign-in": "No sign-in",
  "via {name}": "via {name}",
  "No plugins connected yet": "No plugins connected yet",
  "No plugins match": "No plugins match",
  "Connect one from All and it shows up here.": "Connect one from All and it shows up here.",
  "Try another name or clear the filter.": "Try another name or clear the filter.",
  "From Composio": "From Composio",
  "via Composio": "via Composio",
  "Waiting for sign-in": "Waiting for sign-in",
  "Sign-in failed": "Sign-in failed",
  Inactive: "Inactive",
  "No accounts connected yet. Search above to find an app, then connect it.":
    "No accounts connected yet. Search above to find an app, then connect it.",
  "Composio accounts": "Composio accounts",
  "Could not save the Composio key": "Could not save the Composio key",
  "Remove the Composio API key from this environment? Bots lose access to Composio apps until you add a key again.":
    "Remove the Composio API key from this environment? Bots lose access to Composio apps until you add a key again.",
  "Could not remove the Composio key": "Could not remove the Composio key",
  "Composio returned a sign-in link that does not use HTTPS.":
    "Composio returned a sign-in link that does not use HTTPS.",
  "Could not open {name} sign-in": "Could not open {name} sign-in",
  "Disconnect {name}? Bots stop using this account.":
    "Disconnect {name}? Bots stop using this account.",
  "Could not disconnect {name}": "Could not disconnect {name}",
  "Could not open Composio": "Could not open Composio",
  "No key": "No key",
  "Search above to find Composio apps. Composio handles each app's sign-in, and your bots can use connected accounts.":
    "Search above to find Composio apps. Composio handles each app's sign-in, and your bots can use connected accounts.",
  "Add your own Composio API key to connect apps such as Slack or Notion. Composio handles each app's sign-in.":
    "Add your own Composio API key to connect apps such as Slack or Notion. Composio handles each app's sign-in.",
  "Get a Composio API key": "Get a Composio API key",
  "Could not reach Composio: {error}": "Could not reach Composio: {error}",
  "Composio API key": "Composio API key",
  "Paste a new key to replace it": "Paste a new key to replace it",
  "Save key": "Save key",
  "Remove key": "Remove key",
  "The key is stored only on this Akeru Bot server.":
    "The key is stored only on this Akeru Bot server.",
  "Could not search Composio: {error}": "Could not search Composio: {error}",
  "Removed plugins": "Removed plugins",
  "No longer in the directory · {status}": "No longer in the directory · {status}",
  "Custom MCP servers": "Custom MCP servers",
  "Add server": "Add server",
  "Add a local command or remote URL to use your own MCP server.":
    "Add a local command or remote URL to use your own MCP server.",
  "Delete {name}": "Delete {name}",
  "Disable {name}": "Disable {name}",
  "Enable {name}": "Enable {name}",
  Added: "Added",
  "{count} tool": "{count} tool",
  "{count} tools": "{count} tools",
  "Search plugins": "Search plugins",
  "Plugin sections and categories": "Plugin sections and categories",
  "Plugin category": "Plugin category",
  "All categories": "All categories",
  "{name} is not available yet": "{name} is not available yet",
  "{name} connected with a session issue": "{name} connected with a session issue",
  "{failures} Restart the affected bot session to retry.":
    "{failures} Restart the affected bot session to retry.",
  "Name is required.": "Name is required.",
  "Command is required.": "Command is required.",
  "URL must start with http:// or https://.": "URL must start with http:// or https://.",
  "Store credentials outside the server URL.": "Store credentials outside the server URL.",
  "Enter a valid HTTP or HTTPS URL.": "Enter a valid HTTP or HTTPS URL.",
  "Connect a listed integration, or follow a setup guide from integrations.sh.":
    "Connect a listed integration, or follow a setup guide from integrations.sh.",
  "Could not disable {name}": "Could not disable {name}",
  "Could not enable {name}": "Could not enable {name}",
  "Could not update {name}": "Could not update {name}",
  "Could not connect {name}": "Could not connect {name}",
  "Could not enable MCP server": "Could not enable MCP server",
  "Could not disable MCP server": "Could not disable MCP server",
  "Could not update MCP server": "Could not update MCP server",
  "Could not add MCP server": "Could not add MCP server",
  "Could not open skill": "Could not open skill",
  "Remove '{name}'?": "Remove '{name}'?",
  "Could not remove MCP server": "Could not remove MCP server",
  "Could not open integration guide": "Could not open integration guide",
  "Could not open source": "Could not open source",
  "Find an integration": "Find an integration",
  "Browse integrations.sh for MCP endpoints and setup instructions. Add the server here once you have its URL or command.":
    "Browse integrations.sh for MCP endpoints and setup instructions. Add the server here once you have its URL or command.",
  "Add MCP server": "Add MCP server",
  "Browse integrations.sh": "Browse integrations.sh",
  "Edit MCP server": "Edit MCP server",
  Transport: "Transport",
  "MCP transport": "MCP transport",
  "Local command": "Local command",
  "Remote URL": "Remote URL",
  "Arguments, one per line": "Arguments, one per line",
  "Connect an environment to manage plugins.": "Connect an environment to manage plugins.",
  "Command palette": "Command palette",
  "Toggle theme editor": "Toggle theme editor",
  "Open plugins": "Open plugins",
  "Open usage": "Open usage",
  "Unable to run command": "Unable to run command",
  "An unexpected error occurred.": "An unexpected error occurred.",
  Select: "Select",
  "Search commands and chats...": "Search commands and chats...",
  "Remote health": "Remote health",
  "Health checks for this environment": "Health checks for this environment",
  "Refresh remote health": "Refresh remote health",
  "Filter chats": "Filter chats",
  "Copy message": "Copy message",
  "Change avatar": "Change avatar",
  "Let people reach {name} from messaging apps like Slack or Telegram.":
    "Let people reach {name} from messaging apps like Slack or Telegram.",
  "No environment connected": "No environment connected",
  "Connect to an Akeru Bot environment to set up channels.":
    "Connect to an Akeru Bot environment to set up channels.",
  "Channels are managed on the host": "Channels are managed on the host",
  "This device can chat with {name} but can't change its channels. Open Akeru Bot on the computer that runs it to connect a channel.":
    "This device can chat with {name} but can't change its channels. Open Akeru Bot on the computer that runs it to connect a channel.",
  "No channels set up yet": "No channels set up yet",
  "Add a Slack, Telegram, Discord, WhatsApp, or iMessage connection first. Then assign it to this bot here.":
    "Add a Slack, Telegram, Discord, WhatsApp, or iMessage connection first. Then assign it to this bot here.",
  Backup: "Backup",
  "Your workspace is still loading. Try again in a moment.":
    "Your workspace is still loading. Try again in a moment.",
  "Remove the saved credentials from this environment.":
    "Remove the saved credentials from this environment.",
  "{count} more": "{count} more",
  "{names} uses this account.": "{names} uses this account.",
  "{names} use this account.": "{names} use this account.",
  "Connected account": "Connected account",
  "API key saved on this environment": "API key saved on this environment",
  "Account identity unavailable": "Account identity unavailable",
  Subscription: "Subscription",
  Check: "Check",
  "Saved · {baseUrl}": "Saved · {baseUrl}",
  "Pay per request instead of using the subscription.":
    "Pay per request instead of using the subscription.",
  "Replace key": "Replace key",
  "Copy this code, then open the sign-in page and enter it.":
    "Copy this code, then open the sign-in page and enter it.",
  "Finish signing in to {provider} in the browser.":
    "Finish signing in to {provider} in the browser.",
  "Open sign-in page": "Open sign-in page",
  "Connect to an environment to manage this account.":
    "Connect to an environment to manage this account.",
  "Replace API key": "Replace API key",
  "Add API key": "Add API key",
  "Checking account": "Checking account",
  "Instance account": "Instance account",
  "In 1 hour": "In 1 hour",
  "In 3 hours": "In 3 hours",
  "This evening": "This evening",
  Tomorrow: "Tomorrow",
  "Next week": "Next week",
  "Chat actions": "Chat actions",
  "Rename chat": "Rename chat",
  "Chat title": "Chat title",
  "Could not rename chat": "Could not rename chat",
  "Regenerate title": "Regenerate title",
  "Regenerating…": "Regenerating…",
  "Pin chat": "Pin chat",
  "Unpin chat": "Unpin chat",
  "Mark unread": "Mark unread",
  Unread: "Unread",
  "Settle chat": "Settle chat",
  "Un-settle chat": "Un-settle chat",
  Snooze: "Snooze",
  "Snoozed until {time}": "Snoozed until {time}",
  "Wake chat": "Wake chat",
  "Snooze chat: {when}": "Snooze chat: {when}",
  "Archive chat": "Archive chat",
  "Delete chat": "Delete chat",
  "Delete this chat? This permanently clears the conversation history.":
    "Delete this chat? This permanently clears the conversation history.",
  "No environment": "No environment",
  "Connect to an environment to see its archived chats.":
    "Connect to an environment to see its archived chats.",
  "Could not load archived chats": "Could not load archived chats",
  "Check the connection to this environment, then reopen this page.":
    "Check the connection to this environment, then reopen this page.",
  "Deleted group": "Deleted group",
  "Removed bot": "Removed bot",
  "Other chats": "Other chats",
  "Archived {time}": "Archived {time}",
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
