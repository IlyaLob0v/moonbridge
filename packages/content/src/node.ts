// Node-only helpers (filesystem, hashing). Kept out of index.ts so the browser
// client can import the validator and types without pulling in node: modules.
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
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
} as const;

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
 *   moonbridge/daily.json, moonbridge/welcome.json (optional within Moonbridge)
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
  };
  return { source, parseErrors };
}
