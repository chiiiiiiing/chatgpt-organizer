export interface Revision { clock: number; device: string }
export interface Folder {
  id: string; name: string; parentId: string | null; order: number;
  revision: Revision; deleted: boolean;
}
export interface ConversationRef { id: string; title: string; url: string; seenAt: number }
export interface Placement {
  conversationId: string; folderId: string | null; title: string; url: string;
  revision: Revision; deleted: boolean;
}
export interface Settings {
  collapsedFolderIds: string[];
  organizerCollapsed: boolean;
  timelineExpanded: boolean;
  timelineHidden: boolean;
  syncEnabled: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  collapsedFolderIds: [], organizerCollapsed: false,
  timelineExpanded: false, timelineHidden: false, syncEnabled: true,
};
export interface SyncStatus {
  pending: number; error: string | null; lastSubmittedAt: number | null;
  bytes: number; items: number;
}
export interface Snapshot {
  folders: Folder[]; conversations: ConversationRef[]; placements: Placement[];
  settings: Settings; sync: SyncStatus;
}
export interface Backup {
  schemaVersion: 1; exportedAt: string; folders: Folder[];
  conversations: ConversationRef[]; placements: Placement[]; settings: Settings;
}
export interface ImportPreview { folders: number; conversations: number; placements: number; skipped: number }
export type Command =
  | { type: 'openSettings' }
  | { type: 'getState' }
  | { type: 'discover'; conversations: ConversationRef[] }
  | { type: 'createFolder'; name: string; parentId: string | null }
  | { type: 'renameFolder'; id: string; name: string }
  | { type: 'moveFolder'; id: string; parentId: string | null; beforeId?: string | null }
  | { type: 'deleteFolder'; id: string }
  | { type: 'assign'; conversationIds: string[]; folderId: string | null }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'exportBackup' }
  | { type: 'previewImport'; backup: unknown }
  | { type: 'importBackup'; backup: unknown }
  | { type: 'syncNow' };
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
export interface Turn {
  key: string; index: number; question: string; answer: string;
  element: HTMLElement; messageId: string | null;
}
export interface PageSnapshot {
  conversationId: string | null; title: string; turns: Turn[];
  conversations: ConversationRef[]; sidebar: HTMLElement | null;
  sidebarRegion?: HTMLElement | null;
  readingRoot: HTMLElement | null;
  scrollContainer: HTMLElement | null; dark: boolean;
}
export type Request = <T = Snapshot>(command: Command) => Promise<T>;
