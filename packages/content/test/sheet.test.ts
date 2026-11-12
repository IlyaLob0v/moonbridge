import { strToU8, zipSync } from "fflate";
import { mkdtemp, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateContent, type ContentSource, type ValidatedContent } from "../src/index.js";
import { loadContentDir } from "../src/node.js";
import { checkSheet, contentToSheet, googleExportUrl, readXlsx, shuffledTokens, writeXlsx, SHEETS, type Workbook } from "../src/sheet/index.js";
import { prettyJson, writeSheetToDir } from "../src/sheet/files.js";

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;
const FIXTURE_DIR = new URL("./fixtures/content", import.meta.url).pathname;

async function load(dir: string): Promise<{ source: ContentSource; content: ValidatedContent }> {
  const { source } = await loadContentDir(dir);
  return { source, content: validateContent(source).content! };
}

/** Content without the "$schema" pointers of the hand-written files, which are not content. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x: unknown) => (k === "$schema" ? undefined : x)));
const byId = <T extends { module_id: string }>(list: T[]) => plain([...list].sort((a, b) => a.module_id.localeCompare(b.module_id)));

/** The sheet as the teacher downloads it, through real .xlsx bytes. */
async function sheetOf(dir: string): Promise<{ source: ContentSource; content: ValidatedContent; book: Workbook }> {
  const { source, content } = await load(dir);
  const { book, layout } = contentToSheet(content);
  return { source, content, book: readXlsx(writeXlsx(book, layout)) };
}

/** Sets a cell by column header in the first row matching `where`. */
function edit(book: Workbook, sheet: string, where: (cell: (col: string) => string) => boolean, col: string, value: string): number {
  const rows = book[sheet]!;
  const header = rows[0]!;
  const i = rows.findIndex((r, n) => n > 0 && where((c) => r[header.indexOf(c)] ?? ""));
  if (i < 1) throw new Error(`no row in ${sheet}`);
  let at = header.indexOf(col);
  if (at === -1) {
    header.push(col);
    at = header.length - 1;
  }
  rows[i]![at] = value;
  return i + 1;
}

const errors = (r: { issues: { severity: string; where: string; message: string }[] }) => r.issues.filter((i) => i.severity === "error");

