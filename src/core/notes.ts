/**
 * User notes: free text the team attaches to tables and columns, stored in the small committed
 * file `.dbnext/notes.json`. The file is untrusted input: it is validated and size-limited on load,
 * and bad JSON yields empty notes instead of an error. Dependency-free (no Node APIs).
 *
 * File shape: `{ "version": 1, "tables": { "<entityId>": "note" }, "columns": { "<entityId>": { "<column>": "note" } } }`
 */

export const NOTES_PATH = '.dbnext/notes.json';

export interface Notes {
  /** Entity id -> note. */
  tables: Record<string, string>;
  /** Entity id -> column name -> note. */
  columns: Record<string, Record<string, string>>;
}

export const MAX_NOTE_LENGTH = 2000;
const MAX_NOTES = 20_000;
const MAX_KEY_LENGTH = 1000;
const MAX_FILE_LENGTH = 8 * 1024 * 1024;

export function emptyNotes(): Notes {
  return { tables: {}, columns: {} };
}

function cleanNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\r\n?/g, '\n').trim();
  return t ? t.slice(0, MAX_NOTE_LENGTH) : undefined;
}

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && key !== '__proto__';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Accepts only the documented shape; everything else is dropped. Never throws. */
export function sanitizeNotes(value: unknown): Notes {
  const out = emptyNotes();
  if (!isObject(value)) return out;
  let n = 0;
  if (isObject(value.tables)) {
    for (const [id, raw] of Object.entries(value.tables)) {
      const note = cleanNote(raw);
      if (n >= MAX_NOTES || !note || !validKey(id)) continue;
      out.tables[id] = note;
      n++;
    }
  }
  if (isObject(value.columns)) {
    for (const [id, cols] of Object.entries(value.columns)) {
      if (!validKey(id) || !isObject(cols)) continue;
      const entry: Record<string, string> = {};
      for (const [col, raw] of Object.entries(cols)) {
        const note = cleanNote(raw);
        if (n >= MAX_NOTES || !note || !validKey(col)) continue;
        entry[col] = note;
        n++;
      }
      if (Object.keys(entry).length) out.columns[id] = entry;
    }
  }
  return out;
}

/** Parses the text of notes.json; invalid JSON or an invalid shape gives empty notes. */
export function parseNotes(text: string): Notes {
  if (text.length > MAX_FILE_LENGTH) return emptyNotes();
  try {
    return sanitizeNotes(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    return emptyNotes();
  }
}

function sortedObject<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Stable, diff-friendly JSON for the file (sorted keys, trailing newline). */
export function serializeNotes(notes: Notes): string {
  const clean = sanitizeNotes(notes);
  const columns: Record<string, Record<string, string>> = {};
  for (const [id, cols] of Object.entries(sortedObject(clean.columns))) columns[id] = sortedObject(cols);
  return `${JSON.stringify({ version: 1, tables: sortedObject(clean.tables), columns }, null, 2)}\n`;
}

export function isEmptyNotes(notes: Notes): boolean {
  return Object.keys(notes.tables).length === 0 && Object.keys(notes.columns).length === 0;
}

export function tableNote(notes: Notes | undefined, entityId: string): string | undefined {
  return notes && Object.prototype.hasOwnProperty.call(notes.tables, entityId) ? notes.tables[entityId] : undefined;
}

export function columnNote(notes: Notes | undefined, entityId: string, column: string): string | undefined {
  const cols = notes && Object.prototype.hasOwnProperty.call(notes.columns, entityId) ? notes.columns[entityId] : undefined;
  return cols && Object.prototype.hasOwnProperty.call(cols, column) ? cols[column] : undefined;
}

/** Returns new notes with the table note set (empty text removes it). */
export function withTableNote(notes: Notes, entityId: string, text: string): Notes {
  const next = sanitizeNotes(notes);
  const note = cleanNote(text);
  if (note && validKey(entityId)) next.tables[entityId] = note;
  else delete next.tables[entityId];
  return next;
}

/** Returns new notes with the column note set (empty text removes it). */
export function withColumnNote(notes: Notes, entityId: string, column: string, text: string): Notes {
  const next = sanitizeNotes(notes);
  const note = cleanNote(text);
  if (!validKey(entityId) || !validKey(column)) return next;
  const cols = { ...(next.columns[entityId] ?? {}) };
  if (note) cols[column] = note;
  else delete cols[column];
  if (Object.keys(cols).length) next.columns[entityId] = cols;
  else delete next.columns[entityId];
  return next;
}
