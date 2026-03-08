import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Load system prompts
const systemPrompt = readFileSync(join(__dirname, 'SYSTEM_PROMPT.md'), 'utf-8');
const draftReplyPrompt = readFileSync(join(__dirname, 'DRAFT_REPLY_PROMPT.md'), 'utf-8');

// Load MCP server config from .mcp.json
const mcpConfig = JSON.parse(readFileSync(join(__dirname, '.mcp.json'), 'utf-8'));

// Toolkit config
const toolkitPath = join(__dirname, 'toolkit.json');

function loadToolkit() {
  if (!existsSync(toolkitPath)) return {};
  return JSON.parse(readFileSync(toolkitPath, 'utf-8'));
}

function saveToolkit(data) {
  writeFileSync(toolkitPath, JSON.stringify(data, null, 2) + '\n');
}

// Action items config
const actionItemsPath = join(__dirname, 'action-items.json');

function loadActionItems() {
  if (!existsSync(actionItemsPath)) return { items: [], archive: {} };
  try {
    return JSON.parse(readFileSync(actionItemsPath, 'utf-8'));
  } catch {
    return { items: [], archive: {} };
  }
}

function saveActionItems(data) {
  writeFileSync(actionItemsPath, JSON.stringify(data, null, 2) + '\n');
}

const DEFAULT_WRITING_RULES = [
  'Always use UK English',
  'Never use em dashes (\u2014)',
  'Sign off: "All the best, Milette"',
  'Greet by first name only',
  'Keep replies short and direct',
  'Never say "I hope this email finds you well" or similar',
];

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

// Toolkit endpoints
app.get('/api/toolkit', (_req, res) => {
  const toolkit = loadToolkit();
  if (!toolkit.writingRules) toolkit.writingRules = DEFAULT_WRITING_RULES;
  res.json(toolkit);
});

app.post('/api/toolkit', (req, res) => {
  const { blurb, links, writingRules, bannedPhrases } = req.body;
  saveToolkit({ blurb, links, writingRules, bannedPhrases });
  res.json({ ok: true });
});

