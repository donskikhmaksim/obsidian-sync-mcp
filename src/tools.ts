import type { FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { isPathWritable } from "./write-scope.js";
import { describeListing, describeNoMatch } from "./list-format.js";
import { describeHits, describeQuery, describeSync, type SyncStatus } from "./search-format.js";
import { editSection, findSection, isValidFrontmatterKey, renameFolderPaths, setFrontmatterKey, trashPath } from "./note-edit.js";
import { attachmentMimeType } from "./note-path.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

/** Runs a CouchDB catch-up before a search; undefined in local (VAULT_PATH) mode. */
export type SyncBeforeSearch = () => Promise<{ unreadable: number; error?: string }>;

export const SEARCH_MAX_HITS = 20;
/** Each term is one more regex pass over every note (synchronous), so the count is capped. */
export const SEARCH_MAX_TERMS = 20;
/** Each term is compiled into a regex; a very long one overflows the stack (~10 KB with flags iu) or blocks the event loop, so its length is capped. */
export const SEARCH_MAX_TERM_LENGTH = 200;

/** Trim, drop empty terms, cut each to SEARCH_MAX_TERM_LENGTH and clamp to SEARCH_MAX_TERMS — a backstop behind the schema's .max(). */
export function cleanSearchTerms(terms: string[] | undefined): string[] {
    return (terms ?? [])
        .map((t) => t.trim().slice(0, SEARCH_MAX_TERM_LENGTH))
        .filter((t) => t.length > 0)
        .slice(0, SEARCH_MAX_TERMS);
}

const WRITE_TOOLS = ["write_note", "edit_note", "edit_section", "set_frontmatter", "delete_note", "move_note", "rename_folder"] as const;

/** Folder that delete_note moves notes into (soft delete). Visible on purpose: LiveSync skips dot-folders. */
export const TRASH_FOLDER = (process.env.TRASH_FOLDER || "_Trash").replace(/^\/+|\/+$/g, "");
export const READ_NOTES_MAX = 20;
export const RENAME_FOLDER_MAX = 1000;
/** Raw size cap for read_attachment; model clients reject larger images. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

// Claude Code persists any MCP tool result above ~50 000 characters to a file
// and hands the model a 2 kB preview instead of the text. A tool can raise its
// own threshold (hard ceiling 500 000) by declaring
// `_meta["anthropic/maxResultSizeChars"]` in its tools/list entry; text from
// such a tool is then also exempt from MAX_MCP_OUTPUT_TOKENS. See
// https://code.claude.com/docs/en/mcp#raise-the-limit-for-a-specific-tool
// read_note returns whole notes, so it declares 100 000: enough for a large
// note to arrive in one piece, small enough to keep one read inside a sane
// context budget. Other clients ignore the key.
export const READ_NOTE_MAX_RESULT_SIZE_CHARS = 100_000;

export function registerTools(
    server: FastMCP,
    vault: VaultBackend,
    searchIndex: SearchIndex,
    vaultName: string,
    readOnly = false,
    writeFolders: string[] | null = null,
    syncBeforeSearch?: SyncBeforeSearch,
) {
    if (readOnly) {
        console.log(`READ_ONLY mode: write tools disabled (${WRITE_TOOLS.join(", ")}).`);
    } else if (writeFolders) {
        console.log(`WRITE_FOLDERS: writes restricted to ${writeFolders.map((f) => f + "/").join(", ")}.`);
    }
    const writeScopeNote = writeFolders
        ? ` Writes are only allowed inside: ${writeFolders.map((f) => f + "/").join(", ")}.`
        : "";
    const denyWrite = (path: string) =>
        `Write access denied: '${path}' is outside the writable folders (${writeFolders!.map((f) => f + "/").join(", ")}).`;
    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const result = await original(args, ctx);
            if (debugLogging) console.log(`[tool] ${tool.name} → ${((performance.now() - start)).toFixed(0)}ms`);
            return result;
        };
        return _addTool(tool);
    };
    server.addTool({
        name: "read_note",
        description:
            "Read the content of a note from the Obsidian vault. Returns the markdown content and a deep link to open it in Obsidian.",
        _meta: { "anthropic/maxResultSizeChars": READ_NOTE_MAX_RESULT_SIZE_CHARS },
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async ({ path }) => {
            const content = await vault.readNote(path);
            if (content === null) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            return `[Open in Obsidian](${deepLink})\n\n---\n\n${content}`;
        },
    });

    if (!readOnly) server.addTool({
        name: "write_note",
        description:
            "Write or update a note in the Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
        }),
        execute: async ({ path, content }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const ok = await vault.writeNote(path, content);
            if (!ok) {
                return `Failed to write note: ${path}`;
            }
            searchIndex.update(path, content, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note saved: ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in the vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe("Max number of notes to return. Default 100."),
        }),
        execute: async ({ folder, name, tag, sort_by, modified_after, limit }) => {
            // Use search index (works with encrypted vaults), fall back to vault
            let notes = searchIndex.listWithMtime(folder);
            let vaultTotal: number | null = searchIndex.size;
            let servedByVault = false;
            if (notes.length === 0) {
                notes = await vault.listNotesWithMtime(folder);
                servedByVault = notes.length > 0;
                // The fallback only tells us the vault total when it was unscoped.
                if (vaultTotal === 0) vaultTotal = folder ? null : notes.length;
            }
            const folderTotal = folder ? notes.length : null;
            const filters: string[] = [];
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
                filters.push(`name="${name}"`);
            }
            if (tag) {
                notes = notes.filter((n) => searchIndex.getTags(n.path).includes(tag));
                filters.push(`tag="${tag}"`);
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
                filters.push(`modified_after="${modified_after}"`);
            }
            const index = { state: searchIndex.state, size: searchIndex.size, servedByVault };
            if (notes.length === 0) {
                return describeNoMatch({ vaultTotal, folder, folderTotal, filters, index });
            }
            const sortBy = sort_by === "modified" ? "modified" : "name";
            if (sortBy === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const header = describeListing({
                shown: capped.length,
                matched: total,
                vaultTotal,
                folder,
                folderTotal,
                filters,
                sortBy,
                limit: cap,
                omitted: notes.slice(cap).map((n) => n.path),
                index,
            });
            const lines = capped.map((n) => {
                const deepLink = makeDeepLink(vaultName, n.path);
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${deepLink})`;
            });
            return [header, ...lines].join("\n");
        },
    });

    server.addTool({
        name: "search_notes",
        description:
            "Search note contents for terms, case-insensitive.\n" +
            "Paths and frontmatter titles are searched first and such hits rank on top, marked [path/title]; content hits follow. " +
            "Returns paths with one context line each, never the note body: call read_note on a hit before relying on it. " +
            "Give `terms` (a note matches when ANY term occurs — OR, so list synonyms, field names and other-language wordings; a term may contain spaces; ranked by how many terms match) " +
            "Filters: folder, tag, modified_after. " +
            "The first line of every response is the index status: the CouchDB sequence the index is caught up with after a catch-up run just before the search, " +
            "the server time (local zone and UTC), its age in minutes, how many notes carry content, and any documents that could not be read.",
        parameters: z.object({
            terms: z
                .array(z.string().max(SEARCH_MAX_TERM_LENGTH))
                .max(SEARCH_MAX_TERMS)
                .optional()
                .describe(`Case-insensitive substrings, at most ${SEARCH_MAX_TERMS} of at most ${SEARCH_MAX_TERM_LENGTH} characters each; a note matches when any of them occurs. E.g. ['drag i kanban', 'kanban', 'labels på kategori'].`),
            folder: z
                .string()
                .optional()
                .describe("Folder to search in, e.g. 'projects'. Omit for the whole vault."),
            tag: z
                .string()
                .optional()
                .describe("Only notes carrying this tag, e.g. 'project'."),
            modified_after: z
                .string()
                .optional()
                .describe("Only notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe(`Max hits to return, default and maximum ${SEARCH_MAX_HITS}.`),
        }),
        execute: async ({ terms, folder, tag, modified_after, limit }) => {
            const cleanTerms = cleanSearchTerms(terms);
            if (cleanTerms.length === 0) {
                return "Give at least one term.";
            }
            let modifiedAfter: number | undefined;
            if (modified_after) {
                modifiedAfter = new Date(modified_after).getTime();
                if (isNaN(modifiedAfter)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
            }
            const cap = Math.max(1, Math.min(SEARCH_MAX_HITS, limit ?? SEARCH_MAX_HITS));

            // Catch up first, so a hit can never predate the vault (see main.ts).
            const sync = syncBeforeSearch ? await syncBeforeSearch() : { unreadable: 0 };
            const status: SyncStatus = {
                mode: syncBeforeSearch ? "couchdb" : "local",
                state: searchIndex.state,
                seq: searchIndex.since,
                syncedAt: searchIndex.lastSyncAt,
                now: Date.now(),
                notes: searchIndex.size,
                withContent: searchIndex.contentCount,
                unreadable: sync.unreadable,
                error: sync.error,
            };
            const { hits, total } = searchIndex.search({ terms: cleanTerms, folder, tag, modifiedAfter, limit: cap });
            const query = describeQuery(cleanTerms);
            return `${describeSync(status)}\n${describeHits(hits, total, query, (p) => makeDeepLink(vaultName, p))}`;
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in the vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note counts.",
        parameters: z.object({}),
        execute: async () => {
            let paths = searchIndex.listPaths();
            if (paths.length === 0) {
                paths = await vault.listNotes();
            }
            const folders = new Map<string, number>();
            for (const p of paths) {
                const lastSlash = p.lastIndexOf("/");
                if (lastSlash === -1) {
                    folders.set("(root)", (folders.get("(root)") ?? 0) + 1);
                } else {
                    const folder = p.slice(0, lastSlash);
                    folders.set(folder, (folders.get(folder) ?? 0) + 1);
                    // Ensure all parent folders appear in the list
                    let parent = folder;
                    while (parent.includes("/")) {
                        parent = parent.slice(0, parent.lastIndexOf("/"));
                        if (!folders.has(parent)) folders.set(parent, 0);
                    }
                }
            }
            if (folders.size === 0) {
                return "Vault is empty.";
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, count]) => `- ${f} (${count} notes)`).join("\n");
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in the vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({}),
        execute: async () => {
            const tags = searchIndex.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault.";
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });



    if (!readOnly) server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            content: z.string().describe("Text to append, prepend, or use as replacement for old_text"),
            operation: z
                .enum(["append", "prepend", "replace"])
                .optional()
                .describe("'append' (default): add to end. 'prepend': add after frontmatter. 'replace': swap old_text with content."),
            old_text: z
                .string()
                .optional()
                .describe("Required for replace operation. Exact text to find and replace. Must match exactly once."),
        }),
        execute: async ({ path, content: newContent, operation, old_text }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const existing = await vault.readNote(path);
            if (existing === null) {
                return `Note not found: ${path}`;
            }

            let updated: string;
            const op = operation ?? "append";

            if (op === "replace") {
                if (!old_text) {
                    return "old_text is required for replace operation.";
                }
                const idx = existing.indexOf(old_text);
                if (idx === -1) {
                    return "old_text not found in note.";
                }
                if (existing.indexOf(old_text, idx + 1) !== -1) {
                    return "old_text matches multiple times. Provide a longer, unique string.";
                }
                updated = existing.slice(0, idx) + newContent + existing.slice(idx + old_text.length);
            } else if (op === "prepend") {
                // Insert after frontmatter if present
                const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                if (fmMatch) {
                    const afterFm = fmMatch[0].length;
                    updated = existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
                } else {
                    updated = newContent + "\n" + existing;
                }
            } else {
                // append
                updated = existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
            }

            const ok = await vault.writeNote(path, updated);
            if (!ok) {
                return `Failed to edit note: ${path}`;
            }
            searchIndex.update(path, updated, Date.now());
            const deepLink = makeDeepLink(vaultName, path);
            return `Note edited (${op}): ${path}\n[Open in Obsidian](${deepLink})`;
        },
    });

    if (!readOnly) server.addTool({
        name: "delete_note",
        description:
            `Delete a note. By default this is a soft delete: the note is moved to '${TRASH_FOLDER}/<date>/<original path>' and can be restored with move_note. ` +
            "Set permanent=true only when the user explicitly asks to delete for good." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note to delete"),
            permanent: z.boolean().optional().describe("Delete for good instead of moving to the trash folder. Default false."),
        }),
        execute: async ({ path, permanent }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            // The sync layer reports success even when nothing existed at the
            // path, so "Deleted" would claim a cleanup that never happened.
            // readNote returns "" for an empty note and null only when absent.
            const existing = await vault.readNote(path);
            if (existing === null) return `Note not found: ${path}`;
            if (permanent || path.startsWith(TRASH_FOLDER + "/")) {
                const ok = await vault.deleteNote(path);
                if (ok) searchIndex.remove(path);
                return ok ? `Deleted permanently: ${path}` : `Failed to delete: ${path}`;
            }
            const taken = new Set((await vault.listNotes(TRASH_FOLDER)).map((p) => p.toLowerCase()));
            const dest = trashPath(TRASH_FOLDER, path, new Date(), (p) => taken.has(p.toLowerCase()));
            if (!isPathWritable(dest, writeFolders)) {
                return `Cannot move to trash: '${TRASH_FOLDER}/' is outside the writable folders. Use permanent=true to delete for good.`;
            }
            const ok = await vault.moveNote(path, dest);
            if (!ok) return `Failed to move to trash: ${path}`;
            searchIndex.remove(path);
            searchIndex.update(dest, existing, Date.now());
            return `Moved to trash: ${path} → ${dest}\nRestore with move_note(from='${dest}', to='${path}').`;
        },
    });

    if (!readOnly) server.addTool({
        name: "move_note",
        description:
            "Move or rename a note. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically." + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async ({ from, to }) => {
            // Moving out of a folder deletes there; moving in writes there — both ends must be writable.
            if (!isPathWritable(from, writeFolders)) return denyWrite(from);
            if (!isPathWritable(to, writeFolders)) return denyWrite(to);
            const content = await vault.readNote(from);
            const ok = await vault.moveNote(from, to);
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            searchIndex.remove(from);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) searchIndex.update(to, content, Date.now());
            const deepLink = makeDeepLink(vaultName, to);
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${deepLink})`;
        },
    });

    server.addTool({
        name: "read_notes",
        description: `Read several notes in one call (up to ${READ_NOTES_MAX}). Returns each note's content under its path; missing notes are reported, not fatal.`,
        _meta: { "anthropic/maxResultSizeChars": READ_NOTE_MAX_RESULT_SIZE_CHARS },
        parameters: z.object({
            paths: z.array(z.string()).min(1).max(READ_NOTES_MAX).describe("Vault-relative note paths, e.g. ['daily/2026-03-23.md', 'projects/x.md']"),
        }),
        execute: async ({ paths }) => {
            const parts: string[] = [];
            const skipped: string[] = [];
            let used = 0;
            for (const path of paths) {
                let content: string | null;
                try {
                    content = await vault.readNote(path);
                } catch (e: any) {
                    parts.push(`## ${path}\n\n(${e?.message ?? "invalid path"})`);
                    continue;
                }
                if (content === null) {
                    parts.push(`## ${path}\n\n(Note not found)`);
                    continue;
                }
                const block = `## ${path}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})\n\n${content}`;
                if (used + block.length > READ_NOTE_MAX_RESULT_SIZE_CHARS - 2000 && parts.length > 0) {
                    skipped.push(path);
                    continue;
                }
                used += block.length;
                parts.push(block);
            }
            if (skipped.length) parts.push(`(Not included, response size limit reached — read separately: ${skipped.join(", ")})`);
            return parts.join("\n\n---\n\n");
        },
    });

    server.addTool({
        name: "read_section",
        description: "Read one section of a note: the heading line and everything under it up to the next heading of the same or higher level. Give the heading text ('Tasks') or pin its level ('## Tasks').",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note"),
            heading: z.string().describe("Heading text, optionally with its #'s, e.g. '## Tasks'"),
        }),
        execute: async ({ path, heading }) => {
            const content = await vault.readNote(path);
            if (content === null) return `Note not found: ${path}`;
            const range = findSection(content, heading);
            if ("error" in range) return range.error;
            return content.slice(range.headingStart, range.end);
        },
    });

    if (!readOnly) server.addTool({
        name: "edit_section",
        description:
            "Edit one section of a note by its heading without touching the rest. 'replace' swaps the section body (the heading line stays), 'append' adds to the end of the section, 'prepend' adds right under the heading." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note"),
            heading: z.string().describe("Heading text, optionally with its #'s, e.g. '## Tasks'"),
            content: z.string().describe("Markdown to put in the section"),
            operation: z.enum(["replace", "append", "prepend"]).optional().describe("Default 'append'."),
        }),
        execute: async ({ path, heading, content: text, operation }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            const existing = await vault.readNote(path);
            if (existing === null) return `Note not found: ${path}`;
            const range = findSection(existing, heading);
            if ("error" in range) return range.error;
            const op = operation ?? "append";
            const updated = editSection(existing, range, op, text);
            if (updated === existing) return `No change: ${path}`;
            const ok = await vault.writeNote(path, updated);
            if (!ok) return `Failed to edit note: ${path}`;
            searchIndex.update(path, updated, Date.now());
            return `Section "${range.title}" edited (${op}): ${path}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
        },
    });

    if (!readOnly) server.addTool({
        name: "set_frontmatter",
        description:
            "Set or remove one frontmatter property (YAML at the top of the note) without rewriting the note. Creates the frontmatter if the note has none. Other properties are left exactly as they are." + writeScopeNote,
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note"),
            key: z.string().describe("Property name, e.g. 'status' or 'tags'"),
            value: z
                .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
                .optional()
                .describe("New value: text, number, true/false, or a list of strings (e.g. tags). Omit with remove=true to delete the property."),
            remove: z.boolean().optional().describe("Remove the property instead of setting it."),
        }),
        execute: async ({ path, key, value, remove }) => {
            if (!isPathWritable(path, writeFolders)) return denyWrite(path);
            if (!isValidFrontmatterKey(key)) return `Invalid property name: ${key}`;
            if (!remove && value === undefined) return "Give a value, or remove=true to delete the property.";
            const existing = await vault.readNote(path);
            if (existing === null) return `Note not found: ${path}`;
            const result = setFrontmatterKey(existing, key, remove ? null : value!);
            if (!result.changed) return remove ? `Property '${key}' not present: ${path}` : `No change: ${path}`;
            const ok = await vault.writeNote(path, result.content);
            if (!ok) return `Failed to edit note: ${path}`;
            searchIndex.update(path, result.content, Date.now());
            const what = remove ? "removed" : result.existed ? "updated" : "added";
            return `Property '${key}' ${what}: ${path}\n[Open in Obsidian](${makeDeepLink(vaultName, path)})`;
        },
    });

    if (vault.listAttachments) server.addTool({
        name: "list_attachments",
        description: "List image and PDF attachments in the vault (png, jpg, gif, webp, bmp, svg, pdf) with size and modification time. Use read_attachment to view one.",
        parameters: z.object({
            folder: z.string().optional().describe("Folder to list, e.g. 'attachments'. Omit for the whole vault."),
            name: z.string().optional().describe("Case-insensitive substring of the path."),
            limit: z.coerce.number().optional().describe("Max entries, default 100."),
        }),
        execute: async ({ folder, name, limit }) => {
            let items = await vault.listAttachments!(folder);
            if (name) items = items.filter((a) => a.path.toLowerCase().includes(name.toLowerCase()));
            if (items.length === 0) return folder ? `No attachments in ${folder}.` : "No attachments found.";
            const cap = limit ?? 100;
            const lines = items.slice(0, cap).map((a) => {
                const date = a.mtime ? new Date(a.mtime).toISOString().slice(0, 16) : "";
                const kb = Math.max(1, Math.round(a.size / 1024));
                return `- ${date} ${a.path} (${kb} KB)`;
            });
            const header = `${items.length} attachment(s)` + (items.length > cap ? `, showing ${cap}` : "");
            return [header, ...lines].join("\n");
        },
    });

    if (vault.readAttachment) server.addTool({
        name: "read_attachment",
        description: `View an image or PDF attachment from the vault (up to ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB). Images come back as images; PDFs as an embedded PDF resource.`,
        parameters: z.object({
            path: z.string().describe("Vault-relative path, e.g. 'attachments/photo.png'"),
        }),
        execute: async ({ path }) => {
            const mimeType = attachmentMimeType(path);
            if (!mimeType) return `Unsupported attachment type: ${path}`;
            const bytes = await vault.readAttachment!(path);
            if (bytes === null) return `Attachment not found: ${path}`;
            if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
                return `Attachment too large: ${path} is ${Math.round(bytes.byteLength / 1024 / 1024)} MB (limit ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB).`;
            }
            if (mimeType === "image/svg+xml") {
                return `SVG source of ${path}:\n\n${new TextDecoder().decode(bytes)}`;
            }
            const data = Buffer.from(bytes).toString("base64");
            const caption = { type: "text" as const, text: `${path} (${mimeType}, ${Math.max(1, Math.round(bytes.byteLength / 1024))} KB)` };
            if (mimeType.startsWith("image/")) {
                return { content: [caption, { type: "image" as const, data, mimeType }] };
            }
            return {
                content: [caption, { type: "resource" as const, resource: { uri: makeDeepLink(vaultName, path), mimeType, blob: data } }],
            };
        },
    });

    if (!readOnly) server.addTool({
        name: "rename_folder",
        description:
            `Rename or move a whole folder: every note and image/PDF attachment under it keeps its relative path under the new folder. Stops before moving anything if a destination note already exists. Up to ${RENAME_FOLDER_MAX} files per call.` + writeScopeNote,
        parameters: z.object({
            from: z.string().describe("Current folder, e.g. 'projects/old'"),
            to: z.string().describe("New folder, e.g. 'archive/old'"),
        }),
        execute: async ({ from, to }) => {
            const src = from.replace(/^\/+|\/+$/g, "");
            const dst = to.replace(/^\/+|\/+$/g, "");
            if (!src || !dst) return "Give both folders.";
            if (src === dst) return "Source and destination are the same.";
            if (dst.startsWith(src + "/")) return "Cannot move a folder into itself.";
            const notes = renameFolderPaths(await vault.listNotes(src), src, dst);
            const attachments = vault.listAttachments && vault.moveAttachment
                ? renameFolderPaths((await vault.listAttachments(src)).map((a) => a.path), src, dst)
                : [];
            const total = notes.length + attachments.length;
            if (total === 0) return `Folder is empty or not found: ${src}`;
            if (total > RENAME_FOLDER_MAX) return `Folder has ${total} files, more than ${RENAME_FOLDER_MAX}. Move subfolders separately.`;
            for (const m of [...notes, ...attachments]) {
                if (!isPathWritable(m.from, writeFolders)) return denyWrite(m.from);
                if (!isPathWritable(m.to, writeFolders)) return denyWrite(m.to);
            }
            const existingNotes = new Set((await vault.listNotes(dst)).map((p) => p.toLowerCase()));
            const existingAtt = new Set(
                vault.listAttachments ? (await vault.listAttachments(dst)).map((a) => a.path.toLowerCase()) : [],
            );
            const conflicts = [
                ...notes.filter((m) => existingNotes.has(m.to.toLowerCase())),
                ...attachments.filter((m) => existingAtt.has(m.to.toLowerCase())),
            ].map((m) => m.to);
            if (conflicts.length) {
                return `Nothing moved: ${conflicts.length} destination file(s) already exist:\n${conflicts.slice(0, 20).map((c) => `- ${c}`).join("\n")}`;
            }
            const failed: string[] = [];
            let moved = 0;
            for (const m of notes) {
                const content = await vault.readNote(m.from);
                const ok = content !== null && (await vault.moveNote(m.from, m.to));
                if (!ok) {
                    failed.push(m.from);
                    continue;
                }
                searchIndex.remove(m.from);
                searchIndex.update(m.to, content!, Date.now());
                moved++;
            }
            for (const m of attachments) {
                if (await vault.moveAttachment!(m.from, m.to)) moved++;
                else failed.push(m.from);
            }
            const summary = `Moved ${moved} of ${total} file(s): ${src}/ → ${dst}/`;
            return failed.length ? `${summary}\nFailed:\n${failed.map((f) => `- ${f}`).join("\n")}` : summary;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter, tags, outgoing links, backlinks (notes that link to this one), size, and timestamps. Use this to navigate the knowledge graph.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        execute: async ({ path }) => {
            const meta = await vault.getMetadata(path);
            if (!meta) {
                return `Note not found: ${path}`;
            }
            const deepLink = makeDeepLink(vaultName, path);
            const lines = [
                `**${path}**`,
                `Size: ${meta.size} bytes`,
                `Created: ${new Date(meta.ctime).toISOString()}`,
                `Modified: ${new Date(meta.mtime).toISOString()}`,
            ];
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${v}`);
                }
            }
            if (meta.tags.length > 0) {
                lines.push(`\nTags: ${meta.tags.map((t) => `#${t}`).join(", ")}`);
            }
            if (meta.links.length > 0) {
                lines.push(`\nOutgoing links: ${meta.links.join(", ")}`);
            }
            const backlinks = searchIndex.getBacklinks(path);
            if (backlinks.length > 0) {
                lines.push(`\nBacklinks: ${backlinks.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${deepLink})`);
            return lines.join("\n");
        },
    });
}
