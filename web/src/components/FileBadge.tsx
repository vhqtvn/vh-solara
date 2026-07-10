import { fileColor, fileExt } from "../lib/fileicon";
import styles from "./FileBadge.module.css";

// A small colored extension chip identifying a file type.
export default function FileBadge(props: { path: string }) {
  return (
    <span class={styles["file-badge"]} style={{ color: fileColor(props.path) }}>
      {fileExt(props.path)}
    </span>
  );
}
