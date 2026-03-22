import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, createTodo, getTodoByNotionId, getRouterState, setRouterState } from './db.js';
import { runIncrementalSync, runFullSync } from './notion-sync.js';

// --- Mock @notionhq/client ---
// vi.hoisted ensures mockQuery is defined before the vi.mock factory runs (which is hoisted)

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('@notionhq/client', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Client: function MockClient(_opts: unknown) {
    return { databases: { query: mockQuery } };
  },
  isFullPage: vi.fn((page: unknown) => typeof page === 'object' && page !== null && 'properties' in page),
}));

// --- Mock fs so loadNotionConfig() returns a test config by default ---

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((p: unknown) => {
        if (String(p).includes('notion.json')) {
          return JSON.stringify({ token: 'test-token', databaseId: 'db-1' });
        }
        return actual.readFileSync(p as string);
      }),
    },
  };
});

// --- Helpers ---

/**
 * Build a minimal fake Notion PageObjectResponse matching the Assignments database schema:
 * Name (title), Due Date (date), Class (select), Status (select)
 */
function makePage(
  id: string,
  title: string,
  opts: {
    due_date?: string;  // YYYY-MM-DD
    course?: string;    // e.g. 'CS 2050'
    status?: string;    // 'Not Started' | 'In Progress' | 'Completed'
  } = {},
) {
  return {
    id,
    last_edited_time: new Date().toISOString(),
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: title }],
      },
      'Due Date': opts.due_date
        ? { type: 'date', date: { start: opts.due_date } }
        : { type: 'date', date: null },
      Class: opts.course
        ? { type: 'select', select: { name: opts.course } }
        : { type: 'select', select: null },
      Status: opts.status
        ? { type: 'select', select: { name: opts.status } }
        : { type: 'select', select: null },
    },
  };
}

function singlePage(page: ReturnType<typeof makePage>) {
  return { results: [page], has_more: false, next_cursor: null };
}

function emptyResults() {
  return { results: [], has_more: false, next_cursor: null };
}

// --- Setup ---

beforeEach(() => {
  _initTestDatabase();
  mockQuery.mockReset();
});

// --- runIncrementalSync ---

describe('runIncrementalSync', () => {
  it('delegates to runFullSync when no cursor', async () => {
    mockQuery.mockResolvedValue(emptyResults());

    await runIncrementalSync();

    // Should have called query without a timestamp filter (full sync behaviour)
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.filter).toBeUndefined();
  });

  it('advances cursor when no pages returned', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(emptyResults());

    await runIncrementalSync();

    const cursor = getRouterState('notion_last_sync_at');
    expect(cursor).toBeDefined();
    expect(cursor).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates new todo for a new Notion page', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(makePage('page-1', 'HW 15.2', { due_date: '2026-03-30', course: 'MATH 2550', status: 'Not Started' })),
    );

    await runIncrementalSync();

    const todo = getTodoByNotionId('page-1');
    expect(todo).toBeDefined();
    expect(todo!.title).toBe('HW 15.2');
    expect(todo!.due_date).toBe('2026-03-30');
    expect(todo!.course).toBe('MATH 2550');
    expect(todo!.status).toBe('todo');
    expect(todo!.notion_synced).toBe(1);
  });

  it('sets category to school on new todos', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(makePage('page-1', 'HW 15.2')),
    );

    await runIncrementalSync();

    const todo = getTodoByNotionId('page-1');
    expect(todo!.category).toBe('school');
  });

  it('maps In Progress status correctly', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(makePage('page-2', 'HW8', { status: 'In Progress' })),
    );

    await runIncrementalSync();

    expect(getTodoByNotionId('page-2')!.status).toBe('in_progress');
  });

  it('maps Completed status to done', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(makePage('page-3', 'HW old', { status: 'Completed' })),
    );

    await runIncrementalSync();

    expect(getTodoByNotionId('page-3')!.status).toBe('done');
  });

  it('updates only Notion-mapped fields on existing todo', async () => {
    // Pre-create todo with local-only enrichment
    createTodo({
      id: 'local-1',
      title: 'Old title',
      status: 'todo',
      flexible: 0,             // locally changed
      estimated_minutes: 30,   // local-only field
      priority: 'high',        // local-only field
      notion_id: 'page-4',
      notion_synced: 1,
    });

    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(makePage('page-4', 'Updated title', { status: 'In Progress' })),
    );

    await runIncrementalSync();

    const todo = getTodoByNotionId('page-4');
    expect(todo!.title).toBe('Updated title');
    expect(todo!.status).toBe('in_progress');
    // Locally-enriched fields must not be overwritten
    expect(todo!.flexible).toBe(0);
    expect(todo!.estimated_minutes).toBe(30);
    expect(todo!.priority).toBe('high');
  });

  it('does not advance cursor when Notion API throws', async () => {
    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockRejectedValue(new Error('API error'));

    await expect(runIncrementalSync()).rejects.toThrow('API error');

    expect(getRouterState('notion_last_sync_at')).toBe('2026-01-01T00:00:00.000Z');
  });
});

