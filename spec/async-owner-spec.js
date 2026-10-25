const { Range } = require("lumine");
describe("Autoflow asynchronous owner", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, editor, release;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("autoflow")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("one two three four five six seven eight");
    editor.getBuffer().getLanguageMode().asynchronousSyntax = true;
    lumine.config.set("editor.preferredLineLength", 10);
    spyOn(editor, "getParagraphRangesForBufferRows").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
  });
  afterEach(() => {
    release?.([]);
    editor.destroy();
  });
  for (const reactivate of [false, true])
    it(`does not reflow after deactivation (reactivation ${reactivate})`, async () => {
      const original = editor.getText();
      const pending = main.reflowSelection(editor);
      await lumine.packages.deactivatePackage("autoflow");
      if (reactivate) await lumine.packages.activatePackage("autoflow");
      release([new Range([0, 0], [0, original.length])]);
      await pending;
      expect(editor.getText()).toBe(original);
      expect(editor.getParagraphRangesForBufferRows.calls.first().args[1].signal.aborted).toBe(
        true,
      );
      expect(main.pendingReflows.size).toBe(0);
    });
});
