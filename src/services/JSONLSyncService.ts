// ============================================================
// JSONLSyncService — read Claude Code session JSONL files directly
// ============================================================
//
// Like cc-switch, we scan ~/.claude/projects/ for JSONL session files
// and extract model + token usage from assistant messages.  This works
// WITHOUT an HTTP proxy — Claude Code writes these files natively.
//
// Data flow:
//   ~/.claude/projects/<project>/*.jsonl
//     → incremental parse (track line offset per file)
//     → dedup by message.id (keep highest-output entry)
//     → cost calculation via CostService + ModelRegistry
//     → push to ConversationTracker → Dashboard / StatusBar
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { ModelRegistry } from './ModelRegistry';
import type { ConversationTracker } from './ConversationTracker';
import type { CostService } from './CostService';
import type { TokenUsage } from '../types';

/** All token fields we extract from a JSONL assistant message */
interface JsonlUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageId: string;
  stopReason: string | null;
  timestamp?: string;
  sessionId?: string;
}

/** Per-file sync state persisted via VS Code Memento */
interface FileSyncState {
  lastModified: number;    // mtimeMs of file when last synced
  lastLineOffset: number;  // last line number processed (1-based)
  lastMessageId: string;   // last message.id processed (for dedup)
}

export interface SyncResult {
  imported: number;
  skipped: number;
  filesScanned: number;
  totalTokens: number;
  models: Record<string, number>;
}

export class JSONLSyncService {
  private modelRegistry: ModelRegistry;
  private conversationTracker: ConversationTracker;
  private costService: CostService;

  /** Per-file sync state, keyed by absolute file path */
  private syncState: Map<string, FileSyncState> = new Map();

  /** Persisted state key for VS Code globalState */
  private static readonly STATE_KEY = 'llmContext.jsonlSyncState';

  constructor(
    modelRegistry: ModelRegistry,
    conversationTracker: ConversationTracker,
    costService: CostService
  ) {
    this.modelRegistry = modelRegistry;
    this.conversationTracker = conversationTracker;
    this.costService = costService;
  }

  // ---- Public API ----

  /** Restore sync state from persisted storage */
  loadState(data: Record<string, FileSyncState>): void {
    for (const [filePath, state] of Object.entries(data)) {
      this.syncState.set(filePath, state);
    }
  }

  /** Serialize sync state for persistence */
  saveState(): Record<string, FileSyncState> {
    const out: Record<string, FileSyncState> = {};
    for (const [filePath, state] of this.syncState) {
      out[filePath] = state;
    }
    return out;
  }

  /** Run a full sync across all Claude Code projects */
  async syncAll(): Promise<SyncResult> {
    const result: SyncResult = {
      imported: 0,
      skipped: 0,
      filesScanned: 0,
      totalTokens: 0,
      models: {},
    };

    const projectsDir = this.getProjectsDir();
    if (!fs.existsSync(projectsDir)) {
      return result;
    }

    // Collect all JSONL files
    const files = this.collectJsonlFiles(projectsDir);

    for (const filePath of files) {
      result.filesScanned++;
      try {
        const fileResult = await this.syncFile(filePath);
        result.imported += fileResult.imported;
        result.skipped += fileResult.skipped;
        result.totalTokens += fileResult.totalTokens;
        for (const [model, count] of Object.entries(fileResult.models)) {
          result.models[model] = (result.models[model] ?? 0) + count;
        }
      } catch (err) {
        // Per-file errors are non-fatal
        console.warn(`[JSONL-SYNC] Failed to sync ${filePath}: ${(err as Error).message}`);
      }
    }

    return result;
  }

  // ---- Internal: file discovery ----

  /**
   * Determine the Claude Code projects directory.
   * On all platforms Claude Code stores data under ~/.claude/projects/
   */
  private getProjectsDir(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
    return path.join(home, '.claude', 'projects');
  }

