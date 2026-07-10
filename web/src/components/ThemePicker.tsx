import { For, Show } from "solid-js";
import { customTheme, setThemeId, theme, THEMES } from "../theme";
import styles from "./ThemePicker.module.css";

// Visual theme selector: a scrollable list where each row shows a mini preview
// (background fill + accent / accent-2 / text swatches) next to the name, so a
// theme is recognizable before you pick it. Replaces the plain text dropdown.
export default function ThemePicker() {
  // The custom theme previews live from the user's edited colors.
  const swatchFor = (id: string) => {
    if (id === "custom") {
      const c = customTheme();
      return { bg: c.bg, fg: c.fg, accent: c.accent, accent2: c.accent2 };
    }
    return THEMES.find((t) => t.id === id)!.swatch;
  };

  return (
    <div class={styles["theme-picker"]} role="listbox" aria-label="Theme">
      <For each={THEMES}>
        {(t) => {
          const s = () => swatchFor(t.id);
          return (
            <button
              type="button"
              role="option"
              aria-selected={theme() === t.id}
              class={styles["theme-picker-item"]}
              classList={{ on: theme() === t.id }}
              onClick={() => setThemeId(t.id)}
              title={t.name}
            >
              <span class={styles["theme-swatch"]} style={{ background: s().bg, "border-color": s().accent }} aria-hidden="true">
                <span class={styles["theme-swatch-dot"]} style={{ background: s().accent }} />
                <span class={styles["theme-swatch-dot"]} style={{ background: s().accent2 }} />
                <span class={styles["theme-swatch-dot"]} style={{ background: s().fg }} />
              </span>
              <span class={styles["theme-picker-name"]}>{t.name}</span>
              <Show when={theme() === t.id}>
                <span class={styles["theme-picker-check"]} aria-hidden="true">✓</span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
