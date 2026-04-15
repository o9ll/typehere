/* eslint-disable react-hooks/exhaustive-deps */
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import LZString from "lz-string";
import Fuse from "fuse.js";
import AceEditor from "react-ace";
import { FaMapPin } from "react-icons/fa";
import { MdVisibilityOff } from "react-icons/md";
import { FiMoreHorizontal } from "react-icons/fi";
import isElectron from "is-electron";
import type { BackupEntry } from "./electron.d";
import { THEMES, applyThemeToDocument, restoreThemeFromCache, getThemeById } from "./themes";
import { saveAsset, getAsset, generateAssetId, formatImageRef, restoreSerializedAssets, type SerializedAsset, uploadAssetToCloud, downloadAssetFromCloud, type AssetManifestEntry, IMAGE_REF_REGEX } from "./assets";
import { ImageWidgetManager } from "./imageWidgets";
import { SpotifyWidgetManager, SPOTIFY_URL_REGEX } from "./spotifyWidgets";
import ImageSpotlight from "./ImageSpotlight";
import "./App.css";

const textsToReplace: [string | RegExp, string][] = [
  ["(c)", "©"],
  ["(r)", "®"],
  ["+-", "±"],
];

interface Snippet {
  name: string;
  description: string;
  getValue: () => string;
}

const digitCount = 5;

const DB_NAME = "typehere-db";
const STORE_NAME = "app-state";

type Migration = {
  version: number;
  migrate: (db: IDBDatabase, transaction: IDBTransaction) => void;
};

const ASSETS_STORE_NAME = "assets";

const migrations: Migration[] = [
  {
    version: 1,
    migrate: (db, transaction) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      const store = transaction.objectStore(STORE_NAME);
      store.put({ version: 1, stores: [STORE_NAME] }, "db_schema");
    },
  },
  {
    version: 2,
    migrate: (db) => {
      if (!db.objectStoreNames.contains(ASSETS_STORE_NAME)) {
        db.createObjectStore(ASSETS_STORE_NAME);
      }
    },
  },
];

// Update DB_VERSION automatically based on migrations
const DB_VERSION_LATEST = Math.max(...migrations.map((m) => m.version));

// Add connection pooling
const DB_CONNECTION_POOL: { [key: string]: IDBDatabase } = {};
const MAX_POOL_SIZE = 5;

function getConnectionFromPool(dbName: string): IDBDatabase | undefined {
  return DB_CONNECTION_POOL[dbName];
}

function addConnectionToPool(dbName: string, connection: IDBDatabase) {
  // If pool is full, close the oldest connection
  const poolKeys = Object.keys(DB_CONNECTION_POOL);
  if (poolKeys.length >= MAX_POOL_SIZE) {
    const oldestKey = poolKeys[0];
    DB_CONNECTION_POOL[oldestKey].close();
    delete DB_CONNECTION_POOL[oldestKey];
  }
  DB_CONNECTION_POOL[dbName] = connection;
}

function closeAllConnections() {
  Object.values(DB_CONNECTION_POOL).forEach((db) => {
    try {
      db.close();
    } catch (e) {
      console.error("Error closing DB connection:", e);
    }
  });
  Object.keys(DB_CONNECTION_POOL).forEach((key) => delete DB_CONNECTION_POOL[key]);
}

async function initDB() {
  if (!window.indexedDB) {
    return Promise.reject(new Error("IndexedDB not supported"));
  }

  const existingConnection = getConnectionFromPool(DB_NAME);
  if (existingConnection) {
    return existingConnection;
  }

  closeAllConnections();

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION_LATEST);

    request.onerror = () => {
      reject(request.error);
    };

    request.onblocked = () => {
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onerror = (event: Event) => {
        const target = event.target as IDBRequest;
        console.error("Database error:", target.error);
      };
      addConnectionToPool(DB_NAME, db);
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction;
      const oldVersion = event.oldVersion;

      if (!transaction) {
        console.error("No transaction available for migration");
        return;
      }

      console.log(`Running migrations from version ${oldVersion} to ${DB_VERSION_LATEST}`);

      // Run all needed migrations in order
      migrations
        .filter((migration) => migration.version > oldVersion)
        .sort((a, b) => a.version - b.version)
        .forEach((migration) => {
          console.log(`Applying migration to version ${migration.version}`);
          migration.migrate(db, transaction);
        });
    };
  });
}

async function getFromDB<T>(key: string): Promise<T | undefined> {
  try {
    const db = await initDB();

    if (!db.objectStoreNames.contains(STORE_NAME)) {
      return undefined;
    }

    return new Promise((resolve) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(STORE_NAME, "readonly");
      } catch {
        closeAllConnections();
        resolve(undefined);
        return;
      }

      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      transaction.onerror = () => resolve(undefined);
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => resolve(request.result);
    });
  } catch {
    return undefined;
  }
}

async function setInDB<T>(key: string, value: T): Promise<void> {
  try {
    const db = await initDB();

    if (!db.objectStoreNames.contains(STORE_NAME)) {
      localStorage.setItem(key, JSON.stringify(value));
      return;
    }

    return new Promise((resolve) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(STORE_NAME, "readwrite");
      } catch {
        closeAllConnections();
        localStorage.setItem(key, JSON.stringify(value));
        resolve();
        return;
      }

      const store = transaction.objectStore(STORE_NAME);
      store.put(value, key);

      transaction.onerror = () => {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
        resolve();
      };

      transaction.oncomplete = () => resolve();
    });
  } catch {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
}

function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  wait: number
): {
  (...args: Parameters<T>): void;
  cancel: () => void;
} {
  let timeout: number | undefined;

  const debouncedFn = function (this: unknown, ...args: Parameters<T>) {
    if (timeout) window.clearTimeout(timeout);
    timeout = window.setTimeout(() => func.apply(this, args), wait);
  };

  debouncedFn.cancel = () => {
    if (timeout) window.clearTimeout(timeout);
  };

  return debouncedFn;
}

function usePersistentState<T extends string | number | boolean | object | null>(
  storageKey: string,
  defaultValue: T
) {
  const [data, setData] = useState<T>(defaultValue);
  const [isLoading, setIsLoading] = useState(true);

  // Load initial data
  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      try {
        let value: T | undefined = await getFromDB<T>(storageKey);

        if (value === undefined) {
          try {
            const localStorageData = localStorage.getItem(storageKey);
            if (localStorageData) {
              value = JSON.parse(localStorageData) as T;
              await setInDB(storageKey, value);
              localStorage.removeItem(storageKey);
            } else {
              value = defaultValue;
              await setInDB(storageKey, value);
            }
          } catch (e) {
            console.error("Failed to process localStorage data:", e);
            value = defaultValue;
            await setInDB(storageKey, value);
          }
        }

        // Migration for notes without createdAt
        if (storageKey === "typehere-database" && Array.isArray(value)) {
          const migratedNotes = (value as Note[]).map((note) => {
            if (!note.createdAt) {
              return {
                ...note,
                createdAt: note.updatedAt || new Date().toISOString(),
              };
            }
            return note;
          });
          value = migratedNotes as T;
        }

        // Migration for deleted notes backup
        if (storageKey === "typehere-deletedNotes" && Array.isArray(value)) {
          const migratedNotes = (value as Note[]).map((note) => {
            if (!note.createdAt) {
              return {
                ...note,
                createdAt: note.updatedAt || new Date().toISOString(),
              };
            }
            return note;
          });
          value = migratedNotes as T;
        }

        if (isMounted) {
          setData(value);
        }
      } catch (e) {
        console.error("Failed to load data:", e);
        if (isMounted) {
          setData(defaultValue);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [storageKey]);

  // Debounced save function
  const debouncedSave = useMemo(
    () =>
      debounce(async (value: T) => {
        try {
          await setInDB(storageKey, value);
        } catch (e) {
          console.error("Failed to save data:", e);
        }
      }, 200),
    [storageKey]
  );

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      debouncedSave.cancel();
    };
  }, [debouncedSave]);

  // Modified setter function
  const setPersistedData = useCallback(
    (newData: T) => {
      setData(newData);
      debouncedSave(newData);
    },
    [debouncedSave]
  );

  // Return loading state if data hasn't been loaded yet
  if (isLoading) {
    return [defaultValue, setPersistedData] as const;
  }

  return [data ?? defaultValue, setPersistedData] as const;
}

const searchAllNotesKeys = ["@", ">"];

const getRandomId = () => Math.random().toString(36).substring(2);

type NoteConfig = {
  indentedWrap?: boolean;
};

type Note = {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  isPinned: boolean;
  isHidden: boolean;
  workspace?: string;
  config?: NoteConfig;
};

type CmdKSuggestion =
  | {
      type: "note";
      note: Note;
    }
  | {
      type: "action";
      title: string;
      content: string;
      color?: string;
      themeId?: string;
      onAction: () => boolean;
    };

const cmdKSuggestionActionType = "action" as const;

const freshDatabase = [
  {
    id: getRandomId(),
    content: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isPinned: false,
    isHidden: false,
  },
];


