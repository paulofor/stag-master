import type { PendingVideo, VideoAnalysisSummary } from "./request-video";
import type { BranchOperation, ProjectBranches } from "./project-branches";
import type { ProjectDatabases, SqlServerConfig } from "./database-connections";
import type { ApiAction, ProjectApis } from "./api-connections";
export type AccessMode = "read" | "project" | "windows";
export type RpcId = number | string;
export interface Model {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  isDefault: boolean;
  inputModalities?: string[];
}
export interface Project {
  path: string;
  name: string;
  git?: ProjectGitReport;
}
export interface DocumentationSource {
  name: string;
  url: string;
}
export interface ProjectGitReport {
  phase: "scanning" | "complete";
  scanned: number;
  found: number;
  added: number;
  verified: number;
  skipped: number;
  failures: number;
  incomplete: boolean;
  issues: { path: string; message: string }[];
}
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}
export interface ChatItem {
  id: string;
  kind: "user" | "assistant" | "command" | "file" | "web" | "status";
  text: string;
  output?: string;
  status?: string;
  phase?: string;
  images?: RequestImage[];
}
export interface RequestImage {
  dataUrl: string;
}
export const maxQueuedMessages = 20;
export interface QueuedMessage {
  id: string;
  text: string;
  status: "pending" | "sending" | "uncertain";
}
export interface Question {
  id: string;
  question: string;
  isSecret?: boolean;
  options: { label: string; description: string }[];
}
export interface Approval {
  id: string;
  kind: "command" | "file" | "desktop" | "browser" | "http" | "sql" | "database" | "questions";
  title: string;
  detail: string;
  questions?: Question[];
  blocking?: boolean;
}
export interface Snapshot {
  connection: "disconnected" | "connecting" | "ready" | "error";
  error: string | null;
  account: { email: string | null; plan: string | null } | null;
  loginPending: boolean;
  project: Project | null;
  projectSources: DocumentationSource[];
  projectBranches: ProjectBranches | null;
  projectDatabases: ProjectDatabases | null;
  projectApis: ProjectApis | null;
  models: Model[];
  model: string;
  effort: string;
  mode: AccessMode;
  threads: ThreadSummary[];
  threadId: string | null;
  busy: boolean;
  pendingVideo: PendingVideo | null;
  videoAnalysis: VideoAnalysisSummary | null;
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  items: ChatItem[];
  approvals: Approval[];
  plan: { step: string; status: string }[];
  diff: string;
  metrics: { requests: number; failures: number; totalTokens: number; elapsedMs: number };
  platform: string;
  browser: BrowserState;
}
export const browserTabs = ["documentation", "system"] as const;
export type BrowserTab = (typeof browserTabs)[number];
export const browserTabLabels: Record<BrowserTab, string> = {
  documentation: "Documentação",
  system: "Sistema do projeto",
};
export interface BrowserState extends BrowserInfo {
  available: boolean;
  visible: boolean;
  authorized: boolean;
  remember: boolean;
}
export interface BrowserPageInfo {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  download?: BrowserDownloadInfo;
  certificate?: BrowserCertificateInfo;
  insecureOrigin?: string;
}
export interface BrowserCertificateInfo {
  id: string;
  origin: string;
  fingerprint: string;
  error: string;
}
export interface BrowserDownloadInfo {
  status: "downloading" | "completed" | "failed" | "canceled";
  receivedBytes: number;
  totalBytes: number | null;
  path?: string;
  message: string;
}
export interface BrowserInfo extends BrowserPageInfo {
  activeTab: BrowserTab;
  tabs: Record<BrowserTab, BrowserPageInfo>;
}
export const emptyBrowserPage: BrowserPageInfo = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
};
export const emptySnapshot: Snapshot = {
  connection: "disconnected",
  error: null,
  account: null,
  loginPending: false,
  project: null,
  projectSources: [],
  projectBranches: null,
  projectDatabases: null,
  projectApis: null,
  models: [],
  model: "",
  effort: "",
  mode: "project",
  threads: [],
  threadId: null,
  busy: false,
  pendingVideo: null,
  videoAnalysis: null,
  queuedMessages: [],
  queuePaused: false,
  items: [],
  approvals: [],
  plan: [],
  diff: "",
  metrics: { requests: 0, failures: 0, totalTokens: 0, elapsedMs: 0 },
  platform: "browser",
  browser: {
    available: false,
    visible: true,
    authorized: false,
    remember: false,
    ...emptyBrowserPage,
    activeTab: "documentation",
    tabs: { documentation: { ...emptyBrowserPage }, system: { ...emptyBrowserPage } },
  },
};
export type Action =
  | ApiAction
  | { type: "connect" }
  | { type: "login" }
  | { type: "cancelLogin" }
  | { type: "logout" }
  | { type: "selectProject" }
  | { type: "projectSources"; projectPath: string; sources: DocumentationSource[] }
  | { type: "listBranches"; projectPath: string }
  | { type: "listDatabases"; projectPath: string }
  | {
      type: "recoverDatabases";
      projectPath: string;
      revision: string;
      sourceId: string;
      sourceRevision: string;
    }
  | { type: "databaseConsent"; projectPath: string; revision: string; allow: boolean }
  | {
      type: "saveDatabase";
      projectPath: string;
      revision: string;
      connectionId: string | null;
      config: SqlServerConfig;
      password: string;
      rememberPassword: boolean;
    }
  | { type: "deleteDatabase"; projectPath: string; revision: string; connectionId: string }
  | {
      type: "testDatabase";
      projectPath: string;
      revision: string;
      connectionId: string | null;
      testId: string;
      config: SqlServerConfig;
      password: string;
    }
  | { type: "cancelDatabaseTest"; projectPath: string; testId: string }
  | {
      type: "changeBranch";
      projectPath: string;
      revision: string;
      repositoryId: string;
      operation: BranchOperation;
    }
  | {
      type: "preferences";
      model?: string;
      effort?: string;
      mode?: AccessMode;
      windowsConsent?: boolean;
    }
  | { type: "newChat" }
  | { type: "resume"; threadId: string }
  | { type: "send"; text: string; images?: RequestImage[]; videoId?: string }
  | { type: "analyzeVideo" }
  | { type: "videoAnalysis"; id: string; control: "pause" | "resume" | "cancel" | "retry" }
  | { type: "selectVideo" }
  | { type: "removeVideo" }
  | { type: "enqueue"; threadId: string; id: string; text: string }
  | { type: "removeQueued"; threadId: string; id: string }
  | { type: "pauseQueue"; threadId: string; paused: boolean }
  | { type: "stop" }
  | { type: "answer"; id: string; accept?: boolean; answers?: Record<string, string> }
  | { type: "openLink"; url: string }
  | { type: "browserVisibility"; visible: boolean }
  | { type: "browserConsent"; allow: boolean }
  | { type: "browserTab"; tab: BrowserTab }
  | { type: "browserSession"; projectPath: string; remember: boolean }
  | { type: "browserControl"; control: BrowserControl }
  | { type: "browserBounds"; bounds: { x: number; y: number; width: number; height: number } };
export type BrowserControl = (
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" | "clearCertificateExceptions" }
  | { action: "trustCertificate"; certificateId: string; tab: BrowserTab }
) & { tab?: BrowserTab };
export interface DesktopBridge {
  getSnapshot(): Promise<Snapshot>;
  request(action: Action): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}
declare global {
  interface Window {
    stag?: DesktopBridge;
  }
}
