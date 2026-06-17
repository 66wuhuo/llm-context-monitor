// ============================================================
// ProxyServer — HTTP/HTTPS forward proxy for LLM API interception
// ============================================================

import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'eventemitter3';
import { request as undiciRequest } from 'undici';
import { AnthropicParser } from './AnthropicParser';
import { OpenAIParser } from './OpenAIParser';
import { SSEMonitor } from './SSEMonitor';
import { CertManager } from './CertManager';
import type { TokenService } from '../services/TokenService';
import type { ModelRegistry } from '../services/ModelRegistry';
import type { ConversationTracker } from '../services/ConversationTracker';
import type { ProxyStatus, TokenUsage } from '../types';
import { PROXY_STRIP_HEADERS } from '../constants';

/** Debug log file path (for internal diagnostics) */
const DEBUG_LOG = path.join(os.tmpdir(), 'llm-monitor-debug.log');
function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  try { fs.appendFileSync(DEBUG_LOG, line + '\n'); } catch {}
}

export interface ProxyServerEvents {
  /** A monitored request was detected and parsed */
  'request-detected': (data: {
    conversationId: string;
    model: string;
    provider: string;
    inputTokens: number;
    stream: boolean;
  }) => void;
  /** Streaming output token delta */
  'token-delta': (data: {
    conversationId: string;
    estimatedOutputTokens: number;
  }) => void;
  /** A turn completed with full usage stats */
  'turn-complete': (data: {
    conversationId: string;
    usage: TokenUsage;
    model: string;
  }) => void;
  /** Proxy server started */
  'proxy-started': (data: { port: number }) => void;
  /** Proxy server stopped */
  'proxy-stopped': () => void;
  /** Proxy error */
  'proxy-error': (data: { error: Error }) => void;
}

export class ProxyServer extends EventEmitter<ProxyServerEvents> {
  private server: http.Server | null = null;
  private port: number;
  private monitoredHosts: Set<string> = new Set();
  private requestCount: number = 0;
  private bytesTransferred: number = 0;
  private startedAt?: number;

  private tokenService: TokenService;
  private modelRegistry: ModelRegistry;
  private conversationTracker: ConversationTracker;
  private certManager: CertManager = new CertManager();
  private mitmEnabled: boolean = true;

  /** Track consecutive MITM TLS failures per host. After 2 failures in a row
   *  the proxy auto-falls-back to passthrough for that host so the client
   *  can still reach the API (just without inspection). */
  private mitmFailures: Map<string, number> = new Map();
  private static readonly MITM_MAX_FAILURES = 2;

  /** Track whether we've already warned the user about TLS trust issues
   *  so we only show one notification per proxy session. */
  private tlsWarningEmitted = false;

  constructor(
    port: number,
    tokenService: TokenService,
    modelRegistry: ModelRegistry,
    conversationTracker: ConversationTracker
  ) {
    super();
    this.port = port;
    this.tokenService = tokenService;
    this.modelRegistry = modelRegistry;
    this.conversationTracker = conversationTracker;
  }

  /** Enable/disable MITM HTTPS interception */
  setMitmEnabled(enabled: boolean): void {
    this.mitmEnabled = enabled;
  }

  /** Get the CA certificate PEM (for user to trust) */
  getCACertPem(): string {
    return this.certManager.getCACert().cert;
  }

  /** Set a previously persisted CA cert */
  setCACert(pair: { cert: string; key: string }): void {
    this.certManager.setCACert(pair);
  }

  /** Get CA cert + key for persistence */
  getCACertPair(): { cert: string; key: string } {
    return this.certManager.getCACert();
  }

  /** Set the list of hostnames to monitor */
  setMonitoredHosts(hosts: string[]): void {
    this.monitoredHosts = new Set(hosts.map((h) => h.trim().toLowerCase()));
  }

