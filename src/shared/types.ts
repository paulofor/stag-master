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
export interface Question {
  id: string;
  question: string;
  isSecret?: boolean;
  options: { label: string; description: string }[];
}
export interface Approval {
  id: string;
  kind: "command" | "file" | "desktop" | "browser" | "questions";
  title: string;
  detail: string;
  questions?: Question[];
}
export interface Snapshot {
  connection: "disconnected" | "connecting" | "ready" | "error";
  error: string | null;
  account: { email: string | null; plan: string | null } | null;
  loginPending: boolean;
  project: Project | null;
  models: Model[];
  model: string;
  effort: string;
  mode: AccessMode;
  threads: ThreadSummary[];
  threadId: string | null;
  busy: boolean;
  items: ChatItem[];
  approvals: Approval[];
  plan: { step: string; status: string }[];
  diff: string;
  metrics: { requests: number; failures: number; totalTokens: number; elapsedMs: number };
  platform: string;
  browser: BrowserState;
}
export interface BrowserState {
  available: boolean;
  visible: boolean;
  authorized: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}
export type BrowserInfo = Omit<BrowserState, "available" | "visible" | "authorized">;
export const emptySnapshot: Snapshot = {
  connection: "disconnected",
  error: null,
  account: null,
  loginPending: false,
  project: null,
  models: [],
  model: "",
  effort: "",
  mode: "project",
  threads: [],
  threadId: null,
  busy: false,
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
    url: "",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
  },
};
export type Action =
  | { type: "connect" }
  | { type: "login" }
  | { type: "cancelLogin" }
  | { type: "logout" }
  | { type: "selectProject" }
  | {
      type: "preferences";
      model?: string;
      effort?: string;
      mode?: AccessMode;
      windowsConsent?: boolean;
    }
  | { type: "newChat" }
  | { type: "resume"; threadId: string }
  | { type: "send"; text: string; images?: RequestImage[] }
  | { type: "stop" }
  | { type: "answer"; id: string; accept?: boolean; answers?: Record<string, string> }
  | { type: "openLink"; url: string }
  | { type: "browserVisibility"; visible: boolean }
  | { type: "browserConsent"; allow: boolean }
  | { type: "browserControl"; control: BrowserControl }
  | { type: "browserBounds"; bounds: { x: number; y: number; width: number; height: number } };
export type BrowserControl =
  { action: "navigate"; url: string } | { action: "back" | "forward" | "reload" };
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
