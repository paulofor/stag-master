import { contextBridge, ipcRenderer } from "electron";
import type { Action, DesktopBridge, Snapshot } from "../shared/types";

const bridge: DesktopBridge = {
  getSnapshot: () => ipcRenderer.invoke("stag:getSnapshot"),
  request: (action: Action) => ipcRenderer.invoke("stag:action", action),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot);
    ipcRenderer.on("stag:snapshot", handler);
    return () => {
      ipcRenderer.removeListener("stag:snapshot", handler);
    };
  },
};
contextBridge.exposeInMainWorld("stag", bridge);
