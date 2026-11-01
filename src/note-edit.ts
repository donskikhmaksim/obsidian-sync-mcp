/**
 * Pure text helpers behind the section and frontmatter tools. Kept free of
 * vault access so they can be unit-tested on plain strings.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)?---(\r?\n|$)/;

export type FrontmatterValue = string | number | boolean | string[] | null;

/** Serialize a scalar so YAML reads it back as the same string. */
function yamlScalar(value: string | number | boolean): string {
    if (typeof value !== "string") return String(value);
    // Plain scalars are only safe when they cannot be read as another type or
    // break the line; anything doubtful goes in JSON quotes (valid YAML).
    const plainSafe =
        value.length > 0 &&
        !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
        !/[:#]\s|:$|\s$|[\r\n\t]/.test(value) &&
        !/^(true|false|yes|no|on|off|null|~|[-+]?\d[\d_.eE+-]*)$/i.test(value);
    return plainSafe ? value : JSON.stringify(value);
}

function yamlEntry(key: string, value: Exclude<FrontmatterValue, null>): string[] {
    if (Array.isArray(value)) {
        if (value.length === 0) return [`${key}: []`];
        return [`${key}:`, ...value.map((v) => `  - ${yamlScalar(v)}`)];
    }
    return [`${key}: ${yamlScalar(value)}`];
}

/** Top-level key at the start of a frontmatter line, or null. */
function lineKey(line: string): string | null {
    if (/^[\s#-]/.test(line) || line.length === 0) return null;
    const m = line.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:(\s|$)/);
    if (!m) return null;
    let k = m[1];
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
    return k;
}

export function isValidFrontmatterKey(key: string): boolean {
    return /^[^\s:#\-"'][^:\r\n]*$/.test(key) && key.trim() === key;
}

/**
 * Set (value !== null) or remove (value === null) one top-level frontmatter
 * key. Other lines are left byte-for-byte as they were. Creates the
 * frontmatter block when setting a key on a note that has none.
 */
export function setFrontmatterKey(
    content: string,
    key: string,
    value: FrontmatterValue,
): { content: string; changed: boolean; existed: boolean } {
    const m = content.match(FRONTMATTER_RE);
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    if (!m) {
        if (value === null) return { content, changed: false, existed: false };
        const block = ["---", ...yamlEntry(key, value), "---"].join(eol) + eol;
        return { content: block + content, changed: true, existed: false };
    }
    const body = m[1] ?? "";
    const lines = body.length ? body.replace(/\r?\n$/, "").split(/\r?\n/) : [];
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lineKey(lines[i]) === key) {
            start = i;
            break;
        }
    }
    let end = start;
    if (start !== -1) {
        // The value continues over indented lines and unindented block-list items.
        end = start + 1;
        while (end < lines.length && (/^\s/.test(lines[end]) || /^-(\s|$)/.test(lines[end]) || lines[end] === "")) {
            if (lines[end] === "" && !(end + 1 < lines.length && /^(\s|-(\s|$))/.test(lines[end + 1]))) break;
            end++;
        }
    }
    const replacement = value === null ? [] : yamlEntry(key, value);
    let newLines: string[];
    if (start === -1) {
        if (value === null) return { content, changed: false, existed: false };
        newLines = [...lines, ...replacement];
    } else {
        newLines = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
    }
    const rebuilt = "---" + eol + (newLines.length ? newLines.join(eol) + eol : "") + "---" + m[2];
    const updated = rebuilt + content.slice(m[0].length);
    return { content: updated, changed: updated !== content, existed: start !== -1 };
}

export interface SectionRange {
    /** Index of the first character of the heading line. */
    headingStart: number;
    /** Index just after the heading line's line break. */
    bodyStart: number;
    /** Index where the next heading of the same or higher level begins (or end of note). */
    end: number;
    level: number;
    title: string;
}

interface Heading {
    start: number;
    lineEnd: number;
    level: number;
    title: string;
}

function listHeadings(content: string): Heading[] {
    const headings: Heading[] = [];
    let fence: string | null = null;
    let pos = 0;
    const fm = content.match(FRONTMATTER_RE);
    if (fm) pos = fm[0].length;
    while (pos < content.length) {
        const nl = content.indexOf("\n", pos);
        const lineEnd = nl === -1 ? content.length : nl + 1;
        const line = content.slice(pos, nl === -1 ? content.length : nl).replace(/\r$/, "");
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (fence === null) fence = marker;
            else if (fence === marker) fence = null;
        } else if (fence === null) {
            const h = line.match(/^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
            if (h) headings.push({ start: pos, lineEnd, level: h[1].length, title: h[2].trim() });
        }
        pos = lineEnd;
    }
    return headings;
}

/**
 * Find the section under a heading. `heading` is the heading text, optionally
 * with its leading #'s to pin the level ("## Tasks" or "Tasks").
 */
export function findSection(content: string, heading: string): SectionRange | { error: string } {
    const want = heading.trim().match(/^(#{1,6})?\s*(.*)$/)!;
    const level = want[1]?.length;
    const title = want[2].trim().toLowerCase();
    if (!title) return { error: "Heading text is empty." };
    const headings = listHeadings(content);
    const matches = headings.filter((h) => h.title.toLowerCase() === title && (level === undefined || h.level === level));
    if (matches.length === 0) {
        const available = headings.map((h) => `${"#".repeat(h.level)} ${h.title}`).slice(0, 50);
        return {
            error: `Heading not found: ${heading}.` + (available.length ? ` Headings in this note:\n${available.join("\n")}` : " The note has no headings."),
        };
    }
    if (matches.length > 1) {
        return { error: `Heading "${heading}" occurs ${matches.length} times. Add the #'s for its level, or rename one of them.` };
    }
    const h = matches[0];
    const next = headings.find((o) => o.start > h.start && o.level <= h.level);
    return { headingStart: h.start, bodyStart: h.lineEnd, end: next ? next.start : content.length, level: h.level, title: h.title };
}

export type SectionOperation = "replace" | "append" | "prepend";

/** Apply an edit to the body of a section; the heading line itself is kept. */
export function editSection(content: string, range: SectionRange, op: SectionOperation, text: string): string {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    let headingPart = content.slice(range.headingStart, range.bodyStart);
    if (!headingPart.endsWith("\n")) headingPart += eol;
    const body = content.slice(range.bodyStart, range.end);
    const before = content.slice(0, range.headingStart);
    const after = content.slice(range.end);
    const withEol = (s: string) => (s === "" || s.endsWith("\n") ? s : s + eol);
    let newBody: string;
    if (op === "replace") {
        newBody = withEol(text);
        // Keep one blank line before the next heading, as Obsidian writes it.
        if (after.length > 0 && !newBody.endsWith(eol + eol) && newBody !== "") newBody += eol;
    } else if (op === "prepend") {
        newBody = withEol(text) + body;
    } else {
        // Append after the last non-blank line of the section, keeping trailing blank lines.
        const trailing = body.match(/(\r?\n)*$/)![0];
        const core = body.slice(0, body.length - trailing.length);
        const sep = core === "" ? "" : eol;
        newBody = core + sep + withEol(text) + (trailing.length > 0 ? trailing.replace(/^\r?\n/, "") : "");
        if (after.length > 0 && !newBody.endsWith(eol + eol)) newBody += eol;
    }
    return before + headingPart + newBody + after;
}

/** Destination of a soft-deleted note: <trash>/<YYYY-MM-DD>/<original path>. */
export function trashPath(trashFolder: string, path: string, now: Date, taken: (p: string) => boolean): string {
    const day = now.toISOString().slice(0, 10);
    const base = `${trashFolder}/${day}/${path}`;
    if (!taken(base)) return base;
    const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
    const stem = base.replace(/\.md$/, "");
    let candidate = `${stem} ${stamp}.md`;
    for (let i = 2; taken(candidate); i++) candidate = `${stem} ${stamp}-${i}.md`;
    return candidate;
}

/** Map every path under folder `from` to the same relative path under `to`. */
export function renameFolderPaths(paths: string[], from: string, to: string): { from: string; to: string }[] {
    const src = from.replace(/\/+$/, "") + "/";
    const dst = to.replace(/\/+$/, "") + "/";
    return paths.filter((p) => p.startsWith(src)).map((p) => ({ from: p, to: dst + p.slice(src.length) }));
}
