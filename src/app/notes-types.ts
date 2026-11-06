export const NOTE_TITLE_LIMIT = 120;
export const NOTE_BODY_LIMIT = 30_000;
export const NOTE_TAG_LIMIT = 8;
export const NOTE_TAG_LENGTH_LIMIT = 30;
export const NOTE_QUERY_LIMIT = 120;
export const NOTE_PAGE_SIZE = 30;

export interface NoteContent {
  title: string;
  body: string;
  tags: string[];
}

export interface Note extends NoteContent {
  id: string;
  workspace_id: string;
  project_id: string | null;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  can_edit: boolean;
}

export interface NoteUpdate extends NoteContent {
  pinned: boolean;
  archived: boolean;
}

export interface NoteListOptions {
  archived: boolean;
  query: string;
  offset: number;
}

export interface NotePage {
  notes: Note[];
  has_more: boolean;
}

export interface NotesApi {
  scopeKey: readonly unknown[];
  list(projectId: string | null, options: NoteListOptions, signal?: AbortSignal): Promise<NotePage>;
  create(projectId: string | null, id: string, content: NoteContent): Promise<Note>;
  update(projectId: string | null, note: Note, content: NoteUpdate): Promise<Note>;
  remove(projectId: string | null, note: Note): Promise<void>;
}
