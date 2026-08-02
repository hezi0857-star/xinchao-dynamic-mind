/**
 * MCP (Model Context Protocol) Streamable HTTP handler for xinchao-dynamic-mind.
 * Implements JSON-RPC 2.0 over HTTP POST at /mcp.
 * Supports: initialize, tools/list, tools/call
 */

const SERVER_INFO = {
  name: 'xinchao-dynamic-mind',
  version: '2.0.0',
};

const CAPABILITIES = {
  tools: {},
};

const TOOLS = [
  {
    name: 'xinchao_context',
    description: '获取当前动态上下文信封（Context Envelope）。包含：驱动力短态、当前意图、梦境余韵、交接便签。每次对话开始时调用一次即可获得完整上下文。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xinchao_intent',
    description: '获取心潮当前的行动意图、驱动力状态、念头池和疲惫度。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xinchao_state',
    description: '获取心潮完整的动态状态，包括所有驱动力数值、睡眠状态等详细信息。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xinchao_event',
    description: '向心潮反馈一次对话/互动事件。当对话中满足了某些驱动力（如亲密、分享、好奇等），或产生了新念头时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        satisfied_drives: {
          type: 'string',
          description: '被满足的驱动力，逗号分隔。可选值：intimacy, miss, share, curiosity, responsibility, reflection, play, creation, growth, rest, autonomy, social',
        },
        flash_thoughts: {
          type: 'string',
          description: '闪念内容，JSON格式的数组字符串，如 [{"key":"curiosity","text":"想研究这个问题","intensity":0.8}]',
        },
        event_id: {
          type: 'string',
          description: '幂等事件ID。相同event_id不会重复结算。可选。',
        },
      },
      required: [],
    },
  },
  {
    name: 'xinchao_feedback',
    description: '对指定驱动力增加或减少反馈值。用于精细调整单个驱动力。',
    inputSchema: {
      type: 'object',
      properties: {
        drive: {
          type: 'string',
          description: '驱动力名称：possess, monitor, crave, share, libido, curiosity, boredom, social, duty, reflection, grieve, anger',
        },
        delta: {
          type: 'string',
          description: '变化量，正数增加负数减少，范围 -1.0 到 1.0',
        },
      },
      required: ['drive', 'delta'],
    },
  },
  {
    name: 'xinchao_settle',
    description: '手动触发一次状态结算。通常不需要手动调用，心潮会自动定时结算。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xinchao_heartbeat',
    description: '向心潮发送一次心跳，告知用户仍在活跃。这是推送通知的前置条件——心潮只在收到heartbeat后才会发送推送。每次对话结束时调用一次。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'xinchao_handoff_note',
    description: '保存一条跨对话交接便签。用于在对话结束时记录关键进展、待办或上下文，供下次对话通过xinchao_context自动获取。最多1200字，72小时后自动过期。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '交接便签内容。简洁记录本次对话的关键进展、未完成事项或需要下次继续的上下文。不要放聊天原文、密钥或长段引用。最多1200字。',
        },
      },
      required: ['content'],
    },
  },
];

