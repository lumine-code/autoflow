describe("Autoflow oversized first words with prefixes", () => {
  let editor;
  beforeEach(async () => {
    await lumine.packages.activatePackage("autoflow");
    editor = await lumine.workspace.open();
    lumine.config.set("editor.preferredLineLength", 8);
  });
  for (const [input, expected] of [
    ["// extraordinary word", "// extraordinary\n// word"],
    ["- extraordinary word", "- extraordinary\n  word"],
    ["/* one two", "/* one\n   two"],
  ]) {
    it(`does not insert an empty prefix line for ${input}`, () => {
      editor.setText(input);
      editor.selectAll();
      lumine.packages.getActivePackage("autoflow").mainModule.reflowSelection(editor);
      expect(editor.getText()).toBe(expected);
      editor.undo();
      expect(editor.getText()).toBe(input);
    });
  }
});
