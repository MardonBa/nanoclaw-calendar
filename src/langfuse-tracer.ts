/**
 * Langfuse observability wrapper.
 * Silently no-ops when LANGFUSE_SECRET_KEY is not configured.
 */
import { Langfuse } from 'langfuse';

import { logger } from './logger.js';

let client: Langfuse | null = null;

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function initLangfuse(config: {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}): void {
  if (!config.secretKey) {
    logger.debug('LANGFUSE_SECRET_KEY not set, observability disabled');
    return;
  }
  client = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    flushAt: 10,
    flushInterval: 5000,
  });
  logger.info({ baseUrl: config.baseUrl }, 'Langfuse observability enabled');
}

export function traceTurn(opts: {
  groupName: string;
  groupFolder: string;
  prompt: string;
  result: string | null;
  durationMs: number;
  usage?: UsageTokens;
  isScheduledTask?: boolean;
  error?: string;
}): void {
  if (!client) return;
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - opts.durationMs);
    const trace = client.trace({
      name: opts.groupName,
      tags: [opts.groupFolder, opts.isScheduledTask ? 'scheduled' : 'message'],
    });
    trace.generation({
      name: 'agent-turn',
      model: 'claude-sonnet-4-6',
      input: opts.prompt,
      output: opts.result ?? opts.error ?? '',
      startTime,
      endTime,
      level: opts.error ? 'ERROR' : 'DEFAULT',
      statusMessage: opts.error,
      usage: opts.usage
        ? {
            input: opts.usage.inputTokens,
            output: opts.usage.outputTokens,
            total: opts.usage.inputTokens + opts.usage.outputTokens,
            unit: 'TOKENS',
          }
        : undefined,
      metadata: {
        cacheReadInputTokens: opts.usage?.cacheReadInputTokens,
        cacheCreationInputTokens: opts.usage?.cacheCreationInputTokens,
        isScheduledTask: opts.isScheduledTask ?? false,
        groupFolder: opts.groupFolder,
      },
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to send trace to Langfuse');
  }
}
