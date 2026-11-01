import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { registerTools, TRASH_FOLDER } from "./tools.js";
import { validateAttachmentPath, isValidAttachmentPath } from "./note-path.js";

let dir: string;
const tools = new Map<string, any>();
const run = async (name: string, args: any) => tools.get(name).execute(args, {});

before(async () => {
    dir = await mkdtemp(join(tmpdir(), "tools-new-"));
    const vault = new LocalVault(dir);
    const index = { update() {}, remove() {}, listPaths: () => [], listWithMtime: () => [], size: 0 };
    const server = { addTool: (t: any) => tools.set(t.name, t) };
    registerTools(server as any, vault, index as any, "vault");
});

after(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("new tools against a local vault", () => {
    it("delete_note moves to the trash folder by default and can be restored", async () => {
        await mkdir(join(dir, "a"), { recursive: true });
        await writeFile(join(dir, "a/n.md"), "hello");
        const out = await run("delete_note", { path: "a/n.md" });
        assert.match(out, /Moved to trash/);
        assert.equal(existsSync(join(dir, "a/n.md")), false);
        const day = (await readdir(join(dir, TRASH_FOLDER)))[0];
        assert.equal(await readFile(join(dir, TRASH_FOLDER, day, "a/n.md"), "utf-8"), "hello");
        // A second note at the same path lands next to the first, not over it.
        await writeFile(join(dir, "a/n.md"), "again");
        await run("delete_note", { path: "a/n.md" });
        assert.equal((await readdir(join(dir, TRASH_FOLDER, day, "a"))).length, 2);
        // Deleting inside the trash, or with permanent=true, is for good.
        await writeFile(join(dir, "p.md"), "x");
        assert.match(await run("delete_note", { path: "p.md", permanent: true }), /Deleted permanently/);
        assert.equal(existsSync(join(dir, TRASH_FOLDER, day, "p.md")), false);
    });

    it("set_frontmatter sets and removes properties", async () => {
        await writeFile(join(dir, "f.md"), "---\nstatus: draft\n---\nbody\n");
        assert.match(await run("set_frontmatter", { path: "f.md", key: "status", value: "done" }), /updated/);
        assert.match(await run("set_frontmatter", { path: "f.md", key: "tags", value: ["a", "b"] }), /added/);
        assert.equal(await readFile(join(dir, "f.md"), "utf-8"), "---\nstatus: done\ntags:\n  - a\n  - b\n---\nbody\n");
        assert.match(await run("set_frontmatter", { path: "f.md", key: "status", remove: true }), /removed/);
        assert.equal(await readFile(join(dir, "f.md"), "utf-8"), "---\ntags:\n  - a\n  - b\n---\nbody\n");
        assert.match(await run("set_frontmatter", { path: "f.md", key: "x" }), /Give a value/);
    });

    it("read_section and edit_section work by heading", async () => {
        await writeFile(join(dir, "s.md"), "# T\n\n## A\none\n\n## B\ntwo\n");
        assert.equal(await run("read_section", { path: "s.md", heading: "A" }), "## A\none\n\n");
        await run("edit_section", { path: "s.md", heading: "## A", content: "uno", operation: "replace" });
        await run("edit_section", { path: "s.md", heading: "B", content: "three" });
        assert.equal(await readFile(join(dir, "s.md"), "utf-8"), "# T\n\n## A\nuno\n\n## B\ntwo\nthree\n");
        assert.match(await run("read_section", { path: "s.md", heading: "Z" }), /Heading not found/);
    });

    it("read_notes returns several notes and reports missing ones", async () => {
        await writeFile(join(dir, "r1.md"), "one");
        await writeFile(join(dir, "r2.md"), "two");
        const out = await run("read_notes", { paths: ["r1.md", "missing.md", "r2.md", "../x.md"] });
        assert.match(out, /## r1\.md[\s\S]*one/);
        assert.match(out, /## missing\.md\n\n\(Note not found\)/);
        assert.match(out, /## r2\.md[\s\S]*two/);
        assert.match(out, /## \.\.\/x\.md\n\n\(/);
    });

    it("list_attachments and read_attachment return images and PDFs", async () => {
        await mkdir(join(dir, "att"), { recursive: true });
        const png = Buffer.from("89504e470d0a1a0a", "hex");
        await writeFile(join(dir, "att/p.png"), png);
        await writeFile(join(dir, "att/d.pdf"), "%PDF-1.4");
        await writeFile(join(dir, "att/s.exe"), "nope");
        const list = await run("list_attachments", { folder: "att" });
        assert.match(list, /2 attachment/);
        assert.match(list, /att\/p\.png/);
        assert.doesNotMatch(list, /s\.exe/);
        const img = await run("read_attachment", { path: "att/p.png" });
        assert.equal(img.content[1].type, "image");
        assert.equal(img.content[1].mimeType, "image/png");
        assert.equal(Buffer.from(img.content[1].data, "base64").toString("hex"), png.toString("hex"));
        const pdf = await run("read_attachment", { path: "att/d.pdf" });
        assert.equal(pdf.content[1].type, "resource");
        assert.equal(pdf.content[1].resource.mimeType, "application/pdf");
        assert.match(await run("read_attachment", { path: "att/s.exe" }), /Unsupported/);
        assert.match(await run("read_attachment", { path: "att/none.png" }), /not found/);
    });

    it("rename_folder moves notes and attachments, and refuses to overwrite", async () => {
        await mkdir(join(dir, "old/sub"), { recursive: true });
        await writeFile(join(dir, "old/a.md"), "a");
        await writeFile(join(dir, "old/sub/b.md"), "b");
        await writeFile(join(dir, "old/sub/i.png"), "i");
        await mkdir(join(dir, "taken"), { recursive: true });
        await writeFile(join(dir, "taken/a.md"), "keep");
        assert.match(await run("rename_folder", { from: "old", to: "taken" }), /Nothing moved/);
        assert.equal(await readFile(join(dir, "old/a.md"), "utf-8"), "a");
        assert.match(await run("rename_folder", { from: "old", to: "new" }), /Moved 3 of 3/);
        assert.equal(await readFile(join(dir, "new/sub/b.md"), "utf-8"), "b");
        assert.equal(existsSync(join(dir, "new/sub/i.png")), true);
        assert.equal(existsSync(join(dir, "old/a.md")), false);
        assert.match(await run("rename_folder", { from: "new", to: "new/inner" }), /into itself/);
    });
});

describe("attachment path validation", () => {
    it("accepts images and PDFs, rejects notes, dot-folders and traversal", () => {
        assert.ok(isValidAttachmentPath("a/b.PNG"));
        assert.ok(isValidAttachmentPath("doc.pdf"));
        assert.ok(!isValidAttachmentPath("a.md"));
        assert.ok(!isValidAttachmentPath(".obsidian/x.png"));
        assert.ok(!isValidAttachmentPath("../x.png"));
        assert.ok(!isValidAttachmentPath("ix:x.png"));
        assert.ok(!isValidAttachmentPath("noext"));
        assert.throws(() => validateAttachmentPath("/abs.png"));
    });
});
