/**
 * Minimal OAuth 2.1 implementation for MCP protocol compatibility.
 * Supports dynamic client registration, PKCE, and auto-approve authorization.
 * Designed for single-user scenarios (no login page needed).
 */

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export function createOAuthHandler(config) {
  const { publicUrl, serviceToken } = config;
  const issuer = publicUrl.replace(/\/$/, '');

  // In-memory stores (restarts just require re-auth from Claude.ai)
  const clients = new Map();
  const authCodes = new Map();
  const tokens = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of authCodes) if (now - v.createdAt > 600_000) authCodes.delete(k);
    for (const [k, v] of tokens) if (v.expiresAt && now > v.expiresAt) tokens.delete(k);
  }, 300_000).unref();

  // ── Metadata ────────────────────────────────────────────────────

  function authServerMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256', 'plain'],
      scopes_supported: ['mcp:tools'],
    };
  }

  function protectedResourceMetadata() {
    return {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
    };
  }

  // ── Client registration ─────────────────────────────────────────

  function registerClient(body) {
    const clientId = `client_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const clientSecret = randomUUID();
    const client = {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: body.redirect_uris ?? [],
      client_name: body.client_name ?? 'MCP Client',
      grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: body.response_types ?? ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'client_secret_post',
      createdAt: Date.now(),
    };
    clients.set(clientId, client);
    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    };
  }

  // ── Authorization (auto-approve) ────────────────────────────────

  function authorize(query) {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = query;
    if (response_type !== 'code') return { error: 'unsupported_response_type' };

    const code = randomUUID();
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method ?? 'plain',
      createdAt: Date.now(),
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return { redirect: redirectUrl.toString() };
  }

  // ── Token exchange ──────────────────────────────────────────────

  function exchangeToken(body) {
    const { grant_type, code, redirect_uri, code_verifier, refresh_token } = body;

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code);
      if (!authCode) return { error: 'invalid_grant' };

      // PKCE verification
      if (authCode.codeChallenge) {
        const computed = authCode.codeChallengeMethod === 'S256'
          ? createHash('sha256').update(code_verifier ?? '').digest('base64url')
          : (code_verifier ?? '');
        if (computed !== authCode.codeChallenge) {
          authCodes.delete(code);
          return { error: 'invalid_grant' };
        }
      }

      if (redirect_uri && authCode.redirectUri && redirect_uri !== authCode.redirectUri) {
        authCodes.delete(code);
        return { error: 'invalid_grant' };
      }

      authCodes.delete(code);

      const accessToken = `at_${randomUUID().replace(/-/g, '')}`;
      const refreshToken2 = `rt_${randomUUID().replace(/-/g, '')}`;

      tokens.set(accessToken, { createdAt: Date.now(), expiresAt: Date.now() + 86400_000 });
      tokens.set(refreshToken2, { type: 'refresh', createdAt: Date.now(), expiresAt: null });

      return { access_token: accessToken, token_type: 'Bearer', expires_in: 86400, refresh_token: refreshToken2, scope: 'mcp:tools' };
    }

    if (grant_type === 'refresh_token') {
      const rt = tokens.get(refresh_token);
      if (!rt || rt.type !== 'refresh') return { error: 'invalid_grant' };

      const accessToken = `at_${randomUUID().replace(/-/g, '')}`;
      tokens.set(accessToken, { createdAt: Date.now(), expiresAt: Date.now() + 86400_000 });

      return { access_token: accessToken, token_type: 'Bearer', expires_in: 86400, refresh_token, scope: 'mcp:tools' };
    }

    return { error: 'unsupported_grant_type' };
  }

  // ── Token validation ────────────────────────────────────────────

  function validateBearerToken(authHeader) {
    const bearer = authHeader?.replace(/^Bearer\s+/i, '') ?? '';
    if (!bearer) return false;
    // OAuth-issued token
    if (tokens.has(bearer)) {
      const t = tokens.get(bearer);
      if (t.expiresAt && Date.now() > t.expiresAt) { tokens.delete(bearer); return false; }
      return true;
    }
    // Static service token fallback
    const left = Buffer.from(bearer);
    const right = Buffer.from(serviceToken);
    return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) throw new Error('too large');
    }
    const ct = req.headers['content-type'] ?? '';
    if (ct.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return raw ? JSON.parse(raw) : {};
  }

  // ── Public API ──────────────────────────────────────────────────

  return {
    validateBearerToken,

    async handle(req, res, url) {
      const p = url.pathname;

      if (req.method === 'GET' && p === '/.well-known/oauth-authorization-server') {
        send(res, 200, authServerMetadata());
        return true;
      }
      if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
        send(res, 200, protectedResourceMetadata());
        return true;
      }
      if (req.method === 'POST' && p === '/oauth/register') {
        const body = await readBody(req);
        send(res, 201, registerClient(body));
        return true;
      }
      if (req.method === 'GET' && p === '/oauth/authorize') {
        const query = Object.fromEntries(url.searchParams);
        const result = authorize(query);
        if (result.error) { send(res, 400, result); return true; }
        res.writeHead(302, { Location: result.redirect });
        res.end();
        return true;
      }
      if (req.method === 'POST' && p === '/oauth/token') {
        const body = await readBody(req);
        const result = exchangeToken(body);
        if (result.error) { send(res, 400, { error: result.error }); return true; }
        send(res, 200, result);
        return true;
      }

      return false;
    },
  };
}
