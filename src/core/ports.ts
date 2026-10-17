// Module contracts, copied verbatim from docs/design.md §2. Change both together.
// ---------- shared ----------
export type VaultPath = string & { readonly __brand: "VaultPath" }; // NFC, '/'-separated, no leading '/', validated
export interface Clock { now(): number; sleep(ms: number): Promise<void>; }

// ---------- local vault ----------
export interface LocalEntry { path: VaultPath; size: number; mtime: number; isFolder: boolean; }
export interface VaultPort {
  list(): Promise<LocalEntry[]>;                         // excludes configDir, hidden segments, exclude patterns
  stat(path: VaultPath): Promise<LocalEntry | null>;
  read(path: VaultPath): Promise<ArrayBuffer>;
  /** Atomic replace: write to hidden temp sibling via adapter, then rename into place. */
  writeAtomic(path: VaultPath, data: ArrayBuffer): Promise<void>;
  mkdirp(path: VaultPath): Promise<void>;
  /** Vault.rename (not FileManager.renameFile): the originating device already rewrote links. */
  move(from: VaultPath, to: VaultPath): Promise<void>;
  /** FileManager.trashFile: honors the user's "Deleted files" setting [O-API-7]. */
  trash(path: VaultPath): Promise<void>;
  removeEmptyFolder(path: VaultPath): Promise<boolean>;
}

// ---------- remote ----------
export interface RemoteItem {
  id: string; parentId: string | null; name: string; isFolder: boolean;
  eTag: string; cTag: string | null; size: number; quickXorHash: string | null;
  lastModified: string; deleted: boolean;
}
export interface DeltaPage { items: RemoteItem[]; nextLink?: string; deltaLink?: string; }
export interface AppRoot {
  item: RemoteItem;
  /** Decoded drive path of the approot WITHOUT the "/drive/root:" prefix, e.g. "/Apps/MDVaultSync". */
  pathPrefix: string;
}
export interface UploadTarget { kind: "new"; parentId: string; name: string } // or replace an existing item:
export interface UploadTargetReplace { kind: "replace"; id: string }
export interface UploadSessionInfo { uploadUrl: string; expiresAt: string; }
export interface UploadStatus { nextExpectedStart: number | null; expiresAt: string; } // null = complete or gone
export interface RemotePort {
  getAppRoot(): Promise<AppRoot>;
  delta(link: string | null): Promise<DeltaPage>;                    // null = start full enumeration
  listChildren(folderId: string): Promise<RemoteItem[]>;             // fallback if delta unsupported [G-DL-1]
  getItem(id: string): Promise<RemoteItem | null>;
  getChildByName(parentId: string, name: string): Promise<RemoteItem | null>; // after 409 nameAlreadyExists
  // upload sessions [G-UP-5]..[G-UP-9]; ifMatch applies at creation only (see §6.3 for the commit-time check)
  createUploadSession(target: UploadTarget | UploadTargetReplace, ifMatch: string | null, size: number): Promise<UploadSessionInfo>;
  putFragment(uploadUrl: string, start: number, total: number, bytes: ArrayBuffer): Promise<RemoteItem | null>; // item on final fragment
  getUploadStatus(uploadUrl: string): Promise<UploadStatus>;         // 404 → { nextExpectedStart: null }
  cancelUpload(uploadUrl: string): Promise<void>;
  download(id: string, expectedSize?: number): Promise<ArrayBuffer>; // via fresh downloadUrl, no auth header [G-DLD-1]; refused before the GET if the item's size isn't expectedSize (M6, T-D6)
  createFolder(parentId: string, name: string): Promise<RemoteItem>; // conflictBehavior=fail
  uploadNew(parentId: string, name: string, data: ArrayBuffer): Promise<RemoteItem>;   // fail on name clash
  uploadReplace(id: string, ifMatch: string, data: ArrayBuffer): Promise<RemoteItem>;  // 412 → PreconditionFailed
  move(id: string, ifMatch: string, newParentId: string, newName: string): Promise<RemoteItem>;
  delete(id: string, ifMatch: string): Promise<void>;                // recycle bin, never permanentDelete
  quota(): Promise<{ total: number; used: number; remaining: number } | null>; // null if scope disallows [G-QT-1]
}

