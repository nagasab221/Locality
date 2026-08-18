import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("locality", {
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("choose-folder"),
  chooseFile: (filters: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke("choose-file", filters),
  showInFolder: (p: string): Promise<void> => ipcRenderer.invoke("show-in-folder", p),
  enterServerMode: (): Promise<void> => ipcRenderer.invoke("enter-server-mode"),
  setAutostart: (enabled: boolean): Promise<void> => ipcRenderer.invoke("set-autostart", enabled),

  // Experimental mpv playback engine (Phase 0 spike).
  mpv: {
    start: (fileId: number, startSec = 0, title = "", hasNext = false, alang = "", slang = ""): Promise<{ ok?: boolean; error?: string; url?: string; bin?: string }> =>
      ipcRenderer.invoke("mpv:start", fileId, startSec, title, hasNext, alang, slang),
    command: (command: unknown[]): Promise<void> => ipcRenderer.invoke("mpv:command", command),
    stop: (): Promise<void> => ipcRenderer.invoke("mpv:stop"),
    /** Advance to the next episode (relayed to the main window). */
    next: (): Promise<void> => ipcRenderer.invoke("mpv:next"),
    /** Toggle the app window's fullscreen (mpv fills it). */
    fullscreen: (): Promise<void> => ipcRenderer.invoke("mpv:fullscreen"),
    /** Open the OpenSubtitles search dialog window. */
    subSearch: (): Promise<void> => ipcRenderer.invoke("mpv:sub-search"),
    /** Pick a local subtitle file and load it into mpv. */
    subAddFile: (): Promise<void> => ipcRenderer.invoke("mpv:sub-add-file"),
    /** Close the OpenSubtitles search dialog window (called from inside it). */
    closeSubSearch: (): Promise<void> => ipcRenderer.invoke("mpv:sub-search-close"),
    /** Subscribe to mpv events (prop/ended/error/exit). Returns an unsubscribe fn. */
    onEvent: (cb: (data: any) => void): (() => void) => {
      const listener = (_e: unknown, data: any) => cb(data);
      ipcRenderer.on("mpv:event", listener);
      return () => ipcRenderer.removeListener("mpv:event", listener);
    },
  },
});
