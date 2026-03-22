import { Client, isFullPage } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  cancelDeletedNotionTodos,
  createTodo,
  getTodoByNotionId,
  getRouterState,
  setRouterState,
  updateTodo,
} from './db.js';
import { logger } from './logger.js';
import { Todo } from './types.js';

// --- Config ---

interface NotionConfig {
  token: string;
  databaseId: string;
}

export function loadNotionConfig(): NotionConfig | null {
  const configPath = path.join(
    os.homedir(),
    '.config',
    'nanoclaw',
    'notion.json',
  );
  if (!fs.existsSync(configPath)) {
    logger.warn(
      'Notion config not found at ~/.config/nanoclaw/notion.json — skipping sync',
    );
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!raw.token || !raw.databaseId) {
      logger.warn({ configPath }, 'Notion config missing token or databaseId');
      return null;
    }
    return raw as NotionConfig;
  } catch (err) {
    logger.error({ err }, 'Failed to read Notion config');
    return null;
  }
}

// --- Notion property names (update to match your database) ---

const NOTION_PROPERTY_NAMES = {
  title: 'Name',
  due_date: 'Due Date',
  course: 'Class',
  status: 'Status',
} as const;

// --- Property extractors ---

type NotionProps = PageObjectResponse['properties'];

function extractTitle(props: NotionProps, name: string): string | undefined {
  const prop = props[name];
  if (!prop || prop.type !== 'title') return undefined;
  return (
    prop.title
      .map((t) => t.plain_text)
      .join('')
      .trim() || undefined
  );
}

function extractDate(props: NotionProps, name: string): string | undefined {
  const prop = props[name];
  if (!prop || prop.type !== 'date' || !prop.date) return undefined;
  return prop.date.start.slice(0, 10);
}

function extractSelect(props: NotionProps, name: string): string | undefined {
  const prop = props[name];
  if (!prop || prop.type !== 'select' || !prop.select) return undefined;
  return prop.select.name || undefined;
}

// --- Status normalization ---

function normalizeStatus(raw: string | undefined): Todo['status'] {
  switch (raw?.toLowerCase().trim()) {
    case 'completed':
      return 'done';
    case 'in progress':
      return 'in_progress';
    default:
      return 'todo'; // 'not started' or anything else
  }
}

// --- Page → Todo field mapping ---

interface MappedFields {
  title: string;
  notion_id: string;
  due_date?: string;
  course?: string;
  status: Todo['status'];
}

function pageToTodoFields(page: PageObjectResponse): MappedFields | null {
  const props = page.properties;
  const title = extractTitle(props, NOTION_PROPERTY_NAMES.title);
  if (!title) {
    logger.warn({ pageId: page.id }, 'Notion page has no title — skipping');
    return null;
  }
  return {
    title,
    notion_id: page.id,
    due_date: extractDate(props, NOTION_PROPERTY_NAMES.due_date),
    course: extractSelect(props, NOTION_PROPERTY_NAMES.course),
    status: normalizeStatus(extractSelect(props, NOTION_PROPERTY_NAMES.status)),
  };
}

// --- Upsert ---

function upsertPage(page: PageObjectResponse): void {
  const fields = pageToTodoFields(page);
  if (!fields) return;

  const existing = getTodoByNotionId(page.id);
  if (existing) {
    // Only update Notion-managed fields — never touch locally-enriched fields:
    // scheduled_time, flexible, estimated_minutes, energy_level,
    // location, tags, priority, notes
    updateTodo(existing.id, { ...fields, notion_synced: 1 });
  } else {
    const defaults = {
      id: randomUUID(),
      status: 'todo' as Todo['status'],
      flexible: 1,
      priority: 'medium' as Todo['priority'],
      category: 'school',
      notion_synced: 1,
    };
    createTodo({ ...defaults, ...fields });
  }
}

// --- Pagination helper ---

async function fetchAllPages(
  client: Client,
  databaseId: string,
  filter?: Parameters<Client['databases']['query']>[0]['filter'],
): Promise<PageObjectResponse[]> {
  let cursor: string | undefined;
  const pages: PageObjectResponse[] = [];
  do {
    const response = await client.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      filter,
    });
    for (const page of response.results) {
      if (isFullPage(page)) pages.push(page);
    }
    cursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (cursor);
  return pages;
}

// --- Public API ---

export async function runIncrementalSync(): Promise<void> {
  const config = loadNotionConfig();
  if (!config) return;

  const syncCursor = getRouterState('notion_last_sync_at');
  if (!syncCursor) {
    logger.info('No notion sync cursor found — running full sync');
    return runFullSync();
  }

  const client = new Client({ auth: config.token });
  const pages = await fetchAllPages(client, config.databaseId, {
    timestamp: 'last_edited_time',
    last_edited_time: { after: syncCursor },
  });

  if (pages.length === 0) {
    logger.debug('Notion incremental sync: no changes');
    setRouterState('notion_last_sync_at', new Date().toISOString());
    return;
  }

  logger.info(
    { count: pages.length },
    'Notion incremental sync: upserting pages',
  );
  for (const page of pages) {
    upsertPage(page);
  }

  setRouterState('notion_last_sync_at', new Date().toISOString());
  logger.info({ count: pages.length }, 'Notion incremental sync complete');
}

export async function runFullSync(): Promise<void> {
  const config = loadNotionConfig();
  if (!config) return;

  logger.info('Notion full sync starting');
  const client = new Client({ auth: config.token });
  const pages = await fetchAllPages(client, config.databaseId);

  const notionIds = new Set<string>();
  for (const page of pages) {
    upsertPage(page);
    notionIds.add(page.id);
  }

  const cancelled = cancelDeletedNotionTodos([...notionIds]);
  if (cancelled > 0) {
    logger.info(
      { count: cancelled },
      'Notion full sync: cancelled deleted assignments',
    );
  }

  setRouterState('notion_last_sync_at', new Date().toISOString());
  logger.info({ count: pages.length }, 'Notion full sync complete');
}
