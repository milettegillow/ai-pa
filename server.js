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
app.use(express.static(join(__dirname, 'public'), { etag: false, maxAge: 0 }));

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

// Follow-ups & blockers config
const followUpsPath = join(__dirname, 'follow-ups.json');

function loadFollowUps() {
  if (!existsSync(followUpsPath)) return { followUps: [], blockers: [] };
  try {
    return JSON.parse(readFileSync(followUpsPath, 'utf-8'));
  } catch {
    return { followUps: [], blockers: [] };
  }
}

function saveFollowUps(data) {
  writeFileSync(followUpsPath, JSON.stringify(data, null, 2) + '\n');
}

// Quests config
const questsPath = join(__dirname, 'quests.json');

function loadQuests() {
  if (!existsSync(questsPath)) return { quests: [] };
  try {
    return JSON.parse(readFileSync(questsPath, 'utf-8'));
  } catch {
    return { quests: [] };
  }
}

function saveQuests(data) {
  writeFileSync(questsPath, JSON.stringify(data, null, 2) + '\n');
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

async function runQuery(prompt, resumeSessionId = null, systemPromptOverride = null) {
  let result = '';
  let sessionId = null;

  const options = {
    systemPrompt: systemPromptOverride || systemPrompt,
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
  const { blurb, links, writingRules, bannedPhrases, urgencyRules } = req.body;
  const existing = loadToolkit();
  saveToolkit({ blurb, links, writingRules, bannedPhrases, urgencyRules: urgencyRules || existing.urgencyRules });
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

    // Enrich system prompt with follow-ups, blockers, and toolkit context
    const fuData = loadFollowUps();
    const toolkit = loadToolkit();
    const followUpsList = fuData.followUps.filter(f => !f.completed).map(f => {
      const text = f.text || f.name || '';
      const email = f.recipientEmail || f.email || '';
      return `- [${f.type || 'follow-up'}] ${text}${email ? ` (${email})` : ''}${f.dueDate ? ` [due: ${f.dueDate}]` : ''}`;
    }).join('\n');
    const blockersList = fuData.blockers.filter(b => !b.completed).map(b =>
      `- ${b.name}: ${b.task}`
    ).join('\n');
    const linksList = (toolkit.links || []).map(l => `- ${l.label}: ${l.url}`).join('\n');

    const enrichedPrompt = systemPrompt + `

## Follow-ups
These are Milette's pending follow-ups. When she asks to "send a follow-up to [name]" or "email [name] about [task]", use this data to find the right person and their email address. Draft the email and show it for approval before sending.

${followUpsList || '(none)'}

## Blockers
${blockersList || '(none)'}

## Available links
When drafting emails, include relevant links from this list:
${linksList || '(none)'}

## Follow-up email handling
When Milette asks you to send a follow-up email:
1. Look up the person in the follow-ups list above
2. If they have an email address, draft the email to that address
3. Include any relevant links from the available links list
4. Show the draft clearly formatted (To, Subject, Body) and wait for approval
5. Follow all standard email rules (UK English, no em dashes, sign off "All the best, Milette")`;

    const { result, sessionId } = await runQuery(message, chatSessionId, enrichedPrompt);
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

// Convert raw URLs in draft text to markdown-style links with friendly labels
function formatDraftLinks(text) {
  const toolkit = loadToolkit();
  const linkMap = {};
  if (toolkit.links?.length) {
    for (const link of toolkit.links) {
      linkMap[link.url] = link.label;
    }
  }

  // Temporarily replace existing markdown links with placeholders
  const existingLinks = [];
  let result = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match) => {
    existingLinks.push(match);
    return `__MDLINK_${existingLinks.length - 1}__`;
  });

  // Replace raw URLs with markdown links
  result = result.replace(/https?:\/\/[^\s)]+/g, (url) => {
    let label = null;
    for (const [knownUrl, knownLabel] of Object.entries(linkMap)) {
      if (url.startsWith(knownUrl) || knownUrl.startsWith(url)) {
        label = knownLabel;
        break;
      }
    }
    if (!label) {
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        label = domain;
      } catch {
        label = 'link';
      }
    }
    return `[${label}](${url})`;
  });

  // Restore existing markdown links
  result = result.replace(/__MDLINK_(\d+)__/g, (_, i) => existingLinks[parseInt(i)]);
  return result;
}

// Convert plain text draft to HTML with proper line breaks and hyperlinks
function draftToHtml(text) {
  // Build a map of known URLs to friendly labels from toolkit
  const toolkit = loadToolkit();
  const linkMap = {};
  if (toolkit.links?.length) {
    for (const link of toolkit.links) {
      linkMap[link.url] = link.label;
    }
  }

  // Escape HTML entities
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // First: convert markdown-style links [label](url) to <a> tags
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, url) => {
    return `<a href="${url}">${label}</a>`;
  });

  // Then: replace any remaining raw URLs with anchor tags
  html = html.replace(/(?<!href=")https?:\/\/[^\s<>&)]+/g, (url) => {
    // Decode the escaped URL for matching
    const decoded = url.replace(/&amp;/g, '&');
    // Check if this URL matches a known toolkit link
    let label = null;
    for (const [knownUrl, knownLabel] of Object.entries(linkMap)) {
      if (decoded.startsWith(knownUrl) || knownUrl.startsWith(decoded)) {
        label = knownLabel;
        break;
      }
    }
    if (!label) {
      // Use domain name as fallback label
      try {
        const domain = new URL(decoded).hostname.replace(/^www\./, '');
        label = domain;
      } catch {
        label = 'link';
      }
    }
    return `<a href="${decoded}">${label}</a>`;
  });

  // Convert line breaks to <br> tags
  html = html.replace(/\r?\n/g, '<br>');

  return html;
}

