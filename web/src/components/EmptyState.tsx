import { newSession } from "../sync";
import Icon from "./Icon";
import BrandMark from "./BrandMark";

// The no-session screen: an invitation to act, not a dead end (frontend-design
// skill — "an empty screen is an invitation to act").
export default function EmptyState() {
  return (
    <div class="empty">
      <div class="empty-card">
        <BrandMark class="empty-mark" />
        <h2 class="empty-title">VHSolara</h2>
        <p class="empty-sub">Pick a session from the sidebar, or start a new one.</p>
        <button type="button" class="empty-cta" onClick={() => void newSession()}>
          <Icon name="plus" size={16} /> New session
        </button>
        <div class="empty-tips">
          <span><kbd>Enter</kbd> send</span>
          <span><kbd>!</kbd> shell</span>
          <span><kbd>/undo</kbd> revert a turn</span>
        </div>
      </div>
    </div>
  );
}
