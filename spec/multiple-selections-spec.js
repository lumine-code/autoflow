describe("Autoflow multiple selections", () => {
  let editor;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"]) {
      spyOn(lumine.shell, method).and.resolveTo();
    }
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("autoflow");
    editor = await lumine.workspace.open();
    lumine.config.set("editor.preferredLineLength", 10);
  });

  function dispatch() {
    lumine.commands.dispatch(editor.getElement(), "autoflow:reflow-selection");
  }

  it("requires an editable document target instead of forwarding from another surface", () => {
    const workspace = lumine.workspace.getElement();
    editor.setText("alpha beta gamma delta");
    lumine.commands.dispatch(workspace, "autoflow:reflow-selection");
    expect(editor.getText()).toBe("alpha beta gamma delta");
    expect(lumine.commands.canDispatch(workspace, "autoflow:reflow-selection")).toBe(false);
    expect(
      lumine.keymaps.findKeyBindings({
        target: editor.getElement(),
        command: "autoflow:reflow-selection",
      }).length,
    ).toBeGreaterThan(0);
    const mini = lumine.workspace.buildTextEditor({ mini: true });
    workspace.appendChild(mini.getElement());
    expect(lumine.commands.canDispatch(mini.getElement(), "autoflow:reflow-selection")).toBe(false);
    mini.destroy();
    editor.setReadOnly(true);
    expect(lumine.commands.canDispatch(editor.getElement(), "autoflow:reflow-selection")).toBe(
      false,
    );
    expect(
      lumine.keymaps.findKeyBindings({
        target: editor.getElement(),
        command: "autoflow:reflow-selection",
      }),
    ).toEqual([]);
  });

  it("reflows every selected range as one undoable operation", () => {
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
    dispatch();
    expect(editor.getText()).toBe("alpha beta\ngamma\ndelta\n\none two\nthree four");
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("reflows the paragraph at every empty selection", () => {
    editor.setText("alpha beta gamma delta\n\none two three four");
    editor.setSelectedBufferRanges([
      [
        [0, 3],
        [0, 3],
      ],
      [
        [2, 3],
        [2, 3],
      ],
    ]);
    dispatch();
    expect(editor.getText()).toBe("alpha beta\ngamma\ndelta\n\none two\nthree four");
  });

  it("reflows a shared paragraph once", () => {
    const main = lumine.packages.getActivePackage("autoflow").mainModule;
    spyOn(main, "reflow").and.callThrough();
    editor.setText("alpha beta gamma delta");
    editor.setSelectedBufferRanges([
      [
        [0, 2],
        [0, 2],
      ],
      [
        [0, 13],
        [0, 13],
      ],
    ]);
    dispatch();
    expect(editor.getText()).toBe("alpha beta\ngamma\ndelta");
    expect(main.reflow.calls.count()).toBe(1);
  });

  it("leaves a read-only editor unchanged", () => {
    const original = "alpha beta gamma delta";
    editor.setText(original);
    editor.selectAll();
    editor.setReadOnly(true);
    dispatch();
    expect(editor.getText()).toBe(original);
  });
});
