const CharacterPattern = new RegExp(/[^\s]/);

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "autoflow",
      tips: [
        "You can reflow the selected text to your preferred line length with {{ 'autoflow:reflow-selection' | keystroke }}",
      ],
    };
  },

  activate() {
    this.deactivate();
    this.pendingReflows = new Set();
    this.commandDisposable = lumine.commands.add("lumine-text-editor:not([mini]):not([readonly])", {
      "autoflow:reflow-selection": {
        description: "Rewrap the selection to the preferred line length.",
        isAvailable: ({ target }) => {
          const editor = lumine.workspace.getTextEditorForElement(target, { includeMini: false });
          return Boolean(editor && editor.getGrammar() !== lumine.grammars.nullGrammar);
        },
        didDispatch: (event) => {
          const editor = lumine.workspace.getTextEditorForElement(event?.target, {
            includeMini: false,
          });
          if (!editor) return;
          const report = (error) => {
            if (error.name !== "AbortError" && error.code !== "ERR_STALE_EDIT")
              lumine.notifications.addError("Unable to reflow text.", {
                detail: error.message,
                dismissable: true,
              });
          };
          try {
            const result = this.reflowSelection(editor);
            return typeof result?.then === "function" ? result.catch(report) : result;
          } catch (error) {
            report(error);
          }
        },
      },
    });
  },

  deactivate() {
    for (const controller of this.pendingReflows ?? []) controller.abort();
    this.pendingReflows?.clear();
    this.commandDisposable?.dispose();
    this.commandDisposable = null;
  },

  reflowSelection(editor) {
    if (!this.commandDisposable || editor.isDestroyed() || editor.isReadOnly()) return;
    if (editor.getGrammar() === lumine.grammars.nullGrammar) return;

    if (editor.getBuffer().getLanguageMode().asynchronousSyntax) {
      const revision = editor.getBuffer().getTextRevision();
      const mode = editor.getBuffer().getLanguageMode();
      const epoch = mode.getSyntaxRequestEpoch?.();
      const owner = this.commandDisposable;
      const pending = this.pendingReflows;
      const controller = new AbortController();
      pending.add(controller);
      const selections = editor.getSelectedBufferRanges().map((range) => range.copy());
      return editor
        .getParagraphRangesForBufferRows(
          selections.filter((range) => range.isEmpty()).map((range) => range.start.row),
          { signal: controller.signal },
        )
        .then((paragraphs) => {
          if (
            !paragraphs ||
            controller.signal.aborted ||
            this.commandDisposable !== owner ||
            editor.isDestroyed() ||
            editor.isReadOnly() ||
            editor.getBuffer().getTextRevision() !== revision ||
            editor.getBuffer().getLanguageMode() !== mode ||
            mode.getSyntaxRequestEpoch?.() !== epoch
          )
            return;
          const current = editor.getSelectedBufferRanges();
          if (
            current.length !== selections.length ||
            current.some((range, i) => !range.isEqual(selections[i]))
          )
            return;
          let index = 0;
          return this.reflowRanges(
            editor,
            selections.map((range) => (range.isEmpty() ? paragraphs[index++] : range)),
          );
        })
        .catch((error) => {
          if (!controller.signal.aborted) throw error;
        })
        .finally(() => {
          pending.delete(controller);
          controller.abort();
        });
    }

    const ranges = editor.getSelections().map((selection) => {
      const range = selection.getBufferRange();
      return range.isEmpty() ? selection.cursor.getCurrentParagraphBufferRange() : range;
    });
    return this.reflowRanges(editor, ranges);
  },

  reflowRanges(editor, input) {
    const ranges = input.filter((range) => range != null).sort((a, b) => a.compare(b));
    const mergedRanges = [];
    for (const range of ranges) {
      const previous = mergedRanges[mergedRanges.length - 1];
      if (previous?.intersectsWith(range)) {
        mergedRanges[mergedRanges.length - 1] = previous.union(range);
      } else {
        mergedRanges.push(range);
      }
    }

    const reflowOptions = {
      wrapColumn: this.getPreferredLineLength(editor),
      tabLength: this.getTabLength(editor),
    };
    const buffer = editor.getBuffer();
    if (
      mergedRanges.some(
        (range) =>
          buffer.characterIndexForPosition(range.end) -
            buffer.characterIndexForPosition(range.start) >
            1024 * 1024 ||
          range.end.row - range.start.row > 4096 ||
          Array.from(
            { length: range.end.row - range.start.row + 1 },
            (_, index) => range.start.row + index,
          ).some((row) => buffer.lineLengthForRow(row) > 8192),
      )
    ) {
      return this.reflowSourceRanges(editor, mergedRanges, reflowOptions);
    }
    return editor.transact(() => {
      // Freeze all target ranges before changing the buffer, and work upwards
      // so a wrapped paragraph cannot shift a later selection's coordinates.
      editor.getBuffer().setTextInIndependentRanges(
        mergedRanges.map((range) => ({
          range,
          text: this.reflow(editor.getTextInRange(range), reflowOptions),
        })),
      );
    });
  },

  async reflowSourceRanges(editor, ranges, reflowOptions) {
    const buffer = editor.getBuffer(),
      revision = buffer.getTextRevision(),
      owner = this.commandDisposable;
    const selections = editor.getSelectedBufferRanges(),
      controller = new AbortController();
    this.pendingReflows.add(controller);
    const isCurrent = () =>
      !controller.signal.aborted &&
      this.commandDisposable === owner &&
      !editor.isDestroyed() &&
      !editor.isReadOnly() &&
      buffer.getTextRevision() === revision &&
      editor.getSelectedBufferRanges().length === selections.length &&
      editor.getSelectedBufferRanges().every((range, index) => range.isEqual(selections[index]));
    const check = () => {
      if (!isCurrent())
        throw Object.assign(
          new Error("Reflow cancelled because its document or selections changed"),
          { name: "AbortError" },
        );
    };
    try {
      const edits = [];
      for (const range of ranges) {
        const ending =
          buffer.getPreferredLineEnding() ||
          buffer.lineEndingForRow(range.start.row) ||
          buffer.lineEndingForRow(range.start.row - 1) ||
          "\n";
        const text = await require("./source-reflow").reflowSource(
          buffer.getTextSnapshotInRange(range),
          { ...reflowOptions, ending },
          { check, reflowSmall: this.reflow.bind(this) },
        );
        edits.push({ range, text });
      }
      return await buffer.applyTextEdits(edits, {
        expectedRevision: revision,
        signal: controller.signal,
        isCurrent,
      });
    } finally {
      this.pendingReflows.delete(controller);
    }
  },

  reflow(text, { wrapColumn, tabLength }) {
    let tabLengthInSpaces;
    const paragraphs = [];
    // Convert all \r\n and \r to \n. The text buffer will normalize them later
    text = text.replace(/\r\n?/g, "\n");

    const leadingVerticalSpace = text.match(/^\s*\n/)?.[0] ?? "";
    text = text.slice(leadingVerticalSpace.length);

    const trailingVerticalSpace = text.match(/\n\s*$/)?.[0] ?? "";
    text = text.slice(0, text.length - trailingVerticalSpace.length);

    const paragraphBlocks = text.split(/\n\s*\n/g);
    if (tabLength) {
      tabLengthInSpaces = Array(tabLength + 1).join(" ");
    } else {
      tabLengthInSpaces = "";
    }

    for (let block of paragraphBlocks) {
      let blockLines = block.split("\n");

      // For LaTeX tags surrounding the text, we simply ignore them, and
      // reproduce them verbatim in the wrapped text.
      const beginningLinesToIgnore = [];
      const endingLinesToIgnore = [];
      const latexTagRegex = /^\s*\\\w+(\[.*\])?\{\w+\}(\[.*\])?\s*$/g; // e.g. \begin{verbatim}
      const latexTagStartRegex = /^\s*\\\w+\s*\{\s*$/g; // e.g. \item{
      const latexTagEndRegex = /^\s*\}\s*$/g; // e.g. }
      while (
        blockLines.length > 0 &&
        (blockLines[0].match(latexTagRegex) || blockLines[0].match(latexTagStartRegex))
      ) {
        beginningLinesToIgnore.push(blockLines[0]);
        blockLines.shift();
      }
      while (
        blockLines.length > 0 &&
        (blockLines[blockLines.length - 1].match(latexTagRegex) ||
          blockLines[blockLines.length - 1].match(latexTagEndRegex))
      ) {
        endingLinesToIgnore.unshift(blockLines[blockLines.length - 1]);
        blockLines.pop();
      }

      // The paragraph might be a LaTeX section with no text, only tags:
      // \documentclass{article}
      // In that case, we have nothing to reflow.
      // Push the tags verbatim and continue to the next paragraph.
      if (!(blockLines.length > 0)) {
        paragraphs.push(block);
        continue;
      }

      // TODO: this could be more language specific. Use the actual comment char.
      // Remember that `-` has to be the last character in the character class.
      let linePrefix = blockLines[0].match(/^\s*(\/\/|\/\*|;;|#'|\|\|\||--|[#%*>-])?\s*/g)[0];
      let linePrefixTabExpanded = linePrefix;
      if (tabLengthInSpaces) {
        linePrefixTabExpanded = linePrefix.replace(/\t/g, tabLengthInSpaces);
      }

      if (linePrefix) {
        var escapedLinePrefix = require("@lumine-code/underscore-plus").escapeRegExp(linePrefix);
        blockLines = blockLines.map((blockLine) =>
          blockLine.replace(new RegExp(`^${escapedLinePrefix}`), ""),
        );
      }

      blockLines = blockLines.map((blockLine) => blockLine.replace(/^\s+/, ""));

      const lines = [];
      let currentLine = [];
      let currentLineLength = linePrefixTabExpanded.length;

      const wrappedLinePrefix = linePrefix
        .replace(/^(\s*)\/\*/, "$1  ")
        .replace(/^(\s*)-(?!-)/, "$1 ");

      for (let segment of this.segmentText(blockLines.join(" "))) {
        if (currentLine.length > 0 && this.wrapSegment(segment, currentLineLength, wrapColumn)) {
          lines.push(linePrefix + currentLine.join(""));
          // Switch only after emitting the first line, so a final second line
          // also uses the continuation prefix for C comments and bullets.
          linePrefix = wrappedLinePrefix;
          currentLine = [];
          currentLineLength = linePrefixTabExpanded.length;
        }
        currentLine.push(segment);
        currentLineLength += segment.length;
      }
      lines.push(linePrefix + currentLine.join(""));

      const wrappedLines = beginningLinesToIgnore.concat(lines.concat(endingLinesToIgnore));
      paragraphs.push(wrappedLines.join("\n").replace(/\s+\n/g, "\n"));
    }

    return leadingVerticalSpace + paragraphs.join("\n\n") + trailingVerticalSpace;
  },

  getTabLength(editor) {
    return lumine.config.get("editor.tabLength", { scope: editor.getRootScopeDescriptor() }) ?? 2;
  },

  getPreferredLineLength(editor) {
    return lumine.config.get("editor.preferredLineLength", {
      scope: editor.getRootScopeDescriptor(),
    });
  },

  wrapSegment(segment, currentLineLength, wrapColumn) {
    return (
      CharacterPattern.test(segment) &&
      currentLineLength + segment.length > wrapColumn &&
      (currentLineLength > 0 || segment.length < wrapColumn)
    );
  },

  segmentText(text) {
    let match;
    const segments = [];
    const re = /[\s]+|[^\s]+/g;
    while ((match = re.exec(text))) {
      segments.push(match[0]);
    }
    return segments;
  },
};
