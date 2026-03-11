import { app, BrowserWindow, shell, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Store from "electron-store";
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, "../..");

const envPath = process.env.VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, ".env")
  : path.join(process.resourcesPath, ".env");
dotenv.config({ path: envPath });

export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

// Disable GPU Acceleration for Windows 7
if (os.release().startsWith("6.1")) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
const preload = path.join(__dirname, "../preload/index.mjs");
const indexHtml = path.join(RENDERER_DIST, "index.html");

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const store = new Store<WindowBounds>({
  defaults: {
    width: 800,
    height: 600,
  },
});


async function createWindow() {
  // @ts-expect-error some sort of electron typing bug?
  const { width, height, x, y } = store.get("windowBounds", {
    width: 800,
    height: 600,
  });

  win = new BrowserWindow({
    title: "Main window",
    icon: path.join(process.env.VITE_PUBLIC ?? "", "favicon.ico"),
    x,
    y,
    width,
    height,
    frame: false, // make the window frameless
    titleBarStyle: "hidden", // This hides the native title bar but keeps the traffic lights
    trafficLightPosition: { x: 10, y: 12 }, // Adjust the position of traffic lights
    webPreferences: {
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // nodeIntegration: true,

      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      // contextIsolation: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    // #298
    win.loadURL(VITE_DEV_SERVER_URL);
    // Open devTool if the app is not packaged
    win.webContents.openDevTools();
  } else {
    win.loadFile(indexHtml);
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("close", () => {
    if (win) {
      store.set("windowBounds", win.getBounds());
    }
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  win = null;
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});

// New window example arg: new windows url
ipcMain.handle("open-win", (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
});

interface AppStore {
  backupKey?: string;
}

const appStore = new Store<AppStore>({ name: "typehere-app" });

function getBackupEncryptionKey(): Buffer {
  let key = appStore.get("backupKey");
  if (!key) {
    key = crypto.randomBytes(32).toString("hex");
    appStore.set("backupKey", key);
  }
  return Buffer.from(key, "hex");
}

function encryptBackup(plaintext: string): Buffer {
  const key = getBackupEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBackup(data: Buffer): string {
  const key = getBackupEncryptionKey();
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

function getR2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

const BACKUP_PREFIX = "backups/";

export interface BackupEntry {
  key: string;
  label: string;
  size: number;
  lastModified: string;
}

ipcMain.handle("backup:create", async (_, notesJson: string) => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const label = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const key = `${BACKUP_PREFIX}${label}.bin`;

  const encrypted = encryptBackup(notesJson);

  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: encrypted,
      ContentType: "application/octet-stream",
    })
  );

  return { key, label };
});

ipcMain.handle("backup:list", async () => {
  const client = getR2Client();
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME!,
      Prefix: BACKUP_PREFIX,
    })
  );

  const entries: BackupEntry[] = (response.Contents ?? [])
    .filter((obj) => obj.Key && obj.Key !== BACKUP_PREFIX)
    .map((obj) => ({
      key: obj.Key!,
      label: obj.Key!.replace(BACKUP_PREFIX, "").replace(".bin", ""),
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? "",
    }))
    .sort((a, b) => b.label.localeCompare(a.label));

  return entries;
});

ipcMain.handle("backup:restore", async (_, key: string) => {
  const client = getR2Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    })
  );

  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  return decryptBackup(data);
});

