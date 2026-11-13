// Node-only helpers (filesystem, hashing). Kept out of index.ts so the browser
// client can import the validator and types without pulling in node: modules.
import { access, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ContentSource, SourceFile } from "./types.js";

export { buildBundle } from "./bundle.js";

const FOLDERS = {
  taxonomy: "taxonomy",
  modules: "modules",
  taskSets: "tasks",
  courses: "courses",
  places: "moonbridge/places.json",
  characters: "moonbridge/characters.json",
  episodes: "moonbridge/episodes",
  daily: "moonbridge/daily.json",
  welcome: "moonbridge/welcome.json",
  schoolHomework: "school/homework.json",
  assessments: "school/assessments.json",
  pages: "school/pages",
} as const;

/**
 * A page file: a header of `key: value` lines between --- lines, then Markdown. The file name
 * is the page id. A file without the header is all body (and fails the schema: no title).
 */
export function parsePage(fileName: string, text: string): Record<string, unknown> {
  const page: Record<string, unknown> = { page_id: fileName.replace(/\.md$/, "") };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  const header = m ? m[1]! : "";
  const body = (m ? m[2]! : text).trim();
  for (const line of header.split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2]!.replace(/^"(.*)"$/, "$1");
    page[kv[1]!] = kv[1] === "order" && /^\d+$/.test(value) ? Number(value) : value;
  }
  page.body = body;
  return page;
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".md")).sort().map((n) => join(dir, n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function listJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (dir.endsWith(".json")) {
    try {
      await access(dir);
      return [dir];
    } catch {
      return out;
    }
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJson(full)));
    else if (entry.name.endsWith(".json")) out.push(full);
  }
  return out.sort();
}

/**
 * Reads the content tree. Layout:
 *   taxonomy/*.json, modules/*.json, tasks/*.json, courses/*.json,
 *   moonbridge/places.json, moonbridge/characters.json, moonbridge/episodes/*.json (optional),
 *   moonbridge/daily.json, moonbridge/welcome.json (optional within Moonbridge),
 *   school/homework.json, school/assessments.json, school/pages/*.md (all optional)
 * A file that is not valid JSON is reported with `parseError` instead of data.
 */
export async function loadContentDir(root: string): Promise<{ source: ContentSource; parseErrors: { file: string; message: string }[] }> {
  const parseErrors: { file: string; message: string }[] = [];
  const read = async (folder: string): Promise<SourceFile[]> => {
    const files: SourceFile[] = [];
    for (const full of await listJson(join(root, folder))) {
      const path = relative(root, full);
      try {
        files.push({ path, data: JSON.parse(await readFile(full, "utf8")) });
      } catch (e) {
        parseErrors.push({ file: path, message: (e as Error).message });
      }
    }
    return files;
  };
  const source: ContentSource = {
    taxonomy: await read(FOLDERS.taxonomy),
    modules: await read(FOLDERS.modules),
    taskSets: await read(FOLDERS.taskSets),
    courses: await read(FOLDERS.courses),
    places: await read(FOLDERS.places),
    characters: await read(FOLDERS.characters),
    episodes: await read(FOLDERS.episodes),
    daily: await read(FOLDERS.daily),
    welcome: await read(FOLDERS.welcome),
    schoolHomework: await read(FOLDERS.schoolHomework),
    assessments: await read(FOLDERS.assessments),
    pages: await Promise.all(
      (await listMarkdown(join(root, FOLDERS.pages))).map(async (full) => ({ path: relative(root, full), data: parsePage(basename(full), await readFile(full, "utf8")) })),
    ),
  };
  return { source, parseErrors };
}
