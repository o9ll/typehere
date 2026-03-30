export interface BackupEntry {
  key: string;
  label: string;
  size: number;
  lastModified: string;
}

export interface ElectronBackup {
  create: (notesJson: string) => Promise<{ key: string; label: string }>;
  list: () => Promise<BackupEntry[]>;
  restore: (key: string) => Promise<string>;
  onBeforeQuit: (callback: () => void) => void;
  offBeforeQuit: (callback: () => void) => void;
  sendQuitReady: () => void;
  uploadAsset: (id: string, base64Data: string) => Promise<void>;
  downloadAsset: (id: string) => Promise<string>;
}

declare global {
  interface Window {
    electronBackup?: ElectronBackup;
  }
}
