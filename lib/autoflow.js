const _ = require("@lumine-code/underscore-plus");

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
    // On the workspace, because Edit > Reflow Selection dispatches at whatever
    // holds focus. currentTarget cannot be read for the editor from there — it
    // is the workspace element — so the dispatch target answers instead, with
    // the active editor as the fallback the menu and the palette need.
    this.commandDisposable = lumine.commands.add("lumine-workspace", {
      "autoflow:reflow-selection": {
        description: "Rewrap the selection to the preferred line length.",
        didDispatch: (event) => {
          const clicked = lumine.workspace.getTextEditorForElement(event?.target, {
            includeMini: false,
          });
          const editor = clicked ?? lumine.workspace.getActiveTextEditor();
          if (editor) this.reflowSelection(editor);
        },
      },
    });
  },

  deactivate() {
    this.commandDisposable?.dispose();
    this.commandDisposable = null;
  },

  reflowSelection(editor) {
    if (editor.isReadOnly()) return;

    const ranges = editor
      .getSelections()
      .map((selection) => {
        const range = selection.getBufferRange();
        return range.isEmpty() ? selection.cursor.getCurrentParagraphBufferRange() : range;
      })
      .filter((range) => range != null)
      .sort((a, b) => a.compare(b));
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
    return editor.transact(() => {
      // Freeze all target ranges before changing the buffer, and work upwards
      // so a wrapped paragraph cannot shift a later selection's coordinates.
      for (const range of mergedRanges.reverse()) {
        const reflowedText = this.reflow(editor.getTextInRange(range), reflowOptions);
        editor.setTextInBufferRange(range, reflowedText);
      }
    });
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
        var escapedLinePrefix = _.escapeRegExp(linePrefix);
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