// ---------- content transform (E2EE seam) ----------
export interface TransformContext { path: VaultPath; }
export interface ContentTransform {
  readonly id: string;                                    // "identity" in v1; persisted per file record
  encode(plain: ArrayBuffer, ctx: TransformContext): Promise<ArrayBuffer>;
  decode(stored: ArrayBuffer, ctx: TransformContext): Promise<ArrayBuffer>;
}
/** The only path content takes between executor and RemotePort (src/core/remote-content.ts). */
export interface RemoteContent {
  /** download → verify stored-bytes hash → decode. Returns plaintext and the stored-bytes hash. */
  fetch(item: RemoteItem, path: VaultPath): Promise<{ plain: ArrayBuffer; remoteHash: string }>;
  /** encode → (simple PUT | upload session) → verify returned hash. */
  store(target: UploadTarget | UploadTargetReplace, ifMatch: string | null, plain: ArrayBuffer, path: VaultPath,
        onSession?: (s: UploadSessionInfo) => Promise<void>): Promise<{ item: RemoteItem; remoteHash: string }>;
  /** Stored-bytes hash this plaintext WOULD have remotely (encode + quickXorHash). Identity: equals the plaintext hash. */
  storedHashOf(plain: ArrayBuffer, path: VaultPath): Promise<string>;
  /** Continues a persisted upload session from its nextExpectedRanges (M6, §6.3). null: the session is gone; start over. */
  resume(rec: UploadSessionRecord, plain: ArrayBuffer): Promise<{ item: RemoteItem; remoteHash: string } | null>;
}

// ---------- persisted state ----------
export interface FileRecord {
  path: VaultPath; remoteId: string; eTag: string; cTag: string | null;
  size: number;            // local plaintext size at last sync
  mtime: number;           // local mtime at last sync
  localHash: string;       // quickXorHash of local plaintext
  remoteHash: string;      // quickXorHash of stored bytes (== localHash under identity transform)
  transformId: string;
}
export interface UploadSessionRecord {
  path: VaultPath; uploadUrl: string; expiresAt: string; totalSize: number;
  localHash: string; ifMatch: string | null;   // eTag the session was created against (replace only)
  target: UploadTarget | UploadTargetReplace;
}
export interface PendingConflict { path: VaultPath; copyPath: VaultPath; localHash: string; remoteId: string; }
export interface SyncState {
  schemaVersion: 1;
  deviceId: string;                         // random UUID, generated once per device
  appRootId: string | null;
  deltaLink: string | null;
  remoteIndex: Record<string, RemoteItem>;  // id → item (folders + files), mirror of approot subtree
  files: Record<VaultPath, FileRecord>;
  folders: Record<VaultPath, string>;       // path → remote folder id
  pendingLocal: PendingLocalOp[];           // from vault events since last successful sync
  uploadSessions: Record<VaultPath, UploadSessionRecord>;
  pendingConflicts: Record<VaultPath, PendingConflict>; // written BEFORE the conflict copy (§5.5)
  firstSyncCompleted: boolean;
  /** Persisted union mode: set when a first sync / resync / approot change starts, cleared only when a
   *  union run finishes ok|partial. Survives crashes so a resumed run can never delete (R-FIRST-1). */
  unionPending: boolean;
  /** Paths whose remote delete the user declined; not re-prompted until their local or remote state changes. */
  declinedDeletes: Record<VaultPath, { localHash: string | null; eTag: string | null }>;
  lastReport: SyncReport | null;
}
export type PendingLocalOp =
  | { kind: "dirty"; path: VaultPath }
  | { kind: "deleted"; path: VaultPath }
  | { kind: "renamed"; from: VaultPath; to: VaultPath };
export interface StateStore { load(): Promise<SyncState | null>; save(s: SyncState): Promise<void>; clear(): Promise<void>; }

