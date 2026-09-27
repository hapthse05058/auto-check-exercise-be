/**
 * HS docs for backend tests: the blank HS form (tests/fixtures/hs), a student
 * typing into it, and a Docs batchUpdate simulator for the requests
 * lib/doc/hsDoc.js sends (insertText without "\n", updateTextStyle,
 * createNamedRange, deleteContentRange inside a paragraph, deleteNamedRange)
 * — every index after an edit shifts, named ranges move with the text.
 *
 * A CommonJS port of the website's tests/helpers/fakeDocs.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const BLANK = path.join(__dirname, "..", "fixtures", "hs", "blank.json.gz");
let blankCache = null;

/** A fresh copy of the blank HS form (all 26 tabs). */
function blankHsDoc() {
  blankCache ??= zlib.gunzipSync(fs.readFileSync(BLANK)).toString("utf8");
  return JSON.parse(blankCache);
}

function allTabs(tabs, out = []) {
  for (const t of tabs || []) {
    out.push(t);
    allTabs(t.childTabs, out);
  }
  return out;
}

const tabById = (doc, tabId) =>
  allTabs(doc.tabs).find((t) => t.tabProperties.tabId === tabId);
const tabByTitle = (doc, title) =>
  allTabs(doc.tabs).find((t) => t.tabProperties.title === title);

function indexedNodes(tab) {
  const out = [];
  const walk = (content) => {
    for (const b of content || []) {
      out.push(b);
      if (b.paragraph) out.push(...(b.paragraph.elements || []));
      if (b.table) {
        for (const row of b.table.tableRows) {
          out.push(row);
          for (const cell of row.tableCells) {
            out.push(cell);
            walk(cell.content);
          }
        }
      }
    }
  };
  walk(tab.documentTab.body.content);
  return out;
}

function paragraphs(tab) {
  const out = [];
  const walk = (content) => {
    for (const b of content || []) {
      if (b.paragraph) out.push(b);
      if (b.table) {
        for (const row of b.table.tableRows) {
          for (const cell of row.tableCells) walk(cell.content);
        }
      }
    }
  };
  walk(tab.documentTab.body.content);
  return out;
}

function splitAt(para, index) {
  const els = para.paragraph.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el.textRun) continue;
    if (index > el.startIndex && index < el.endIndex) {
      const cut = index - el.startIndex;
      const left = {
        ...el,
        endIndex: index,
        textRun: { ...el.textRun, content: el.textRun.content.slice(0, cut) },
      };
      const right = {
        ...el,
        startIndex: index,
        textRun: {
          ...el.textRun,
          textStyle: el.textRun.textStyle
            ? { ...el.textRun.textStyle }
            : undefined,
          content: el.textRun.content.slice(cut),
        },
      };
      els.splice(i, 1, left, right);
      return;
    }
  }
}

const paragraphAt = (tab, index) =>
  paragraphs(tab).find((p) => index >= p.startIndex && index < p.endIndex);

function rangesOf(tab) {
  const out = [];
  for (const group of Object.values(tab.documentTab.namedRanges || {})) {
    for (const nr of group.namedRanges || []) out.push(...(nr.ranges || []));
  }
  return out;
}

function insertText(tab, { location: { index }, text }) {
  if (text.includes("\n")) throw new Error("hsDocs: \\n insert unsupported");
  const para = paragraphAt(tab, index);
  if (!para) throw new Error(`hsDocs: no paragraph at ${index}`);
  const len = text.length;
  splitAt(para, index);
  for (const node of indexedNodes(tab)) {
    if (node.startIndex === undefined) continue;
    if (node.startIndex >= index && node !== para) {
      node.startIndex += len;
      node.endIndex += len;
    } else if (node.endIndex > index) {
      node.endIndex += len;
    }
  }
  for (const r of rangesOf(tab)) {
    if (r.startIndex >= index) {
      r.startIndex += len;
      r.endIndex += len;
    } else if (r.endIndex > index) {
      r.endIndex += len;
    }
  }
  const els = para.paragraph.elements;
  let at = els.findIndex((el) => el.startIndex === index + len);
  if (at < 0) at = els.length;
  const prev = els[at - 1];
  const style = prev?.textRun?.textStyle
    ? { ...prev.textRun.textStyle }
    : undefined;
  els.splice(at, 0, {
    startIndex: index,
    endIndex: index + len,
    textRun: { content: text, ...(style ? { textStyle: style } : {}) },
  });
}

