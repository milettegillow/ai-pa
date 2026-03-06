import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Load system prompt
const systemPrompt = readFileSync(join(__dirname, 'SYSTEM_PROMPT.md'), 'utf-8');

// Load MCP server config from .mcp.json
const mcpConfig = JSON.parse(readFileSync(join(__dirname, '.mcp.json'), 'utf-8'));

// Chat session ID — used to resume conversation across requests
let chatSessionId = null;

// Run a query through the Claude Agent SDK
async function runQuery(prompt, resumeSessionId = null) {
  let result = '';
  let sessionId = null;

  const options = {
    systemPrompt,
    mcpServers: mcpConfig.mcpServers,
    // Disable ALL built-in tools — only MCP tools should be available.
    // This prevents the agent from using Bash/osascript to access Mac Mail.
    allowedTools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 25,
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  console.log(`\n[runQuery] ─────────────────────────────────────`);
  console.log(`[runQuery] Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  console.log(`[runQuery] Session: ${resumeSessionId || 'new'}`);
  console.log(`[runQuery] MCP servers: ${JSON.stringify(Object.keys(mcpConfig.mcpServers))}`);
  console.log(`[runQuery] Allowed built-in tools: none (MCP only)`);

  let messageCount = 0;
  for await (const message of query({ prompt, options })) {
    messageCount++;

    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      console.log(`[runQuery] #${messageCount} Session init: ${sessionId}`);
    } else if ('result' in message) {
      result = message.result;
      console.log(`[runQuery] #${messageCount} RESULT (${result.length} chars):`);
      console.log(`  "${result.slice(0, 200)}${result.length > 200 ? '...' : ''}"`);
    } else {
      // Log tool calls and other message types for debugging
      const msgType = message.type || 'unknown';
      const msgSubtype = message.subtype || '';
      const toolName = message.tool_name || message.name || '';
      const toolInput = message.tool_input || message.input || '';

      let logLine = `[runQuery] #${messageCount} type=${msgType}`;
      if (msgSubtype) logLine += ` subtype=${msgSubtype}`;
      if (toolName) logLine += ` tool=${toolName}`;
      console.log(logLine);

      // Log tool inputs/outputs for debugging MCP calls
      if (toolInput) {
        console.log(`  Input: ${JSON.stringify(toolInput).slice(0, 200)}`);
      }
      if (message.content) {
        const content = typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
        console.log(`  Content: ${content.slice(0, 300)}`);
      }
    }
  }

  console.log(`[runQuery] Done. Messages: ${messageCount}, Result: ${result.length} chars`);
  console.log(`[runQuery] ─────────────────────────────────────\n`);
  return { result, sessionId };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Chat endpoint — resumes the same session for conversation continuity
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const { result, sessionId } = await runQuery(message, chatSessionId);
    if (sessionId) chatSessionId = sessionId;

    res.json({ response: result });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset conversation — clears session so next chat starts fresh
app.post('/api/reset', (_req, res) => {
  chatSessionId = null;
  res.json({ ok: true });
});

// Fetch unread emails via a one-shot Agent SDK query
app.get('/api/emails', async (_req, res) => {
  console.log('\n[/api/emails] ══════════════════════════════════');
  try {
    const { result } = await runQuery(
      'Use the Microsoft Graph MCP tools to list my recent unread emails (up to 15). Do NOT use Bash, osascript, or any local mail app. Only use the MCP tools available to you. Return ONLY valid JSON — no markdown fences, no explanation. Use this exact schema: [{"id":"...","sender":"...","senderEmail":"...","subject":"...","preview":"first 80 chars of body...","time":"ISO 8601 timestamp","isRead":false}]',
    );

    console.log(`[/api/emails] Raw result:\n${result}`);

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log('[/api/emails] WARNING: No JSON array found in result');
      return res.json({ emails: [], raw: result });
    }

    const emails = JSON.parse(jsonMatch[0]);
    console.log(`[/api/emails] Parsed ${emails.length} emails successfully`);
    console.log('[/api/emails] ══════════════════════════════════\n');
    res.json({ emails });
  } catch (err) {
    console.error('[/api/emails] ERROR:', err);
    console.log('[/api/emails] ══════════════════════════════════\n');
    res.status(500).json({ emails: [], error: err.message });
  }
});

// Fetch today + tomorrow calendar events via a one-shot Agent SDK query
app.get('/api/calendar', async (_req, res) => {
  console.log('\n[/api/calendar] ══════════════════════════════════');
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const { result } = await runQuery(
      `Use the Microsoft Graph MCP tools to list my calendar events for ${today} and ${tomorrow}. Do NOT use Bash, osascript, or any local calendar app. Only use the MCP tools available to you. Return ONLY valid JSON — no markdown fences, no explanation. Use this exact schema: [{"id":"...","title":"...","start":"ISO 8601","end":"ISO 8601","location":"...","attendees":["email1","email2"]}]`,
    );

    console.log(`[/api/calendar] Raw result:\n${result}`);

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log('[/api/calendar] WARNING: No JSON array found in result');
      return res.json({ events: [], raw: result });
    }

    const events = JSON.parse(jsonMatch[0]);
    console.log(`[/api/calendar] Parsed ${events.length} events successfully`);
    console.log('[/api/calendar] ══════════════════════════════════\n');
    res.json({ events });
  } catch (err) {
    console.error('[/api/calendar] ERROR:', err);
    console.log('[/api/calendar] ══════════════════════════════════\n');
    res.status(500).json({ events: [], error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  AI Personal Assistant                       │`);
  console.log(`  │  http://localhost:${PORT}                        │`);
  console.log(`  └─────────────────────────────────────────────┘`);
  console.log(`\n  MCP servers:`);
  for (const [name, config] of Object.entries(mcpConfig.mcpServers)) {
    console.log(`    - ${name}: ${config.command} ${(config.args || []).join(' ')}`);
  }
  console.log(`  System prompt: ${systemPrompt.length} chars loaded`);
  console.log(`  Built-in tools: DISABLED (MCP only)`);
  console.log('');
});
