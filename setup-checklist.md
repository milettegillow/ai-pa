# Setup Checklist

Complete these steps before your first session.

- [ ] **Install Claude Code** — follow [the docs](https://docs.anthropic.com/en/docs/claude-code) if you haven't already
- [ ] **Install Node.js 18+** — needed to run the MCP server
- [ ] **Authenticate with Microsoft** — run `npx -y @softeria/ms-365-mcp-server --login` and follow the device code flow in your browser. Sign in with your Microsoft 365 account. For work/school accounts, add `"--org-mode"` to the args in `.mcp.json`. If it fails, check with your IT admin about app consent policies.
- [ ] **Set your Zoom link** — open `SYSTEM_PROMPT.md` and replace `[ZOOM_PERSONAL_ROOM_LINK]` with your actual Zoom personal room URL
- [ ] **Install dependencies** — run `npm install` from the project root
- [ ] **Launch the dashboard** — run `npm start` and open http://localhost:3000
- [ ] **Test it** — hit the "Morning Briefing" button or try "What's on my calendar today?" in the chat

## Troubleshooting

**Auth fails or hangs:** Your org may require admin consent for the Microsoft Graph MCP app. Ask your IT admin to approve it in the Azure AD app registrations, or try with a personal Microsoft account first.

**MCP server not found:** Make sure `npx` is on your PATH. Run `npx -y @softeria/ms-365-mcp-server --help` to verify it's reachable.

**Token expired:** The cached token should refresh automatically. If it stops working, delete the cached credentials (check `~/.mcp-microsoft-graph/` or similar) and re-authenticate.
