// The Markdown of school pages (help, FAQ, legal texts) as HTML, for the platform and for the
// pages the gateway serves itself (a parent's consent). A small subset on purpose: headings,
// paragraphs, lists, quotes, **bold**, *italic* and links. Everything is escaped first, so a
// page can never carry a script; links go only to the platform's own paths or to https.

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A link target the page may use: a platform path (/help/faq), https or mailto. */
function safeHref(href: string): string | undefined {
  if (/^\/(?!\/)[\w\-./?=&#%]*$/.test(href)) return href;
  if (/^https:\/\/[^\s"'<>]+$/.test(href)) return href;
  if (/^mailto:[^\s"'<>]+$/.test(href)) return href;
  return undefined;
}

function inline(text: string): string {
  let out = escape(text);
  // Links: [label](target), after escaping (the target's & is &amp; now, which a browser reads back).
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const target = safeHref(href.replace(/&amp;/g, "&"));
    if (!target) return label;
    const external = !target.startsWith("/");
    return `<a href="${escape(target)}"${external ? ' target="_blank" rel="noopener"' : ' data-link=""'}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  return out;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let quote: string[] = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flush = () => (flushPara(), flushList(), flushQuote());
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // A page's own title is its h1 on screen: # in the text is a section, one level down.
      const level = heading[1]!.length + 1;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      flushQuote();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]!);
      continue;
    }
    if (list) {
      // A line under a list item continues it.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flush();
  return html.join("\n");
}
