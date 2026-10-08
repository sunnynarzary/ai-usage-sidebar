# AI Usage Sidebar

AI Usage Sidebar shows Claude Code, Codex, and Cursor usage in a VS Code or Cursor sidebar. Each tool starts disabled. Open the **AI Usage** view and select **Enable** for the tool you want, or use **AI Usage: Manage tools**. Consent is stored locally in the editor's global extension state, separately for Cursor IDE and cursor-agent. Changing Cursor sources asks for consent again before reading the newly selected source. Manage tools can revoke consent. Setting a card to **never** also revokes consent and stops its reads; **always** changes visibility only and never grants consent. All extension settings have application scope.

Card visibility can be **auto** (default), **always**, or **never**. Auto hides a card only when a local login is positively absent. On a fresh install, each tool shows a compact enable row. Refresh runs only for enabled tools while the view is open.

## Local data and vendor requests

- **Claude Code:** On macOS, reads the `Claude Code-credentials` Keychain item and the `$CLAUDE_CONFIG_DIR/.credentials.json` and `~/.claude/.credentials.json` files when present, choosing the usable login with the later expiry. On Windows and Linux, reads the configured file, then the default file. Sends the access token only to `GET https://api.anthropic.com/api/oauth/usage`. The extension does not refresh or alter the login. If expired, open Claude Code to refresh it. A custom `CLAUDE_CONFIG_DIR` can cause Claude Code to use a suffixed macOS Keychain service; this extension does not guess that name, but checks the configured file. GUI-launched editors may not inherit `CLAUDE_CONFIG_DIR` from a shell.
- **Codex:** Starts the installed local Codex CLI and asks its app server for `account/rateLimits/read`, then stops the process tree. The CLI manages its own login and network activity. The extension does not read the Codex credential directly.
- **Cursor IDE (default):** Reads `cursorAuth/accessToken` from Cursor's `User/globalStorage/state.vscdb` database, at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` on macOS or `%APPDATA%\Cursor\User\globalStorage\state.vscdb` on Windows. Sends the token to `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` and `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo`. The read is read-only and WAL-aware when the editor supports `node:sqlite`; otherwise a main-file-only fallback refuses a nonempty WAL to avoid stale login data.
- **Cursor (cursor-agent login):** A separate setting and consent. On macOS, reads the `cursor-access-token` Keychain item and sends it to `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` and `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo`. Its Windows credential location is unknown, so this source reports **unavailable** on Windows. The extension never silently switches between the IDE and cursor-agent accounts.

Claude and Cursor credentials go to the vendors that issued them, through the fixed HTTPS requests above; the extension sends nothing to its publisher or another third party. No credential is copied to another file, refreshed, or logged by the extension. These usage endpoints and the Cursor database key are undocumented. They may change, and accessing them may carry account or terms risk. This extension is not affiliated with Anthropic, OpenAI, or Cursor.

## Install and development

The extension runs in the local UI extension host, including when a workspace is remote. Run `npm install`, `npm test`, then `npm run package` to make a VSIX. The 128px icon is original geometric bar artwork created for this project; `media/usage.svg` is the existing project activity icon.

## License

MIT. See [LICENSE](LICENSE).