// --- runFullSync ---

describe('runFullSync', () => {
  it('creates todos for all returned pages', async () => {
    mockQuery.mockResolvedValue({
      results: [
        makePage('page-a', 'HW 15.2', { course: 'MATH 2550' }),
        makePage('page-b', 'HW8', { course: 'CS 2050' }),
      ],
      has_more: false,
      next_cursor: null,
    });

    await runFullSync();

    expect(getTodoByNotionId('page-a')).toBeDefined();
    expect(getTodoByNotionId('page-b')).toBeDefined();
  });

  it('cancels todos whose notion_id is absent from sync', async () => {
    createTodo({
      id: 'gone-1',
      title: 'Deleted assignment',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      notion_id: 'deleted-page',
      notion_synced: 1,
    });

    mockQuery.mockResolvedValue(
      singlePage(makePage('page-a', 'HW 15.2')),
    );

    await runFullSync();

    const gone = getTodoByNotionId('deleted-page');
    expect(gone!.status).toBe('cancelled');
  });

  it('does not cancel done todos absent from sync', async () => {
    createTodo({
      id: 'done-1',
      title: 'Completed assignment',
      status: 'done',
      flexible: 1,
      priority: 'medium',
      notion_id: 'old-page',
      notion_synced: 1,
    });

    mockQuery.mockResolvedValue(
      singlePage(makePage('page-a', 'HW 15.2')),
    );

    await runFullSync();

    expect(getTodoByNotionId('old-page')!.status).toBe('done');
  });

  it('handles pagination', async () => {
    mockQuery
      .mockResolvedValueOnce({
        results: [makePage('page-1', 'HW 1')],
        has_more: true,
        next_cursor: 'cur-2',
      })
      .mockResolvedValueOnce({
        results: [makePage('page-2', 'HW 2')],
        has_more: false,
        next_cursor: null,
      });

    await runFullSync();

    expect(getTodoByNotionId('page-1')).toBeDefined();
    expect(getTodoByNotionId('page-2')).toBeDefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0].start_cursor).toBe('cur-2');
  });

  it('advances cursor after sync', async () => {
    mockQuery.mockResolvedValue(emptyResults());
    const before = getRouterState('notion_last_sync_at');

    await runFullSync();

    const after = getRouterState('notion_last_sync_at');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

// --- loadNotionConfig missing ---

describe('runIncrementalSync / runFullSync with missing config', () => {
  it('returns without error when config file is absent', async () => {
    const fsMock = (await import('fs')).default as typeof import('fs');
    vi.mocked(fsMock.existsSync).mockReturnValue(false);

    await expect(runIncrementalSync()).resolves.toBeUndefined();
    await expect(runFullSync()).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();

    vi.mocked(fsMock.existsSync).mockReturnValue(true);
  });
});