describe("the content sheet", () => {
  it.each([
    ["the live course", CONTENT_DIR],
    ["the test fixture", FIXTURE_DIR],
  ])("gives %s back unchanged after a download and an import", async (_name, dir) => {
    const { source, content, book } = await sheetOf(dir);
    const result = checkSheet(book, source);
    expect(errors(result)).toEqual([]);
    expect(byId(result.content!.modules)).toEqual(byId(content.modules));
    expect(byId(result.content!.taskSets)).toEqual(byId(content.taskSets));
    expect(result.content!.courses.map((c) => c.units)).toEqual(content.courses.map((c) => c.units));
    const sorted = <T>(list: T[], id: (t: T) => string) => plain([...list].sort((a, b) => id(a).localeCompare(id(b))));
    expect(sorted(result.content!.moonbridge!.episodes, (e) => e.episode_id)).toEqual(sorted(content.moonbridge!.episodes, (e) => e.episode_id));
    expect(sorted(result.content!.moonbridge!.places, (p) => p.place_id)).toEqual(sorted(content.moonbridge!.places, (p) => p.place_id));
    // Taxonomy, characters and guests are not in the sheet: they come from the repository.
    expect(result.content!.moonbridge!.characters).toEqual(content.moonbridge!.characters);
  });

  it("takes a new task written the short way: id without the unit, letters for options, Russian words for types", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    const header = book[SHEETS.tasks]![0]!;
    const row = header.map(() => "");
    const set = (col: string, v: string) => (row[header.indexOf(col)] = v);
    set("юнит", "A1_NiceToMeetYou_01");
    set("задание", "goodnight");
    set("понятие", "greetings.meeting");
    set("тип", "Выбор");
    set("текст задания", "It's late. Rocco says: Good night!");
    set("вариант a", "Good night, Rocco.");
    set("вариант b", "Good morning, Rocco.");
    set("верные ответы", "a");
    set("ошибка 1", "b");
    set("тип ошибки 1", "Не то слово");
    set("пояснение 1", "Поздно вечером говорят good night.");
    book[SHEETS.tasks]!.push(row);

    const result = checkSheet(book, source);
    expect(errors(result)).toEqual([]);
    const task = result.content!.taskSets[0]!.tasks.find((t) => t.task_id === "A1_NiceToMeetYou_01_goodnight")!;
    expect(task.type).toBe("choice");
    expect(task.presentation.options).toEqual([
      { id: "a", text: "Good night, Rocco." },
      { id: "b", text: "Good morning, Rocco." },
    ]);
    expect(task.answer.known_errors).toEqual([{ match: ["b"], error_type: "lexis.wrong_word", feedback: "Поздно вечером говорят good night." }]);
    expect(result.content!.modules[0]!.tasks).toContain("A1_NiceToMeetYou_01_goodnight");
  });

  it("builds order-words tokens from the answer when the cell is empty, never in answer order", async () => {
    const tokens = shuffledTokens("Where are you from?", "x_1");
    expect([...tokens].sort()).toEqual(["Where", "are", "from", "you"].sort());
    expect(tokens.join(" ")).not.toBe("Where are you from");
    expect(shuffledTokens("Where are you from?", "x_1")).toEqual(tokens);

    const { source, book } = await sheetOf(CONTENT_DIR);
    edit(book, SHEETS.tasks, (c) => c("тип") === "порядок слов", "слова", "");
    const result = checkSheet(book, source);
    expect(errors(result)).toEqual([]);
  });

  it("finds the wrong word of find_error by the word itself, and asks for a number when it repeats", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    const n = edit(book, SHEETS.tasks, (c) => c("задание") === "find_error" && c("юнит") === "A1_NightCafe_04", "верные ответы", "a");
    const result = checkSheet(book, source);
    expect(errors(result)).toEqual([{ severity: "error", where: `${SHEETS.tasks}, строка ${n}`, message: "слово «a» встречается во фразе несколько раз: укажите его номер" }]);
  });

  it("says in Russian what is wrong and on which row", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    const typeRow = edit(book, SHEETS.tasks, (c) => c("задание") === "hello", "тип", "выборр");
    const conceptRow = edit(book, SHEETS.tasks, (c) => c("задание") === "too", "понятие", "greetings.nope");
    const stepRow = edit(book, SHEETS.episodes, (c) => c("шаг") === "greet", "если неверно", "nowhere");
    const result = checkSheet(book, source);
    expect(result.ok).toBe(false);
    expect(errors(result)).toEqual([
      expect.objectContaining({ where: `${SHEETS.tasks}, строка ${typeRow}`, message: expect.stringMatching(/^тип «выборр» не знаком/) }),
    ]);
    // Once the row-level problems are fixed, the content checks point at rows too.
    edit(book, SHEETS.tasks, (c) => c("задание") === "hello", "тип", "выбор");
    const second = checkSheet(book, source);
    expect(errors(second)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: `${SHEETS.tasks}, строка ${conceptRow}`, message: expect.stringContaining("такого понятия у юнита нет") }),
        expect.objectContaining({ where: `${SHEETS.episodes}, строка ${stepRow}`, message: expect.stringContaining("шага с таким именем в эпизоде нет") }),
      ]),
    );
  });

  it("names a missing sheet or column instead of guessing", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    delete book[SHEETS.places];
    book[SHEETS.tasks]![0] = book[SHEETS.tasks]![0]!.map((h) => (h === "верные ответы" ? "ответы" : h));
    expect(errors(checkSheet(book, source))).toEqual([
      { severity: "error", where: SHEETS.tasks, message: "нет колонок: «верные ответы»" },
      { severity: "error", where: SHEETS.places, message: `в таблице нет листа «${SHEETS.places}»` },
    ]);
  });

  it("raises the version of a unit whose content changed, and only of that unit", async () => {
    const { source, content, book } = await sheetOf(CONTENT_DIR);
    edit(book, SHEETS.tasks, (c) => c("задание") === "she_is", "подсказка", "she → is");
    const live = { modules: content.modules, tasks: content.taskSets.flatMap((s) => s.tasks) };
    const result = checkSheet(book, source, live);
    const version = (id: string) => result.content!.modules.find((m) => m.module_id === id)!.version;
    const before = (id: string) => content.modules.find((m) => m.module_id === id)!.version;
    expect(version("A1_WhereAreYouFrom_02")).toBe(before("A1_WhereAreYouFrom_02") + 1);
    expect(version("A1_NiceToMeetYou_01")).toBe(before("A1_NiceToMeetYou_01"));
  });

  it("sets the course's unit order by the order of rows", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    const rows = book[SHEETS.units]!;
    [rows[3], rows[4]] = [rows[4]!, rows[3]!];
    const result = checkSheet(book, source);
    // Unit 4 needs unit 3: the validator refuses the swap.
    expect(errors(result)).toEqual([expect.objectContaining({ where: `${SHEETS.units}, строка 4`, message: expect.stringContaining("юнит стоит раньше юнита, который для него нужен") })]);
  });

  it("reads workbooks the way Google Sheets and Excel write them: shared strings, numbers, sparse rows", () => {
    const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const file = zipSync({
      "xl/workbook.xml": xml(`<workbook ${NS}><sheets><sheet name="Юниты" sheetId="1" r:id="rId7"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet7.xml"/></Relationships>',
      ),
      "xl/sharedStrings.xml": xml(
        `<sst ${NS}><si><t>юнит</t></si><si><r><t>порог </t></r><r><rPr><b/></rPr><t>проверки</t></r></si><si><t xml:space="preserve">Tom &amp; Jerry&#10;line 2</t></si></sst>`,
      ),
      "xl/worksheets/sheet7.xml": xml(
        `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>0.80000000000000004</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="inlineStr"><is><t>да</t></is></c></row></sheetData></worksheet>`,
      ),
    });
    expect(readXlsx(file)).toEqual({ Юниты: [["юнит", "", "порог проверки"], [], ["Tom & Jerry\nline 2", "", "0.8", "TRUE", "да"]] });
    expect(() => readXlsx(strToU8("not a zip"))).toThrow("это не файл Excel");
  });

  it("knows a Google Sheets link", () => {
    expect(googleExportUrl("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0")).toBe(
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=xlsx",
    );
    expect(googleExportUrl("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit")).toBeUndefined();
    expect(googleExportUrl("http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit")).toBeUndefined();
    expect(googleExportUrl("не ссылка")).toBeUndefined();
  });

  it("writes an imported sheet into the content folder as the same files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moonbridge-content-"));
    try {
      await cp(CONTENT_DIR, dir, { recursive: true });
      const { source, book } = await sheetOf(dir);
      const result = checkSheet(book, source);
      const written = await writeSheetToDir(dir, result.sheet!);
      expect(written).toContain("modules/A1_NiceToMeetYou_01.json");
      // The repository's files are kept in the importer's format: importing again changes nothing.
      // ($schema points back into this package from wherever the folder is.)
      const text = async (root: string, f: string) => (await readFile(join(root, f), "utf8")).replace(/"\$schema": "[^"]*"/, "");
      for (const f of written) expect(await text(dir, f)).toBe(await text(CONTENT_DIR, f));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps short JSON values on one line without touching the text inside strings", () => {
    const value = { a: ["x, 1", "y:2"], b: { c: "room 13,14" } };
    expect(prettyJson(value)).toBe('{ "a": ["x, 1", "y:2"], "b": { "c": "room 13,14" } }\n');
    expect(JSON.parse(prettyJson(value, 10))).toEqual(value);
  });
});

