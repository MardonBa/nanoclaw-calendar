import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  cancelDeletedNotionTodos,
  countMessagesSince,
  createTask,
  createTodo,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getSchoolTodosNeedingNotionCreate,
  getTaskById,
  getTodoById,
  getTodoByNotionId,
  getTodosNeedingNotionUpdate,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
  updateTodo,
} from './db.js';

import type { Todo } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('countMessagesSince returns total count excluding bot messages', () => {
    // The beforeEach for this describe block stores 10 user messages (no bots)
    const count = countMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(count).toBe(10);
  });

  it('countMessagesSince returns 0 when no messages match', () => {
    const count = countMessagesSince('group@g.us', '2099-01-01T00:00:00.000Z', 'Andy');
    expect(count).toBe(0);
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Todo CRUD ---

function makeTodo(
  overrides: Partial<Omit<Todo, 'created_at' | 'updated_at'>> = {},
): Omit<Todo, 'created_at' | 'updated_at'> {
  return {
    id: 'todo-1',
    title: 'Test todo',
    status: 'todo',
    flexible: 1,
    priority: 'medium',
    notion_synced: 0,
    ...overrides,
  };
}

describe('createTodo', () => {
  it('inserts a todo and retrieves it by id', () => {
    createTodo(makeTodo());
    const row = getTodoById('todo-1');
    expect(row).toBeDefined();
    expect(row!.title).toBe('Test todo');
    expect(row!.status).toBe('todo');
    expect(row!.priority).toBe('medium');
    expect(row!.flexible).toBe(1);
    expect(row!.notion_synced).toBe(0);
  });

  it('sets created_at and updated_at automatically', () => {
    createTodo(makeTodo());
    const row = getTodoById('todo-1');
    expect(row!.created_at).toBeDefined();
    expect(row!.updated_at).toBeDefined();
    expect(row!.created_at.length).toBeGreaterThan(0);
  });

  it('stores undefined for optional fields when omitted', () => {
    createTodo(makeTodo());
    const row = getTodoById('todo-1');
    expect(row!.notes).toBeUndefined();
    expect(row!.due_date).toBeUndefined();
    expect(row!.course).toBeUndefined();
    expect(row!.location).toBeUndefined();
    expect(row!.tags).toBeUndefined();
    expect(row!.notion_id).toBeUndefined();
  });

  it('serialises tags array and deserialises on read', () => {
    createTodo(makeTodo({ tags: ['campus', 'urgent'] }));
    const row = getTodoById('todo-1');
    expect(row!.tags).toEqual(['campus', 'urgent']);
  });

  it('stores a todo with a notion_id and finds it by notion_id', () => {
    createTodo(makeTodo({ notion_id: 'notion-abc' }));
    const row = getTodoByNotionId('notion-abc');
    expect(row).toBeDefined();
    expect(row!.id).toBe('todo-1');
  });
});

describe('updateTodo', () => {
  it('updates specified fields only', () => {
    createTodo(makeTodo({ due_date: '2026-04-01' }));
    updateTodo('todo-1', { title: 'Updated title' });
    const row = getTodoById('todo-1');
    expect(row!.title).toBe('Updated title');
    expect(row!.due_date).toBe('2026-04-01');
    expect(row!.priority).toBe('medium');
  });

  it('sets updated_at after update', () => {
    createTodo(makeTodo());
    updateTodo('todo-1', { status: 'done' });
    const row = getTodoById('todo-1');
    expect(row!.updated_at).toBeDefined();
    expect(row!.updated_at >= row!.created_at).toBe(true);
  });

  it('no-ops when fields object is empty', () => {
    createTodo(makeTodo());
    const before = getTodoById('todo-1');
    updateTodo('todo-1', {});
    const after = getTodoById('todo-1');
    expect(after!.title).toBe(before!.title);
    expect(after!.status).toBe(before!.status);
  });

  it('serialises tags on update', () => {
    createTodo(makeTodo());
    updateTodo('todo-1', { tags: ['home'] });
    const row = getTodoById('todo-1');
    expect(row!.tags).toEqual(['home']);
  });

  it('sets notion_id on an existing local-only todo', () => {
    createTodo(makeTodo());
    updateTodo('todo-1', { notion_id: 'notion-xyz', notion_synced: 1 });
    const row = getTodoByNotionId('notion-xyz');
    expect(row).toBeDefined();
    expect(row!.id).toBe('todo-1');
    expect(row!.notion_synced).toBe(1);
  });
});

describe('getTodoById', () => {
  it('returns undefined for unknown id', () => {
    expect(getTodoById('does-not-exist')).toBeUndefined();
  });
});

describe('getTodoByNotionId', () => {
  it('returns undefined for unknown notion_id', () => {
    expect(getTodoByNotionId('unknown')).toBeUndefined();
  });

  it('returns undefined for a local-only todo with no notion_id', () => {
    createTodo(makeTodo());
    expect(getTodoByNotionId('todo-1')).toBeUndefined();
  });
});

describe('cancelDeletedNotionTodos', () => {
  it('cancels todos whose notion_id is not in the active list', () => {
    createTodo(
      makeTodo({ id: 'a', notion_id: 'n-1', status: 'todo', notion_synced: 1 }),
    );
    createTodo(
      makeTodo({ id: 'b', notion_id: 'n-2', status: 'todo', notion_synced: 1 }),
    );

    cancelDeletedNotionTodos(['n-1']); // n-2 is absent

    expect(getTodoById('a')!.status).toBe('todo');
    expect(getTodoById('b')!.status).toBe('cancelled');
  });

  it('does not cancel todos without a notion_id', () => {
    createTodo(makeTodo({ id: 'local' }));

    cancelDeletedNotionTodos(['n-99']);

    expect(getTodoById('local')!.status).toBe('todo');
  });

  it('does not cancel done todos', () => {
    createTodo(
      makeTodo({
        id: 'done',
        notion_id: 'n-done',
        status: 'done',
        notion_synced: 1,
      }),
    );

    cancelDeletedNotionTodos(['n-other']);

    expect(getTodoById('done')!.status).toBe('done');
  });

  it('returns the count of cancelled rows', () => {
    createTodo(
      makeTodo({
        id: 'c1',
        notion_id: 'n-c1',
        status: 'todo',
        notion_synced: 1,
      }),
    );
    createTodo(
      makeTodo({
        id: 'c2',
        notion_id: 'n-c2',
        status: 'todo',
        notion_synced: 1,
      }),
    );

    const count = cancelDeletedNotionTodos([]);
    expect(count).toBe(0); // empty array guard

    const count2 = cancelDeletedNotionTodos(['n-c1']); // c2 gets cancelled
    expect(count2).toBe(1);
  });

  it('returns 0 and is no-op for empty array', () => {
    createTodo(
      makeTodo({
        id: 'e1',
        notion_id: 'n-e1',
        status: 'todo',
        notion_synced: 1,
      }),
    );

    const count = cancelDeletedNotionTodos([]);

    expect(count).toBe(0);
    expect(getTodoById('e1')!.status).toBe('todo');
  });
});

describe('getSchoolTodosNeedingNotionCreate', () => {
  it('returns school todos with no notion_id', () => {
    createTodo(makeTodo({ id: 'school-1', category: 'school' }));
    const todos = getSchoolTodosNeedingNotionCreate();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('school-1');
  });

  it('excludes school todos that already have a notion_id', () => {
    createTodo(
      makeTodo({
        id: 'school-1',
        category: 'school',
        notion_id: 'n-1',
        notion_synced: 1,
      }),
    );
    expect(getSchoolTodosNeedingNotionCreate()).toHaveLength(0);
  });

  it('excludes cancelled school todos', () => {
    createTodo(
      makeTodo({ id: 'school-1', category: 'school', status: 'cancelled' }),
    );
    expect(getSchoolTodosNeedingNotionCreate()).toHaveLength(0);
  });

  it('excludes non-school todos', () => {
    createTodo(makeTodo({ id: 'personal-1', category: 'personal' }));
    expect(getSchoolTodosNeedingNotionCreate()).toHaveLength(0);
  });

  it('returns multiple qualifying todos', () => {
    createTodo(makeTodo({ id: 'school-1', category: 'school' }));
    createTodo(makeTodo({ id: 'school-2', category: 'school' }));
    createTodo(makeTodo({ id: 'personal-1', category: 'personal' }));
    createTodo(
      makeTodo({
        id: 'school-3',
        category: 'school',
        notion_id: 'n-3',
        notion_synced: 1,
      }),
    );
    const todos = getSchoolTodosNeedingNotionCreate();
    expect(todos).toHaveLength(2);
    const ids = todos.map((t) => t.id);
    expect(ids).toContain('school-1');
    expect(ids).toContain('school-2');
  });
});

describe('getTodosNeedingNotionUpdate', () => {
  it('returns todos with notion_id and notion_synced=0', () => {
    createTodo(makeTodo({ id: 'a', notion_id: 'n-a', notion_synced: 0 }));
    const todos = getTodosNeedingNotionUpdate();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe('a');
  });

  it('excludes todos with notion_synced=1', () => {
    createTodo(makeTodo({ id: 'a', notion_id: 'n-a', notion_synced: 1 }));
    expect(getTodosNeedingNotionUpdate()).toHaveLength(0);
  });

  it('excludes todos without notion_id', () => {
    createTodo(makeTodo({ id: 'local', notion_synced: 0 }));
    expect(getTodosNeedingNotionUpdate()).toHaveLength(0);
  });
});