// Send reply — calls MCP reply-mail-message tool
app.post('/api/emails/:id/send', async (req, res) => {
  try {
    const { draftText } = req.body;
    if (!draftText) {
      return res.status(400).json({ error: 'draftText is required' });
    }

    const messageId = req.params.id;
    const htmlBody = draftToHtml(draftText);
    console.log(`[send] Sending reply to message ${messageId.slice(0, 20)}...`);
    console.log('[send] HTML body:', htmlBody);

    await callTool('reply-mail-message', {
      messageId,
      body: {
        Message: {
          body: {
            contentType: 'html',
            content: htmlBody,
          },
        },
      },
    });

    // Graph API auto-marks as read on reply — undo that so only explicit
    // user confirmation marks it as read
    try {
      await callTool('update-mail-message', {
        messageId,
        body: { isRead: false },
      });
    } catch (e) {
      console.warn('[send] Could not reset isRead:', e.message);
    }

    // Invalidate email cache so the inbox refreshes
    delete cache['emails'];

    console.log('[send] Reply sent successfully');
    res.json({ success: true });
  } catch (err) {
    console.error('[/api/emails/:id/send] ERROR:', err.message);
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

If YES — return a JSON array of 2-4 objects, each with "label" (max 6 words) and "isDefault" (boolean). Mark exactly ONE option as isDefault: true — the most likely or natural response. Default logic: if an option involves sending a scheduling/Calendly link, that's the default for meeting requests. Otherwise, the straightforward positive reply is the default.
If NO — return an empty JSON array [].

Example: [{"label": "Accept and send Calendly", "isDefault": true}, {"label": "Politely decline", "isDefault": false}]

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
        const parsed = JSON.parse(jsonMatch[0]);
        // Normalise: accept both string[] and {label, isDefault}[]
        options = parsed.map(item => {
          if (typeof item === 'string') return { label: item, isDefault: false };
          return { label: item.label || '', isDefault: !!item.isDefault };
        });
        // Ensure exactly one default
        const hasDefault = options.some(o => o.isDefault);
        if (!hasDefault && options.length > 0) options[0].isDefault = true;
      }
    } catch (e) {
      console.error('[analyse] Failed to parse:', e.message);
    }

    console.log('[analyse] Parsed options:', options);

    // Step 2: Check for missing links
    let missingLink = null;
    try {
      const linkList = toolkit.links?.length
        ? toolkit.links.map(l => `- ${l.label}: ${l.url}`).join('\n')
        : '(none)';

      const linkPrompt = `Here is an email Milette needs to reply to:

From: ${sender} <${senderEmail || ''}>
Subject: ${subject}
Body: ${latestMessage || '(no content)'}

Here are the links Milette already has in her toolkit:
${linkList}

Would a good reply to this email require a specific link that is NOT already in the toolkit above? For example: a pricing page, a specific event registration link, a document, a form, an application link, etc.

If YES — return a JSON object: {"missingLink": "brief description of what link is needed"}
If NO — return: {"missingLink": null}

Return ONLY the JSON object, nothing else.`;

      let linkResult = '';
      for await (const message of query({ prompt: linkPrompt, options: {
        systemPrompt: `You are an email analysis assistant. Determine if a reply would require a specific link or URL that isn't already available. Only flag genuinely missing links — don't flag links that aren't needed for the reply. Be conservative: if the reply can be written without a specific link, return null.${context}`,
        tools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
      }})) {
        if ('result' in message) {
          linkResult = message.result;
        }
      }

      try {
        const jsonMatch = linkResult.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.missingLink) {
            missingLink = parsed.missingLink;
          }
        }
      } catch (e) {
        console.error('[analyse] Failed to parse link check:', e.message);
      }
    } catch (e) {
      console.error('[analyse] Link check failed:', e.message);
    }

    console.log('[analyse] Missing link:', missingLink);
    res.json({ options, missingLink });
  } catch (err) {
    console.error('[/api/emails/:id/analyse] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/:id/draft-reply', async (req, res) => {
  try {
    const { sender, senderEmail, subject, preview, instruction, additionalLinks, receivedAt } = req.body;
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
    if (additionalLinks?.length) {
      fullPrompt += '\n\n## Additional Links (provided by user for this reply)\n\n' + additionalLinks.map(l => `- ${l}`).join('\n');
    }
    const rules = toolkit.writingRules || DEFAULT_WRITING_RULES;
    fullPrompt += '\n\n## Writing Rules\n\n' + rules.map(r => `- ${r}`).join('\n');
    if (toolkit.bannedPhrases?.length) {
      fullPrompt += '\n\n## Banned Phrases (NEVER use these)\n\n' + toolkit.bannedPhrases.map(p => `- "${p}"`).join('\n');
    }

    // Check if email is older than 2 weeks — prepend apology instruction
    let apologyPrefix = '';
    if (receivedAt) {
      const ageHours = (Date.now() - new Date(receivedAt).getTime()) / (1000 * 60 * 60);
      if (ageHours >= 336) {
        apologyPrefix = '\n\nIMPORTANT: This email is over 2 weeks old. Start the reply with "Apologies for the delay here — " before the main content.';
      }
    }

    let userPrompt = `Draft a reply to this email:

From: ${sender} <${senderEmail || ''}>
Subject: ${subject}
Body: ${preview || '(no preview available)'}`;

    if (instruction) {
      userPrompt += `\n\nThe user wants to: ${instruction}. Draft the reply accordingly.`;
    }

    userPrompt += apologyPrefix;
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

    // Post-process: convert raw URLs to markdown-style links with friendly labels
    draft = formatDraftLinks(draft);

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

    // DEBUG: Step 1 — unfiltered call to see raw count
    console.log('[DEBUG /api/emails] Step 1: calling list-mail-folder-messages with NO filters...');
    const debugRaw = await callTool('list-mail-folder-messages', {
      mailFolderId: 'Inbox',
    });
    if (debugRaw?.content?.[0]?.text) {
      try {
        const rawData = JSON.parse(debugRaw.content[0].text);
        const rawItems = rawData.value || (Array.isArray(rawData) ? rawData : []);
        console.log(`[DEBUG /api/emails] Unfiltered: ${rawItems.length} messages returned`);
        if (rawItems.length > 0) {
          console.log(`[DEBUG /api/emails] First message: subject="${rawItems[0].subject}", isRead=${rawItems[0].isRead}, inferenceClassification=${rawItems[0].inferenceClassification}`);
        }
      } catch (e) {
        console.log(`[DEBUG /api/emails] Raw parse failed: ${e.message}`);
        console.log(`[DEBUG /api/emails] Raw text (first 500): ${debugRaw.content[0].text.slice(0, 500)}`);
      }
    } else {
      console.log('[DEBUG /api/emails] No content in raw response:', JSON.stringify(debugRaw).slice(0, 500));
    }

    // DEBUG: Step 2 — with isRead filter only
    console.log('[DEBUG /api/emails] Step 2: calling with filter "isRead eq false" only...');
    const debugFiltered = await callTool('list-mail-folder-messages', {
      mailFolderId: 'Inbox',
      filter: 'isRead eq false',
    });
    if (debugFiltered?.content?.[0]?.text) {
      try {
        const filtData = JSON.parse(debugFiltered.content[0].text);
        const filtItems = filtData.value || (Array.isArray(filtData) ? filtData : []);
        console.log(`[DEBUG /api/emails] isRead=false filter: ${filtItems.length} messages`);
      } catch (e) {
        console.log(`[DEBUG /api/emails] Filtered parse failed: ${e.message}`);
      }
    }

    // DEBUG: Step 3 — full call (original)
    console.log('[DEBUG /api/emails] Step 3: full call with all params...');
    const result = await callTool('list-mail-folder-messages', {
      mailFolderId: 'Inbox',
      filter: 'isRead eq false',
      top: 50,
      orderby: ['receivedDateTime desc'],
      select: ['id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'body', 'uniqueBody', 'bodyPreview', 'isRead', 'inferenceClassification'],
    });

    // DEBUG: Log raw MCP response
    console.log('[DEBUG /api/emails] Full call raw response:', JSON.stringify(result).slice(0, 1000));

    // Parse MCP result — content is an array of content blocks
    const emails = [];
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          try {
            const data = JSON.parse(block.text);
            const items = data.value || (Array.isArray(data) ? data : []);
            console.log(`[DEBUG /api/emails] Parsed ${items.length} items from full call`);
            let skippedOther = 0;
            for (const msg of items) {
              if (msg.inferenceClassification === 'other') { skippedOther++; continue; }
              emails.push({
                id: msg.id || '',
                sender: msg.from?.emailAddress?.name || msg.from?.emailAddress?.address || 'Unknown',
                senderEmail: msg.from?.emailAddress?.address || '',
                subject: msg.subject || '(No subject)',
                preview: (msg.bodyPreview || '').slice(0, 100),
                body: msg.body?.content || msg.bodyPreview || '',
                uniqueBody: msg.uniqueBody?.content || '',
                bodyType: msg.body?.contentType || 'text',
                time: msg.receivedDateTime || '',
                isRead: msg.isRead ?? false,
                to: (msg.toRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
                cc: (msg.ccRecipients || []).map(r => ({ name: r.emailAddress?.name || '', email: r.emailAddress?.address || '' })),
              });
            }
            console.log(`[DEBUG /api/emails] Skipped ${skippedOther} with inferenceClassification=other, kept ${emails.length}`);
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
      select: ['id', 'subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'body', 'uniqueBody', 'bodyPreview', 'isRead', 'inferenceClassification'],
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
                uniqueBody: msg.uniqueBody?.content || '',
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

    // DEBUG: Step 1 — wide date range (7 days back, 7 days forward)
    const debugStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const debugEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    console.log(`[DEBUG /api/calendar] Step 1: wide range ${debugStart} to ${debugEnd}`);
    const debugCal = await callTool('get-calendar-view', {
      startDateTime: debugStart,
      endDateTime: debugEnd,
    });
    if (debugCal?.content?.[0]?.text) {
      try {
        const rawCal = JSON.parse(debugCal.content[0].text);
        const rawItems = rawCal.value || (Array.isArray(rawCal) ? rawCal : []);
        console.log(`[DEBUG /api/calendar] Wide range: ${rawItems.length} events`);
        for (const e of rawItems.slice(0, 5)) {
          console.log(`[DEBUG /api/calendar]   - "${e.subject}" start=${e.start?.dateTime} end=${e.end?.dateTime}`);
        }
      } catch (e) {
        console.log(`[DEBUG /api/calendar] Wide parse failed: ${e.message}`);
        console.log(`[DEBUG /api/calendar] Raw text (first 500): ${debugCal.content[0].text.slice(0, 500)}`);
      }
    } else {
      console.log('[DEBUG /api/calendar] No content in wide response:', JSON.stringify(debugCal).slice(0, 500));
    }

    // DEBUG: Step 2 — today only (original params)
    console.log(`[DEBUG /api/calendar] Step 2: today only ${startDateTime} to ${endDateTime}`);
    const result = await callTool('get-calendar-view', {
      startDateTime,
      endDateTime,
      top: 20,
      orderby: ['start/dateTime asc'],
      select: ['id', 'subject', 'start', 'end', 'location', 'attendees'],
    });

    // DEBUG: Log raw response
    console.log('[DEBUG /api/calendar] Today raw response:', JSON.stringify(result).slice(0, 1000));

    const events = [];
    if (result?.content) {
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          try {
            const data = JSON.parse(block.text);
            const items = data.value || (Array.isArray(data) ? data : []);
            console.log(`[DEBUG /api/calendar] Parsed ${items.length} events from today call`);
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

// Match action item text to a source email using sender name, email address, and subject keywords
function matchItemToEmail(itemText, emailList) {
  const lower = itemText.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const email of emailList) {
    let score = 0;
    const senderFull = (email.sender || '').toLowerCase();
    const senderFirst = senderFull.split(' ')[0];
    const senderLast = senderFull.split(' ').slice(-1)[0];
    const senderEmail = (email.senderEmail || '').toLowerCase();
    const subject = (email.subject || '').toLowerCase();

    // Check sender first name (min 3 chars to avoid false positives)
    if (senderFirst.length >= 3 && lower.includes(senderFirst)) score += 3;
    // Check sender last name
    if (senderLast.length >= 3 && senderLast !== senderFirst && lower.includes(senderLast)) score += 2;
    // Check sender email address
    if (senderEmail && lower.includes(senderEmail)) score += 4;
    // Check for subject keywords (at least 2 words matching)
    const subjectWords = subject.split(/\s+/).filter(w => w.length >= 4);
    const subjectMatches = subjectWords.filter(w => lower.includes(w)).length;
    if (subjectMatches >= 2) score += 2;

    // Check for company/org names in parentheses from sender, e.g. "Christa (Apple)"
    const orgMatch = email.senderEmail?.match(/@(.+?)\./);
    if (orgMatch) {
      const org = orgMatch[1].toLowerCase();
      if (org.length >= 3 && !['gmail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud'].includes(org) && lower.includes(org)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = email;
    }
  }

  // Require at least a first-name match (score >= 3)
  return bestScore >= 3 ? bestMatch : null;
}

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

    // Backfill: for items missing receivedAt, match against current emails
    let backfilled = 0;
    for (const item of data.items) {
      if (item.receivedAt || item.source === 'calendar') continue;
      const matched = matchItemToEmail(item.text, emailList);
      if (matched) {
        item.receivedAt = matched.time;
        item.sourceId = matched.id;
        backfilled++;
      }
    }
    if (backfilled > 0) {
      saveActionItems(data);
      console.log(`[action-items/generate] Backfilled receivedAt for ${backfilled} items`);
    }

    const existingTexts = (data.items || []).map(i => i.text.toLowerCase());

    const toolkit = loadToolkit();
    const context = toolkit.blurb ? `\n\nContext about Milette's company: ${toolkit.blurb}` : '';

    const emailSummary = emailList.map(e => `- [ID:${e.id}] From: ${e.sender} (${e.senderEmail}) | Subject: ${e.subject} | receivedDateTime: ${e.time} | Preview: ${e.preview}`).join('\n');
    const calSummary = eventList.map(e => `- ${e.title} (${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`).join('\n');
    const existingSummary = existingTexts.length ? '\n\nExisting action items (DO NOT duplicate these):\n' + existingTexts.map(t => `- ${t}`).join('\n') : '';

    const prompt = `Here are Milette's unread emails:\n${emailSummary || '(none)'}\n\nHere is today's calendar:\n${calSummary || '(none)'}${existingSummary}\n\nExtract action items — things Milette needs to do, reply to, follow up on, or prepare for. Be specific with names and context (e.g. "Reply to Gabrielle at Aldea re: intro" not "Reply to email").

IMPORTANT: When an action item implies creating, preparing, or drafting something (a proposal, contract, deck, doc, etc.), always use the format "[action] [asset] for [context]" where context is the person, event, or purpose. Examples:
- "Create event proposal for April Event Collab"
- "Prepare sponsorship contract for PulpaTronics"
- "Draft pricing doc for Marc at X"
NEVER write vague items like "Create proposal" or "Prepare contract" — always include the specific context.

For each item, return a JSON object with:
- "text": the action item description
- "sourceId": the email ID (the [ID:...] value) this item came from, or "" for calendar items
- "receivedAt": copy the EXACT receivedDateTime string from the email, or null for calendar items
- "isIntro": true if this is an introduction/intro email

Return ONLY a valid JSON array of objects like: [{"text": "Reply to ...", "sourceId": "AAMk...", "receivedAt": "2026-03-06T10:00:00Z", "isIntro": false}]`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are Milette's personal assistant. Extract action items from her emails and calendar. Return ONLY a valid JSON array of objects with "text", "sourceId" (the email's [ID:...] value, or "" for calendar), "receivedAt" (copy the EXACT receivedDateTime string from the email, or null for calendar), and "isIntro" (boolean — true if the email is an introduction between people). No explanation, no markdown, just the JSON array.${context}`,
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
    for (const raw of newItems) {
      // Support both string[] (legacy) and object[] (new)
      const text = typeof raw === 'string' ? raw : raw?.text;
      let sourceId = typeof raw === 'object' ? raw?.sourceId || '' : '';
      let receivedAt = typeof raw === 'object' ? raw?.receivedAt || null : null;
      const isIntro = typeof raw === 'object' ? !!raw?.isIntro : false;
      if (typeof text !== 'string' || !text.trim()) continue;
      const lower = text.trim().toLowerCase();
      if (existingTexts.includes(lower)) continue;

      // Server-side matching as fallback when Claude didn't return receivedAt
      if (!receivedAt) {
        const matched = matchItemToEmail(text, emailList);
        if (matched) {
          receivedAt = matched.time;
          sourceId = sourceId || matched.id;
        }
      }

      data.items.push({
        id: randomUUID(),
        text: text.trim(),
        source: 'email',
        sourceId,
        createdAt: new Date().toISOString(),
        completedAt: null,
        completed: false,
        receivedAt: receivedAt || null,
        isIntro: isIntro,
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

app.patch('/api/action-items/:id/text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const data = loadActionItems();
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.text = text.trim();
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

// ── Quest Mode endpoints ────────────────────────────────────────────────────

app.get('/api/quests', (_req, res) => {
  const data = loadQuests();
  res.json(data);
});

app.post('/api/quest/generate', async (req, res) => {
  try {
    const { availableMinutes } = req.body;

    // Gather all data sources
    const actionData = loadActionItems();
    const fuData = loadFollowUps();
    const toolkit = loadToolkit();

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

    const incompleteActions = (actionData.items || []).filter(i => !i.completed);
    const incompleteFollowUps = (fuData.followUps || []).filter(f => !f.completed);
    const incompleteBlockers = (fuData.blockers || []).filter(b => !b.completed);
    const toolkitLinks = (toolkit.links || []).map(l => `- ${l.label}: ${l.url}`).join('\n');

    const actionsSummary = incompleteActions.map(i => {
      const age = i.receivedAt ? Math.round((Date.now() - new Date(i.receivedAt).getTime()) / (1000*60*60)) + 'h ago' : 'unknown age';
      return `- [ACTION id:${i.id}] ${i.text} (${age}, isIntro: ${!!i.isIntro}, sourceId: ${i.sourceId || 'none'})`;
    }).join('\n');

    const followUpsSummary = incompleteFollowUps.map(f => {
      const text = f.text || f.name || '';
      return `- [FOLLOWUP id:${f.id}] ${text} (type: ${f.type || 'unknown'}, email: ${f.recipientEmail || 'none'}, due: ${f.dueDate || 'none'})`;
    }).join('\n');

    const blockersSummary = incompleteBlockers.map(b =>
      `- [BLOCKER id:${b.id}] ${b.name}: ${b.task}`
    ).join('\n');

    const questEmails = emailList.slice(0, 20);
    const emailIndexMap = {}; // short index -> real email id
    const emailsSummary = questEmails.map((e, idx) => {
      emailIndexMap[idx] = e.id;
      // Extract URLs from the email body for Claude to use
      const bodyText = e.body || e.preview || '';
      const urlMatches = bodyText.match(/https?:\/\/[^\s<>")\]]+/g) || [];
      const uniqueUrls = [...new Set(urlMatches)].slice(0, 5);
      const urlsStr = uniqueUrls.length ? ` | URLs: ${uniqueUrls.join(', ')}` : '';
      return `- [EMAIL #${idx}] From: ${e.sender} (${e.senderEmail}) | Subject: ${e.subject} | Preview: ${(e.preview || '').slice(0, 120)}${urlsStr}`;
    }).join('\n');

    const calSummary = eventList.map(e =>
      `- ${e.title} (${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})`
    ).join('\n');

    // Gather recently completed quest tasks (last 24 hours)
    const questData = loadQuests();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentlyCompleted = (questData.quests || [])
      .filter(q => q.completedAt && new Date(q.completedAt).getTime() > oneDayAgo)
      .flatMap(q => q.completedTaskTitles || []);
    const recentlyCompletedSummary = recentlyCompleted.length
      ? recentlyCompleted.map(t => `- "${t}"`).join('\n')
      : '(none)';

    // Build blocker exclusion list — tasks mentioned in active blockers should not be in quest
    const blockerTaskNames = incompleteBlockers.map(b => b.task || '').filter(Boolean);
    const blockerExclusionSummary = blockerTaskNames.length
      ? blockerTaskNames.map(t => `- ${t}`).join('\n')
      : '(none)';

    const timeConstraint = availableMinutes
      ? `Milette has ${availableMinutes} minutes. Fit as many tasks as possible within this time, preferring to keep blocker+dependent pairs together. Cut the list at the time limit.`
      : `Milette has unlimited time. Include ALL tasks.`;

    const prompt = `Generate a quest plan for Milette. ${timeConstraint}

Action items:
${actionsSummary || '(none)'}

Follow-ups:
${followUpsSummary || '(none)'}

Blockers (active — do NOT create quest tasks for anything mentioned in these blockers, they are blocked until resolved):
${blockersSummary || '(none)'}

Tasks blocked by active blockers (DO NOT include these or anything similar in the quest):
${blockerExclusionSummary}

Recently completed quest tasks (DO NOT include these again — they are already done):
${recentlyCompletedSummary}

Unread emails:
${emailsSummary || '(none)'}

Today's calendar:
${calSummary || '(none)'}

Available toolkit links:
${toolkitLinks || '(none)'}

Time estimates:
- Email reply with Calendly link or short response: 1-2 min
- Email reply requiring a drafted response: 3-5 min
- Intro reply: 2-3 min
- Creating a simple one-pager: 20 min
- Creating a proposal doc: 30 min
- Creating a full deck: 45-60 min
- External tasks (form, contract): 5-10 min
- Follow-up emails: 2-3 min

Orientation tasks:
If 2+ tasks share a common theme or context dependency (e.g. multiple emails about the same project, event series, or funding round), prepend ONE "orientation" task of type "orientation" immediately before that group.
- The orientation task helps Milette get a clear picture before diving into individual responses.
- Set its blocksTaskIds to the ids of all tasks that depend on understanding this context.
- estimatedMinutes: 2-5 min depending on complexity.
- Only create orientation tasks when genuinely useful — don't force them for unrelated tasks.

Exclusion rules (CRITICAL — follow these strictly):
1. NEVER include tasks that match or overlap with active blockers — if a blocker says "Confirm Women of Impact attendance", do NOT create a task about confirming Women of Impact attendance
2. NEVER include tasks that appear in the "Recently completed quest tasks" list — they are already done
3. NEVER include tasks for emails that are about the same topic as a completed task or active blocker
4. Every task MUST have at least one email in relatedEmailIds (referencing an [EMAIL #N] from the list above). If an action item or follow-up has no matching unread email, do NOT include it as a quest task — it cannot be acted on right now

Ordering rules:
1. Sort by urgency tier (red > orange > yellow > none)
2. Within each urgency tier: tasks with no blockers first, sorted by estimatedMinutes ascending
3. Tasks with blockers after — insert the blocker as a task immediately before its dependent task
4. Orientation tasks always appear immediately before the group of tasks they block

Urgency rules: items received >48h ago = red, >24h = orange, >12h = yellow, else none. Follow-ups with dueDate past = red, within 24h = orange, within 72h = yellow.

Return ONLY valid JSON:
{
  "questName": "Short evocative name (2-4 words, e.g. 'The Sunday Clear', 'Morning Sprint', 'The Inbox Blitz')",
  "totalEstimatedMinutes": number,
  "tasks": [
    {
      "id": "use the EXACT id from the source item (action/followup/blocker) where possible, or generate a new UUID for orientation tasks",
      "title": "Short action title",
      "instruction": "One sentence telling Milette exactly what to do",
      "type": "email-reply | create-asset | external-task | follow-up | orientation",
      "estimatedMinutes": number,
      "urgency": "red | orange | yellow | none",
      "hasBlocker": false,
      "isBlockerFor": "dependent task id or null",
      "blocksTaskIds": ["array of task ids this orientation task blocks — only used for type=orientation, use [] for other types"],
      "relatedEmailIds": [0, 3, 7, "← use the SHORT numeric indices from [EMAIL #N] tags. Include ALL related emails: source email, auto-notifications about the same topic, personal emails needing response. Check ALL 20 emails. Use [] if none."],
      "relatedActionItemId": "action item id or null",
      "relatedFollowUpId": "follow-up id or null",
      "url": "for external-task type: use the EXACT full URL from the email's URLs list (not a shortened or domain-only version). If no actionable URL found, use null and the user will find it in the email.",
      "suggestedAction": "what the app should do e.g. 'open email + pre-draft response' or 'mark done when ready'"
    }
  ]
}`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are Milette's personal assistant building a gamified task quest. Analyse her pending work, estimate times, sort by urgency, and return a structured quest plan. Return ONLY valid JSON, no markdown, no explanation. Be specific in instructions — use real names and context from the data.`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) rawResult = message.result;
    }

    let quest;
    try {
      const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) quest = JSON.parse(jsonMatch[0]);
      else throw new Error('No JSON object found');
    } catch (e) {
      console.error('[quest/generate] Failed to parse:', e.message);
      return res.status(500).json({ error: 'Failed to parse quest from Claude' });
    }

    // Ensure each task has an id
    for (const task of quest.tasks || []) {
      if (!task.id) task.id = randomUUID();
    }

    console.log(`[quest/generate] "${quest.questName}" — ${(quest.tasks || []).length} tasks, ~${quest.totalEstimatedMinutes} min`);
    for (const task of quest.tasks || []) {
      // Normalize: support both old relatedEmailId (string) and new relatedEmailIds (array)
      if (task.relatedEmailId && !task.relatedEmailIds) {
        task.relatedEmailIds = [task.relatedEmailId];
      }
      if (!task.relatedEmailIds) task.relatedEmailIds = [];
      delete task.relatedEmailId;
      // Map short numeric indices back to real email IDs
      task.relatedEmailIds = task.relatedEmailIds
        .map(idx => {
          if (typeof idx === 'number' && emailIndexMap[idx]) return emailIndexMap[idx];
          if (typeof idx === 'string' && emailIndexMap[parseInt(idx)]) return emailIndexMap[parseInt(idx)];
          return idx; // already a real ID
        })
        .filter(id => typeof id === 'string' && id.length > 5); // drop any unmapped indices
      // Ensure blocksTaskIds exists
      if (!task.blocksTaskIds) task.blocksTaskIds = [];
      const blocksStr = task.blocksTaskIds.length ? ` blocks=[${task.blocksTaskIds.length}]` : '';
      console.log(`[quest/generate]   task "${task.title}" type=${task.type} relatedEmailIds=[${task.relatedEmailIds.length}]${blocksStr} url=${task.url || 'NULL'}`);
    }
    // Filter out tasks with no email association (except orientation tasks which don't need one)
    const before = quest.tasks.length;
    quest.tasks = quest.tasks.filter(t => t.type === 'orientation' || t.relatedEmailIds.length > 0);
    if (quest.tasks.length < before) {
      console.log(`[quest/generate] Dropped ${before - quest.tasks.length} tasks with no email association`);
    }
    // Recalculate total time
    quest.totalEstimatedMinutes = quest.tasks.reduce((sum, t) => sum + (t.estimatedMinutes || 0), 0);
    res.json(quest);
  } catch (err) {
    console.error('[quest/generate] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quest/complete', (req, res) => {
  const { name, tasksCompleted, totalMinutes, completedTaskTitles } = req.body;
  const data = loadQuests();
  data.quests.push({
    id: randomUUID(),
    name: name || 'Quest',
    completedAt: new Date().toISOString(),
    tasksCompleted: tasksCompleted || 0,
    totalMinutes: totalMinutes || 0,
    completedTaskTitles: completedTaskTitles || [],
  });
  saveQuests(data);
  res.json({ ok: true });
});

// Detect which quest tasks share context with a given task
app.post('/api/quest/related-tasks', async (req, res) => {
  try {
    const { taskId, contextText, tasks } = req.body;
    if (!tasks || !taskId) return res.status(400).json({ error: 'Missing tasks or taskId' });

    const currentTask = tasks.find(t => t.id === taskId);
    if (!currentTask) return res.status(400).json({ error: 'Task not found' });

    const otherTasks = tasks.filter(t => t.id !== taskId);
    if (otherTasks.length === 0) return res.json({ relatedTaskIds: [] });

    const taskList = otherTasks.map(t => `- [${t.id}] "${t.title}" (type: ${t.type})`).join('\n');

    const prompt = `The user is working on this quest task: "${currentTask.title}"
They said they need context first: "${contextText}"

Here are the other tasks in their quest:
${taskList}

Which of these tasks share the same context/theme dependency — i.e. the user would ALSO need the same context "${contextText}" before doing them?

Return ONLY a JSON array of task ids that share this context. Return [] if none are related.
Example: ["id1", "id2"]`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: 'You detect shared context between tasks. Return ONLY a JSON array of task IDs. No explanation.',
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) rawResult = message.result;
    }

    let relatedIds = [];
    try {
      const match = rawResult.match(/\[[\s\S]*?\]/);
      if (match) relatedIds = JSON.parse(match[0]);
    } catch (e) {
      console.error('[quest/related-tasks] Parse error:', e.message);
    }

    // Filter to only valid task ids
    const validIds = new Set(otherTasks.map(t => t.id));
    relatedIds = relatedIds.filter(id => validIds.has(id));

    console.log(`[quest/related-tasks] "${currentTask.title}" context="${contextText}" → ${relatedIds.length} related tasks`);
    res.json({ relatedTaskIds: relatedIds });
  } catch (err) {
    console.error('[quest/related-tasks] ERROR:', err.message);
    res.json({ relatedTaskIds: [] });
  }
});

// Generate blocker suggestions from action items
app.post('/api/blockers/generate', async (_req, res) => {
  try {
    const actionData = loadActionItems();
    const fuData = loadFollowUps();
    const toolkit = loadToolkit();

    const incompleteItems = (actionData.items || []).filter(i => !i.completed);
    const existingBlockers = (fuData.blockers || []).map(b => b.name.toLowerCase());
    const toolkitLinks = (toolkit.links || []).map(l => `- ${l.label}: ${l.url}`).join('\n');

    const itemsList = incompleteItems.map(i => `- ${i.text}`).join('\n');

    const prompt = `Here are Milette's current action items:\n${itemsList || '(none)'}\n\nHere are the links/assets already available in her toolkit:\n${toolkitLinks || '(none)'}\n\nHere are her existing blockers (do NOT suggest these again):\n${existingBlockers.map(b => `- ${b}`).join('\n') || '(none)'}\n\nIdentify action items that require an asset Milette doesn't already have — things like proposals, contracts, decks, forms, graphics, invoices, or documents that need to be created before the action item can be completed.\n\nFor each missing asset, return a blocker in the format "[action] [asset] for [context]". Always include the specific context (person, event, or purpose). Never return vague blockers like "Create proposal" — always say "Create event proposal for April Event Collab".\n\nReturn ONLY a valid JSON array of objects like: [{"text": "Create event proposal for April Event Collab", "impliedBy": "Send event proposal to Bidisa Mukherjee for April Event Collab sponsorship outreach"}]\n\nIf there are no missing assets, return an empty array: []`;

    let rawResult = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are Milette's personal assistant. Analyse her action items to find implied blockers — assets or documents that need to be created before action items can be completed. Return ONLY a valid JSON array. No explanation, no markdown.`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) rawResult = message.result;
    }

    let suggestions = [];
    try {
      const jsonMatch = rawResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) suggestions = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[blockers/generate] Failed to parse:', e.message);
      return res.status(500).json({ error: 'Failed to parse blocker suggestions' });
    }

    // Filter out duplicates of existing blockers
    suggestions = suggestions.filter(s => {
      const lower = (s.text || '').toLowerCase();
      return lower && !existingBlockers.includes(lower);
    });

    console.log(`[blockers/generate] ${suggestions.length} suggestions`);
    res.json({ suggestions });
  } catch (err) {
    console.error('[blockers/generate] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate follow-up suggestions from calendar + sent emails
app.post('/api/followups/generate', async (_req, res) => {
  try {
    const fuData = loadFollowUps();
    const existingTexts = (fuData.followUps || []).map(f => (f.text || f.name || '').toLowerCase());

    // ── Part A: Post-call follow-ups from calendar ──
    const events = getCached('calendar') || [];
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    // Events that have ended today with attendees
    const endedEvents = events.filter(evt => {
      if (!evt.end || !evt.attendees || evt.attendees.length === 0) return false;
      const endTime = new Date(evt.end);
      return endTime <= now && evt.start && evt.start.split('T')[0] === todayStr;
    });

    const postCallSuggestions = endedEvents.map(evt => ({
      type: 'post-call',
      text: `Follow up with ${evt.attendees[0]} after ${evt.title}`,
      dueDate: todayStr,
      recipientEmail: '',
      confidence: null,
      source: evt.title,
    })).filter(s => !existingTexts.includes(s.text.toLowerCase()));

    // ── Part B: Awaiting-reply from sent emails ──
    let awaitingSuggestions = [];
    try {
      // Fetch recent sent emails (last 7 days)
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const sentResult = await callTool('list-mail-folder-messages', {
        mailFolderId: 'SentItems',
        filter: `sentDateTime ge ${sevenDaysAgo}`,
        top: 30,
        orderby: ['sentDateTime desc'],
        select: ['id', 'subject', 'toRecipients', 'sentDateTime', 'bodyPreview', 'conversationId'],
      });

      let sentEmails = [];
      if (sentResult?.content?.[0]?.text) {
        try { sentEmails = JSON.parse(sentResult.content[0].text); } catch {}
        if (!Array.isArray(sentEmails) && sentEmails?.value) sentEmails = sentEmails.value;
      }

      // Fetch recent inbox to cross-reference replies
      const inboxResult = await callTool('list-mail-folder-messages', {
        mailFolderId: 'Inbox',
        filter: `receivedDateTime ge ${sevenDaysAgo}`,
        top: 50,
        orderby: ['receivedDateTime desc'],
        select: ['id', 'subject', 'from', 'receivedDateTime', 'conversationId'],
      });

      let inboxEmails = [];
      if (inboxResult?.content?.[0]?.text) {
        try { inboxEmails = JSON.parse(inboxResult.content[0].text); } catch {}
        if (!Array.isArray(inboxEmails) && inboxEmails?.value) inboxEmails = inboxEmails.value;
      }

      // Find sent emails with no reply (by conversationId)
      const repliedConversations = new Set(inboxEmails.map(e => e.conversationId).filter(Boolean));
      const unreplied = sentEmails.filter(e => e.conversationId && !repliedConversations.has(e.conversationId));

      if (unreplied.length > 0) {
        // Ask Claude to analyse which ones need follow-up
        const emailSummaries = unreplied.slice(0, 15).map(e => {
          const to = (e.toRecipients || []).map(r => r?.emailAddress?.name || r?.emailAddress?.address || '').join(', ');
          return `- To: ${to} | Subject: ${e.subject || '(no subject)'} | Sent: ${e.sentDateTime || ''} | Preview: ${(e.bodyPreview || '').slice(0, 100)}`;
        }).join('\n');

        let rawResult = '';
        for await (const message of query({ prompt: `Here are Milette's sent emails from the last 7 days that haven't received a reply:\n\n${emailSummaries}\n\nFor each email, decide if Milette should follow up. Consider:\n- Is it a request that expects a response?\n- Has enough time passed (2+ days)?\n- Is it just a "thanks" or FYI that doesn't need a reply?\n\nReturn ONLY a valid JSON array of objects for emails that DO need follow-up:\n[{"text": "Follow up with [Name] re: [subject/context]", "recipientEmail": "email@example.com", "confidence": "definite|likely|maybe", "sentDate": "ISO date"}]\n\nIf none need follow-up, return: []`, options: {
          systemPrompt: 'You are Milette\'s personal assistant. Analyse sent emails to identify ones awaiting a reply. Return ONLY valid JSON. No explanation, no markdown.',
          tools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          maxTurns: 1,
        }})) {
          if ('result' in message) rawResult = message.result;
        }

        try {
          const jsonMatch = rawResult.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            awaitingSuggestions = parsed.map(s => ({
              type: 'awaiting-reply',
              text: s.text || '',
              recipientEmail: s.recipientEmail || '',
              confidence: s.confidence || 'maybe',
              dueDate: null,
              source: 'sent-email',
            })).filter(s => s.text && !existingTexts.includes(s.text.toLowerCase()));
          }
        } catch (e) {
          console.error('[followups/generate] Failed to parse awaiting-reply:', e.message);
        }
      }
    } catch (err) {
      console.error('[followups/generate] Error fetching sent emails:', err.message);
      // Continue with just post-call suggestions
    }

    const suggestions = [...postCallSuggestions, ...awaitingSuggestions];
    console.log(`[followups/generate] ${postCallSuggestions.length} post-call, ${awaitingSuggestions.length} awaiting-reply`);
    res.json({ suggestions });
  } catch (err) {
    console.error('[followups/generate] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Follow-ups & Blockers endpoints ──────────────────────────────────────────

app.get('/api/follow-ups', (_req, res) => {
  const data = loadFollowUps();
  res.json(data);
});

app.patch('/api/follow-ups/:id/text', (req, res) => {
  const { name, task, text } = req.body;
  const data = loadFollowUps();
  const item = [...data.followUps, ...data.blockers].find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  // Support both new format (text) and old format (name/task) for blockers
  if (text !== undefined) item.text = text.trim();
  if (name !== undefined) item.name = name.trim();
  if (task !== undefined) item.task = task.trim();
  saveFollowUps(data);
  res.json({ ok: true, item });
});

app.patch('/api/follow-ups/:id/toggle', (req, res) => {
  const data = loadFollowUps();
  const item = [...data.followUps, ...data.blockers].find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.completed = !item.completed;
  item.completedAt = item.completed ? new Date().toISOString() : null;
  saveFollowUps(data);
  res.json({ ok: true, item });
});

app.post('/api/follow-ups', (req, res) => {
  const { type } = req.body;
  const data = loadFollowUps();

  let item;
  if (type === 'blocker') {
    // Blockers use name/task format
    item = {
      id: randomUUID(),
      name: req.body.name || '',
      dueDate: req.body.dueDate || null,
      task: req.body.task || '',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };
    data.blockers.push(item);
  } else {
    // Follow-ups use new format: type, confidence, text, recipientEmail
    item = {
      id: randomUUID(),
      type: req.body.followUpType || 'post-call',
      confidence: req.body.confidence || null,
      text: req.body.text || req.body.name || '',
      dueDate: req.body.dueDate || null,
      recipientEmail: req.body.recipientEmail || req.body.email || '',
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
    };
    data.followUps.push(item);
  }
  saveFollowUps(data);
  res.json({ ok: true, item });
});

app.delete('/api/follow-ups/:id', (req, res) => {
  const data = loadFollowUps();
  data.followUps = data.followUps.filter(i => i.id !== req.params.id);
  data.blockers = data.blockers.filter(i => i.id !== req.params.id);
  saveFollowUps(data);
  res.json({ ok: true });
});

// Draft a follow-up email from a follow-up item
app.post('/api/follow-ups/:id/draft', async (req, res) => {
  try {
    const data = loadFollowUps();
    const item = data.followUps.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Follow-up not found' });
    const recipientEmail = item.recipientEmail || item.email || '';
    if (!recipientEmail) return res.status(400).json({ error: 'No email address stored for this follow-up' });

    const { instruction } = req.body;
    const toolkit = loadToolkit();
    const linksList = (toolkit.links || []).map(l => `- ${l.label}: ${l.url}`).join('\n');
    const rulesText = (toolkit.writingRules || []).map(r => `- ${r}`).join('\n');
    const bannedText = (toolkit.bannedPhrases || []).map(p => `- "${p}"`).join('\n');

    const itemText = item.text || item.name || '';
    const itemTask = item.task || '';
    const prompt = `Draft a follow-up email to ${recipientEmail}.
Context: ${itemText}${itemTask ? `\nTask: ${itemTask}` : ''}
${instruction ? `Additional instruction: ${instruction}` : ''}

Available links to include if relevant:
${linksList}

Writing rules:
${rulesText}

Banned phrases (never use these):
${bannedText}

Context about Milette's company: ${toolkit.blurb || ''}

Write ONLY the email body. No subject line. Sign off: "All the best, Milette"`;

    let draft = '';
    for await (const message of query({ prompt, options: {
      systemPrompt: `You are Milette's email drafting assistant. Write concise, direct emails following her writing rules exactly. Return ONLY the email body text, nothing else.`,
      tools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    }})) {
      if ('result' in message) draft = message.result;
    }

    // Post-process links
    draft = formatDraftLinks(draft);

    res.json({ draft, to: recipientEmail, name: itemText });
  } catch (err) {
    console.error('[follow-ups/draft] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send a follow-up email (not a reply — a new email)
app.post('/api/follow-ups/:id/send', async (req, res) => {
  try {
    const data = loadFollowUps();
    const item = data.followUps.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Follow-up not found' });
    const recipientEmail = item.recipientEmail || item.email || '';
    if (!recipientEmail) return res.status(400).json({ error: 'No email address' });

    const { draftText, subject } = req.body;
    if (!draftText) return res.status(400).json({ error: 'draftText is required' });

    const htmlBody = draftToHtml(draftText);
    const itemText = item.text || item.name || '';

    const mcpClient = await getMcpClient();
    await mcpClient.callTool({
      name: 'send-mail-message',
      arguments: {
        to: recipientEmail,
        subject: subject || `Following up - ${itemText}`,
        body: htmlBody,
        bodyType: 'html',
      },
    });

    // Mark as completed
    item.completed = true;
    item.completedAt = new Date().toISOString();
    saveFollowUps(data);

    res.json({ success: true });
  } catch (err) {
    console.error('[follow-ups/send] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
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
