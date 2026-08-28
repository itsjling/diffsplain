import { createElement, type ReactNode } from "react";

type MarkdownBlock =
  | { kind: "code"; code: string; language: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "paragraph"; text: string };

const UNSAFE_HTML =
  /<(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/g;
const FENCE = /^(?:\s{0,3})(`{3,}|~{3,})\s*([^\s]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const UNORDERED_LIST = /^\s*[-+*]\s+(.+)$/;
const ORDERED_LIST = /^\s*\d+[.)]\s+(.+)$/;
const INLINE_TOKEN =
  /(!?\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/;

function stripRawHtml(value: string) {
  return value.replace(UNSAFE_HTML, "").replace(HTML_TAG, "");
}

function safeHref(value: string) {
  try {
    const url = new URL(value, "https://diffsplain.invalid/");
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function appendText(nodes: ReactNode[], value: string) {
  const parts = value.split("\n");
  parts.forEach((part, index) => {
    if (index) nodes.push(<br key={`break-${nodes.length}`} />);
    if (part) nodes.push(part);
  });
}

// fallow-ignore-next-line complexity -- This maps the allowed inline grammar without rendering raw HTML.
function inlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const text = stripRawHtml(value);
  const tokenPattern = new RegExp(INLINE_TOKEN.source, "g");
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    appendText(nodes, text.slice(index, match.index));
    const [token, imageOrLink, label, href, code, strongA, strongB, emA, emB] =
      match;
    const key = `token-${nodes.length}`;
    if (imageOrLink) {
      if (imageOrLink.startsWith("!")) {
        appendText(nodes, stripRawHtml(label ?? ""));
      } else {
        const safe = safeHref(href ?? "");
        const children = inlineMarkdown(label ?? "");
        nodes.push(
          safe ? (
            <a href={safe} key={key} rel="noreferrer" target="_blank">
              {children}
            </a>
          ) : (
            <span key={key}>{children}</span>
          ),
        );
      }
    } else if (code !== undefined) {
      nodes.push(<code key={key}>{code}</code>);
    } else if (strongA !== undefined || strongB !== undefined) {
      nodes.push(<strong key={key}>{inlineMarkdown(strongA ?? strongB)}</strong>);
    } else if (emA !== undefined || emB !== undefined) {
      nodes.push(<em key={key}>{inlineMarkdown(emA ?? emB)}</em>);
    } else {
      appendText(nodes, token);
    }
    index = match.index + token.length;
  }
  appendText(nodes, text.slice(index));
  return nodes;
}

// fallow-ignore-next-line complexity -- This owns the deliberately small safe Markdown block grammar.
function blocksFromMarkdown(markdown: string): MarkdownBlock[] {
  // Code fences render as text through React, so keep their source intact. The
  // inline renderer strips raw HTML from every other Markdown block.
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const closing = fence[1];
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(closing)) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        code: code.join("\n"),
        language: fence[2] ?? "",
      });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }

    const unordered = line.match(UNORDERED_LIST);
    const ordered = line.match(ORDERED_LIST);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const next = orderedList
          ? lines[index].match(ORDERED_LIST)
          : lines[index].match(UNORDERED_LIST);
        if (!next) break;
        items.push(next[1]);
        index += 1;
      }
      blocks.push({ kind: "list", items, ordered: orderedList });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (
        !next.trim() ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        /^\s*>/.test(next) ||
        UNORDERED_LIST.test(next) ||
        ORDERED_LIST.test(next) ||
        /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(next)
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

// fallow-ignore-next-line complexity -- This exhaustively maps the closed Markdown block union to React elements.
function blockNode(block: MarkdownBlock, index: number) {
  const key = `block-${index}`;
  if (block.kind === "code") {
    return (
      <pre key={key} data-language={block.language || undefined}>
        <code>{block.code}</code>
      </pre>
    );
  }
  if (block.kind === "heading") {
    return createElement(
      `h${block.level}`,
      { key },
      inlineMarkdown(block.text),
    );
  }
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-item-${itemIndex}`}>{inlineMarkdown(item)}</li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "quote") {
    return <blockquote key={key}>{inlineMarkdown(block.text)}</blockquote>;
  }
  if (block.kind === "rule") return <hr key={key} />;
  return <p key={key}>{inlineMarkdown(block.text)}</p>;
}

export function SafeMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="safe-markdown">
      {blocksFromMarkdown(markdown).map(blockNode)}
    </div>
  );
}