  /** Start the proxy server */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      // Handle CONNECT for HTTPS tunneling
      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket as net.Socket, head);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port in use, try next port
          this.port++;
          this.server?.close();
          this.server?.listen(this.port);
        } else {
          this.emit('proxy-error', { error: err });
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.startedAt = Date.now();
        this.emit('proxy-started', { port: this.port });
        resolve(this.port);
      });
    });
  }

  /** Stop the proxy server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.startedAt = undefined;
          this.emit('proxy-stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Reset MITM failure counters so MITM is retried for all hosts */
  resetMitmFailures(): void {
    this.mitmFailures.clear();
    this.tlsWarningEmitted = false;
  }

  /** Get proxy status */
  getStatus(): ProxyStatus {
    return {
      running: this.server !== null,
      port: this.port,
      requestCount: this.requestCount,
      bytesTransferred: this.bytesTransferred,
      startedAt: this.startedAt,
    };
  }

  // ---- Internal: CONNECT (HTTPS tunneling) ----

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const [hostname, portStr] = (req.url ?? '').split(':');
    const port = parseInt(portStr, 10) || 443;

    if (!this.isMonitoredHost(hostname)) {
      // Passthrough: connect to target and pipe through
      this.tunnelPassthrough(clientSocket, hostname, port, head);
      return;
    }

    // Monitored HTTPS host — try MITM interception
    this.requestCount++;
    const failures = this.mitmFailures.get(hostname) ?? 0;
    debugLog(`CONNECT: ${hostname}:${port} — MITM enabled=${this.mitmEnabled} openssl=${CertManager.isAvailable()} failures=${failures}`);

    if (
      this.mitmEnabled &&
      CertManager.isAvailable() &&
      failures < ProxyServer.MITM_MAX_FAILURES
    ) {
      debugLog(`MITM: starting interception for ${hostname}`);
      this.handleConnectMITM(clientSocket, hostname, port, head);
    } else {
      const reason =
        failures >= ProxyServer.MITM_MAX_FAILURES
          ? `auto-fallback after ${failures} TLS failures`
          : 'disabled or openssl unavailable';
      debugLog(`FALLBACK: tunneling ${hostname} (${reason})`);
      this.tunnelPassthrough(clientSocket, hostname, port, head);
    }
  }

  // ---- Internal: MITM CONNECT handling ----

  private handleConnectMITM(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    _head: Buffer
  ): void {
    // Generate a TLS cert for this hostname, signed by our CA
    let hostCert: { cert: string; key: string };
    try {
      hostCert = this.certManager.getHostCert(hostname);
      debugLog(`MITM: cert generated for ${hostname}`);
    } catch (err) {
      debugLog(`MITM: cert FAILED for ${hostname}: ${(err as Error).message}`);
      this.tunnelPassthrough(clientSocket, hostname, port, _head);
      return;
    }

    // Respond 200 to establish the CONNECT tunnel
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    debugLog(`MITM: sent 200 for ${hostname}`);

    // Create a server-side TLS socket on the client connection
    const secureContext = tls.createSecureContext({
      key: hostCert.key,
      cert: hostCert.cert,
    });

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
      rejectUnauthorized: false,
      requestCert: false,
    });
    debugLog(`MITM: TLSSocket created for ${hostname}`);

    // Track bytes through the TLS socket
    tlsSocket.on('data', (chunk: Buffer) => {
      this.bytesTransferred += chunk.length;
    });

    // Log TLS connection established & auto-clear failure counter
    tlsSocket.once('secureConnect', () => {
      debugLog(`MITM: TLS handshake COMPLETE for ${hostname}`);
      // Successful MITM handshake — reset failure counter for this host
      if (this.mitmFailures.get(hostname) ?? 0 > 0) {
        this.mitmFailures.delete(hostname);
        debugLog(`MITM: failure counter reset for ${hostname}`);
      }
    });

    // Create a temporary HTTP server to parse the decrypted request
    const mitmServer = http.createServer((req, res) => {
      debugLog(`MITM: HTTP request received: ${req.method} ${req.url}`);
      this.handleMitmRequest(req, res, hostname);
    });

    // Route the decrypted TLS socket into the HTTP server
    mitmServer.emit('connection', tlsSocket);
    debugLog(`MITM: piped TLS socket into HTTP server for ${hostname}`);

    // Handle TLS errors gracefully — track per-host failures for auto-fallback
    tlsSocket.once('error', (err: Error) => {
      debugLog(`MITM: TLS ERROR for ${hostname}: ${err.message}`);

      // Bump failure counter for this host
      const failCount = (this.mitmFailures.get(hostname) ?? 0) + 1;
      this.mitmFailures.set(hostname, failCount);

      // Only emit ONE user-visible warning per proxy session
      if (!this.tlsWarningEmitted) {
        this.tlsWarningEmitted = true;
        this.emit('proxy-error', { error: new Error(
          `TLS 握手失败：客户端不信任代理 CA 证书。\n` +
          `已在用户环境设置了 NODE_TLS_REJECT_UNAUTHORIZED=0，如仍失败请重启终端。\n` +
          `代理将自动回退为透传模式（不检查加密流量）。\n` +
          `原始错误: ${err.message}`
        )});
      }

      // After consecutive failures, future CONNECTs to this host skip MITM
      if (failCount >= ProxyServer.MITM_MAX_FAILURES) {
        debugLog(`MITM: auto-fallback active for ${hostname} (${failCount} failures)`);
      }
    });

    // Clean up the temporary HTTP server when the TLS socket closes
    tlsSocket.once('close', () => {
      debugLog(`MITM: connection closed for ${hostname}`);
      mitmServer.close();
    });
  }

  /** Handle a decrypted HTTP request from the MITM tunnel */
  private async handleMitmRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    hostname: string
  ): Promise<void> {
    const path = req.url ?? '/';
    const method = req.method ?? 'POST';

    // Determine provider
    const isAnthropic = AnthropicParser.isAnthropicHost(hostname);
    const isOpenAI = OpenAIParser.isOpenAIHost(hostname);

    // Read request body
    const body = await this.readBody(req);
    debugLog(`MITM: body read (${body.length} bytes) — isAnthropic=${isAnthropic} isOpenAI=${isOpenAI} path=${path}`);

    if (isAnthropic && AnthropicParser.isMessagesApi(path)) {
      debugLog(`MITM: routing to handleAnthropicMessage`);
      await this.handleAnthropicMessage(req, res, body, hostname, path);
    } else if (isOpenAI && OpenAIParser.isChatCompletionsApi(path)) {
      debugLog(`MITM: routing to handleOpenAIChatCompletion — body preview: ${body.slice(0, 200)}`);
      await this.handleOpenAIChatCompletion(req, res, body, hostname, path);
    } else {
      debugLog(`MITM: passthrough (no handler matched) — path=${path}`);
      await this.passthroughHttp(req, res, hostname, path, method, body);
    }
  }

  // ---- Internal: HTTP request handling ----

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const hostname = req.headers.host ?? '';
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (!this.isMonitoredHost(hostname)) {
      // Passthrough non-monitored requests
      await this.passthroughHttp(req, res, hostname, path, method);
      return;
    }

    // This is a monitored LLM API request
    this.requestCount++;

    // Read the full request body
    const body = await this.readBody(req);

    // Determine the provider and parse the request
    const isAnthropic = AnthropicParser.isAnthropicHost(hostname);
    const isOpenAI = OpenAIParser.isOpenAIHost(hostname);

    if (isAnthropic && AnthropicParser.isMessagesApi(path)) {
      await this.handleAnthropicMessage(req, res, body, hostname, path);
    } else if (isOpenAI && OpenAIParser.isChatCompletionsApi(path)) {
      await this.handleOpenAIChatCompletion(req, res, body, hostname, path);
    } else {
      // Other API endpoints (count_tokens, models list, etc.) — passthrough
      await this.passthroughHttp(req, res, hostname, path, method, body);
    }
  }

  // ---- Anthropic Messages API handling ----

  private async handleAnthropicMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    hostname: string,
    path: string
  ): Promise<void> {
    const parsed = AnthropicParser.parseRequest(body, path);
    if (!parsed) {
      await this.passthroughHttp(req, res, hostname, path, req.method ?? 'POST', body);
      return;
    }

    // Generate conversation ID and track this request
    const conversationId = this.conversationTracker.getActiveConversationId() ??
      this.conversationTracker.generateConversationId();

    // Start or ensure session exists
    if (!this.conversationTracker.getSession(conversationId)) {
      this.conversationTracker.startConversation(conversationId, parsed.model);
    }

    // Count input tokens
    const inputTokens = await this.tokenService.countTokens(
      parsed.model,
      parsed.system,
      parsed.messages,
      parsed.tools
    );

    this.emit('request-detected', {
      conversationId,
      model: parsed.model,
      provider: 'anthropic',
      inputTokens,
      stream: parsed.stream,
    });

    // Forward the request
    const upstreamRes = await undiciRequest(
      `https://${hostname}${path}`,
      {
        method: req.method ?? 'POST',
        headers: this.cleanHeaders(req.headers),
        body,
      }
    );

    // Copy response headers
    res.writeHead(upstreamRes.statusCode, this.filterHeaders(upstreamRes.headers));

    if (parsed.stream) {
      // Handle streaming response with SSE monitoring
      const ssemonitor = new SSEMonitor(conversationId);
      let estimatedOutputTokens = 0;

      ssemonitor.on('block-delta', (data) => {
        if (data.text) {
          estimatedOutputTokens += this.tokenService.estimateDeltaTokens(data.text);
          this.emit('token-delta', {
            conversationId,
            estimatedOutputTokens,
          });
        }
      });

      ssemonitor.on('turn-complete', (data) => {
        const usage: TokenUsage = {
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens || estimatedOutputTokens,
          cacheReadTokens: data.cacheReadTokens,
          cacheCreationTokens: data.cacheCreationTokens,
          totalTokens:
            data.inputTokens + (data.outputTokens || estimatedOutputTokens),
        };

        this.conversationTracker.recordTurn(conversationId, usage, data.model);
        this.emit('turn-complete', { conversationId, usage, model: data.model });
      });

      // Stream the body through SSEMonitor and to the client
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          const buf = Buffer.from(chunk);
          ssemonitor.feed(buf);
          this.bytesTransferred += buf.length;
          res.write(buf);
        }
      }
      ssemonitor.flush();
      res.end();
    } else {
      // Non-streaming: read full response
      const responseBody = await this.readResponseBody(upstreamRes);
      const responseParsed = AnthropicParser.parseResponse(responseBody);

      if (responseParsed?.usage) {
        const usage: TokenUsage = {
          inputTokens: responseParsed.usage.input_tokens,
          outputTokens: responseParsed.usage.output_tokens,
          cacheReadTokens: responseParsed.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: responseParsed.usage.cache_creation_input_tokens ?? 0,
          totalTokens:
            responseParsed.usage.input_tokens + responseParsed.usage.output_tokens,
        };

        this.conversationTracker.recordTurn(
          conversationId,
          usage,
          responseParsed.model ?? parsed.model
        );
        this.emit('turn-complete', {
          conversationId,
          usage,
          model: responseParsed.model ?? parsed.model,
        });
      }

      res.end(responseBody);
    }
  }

  // ---- OpenAI Chat Completion API handling ----

  private async handleOpenAIChatCompletion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    hostname: string,
    path: string
  ): Promise<void> {
    const parsed = OpenAIParser.parseRequest(body, path);
    if (!parsed) {
      await this.passthroughHttp(req, res, hostname, path, req.method ?? 'POST', body);
      return;
    }

    const conversationId = this.conversationTracker.getActiveConversationId() ??
      this.conversationTracker.generateConversationId();

    if (!this.conversationTracker.getSession(conversationId)) {
      this.conversationTracker.startConversation(conversationId, parsed.model);
    }

    // Estimate input tokens (OpenAI format)
    const inputTokens = this.tokenService.estimateTokensLocal(parsed.messages);

    this.emit('request-detected', {
      conversationId,
      model: parsed.model,
      provider: 'openai',
      inputTokens,
      stream: parsed.stream,
    });

    // Forward the request
    const upstreamRes = await undiciRequest(
      `https://${hostname}${path}`,
      {
        method: req.method ?? 'POST',
        headers: this.cleanHeaders(req.headers),
        body,
      }
    );

    res.writeHead(upstreamRes.statusCode, this.filterHeaders(upstreamRes.headers));

    if (parsed.stream) {
      // OpenAI SSE streaming
      const ssemonitor = new SSEMonitor(conversationId);
      let estimatedOutputTokens = 0;

      ssemonitor.on('block-delta', (data) => {
        if (data.text) {
          estimatedOutputTokens += this.tokenService.estimateDeltaTokens(data.text);
          this.emit('token-delta', {
            conversationId,
            estimatedOutputTokens,
          });
        }
      });

      ssemonitor.on('turn-complete', (data) => {
        const usage: TokenUsage = {
          inputTokens: data.inputTokens || inputTokens,
          outputTokens: data.outputTokens || estimatedOutputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens:
            (data.inputTokens || inputTokens) +
            (data.outputTokens || estimatedOutputTokens),
        };

        this.conversationTracker.recordTurn(conversationId, usage, data.model);
        this.emit('turn-complete', { conversationId, usage, model: data.model });
      });

      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          const buf = Buffer.from(chunk);
          ssemonitor.feed(buf);
          this.bytesTransferred += buf.length;
          res.write(buf);
        }
      }
      ssemonitor.flush();
      res.end();
    } else {
      const responseBody = await this.readResponseBody(upstreamRes);
      const responseParsed = OpenAIParser.parseResponse(responseBody);

      if (responseParsed?.usage) {
        const usage: TokenUsage = {
          inputTokens: responseParsed.usage.prompt_tokens,
          outputTokens: responseParsed.usage.completion_tokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: responseParsed.usage.total_tokens,
        };

        this.conversationTracker.recordTurn(
          conversationId,
          usage,
          responseParsed.model ?? parsed.model
        );
        this.emit('turn-complete', {
          conversationId,
          usage,
          model: responseParsed.model ?? parsed.model,
        });
      }

      res.end(responseBody);
    }
  }

  // ---- Utilities ----

  private isMonitoredHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    for (const monitored of this.monitoredHosts) {
      if (normalized.includes(monitored)) return true;
    }
    return false;
  }

  private tunnelPassthrough(
    clientSocket: net.Socket,
    host: string,
    port: number,
    head: Buffer
  ): void {
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n\r\n'
      );
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', () => {
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      serverSocket.end();
    });

    // Track bytes for proxied connections
    clientSocket.on('data', (chunk: Buffer) => {
      this.bytesTransferred += chunk.length;
    });
  }

  private async passthroughHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    hostname: string,
    path: string,
    method: string,
    body?: string
  ): Promise<void> {
    try {
      const upstreamRes = await undiciRequest(
        `https://${hostname}${path}`,
        {
          method,
          headers: this.cleanHeaders(req.headers),
          body: body || undefined,
        }
      );

      res.writeHead(upstreamRes.statusCode, this.filterHeaders(upstreamRes.headers));

      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) {
          const buf = Buffer.from(chunk);
          this.bytesTransferred += buf.length;
          res.write(buf);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Proxy Error: ${(err as Error).message}`);
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  private async readResponseBody(res: {
    body: NodeJS.ReadableStream | AsyncIterable<unknown> | null;
    text?: () => Promise<string>;
  }): Promise<string> {
    // If the response has a .text() method (like undici), use it
    if (res.text) {
      return res.text();
    }

    if (!res.body) return '';

    // Handle Node.js ReadableStream
    if (Symbol.asyncIterator in res.body) {
      const chunks: Buffer[] = [];
      for await (const chunk of res.body as AsyncIterable<Buffer | Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf-8');
    }

    return '';
  }

  private cleanHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      // Skip proxy-specific headers and hop-by-hop headers
      if (PROXY_STRIP_HEADERS.includes(key.toLowerCase())) continue;
      if (value !== undefined) {
        cleaned[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }
    return cleaned;
  }

  private filterHeaders(
    headers: Record<string, string | string[] | undefined>
  ): Record<string, string | string[] | undefined> {
    const filtered: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(headers)) {
      // Strip transfer-encoding to let the client handle chunking
      if (key.toLowerCase() === 'transfer-encoding') continue;
      filtered[key] = value;
    }
    return filtered;
  }
}
