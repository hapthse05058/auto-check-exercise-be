// Google Doc id helpers. A student is identified by their doc id, not by the raw
// link: the same document yields many URLs once "/edit", "?tab=…" or
// "&usp=sharing" are appended. Pure, no IO — mirrors the frontend's
// src/lib/googleDoc.js so both sides dedupe students the same way.

/** Extracts the document id from a Google Docs URL, or "" when there is none. */
function extractDocId(url) {
  return String(url || "").match(/\/document\/d\/([a-zA-Z0-9_-]+)/)?.[1] || "";
}

/**
 * Finds Google Docs claimed by more than one student.
 *
 * @param candidates {{name?:string, ggDocLink?:string}[]} students about to be created
 * @param existing   {{name?:string, ggDocLink?:string}[]} students already in the class
 * @returns {{docId:string, names:string[]}[]} one entry per clashing doc, with
 *          every name attached to it (existing first), empty when all is well.
 */
function findDuplicateDocs(candidates = [], existing = []) {
  const holders = new Map(); // docId -> names
  for (const student of existing) {
    const docId = extractDocId(student?.ggDocLink);
    if (!docId) continue;
    if (!holders.has(docId)) holders.set(docId, []);
    holders.get(docId).push(student?.name || "");
  }

  const duplicates = new Map(); // docId -> names
  for (const candidate of candidates) {
    const docId = extractDocId(candidate?.ggDocLink);
    if (!docId) continue; // not a Google Doc link → nothing to compare
    const names = holders.get(docId);
    if (!names) {
      holders.set(docId, [candidate?.name || ""]);
      continue;
    }
    if (!duplicates.has(docId)) duplicates.set(docId, [...names]);
    const clash = duplicates.get(docId);
    const name = candidate?.name || "";
    if (name && !clash.includes(name)) clash.push(name);
  }

  return [...duplicates].map(([docId, names]) => ({ docId, names }));
}

module.exports = { extractDocId, findDuplicateDocs };
