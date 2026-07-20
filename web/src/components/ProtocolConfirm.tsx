import { Show } from "solid-js";
import Icon from "./Icon";
import { confirmProtocol, dismissProtocol, pendingProtocol, PROTOCOL_SCHEME } from "../protocol";
import styles from "./ProtocolConfirm.module.css";

// User-confirmation prompt for an inbound `web+vhsolara:` payload.
//
// SECURITY CONTRACT: this is the ONLY surface that can trigger an "act" on a
// protocol payload. It renders the raw, untrusted payload verbatim (escaped by
// JSX) so the user can see exactly what would be acted on. The "Allow" button
// is the sole caller of confirmProtocol(); "Cancel" / Escape / backdrop drop
// the payload without acting. See web/src/protocol.ts.
export default function ProtocolConfirm() {
  return (
    <Show when={pendingProtocol()} keyed>
      {(payload) => (
        <div class="dialog-overlay" onClick={dismissProtocol}>
          <div
            class={`dialog confirm ${styles["proto-dialog"]}`}
            role="alertdialog"
            aria-label="Incoming protocol request"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="dialog-head">
              <span class="dialog-title">Incoming link</span>
              <button type="button" class="icon-btn" aria-label="Close" onClick={dismissProtocol}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div class="dialog-body">
              <p class={styles["proto-lede"]}>
                An app or page wants to open a link in VHSolara. Review the payload before allowing.
              </p>
              <p class={styles["proto-scheme"]}>
                Scheme: <code>{PROTOCOL_SCHEME}</code>
              </p>
              <pre class={styles["proto-payload"]} data-testid="proto-payload">{payload}</pre>
              {!payload.startsWith(PROTOCOL_SCHEME) && (
                <p class={styles["proto-warn"]} role="note">
                  Warning: this payload does not start with the expected <code>{PROTOCOL_SCHEME}</code> scheme.
                  It may have been spoofed — verify before allowing.
                </p>
              )}
            </div>
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel" onClick={dismissProtocol}>
                Cancel
              </button>
              <button
                type="button"
                class="confirm-go"
                data-testid="proto-allow"
                onClick={confirmProtocol}
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
