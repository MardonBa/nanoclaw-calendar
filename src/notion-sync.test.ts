import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  createTodo,
  getTodoById,
  getTodoByNotionId,
  getRouterState,
  setRouterState,
} from './db.js';
import { runIncrementalSync, runFullSync } from './notion-sync.js';

// --- Mock @notionhq/client ---
// vi.hoisted ensures mockQuery is defined before the vi.mock factory runs (which is hoisted)

const mockQuery = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

vi.mock('@notionhq/client', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Client: function MockClient(_opts: unknown) {
    return {
      databases: { query: mockQuery },
      pages: { create: mockCreate, update: mockUpdate },
    };
  },
  isFullPage: vi.fn(
    (page: unknown) =>
      typeof page === 'object' && page !== null && 'properties' in page,
  ),
}));

// --- Mock fs so loadNotionConfig() returns a test config by default ---

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((p: unknown, options?: unknown) => {
        if (String(p).includes('notion.json')) {
          return JSON.stringify({ token: 'test-token', databaseId: 'db-1' });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (actual.readFileSync as any)(p, options);
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
    due_date?: string; // YYYY-MM-DD
    course?: string; // e.g. 'CS 2050'
    status?: string; // 'Not Started' | 'In Progress' | 'Completed'
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
  mockCreate.mockReset();
  mockUpdate.mockReset();
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
      singlePage(
        makePage('page-1', 'HW 15.2', {
          due_date: '2026-03-30',
          course: 'MATH 2550',
          status: 'Not Started',
        }),
      ),
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
    mockQuery.mockResolvedValue(singlePage(makePage('page-1', 'HW 15.2')));

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
      flexible: 0, // locally changed
      estimated_minutes: 30, // local-only field
      priority: 'high', // local-only field
      notion_id: 'page-4',
      notion_synced: 1,
    });

    setRouterState('notion_last_sync_at', '2026-01-01T00:00:00.000Z');
    mockQuery.mockResolvedValue(
      singlePage(
        makePage('page-4', 'Updated title', { status: 'In Progress' }),
      ),
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

    expect(getRouterState('notion_last_sync_at')).toBe(
      '2026-01-01T00:00:00.000Z',
    );
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

    mockQuery.mockResolvedValue(singlePage(makePage('page-a', 'HW 15.2')));

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

    mockQuery.mockResolvedValue(singlePage(makePage('page-a', 'HW 15.2')));

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

// --- pushSchoolTodosToNotion ---

describe('pushSchoolTodosToNotion (via runFullSync)', () => {
  it('creates a Notion page for a school todo with no notion_id', async () => {
    createTodo({
      id: 'local-school',
      title: 'HW 1',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });
    mockCreate.mockResolvedValue({ id: 'new-page-id' });
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.properties['Name'].title[0].text.content).toBe('HW 1');
  });

  it('stores the returned page id as notion_id on the local todo', async () => {
    createTodo({
      id: 'local-school',
      title: 'HW 1',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });
    mockCreate.mockResolvedValue({ id: 'new-page-id' });
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    const todo = getTodoById('local-school');
    expect(todo!.notion_id).toBe('new-page-id');
    expect(todo!.notion_synced).toBe(1);
  });

  it('does not create a page for a non-school todo', async () => {
    createTodo({
      id: 'personal-1',
      title: 'Buy milk',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'personal',
      notion_synced: 0,
    });
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not create a page for a cancelled school todo', async () => {
    createTodo({
      id: 'cancelled-school',
      title: 'Old HW',
      status: 'cancelled',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('continues past a failed create and processes the next todo', async () => {
    createTodo({
      id: 'fail-1',
      title: 'Bad HW',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });
    createTodo({
      id: 'ok-2',
      title: 'Good HW',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });
    mockCreate
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce({ id: 'page-ok' });
    mockQuery.mockResolvedValue(emptyResults());

    await expect(runFullSync()).resolves.toBeUndefined();

    expect(getTodoById('fail-1')!.notion_id).toBeUndefined();
    expect(getTodoById('ok-2')!.notion_id).toBe('page-ok');
  });
});

// --- pushStatusUpdatesToNotion ---

describe('pushStatusUpdatesToNotion (via runFullSync)', () => {
  it('pushes update for a todo with notion_id and notion_synced=0', async () => {
    createTodo({
      id: 'synced-1',
      title: 'HW 5',
      status: 'done',
      flexible: 1,
      priority: 'medium',
      notion_id: 'page-5',
      notion_synced: 0,
    });
    mockUpdate.mockResolvedValue({});
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg.page_id).toBe('page-5');
    expect(updateArg.properties['Status'].select.name).toBe('Completed');
  });

  it('sets notion_synced=1 after a successful update', async () => {
    createTodo({
      id: 'synced-1',
      title: 'HW 5',
      status: 'done',
      flexible: 1,
      priority: 'medium',
      notion_id: 'page-5',
      notion_synced: 0,
    });
    mockUpdate.mockResolvedValue({});
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(getTodoById('synced-1')!.notion_synced).toBe(1);
  });

  it('does not push a todo with notion_synced=1', async () => {
    createTodo({
      id: 'synced-already',
      title: 'HW 6',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      notion_id: 'page-6',
      notion_synced: 1,
    });
    mockQuery.mockResolvedValue(emptyResults());

    await runFullSync();

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('continues past a failed update', async () => {
    createTodo({
      id: 'fail-upd',
      title: 'HW fail',
      status: 'done',
      flexible: 1,
      priority: 'medium',
      notion_id: 'page-fail',
      notion_synced: 0,
    });
    createTodo({
      id: 'ok-upd',
      title: 'HW ok',
      status: 'in_progress',
      flexible: 1,
      priority: 'medium',
      notion_id: 'page-ok',
      notion_synced: 0,
    });
    mockUpdate
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce({});
    mockQuery.mockResolvedValue(emptyResults());

    await expect(runFullSync()).resolves.toBeUndefined();

    expect(getTodoById('fail-upd')!.notion_synced).toBe(0);
    expect(getTodoById('ok-upd')!.notion_synced).toBe(1);
  });
});

// --- push runs before pull ---

describe('push runs before pull in runFullSync', () => {
  it('calls pages.create before databases.query', async () => {
    createTodo({
      id: 'school-push',
      title: 'Push first',
      status: 'todo',
      flexible: 1,
      priority: 'medium',
      category: 'school',
      notion_synced: 0,
    });

    const callOrder: string[] = [];
    mockCreate.mockImplementation(() => {
      callOrder.push('create');
      return Promise.resolve({ id: 'page-new' });
    });
    mockQuery.mockImplementation(() => {
      callOrder.push('query');
      return Promise.resolve(emptyResults());
    });

    await runFullSync();

    expect(callOrder[0]).toBe('create');
    expect(callOrder).toContain('query');
  });
});
