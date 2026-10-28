import type { ProjectIconName } from './project-identity';
import type { Task } from './types';

export const COMMENT_REACTIONS = ['👍', '🎉', '❤️', '👀', '🚀', '✅'] as const;
export type ReactionEmoji = (typeof COMMENT_REACTIONS)[number];
export const COMMENT_MAX_LENGTH = 4000;
export const COMMENT_PAGE_SIZE = 50;
export const INBOX_MAX_ITEMS = 200;

export interface MentionMember {
  member_id: string;
  display_name: string;
}

export interface CommentReaction {
  emoji: ReactionEmoji;
  count: number;
  mine: boolean;
}

export interface TaskComment {
  id: string;
  workspace_id: string;
  task_id: string;
  author_id: string;
  author_name: string;
  body: string;
  mentions: MentionMember[];
  reactions: CommentReaction[];
  version: number;
  sequence: number;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_delete: boolean;
}

export interface CommentThread {
  items: TaskComment[];
  next_before_id: number | null;
  participants: MentionMember[];
}

export interface InboxNotification {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string;
  comment_id: string | null;
  kind: 'mention' | 'comment' | 'assignment';
  actor_name: string;
  project_name: string;
  project_color: string;
  project_icon: ProjectIconName;
  task_title: string;
  created_at: string;
  read_at: string | null;
}

export interface InboxState {
  items: InboxNotification[];
  unread_count: number;
}

export interface CommunicationApi {
  scopeKey: string[];
  thread: (task: Task, beforeId?: number | null, signal?: AbortSignal) => Promise<CommentThread>;
  create: (task: Task, id: string, body: string, mentionMemberIds: string[]) => Promise<TaskComment>;
  update: (comment: TaskComment, body: string) => Promise<TaskComment>;
  remove: (comment: TaskComment) => Promise<void>;
  react: (comment: TaskComment, emoji: ReactionEmoji, active: boolean) => Promise<TaskComment>;
  inbox: (signal?: AbortSignal) => Promise<InboxState>;
  setRead: (id: string, read: boolean) => Promise<void>;
  readAll: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}