const themeId = "typehere-theme";
if (!restoreThemeFromCache()) {
  if (localStorage.getItem(themeId) === '"dark"') {
    document.documentElement.setAttribute("data-theme", "dark");
  }
}

const sortNotes = (notes: Note[]) => {
  if (!notes || notes.length === 0) return [];
  return notes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

initDB().catch(() => {});

const getCurrentTime = () => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear().toString().slice(-2);
  const dayAbbr = now.toLocaleDateString("en-US", { weekday: "short" }).toLowerCase();
  const hour = now.getHours();
  const minute = now.getMinutes().toString().padStart(2, "0");
  const period = hour >= 12 ? "p" : "a";
  const hour12 = hour % 12 || 12;
  const fixedDayAbbr = dayAbbr === "thu" ? "thur" : dayAbbr;
  return `${month}/${day}/${year} ${fixedDayAbbr} ${hour12}:${minute}${period}`;
};

const getCurrentDate = () => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear().toString().slice(-2);
  const dayAbbr = now.toLocaleDateString("en-US", { weekday: "short" }).toLowerCase();
  const fixedDayAbbr = dayAbbr === "thu" ? "thur" : dayAbbr;
  return `${month}/${day}/${year} ${fixedDayAbbr}`;
};

const snippets: Snippet[] = [
  {
    name: "time",
    description: "Insert current date and time",
    getValue: getCurrentTime,
  },
  {
    name: "now",
    description: "Insert current date and time",
    getValue: getCurrentTime,
  },
  {
    name: "date",
    description: "Insert current date",
    getValue: getCurrentDate,
  },
];

