const DB_NAME = "typehere-db";
const ASSETS_STORE_NAME = "assets";

interface AssetRecord {
  id: string;
  noteId: string;
  blob: Blob;
  mimeType: string;
  name: string;
}

let _cachedDb: IDBDatabase | null = null;

async function getAssetsDB(): Promise<IDBDatabase> {
  if (_cachedDb) return _cachedDb;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      _cachedDb = request.result;
      _cachedDb.onclose = () => { _cachedDb = null; };
      resolve(_cachedDb);
    };
  });
}

export async function saveAsset(
  id: string,
  noteId: string,
  blob: Blob,
  mimeType: string,
  name: string
): Promise<void> {
  const db = await getAssetsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readwrite");
    const store = tx.objectStore(ASSETS_STORE_NAME);
    const record: AssetRecord = { id, noteId, blob, mimeType, name };
    store.put(record, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAsset(id: string): Promise<AssetRecord | undefined> {
  const db = await getAssetsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readonly");
    const store = tx.objectStore(ASSETS_STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteAsset(id: string): Promise<void> {
  const db = await getAssetsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readwrite");
    const store = tx.objectStore(ASSETS_STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllAssets(): Promise<AssetRecord[]> {
  const db = await getAssetsDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readonly");
    const store = tx.objectStore(ASSETS_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export interface SerializedAsset {
  id: string;
  noteId: string;
  mimeType: string;
  name: string;
  data: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = atob(base64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    buffer[i] = bytes.charCodeAt(i);
  }
  return new Blob([buffer], { type: mimeType });
}

export async function serializeAssets(): Promise<SerializedAsset[]> {
  const assets = await getAllAssets();
  return Promise.all(
    assets.map(async (a) => ({
      id: a.id,
      noteId: a.noteId,
      mimeType: a.mimeType,
      name: a.name,
      data: await blobToBase64(a.blob),
    }))
  );
}

export async function restoreSerializedAssets(serialized: SerializedAsset[]): Promise<void> {
  for (const a of serialized) {
    const blob = base64ToBlob(a.data, a.mimeType);
    await saveAsset(a.id, a.noteId, blob, a.mimeType, a.name);
  }
}

export interface AssetManifestEntry {
  id: string;
  noteId: string;
  mimeType: string;
  name: string;
}

const UPLOADED_ASSETS_KEY = "typehere-uploaded-assets";

function getUploadedAssetIds(): Set<string> {
  const raw = localStorage.getItem(UPLOADED_ASSETS_KEY);
  return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
}

function markAssetUploaded(id: string) {
  const set = getUploadedAssetIds();
  set.add(id);
  localStorage.setItem(UPLOADED_ASSETS_KEY, JSON.stringify([...set]));
}

export async function uploadAssetToCloud(id: string): Promise<void> {
  if (!window.electronBackup?.uploadAsset) return;
  if (getUploadedAssetIds().has(id)) return;

  const asset = await getAsset(id);
  if (!asset) return;

  const base64 = await blobToBase64(asset.blob);
  await window.electronBackup.uploadAsset(id, base64);
  markAssetUploaded(id);
}

export async function downloadAssetFromCloud(entry: AssetManifestEntry): Promise<void> {
  if (!window.electronBackup?.downloadAsset) return;

  const existing = await getAsset(entry.id);
  if (existing) return;

  const base64 = await window.electronBackup.downloadAsset(entry.id);
  const blob = base64ToBlob(base64, entry.mimeType);
  await saveAsset(entry.id, entry.noteId, blob, entry.mimeType, entry.name);
}

export function generateAssetId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ImageRef {
  id: string;
  scale?: number;
}

export const IMAGE_REF_REGEX = /\[img:([a-f0-9]+)(?::(\d*\.?\d+))?\]/g;

export function parseImageRefs(line: string): ImageRef[] {
  const refs: ImageRef[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(IMAGE_REF_REGEX.source, "g");
  while ((match = regex.exec(line)) !== null) {
    refs.push({ id: match[1], scale: match[2] ? parseFloat(match[2]) : undefined });
  }
  return refs;
}

export function formatImageRef(id: string): string {
  return `[img:${id}]`;
}
