import type { NoteMetadata } from "./parse.js";

export interface NoteInfo extends NoteMetadata {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

export interface NoteListing {
    path: string;
    mtime: number;
}

export interface AttachmentListing {
    path: string;
    size: number;
    mtime: number;
}

export interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    /** Image and PDF files (see note-path.ts ATTACHMENT_MIME_TYPES). */
    listAttachments?(folder?: string): Promise<AttachmentListing[]>;
    /** Raw bytes of an attachment, or null when absent. */
    readAttachment?(path: string): Promise<Uint8Array | null>;
    /** Move an attachment; false when the source is absent. */
    moveAttachment?(from: string, to: string): Promise<boolean>;
    watchChanges?(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void): void;
    /**
     * Catch up on changes since a sequence. Returns the new sequence. CouchDB only.
     * `stats.unreadable` counts documents that could not be decrypted or loaded
     * and were therefore skipped — the caller reports them so "caught up" never
     * hides a silent miss.
     */
    catchUp?(since: string, callback: (path: string, content: string | null, mtime?: number) => void, onBatch?: (since: string, processed: number) => Promise<void>, stats?: { unreadable: number }): Promise<string>;
}
