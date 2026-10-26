const CHUNK = 32768;
const TAG = /^\s*\\\w+(\[.*\])?\{\w+\}(\[.*\])?\s*$/;
const TAG_START = /^\s*\\\w+\s*\{\s*$/;
const TAG_END = /^\s*\}\s*$/;

class Builder {
  constructor(source) {
    this.output = source.subtext(0, 0);
    this.parts = [];
    this.units = 0;
  }
  add(value) {
    if (!value.length) return;
    if (typeof value !== "string" && value.length > CHUNK) {
      this.flush();
      this.output = this.output.replace(this.output.length, this.output.length, value);
      return;
    }
    const text = typeof value === "string" ? value : value.toString();
    this.parts.push(text);
    this.units += text.length;
    if (this.units >= 65536) this.flush();
  }
  flush() {
    if (this.units)
      this.output = this.output.replace(
        this.output.length,
        this.output.length,
        this.parts.join(""),
      );
    this.parts = [];
    this.units = 0;
  }
  finish() {
    this.flush();
    return this.output;
  }
  finishValue() {
    if (this.output.length) return this.finish();
    const text = this.parts.join("");
    this.parts = [];
    this.units = 0;
    return text;
  }
}

async function reflowSource(input, options, { check = () => {}, reflowSmall } = {}) {
  let deadline = performance.now() + 4;
  const pause = async () => {
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      check();
      deadline = performance.now() + 4;
    }
  };
  await new Promise((resolve) => setImmediate(resolve));
  check();
  const normalized = new Builder(input);
  let carry = "",
    consumed = 0,
    lastEmit = 0,
    changed = false;
  for (let offset = 0; offset < input.length; offset += CHUNK) {
    let text = carry + input.slice(offset, Math.min(input.length, offset + CHUNK));
    carry = text.endsWith("\r") ? "\r" : "";
    if (carry) text = text.slice(0, -1);
    const converted = text.replace(/\r\n?/g, "\n");
    if (text !== converted) {
      normalized.add(input.subtext(lastEmit, consumed));
      normalized.add(converted);
      lastEmit = consumed + text.length;
      changed = true;
    }
    consumed += text.length;
    await pause();
  }
  normalized.add(input.subtext(lastEmit, consumed));
  if (carry) normalized.add("\n");
  const source = changed || carry ? normalized.finish() : input;
  const lineEnd = (row) =>
    row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
  const firstNonblank = async (start, end) => {
    for (let offset = start; offset < end; offset += CHUNK) {
      const text = source.slice(offset, Math.min(end, offset + CHUNK)),
        index = text.search(/\S/);
      if (index >= 0) return offset + index;
      await pause();
    }
    return end;
  };
  const lastNonblank = async (start, end) => {
    while (end > start) {
      const offset = Math.max(start, end - CHUNK),
        text = source.slice(offset, end),
        trimmed = text.trimEnd();
      if (trimmed.length) return offset + trimmed.length - 1;
      end = offset;
      await pause();
    }
    return start - 1;
  };
  const equalPrefix = async (start, end, prefix) => {
    if (end - start < prefix.length) return false;
    for (let offset = 0; offset < prefix.length; offset += CHUNK) {
      const size = Math.min(CHUNK, prefix.length - offset);
      if (
        source.slice(start + offset, start + offset + size) !== prefix.slice(offset, offset + size)
      )
        return false;
      await pause();
    }
    return true;
  };
  const tag = async (row, ending) => {
    const start = source.lineStart(row),
      end = lineEnd(row);
    if (end - start <= CHUNK) {
      const text = source.slice(start, end);
      return TAG.test(text) || (ending ? TAG_END : TAG_START).test(text);
    }
    const first = await firstNonblank(start, end),
      code = source.charCodeAt(first);
    if (code !== 92 && !(ending && code === 125)) return false;
    // NFA for the three fixed LaTeX tag expressions. Character-class runs reach
    // a fixed state after a few transitions, including arbitrary bracket text.
    let states = 1 | (ending ? 1 << 16 : 1 << 11);
    const closure = (value) => {
      if (value & (1 << 2)) value |= (1 << 3) | (1 << 5);
      if (value & (1 << 3)) value |= 1 << 5;
      if (value & (1 << 8)) value |= 1 << 10;
      if (value & (1 << 13)) value |= 1 << 14;
      return value;
    };
    const step = (value, character) => {
      value = closure(value);
      const white = /\s/.test(character),
        word = /\w/.test(character),
        dot = !/[\r\n\u2028\u2029]/.test(character);
      let next = 0;
      if (value & 1) {
        if (white) next |= 1;
        if (character === "\\") next |= 1 << 1;
      }
      if (value & (1 << 1) && word) next |= 1 << 2;
      if (value & (1 << 2) && word) next |= 1 << 2;
      if (value & (1 << 3) && character === "[") next |= 1 << 4;
      if (value & (1 << 4)) {
        if (dot) next |= 1 << 4;
        if (character === "]") next |= 1 << 5;
      }
      if (value & (1 << 5) && character === "{") next |= 1 << 6;
      if (value & (1 << 6) && word) next |= 1 << 7;
      if (value & (1 << 7)) {
        if (word) next |= 1 << 7;
        if (character === "}") next |= 1 << 8;
      }
      if (value & (1 << 8) && character === "[") next |= 1 << 9;
      if (value & (1 << 9)) {
        if (dot) next |= 1 << 9;
        if (character === "]") next |= 1 << 10;
      }
      if (value & (1 << 10) && white) next |= 1 << 10;
      if (value & (1 << 11)) {
        if (white) next |= 1 << 11;
        if (character === "\\") next |= 1 << 12;
      }
      if (value & (1 << 12) && word) next |= 1 << 13;
      if (value & (1 << 13) && word) next |= 1 << 13;
      if (value & (1 << 14)) {
        if (white) next |= 1 << 14;
        if (character === "{") next |= 1 << 15;
      }
      if (value & (1 << 15) && white) next |= 1 << 15;
      if (value & (1 << 16)) {
        if (white) next |= 1 << 16;
        if (character === "}") next |= 1 << 17;
      }
      if (value & (1 << 17) && white) next |= 1 << 17;
      return closure(next);
    };
    for (let offset = start; offset < end; offset += CHUNK) {
      const text = source.slice(offset, Math.min(end, offset + CHUNK));
      for (const match of text.matchAll(/\w+|[ \t\v\f]+|[^\w\s\\[\]{}]+|[\s\S]/g)) {
        for (let i = 0; i < match[0].length; i++) {
          const next = step(states, match[0][0]);
          if (next === states) break;
          states = next;
          if (!states) return false;
        }
      }
      await pause();
    }
    return Boolean(states & ((1 << 10) | (ending ? 1 << 17 : 1 << 15)));
  };

  async function* segments(parts, textSource = source) {
    let kind, start, end, joined;
    const flush = () => {
      if (!joined)
        return end - start <= CHUNK ? textSource.slice(start, end) : textSource.subtext(start, end);
      return joined.finishValue();
    };
    let batch = [];
    for await (const part of parts) {
      const synthetic = typeof part === "string";
      const begin = synthetic ? 0 : part.start,
        limit = synthetic ? part.length : part.end;
      for (let offset = begin; offset < limit; offset += CHUNK) {
        const text = synthetic
          ? part.slice(offset, offset + CHUNK)
          : textSource.slice(offset, Math.min(limit, offset + CHUNK));
        for (const match of text.matchAll(/\s+|\S+/g)) {
          const white = /\s/.test(match[0][0]),
            a = offset + match.index,
            b = a + match[0].length;
          if (kind !== undefined && kind !== white) {
            batch.push({ text: flush(), white: kind });
            if (batch.length === 256) {
              yield batch;
              batch = [];
            }
            kind = undefined;
            joined = undefined;
          }
          if (kind === undefined) {
            kind = white;
            start = a;
            end = b;
            if (synthetic) {
              joined = new Builder(textSource);
              joined.add(match[0]);
            }
          } else if (!synthetic && !joined && end === a) end = b;
          else {
            if (!joined) {
              joined = new Builder(textSource);
              joined.add(textSource.subtext(start, end));
            }
            joined.add(synthetic ? match[0] : textSource.subtext(a, b));
          }
        }
        await pause();
      }
    }
    if (kind !== undefined) batch.push({ text: flush(), white: kind });
    if (batch.length) yield batch;
  }

  const largeBlock = async (begin, end) => {
    const firstRow = source.positionAt(begin).row,
      lastRow = source.positionAt(end).row;
    let first = firstRow,
      last = lastRow;
    while (first <= last && (await tag(first, false))) {
      first++;
      await pause();
    }
    while (last >= first && (await tag(last, true))) {
      last--;
      await pause();
    }
    if (first > last) return source.subtext(begin, end);
    const firstStart = source.lineStart(first),
      firstEnd = lineEnd(first);
    let prefixEnd = await firstNonblank(firstStart, firstEnd);
    const firstToken = source.slice(prefixEnd, Math.min(firstEnd, prefixEnd + 3));
    const marker = /^(\/\/|\/\*|;;|#'|\|\|\||--|[#%*>-])/.exec(firstToken)?.[0];
    const markerStart = prefixEnd;
    if (marker) prefixEnd += marker.length;
    prefixEnd = await firstNonblank(prefixEnd, firstEnd);
    let prefix = source.subtext(firstStart, prefixEnd);
    const originalPrefix = prefix;
    let width = prefix.length;
    if (options.tabLength)
      for (let offset = 0; offset < prefix.length; offset += CHUNK) {
        const tabs =
          prefix.slice(offset, Math.min(prefix.length, offset + CHUNK)).match(/\t/g)?.length ?? 0;
        width += tabs * (options.tabLength - 1);
        await pause();
      }
    let wrapped = prefix;
    if (marker === "/*")
      wrapped = prefix.replace(markerStart - firstStart, markerStart - firstStart + 2, "  ");
    else if (marker === "-")
      wrapped = prefix.replace(markerStart - firstStart, markerStart - firstStart + 1, " ");
    async function* bodyParts() {
      for (let row = first; row <= last; row++) {
        const start = source.lineStart(row),
          end = lineEnd(row);
        const withoutPrefix =
          originalPrefix.length && (await equalPrefix(start, end, originalPrefix))
            ? start + originalPrefix.length
            : start;
        const content = await firstNonblank(withoutPrefix, end);
        if (row > first) yield " ";
        yield { start: content, end };
        await pause();
      }
    }
    const built = new Builder(source);
    let emitted = false;
    const emitLine = (line) => {
      if (emitted) built.add("\n");
      built.add(line);
      emitted = true;
    };
    for (let row = firstRow; row < first; row++)
      emitLine(source.subtext(source.lineStart(row), lineEnd(row)));
    let current = new Builder(source),
      currentLength = width,
      segmentCount = 0;
    current.add(prefix);
    for await (const batch of segments(bodyParts())) {
      for (const segment of batch) {
        if (
          segmentCount > 0 &&
          !segment.white &&
          currentLength + segment.text.length > options.wrapColumn &&
          (currentLength > 0 || segment.text.length < options.wrapColumn)
        ) {
          emitLine(current.finishValue());
          prefix = wrapped;
          current = new Builder(source);
          current.add(prefix);
          currentLength = width;
          segmentCount = 0;
        }
        current.add(segment.text);
        currentLength += segment.text.length;
        segmentCount++;
      }
    }
    emitLine(current.finishValue());
    for (let row = last + 1; row <= lastRow; row++)
      emitLine(source.subtext(source.lineStart(row), lineEnd(row)));
    const raw = built.finish(),
      cleaned = new Builder(source);
    for await (const batch of segments([{ start: 0, end: raw.length }], raw)) {
      for (const segment of batch) {
        if (segment.white && typeof segment.text === "string") {
          const lastNewline = segment.text.lastIndexOf("\n");
          cleaned.add(lastNewline < 0 ? segment.text : "\n" + segment.text.slice(lastNewline + 1));
        } else if (segment.white && segment.text.lineCount > 1) {
          cleaned.add("\n");
          cleaned.add(segment.text.subtext(segment.text.lineStart(segment.text.lineCount - 1)));
        } else cleaned.add(segment.text);
      }
    }
    return cleaned.finish();
  };

  const firstCharacter = await firstNonblank(0, source.length);
  const leadingEnd = source.lineStart(source.positionAt(firstCharacter).row);
  const lastCharacter = await lastNonblank(leadingEnd, source.length);
  let bodyEnd = source.length;
  if (lastCharacter >= leadingEnd) {
    const row = source.positionAt(lastCharacter).row;
    if (row + 1 < source.lineCount) bodyEnd = source.lineStart(row + 1) - 1;
  }
  const output = new Builder(source);
  output.add(source.subtext(0, leadingEnd));
  let blockStart = leadingEnd,
    firstBlock = true;
  const emitBlock = async (end) => {
    if (!firstBlock) output.add("\n\n");
    firstBlock = false;
    const block = source.subtext(blockStart, end);
    output.add(
      block.length <= 8192 && reflowSmall
        ? reflowSmall(block.toString(), options)
        : await largeBlock(blockStart, end),
    );
  };
  let row = source.positionAt(blockStart).row;
  while (row + 1 < source.lineCount && lineEnd(row + 1) < bodyEnd) {
    const next = row + 1;
    if ((await firstNonblank(source.lineStart(next), lineEnd(next))) === lineEnd(next)) {
      await emitBlock(lineEnd(row));
      row = next;
      while (
        row + 1 < source.lineCount &&
        lineEnd(row) < bodyEnd &&
        (await firstNonblank(source.lineStart(row), lineEnd(row))) === lineEnd(row)
      ) {
        row++;
        await pause();
      }
      blockStart = source.lineStart(row);
    } else row++;
    await pause();
  }
  await emitBlock(bodyEnd);
  output.add(source.subtext(bodyEnd));
  let result = output.finish();
  if (options.ending && options.ending !== "\n") {
    const normalizedOutput = new Builder(source);
    for (let offset = 0; offset < result.length; offset += CHUNK) {
      normalizedOutput.add(
        result
          .slice(offset, Math.min(result.length, offset + CHUNK))
          .replace(/\n/g, options.ending),
      );
      await pause();
    }
    result = normalizedOutput.finish();
  }
  check();
  return result;
}
module.exports = { reflowSource };
