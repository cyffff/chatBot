export function splitMarkdownTableRow(source) {
  let line = source.trim();
  if (line.startsWith("|")) line = line.slice(1);
  if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);

  const cells = [];
  let cell = "";
  let escaped = false;
  let inlineCode = false;
  for (const character of line) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      inlineCode = !inlineCode;
      cell += character;
      continue;
    }
    if (character === "|" && !inlineCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

export function markdownTableDefinition(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return null;
  const headers = splitMarkdownTableRow(lines[index]);
  const delimiters = splitMarkdownTableRow(lines[index + 1]);
  if (headers.length < 2 || headers.length !== delimiters.length) return null;
  if (!delimiters.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return {
    headers,
    alignments: delimiters.map((cell) => {
      if (cell.startsWith(":") && cell.endsWith(":")) return "center";
      if (cell.endsWith(":")) return "right";
      return "left";
    })
  };
}
