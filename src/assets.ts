const DB_NAME = "typehere-db";
const ASSETS_STORE_NAME = "assets";

interface AssetRecord {
  id: string;
  noteId: string;
  blob: Blob;
  mimeType: string;
  name: string;
}

async function getAssetsDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
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

export function generateAssetId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const IMAGE_REF_REGEX = /\[img:([a-f0-9]+)\]/g;

export function parseImageRefs(line: string): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(IMAGE_REF_REGEX.source, "g");
  while ((match = regex.exec(line)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

export function formatImageRef(id: string): string {
  return `[img:${id}]`;
}
