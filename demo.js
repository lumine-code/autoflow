// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [],
  viewport: { width: 1100, height: 340 },
  async before() {},
  async prepare(context) {
    const { lumine, state, open } = context;
    state.editor = await open("usage/notes.txt");

    lumine.config.set("editor.preferredLineLength", 64);
    state.editor.selectAll();
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Reflow a paragraph to the chosen line length.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          lumine.commands.dispatch(lumine.views.getView(state.editor), "autoflow:reflow-selection");
        }
      },
      ready(context) {
        const { state } = context;
        return Boolean(state.editor.getLineCount() > 2);
      },
    },
  ],
  async cleanup(context) {
    const { lumine } = context;
    lumine.config.unset("editor.preferredLineLength");
  },
};
