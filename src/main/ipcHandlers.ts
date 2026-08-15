import { ipcMain, clipboard } from 'electron';
import * as store from './store';
import * as popupWindow from './popupWindow';
import { markSelfWritten } from './clipboardWatcher';

export function register(): void {
  ipcMain.handle('search', (_event, query: string) => {
    return store.search(query ?? '');
  });

  ipcMain.handle('selectEntry', (_event, id: number) => {
    const entry = store.getById(id);
    if (entry) {
      markSelfWritten(entry.text);
      clipboard.writeText(entry.text);
      store.touch(id);
    }
    popupWindow.hide();
  });

  ipcMain.on('hidePopup', () => {
    popupWindow.hide();
  });
}