// Drive name mapping (friendly → internal)
const DRIVE_MAP = {
  intimacy: 'possess',
  miss: 'monitor',
  share: 'share',
  curiosity: 'curiosity',
  responsibility: 'duty',
  reflection: 'reflection',
  play: 'boredom',
  creation: 'crave',
  growth: 'curiosity',
  rest: 'grieve',
  autonomy: 'anger',
  social: 'social',
  // Direct names also work
  possess: 'possess',
  monitor: 'monitor',
  crave: 'crave',
  libido: 'libido',
  boredom: 'boredom',
  duty: 'duty',
  grieve: 'grieve',
  anger: 'anger',
};

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function createMcpHandler({ store, runCycle, engine, topDrives, pickIntent }) {
  const {
    applyConversationEvent,
    applyDriveFeedback,
  } = engine;

  const sessions = new Map();
  const handoffNotes = [];
  const processedEventIds = new Set();
  const HANDOFF_TTL_MS = 72 * 3_600_000;
  const HANDOFF_MAX_CHARS = 1200;

  function getOrCreateSession(req) {
    const existing = req.headers['mcp-session-id'];
    if (existing && sessions.has(existing)) return existing;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.set(id, { createdAt: Date.now() });
    if (sessions.size > 100) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    return id;
  }

  function getActiveHandoffNotes() {
    const now = Date.now();
    while (handoffNotes.length > 0 && now - handoffNotes[0].createdAt > HANDOFF_TTL_MS) {
      handoffNotes.shift();
    }
    return handoffNotes.slice(-5);
  }

  function buildContextEnvelope(state) {
    const intent = pickIntent(state);
    const top = topDrives(state);
    const recentDream = (state.recentDreams ?? []).slice(-1)[0];
    const notes = getActiveHandoffNotes();

    return {
      consciousness: state.consciousness,
      intent: intent ? { key: intent.key, label: intent.label, value: intent.value } : null,
      topDrives: top.map((d) => ({ key: d.key, label: d.label, value: d.value })),
      fatigue: state.fatigue ?? 0,
      dreamResidue: recentDream?.residue ? { text: recentDream.residue, awareness: recentDream.awareness, dreamedAt: recentDream.createdAt } : null,
      handoffNotes: notes.map((n) => ({ content: n.content, createdAt: new Date(n.createdAt).toISOString() })),
      pendingAwareness: state.pendingAwareness,
      generatedAt: new Date().toISOString(),
    };
  }

  async function handleToolCall(name, args) {
    switch (name) {
      case 'xinchao_context': {
        const state = await store.read();
        return { success: true, data: buildContextEnvelope(state) };
      }

      case 'xinchao_intent': {
        const state = await store.read();
        const intent = pickIntent(state);
        return { success: true, data: { intent, topDrives: topDrives(state), thoughtPool: state.thoughtPool ?? null, fatigue: state.fatigue ?? 0 } };
      }

      case 'xinchao_state': {
        const state = await store.read();
        return { success: true, data: state };
      }

      case 'xinchao_event': {
        const now = new Date();
        const event = {};

        // Event ID idempotency
        if (args.event_id) {
          if (processedEventIds.has(args.event_id)) {
            return { success: true, data: { deduplicated: true, event_id: args.event_id } };
          }
          processedEventIds.add(args.event_id);
          // Keep set bounded
          if (processedEventIds.size > 500) {
            const first = processedEventIds.values().next().value;
            processedEventIds.delete(first);
          }
        }

        if (args.satisfied_drives) {
          const drives = args.satisfied_drives.split(',').map((s) => s.trim()).filter(Boolean);
          event.satisfiedDrives = drives.map((d) => DRIVE_MAP[d] ?? d).filter(Boolean);
        }

        if (args.flash_thoughts) {
          try {
            event.flashThoughts = JSON.parse(args.flash_thoughts);
          } catch {
            event.flashThoughts = [];
          }
        }

        const state = await store.update((current) => applyConversationEvent(current, event, now).state);
        return { success: true, data: { revision: state.revision, consciousness: state.consciousness } };
      }

      case 'xinchao_feedback': {
        const drive = DRIVE_MAP[args.drive] ?? args.drive;
        const delta = Number(args.delta);
        if (!drive || !Number.isFinite(delta)) {
          return { success: false, error: 'Invalid drive or delta' };
        }
        const state = await store.update((current) => applyDriveFeedback(current, { [drive]: delta }, new Date()));
        return { success: true, data: { revision: state.revision, topDrives: topDrives(state) } };
      }

      case 'xinchao_settle': {
        const result = await runCycle();
        return { success: true, data: { revision: result.state.revision, consciousness: result.state.consciousness, dreamCreated: result.dreamCreated, barkSent: result.barkSent } };
      }

      case 'xinchao_heartbeat': {
        const now = new Date();
        const state = await store.update((current) => {
          const result = applyConversationEvent(current, {}, now);
          result.state.lastHeartbeatAt = now.toISOString();
          return result.state;
        });
        return { success: true, data: { revision: state.revision, consciousness: state.consciousness, pendingAwareness: state.pendingAwareness } };
      }

      case 'xinchao_handoff_note': {
        const content = String(args.content ?? '').slice(0, HANDOFF_MAX_CHARS).trim();
        if (!content) return { success: false, error: 'Content is required' };
        handoffNotes.push({ content, createdAt: Date.now() });
        // Keep bounded
        while (handoffNotes.length > 10) handoffNotes.shift();
        return { success: true, data: { saved: true, expiresAt: new Date(Date.now() + HANDOFF_TTL_MS).toISOString() } };
      }

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  async function handleRequest(body) {
    const { id, method, params } = body;

    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        });

      case 'notifications/initialized':
        return null; // No response needed for notifications

      case 'tools/list':
        return jsonRpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args = {} } = params ?? {};
        if (!name) return jsonRpcError(id, -32602, 'Missing tool name');
        try {
          const result = await handleToolCall(name, args);
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          });
        } catch (error) {
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }],
            isError: true,
          });
        }
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async function mcpHandler(req, res) {
    const sessionId = getOrCreateSession(req);

    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Mcp-Session-Id': sessionId,
      });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready' })}\n\n`);
      req.on('close', () => res.end());
      return;
    }

    if (req.method === 'DELETE') {
      sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST - handle JSON-RPC
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request too large' }));
        return;
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    // Handle batch requests
    if (Array.isArray(parsed)) {
      const results = [];
      for (const item of parsed) {
        const result = await handleRequest(item);
        if (result !== null) results.push(result);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Mcp-Session-Id': sessionId });
      res.end(JSON.stringify(results));
      return;
    }

    const result = await handleRequest(parsed);
    if (result === null) {
      res.writeHead(204, { 'Mcp-Session-Id': sessionId });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Mcp-Session-Id': sessionId });
    res.end(JSON.stringify(result));
  };
}
