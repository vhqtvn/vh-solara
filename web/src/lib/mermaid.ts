// Lazy mermaid loader: the (large) mermaid library is only fetched when a
// diagram actually needs rendering, so it stays out of the initial bundle.
let loader: Promise<any> | null = null;

async function getMermaid() {
  if (!loader) {
    loader = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m.default;
    });
  }
  return loader;
}

let counter = 0;
export async function renderMermaid(src: string): Promise<string> {
  const mermaid = await getMermaid();
  const { svg } = await mermaid.render("vh-mmd-" + counter++, src);
  return svg;
}
