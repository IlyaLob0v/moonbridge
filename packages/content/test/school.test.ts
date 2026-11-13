import { describe, expect, it } from "vitest";
import { renderMarkdown, validateContent, type ContentSource } from "../src/index.js";
import { buildBundle, loadContentDir, parsePage } from "../src/node.js";

// The school's texts and forms: pages, file homework with criteria, the tests and the survey.

const CONTENT_DIR = new URL("../../../content", import.meta.url).pathname;

async function load(): Promise<ContentSource> {
  const { source, parseErrors } = await loadContentDir(CONTENT_DIR);
  expect(parseErrors).toEqual([]);
  return structuredClone(source);
}
const issues = (src: ContentSource, severity: "error" | "warning") =>
  validateContent(src).issues.filter((i) => i.severity === severity).map((i) => i.code);
const assessments = (src: ContentSource) => (src.assessments![0]!.data as any).assessments as any[];

describe("the school content in /content", () => {
  it("has the legal pages with editions, the help, the rubrics and the tests", async () => {
    const school = buildBundle(validateContent(await load()).content!).school!;
    const ids = school.pages.map((p) => p.page_id);
    for (const id of ["privacy", "terms", "consent", "parent-consent", "student-guide", "faq", "teacher-guide"]) expect(ids).toContain(id);
    for (const p of school.pages.filter((x) => ["privacy", "terms", "consent", "parent-consent"].includes(x.page_id))) expect(p.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(school.rubrics.map((r) => r.rubric_id)).toEqual(expect.arrayContaining(["voice", "writing"]));
    expect(school.homework_prompts.every((p) => school.rubrics.some((r) => r.rubric_id === p.rubric_id))).toBe(true);
    const entry = school.assessments.find((a) => a.assessment_id === "entry");
    expect(entry?.kind).toBe("test");
    expect(school.assessments.some((a) => a.kind === "survey")).toBe(true);
  });
});

describe("checks", () => {
  it("a legal page needs its edition date", async () => {
    const src = await load();
    const terms = src.pages!.find((f) => (f.data as any).page_id === "terms")!;
    delete (terms.data as any).version;
    expect(issues(src, "error")).toContain("page.version");
  });

  it("a test task's answer is checked like any task, and a hint is only a warning", async () => {
    const src = await load();
    const task = assessments(src).find((a) => a.kind === "test").tasks[0];
    task.presentation.hint = "Подсказка";
    expect(issues(src, "warning")).toContain("test.hint");
    const pair = assessments(src).find((a) => a.pair);
    pair.pair = "nowhere";
    expect(issues(src, "error")).toContain("ref.pair");
  });

  it("a choice question needs options", async () => {
    const src = await load();
    const survey = assessments(src).find((a) => a.kind === "survey");
    survey.questions.push({ id: "extra", kind: "choice", text: "?" });
    expect(issues(src, "error")).toContain("survey.options");
  });

  it("a prompt of a unit that is gone is a warning, not an error", async () => {
    const src = await load();
    const prompts = (src.schoolHomework![0]!.data as any).prompts as any[];
    prompts[0].module_id = "A1_Gone_99";
    const v = validateContent(src);
    expect(v.ok).toBe(true);
    expect(v.issues.filter((i) => i.severity === "warning").map((i) => i.code)).toContain("ref.module");
  });
});

describe("pages", () => {
  it("reads the header and the body", () => {
    const p = parsePage("terms.md", "---\ntitle: \"Договор\"\nversion: 2026-11-13\norder: 3\n---\n\n# Раздел\nТекст.\n");
    expect(p).toMatchObject({ page_id: "terms", title: "Договор", version: "2026-11-13", order: 3, body: "# Раздел\nТекст." });
  });

  it("renders a small, safe Markdown", () => {
    const html = renderMarkdown("# Раздел\n\nТекст **жирный** и *курсив*.\n\n- один\n- два\n\n1. первый\n\n> цитата\n\n[помощь](/help/faq) [сайт](https://example.com)");
    expect(html).toContain("<h2>Раздел</h2>");
    expect(html).toContain("<b>жирный</b>");
    expect(html).toContain("<i>курсив</i>");
    expect(html).toContain("<ul><li>один</li><li>два</li></ul>");
    expect(html).toContain("<ol><li>первый</li></ol>");
    expect(html).toContain("<blockquote>цитата</blockquote>");
    expect(html).toContain('<a href="/help/faq" data-link="">помощь</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener">сайт</a>');
  });

  it("never lets a script or an unsafe link through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](//evil.example) <img src=x onerror="a">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("&lt;script&gt;");
  });
});
