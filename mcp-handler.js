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
    name: 'xinchao_intent',
    description: '获取心潮当前的行动意图、驱动力状态、念头池和疲惫度。每次对话开始时调用一次，了解AI当前的内在状态和最想做的事。',
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

  async function handleToolCall(name, args) {
    switch (name) {
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
    if (req.method === 'GET') {
      // SSE endpoint for server-initiated messages (not needed for basic usage)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready' })}\n\n`);
      req.on('close', () => res.end());
      return;
    }

    if (req.method === 'DELETE') {
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
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(results));
      return;
    }

    const result = await handleRequest(parsed);
    if (result === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  };
}
