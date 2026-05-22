/**
 * Convert submission-memo.md (or any markdown file) to a .docx using the
 * `docx` npm package. Run via: node scripts/md-to-docx.mjs <input.md> <output.docx>
 *
 * Supports: headings (#–######), paragraphs, bold (**), italic (*), inline
 * code (`), bullet lists (- / *), numbered lists (1.), tables (GFM pipe),
 * blockquotes, horizontal rules. Not pretty for everything but good
 * enough for the memo.
 */

import fs from "node:fs";
import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from "docx";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node scripts/md-to-docx.mjs <input.md> <output.docx>");
  process.exit(1);
}

const md = fs.readFileSync(path.resolve(inPath), "utf-8");
const lines = md.split(/\r?\n/);

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/** Parse a string of inline markdown into an array of TextRun specs. */
function parseInline(text) {
  // Order matters: bold (**) before italic (*).
  // We tokenise by walking the string and tracking open delimiters.
  const tokens = [];
  let i = 0;
  let buffer = "";
  let bold = false;
  let italic = false;
  let code = false;

  const flush = () => {
    if (buffer) {
      tokens.push({ text: buffer, bold, italic, code });
      buffer = "";
    }
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (c === "`" && !bold && !italic) {
      flush();
      code = !code;
      i += 1;
      continue;
    }
    if (!code && c === "*" && next === "*") {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (!code && c === "*") {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    // Handle markdown links [text](url) — strip to just text
    if (!code && c === "[") {
      const closeBr = text.indexOf("]", i);
      const openPa = text.indexOf("(", closeBr);
      const closePa = text.indexOf(")", openPa);
      if (
        closeBr > i &&
        openPa === closeBr + 1 &&
        closePa > openPa
      ) {
        flush();
        const linkText = text.slice(i + 1, closeBr);
        tokens.push({ text: linkText, bold, italic, code });
        i = closePa + 1;
        continue;
      }
    }
    buffer += c;
    i += 1;
  }
  flush();

  return tokens.map(
    (t) =>
      new TextRun({
        text: t.text,
        bold: t.bold,
        italics: t.italic,
        font: t.code ? "Consolas" : undefined,
      }),
  );
}

/** Parse a table block (array of lines starting with |) into a Table node. */
function parseTable(blockLines) {
  // First row is header. Second row is separator. Remaining are body.
  const splitRow = (line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = splitRow(blockLines[0]);
  const body = blockLines.slice(2).map(splitRow);

  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
  };

  const makeRow = (cells, isHeader) =>
    new TableRow({
      children: cells.map(
        (text) =>
          new TableCell({
            borders: cellBorder,
            children: [
              new Paragraph({
                children: parseInline(text).map((r) =>
                  isHeader
                    ? new TextRun({ ...r.options, bold: true })
                    : r,
                ),
              }),
            ],
          }),
      ),
    });

  return new Table({
    rows: [makeRow(header, true), ...body.map((r) => makeRow(r, false))],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

const children = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];

  // Blank line → skip
  if (line.trim() === "") {
    i += 1;
    continue;
  }

  // Horizontal rule
  if (/^---+$/.test(line.trim())) {
    children.push(
      new Paragraph({
        children: [new TextRun("")],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC" } },
      }),
    );
    i += 1;
    continue;
  }

  // Heading
  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    children.push(
      new Paragraph({
        heading: HEADING_LEVELS[level],
        children: parseInline(headingMatch[2]),
      }),
    );
    i += 1;
    continue;
  }

  // Table
  if (line.trim().startsWith("|") && lines[i + 1]?.trim().startsWith("|")) {
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      block.push(lines[i]);
      i += 1;
    }
    if (block.length >= 2) {
      children.push(parseTable(block));
      // Spacer paragraph after table for visual separation
      children.push(new Paragraph({ children: [new TextRun("")] }));
    }
    continue;
  }

  // Blockquote
  if (line.startsWith(">")) {
    const text = line.replace(/^>\s?/, "");
    children.push(
      new Paragraph({
        children: parseInline(text),
        indent: { left: 360 },
        spacing: { before: 100, after: 100 },
      }),
    );
    i += 1;
    continue;
  }

  // Unordered list
  if (/^\s*[-*]\s+/.test(line)) {
    const text = line.replace(/^\s*[-*]\s+/, "");
    children.push(
      new Paragraph({
        children: parseInline(text),
        bullet: { level: 0 },
      }),
    );
    i += 1;
    continue;
  }

  // Ordered list
  const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
  if (orderedMatch) {
    children.push(
      new Paragraph({
        children: parseInline(orderedMatch[1]),
        numbering: { reference: "default-numbering", level: 0 },
      }),
    );
    i += 1;
    continue;
  }

  // Default: paragraph (collect contiguous non-blank, non-special lines)
  const paraLines = [line];
  let j = i + 1;
  while (
    j < lines.length &&
    lines[j].trim() !== "" &&
    !/^#{1,6}\s/.test(lines[j]) &&
    !lines[j].trim().startsWith("|") &&
    !lines[j].startsWith(">") &&
    !/^\s*[-*]\s+/.test(lines[j]) &&
    !/^\s*\d+\.\s+/.test(lines[j]) &&
    !/^---+$/.test(lines[j].trim())
  ) {
    paraLines.push(lines[j]);
    j += 1;
  }
  children.push(
    new Paragraph({
      children: parseInline(paraLines.join(" ")),
      spacing: { after: 200 },
    }),
  );
  i = j;
}

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "default-numbering",
        levels: [
          {
            level: 0,
            format: "decimal",
            text: "%1.",
            alignment: AlignmentType.START,
            style: {
              paragraph: { indent: { left: 720, hanging: 360 } },
            },
          },
        ],
      },
    ],
  },
  sections: [{ children }],
});

const buffer = await Packer.toBuffer(doc);
fs.writeFileSync(path.resolve(outPath), buffer);
console.log(`Wrote ${outPath} (${buffer.length} bytes, ${children.length} blocks)`);
