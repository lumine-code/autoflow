describe("Autoflow custom range tracking", () => {
  let main, editor;
  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("autoflow")).mainModule;
    editor = await lumine.workspace.open();
  });
  afterEach(() => editor.destroy());

  it("reflows separate source ranges despite its own intermediate selection changes", async () => {
    const original = "alpha beta gamma delta\n\none two three four";
    editor.setText(original);
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 22],
      ],
      [
        [2, 0],
        [2, 18],
      ],
    ]);
    const buffer = editor.getBuffer();
    let calls = 0;
    const layer = buffer.addMarkerLayer({
      trackRanges(entries) {
        calls++;
        return entries.map(({ id }) => ({ id, range: buffer.getRange() }));
      },
    });
    layer.markRange(buffer.getRange(), { invalidate: "never" });
    buffer.clearUndoStack();
    await main.reflowSourceRanges(editor, editor.getSelectedBufferRanges(), {
      wrapColumn: 10,
      tabLength: 2,
    });
    expect(editor.getText()).toBe("alpha beta\ngamma\ndelta\n\none two\nthree four");
    expect(calls).toBe(2);
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(buffer.undo()).toBe(false);
  });
});
