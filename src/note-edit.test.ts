import { test } from "node:test";
import assert from "node:assert/strict";
import { editSection, findSection, isValidFrontmatterKey, renameFolderPaths, setFrontmatterKey, trashPath } from "./note-edit.js";

test("setFrontmatterKey updates a scalar and leaves other lines untouched", () => {
    const src = "---\ntitle: A\nstatus: draft\ntags:\n  - x\n---\nbody\n";
    const r = setFrontmatterKey(src, "status", "done");
    assert.equal(r.content, "---\ntitle: A\nstatus: done\ntags:\n  - x\n---\nbody\n");
    assert.equal(r.existed, true);
});

test("setFrontmatterKey replaces a block list, indented or not", () => {
    const src = "---\ntags:\n  - a\n  - b\nnext: 1\n---\n";
    assert.equal(setFrontmatterKey(src, "tags", ["c"]).content, "---\ntags:\n  - c\nnext: 1\n---\n");
    const flat = "---\ntags:\n- a\n- b\nnext: 1\n---\n";
    assert.equal(setFrontmatterKey(flat, "tags", ["c", "d"]).content, "---\ntags:\n  - c\n  - d\nnext: 1\n---\n");
});

test("setFrontmatterKey removes a key with its continuation lines", () => {
    const src = "---\na: 1\ntags:\n  - x\n  - y\nb: 2\n---\ntext";
    assert.equal(setFrontmatterKey(src, "tags", null).content, "---\na: 1\nb: 2\n---\ntext");
    assert.equal(setFrontmatterKey(src, "missing", null).changed, false);
});

test("setFrontmatterKey adds a key and creates frontmatter when absent", () => {
    assert.equal(setFrontmatterKey("---\na: 1\n---\n", "b", 2).content, "---\na: 1\nb: 2\n---\n");
    assert.equal(setFrontmatterKey("# Note\n", "status", "new").content, "---\nstatus: new\n---\n# Note\n");
    assert.equal(setFrontmatterKey("# Note\n", "status", null).changed, false);
});

test("setFrontmatterKey quotes strings that YAML would misread", () => {
    assert.match(setFrontmatterKey("", "a", "true").content, /a: "true"/);
    assert.match(setFrontmatterKey("", "a", "12").content, /a: "12"/);
    assert.match(setFrontmatterKey("", "a", "x: y").content, /a: "x: y"/);
    assert.match(setFrontmatterKey("", "a", "[[Link]]").content, /a: "\[\[Link\]\]"/);
    assert.match(setFrontmatterKey("", "a", "Привет мир").content, /a: Привет мир\n/);
    assert.match(setFrontmatterKey("", "a", true).content, /a: true\n/);
    assert.match(setFrontmatterKey("", "a", []).content, /a: \[\]\n/);
});

test("setFrontmatterKey keeps CRLF line endings", () => {
    const src = "---\r\na: 1\r\n---\r\nbody";
    assert.equal(setFrontmatterKey(src, "a", 2).content, "---\r\na: 2\r\n---\r\nbody");
});

test("isValidFrontmatterKey", () => {
    assert.ok(isValidFrontmatterKey("status"));
    assert.ok(isValidFrontmatterKey("дата создания"));
    assert.ok(!isValidFrontmatterKey("a:b"));
    assert.ok(!isValidFrontmatterKey(" a"));
    assert.ok(!isValidFrontmatterKey("- a"));
    assert.ok(!isValidFrontmatterKey("a\nb"));
});

const NOTE = "---\nx: 1\n---\n# Title\nintro\n\n## Tasks\n- one\n\n### Sub\nsub text\n\n## Notes\nnotes\n```\n## not a heading\n```\n";

test("findSection spans to the next heading of the same or higher level", () => {
    const r = findSection(NOTE, "Tasks");
    assert.ok(!("error" in r));
    assert.equal(NOTE.slice(r.headingStart, r.end), "## Tasks\n- one\n\n### Sub\nsub text\n\n");
    const notes = findSection(NOTE, "## Notes");
    assert.ok(!("error" in notes));
    assert.equal(NOTE.slice(notes.headingStart, notes.end), "## Notes\nnotes\n```\n## not a heading\n```\n");
});

test("findSection reports missing, wrong-level and duplicate headings", () => {
    const missing = findSection(NOTE, "Nope");
    assert.ok("error" in missing && missing.error.includes("## Tasks"));
    assert.ok("error" in findSection(NOTE, "# Tasks"));
    assert.ok("error" in findSection("## A\n## A\n", "A"));
    assert.ok("error" in findSection(NOTE, "not a heading"), "headings in code fences are ignored");
});

test("editSection replace, append and prepend", () => {
    const r = findSection(NOTE, "Tasks") as any;
    assert.ok(editSection(NOTE, r, "replace", "- new").includes("## Tasks\n- new\n\n## Notes"));
    assert.ok(editSection(NOTE, r, "append", "- two").includes("sub text\n- two\n\n## Notes"));
    assert.ok(editSection(NOTE, r, "prepend", "- zero").includes("## Tasks\n- zero\n- one"));
    const last = findSection("## A\ntext", "A") as any;
    assert.equal(editSection("## A\ntext", last, "append", "more"), "## A\ntext\nmore\n");
});

test("trashPath dates the folder and avoids collisions", () => {
    const now = new Date("2026-11-01T10:20:30Z");
    assert.equal(trashPath("_Trash", "a/b.md", now, () => false), "_Trash/2026-11-01/a/b.md");
    const taken = new Set(["_Trash/2026-11-01/a/b.md", "_Trash/2026-11-01/a/b 102030.md"]);
    assert.equal(trashPath("_Trash", "a/b.md", now, (p) => taken.has(p)), "_Trash/2026-11-01/a/b 102030-2.md");
});

test("renameFolderPaths keeps relative paths and ignores siblings with the same prefix", () => {
    assert.deepEqual(renameFolderPaths(["p/a.md", "p/x/b.md", "pp/c.md"], "p", "q/"), [
        { from: "p/a.md", to: "q/a.md" },
        { from: "p/x/b.md", to: "q/x/b.md" },
    ]);
});
