import { setProjSwitcherOpen } from "../ui";
import Icon from "./Icon";
import BrandMark from "./BrandMark";

// The no-project screen: vh-solara runs as a daemon whose cwd is not a
// meaningful project, so with no project pinned the app invites the operator to
// pick one rather than silently bridging cwd. Mirrors EmptyState's styling/
// a11y shape (frontend-design skill — "an empty screen is an invitation to
// act"). The CTA opens the project switcher dialog via the GLOBAL
// projSwitcherOpen signal (ui.ts) — ProjectSwitcher reads/writes the same
// signal — so this CTA and the sidebar trigger drive one shared dialog.
export default function NoProjectState() {
  return (
    <div class="empty">
      <div class="empty-card">
        <BrandMark class="empty-mark" />
        <h2 class="empty-title">VHSolara</h2>
        <p class="empty-sub">Select a project to start working with its sessions.</p>
        <button type="button" class="empty-cta" onClick={() => setProjSwitcherOpen(true)}>
          <Icon name="layers" size={16} /> Select project
        </button>
        <div class="empty-tips">
          <span>Pin a recent project or add one by path.</span>
        </div>
      </div>
    </div>
  );
}
