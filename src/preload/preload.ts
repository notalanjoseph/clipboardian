import { contextBridge, ipcRenderer } from 'electron';

export interface Entry {
  id: number;
  text: string;
  created_at: number;
  pinned: number;
}

contextBridge.exposeInMainWorld('clipboardAPI', {
  search: (query: string): Promise<Entry[]> => ipcRenderer.invoke('search', query),
  selectEntry: (id: number): Promise<void> => ipcRenderer.invoke('selectEntry', id),
  hidePopup: (): void => ipcRenderer.send('hidePopup'),
  onResetSearch: (callback: () => void): void => {
    ipcRenderer.on('reset-search', callback);
  },
});
