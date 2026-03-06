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
    // `tools: []` passes --tools "" which disables built-in tools (Bash, Read, etc.)
    // while still allowing MCP tools from --mcp-config.
    tools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 25,
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  const startTime = Date.now();
  console.log(`\n[runQuery] ─────────────────────────────────────`);
  console.log(`[runQuery] Prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}"`);
  console.log(`[runQuery] Session: ${resumeSessionId || 'new'}`);
  console.log(`[runQuery] MCP servers: ${JSON.stringify(Object.keys(mcpConfig.mcpServers))}`);
  console.log(`[runQuery] MCP config: ${JSON.stringify(mcpConfig.mcpServers)}`);
  console.log(`[runQuery] Built-in tools: DISABLED (tools: [])`);
  console.log(`[runQuery] Starting query at ${new Date().toISOString()}...`);

  let messageCount = 0;
  try {
    for await (const message of query({ prompt, options })) {
      messageCount++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        console.log(`[runQuery] #${messageCount} [${elapsed}s] Session init: ${sessionId}`);
      } else if ('result' in message) {
        result = message.result;
        console.log(`[runQuery] #${messageCount} [${elapsed}s] RESULT (${result.length} chars):`);
        console.log(`  "${result.slice(0, 500)}${result.length > 500 ? '...' : ''}"`);
      } else {
        // Log EVERY field on the message for debugging
        const keys = Object.keys(message);
        const msgType = message.type || 'unknown';
        const msgSubtype = message.subtype || '';
        const toolName = message.tool_name || message.name || '';
        const toolInput = message.tool_input || message.input || '';

        let logLine = `[runQuery] #${messageCount} [${elapsed}s] type=${msgType}`;
        if (msgSubtype) logLine += ` subtype=${msgSubtype}`;
        if (toolName) logLine += ` tool=${toolName}`;
        logLine += ` keys=[${keys.join(',')}]`;
        console.log(logLine);

        // Log tool inputs/outputs for debugging MCP calls
        if (toolInput) {
          console.log(`  Input: ${JSON.stringify(toolInput).slice(0, 500)}`);
        }
        if (message.content) {
          const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
          console.log(`  Content: ${content.slice(0, 500)}`);
        }
        // Log any error fields
        if (message.error) {
          console.log(`  ERROR: ${JSON.stringify(message.error)}`);
        }
      }
    }
  } catch (queryErr) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[runQuery] QUERY THREW after ${elapsed}s and ${messageCount} messages:`);
    console.error(`  Name: ${queryErr.name}`);
    console.error(`  Message: ${queryErr.message}`);
    console.error(`  Stack: ${queryErr.stack}`);
    throw queryErr;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[runQuery] Done in ${elapsed}s. Messages: ${messageCount}, Result: ${result.length} chars`);
  if (result.length === 0) {
    console.log(`[runQuery] WARNING: Empty result! The agent may have failed to produce output.`);
  }
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

// Sanitise a string so it's valid for JSON.parse — fix smart quotes, control chars, etc.
function sanitiseForJson(str) {
  return str
    // Smart/curly double quotes → escaped straight quotes (bare " would break JSON strings)
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"')
    // Smart/curly single quotes → straight
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    // En/em dashes → hyphen
    .replace(/[\u2013\u2014]/g, '-')
    // Non-breaking space → regular space
    .replace(/\u00A0/g, ' ')
    // Ellipsis character → three dots
    .replace(/\u2026/g, '...')
    // Remove BOM
    .replace(/\uFEFF/g, '')
    // Remove zero-width chars
    .replace(/[\u200B\u200C\u200D]/g, '')
    // Replace literal \r\n inside JSON string values with \\n
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    // Remove other ASCII control chars (except \n and \t which JSON allows escaped)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Parse a JSON array from a string that may contain markdown fences or other text
function parseJsonArray(str) {
  if (!str || str.length === 0) return null;

  // Try parsing with increasingly aggressive cleanup
  for (const input of [str, sanitiseForJson(str)]) {
    // 1. Try parsing the entire string directly
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.log(`[parseJsonArray] Direct parse failed: ${e.message}`);
    }

    // 2. Strip markdown fences and try again
    const fenceStripped = input.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    try {
      const parsed = JSON.parse(fenceStripped);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.log(`[parseJsonArray] Fence-stripped parse failed: ${e.message}`);
    }

    // 3. Find the outermost [...] using bracket counting
    const start = input.indexOf('[');
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < input.length; i++) {
      if (input[i] === '[') depth++;
      else if (input[i] === ']') depth--;
      if (depth === 0) {
        const slice = input.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          console.log(`[parseJsonArray] Bracket-extracted parse failed: ${e.message}`);
          // Show the problematic area around the error position
          const posMatch = e.message.match(/position (\d+)/);
          if (posMatch) {
            const pos = parseInt(posMatch[1]);
            console.log(`[parseJsonArray] Context around error: ...${slice.slice(Math.max(0, pos - 40), pos + 40)}...`);
          }
        }
        break;
      }
    }
  }

  return null;
}

