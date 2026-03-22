import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getTodoById } from './db.js';
import { processTodoIpc } from './ipc.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper: minimal valid create_todo IPC message
function makeCreateData(payloadOverrides: Record<string, unknown> = {}) {
  return {
    type: 'create_todo',
    payload: { id: 'todo-1', title: 'Test todo', ...payloadOverrides },
  };
}

// --- processTodoIpc: create_todo ---

describe('processTodoIpc — create_todo', () => {
  it('creates a todo with required fields', () => {
    const result = processTodoIpc(makeCreateData(), 'main', true);
    expect(result.ok).toBe(true);
    const row = getTodoById('todo-1');
    expect(row).toBeDefined();
    expect(row!.title).toBe('Test todo');
    expect(row!.id).toBe('todo-1');
  });

  it('applies defaults for status, priority, flexible, notion_synced', () => {
    processTodoIpc(makeCreateData(), 'main', true);
    const row = getTodoById('todo-1');
    expect(row!.status).toBe('todo');
    expect(row!.priority).toBe('medium');
    expect(row!.flexible).toBe(1);
    expect(row!.notion_synced).toBe(0);
  });

  it('stores optional fields when provided in payload', () => {
    processTodoIpc(
      makeCreateData({
        due_date: '2026-05-01',
        category: 'school',
        course: 'COMP 101',
      }),
      'main',
      true,
    );
    const row = getTodoById('todo-1');
    expect(row!.due_date).toBe('2026-05-01');
    expect(row!.category).toBe('school');
    expect(row!.course).toBe('COMP 101');
  });

  it('stores and deserialises tags', () => {
    processTodoIpc(
      makeCreateData({ tags: ['campus', 'urgent'] }),
      'main',
      true,
    );
    const row = getTodoById('todo-1');
    expect(row!.tags).toEqual(['campus', 'urgent']);
  });

  it('does nothing when payload id is missing', () => {
    const result = processTodoIpc(
      { type: 'create_todo', payload: { title: 'No id' } },
      'main',
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(getTodoById('todo-1')).toBeUndefined();
  });

  it('does nothing when payload title is missing', () => {
    const result = processTodoIpc(
      { type: 'create_todo', payload: { id: 'todo-1' } },
      'main',
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(getTodoById('todo-1')).toBeUndefined();
  });

  it('does not throw when payload is null', () => {
    let result!: ReturnType<typeof processTodoIpc>;
    expect(() => {
      result = processTodoIpc(
        { type: 'create_todo', payload: null },
        'main',
        true,
      );
    }).not.toThrow();
    expect(result.ok).toBe(false);
    expect(getTodoById('todo-1')).toBeUndefined();
  });

  it('does not throw when payload is a string', () => {
    let result!: ReturnType<typeof processTodoIpc>;
    expect(() => {
      result = processTodoIpc(
        { type: 'create_todo', payload: 'bad' },
        'main',
        true,
      );
    }).not.toThrow();
    expect(result.ok).toBe(false);
    expect(getTodoById('todo-1')).toBeUndefined();
  });
});

// --- processTodoIpc: update_todo ---

describe('processTodoIpc — update_todo', () => {
  it('updates fields on an existing todo', () => {
    processTodoIpc(makeCreateData(), 'main', true);
    const result = processTodoIpc(
      { type: 'update_todo', id: 'todo-1', payload: { status: 'done' } },
      'main',
      true,
    );
    expect(result.ok).toBe(true);
    expect(getTodoById('todo-1')!.status).toBe('done');
  });

  it('partial update leaves other fields unchanged', () => {
    processTodoIpc(makeCreateData({ due_date: '2026-05-01' }), 'main', true);
    processTodoIpc(
      { type: 'update_todo', id: 'todo-1', payload: { title: 'New title' } },
      'main',
      true,
    );
    const row = getTodoById('todo-1');
    expect(row!.title).toBe('New title');
    expect(row!.due_date).toBe('2026-05-01');
  });

  it('returns ok:true on nonexistent id (updateTodo is a no-op)', () => {
    const result = processTodoIpc(
      { type: 'update_todo', id: 'no-such-id', payload: { status: 'done' } },
      'main',
      true,
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok:false when top-level id is missing', () => {
    const result = processTodoIpc(
      { type: 'update_todo', payload: { status: 'done' } },
      'main',
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns ok:false when payload is null', () => {
    processTodoIpc(makeCreateData(), 'main', true);
    const result = processTodoIpc(
      { type: 'update_todo', id: 'todo-1', payload: null },
      'main',
      true,
    );
    expect(result.ok).toBe(false);
    // original data unchanged
    expect(getTodoById('todo-1')!.status).toBe('todo');
  });
});

// --- processTodoIpc: unknown type ---

describe('processTodoIpc — unknown type', () => {
  it('returns ok:false on unknown type', () => {
    const result = processTodoIpc({ type: 'unknown_operation' }, 'main', true);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