  /**
   * Collect all .jsonl files under the projects directory.
   * Scans two levels: projects/<project-dir>/*.jsonl (main sessions)
   * and projects/<project-dir>/<session-dir>/subagents/*.jsonl (sub-agents).
   */
  private collectJsonlFiles(projectsDir: string): string[] {
    const files: string[] = [];

    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(projectsDir, entry.name);

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const item of items) {
        const itemPath = path.join(projectPath, item.name);

        if (item.isFile() && item.name.endsWith('.jsonl')) {
          // Main session JSONL
          files.push(itemPath);
        } else if (item.isDirectory()) {
          // Scan sub-agents: <session-dir>/subagents/*.jsonl
          this.pushJsonlChildren(
            path.join(itemPath, 'subagents'),
            files
          );
        }
      }
    }

    return files;
  }

  /** Push all .jsonl files directly under `dir` into `files` (non-recursive). */
  private pushJsonlChildren(dir: string, files: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push(path.join(dir, e.name));
      }
    }
  }

  // ---- Internal: file syncing ----

  private async syncFile(
    filePath: string
  ): Promise<{ imported: number; skipped: number; totalTokens: number; models: Record<string, number> }> {
    // Get file metadata
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { imported: 0, skipped: 0, totalTokens: 0, models: {} };
    }

    const fileModified = stat.mtimeMs;
    const prevState = this.syncState.get(filePath);

    // Skip if file hasn't changed since last sync
    if (prevState && fileModified <= prevState.lastModified) {
      return { imported: 0, skipped: 0, totalTokens: 0, models: {} };
    }

    // Parse file incrementally
    const startLine = prevState ? prevState.lastLineOffset : 0;
    const parsed = await this.parseJsonlIncremental(filePath, startLine, prevState?.lastMessageId);

    // Update sync state
    this.syncState.set(filePath, {
      lastModified: fileModified,
      lastLineOffset: parsed.lastLine,
      lastMessageId: parsed.lastMessageId,
    });

    return {
      imported: parsed.imported,
      skipped: parsed.skipped,
      totalTokens: parsed.totalTokens,
      models: parsed.models,
    };
  }

  /** Parse JSONL lines from `startLine`, extracting assistant usage data */
  private async parseJsonlIncremental(
    filePath: string,
    startLine: number,
    lastKnownMessageId?: string
  ): Promise<{
    imported: number;
    skipped: number;
    totalTokens: number;
    models: Record<string, number>;
    lastLine: number;
    lastMessageId: string;
  }> {
    let imported = 0;
    let skipped = 0;
    let totalTokens = 0;
    const models: Record<string, number> = {};
    let lineNo = 0;
    let lastMessageId = lastKnownMessageId ?? '';

    // Collect usage entries keyed by message.id (for dedup)
    const byMessageId = new Map<string, JsonlUsage>();

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      lineNo++;
      if (lineNo <= startLine) continue;
      if (!line.trim()) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // tolerate malformed lines
      }

      const message = obj.message as Record<string, unknown> | undefined;
      if (!message || message.role !== 'assistant') continue;

      const usage = message.usage as Record<string, number> | undefined;
      if (!usage) continue;

      const msgId = message.id as string | undefined;
      if (!msgId) continue;

      // Skip if this message was already processed (from previous sync)
      if (lastKnownMessageId && msgId === lastKnownMessageId) {
        skipped++;
        continue;
      }

      const entry: JsonlUsage = {
        model: (message.model as string) ?? 'unknown',
        inputTokens: (usage.input_tokens as number) ?? 0,
        outputTokens: (usage.output_tokens as number) ?? 0,
        cacheReadTokens: (usage.cache_read_input_tokens as number) ?? 0,
        cacheCreationTokens: (usage.cache_creation_input_tokens as number) ?? 0,
        messageId: msgId,
        stopReason: (message.stop_reason as string) ?? null,
        timestamp: obj.timestamp as string | undefined,
        sessionId: obj.sessionId as string | undefined,
      };

      // Dedup: keep the entry with highest output_tokens (most complete stream)
      const existing = byMessageId.get(msgId);
      if (!existing || entry.outputTokens > existing.outputTokens) {
        byMessageId.set(msgId, entry);
      }

      lastMessageId = msgId;
    }

    // Push deduped entries into ConversationTracker
    for (const entry of byMessageId.values()) {
      // Skip entries with zero billable tokens
      if (
        entry.inputTokens === 0 &&
        entry.outputTokens === 0 &&
        entry.cacheReadTokens === 0 &&
        entry.cacheCreationTokens === 0
      ) {
        skipped++;
        continue;
      }

      const usage: TokenUsage = {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        totalTokens:
          entry.inputTokens +
          entry.outputTokens +
          entry.cacheReadTokens +
          entry.cacheCreationTokens,
      };

      // Ensure session exists
      const convId = entry.sessionId ?? `jsonl-${entry.messageId}`;
      if (!this.conversationTracker.getSession(convId)) {
        this.conversationTracker.startConversation(convId, entry.model);
      }

      // Record turn
      const turn = this.conversationTracker.recordTurn(convId, usage, entry.model, 1);

      if (turn) {
        imported++;
        totalTokens += usage.totalTokens;
        models[entry.model] = (models[entry.model] ?? 0) + 1;
      } else {
        skipped++;
      }
    }

    return { imported, skipped, totalTokens, models, lastLine: lineNo, lastMessageId };
  }
}