const formatDateCompact = (dateStr: string) => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const hour = date.getHours();
    const minute = date.getMinutes().toString().padStart(2, "0");
    const period = hour >= 12 ? "p" : "a";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minute}${period}`;
  } else if (diffDays === 1) {
    return "yesterday";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    const month = date.toLocaleString("default", { month: "short" }).toLowerCase();
    const day = date.getDate();
    return `${month}${day}`;
  }
};

function App() {
  const textareaDomRef = useRef<HTMLTextAreaElement>(null);
  const cmdKInputDomRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isElectron()) {
      document.body.classList.add("electron");
    }
  }, []);

  const [database, setDatabase] = usePersistentState<Note[]>("typehere-database", freshDatabase);
  const databaseRef = useRef(database);
  databaseRef.current = database;

  const [currentWorkspace, setCurrentWorkspace] = usePersistentState<string | null>(
    "typehere-currentWorkspace",
    null
  );
  const [currentNoteId, setCurrentNoteId] = usePersistentState<string>(
    "typehere-currentNoteId",
    freshDatabase[0].id
  );
  const [shouldShowScrollbar, setShouldShowScrollbar] = usePersistentState<boolean>(
    "typehere-shouldShowScrollbar",
    false
  );
  const [moreMenuPosition, setMoreMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const [isAltKeyDown, setIsAltKeyDown] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [lastAceCursorPosition, setLastAceCursorPosition] = useState({
    row: 0,
    column: 0,
  });

  const workspaceNotes = useMemo(() => {
    return currentWorkspace === null
      ? sortNotes(database ?? [])
      : sortNotes((database ?? []).filter((n) => n.workspace === currentWorkspace || n.isPinned));
  }, [database, currentWorkspace]);

  const currentNote = useMemo(() => {
    return database?.find((n) => n.id === currentNoteId);
  }, [database, currentNoteId]);

  const isIndentedWrap = currentNote?.config?.indentedWrap ?? true;

  const setIsIndentedWrap = useCallback(
    (value: boolean) => {
      if (!currentNote || !database) return;
      const updatedNote = {
        ...currentNote,
        config: {
          ...currentNote.config,
          indentedWrap: value,
        },
      };
      setDatabase(database.map((n) => (n.id === currentNote.id ? updatedNote : n)));
    },
    [currentNote, database, setDatabase]
  );

  const availableWorkspaces = useMemo(() => {
    const seenWorkspaces = new Set<string>();
    const allWorkspaces: string[] = [];
    const shallowDatabase = sortNotes([...(database ?? [])]);

    for (const note of shallowDatabase) {
      if (!note.workspace || seenWorkspaces.has(note.workspace)) {
        continue;
      }

      allWorkspaces.push(note.workspace);
      seenWorkspaces.add(note.workspace);
    }

    return allWorkspaces;
  }, [database]);

  const navigableWorkspaces = useMemo(() => {
    return [null, ...availableWorkspaces];
  }, [availableWorkspaces]);

  useEffect(() => {
    const currentNote = workspaceNotes.find((note) => note.id === currentNoteId);
    if (currentNote) {
      setTextValue(currentNote.content);
    } else if (workspaceNotes.length > 0) {
      setCurrentNoteId(workspaceNotes[0].id);
      setTextValue(workspaceNotes[0].content);
    }
  }, [workspaceNotes, currentNoteId]);

  useEffect(() => {
    const imgManager = imageWidgetManagerRef.current;
    const spotifyManager = spotifyWidgetManagerRef.current;
    if (imgManager) imgManager.clear();
    if (spotifyManager) spotifyManager.clear();
    const id = setTimeout(() => {
      imgManager?.sync();
      spotifyManager?.sync();
    }, 50);
    return () => clearTimeout(id);
  }, [currentNoteId]);

  const focus = () => {
    if (aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      if (editor.isFocused()) return;
      editor.moveCursorTo(lastAceCursorPosition.row, lastAceCursorPosition.column);
      editor.focus();
    } else {
      textareaDomRef.current?.focus();
    }
  };

  const deleteNote = async (noteId: string) => {
    const deletedNote = database?.find((note) => note.id === noteId);
    if (!deletedNote || !database) return;
    setFreshlyDeletedNotes((prev) => [...prev, deletedNote]);
    setDeletedNotesBackup([...deletedNotesBackup, deletedNote].slice(-10));
    const updatedDatabase = database.filter((note) => note.id !== noteId);
    setDatabase(updatedDatabase);
    if (currentNoteId === noteId) {
      setCurrentNoteId(updatedDatabase[0]?.id || "");
      setTextValue(updatedDatabase[0]?.content || "");
    }
  };

  const [historyStack, setHistoryStack] = useState<string[]>([currentNoteId ?? ""]);
  const [historyIndex, setHistoryIndex] = useState<number>(0);

  const openNote = (
    noteId: string,
    shouldFocus: boolean = true,
    shouldUpdateHistory: boolean = true
  ) => {
    if (!noteId || !database?.find((n) => n.id === noteId)) {
      return;
    }

    setLastAceCursorPosition({ row: 0, column: 0 });
    setCurrentNoteId(noteId);

    const n = database?.find((n) => n.id === noteId);
    if (n) {
      n.updatedAt = new Date().toISOString();
    }

    if (n && !n.isPinned && n.workspace !== currentWorkspace) {
      setCurrentWorkspace(n.workspace ?? null);
    }

    setDatabase(database ?? []);

    if (shouldFocus) {
      setTimeout(() => {
        focus();

        if (aceEditorRef.current) {
          const editor = aceEditorRef.current.editor;
          editor.getSession().getUndoManager().reset();
          editor.clearSelection();
          editor.moveCursorTo(0, 0);
        }
      }, 10);
    }

    if (shouldUpdateHistory) {
      if (historyStack[historyIndex] !== noteId) {
        // Discard forward history if any
        const newHistoryStack = historyStack.slice(0, historyIndex + 1);
        newHistoryStack.push(noteId);
        setHistoryStack(newHistoryStack);
        setHistoryIndex(newHistoryStack.length - 1);
      }
    }
  };

  const openNewNote = (
    defaultContent: string = "",
    defaultWorkspace: string = "",
    shouldFocus = true
  ) => {
    const newNote: Note = {
      id: getRandomId(),
      content: defaultContent,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspace: (defaultWorkspace || currentWorkspace) ?? undefined,
      isPinned: false,
      isHidden: false,
    };

    setDatabase([...database, newNote]);
    setCurrentNoteId(newNote.id);
    setTextValue("");
    openNote(newNote.id, shouldFocus);

    return newNote;
  };

  const fileInputDomRef = useRef<HTMLInputElement>(null);

  const [currentThemeId, setCurrentThemeId] = usePersistentState<string>(themeId, "light");
  const currentTheme = getThemeById(currentThemeId);
  const [selectedCmdKSuggestionIndex, setSelectedCmdKSuggestionIndex] = useState<number>(0);
  const [cmdKSearchQuery, setCmdKSearchQuery] = useState("");
  const [isCmdKMenuOpen, setIsCmdKMenuOpen] = useState(false);
  const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
  const [hasVimNavigated, setHasVimNavigated] = useState(false);
  const [isUsingVim, setIsUsingVim] = usePersistentState<boolean>("typehere-vim", false);
  const [isNarrowScreen, setIsNarrowScreen] = usePersistentState<boolean>("typehere-narrow", false);
  const [freshlyDeletedNotes, setFreshlyDeletedNotes] = useState<Note[]>([]);
  const [deletedNotesBackup, setDeletedNotesBackup] = usePersistentState<Note[]>(
    "typehere-deletedNotes",
    []
  );
  const [shouldShowHiddenNotes, setShouldShowHiddenNotes] = useState(false);

  const themeBeforePreviewRef = useRef<string | null>(null);
  const isSuppressingMousePreviewRef = useRef(false);

  const saveTheme = (id: string) => {
    setCurrentThemeId(id);
    applyThemeToDocument(getThemeById(id));
  };

  const previewThemeForSuggestion = (suggestion?: CmdKSuggestion) => {
    if (suggestion?.type === "action" && suggestion.themeId) {
      if (themeBeforePreviewRef.current === null) {
        themeBeforePreviewRef.current = currentThemeId;
      }
      applyThemeToDocument(getThemeById(suggestion.themeId), true);
    } else if (themeBeforePreviewRef.current !== null) {
      applyThemeToDocument(getThemeById(themeBeforePreviewRef.current), true);
    }
  };

  useEffect(() => {
    applyThemeToDocument(currentTheme);
  }, [currentThemeId]);

  useEffect(() => {
    if (isCmdKMenuOpen) {
      isSuppressingMousePreviewRef.current = true;
    } else {
      if (themeBeforePreviewRef.current !== null) {
        applyThemeToDocument(getThemeById(themeBeforePreviewRef.current), true);
        themeBeforePreviewRef.current = null;
      }
      setIsThemePickerOpen(false);
    }
  }, [isCmdKMenuOpen]);

  const moveNoteToWorkspace = (note: Note, workspace?: string) => {
    note.workspace = workspace;
    setDatabase(database ?? []);
    setCurrentWorkspace(workspace ?? null);
    setSelectedCmdKSuggestionIndex(0);
    openNote(note.id, false);
  };

  const runCmdKSuggestion = (suggestion?: CmdKSuggestion): boolean => {
    if (!suggestion) return true;
    if (suggestion.type === "note") {
      openNote(suggestion.note.id);
      return true;
    } else if (suggestion.type === "action") {
      return suggestion.onAction();
    }
    return false;
  };

  const getNextWorkspace = (direction: "left" | "right") => {
    const currentIndex = navigableWorkspaces.indexOf(currentWorkspace ?? null);
    if (currentIndex === -1) {
      console.warn("wtf?"); // not supposed to happen
    } else {
      if (direction === "left") {
        return navigableWorkspaces[
          (currentIndex - 1 + navigableWorkspaces.length) % navigableWorkspaces.length
        ];
      } else {
        return navigableWorkspaces[(currentIndex + 1) % navigableWorkspaces.length];
      }
    }
  };

  const openWorkspace = (workspace: string | null) => {
    setSelectedCmdKSuggestionIndex(0);
    setCurrentWorkspace(workspace ?? null);
    setCurrentNoteId(""); // hack to force a re-render
  };

  const getNoteTitle = (note: Note) => {
    const firstLineBreakIndex = note.content.trim().indexOf("\n");
    const title = note.content.substring(
      0,
      firstLineBreakIndex === -1 ? undefined : firstLineBreakIndex + 1
    );
    return title;
  };

  const saveNote = (noteId: string, newText: string) => {
    let processedText = newText;
    if (aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      textsToReplace.forEach(([from, to]) => {
        if (from instanceof RegExp) {
          editor.replaceAll(to, {
            needle: from,
            regExp: true,
          });
        } else {
          editor.replaceAll(to, {
            needle: from,
            regExp: false,
          });
        }
      });
      processedText = editor.getValue();
    } else {
      textsToReplace.forEach(([from, to]) => {
        if (from instanceof RegExp) {
          processedText = processedText.replace(from, to);
        } else {
          processedText = processedText.split(from).join(to);
        }
      });
    }

    if (!database) return;

    const noteIndex = database.findIndex((n) => n.id === noteId);
    if (noteIndex !== -1) {
      const updatedNote = {
        ...database[noteIndex],
        content: processedText,
        updatedAt: new Date().toISOString(),
      };
      const newDatabase = [...database];
      newDatabase.splice(noteIndex, 1, updatedNote);
      setDatabase(newDatabase);
    }
  };

  const pinNote = (note: Note, isPinned: boolean = true) => {
    note.isPinned = isPinned;
    setDatabase(sortNotes([...database.filter((n) => n.id !== note.id), note]));
  };

  const setIsNoteHidden = (note: Note, isHidden: boolean) => {
    note.isHidden = isHidden;
    setDatabase(sortNotes([...database.filter((n) => n.id !== note.id), note]));
  };
  const getAllSuggestions = useCallback(
    (shouldSearchAllNotes = false): CmdKSuggestion[] => {
      const processedCmdKSearchQuery =
        shouldSearchAllNotes && searchAllNotesKeys.some((key) => cmdKSearchQuery.startsWith(key))
          ? cmdKSearchQuery.substring(1)
          : cmdKSearchQuery;
      const relevantNotes = shouldSearchAllNotes ? database : workspaceNotes;
      const notesToSearch = relevantNotes
        .filter((note) => shouldShowHiddenNotes || !note.isHidden || note.id === currentNoteId)
        .map((note) => {
          const firstLineBreakIndex = note.content.trim().indexOf("\n");
          return {
            ...note,
            firstLineWithWorkspace:
              firstLineBreakIndex !== -1
                ? note.content.slice(0, firstLineBreakIndex) +
                  (note.workspace ? ` (${note.workspace})` : "")
                : note.content + (note.workspace ? ` ${note.workspace}` : ""),
          };
        });
      const hiddenNotesMatchLength = 5;
      // we're matching the entire database for easier access.
      const matchingHiddenNotes = database
        .filter((note) => {
          if (shouldShowHiddenNotes) {
            return false;
          }
          const noteTitleLower = getNoteTitle(note).toLowerCase();
          const queryLower = processedCmdKSearchQuery.toLowerCase();
          return (
            note.isHidden &&
            note.id !== currentNoteId &&
            processedCmdKSearchQuery.length &&
            (processedCmdKSearchQuery.length >= hiddenNotesMatchLength
              ? noteTitleLower.startsWith(queryLower)
              : // if less than the limit, must be exact match
                noteTitleLower === queryLower)
          );
        })
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      const notesFuse = new Fuse(notesToSearch, {
        keys: [
          { name: "content", weight: 1 },
          { name: "firstLineWithWorkspace", weight: 0.6 },
        ],
        includeScore: true,
        threshold: 0.2,
        useExtendedSearch: true,
      });
      const workspaceFuse = new Fuse(
        [
          ...availableWorkspaces.map((workspace) => ({
            label: workspace,
            value: workspace,
          })),
          {
            label: "all notes",
            value: null,
          },
        ],
        {
          keys: ["label"],
          includeScore: true,
          threshold: 0.05, // lower for workspace match
        }
      );
      const notes = processedCmdKSearchQuery
        ? notesFuse.search(processedCmdKSearchQuery.trim()).map((result) => result.item)
        : notesToSearch;

      if (notes.length <= 1 && !shouldSearchAllNotes) {
        return getAllSuggestions(true);
      }

      const workspaces = processedCmdKSearchQuery
        ? workspaceFuse.search(processedCmdKSearchQuery).map((result) => result.item)
        : [];
      const currentNote = database.find((note) => note.id === currentNoteId);

      const unlinkTitle = "unlink note";
      const shouldTrimQuery = processedCmdKSearchQuery.length > 20;
      const trimmedQuery = processedCmdKSearchQuery.slice(0, 20);
      const trimmedContent = shouldTrimQuery ? trimmedQuery + "..." : processedCmdKSearchQuery;

      const regularCommands: CmdKSuggestion[] = [
        {
          type: cmdKSuggestionActionType,
          title: "choose theme",
          content: `current: ${currentTheme.name.toLowerCase()}`,
          color: currentTheme.accentColor,
          onAction: () => {
            setIsThemePickerOpen(true);
            setCmdKSearchQuery("");
            const idx = THEMES.findIndex((t) => t.id === currentThemeId);
            setSelectedCmdKSuggestionIndex(idx === -1 ? 0 : idx);
            setTimeout(() => {
              document.getElementById(`note-list-cmdk-item-${idx}`)?.scrollIntoView({ block: "center" });
            });
            return false;
          },
        },
        {
          type: "action",
          title: "pin/unpin current note",
          content: currentNote?.isPinned ? "unpin from all workspaces" : "pin to all workspaces",
          color: "#FF9800", // Orange
          onAction: () => {
            if (!currentNote) return true;
            pinNote(currentNote, !currentNote.isPinned);
            setCmdKSearchQuery("");
            return false;
          },
        },
        {
          type: "action",
          title: "toggle vim mode",
          content: "turn " + (isUsingVim ? "off" : "on") + " vim mode",
          color: "#81D4FA", // A calming light blue
          onAction: () => {
            setIsUsingVim(!isUsingVim);
            return true;
          },
        },
        {
          type: "action",
          title: "toggle narrow screen mode",
          content: "enter " + (isNarrowScreen ? "wide" : "narrow") + " screen mode",
          color: "#AED581", // A gentle light green
          onAction: () => {
            setIsNarrowScreen(!isNarrowScreen);
            return true;
          },
        },
        {
          type: "action",
          title: "toggle indented wrap (this note)",
          content: "turn " + (isIndentedWrap ? "off" : "on") + " indented soft wrap for this note",
          color: "#FFB74D",
          onAction: () => {
            setIsIndentedWrap(!isIndentedWrap);
            return true;
          },
        },
        {
          type: "action",
          title: "backup all notes",
          content: "to cloud",
          color: "#FFEB3B",
          onAction: () => {
            createCloudBackup();
            return true;
          },
        },
        ...(window.electronBackup
          ? [
              {
                type: cmdKSuggestionActionType,
                title: "open cloud backups",
                content: "list and restore backups",
                color: "#FFF59D",
                onAction: () => {
                  void openBackupList();
                  return true;
                },
              },
            ]
          : []),
        {
          type: "action",
          title: "import notes",
          content: "import notes from chosen JSON file",
          color: "#FA7070", // A soothing pink
          onAction: () => {
            fileInputDomRef.current?.click();
            return true;
          },
        },
        {
          type: "action",
          title: "export notes",
          content: "export notes to chosen JSON file",
          color: "#FFF7F7", // A soothing white
          onAction: () => {
            exportDatabase();
            setCmdKSearchQuery("");
            return false;
          },
        },
        {
          type: "action",
          title: shouldShowScrollbar ? "hide scrollbar" : "show scrollbar",
          content: "toggle the scrollbar visibility",
          color: "#B2B2FF", // A soothing light blue
          onAction: () => {
            setShouldShowScrollbar(!shouldShowScrollbar);
            setCmdKSearchQuery("");
            return true;
          },
        },
      ];

      const regularCommandsFuse = new Fuse(regularCommands, {
        shouldSort: true,
        keys: ["title", "content"],
        includeScore: true,
        threshold: 0.4,
      });

      const regularCommandsResults = regularCommandsFuse.search(processedCmdKSearchQuery);

      const prioritizedActions: CmdKSuggestion[] = [
        ...(processedCmdKSearchQuery
          ? [
              ...(workspaces.length > 0
                ? [
                    ...workspaces.slice(0, 3).map((workspace) => ({
                      type: cmdKSuggestionActionType,
                      title: `go to ${workspace.label}`,
                      content: `↓[${workspace.label}]`,
                      color: "#2196F3",
                      onAction() {
                        openWorkspace(workspace.value);
                        setCmdKSearchQuery("");
                        return false;
                      },
                    })),
                  ]
                : []),
            ]
          : []),
      ];

      const actions: CmdKSuggestion[] = [
        ...(processedCmdKSearchQuery
          ? [
              ...(regularCommandsResults.length > 0
                ? regularCommandsResults.map((result) => result.item)
                : []),

              {
                type: cmdKSuggestionActionType,
                title: "create new note",
                content: `"${trimmedContent}"`,
                color: "#4CAF50",
                onAction: () => {
                  openNewNote(processedCmdKSearchQuery);
                  setIsCmdKMenuOpen(false);
                  setSelectedCmdKSuggestionIndex(0);
                  setCmdKSearchQuery("");
                  return true;
                },
              },
              ...(workspaces.length > 0
                ? [
                    {
                      type: cmdKSuggestionActionType,
                      title: `move note to ${workspaces[0].label}`,
                      content: `→[${workspaces[0].label}]`,
                      color: "#00BCD4",
                      onAction() {
                        if (!currentNote) {
                          console.warn("weird weird weird");
                          return true;
                        }
                        moveNoteToWorkspace(currentNote, workspaces[0]?.value ?? undefined);
                        setCmdKSearchQuery("");
                        return false;
                      },
                    },
                  ]
                : []),

              ...(availableWorkspaces.find((workspace) => workspace === processedCmdKSearchQuery)
                ? currentWorkspace
                  ? []
                  : []
                : [
                    {
                      type: cmdKSuggestionActionType,
                      title: "create workspace",
                      color: "#FF9800",
                      content: `+[${trimmedContent}]`,
                      onAction: () => {
                        openNewNote("", processedCmdKSearchQuery, false);
                        setSelectedCmdKSuggestionIndex(0);
                        setCurrentWorkspace(processedCmdKSearchQuery);
                        setCmdKSearchQuery("");
                        return false;
                      },
                    },
                  ]),
              ...(currentWorkspace
                ? [
                    {
                      type: cmdKSuggestionActionType,
                      title: "rename workspace",
                      content: `±[${trimmedContent}]`,
                      color: "#9C27B0",
                      onAction: () => {
                        const newDatabase = [...database].map((n) => {
                          if (n.workspace !== currentWorkspace) {
                            return n;
                          }
                          return {
                            ...n,
                            workspace: processedCmdKSearchQuery,
                          };
                        });
                        setCurrentWorkspace(processedCmdKSearchQuery);
                        setSelectedCmdKSuggestionIndex(0);
                        setDatabase(newDatabase);
                        setCmdKSearchQuery("");
                        return false;
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(currentNote?.workspace &&
        processedCmdKSearchQuery &&
        unlinkTitle.includes(processedCmdKSearchQuery)
          ? [
              {
                type: cmdKSuggestionActionType,
                title: unlinkTitle,
                content: `-[${currentNote.workspace}]`,
                color: "#F44336",
                onAction() {
                  currentNote.workspace = undefined;
                  setDatabase(sortNotes(database));
                  setCurrentWorkspace(null);
                  return false;
                },
              },
            ]
          : []),
      ];

      sortNotes(notes);

      if (shouldSearchAllNotes) {
        notes.sort((a, b) => {
          const aInCurrentWorkspace = a.workspace === currentWorkspace ? 1 : 0;
          const bInCurrentWorkspace = b.workspace === currentWorkspace ? 1 : 0;
          return bInCurrentWorkspace - aInCurrentWorkspace;
        });
      }

      return [
        ...matchingHiddenNotes.map((note) => ({
          type: "note" as const,
          note,
        })),
        ...prioritizedActions,
        ...notes.map((note) => ({
          type: "note" as const,
          note,
        })),
        ...actions,
      ];
    },
    [database, cmdKSearchQuery, workspaceNotes, currentNoteId]
  );

  const themeSuggestions = useMemo<CmdKSuggestion[]>(() => {
    const all: CmdKSuggestion[] = THEMES.map((t) => ({
      type: cmdKSuggestionActionType,
      title: `${t.name}${currentThemeId === t.id ? " (current)" : ""}`,
      content: `${t.name} ${t.isDark ? "dark" : "light"} theme`,
      color: t.accentColor,
      themeId: t.id,
      onAction: () => {
        themeBeforePreviewRef.current = null;
        saveTheme(t.id);
        return true;
      },
    }));
    if (!cmdKSearchQuery) return all;
    const fuse = new Fuse(all, {
      keys: ["title", "content"],
      threshold: 0.4,
    });
    return fuse.search(cmdKSearchQuery).map((r) => r.item);
  }, [cmdKSearchQuery, currentThemeId]);

  const cmdKSuggestions = useMemo<CmdKSuggestion[]>(() => {
    if (isThemePickerOpen) return themeSuggestions;
    const shouldSearchAllNotes = searchAllNotesKeys.some((key) => cmdKSearchQuery.startsWith(key));
    return getAllSuggestions(shouldSearchAllNotes);
  }, [cmdKSearchQuery, getAllSuggestions, isThemePickerOpen, themeSuggestions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
      }

      // NO PRINT
      if (e.code === "KeyP" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
      }

      if (isCmdKMenuOpen && e.code === "Escape") {
        e.preventDefault();
        if (themeBeforePreviewRef.current !== null) {
          applyThemeToDocument(getThemeById(themeBeforePreviewRef.current), true);
          themeBeforePreviewRef.current = null;
        }
        if (isThemePickerOpen) {
          setIsThemePickerOpen(false);
          setCmdKSearchQuery("");
          setSelectedCmdKSuggestionIndex(0);
          return;
        }
        setIsCmdKMenuOpen(false);
        focus();
        return;
      }

      if (e.code === "KeyE" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsNarrowScreen(!isNarrowScreen);
        return;
      }

      const currentSuggestion = cmdKSuggestions[selectedCmdKSuggestionIndex];
      const currentSelectedNote = currentSuggestion.type === "note" ? currentSuggestion.note : null;

      const vimUp = (e.ctrlKey || e.metaKey) && e.code === "KeyK";
      const vimDown = (e.ctrlKey || e.metaKey) && e.code === "KeyJ";
      const vimLeft = (e.ctrlKey || e.metaKey) && e.code === "KeyU";
      const vimRight = (e.ctrlKey || e.metaKey) && e.code === "KeyI";

      if (isCmdKMenuOpen && (vimUp || vimDown || vimLeft || vimRight)) {
        setHasVimNavigated(true);
      }

      if (isCmdKMenuOpen) {
        const topXDigits = new Array(digitCount).fill(0).map((_, i) => `Digit${i + 1}`);
        const topXDigitsSet = new Set(topXDigits);

        if (e.altKey) {
          setIsAltKeyDown(true);
        }

        if (e.altKey && topXDigitsSet.has(e.code)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const index = topXDigits.findIndex((key) => key === e.code);
          const suggestion = cmdKSuggestions[index];
          const shouldCloseCmdK = runCmdKSuggestion(suggestion);
          if (shouldCloseCmdK) {
            setIsCmdKMenuOpen(false);
            setSelectedCmdKSuggestionIndex(0);
          }
          return;
        }

        if (freshlyDeletedNotes.length > 0 && e.code === "KeyZ" && (e.ctrlKey || e.metaKey)) {
          const topOfStack = freshlyDeletedNotes.pop();
          if (topOfStack) {
            e.stopImmediatePropagation();
            e.preventDefault();
            setDatabase(sortNotes([...database, topOfStack]));
          }
          return;
        }

        let nextIndex: number | null = null;
        const length = cmdKSuggestions.length;
        if (e.code === "ArrowUp" || vimUp) {
          e.preventDefault();
          if (selectedCmdKSuggestionIndex === null) {
            nextIndex = length - 1;
          } else {
            nextIndex = (selectedCmdKSuggestionIndex - 1 + length) % length;
          }
          setSelectedCmdKSuggestionIndex(nextIndex);
        } else if (e.code === "ArrowDown" || vimDown) {
          e.preventDefault();
          if (selectedCmdKSuggestionIndex === null) {
            nextIndex = 0;
          } else {
            nextIndex = (selectedCmdKSuggestionIndex + 1) % length;
          }
          setSelectedCmdKSuggestionIndex(nextIndex);
        }

        if (nextIndex !== null) {
          const elementId = `note-list-cmdk-item-${nextIndex}`;
          const element = document.getElementById(elementId);
          if (element) {
            element.scrollIntoView({ block: "center" });
          }
          previewThemeForSuggestion(cmdKSuggestions[nextIndex]);
          return;
        }

        if (e.code === "Enter" || (e.code === "KeyB" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          const suggestion = cmdKSuggestions[selectedCmdKSuggestionIndex];
          const shouldCloseCmdK = runCmdKSuggestion(suggestion);
          if (shouldCloseCmdK) {
            setIsCmdKMenuOpen(false);
            setSelectedCmdKSuggestionIndex(0);
          }
          return;
        }

        const direction =
          vimLeft || (e.code === "ArrowLeft" && !e.metaKey && !e.ctrlKey)
            ? "left"
            : vimRight || (e.code === "ArrowRight" && !e.metaKey && !e.ctrlKey)
              ? "right"
              : null;
        const isArrowKeys =
          !e.metaKey && !e.ctrlKey && (e.code === "ArrowLeft" || e.code === "ArrowRight");
        if (direction && (isArrowKeys ? cmdKSearchQuery.length === 0 : true)) {
          e.preventDefault();
          const nextWorkspace = getNextWorkspace(direction);
          if (nextWorkspace !== currentWorkspace) {
            openWorkspace(nextWorkspace ?? null);
          }
        }

        if (currentSelectedNote) {
          if ((e.code === "KeyH" || e.code === "KeyG") && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            pinNote(currentSelectedNote, !currentSelectedNote.isPinned);
            openNote(currentSelectedNote.id, false);
            setSelectedCmdKSuggestionIndex(0);
            return;
          }

          if ((e.ctrlKey || e.metaKey) && e.code === "Quote" && !currentSelectedNote.isPinned) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const shouldAllowShowAll = false;
            if (e.shiftKey && shouldAllowShowAll) {
              setShouldShowHiddenNotes(!shouldShowHiddenNotes);
              return;
            }

            setIsNoteHidden(currentSelectedNote, !currentSelectedNote.isHidden);
            return;
          }

          if (e.code === "ArrowLeft" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const nextWorkspace = getNextWorkspace("left");
            if (nextWorkspace !== currentWorkspace) {
              moveNoteToWorkspace(currentSelectedNote, nextWorkspace ?? undefined);
              setSelectedCmdKSuggestionIndex(0);
            }
            return;
          }

          if (e.code === "ArrowRight" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const nextWorkspace = getNextWorkspace("right");
            if (nextWorkspace !== currentWorkspace) {
              moveNoteToWorkspace(currentSelectedNote, nextWorkspace ?? undefined);
              setSelectedCmdKSuggestionIndex(0);
            }
            return;
          }
        }

        // otherwise, just focus on the cmdk search and let the user type
        cmdKInputDomRef.current?.focus();

        return;
      }

      if (isHelpMenuOpen && (e.code === "Escape" || e.code === "Enter")) {
        e.preventDefault();
        setIsHelpMenuOpen((prev) => !prev);
        focus();
        return;
      }

      if ((e.code === "KeyP" || e.code === "KeyK") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        textareaDomRef.current?.blur();
        setSelectedCmdKSuggestionIndex(0);
        setIsCmdKMenuOpen(true);
        setIsHelpMenuOpen(false);

        if (e.shiftKey) {
          setCmdKSearchQuery("@");
        } else {
          setCmdKSearchQuery("");
        }
        return;
      }

      if (e.code === "KeyF" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        textareaDomRef.current?.blur();
        setSelectedCmdKSuggestionIndex(0);
        setIsCmdKMenuOpen(true);
        setIsHelpMenuOpen(false);
        setCmdKSearchQuery("@");
        return;
      }

      if (
        e.code === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        textValue.trim().length !== 0 &&
        !e.isComposing
      ) {
        e.preventDefault();
        openNewNote();
        return;
      }

      if (e.code === "Enter") {
        focus();
      } else if (isUsingVim && !isCmdKMenuOpen) {
        if (document.activeElement === document.body) {
          aceEditorRef.current?.editor.focus();
        }
      }

      if (e.metaKey && e.code === "BracketLeft") {
        e.preventDefault();
        if (historyIndex > 0) {
          const prevIndex = historyIndex - 1;
          setHistoryIndex(prevIndex);
          openNote(historyStack[prevIndex], true, false);
        }
      } else if (e.metaKey && e.code === "BracketRight") {
        e.preventDefault();
        if (historyIndex < historyStack.length - 1) {
          const nextIndex = historyIndex + 1;
          setHistoryIndex(nextIndex);
          openNote(historyStack[nextIndex], true, false);
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "AltLeft") {
        setIsAltKeyDown(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    database,
    database.length,
    hasVimNavigated,
    isCmdKMenuOpen,
    openNewNote,
    openNote,
    selectedCmdKSuggestionIndex,
    textValue,
    isNarrowScreen,
    isHelpMenuOpen,
    isUsingVim,
    focus,
    cmdKSuggestions,
    setIsNarrowScreen,
    currentWorkspace,
    navigableWorkspaces,
    runCmdKSuggestion,
    setCurrentWorkspace,
    workspaceNotes.length,
    freshlyDeletedNotes,
    deleteNote,
    setDatabase,
    getNextWorkspace,
    setCurrentNoteId,
    moveNoteToWorkspace,
    openWorkspace,
    pinNote,
    setIsNoteHidden,
    shouldShowHiddenNotes,
    historyIndex,
    historyStack,
  ]);

  const [spotlightSrc, setSpotlightSrc] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const imageWidgetManagerRef = useRef<ImageWidgetManager | null>(null);
  const spotifyWidgetManagerRef = useRef<SpotifyWidgetManager | null>(null);
  const currentNoteIdRef = useRef(currentNoteId);
  currentNoteIdRef.current = currentNoteId;

  useEffect(() => {
    if (textareaDomRef.current) {
      textareaDomRef.current.focus();
    }
  }, [currentNoteId]);

  const aceEditorRef = useRef<AceEditor>(null);

  useEffect(() => {
    if (aceEditorRef.current) {
      const editor = aceEditorRef.current.editor;
      editor.renderer.setScrollMargin(32, 48, 0, 0);
      editor.commands.removeCommand("findprevious");
      editor.commands.removeCommand("findnext");
      editor.commands.removeCommand("removetolineend");

      const mode = editor.session.getMode() as { $highlightRules?: { $rules?: Record<string, Array<{ token: string; regex: string }>> } };
      if (mode.$highlightRules?.$rules?.["start"]) {
        const customRules: Array<{ token: string; regex: string }> = [
          { token: "image_ref", regex: "\\[img:[a-f0-9]+(?::\\d*\\.?\\d+)?\\]" },
          { token: "important_marker", regex: "!!!" },
          { token: "spotify_url", regex: SPOTIFY_URL_REGEX.source },
        ];
        for (const rule of customRules) {
          mode.$highlightRules.$rules["start"].unshift(rule);
        }
        (mode as Record<string, unknown>).$tokenizer = null;
        editor.session.bgTokenizer.setTokenizer(editor.session.getMode().getTokenizer());
        editor.session.bgTokenizer.start(0);
      }

      editor.setOption("enableBasicAutocompletion", false);
      editor.setOption("enableLiveAutocompletion", false);
      editor.setOption("enableSnippets", false);
      editor.getSession().setUseWorker(false); // Disable worker thread
      editor.renderer.setShowGutter(false);
      editor.renderer.setShowPrintMargin(false);
      editor.resize();

      const snippetCompleter = {
        identifierRegexps: [/[/\w]/],
        getCompletions: (
          _editor: unknown,
          session: { getLine: (row: number) => string },
          pos: { row: number; column: number },
          _prefix: string,
          callback: (
            error: null,
            completions: { caption: string; snippet: string; meta: string; score: number }[]
          ) => void
        ) => {
          const line = session.getLine(pos.row);
          const beforeCursor = line.substring(0, pos.column);
          const hasSlash = beforeCursor.startsWith("/");
          const searchTerm = (hasSlash ? beforeCursor.substring(1) : beforeCursor).toLowerCase();

          const completions = snippets
            .filter((snippet) => snippet.name.toLowerCase().startsWith(searchTerm))
            .map((snippet) => ({
              caption: snippet.name,
              snippet: snippet.getValue(),
              meta: snippet.description,
              score: 1000,
            }));

          callback(null, completions);
        },
      };

      editor.completers = [snippetCompleter];
      editor.setOptions({
        enableBasicAutocompletion: true,
        enableSnippets: true,
        enableLiveAutocompletion: true,
      });

      const widgetManager = new ImageWidgetManager(editor, (src) => setSpotlightSrc(src));
      imageWidgetManagerRef.current = widgetManager;
      widgetManager.sync();

      const spotifyManager = new SpotifyWidgetManager(editor);
      spotifyWidgetManagerRef.current = spotifyManager;
      spotifyManager.sync();

      const container = editor.container;
      let dragDepth = 0;

      const handleDragEnter = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        dragDepth++;
        if (dragDepth === 1) setIsDragOver(true);
      };
      const handleDragOver = (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        }
      };
      const handleDragLeave = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        dragDepth--;
        if (dragDepth <= 0) {
          dragDepth = 0;
          setIsDragOver(false);
        }
      };
      const handleDrop = async (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = 0;
        setIsDragOver(false);
        const files = e.dataTransfer?.files;
        if (!files) return;

        let isFirstInsertedImage = true;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file.type.startsWith("image/")) continue;

          const assetId = generateAssetId();
          await saveAsset(assetId, currentNoteIdRef.current ?? "", file, file.type, file.name);
          uploadAssetToCloud(assetId).catch(() => {});

          const cursor = editor.getCursorPosition();
          const ref = formatImageRef(assetId);
          editor.session.insert(cursor, isFirstInsertedImage ? ref : ` ${ref}`);
          isFirstInsertedImage = false;
        }
      };

      const handlePaste = async (e: ClipboardEvent) => {
        const clipboardData = e.clipboardData;
        if (!clipboardData) return;

        const imageFiles: File[] = [];
        const fileList = clipboardData.files;
        if (fileList && fileList.length > 0) {
          for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            if (file.type.startsWith("image/")) imageFiles.push(file);
          }
        }
        if (imageFiles.length === 0) {
          const items = clipboardData.items;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.type.startsWith("image/")) continue;
            const file = item.getAsFile();
            if (file) imageFiles.push(file);
          }
        }
        if (imageFiles.length === 0) return;

        e.preventDefault();

        for (let i = 0; i < imageFiles.length; i++) {
          const file = imageFiles[i];
          const assetId = generateAssetId();
          await saveAsset(assetId, currentNoteIdRef.current ?? "", file, file.type, file.name || "pasted-image");
          uploadAssetToCloud(assetId).catch(() => {});

          const cursor = editor.getCursorPosition();
          const ref = formatImageRef(assetId);
          editor.session.insert(cursor, i === 0 ? ref : ` ${ref}`);
        }
      };

      container.addEventListener("dragenter", handleDragEnter);
      container.addEventListener("dragover", handleDragOver);
      container.addEventListener("dragleave", handleDragLeave);
      container.addEventListener("drop", handleDrop);
      container.addEventListener("paste", handlePaste);

      return () => {
        container.removeEventListener("dragenter", handleDragEnter);
        container.removeEventListener("dragover", handleDragOver);
        container.removeEventListener("dragleave", handleDragLeave);
        container.removeEventListener("drop", handleDrop);
        container.removeEventListener("paste", handlePaste);
        widgetManager.destroy();
        imageWidgetManagerRef.current = null;
        spotifyManager.destroy();
        spotifyWidgetManagerRef.current = null;
      };
    }
  }, []);

  useEffect(() => {
    if (!aceEditorRef.current) return;

    const editor = aceEditorRef.current.editor;
    if (isUsingVim) {
      editor.setKeyboardHandler("ace/keyboard/vim");
    } else {
      editor.setKeyboardHandler("ace/keyboard/keybinding");
    }
  }, [isUsingVim]);

  useEffect(() => {
    if (!aceEditorRef.current) return;

    const editor = aceEditorRef.current.editor;
    editor.getSession().setOption("indentedSoftWrap", isIndentedWrap);
  }, [isIndentedWrap]);

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const cmdKey = isMac ? "⌘" : "ctrl";

  const [isBackupListOpen, setIsBackupListOpen] = useState(false);
  const [backupList, setBackupList] = useState<BackupEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<"idle" | "backing-up" | "done" | "error">("idle");
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);

  const isBackingUp = backupStatus === "backing-up";

  const buildBackupPayload = async (notes: Note[]): Promise<string> => {
    const allContent = notes.map((n) => n.content).join("\n");
    const regex = new RegExp(IMAGE_REF_REGEX.source, "g");
    const referencedIds = new Set<string>();
    let match;
    while ((match = regex.exec(allContent)) !== null) {
      referencedIds.add(match[1]);
    }

    for (const id of referencedIds) {
      try { await uploadAssetToCloud(id); } catch { /* best effort */ }
    }

    const assetManifest: AssetManifestEntry[] = [];
    for (const id of referencedIds) {
      const asset = await getAsset(id);
      if (asset) {
        assetManifest.push({ id: asset.id, noteId: asset.noteId, mimeType: asset.mimeType, name: asset.name });
      }
    }

    return JSON.stringify({ version: 3, notes, assetManifest });
  };

  const createCloudBackup = async () => {
    if (!window.electronBackup || isBackingUp) return;
    setBackupStatus("backing-up");
    try {
      await window.electronBackup.create(await buildBackupPayload(database));
      setBackupStatus("done");
      localStorage.setItem("typehere-last-auto-backup", Date.now().toString());
      setTimeout(() => setBackupStatus("idle"), 3000);
    } catch {
      setBackupStatus("error");
      setTimeout(() => setBackupStatus("idle"), 4000);
    }
  };

  const AUTO_BACKUP_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

  useEffect(() => {
    if (!window.electronBackup || !database || database.length === 0) return;

    const hasContent = database.some((note) => note.content.trim().length > 0);
    if (!hasContent) return;

    const lastBackup = parseInt(localStorage.getItem("typehere-last-auto-backup") ?? "0", 10);
    const timeSinceLastBackup = Date.now() - lastBackup;

    if (timeSinceLastBackup >= AUTO_BACKUP_INTERVAL_MS) {
      buildBackupPayload(database).then((payload) =>
        window.electronBackup!.create(payload)
      ).then(() => {
        localStorage.setItem("typehere-last-auto-backup", Date.now().toString());
      }).catch(() => {});
    }
  }, [database]);

  useEffect(() => {
    if (!window.electronBackup) return;

    const handler = async () => {
      const db = databaseRef.current;
      const hasContent = db && db.some((n) => n.content.trim().length > 0);
      if (hasContent) {
        try {
          const payload = await buildBackupPayload(db);
          await window.electronBackup!.create(payload);
          localStorage.setItem("typehere-last-auto-backup", Date.now().toString());
        } catch { /* quit proceeds regardless */ }
      }
      window.electronBackup!.sendQuitReady();
    };

    window.electronBackup.onBeforeQuit(handler);
    return () => { window.electronBackup!.offBeforeQuit(handler); };
  }, []);

  const openBackupList = async () => {
    if (!window.electronBackup) return;
    setIsBackupListOpen(true);
    setIsLoadingBackups(true);
    try {
      const entries = await window.electronBackup.list();
      setBackupList(entries);
    } finally {
      setIsLoadingBackups(false);
    }
  };

  const restoreBackup = async (key: string) => {
    if (!window.electronBackup) return;
    const raw = await window.electronBackup.restore(key);
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      setDatabase(parsed);
    } else if (parsed.version === 2) {
      setDatabase(parsed.notes);
      if (parsed.assets?.length > 0) {
        await restoreSerializedAssets(parsed.assets as SerializedAsset[]);
      }
    } else if (parsed.version === 3) {
      setDatabase(parsed.notes);
      if (parsed.assetManifest?.length > 0) {
        for (const entry of parsed.assetManifest as AssetManifestEntry[]) {
          try { await downloadAssetFromCloud(entry); } catch { /* best effort */ }
        }
      }
    }

    setCurrentWorkspace(null);
    setIsBackupListOpen(false);
  };

  const exportDatabase = async () => {
    const compressedData = LZString.compressToEncodedURIComponent(JSON.stringify(database));
    const dataStr = "data:text/json;charset=utf-8," + compressedData;

    // Generate filename with current date in format: notes_export_MMDDYY
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const year = String(now.getFullYear()).slice(-2);
    const filename = `notes_export_${month}${day}${year}.json`;

    const downloadAnchorNode = document.createElement("a");
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", filename);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  useEffect(() => {
    const aceScroller = document.querySelector(".ace_scrollbar") as HTMLElement;
    if (aceScroller) {
      aceScroller.style.visibility = shouldShowScrollbar ? "visible" : "hidden";
      document.body.classList.toggle("show-scrollbar", shouldShowScrollbar);
    }
  }, [shouldShowScrollbar]);


  const [currentTime, setCurrentTime] = useState(getCurrentTime());

  const noteTitle = useMemo(() => {
    const firstLine = textValue.trim().split("\n")[0]?.trim() ?? "";
    if (!firstLine) return "untitled";
    return firstLine.length > 30 ? firstLine.slice(0, 30) + "..." : firstLine;
  }, [textValue]);

  const wordCount = useMemo(() => {
    const trimmed = textValue.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }, [textValue]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(getCurrentTime());
    }, 60000); // Update every minute

    return () => clearInterval(timer);
  }, []);

  // Add cleanup for Ace editor and database connections
  useEffect(() => {
    return () => {
      // Cleanup Ace editor
      if (aceEditorRef.current) {
        const editor = aceEditorRef.current.editor;
        editor.destroy();
        editor.container.remove();
      }

      // Close all IndexedDB connections
      closeAllConnections();

    };
  }, []);

  useEffect(() => {
    document.fonts.ready.then(() => {
      if (aceEditorRef.current) {
        aceEditorRef.current.editor.renderer.updateFull();
      }
    });
  }, []);

  return (
    <>
      {isElectron() && <div className="custom-title-bar" />}
      <main
        style={{
          ...(isNarrowScreen
            ? {
                maxWidth: "calc(800px + 64px)",
                margin: "0 auto",
              }
            : {}),
        }}
      >
        <div
          style={{
            width: "100%",
            height: isElectron() ? "calc(100vh - 28px)" : "100vh",
            paddingLeft: isNarrowScreen ? 0 : 36,
            paddingRight: shouldShowScrollbar ? 0 : isNarrowScreen ? 0 : 36,
            position: "relative",
          }}
        >
          {isDragOver && (
            <div className="image-drop-overlay">
              <span className="image-drop-overlay-text">drop image</span>
            </div>
          )}
          <AceEditor
            theme={currentTheme.isDark ? "clouds_midnight" : "clouds"}
            ref={aceEditorRef}
            value={textValue}
            onChange={(newText: string) => {
              setTextValue(newText);
              saveNote(currentNoteId, newText);
              imageWidgetManagerRef.current?.scheduleSync();
              spotifyWidgetManagerRef.current?.scheduleSync();
            }}
            setOptions={{
              showLineNumbers: false,
              showGutter: false,
              wrap: true,
              highlightActiveLine: false,
              showPrintMargin: false,
              fontFamily: "'Berkeley Mono', 'JetBrains Mono', monospace",
            }}
            fontSize="1rem"
            onCursorChange={(e) => {
              setLastAceCursorPosition({
                row: e.cursor.row,
                column: e.cursor.column,
              });
            }}
            tabSize={2}
            keyboardHandler="vim"
            width="100%"
            height="100%"
            className="editor"
            onLoad={(editor) => {
              if (isElectron()) {
                editor.renderer.setPadding(70);
              }
              const aceScroller = document.querySelector(".ace_scrollbar") as HTMLElement;
              if (aceScroller) {
                aceScroller.style.visibility = shouldShowScrollbar ? "visible" : "hidden";
              }
            }}
            style={{
              lineHeight: "1.5",
              background: "var(--note-background-color)",
              color: "var(--dark-color)",
            }}
            placeholder="Type here..."
          />
        </div>
        <div id="controls">
          <div className="statusbar-left">
            <span className="statusbar-item statusbar-path">
              <span>{noteTitle}</span>
              {currentWorkspace && (
                <span className="statusbar-dim"> ({currentWorkspace})</span>
              )}
            </span>
            <span className="statusbar-item statusbar-dim">{wordCount}w</span>
          </div>
          <div className="statusbar-right">
            {backupStatus !== "idle" && (
              <span className="statusbar-item" style={backupStatus === "error" ? { color: "var(--red-color, #e05252)" } : undefined}>
                {backupStatus === "backing-up" ? "backing up..." : backupStatus === "done" ? "backed up" : "backup failed"}
              </span>
            )}
            <span className="statusbar-item">{currentTime}</span>
          {isHelpMenuOpen &&
            createPortal(
              <>
                <div className="ui-overlay" onClick={() => setIsHelpMenuOpen(false)} />
                <div className="help-menu">
                  <div className="ui-panel-header">
                    <span className="ui-panel-title">Keyboard Shortcuts</span>
                    <button className="ui-close-btn" onClick={() => setIsHelpMenuOpen(false)}>esc</button>
                  </div>
                  <div className="help-menu-shortcuts">
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>k/p</kbd>
                      </div>
                      <span>Open notes search</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>⇧</kbd>
                        <kbd>f</kbd>
                      </div>
                      <span>Search all notes</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>⇧</kbd>
                        <kbd>⏎</kbd>
                      </div>
                      <span>Create empty note</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>j/k</kbd>
                        <kbd>↑/↓</kbd>
                      </div>
                      <span>Navigation</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>e</kbd>
                      </div>
                      <span>Toggle narrow screen</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>←/→</kbd>
                      </div>
                      <span>Switch workspaces</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>←/→</kbd>
                      </div>
                      <span>Move note between workspaces</span>
                    </div>
                    <div className="help-menu-shortcuts-item">
                      <div className="help-menu-shortcuts-keys">
                        <kbd>{cmdKey}</kbd>
                        <kbd>h</kbd>
                      </div>
                      <span>Pin note to all workspaces</span>
                    </div>
                  </div>
                </div>
              </>,
              document.body
            )}
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMoreMenuPosition({
                x: window.innerWidth - (rect.x + rect.width),
                y: window.innerHeight - rect.y + 4,
              });
            }}
            aria-label="More"
            title="More"
          >
            <FiMoreHorizontal size={14} />
          </button>
          {moreMenuPosition && (
            <>
              <div
                style={{
                  width: "100vw",
                  height: "100vh",
                  position: "fixed",
                  top: 0,
                  left: 0,
                }}
                onClick={() => {
                  setMoreMenuPosition(null);
                }}
              />
              <div
                style={{
                  position: "fixed",
                  right: moreMenuPosition.x,
                  bottom: moreMenuPosition.y,
                  zIndex: 100,
                }}
                className="more-menu"
              >
                <button onClick={() => setIsUsingVim(!isUsingVim)}>
                  <span className="more-menu-check">{isUsingVim ? "✓" : ""}</span>
                  <span className="more-menu-label">vim mode</span>
                </button>
                <button onClick={() => {
                  setMoreMenuPosition(null);
                  setIsCmdKMenuOpen(true);
                  setIsThemePickerOpen(true);
                  setCmdKSearchQuery("");
                  const idx = THEMES.findIndex((t) => t.id === currentThemeId);
                  setSelectedCmdKSuggestionIndex(idx === -1 ? 0 : idx);
                  setTimeout(() => {
                    document.getElementById(`note-list-cmdk-item-${idx}`)?.scrollIntoView({ block: "center" });
                  });
                }}>
                  <span className="more-menu-check" />
                  <span className="more-menu-label">theme: {currentTheme.name.toLowerCase()}</span>
                </button>
                <div className="more-menu-divider" />
                <button
                  onClick={() => {
                    setMoreMenuPosition(null);
                    createCloudBackup();
                  }}
                  disabled={isBackingUp}
                >
                  <span className="more-menu-check" />
                  <span className="more-menu-label">{isBackingUp ? "backing up..." : "backup"}</span>
                </button>
                <button
                  onClick={() => {
                    setMoreMenuPosition(null);
                    openBackupList();
                  }}
                >
                  <span className="more-menu-check" />
                  <span className="more-menu-label">backups</span>
                </button>
                <button
                  onClick={() => {
                    setMoreMenuPosition(null);
                    exportDatabase();
                  }}
                >
                  <span className="more-menu-check" />
                  <span className="more-menu-label">export</span>
                </button>
                <button
                  onClick={() => {
                    setMoreMenuPosition(null);
                    fileInputDomRef.current?.click();
                  }}
                >
                  <span className="more-menu-check" />
                  <span className="more-menu-label">import</span>
                </button>
                {textValue && (
                  <button
                    onClick={() => {
                      setMoreMenuPosition(null);
                      openNewNote("");
                    }}
                  >
                    <span className="more-menu-check" />
                    <span className="more-menu-label">new note</span>
                  </button>
                )}
                <div className="more-menu-divider" />
                <a href="https://github.com/shaoruu/typehere.app" target="_blank" rel="noreferrer">
                  <button>
                    <span className="more-menu-check" />
                    <span className="more-menu-label">github</span>
                  </button>
                </a>
                <button
                  onClick={() => {
                    setMoreMenuPosition(null);
                    setIsHelpMenuOpen(true);
                  }}
                >
                  <span className="more-menu-check" />
                  <span className="more-menu-label">shortcuts</span>
                </button>
              </div>
            </>
          )}
          </div>
        </div>
        {isCmdKMenuOpen &&
          createPortal(
            <>
              <div
                className="ui-overlay"
                style={{ zIndex: 200, ...(isThemePickerOpen && { background: "transparent" }) }}
                onClick={() => setIsCmdKMenuOpen(false)}
              />
              <div
                className="ui-panel"
                style={{
                  zIndex: 201,
                  top: "22%",
                  left: "50%",
                  width: "380px",
                  maxWidth: "calc(100vw - 32px)",
                  transform: "translateX(-50%)",
                }}
              >
                <input
                  autoFocus
                  ref={cmdKInputDomRef}
                  placeholder={isThemePickerOpen ? "Search themes..." : "Search notes..."}
                  value={cmdKSearchQuery}
                  onChange={(e) => {
                    setCmdKSearchQuery(e.target.value);
                    setSelectedCmdKSuggestionIndex(0);
                  }}
                  style={{
                    padding: "10px 14px",
                    outline: "none",
                    border: "none",
                    borderBottom: "1px solid var(--border-color)",
                    borderRadius: 0,
                    fontSize: "0.85rem",
                    background: "transparent",
                    color: "var(--dark-color)",
                    width: "100%",
                  }}
                />
                <div
                  className="no-scrollbar"
                  onMouseMove={() => {
                    isSuppressingMousePreviewRef.current = false;
                  }}
                  style={{
                    maxHeight: "min(320px, 40vh)",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    padding: "4px",
                  }}
                >
                  {cmdKSuggestions.map((suggestion, index) => {
                    if (suggestion.type === "note") {
                      const note = suggestion.note;
                      const title = getNoteTitle(note);
                      const createdFormatted = formatDateCompact(note.createdAt);
                      const updatedFormatted = formatDateCompact(note.updatedAt);
                      const showBothDates = note.createdAt !== note.updatedAt;

                      return (
                        <div
                          key={`note-${note.id}-${index}`}
                          id={`note-list-cmdk-item-${index}`}
                          className="cmdk-item"
                          onClick={() => openNote(note.id)}
                          onMouseEnter={() => {
                            if (isSuppressingMousePreviewRef.current) return;
                            setSelectedCmdKSuggestionIndex(index);
                            previewThemeForSuggestion(suggestion);
                          }}
                          data-selected={index === selectedCmdKSuggestionIndex}
                        >
                          <div className="cmdk-item-main">
                            <span
                              className="cmdk-item-title"
                              style={{
                                fontWeight: note.id === currentNoteId ? 600 : undefined,
                                fontStyle: title ? "normal" : "italic",
                                color: title ? "var(--dark-color)" : "var(--untitled-note-title-color)",
                              }}
                            >
                              {isAltKeyDown && index + 1 <= digitCount && (
                                <span className="cmdk-item-index">{index + 1}</span>
                              )}
                              {note.isHidden && (
                                <MdVisibilityOff style={{ color: "var(--hidden-color)", marginRight: 3, fontSize: "0.8rem" }} />
                              )}
                              {note.isPinned && (
                                <FaMapPin style={{ marginRight: 3, color: "var(--pin-color)", fontSize: "0.75rem" }} />
                              )}
                              {title.trim() || "New Note"}
                            </span>
                            <button
                              className="cmdk-delete-btn"
                              onClick={(e) => { e.stopPropagation(); deleteNote(note.id); }}
                              style={{
                                visibility: workspaceNotes.length > 1 && index === selectedCmdKSuggestionIndex ? "visible" : "hidden",
                                pointerEvents: workspaceNotes.length > 1 && index === selectedCmdKSuggestionIndex ? "auto" : "none",
                              }}
                            >
                              delete
                            </button>
                          </div>
                          <div className="cmdk-item-meta">
                            {note.workspace && (
                              <>
                                <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", direction: "rtl" }}>
                                  {note.workspace}
                                </span>
                                <span>·</span>
                              </>
                            )}
                            {showBothDates ? (
                              <>
                                <span title="Created">{createdFormatted}</span>
                                <span>→</span>
                                <span title="Updated">{updatedFormatted}</span>
                              </>
                            ) : (
                              <span>{updatedFormatted}</span>
                            )}
                          </div>
                        </div>
                      );
                    }

                    const { title, color } = suggestion;

                    return (
                      <div
                        key={`action-${title}-${index}`}
                        id={`note-list-cmdk-item-${index}`}
                        className="cmdk-item cmdk-action"
                        onClick={() => {
                          if (runCmdKSuggestion(suggestion)) {
                            setIsCmdKMenuOpen(false);
                            setSelectedCmdKSuggestionIndex(0);
                          }
                        }}
                        onMouseEnter={() => {
                          if (isSuppressingMousePreviewRef.current) return;
                          setSelectedCmdKSuggestionIndex(index);
                          previewThemeForSuggestion(suggestion);
                        }}
                        data-selected={index === selectedCmdKSuggestionIndex}
                        style={{ position: "relative" }}
                      >
                        {color && (
                          <div
                            className="cmdk-action-stripe"
                            style={{
                              background: color,
                              opacity: index === selectedCmdKSuggestionIndex ? 1 : 0.4,
                            }}
                          />
                        )}
                        <div className="cmdk-item-main">
                          <span className="cmdk-item-title">{title}</span>
                          <kbd
                            className="cmdk-enter-hint"
                            style={{ visibility: index === selectedCmdKSuggestionIndex ? "visible" : "hidden" }}
                          >
                            ↵
                          </kbd>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="cmdk-footer">
                  {currentWorkspace ? `[${currentWorkspace}]` : "all notes"}
                </div>
              </div>
            </>,
            document.body
          )}
        <input
          type="file"
          style={{ display: "none" }}
          ref={fileInputDomRef}
          onChange={(e) => {
            const fileReader = new FileReader();
            const target = e.target as HTMLInputElement;
            if (!target.files) return;
            fileReader.readAsText(target.files[0], "UTF-8");
            fileReader.onload = (e) => {
              const decompressedContent = LZString.decompressFromEncodedURIComponent(
                e.target?.result as string
              );
              if (decompressedContent) {
                const content = JSON.parse(decompressedContent);
                setDatabase(content);
                setCurrentWorkspace(null);
              }
            };
          }}
        />
        {isBackupListOpen &&
          createPortal(
            <>
              <div className="ui-overlay" onClick={() => setIsBackupListOpen(false)} />
              <div
                className="ui-panel"
                style={{
                  top: "50%",
                  left: "50%",
                  transform: "translate(-50%, -50%)",
                  width: "380px",
                  maxWidth: "calc(100vw - 32px)",
                  maxHeight: "60vh",
                }}
              >
                <div className="ui-panel-header">
                  <span className="ui-panel-title">Cloud Backups</span>
                  <button className="ui-close-btn" onClick={() => setIsBackupListOpen(false)}>esc</button>
                </div>
                <div className="no-scrollbar" style={{ overflowY: "auto", flex: 1 }}>
                  {isLoadingBackups ? (
                    <div className="backup-list-row" style={{ justifyContent: "center", padding: "20px" }}>
                      <span className="backup-list-meta">loading...</span>
                    </div>
                  ) : backupList.length === 0 ? (
                    <div className="backup-list-row" style={{ justifyContent: "center", padding: "20px" }}>
                      <span className="backup-list-meta">no backups yet</span>
                    </div>
                  ) : (
                    backupList.map((entry) => (
                      <div key={entry.key} className="backup-list-row">
                        <span className="backup-list-label">{entry.label}</span>
                        <span className="backup-list-meta">{(entry.size / 1024).toFixed(1)}kb</span>
                        <button className="backup-restore-btn" onClick={() => restoreBackup(entry.key)}>
                          restore
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>,
            document.body
          )}
      </main>
      {spotlightSrc && (
        <ImageSpotlight src={spotlightSrc} onClose={() => setSpotlightSrc(null)} />
      )}
    </>
  );
}

export default App;