// Generate a writing rule from natural language via Claude
app.post('/api/toolkit/generate-rule', async (req, res) => {
  try {
    const { instruction } = req.body;
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });

    let rule = '';
    for await (const message of query({ prompt: instruction, options: {
      systemPrompt: `You are a writing style rule generator. The user will describe a writing preference in casual language. Your job is to turn it into a single, concise writing rule (one sentence, imperative mood, like "Always use UK English" or "Never start emails with a greeting cliché"). Return ONLY the rule text, nothing else. No quotes, no explanation, no bullet point.`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) {
        rule = message.result.replace(/^[-•*"\s]+/, '').replace(/["]+$/, '').trim();
      }
    }

    res.json({ rule });
  } catch (err) {
    console.error('[/api/toolkit/generate-rule] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// Draft reply — uses Claude Agent SDK with draft-specific system prompt + toolkit context
// Strip quoted reply chains from email threads — keep only the latest message
function stripQuotedReplies(text) {
  if (!text) return '';
  // Split on common reply markers and keep only the first part
  const markers = [
    /\r?\nOn .{10,80} wrote:\s*\r?\n/,        // "On Mon, Feb 16... wrote:"
    /\r?\n-{3,}\s*Original Message\s*-{3,}/i,  // "--- Original Message ---"
    /\r?\nFrom: .+\r?\nSent: /,               // "From: X\nSent: ..."
    /\r?\n_{3,}\r?\nFrom: /,                   // "___\nFrom: ..."
    /\r?\n>{2,}/,                               // ">>>" quoted lines
  ];
  let result = text;
  for (const marker of markers) {
    const match = result.match(marker);
    if (match) {
      result = result.slice(0, match.index);
    }
  }
  return result.trim();
}

// Analyse email to determine response options
app.post('/api/emails/:id/analyse', async (req, res) => {
  try {
    const { sender, senderEmail, subject, body } = req.body;
    if (!sender || !subject) {
      return res.status(400).json({ error: 'sender and subject are required' });
    }

    const latestMessage = stripQuotedReplies(body);
    console.log('[analyse] Received:', { sender, senderEmail, subject, bodyLength: body?.length, strippedLength: latestMessage.length });

    const toolkit = loadToolkit();
    const context = toolkit.blurb ? `\nContext about Milette's company: ${toolkit.blurb}` : '';

    const prompt = `Analyse this email and determine if there are multiple distinct ways Milette could respond.

From: ${sender} <${senderEmail || ''}>
Subject: ${subject}
Body: ${latestMessage || '(no content)'}

Consider: Are there clear response options? (e.g. yes/no to a request, accept/decline an invitation, different tones like enthusiastic vs polite decline, option A vs option B)

If YES — return a JSON array of 2-4 short option labels (max 6 words each).
If NO — return an empty JSON array [].

Return ONLY the JSON array, nothing else.`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are an email response analyst. Determine whether an email contains a question, request, or decision point that could be answered in different ways. Look for: direct questions, invitations, offers, requests for confirmation, yes/no decisions, scheduling proposals. If the sender is asking something that has 2+ reasonable responses, return option labels. Only return [] for purely informational emails with no question or call to action.${context}`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) {
        rawResult = message.result;
      }
    }

    console.log('[analyse] Raw Claude response:', JSON.stringify(rawResult));

    let options = [];
    try {
      const jsonMatch = rawResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        options = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('[analyse] Failed to parse:', e.message);
    }

    console.log('[analyse] Parsed options:', options);
    res.json({ options });
  } catch (err) {
    console.error('[/api/emails/:id/analyse] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/draft-reply', async (req, res) => {
  try {
    const { sender, senderEmail, subject, preview, instruction } = req.body;
    if (!sender || !subject) {
      return res.status(400).json({ error: 'sender and subject are required' });
    }

    // Build system prompt with toolkit context
    const toolkit = loadToolkit();
    let fullPrompt = draftReplyPrompt;

    if (toolkit.blurb) {
      fullPrompt += `\n\n## About The Tech Bros\n\n${toolkit.blurb}`;
    }
    if (toolkit.links?.length) {
      fullPrompt += '\n\n## Key Links\n\n' + toolkit.links.map(l => `- ${l.label}: ${l.url}`).join('\n');
    }
    const rules = toolkit.writingRules || DEFAULT_WRITING_RULES;
    fullPrompt += '\n\n## Writing Rules\n\n' + rules.map(r => `- ${r}`).join('\n');
    if (toolkit.bannedPhrases?.length) {
      fullPrompt += '\n\n## Banned Phrases (NEVER use these)\n\n' + toolkit.bannedPhrases.map(p => `- "${p}"`).join('\n');
    }

    let userPrompt = `Draft a reply to this email:

From: ${sender} <${senderEmail || ''}>
Subject: ${subject}
Body: ${preview || '(no preview available)'}`;

    if (instruction) {
      userPrompt += `\n\nThe user wants to: ${instruction}. Draft the reply accordingly.`;
    }

    userPrompt += '\n\nWrite ONLY the reply body text. No subject line, no headers, no explanation.';

    let draft = '';
    for await (const message of query({ prompt: userPrompt, options: {
      systemPrompt: fullPrompt,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) {
        draft = message.result;
      }
    }

    res.json({ draft });
  } catch (err) {
    console.error('[/api/emails/:id/draft-reply] ERROR:', err.message);
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
      select: ['id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'body', 'bodyPreview', 'isRead', 'inferenceClassification'],
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
                body: msg.body?.content || msg.bodyPreview || '',
                bodyType: msg.body?.contentType || 'text',
                time: msg.receivedDateTime || '',
                isRead: msg.isRead ?? false,
                to: (msg.toRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
                cc: (msg.ccRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
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
      select: ['id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'body', 'bodyPreview', 'isRead', 'inferenceClassification'],
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
                body: msg.body?.content || msg.bodyPreview || '',
                bodyType: msg.body?.contentType || 'text',
                time: msg.receivedDateTime || '',
                isRead: msg.isRead ?? false,
                to: (msg.toRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
                cc: (msg.ccRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
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
                attendees: (evt.attendees || []).map(a => a.emailAddress?.name || a.emailAddress?.address || '').filter(Boolean),
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

// ── Action Items ─────────────────────────────────────────────────────────────

app.get('/api/action-items', (_req, res) => {
  const data = loadActionItems();
  res.json({ items: data.items || [] });
});

app.post('/api/action-items/generate', async (_req, res) => {
  try {
    // Gather current emails and calendar from cache or fetch
    let emailList = getCached('emails');
    if (!emailList) {
      try {
        const emailRes = await fetch(`http://localhost:${PORT}/api/emails`);
        const emailData = await emailRes.json();
        emailList = emailData.emails || [];
      } catch { emailList = []; }
    }

    let eventList = getCached('calendar');
    if (!eventList) {
      try {
        const calRes = await fetch(`http://localhost:${PORT}/api/calendar`);
        const calData = await calRes.json();
        eventList = calData.events || [];
      } catch { eventList = []; }
    }

    const data = loadActionItems();
    const existingTexts = (data.items || []).map(i => i.text.toLowerCase());

    const toolkit = loadToolkit();
    const context = toolkit.blurb ? `\n\nContext about Milette's company: ${toolkit.blurb}` : '';

    const emailSummary = emailList.map(e => `- From: ${e.sender} (${e.senderEmail}) | Subject: ${e.subject} | Preview: ${e.preview}`).join('\n');
    const calSummary = eventList.map(e => `- ${e.title} (${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`).join('\n');
    const existingSummary = existingTexts.length ? '\n\nExisting action items (DO NOT duplicate these):\n' + existingTexts.map(t => `- ${t}`).join('\n') : '';

    const prompt = `Here are Milette's unread emails:\n${emailSummary || '(none)'}\n\nHere is today's calendar:\n${calSummary || '(none)'}${existingSummary}\n\nExtract action items — things Milette needs to do, reply to, follow up on, or prepare for. Be specific with names and context (e.g. "Reply to Gabrielle at Aldea re: intro" not "Reply to email").`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are Milette's personal assistant. Extract action items from her emails and calendar. Return ONLY a valid JSON array of strings. Each string should be a specific, actionable task. No explanation, no markdown, just the JSON array.${context}`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) {
        rawResult = message.result;
      }
    }

    // Parse the JSON array from Claude's response
    let newItems = [];
    try {
      const jsonMatch = rawResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        newItems = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('[action-items/generate] Failed to parse Claude response:', e.message);
      return res.status(500).json({ error: 'Failed to parse action items from Claude' });
    }

    // Deduplicate and add new items
    let added = 0;
    for (const text of newItems) {
      if (typeof text !== 'string' || !text.trim()) continue;
      const lower = text.trim().toLowerCase();
      if (existingTexts.includes(lower)) continue;
      data.items.push({
        id: randomUUID(),
        text: text.trim(),
        source: 'email',
        sourceId: '',
        createdAt: new Date().toISOString(),
        completedAt: null,
        completed: false,
      });
      existingTexts.push(lower);
      added++;
    }

    saveActionItems(data);
    console.log(`[action-items/generate] ${added} new items added, ${data.items.length} total`);
    res.json({ items: data.items });
  } catch (err) {
    console.error('[action-items/generate] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/action-items/:id/complete', (req, res) => {
  const data = loadActionItems();
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.completed = true;
  item.completedAt = new Date().toISOString();
  saveActionItems(data);
  res.json({ ok: true, item });
});

app.patch('/api/action-items/:id/uncomplete', (req, res) => {
  const data = loadActionItems();
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.completed = false;
  item.completedAt = null;
  saveActionItems(data);
  res.json({ ok: true, item });
});

app.post('/api/action-items/archive', (_req, res) => {
  const data = loadActionItems();
  const today = new Date().toISOString().split('T')[0];
  const completed = data.items.filter(i => i.completed);
  if (completed.length === 0) return res.json({ ok: true, archived: 0 });

  if (!data.archive) data.archive = {};
  if (!data.archive[today]) data.archive[today] = [];
  data.archive[today].push(...completed);
  data.items = data.items.filter(i => !i.completed);
  saveActionItems(data);
  res.json({ ok: true, archived: completed.length });
});

app.get('/api/action-items/archive', (_req, res) => {
  const data = loadActionItems();
  res.json({ archive: data.archive || {} });
});

// Post-call follow-up detection — runs every 5 minutes
function checkPostCallFollowUps() {
  try {
    const events = getCached('calendar');
    if (!events || events.length === 0) return;

    const now = Date.now();
    const fiveMin = 5 * 60 * 1000;
    const data = loadActionItems();
    let added = 0;

    for (const evt of events) {
      if (!evt.end || !evt.attendees || evt.attendees.length === 0) continue;
      const endTime = new Date(evt.end).getTime();
      if (endTime > now - fiveMin && endTime <= now) {
        const followUpText = `\u{1F4DE} ${evt.title} just ended — want to send a follow-up?`;
        const alreadyExists = data.items.some(i => i.text === followUpText);
        if (!alreadyExists) {
          data.items.unshift({
            id: randomUUID(),
            text: followUpText,
            source: 'calendar',
            sourceId: evt.id,
            createdAt: new Date().toISOString(),
            completedAt: null,
            completed: false,
          });
          added++;
        }
      }
    }

    if (added > 0) {
      saveActionItems(data);
      console.log(`[post-call] Added ${added} follow-up item(s)`);
    }
  } catch (err) {
    console.error('[post-call] Error:', err.message);
  }
}

// Midnight auto-archive
function checkMidnightArchive() {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    console.log('[auto-archive] Running midnight archive');
    const data = loadActionItems();
    const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
    const completed = data.items.filter(i => i.completed);
    if (completed.length > 0) {
      if (!data.archive) data.archive = {};
      if (!data.archive[yesterday]) data.archive[yesterday] = [];
      data.archive[yesterday].push(...completed);
      data.items = data.items.filter(i => !i.completed);
      saveActionItems(data);
      console.log(`[auto-archive] Archived ${completed.length} items under ${yesterday}`);
    }
  }
}

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

  // Post-call follow-up detection every 5 minutes
  setInterval(checkPostCallFollowUps, 5 * 60 * 1000);
  // Midnight auto-archive check every 60 seconds
  setInterval(checkMidnightArchive, 60 * 1000);
  console.log('  Intervals: post-call follow-ups (5m), midnight archive (60s)');
});
