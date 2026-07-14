import fs from "node:fs";

export function readJsonlTail(file, cursor = null, { startAtEnd = true } = {}) {
  if (!fs.existsSync(file)) {
    return {
      rows: [],
      cursor,
      initialized: false,
      missing: true,
      bytesRead: 0,
      parseErrors: 0,
      rotated: false,
      truncated: false
    };
  }

  const stat = fs.statSync(file);
  const identity = { dev: String(stat.dev), ino: String(stat.ino) };
  if (!cursor?.initialized) {
    return {
      rows: [],
      cursor: {
        initialized: true,
        ...identity,
        offset: startAtEnd ? stat.size : 0,
        partial: "",
        initializedAt: new Date().toISOString()
      },
      initialized: true,
      missing: false,
      bytesRead: 0,
      parseErrors: 0,
      rotated: false,
      truncated: false
    };
  }

  const rotated = cursor.dev !== identity.dev || cursor.ino !== identity.ino;
  const priorOffset = rotated ? 0 : nonNegativeOffset(cursor.offset);
  const truncated = !rotated && stat.size < priorOffset;
  const offset = truncated ? 0 : priorOffset;
  const partial = rotated || truncated ? "" : String(cursor.partial ?? "");
  if (stat.size === offset) {
    return {
      rows: [],
      cursor: { ...cursor, ...identity, offset, partial },
      initialized: false,
      missing: false,
      bytesRead: 0,
      parseErrors: 0,
      rotated,
      truncated
    };
  }

  const bytesRead = stat.size - offset;
  const buffer = Buffer.allocUnsafe(bytesRead);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesRead, offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = partial + buffer.toString("utf8");
  const lines = text.split(/\r?\n/u);
  const nextPartial = text.endsWith("\n") ? "" : lines.pop() ?? "";
  const rows = [];
  let parseErrors = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  return {
    rows,
    cursor: {
      ...cursor,
      ...identity,
      initialized: true,
      offset: stat.size,
      partial: nextPartial,
      lastReadAt: new Date().toISOString()
    },
    initialized: false,
    missing: false,
    bytesRead,
    parseErrors,
    rotated,
    truncated
  };
}

function nonNegativeOffset(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