describe("the words sheet", () => {
  it("reads a new word with its example into its unit", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    book[SHEETS.words]!.push(["A1_NightCafe_04", "a glass of water", "стакан воды", "Can I have a glass of water, please?"]);
    const result = checkSheet(book, source);
    expect(errors(result)).toEqual([]);
    const words = result.content!.modules.find((m) => m.module_id === "A1_NightCafe_04")!.words!;
    expect(words.at(-1)).toEqual({ en: "a glass of water", ru: "стакан воды", example: "Can I have a glass of water, please?" });
  });

  it("says which row repeats a word or misses a translation", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    const first = book[SHEETS.words]![1]!;
    book[SHEETS.words]!.push([first[0]!, first[1]!.toUpperCase(), "дубль"], ["A1_NightCafe_04", "napkin", ""]);
    const rows = book[SHEETS.words]!.length;
    const messages = errors(checkSheet(book, source)).map((i) => `${i.where}: ${i.message}`);
    expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`строка ${rows - 1}: слово .* уже есть выше`)), `${SHEETS.words}, строка ${rows}: нужно слово по-английски и перевод`]));
  });

  it("publishes an older sheet without the words sheet, with a warning", async () => {
    const { source, book } = await sheetOf(CONTENT_DIR);
    delete book[SHEETS.words];
    const result = checkSheet(book, source);
    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: "warning", where: SHEETS.words }));
    expect(result.content!.modules.every((m) => m.words === undefined)).toBe(true);
  });
});
