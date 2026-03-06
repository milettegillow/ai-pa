# AI Personal Assistant

A minimal personal assistant that runs inside Claude Code, using Microsoft Graph MCP for Outlook email and calendar access.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working
- A Microsoft 365 account (personal or work/school)
- Node.js 18+

## Setup

### 1. Authenticate with Microsoft 365

The project uses [`@softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) for Outlook email and calendar access. Run the login command first:

```bash
npx -y @softeria/ms-365-mcp-server --login
```

This triggers the device code flow — follow the URL and enter the code in your browser to sign in with your Microsoft account. Tokens are cached in your OS credential store.

> **Work/school accounts:** If your org uses a work/school tenant, edit `.mcp.json` and add `"--org-mode"` to the args array. If your IT admin hasn't pre-approved the app, you may need them to grant consent first.

### 2. Set your Zoom personal room link

Open `SYSTEM_PROMPT.md` and replace the placeholder:

```
[ZOOM_PERSONAL_ROOM_LINK]
```

with your actual Zoom link, e.g. `https://zoom.us/j/1234567890`.

### 3. Install dependencies

```bash
cd ~/Code/ai-pa && npm install
```

### 4. Launch the dashboard

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). Runs on your Claude Max subscription via the Agent SDK — no API key needed. Watch the terminal for the MCP OAuth device code flow on first run.

### Alternative: CLI-only mode

If you prefer Claude Code without the dashboard:

```bash
claude --system-prompt SYSTEM_PROMPT.md
```

## Example prompts

Once you're in a session (dashboard or CLI), try:

- **Morning briefing:** "Give me my morning briefing"
- **Check calendar:** "What's on my calendar this week?"
- **Read email:** "Summarise my unread emails"
- **Draft a reply:** "Draft a reply to the last email from Sarah saying I'll be 10 minutes late"
- **Create a meeting:** "Set up a 30-minute meeting with alex@example.com tomorrow at 2pm called 'Quick sync'"

## Project files

| File | Purpose |
|---|---|
| `server.js` | Express backend — serves the dashboard, proxies Claude + MCP |
| `public/index.html` | Single-page dashboard frontend |
| `SYSTEM_PROMPT.md` | The PA's personality and rules |
| `.mcp.json` | MCP server config for Microsoft Graph |
| `.env` | Optional settings like port (not committed) |
| `setup-checklist.md` | Step-by-step checklist to get running |
