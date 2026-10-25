const path = require("node:path");

describe("autoflow with no grammar", () => {
  let editor, main;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    main = (await lumine.packages.activatePackage(path.join(__dirname, ".."))).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("one two three four five six seven eight nine ten");
    editor.selectAll();
  });
  afterEach(() => editor?.destroy());

  it("declines paragraph analysis and reflow until a grammar is selected", async () => {
    const grammar = lumine.grammars.grammarForScopeName("text.plain");
    editor.setGrammar(lumine.grammars.nullGrammar);
    spyOn(main, "reflowRanges").and.callThrough();
    await main.reflowSelection(editor);
    expect(main.reflowRanges).not.toHaveBeenCalled();
    expect(lumine.commands.canDispatch(editor.getElement(), "autoflow:reflow-selection")).toBe(
      false,
    );
    editor.setGrammar(grammar);
    await main.reflowSelection(editor);
    expect(main.reflowRanges).toHaveBeenCalled();
  });
});
