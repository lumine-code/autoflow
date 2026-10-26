const { TextBuffer } = require("lumine");

describe("source-backed reflow", () => {
  let buffer;
  afterEach(() => buffer?.destroy());
  it("matches existing whitespace, comment, LaTeX and Unicode semantics", async () => {
    const { reflowSource } = require("../lib/source-reflow");
    const legacy = require("../lib/autoflow");
    const cases = [
      "",
      " a ",
      "\n\n a b c\n \n",
      "a\r\nb\rc",
      "// one two three\n// four five six",
      "/* one two three four five six seven */",
      "- one two three\n  four five six",
      "a\n\n b\n\n c",
      "a\n \t\n b",
      "\\begin{test}\none two three four\n\\end{test}",
      "\\item{\n  one two three four\n}",
      "\t\tword words another",
      "\u00a0one\u00a0two\u2028three",
      "\\command[" + "a".repeat(40000) + "]{tag}\nword word",
      "\\command{" + "a".repeat(40000) + "}\nword word",
      "longword".repeat(10000) + "\n word",
    ];
    let seed = 17191;
    const words = ["one", "two", "\n", "\n\n", "  ", "\t", "//", "é😀", "-", "\\x{y}", "\r\n"];
    for (let sample = 0; sample < 100; sample++) {
      let text = "";
      for (let i = 0; i < 40; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += words[(seed >>> 16) % words.length];
      }
      cases.push(text);
    }
    for (const text of cases) {
      buffer = new TextBuffer(text);
      const options = { wrapColumn: 20, tabLength: 4 };
      expect((await reflowSource(buffer.getTextSnapshot(), options)).toString())
        .withContext(JSON.stringify(text.slice(0, 100)))
        .toBe(legacy.reflow(text, options));
      buffer.destroy();
      buffer = null;
    }
  });

  it("reflows an indentation prefix too long for a generated RegExp", async () => {
    const prefix = " ".repeat(40000);
    buffer = new TextBuffer(prefix + "body more words");
    const { reflowSource } = require("../lib/source-reflow");
    const result = await reflowSource(buffer.getTextSnapshot(), { wrapColumn: 20, tabLength: 4 });
    expect(result.toString()).toBe(prefix + "body\n" + prefix + "more\n" + prefix + "words");
  });

  it("keeps an indivisible word larger than the runtime string limit intact", async () => {
    jasmine.useRealClock();
    buffer = new TextBuffer("x".repeat(32768));
    let source = buffer.getTextSnapshot();
    while (source.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
      source = source.replace(source.length, source.length, source);
    const { reflowSource } = require("../lib/source-reflow");
    const result = await reflowSource(source, { wrapColumn: 80, tabLength: 2 });
    expect(result.length).toBe(source.length);
    expect(result.equals(source)).toBe(true);
  });

  it("cancels source preparation without changing its buffer", async () => {
    buffer = new TextBuffer("word words more\n".repeat(100000));
    const { reflowSource } = require("../lib/source-reflow");
    let checks = 0;
    await expectAsync(
      reflowSource(
        buffer.getTextSnapshot(),
        { wrapColumn: 20, tabLength: 4 },
        {
          check() {
            if (++checks > 1) throw Object.assign(new Error("cancel"), { name: "AbortError" });
          },
        },
      ),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(buffer.lineForRow(0)).toBe("word words more");
  });
});
