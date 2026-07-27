# server.js 需要的修改

在 import 区域加一行：
```js
import { createMcpHandler } from './mcp-handler.js';
```

在 `server.listen` 之前加：
```js
const mcpHandler = createMcpHandler({
  store,
  runCycle,
  engine: { applyConversationEvent, applyDriveFeedback },
  topDrives,
  pickIntent,
});
```

在 createServer 的 request handler 里，health 路由之后、auth 检查之前，加 /mcp 路由：
```js
if (url.pathname === '/mcp') {
  if (!authorized(request)) return send(response, 401, { error: 'unauthorized' });
  return mcpHandler(request, response);
}
```