// Parse pipe-delimited email lines into objects
function parsePipeEmails(str) {
  if (!str || str.length === 0) return null;
  const lines = str.split('\n').map(l => l.trim()).filter(l => l && l.includes('|'));
  if (lines.length === 0) return null;

  const emails = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 6) continue;
    emails.push({
      id: parts[0],
      sender: parts[1],
      senderEmail: parts[2],
      subject: parts[3],
      preview: parts[4],
      time: parts[5],
      isRead: parts[6] === 'true',
    });
  }
  return emails.length > 0 ? emails : null;
}

// Fetch unread emails via a one-shot Agent SDK query
app.get('/api/emails', async (_req, res) => {
  const t0 = Date.now();
  console.log('\n[/api/emails] ══════════════════════════════════');
  console.log(`[/api/emails] Request received at ${new Date().toISOString()}`);
  try {
    const { result } = await runQuery(
      'Use the Microsoft Graph MCP tools to list my recent unread emails (up to 15). Do NOT use Bash, osascript, or any local mail app. Only use the MCP tools available to you. Return ONLY the results as plain text, one email per line, in this exact pipe-delimited format:\nID|SENDER_NAME|SENDER_EMAIL|SUBJECT|PREVIEW_FIRST_100_CHARS|ISO_TIME|IS_READ\nNo JSON, no markdown, no explanation, no header row. Just the pipe-delimited lines. If a field contains a pipe character, remove it.',
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[/api/emails] Query completed in ${elapsed}s`);
    console.log(`[/api/emails] Raw result (${result.length} chars):\n${result.slice(0, 2000)}`);

    if (!result || result.length === 0) {
      console.log('[/api/emails] WARNING: Empty result from agent');
      return res.json({ emails: [], raw: '(empty result)' });
    }

    const emails = parsePipeEmails(result);
    if (emails) {
      console.log(`[/api/emails] Parsed ${emails.length} emails successfully`);
      console.log('[/api/emails] ══════════════════════════════════\n');
      res.json({ emails });
    } else {
      console.log('[/api/emails] WARNING: Could not parse pipe-delimited result');
      console.log('[/api/emails] Full result:', result);
      console.log('[/api/emails] ══════════════════════════════════\n');
      res.json({ emails: [], raw: result });
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[/api/emails] ERROR after ${elapsed}s:`, err.message);
    console.error(`[/api/emails] Stack:`, err.stack);
    console.log('[/api/emails] ══════════════════════════════════\n');
    res.status(500).json({ emails: [], error: err.message });
  }
});

// Parse pipe-delimited calendar lines into objects
function parsePipeCalendar(str) {
  if (!str || str.length === 0) return null;
  const lines = str.split('\n').map(l => l.trim()).filter(l => l && l.includes('|'));
  if (lines.length === 0) return null;

  const events = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    events.push({
      id: parts[0],
      title: parts[1],
      start: parts[2],
      end: parts[3],
      location: parts[4] || '',
    });
  }
  return events.length > 0 ? events : null;
}

// Fetch upcoming calendar events (next 7 days) via a one-shot Agent SDK query
app.get('/api/calendar', async (_req, res) => {
  const t0 = Date.now();
  console.log('\n[/api/calendar] ══════════════════════════════════');
  console.log(`[/api/calendar] Request received at ${new Date().toISOString()}`);
  try {
    const today = new Date().toISOString().split('T')[0];
    const endDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    const { result } = await runQuery(
      `Use the Microsoft Graph MCP tools to list my calendar events from ${today} to ${endDate} (next 7 days). Do NOT use Bash, osascript, or any local calendar app. Only use the MCP tools available to you. Return ONLY the results as plain text, one event per line, in this exact pipe-delimited format:\nID|TITLE|START_ISO|END_ISO|LOCATION\nNo JSON, no markdown, no explanation, no header row. Just the pipe-delimited lines. If a field contains a pipe character, remove it.`,
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[/api/calendar] Query completed in ${elapsed}s`);
    console.log(`[/api/calendar] Raw result (${result.length} chars):\n${result.slice(0, 2000)}`);

    if (!result || result.length === 0) {
      console.log('[/api/calendar] WARNING: Empty result from agent');
      return res.json({ events: [], raw: '(empty result)' });
    }

    const events = parsePipeCalendar(result);
    if (events) {
      console.log(`[/api/calendar] Parsed ${events.length} events successfully`);
      console.log('[/api/calendar] ══════════════════════════════════\n');
      res.json({ events });
    } else {
      console.log('[/api/calendar] WARNING: Could not parse pipe-delimited result');
      console.log('[/api/calendar] Full result:', result);
      console.log('[/api/calendar] ══════════════════════════════════\n');
      res.json({ events: [], raw: result });
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[/api/calendar] ERROR after ${elapsed}s:`, err.message);
    console.error(`[/api/calendar] Stack:`, err.stack);
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
  console.log(`  Built-in tools: DISABLED (tools: [], MCP only)`);
  console.log('');
});
