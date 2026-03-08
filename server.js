import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

// ── Direct MCP Client ────────────────────────────────────────────────────────

let mcpClient = null;
let mcpConnecting = false;

async function getMcpClient() {
  if (mcpClient) return mcpClient;
  if (mcpConnecting) {
    // Wait for in-flight connection
    while (mcpConnecting) await new Promise(r => setTimeout(r, 100));
    return mcpClient;
  }

  mcpConnecting = true;
  try {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@softeria/ms-365-mcp-server', '--org-mode', '--preset', 'mail,calendar'],
      stderr: 'inherit',
    });

    const client = new Client({ name: 'ai-pa', version: '1.0.0' });

    transport.onclose = () => {
      console.log('[MCP] Transport closed, will reconnect on next request');
      mcpClient = null;
    };

    await client.connect(transport);
    console.log('[MCP] Connected to ms365 MCP server');

    // List available tools for debugging
    const { tools } = await client.listTools();
    console.log(`[MCP] ${tools.length} tools available: ${tools.map(t => t.name).join(', ')}`);

    mcpClient = client;
    return client;
  } catch (err) {
    console.error('[MCP] Failed to connect:', err.message);
    throw err;
  } finally {
    mcpConnecting = false;
  }
}

async function callTool(name, args = {}) {
  const client = await getMcpClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    return result;
  } catch (err) {
    console.error(`[MCP] ${name} failed:`, err.message);
    // Reset client on error so it reconnects
    mcpClient = null;
    throw err;
  }
}

// ── In-Memory Cache ──────────────────────────────────────────────────────────

const cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < CACHE_TTL) {
    console.log(`[Cache] HIT for ${key} (age: ${((Date.now() - entry.time) / 1000).toFixed(0)}s)`);
    return entry.data;
  }
  return null;
}

function setCache(key, data) {
  if (Array.isArray(data) && data.length === 0) return;
  cache[key] = { data, time: Date.now() };
}

// ── Chat (Claude Agent SDK) ──────────────────────────────────────────────────

let chatSessionId = null;

async function runQuery(prompt, resumeSessionId = null) {
  let result = '';
  let sessionId = null;

  const options = {
    systemPrompt,
    mcpServers: mcpConfig.mcpServers,
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
        console.log(`[runQuery] #${messageCount} [${elapsed}s] RESULT (${result.length} chars)`);
      }
    }
  } catch (queryErr) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[runQuery] QUERY THREW after ${elapsed}s: ${queryErr.message}`);
    throw queryErr;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[runQuery] Done in ${elapsed}s. Result: ${result.length} chars`);
  console.log(`[runQuery] ─────────────────────────────────────\n`);
  return { result, sessionId };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Chat endpoint — uses Claude Agent SDK with MCP access
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

app.post('/api/reset', (_req, res) => {
  chatSessionId = null;
  res.json({ ok: true });
});

