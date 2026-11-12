import { describe, expect, it } from 'vitest';
import {
  createTaskSchema,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  saveAnnouncementSchema,
  taskListQuerySchema,
} from './operations.js';
import { PERMISSION_HINTS } from './permission-labels.js';

describe('operations schemas (M8)', () => {
  it('a task subject needs both its type and id', () => {
    expect(
      createTaskSchema.safeParse({ title: 'Call', assigneeId: 1, subjectType: 'family' }).success,
    ).toBe(false);
    const ok = createTaskSchema.parse({
      title: 'Call',
      assigneeId: 1,
      subjectType: 'family',
      subjectId: 3,
    });
    expect(ok.priority).toBe('normal');
    expect(createTaskSchema.safeParse({ title: 'Ca', assigneeId: 1 }).success).toBe(false);
  });

  it('task list defaults to the given box and accepts the open filter', () => {
    expect(taskListQuerySchema.parse({})).toMatchObject({ box: 'given', page: 1, perPage: 25 });
    expect(taskListQuerySchema.parse({ status: 'open', overdue: '1' })).toMatchObject({
      status: 'open',
      overdue: true,
    });
  });

  it('announcements default to every role, unpinned', () => {
    expect(saveAnnouncementSchema.parse({ title: 'Eid', body: 'No classes' })).toMatchObject({
      audience: [],
      pinned: false,
    });
  });

  it('every notification kind and the new permission have labels', () => {
    for (const k of NOTIFICATION_KINDS) expect(NOTIFICATION_KIND_LABELS[k].ar).toBeTruthy();
    expect(PERMISSION_HINTS['tasks.oversee'].ar).toBeTruthy();
  });
});