function updateTextStyle(tab, { range, textStyle, fields }) {
  const names = fields.split(",").map((f) => f.trim());
  for (const para of paragraphs(tab)) {
    if (para.endIndex <= range.startIndex || para.startIndex >= range.endIndex)
      continue;
    splitAt(para, range.startIndex);
    splitAt(para, range.endIndex);
    for (const el of para.paragraph.elements) {
      if (!el.textRun) continue;
      if (el.startIndex >= range.startIndex && el.endIndex <= range.endIndex) {
        const style = { ...(el.textRun.textStyle || {}) };
        for (const f of names) {
          if (textStyle[f] === undefined || textStyle[f] === false)
            delete style[f];
          else style[f] = textStyle[f];
        }
        el.textRun.textStyle = style;
      }
    }
  }
}

let rangeSeq = 0;
function createNamedRange(tab, { name, range }) {
  const named = (tab.documentTab.namedRanges ||= {});
  const group = (named[name] ||= { name, namedRanges: [] });
  group.namedRanges.push({
    namedRangeId: `nr.${++rangeSeq}`,
    name,
    ranges: [
      {
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        tabId: range.tabId,
      },
    ],
  });
}

/** Applies batchUpdate requests to `doc` in place, like the Docs API. */
function applyHsRequests(doc, requests) {
  for (const request of requests) {
    const [kind, body] = Object.entries(request)[0];
    const tabId = body.location?.tabId ?? body.range?.tabId;
    const tab = tabById(doc, tabId);
    if (!tab) throw new Error(`hsDocs: no tab ${tabId}`);
    if (kind === "insertText") insertText(tab, body);
    else if (kind === "updateTextStyle") updateTextStyle(tab, body);
    else if (kind === "createNamedRange") createNamedRange(tab, body);
    else throw new Error(`hsDocs: unsupported request ${kind}`);
  }
  return doc;
}

const paraText = (para) =>
  para.paragraph.elements.map((e) => e.textRun?.content ?? "").join("");

function findParagraph(tab, prefix, nth = 0) {
  const hits = paragraphs(tab).filter((p) => paraText(p).startsWith(prefix));
  if (!hits[nth]) throw new Error(`hsDocs: no paragraph "${prefix}" #${nth}`);
  return hits[nth];
}

const RED = { foregroundColor: { color: { rgbColor: { red: 1 } } } };

/**
 * A student (or teacher) typing `text` into the paragraph starting with
 * `prefix`, right after `after` (or at its end), in `style`.
 */
function typeInto(
  doc,
  tab,
  prefix,
  text,
  { after = null, nth = 0, style } = {},
) {
  const para = findParagraph(tab, prefix, nth);
  const content = paraText(para);
  if (after !== null && content.indexOf(after) < 0) {
    throw new Error(`hsDocs: "${after}" not in "${content}"`);
  }
  const offset =
    after === null ? content.length - 1 : content.indexOf(after) + after.length;
  const index = para.startIndex + offset;
  const tabId = tab.tabProperties.tabId;
  applyHsRequests(doc, [
    { insertText: { location: { index, tabId }, text } },
    {
      updateTextStyle: {
        range: { startIndex: index, endIndex: index + text.length, tabId },
        textStyle: style || {},
        fields: "foregroundColor,bold,underline,strikethrough,backgroundColor",
      },
    },
  ]);
}

/** Buổi 19 Ex2 ("find and correct"): the student answers the first `n` items. */
const B19_ITEMS = [
  ["There is a lamp to the table.", "There is a lamp on the table."],
  ["The children are playing on", "The children are playing in the garden."],
  ["The bus stop is under", "The bus stop is next to the post office."],
  [
    "My house is on the library",
    "My house is between the library and the supermarket.",
  ],
];

function b19Doc(n = B19_ITEMS.length, { teacherTicks = 0 } = {}) {
  const doc = blankHsDoc();
  const tab = tabByTitle(doc, "Buổi 19");
  B19_ITEMS.slice(0, n).forEach(([prefix, answer], i) => {
    typeInto(doc, tab, prefix, answer, { after: "→ " });
    if (i < teacherTicks) typeInto(doc, tab, prefix, " ✅", { style: RED });
  });
  return doc;
}

module.exports = {
  B19_ITEMS,
  RED,
  applyHsRequests,
  b19Doc,
  blankHsDoc,
  findParagraph,
  paraText,
  tabById,
  tabByTitle,
  typeInto,
};