// IMPORTANT: requires double confirmation before marking as read
app.post('/api/emails/:id/read', async (req, res) => {
  try {
    await callTool('update-mail-message', {
      messageId: req.params.id,
      body: { isRead: true },
    });
    delete cache['emails'];
    res.json({ ok: true });
  } catch (err) {
    console.error('[/api/emails/:id/read] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Emails — direct MCP call, no Claude involved
app.get('/api/emails', async (_req, res) => {
  const t0 = Date.now();

  try {
    // Check cache first
    const cached = getCached('emails');
    if (cached) {
      return res.json({ emails: cached });
    }

    const result = await callTool('list-mail-folder-messages', {
      mailFolderId: 'Inbox',
      filter: 'isRead eq false',
      top: 50,
      orderby: ['receivedDateTime desc'],
      select: ['id', 'subject', 'from', 'receivedDateTime', 'bodyPreview', 'isRead', 'inferenceClassification'],
    });

    // Parse MCP result — content is an array of content blocks
    const emails = [];
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          try {
            const data = JSON.parse(block.text);
            const items = data.value || (Array.isArray(data) ? data : []);
            for (const msg of items) {
              if (msg.inferenceClassification === 'other') continue;
              emails.push({
                id: msg.id || '',
                sender: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
                senderEmail: msg.from?.emailAddress?.address || '',
                subject: msg.subject || '(No subject)',
                preview: (msg.bodyPreview || '').slice(0, 100),
                time: msg.receivedDateTime || '',
                isRead: msg.isRead ?? false,
              });
            }
          } catch (e) {
            console.error(`[/api/emails] Parse error: ${e.message}`);
          }
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[/api/emails] ${emails.length} emails in ${elapsed}s`);

    setCache('emails', emails);
    res.json({ emails });
  } catch (err) {
    console.error('[/api/emails] ERROR:', err.message);
    res.status(500).json({ emails: [], error: err.message });
  }
});

// Refresh emails — bypass cache
app.post('/api/emails/refresh', async (_req, res) => {
  const t0 = Date.now();
  delete cache['emails'];

  try {
    const result = await callTool('list-mail-folder-messages', {
      mailFolderId: 'Inbox',
      filter: 'isRead eq false',
      top: 50,
      orderby: ['receivedDateTime desc'],
      select: ['id', 'subject', 'from', 'receivedDateTime', 'bodyPreview', 'isRead', 'inferenceClassification'],
    });

    const emails = [];
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          try {
            const data = JSON.parse(block.text);
            const items = data.value || (Array.isArray(data) ? data : []);
            for (const msg of items) {
              if (msg.inferenceClassification === 'other') continue;
              emails.push({
                id: msg.id || '',
                sender: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
                senderEmail: msg.from?.emailAddress?.address || '',
                subject: msg.subject || '(No subject)',
                preview: (msg.bodyPreview || '').slice(0, 100),
                time: msg.receivedDateTime || '',
                isRead: msg.isRead ?? false,
              });
            }
          } catch (e) {
            console.error(`[/api/emails/refresh] Parse error: ${e.message}`);
          }
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[/api/emails/refresh] ${emails.length} emails in ${elapsed}s`);

    setCache('emails', emails);
    res.json({ emails });
  } catch (err) {
    console.error('[/api/emails/refresh] ERROR:', err.message);
    res.status(500).json({ emails: [], error: err.message });
  }
});

// Calendar — direct MCP call, no Claude involved
app.get('/api/calendar', async (_req, res) => {
  const t0 = Date.now();

  try {
    const cached = getCached('calendar');
    if (cached) {
      return res.json({ events: cached });
    }

    const now = new Date();
    const startDateTime = now.toISOString();
    // End of today
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const endDateTime = endOfDay.toISOString();


    const result = await callTool('get-calendar-view', {
      startDateTime,
      endDateTime,
      top: 20,
      orderby: ['start/dateTime asc'],
      select: ['id', 'subject', 'start', 'end', 'location', 'attendees'],
    });

    const events = [];
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          try {
            const data = JSON.parse(block.text);
            const items = data.value || (Array.isArray(data) ? data : []);
            for (const evt of items) {
              events.push({
                id: evt.id || '',
                title: evt.subject || '(No title)',
                start: evt.start?.dateTime ? evt.start.dateTime + 'Z' : '',
                end: evt.end?.dateTime ? evt.end.dateTime + 'Z' : '',
                location: evt.location?.displayName || '',
              });
            }
          } catch (e) {
            console.error(`[/api/calendar] Parse error: ${e.message}`);
          }
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[/api/calendar] ${events.length} events in ${elapsed}s`);

    setCache('calendar', events);
    res.json({ events });
  } catch (err) {
    console.error('[/api/calendar] ERROR:', err.message);
    res.status(500).json({ events: [], error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  AI Personal Assistant                       │`);
  console.log(`  │  http://localhost:${PORT}                        │`);
  console.log(`  └─────────────────────────────────────────────┘`);
  console.log(`\n  Direct MCP: mail + calendar (no Claude needed)`);
  console.log(`  Claude: chat only (via Agent SDK + MCP)`);
  console.log(`  Cache TTL: ${CACHE_TTL / 1000}s`);
  console.log('');

  // Pre-connect to MCP server so first request is fast
  try {
    await getMcpClient();
  } catch (err) {
    console.error('  [!] MCP pre-connect failed — will retry on first request');
  }
});