// ---------- auth ----------
export interface TokenStore {
  get(): string | null;
  set(refreshToken: string): Promise<void>;   // async: saves the non-secret sessionOnlySignIn flag
  clear(): Promise<void>;
  /** "secret-storage" = Obsidian SecretStorage (OS encryption NOT guaranteed, see §4); "memory" = this session only (D-5). */
  readonly backend: "secret-storage" | "memory";
}
export interface AccessTokenProvider { getAccessToken(): Promise<string>; } // single-flight refresh

// ---------- HTTP ----------
export interface HttpRequest {
  url: string; method: string; headers?: Record<string, string>; body?: ArrayBuffer | string;
  /** Overrides the size-based default of the timeout decorator (src/remote/timeout.ts); downloads set it from the item size. */
  timeoutMs?: number;
}
export interface HttpResponse { status: number; headers: Record<string, string>; body: ArrayBuffer; }
export interface HttpTransport { send(req: HttpRequest): Promise<HttpResponse>; } // never throws on status; throws on network failure

// ---------- plan & report ----------
export type PlanOp =
  | { kind: "download"; id: string; path: VaultPath; reason: string }
  | { kind: "upload-new"; path: VaultPath }
  | { kind: "upload-replace"; path: VaultPath; id: string; ifMatch: string }
  | { kind: "remote-move"; id: string; ifMatch: string; from: VaultPath; to: VaultPath }
  | { kind: "local-move"; from: VaultPath; to: VaultPath }
  | { kind: "remote-delete"; id: string; ifMatch: string; path: VaultPath }
  | { kind: "local-trash"; path: VaultPath }
  | { kind: "conflict"; path: VaultPath; id: string; copyPath: VaultPath; noHistory?: true } // noHistory: no base (preview group, M7)
  | { kind: "adopt"; path: VaultPath; id: string }          // identical content both sides: record only
  | { kind: "forget"; path: VaultPath }                     // gone on both sides: drop record
  | { kind: "skip"; path: VaultPath; reason: SkipReason };
export type SkipReason = "too-large" | "invalid-name" | "path-too-long" | "case-collision"
  | "reserved-name" | "outside-vault" | "hidden" | "excluded" | "unicode-collision";
export interface Plan {
  ops: PlanOp[]; deleteCount: number; trackedCount: number;
  unionMode: boolean;
  /** No-base pairs whose content differs (stale device rejoining): each becomes a conflict; shown as its own preview group. */
  differsNoHistory: number;
}
export interface SyncReport {
  trigger: Trigger;
  startedAt: number; finishedAt: number; result: "ok" | "partial" | "failed" | "cancelled";
  counts: Record<PlanOp["kind"], number>;
  touched: { kind: PlanOp["kind"]; path: VaultPath; to?: VaultPath }[]; // every path the run changed (T-R1)
  conflicts: { path: VaultPath; copyPath: VaultPath }[];
  skipped: { path: VaultPath; reason: SkipReason }[];
  errors: { path: VaultPath | null; code: string }[];
}

// ---------- engine & logging ----------
export type Trigger = "startup" | "interval" | "command" | "ribbon" | "preview" | "rerun";
export interface SyncHooks {
  /** Show the plan; resolve true to run. Never called for unattended triggers except on first sync (see §5.4). */
  confirmPlan(plan: Plan): Promise<boolean>;
  /** Resolve true to delete, false to skip deletes this run. */
  confirmDeletes(ops: PlanOp[]): Promise<boolean>;
  onStatus(s: EngineStatus): void;
  /** After every run, reruns included (M7: notices; requestSync returns only the last run's report). */
  onReport?(r: SyncReport): void;
}
export type EngineStatus =
  | { state: "idle"; lastSyncAt: number | null } | { state: "syncing"; phase: string }
  | { state: "waiting-for-user" } | { state: "error"; code: string } | { state: "sign-in-required" };
export interface SyncEngine { requestSync(trigger: Trigger): Promise<SyncReport>; readonly status: EngineStatus; }
export type OpKind = "auth.refresh" | "auth.signin" | "graph.request" | "sync.run" | "sync.pull" | "sync.scan"
  | "sync.plan" | "sync.exec" | `op.${PlanOp["kind"]}` | "upload.fragment" | "upload.resume" | "retry.backoff" | "state.save"
  | "ui.settings"; // M8: settings-tab breadcrumbs (matrix row 10)
