import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_BACKLOG_PATH = path.join(REPO_ROOT, "docs", "planning", "backlog.md");
const DEFAULT_MAIN_DONE_LIMIT = 12;
const DEFAULT_MAIN_CANCELLED_LIMIT = 6;
const ACTIVE_SECTIONS = ["Now", "Next", "Later"];
const HISTORY_SECTIONS = ["Done", "Cancelled"];
const TASK_SECTIONS = new Set([...ACTIVE_SECTIONS, ...HISTORY_SECTIONS]);
const ACTIVE_STATUSES = new Set(["todo", "in_progress", "blocked"]);
const HISTORY_STATUSES = new Set(["done", "cancelled"]);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...HISTORY_STATUSES]);
const TABLE_HEADER = "| ID | Status | Area | Task | Owner | Notes | Links |";
const TABLE_DIVIDER = "| --- | --- | --- | --- | --- | --- | --- |";
const MANAGED_ARCHIVE_PATTERN = /^backlog-archive-(?:\d{4}-q[1-4]|undated)\.md$/;

class BacklogError extends Error {}

function parseArgs(argv) {
    const options = {
        backlogPath: DEFAULT_BACKLOG_PATH,
        archiveDir: "",
        mainDoneLimit: DEFAULT_MAIN_DONE_LIMIT,
        mainCancelledLimit: DEFAULT_MAIN_CANCELLED_LIMIT,
        check: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case "--backlog":
                options.backlogPath = resolveCliPath(argv[index + 1], "Missing value for --backlog");
                index += 1;
                break;
            case "--archive-dir":
                options.archiveDir = resolveCliPath(
                    argv[index + 1],
                    "Missing value for --archive-dir",
                );
                index += 1;
                break;
            case "--main-done-limit":
                options.mainDoneLimit = parseIntegerFlag(
                    argv[index + 1],
                    "--main-done-limit",
                );
                index += 1;
                break;
            case "--main-cancelled-limit":
                options.mainCancelledLimit = parseIntegerFlag(
                    argv[index + 1],
                    "--main-cancelled-limit",
                );
                index += 1;
                break;
            case "--check":
                options.check = true;
                break;
            default:
                throw new BacklogError(`Unexpected argument: ${argument}`);
        }
    }

    options.archiveDir =
        options.archiveDir || path.join(path.dirname(options.backlogPath), "archive");
    return options;
}

function resolveCliPath(value, message) {
    if (!value) {
        throw new BacklogError(message);
    }
    return path.resolve(process.cwd(), value);
}

function parseIntegerFlag(value, flagName) {
    if (!value) {
        throw new BacklogError(`Missing value for ${flagName}`);
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new BacklogError(`${flagName} must be a non-negative integer`);
    }
    return parsed;
}

function readFileNormalized(filePath) {
    return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function parseSections(text) {
    const lines = text.split("\n");
    const preamble = [];
    const sections = [];
    let current = null;

    for (const line of lines) {
        const headingMatch = /^## (.+)$/.exec(line);
        if (headingMatch) {
            if (current) {
                sections.push(current);
            }
            current = {
                title: headingMatch[1].trim(),
                lines: [],
            };
            continue;
        }
        if (current) {
            current.lines.push(line);
        } else {
            preamble.push(line);
        }
    }

    if (current) {
        sections.push(current);
    }

    return {
        preamble,
        sections,
    };
}

function parseTableRows(section, originLabel) {
    if (!section) {
        return [];
    }

    const tableLines = section.lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|"));

    if (tableLines.length <= 2) {
        return [];
    }

    return tableLines.slice(2).map((line, index) => parseTaskRow(line, originLabel, index));
}

function parseTaskRow(line, originLabel, index) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
        throw new BacklogError(`Invalid backlog row in ${originLabel}: ${line}`);
    }
    const rawCells = splitMarkdownRow(trimmed.slice(1, -1)).map((cell) =>
        unescapeTableCell(cell),
    );
    const cells =
        rawCells.length <= 7
            ? [...rawCells, ...Array(Math.max(0, 7 - rawCells.length)).fill("")]
            : [
                  rawCells[0],
                  rawCells[1],
                  rawCells[2],
                  rawCells[3],
                  rawCells[4],
                  rawCells.slice(5, -1).join(" | "),
                  rawCells.at(-1),
              ];
    const [id, status, area, task, owner, notes, links] = cells;
    if (!id) {
        throw new BacklogError(`Missing task ID in ${originLabel}`);
    }
    if (!VALID_STATUSES.has(status)) {
        throw new BacklogError(`Unsupported status ${status} for ${id} in ${originLabel}`);
    }

    return {
        id,
        status,
        area,
        task,
        owner,
        notes,
        links,
        completionDate: extractCompletionDate(notes),
        originLabel,
        orderKey: `${originLabel}:${index.toString().padStart(4, "0")}`,
    };
}

function splitMarkdownRow(content) {
    const cells = [];
    let current = "";
    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        const previous = index > 0 ? content[index - 1] : "";
        if (character === "|" && previous !== "\\") {
            cells.push(current.trim());
            current = "";
            continue;
        }
        current += character;
    }
    cells.push(current.trim());
    return cells;
}

function unescapeTableCell(cell) {
    return String(cell || "").replace(/\\\|/g, "|").trim();
}

function extractCompletionDate(notes) {
    const match = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(String(notes || ""));
    return match ? match[1] : "";
}

function periodKeyForDate(dateText) {
    if (!dateText) {
        return "undated";
    }
    const [year, month] = dateText.split("-").map((value) => Number.parseInt(value, 10));
    const quarter = Math.floor((month - 1) / 3) + 1;
    return `${year}-q${quarter}`;
}

function archiveLabelForKey(periodKey) {
    if (periodKey === "undated") {
        return "Undated";
    }
    const match = /^(\d{4})-q([1-4])$/.exec(periodKey);
    if (!match) {
        throw new BacklogError(`Unsupported archive period key: ${periodKey}`);
    }
    return `${match[1]} Q${match[2]}`;
}

function archiveFilenameForKey(periodKey) {
    if (periodKey === "undated") {
        return "backlog-archive-undated.md";
    }
    return `backlog-archive-${periodKey}.md`;
}

function parseArchiveFilePeriod(filename) {
    if (filename === "backlog-archive-undated.md") {
        return "undated";
    }
    const match = /^backlog-archive-(\d{4}-q[1-4])\.md$/.exec(filename);
    if (!match) {
        throw new BacklogError(`Unsupported managed archive filename: ${filename}`);
    }
    return match[1];
}

function validateNoDuplicateIDs(rows, label) {
    const seen = new Map();
    const duplicates = [];
    for (const row of rows) {
        const previous = seen.get(row.id);
        if (previous) {
            duplicates.push(
                `Duplicate task ID ${row.id} found in ${label}: ${previous} and ${row.originLabel}`,
            );
        } else {
            seen.set(row.id, row.originLabel);
        }
    }
    if (!duplicates.length) {
        return;
    }
    if (duplicates.length === 1) {
        throw new BacklogError(duplicates[0]);
    }
    const bullets = duplicates
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n");
    throw new BacklogError(
        `${duplicates.length} duplicate-ID problems found:\n${bullets}`,
    );
}

function sortHistoricalRows(rows) {
    return [...rows].sort((left, right) => {
        const leftHasDate = Boolean(left.completionDate);
        const rightHasDate = Boolean(right.completionDate);
        if (leftHasDate && rightHasDate && left.completionDate !== right.completionDate) {
            return right.completionDate.localeCompare(left.completionDate);
        }
        if (leftHasDate !== rightHasDate) {
            return leftHasDate ? -1 : 1;
        }
        return left.orderKey.localeCompare(right.orderKey);
    });
}

function readManagedArchives(archiveDir) {
    if (!fs.existsSync(archiveDir)) {
        return [];
    }

    const archiveFiles = fs
        .readdirSync(archiveDir)
        .filter((name) => MANAGED_ARCHIVE_PATTERN.test(name))
        .sort();
    const rows = [];

    for (const filename of archiveFiles) {
        const periodKey = parseArchiveFilePeriod(filename);
        const parsed = parseSections(readFileNormalized(path.join(archiveDir, filename)));
        const sections = new Map(parsed.sections.map((section) => [section.title, section]));
        for (const statusTitle of HISTORY_SECTIONS) {
            const parsedRows = parseTableRows(
                sections.get(statusTitle),
                `${filename}:${statusTitle}`,
            ).map((row) => ({
                ...row,
                periodKey: row.completionDate ? periodKeyForDate(row.completionDate) : periodKey,
            }));
            rows.push(...parsedRows);
        }
    }

    validateNoDuplicateIDs(rows, `${path.relative(REPO_ROOT, archiveDir) || archiveDir}`);
    return rows;
}

function buildState(backlogPath, archiveDir, limits) {
    const parsedBacklog = parseSections(readFileNormalized(backlogPath));
    const sectionsByTitle = new Map(parsedBacklog.sections.map((section) => [section.title, section]));
    const mainRows = [];

    for (const title of [...ACTIVE_SECTIONS, ...HISTORY_SECTIONS]) {
        mainRows.push(...parseTableRows(sectionsByTitle.get(title), title));
    }
    validateNoDuplicateIDs(mainRows, path.relative(REPO_ROOT, backlogPath) || backlogPath);

    const activeRows = {
        Now: [],
        Next: [],
        Later: [],
    };
    const doneRows = [];
    const cancelledRows = [];

    for (const row of mainRows) {
        if (ACTIVE_STATUSES.has(row.status)) {
            if (!ACTIVE_SECTIONS.includes(row.originLabel)) {
                throw new BacklogError(
                    `Task ${row.id} has active status ${row.status} but sits under ${row.originLabel}`,
                );
            }
            activeRows[row.originLabel].push(row);
            continue;
        }
        if (row.status === "done") {
            doneRows.push(row);
            continue;
        }
        if (row.status === "cancelled") {
            cancelledRows.push(row);
        }
    }

    const sortedDone = sortHistoricalRows(doneRows);
    const sortedCancelled = sortHistoricalRows(cancelledRows);
    const mainDone = sortedDone.slice(0, limits.mainDoneLimit);
    const archiveDone = sortedDone.slice(limits.mainDoneLimit);
    const mainCancelled = sortedCancelled.slice(0, limits.mainCancelledLimit);
    const archiveCancelled = sortedCancelled.slice(limits.mainCancelledLimit);

    const existingArchiveRows = readManagedArchives(archiveDir);
    const keptRows = [
        ...activeRows.Now,
        ...activeRows.Next,
        ...activeRows.Later,
        ...mainDone,
        ...mainCancelled,
    ];
    validateNoDuplicateIDs(keptRows, "main backlog after normalization");

    const archiveRows = [...existingArchiveRows, ...archiveDone, ...archiveCancelled];
    validateNoDuplicateIDs(
        [...keptRows, ...archiveRows],
        "normalized backlog plus managed archives",
    );

    return {
        backlogPath,
        archiveDir,
        parsedBacklog,
        activeRows,
        mainDone,
        mainCancelled,
        archiveRows,
        archiveSummary: summarizeArchiveRows(archiveRows),
    };
}

function summarizeArchiveRows(rows) {
    const summary = new Map();
    for (const row of rows) {
        const periodKey = row.periodKey || periodKeyForDate(row.completionDate);
        if (!summary.has(periodKey)) {
            summary.set(periodKey, {
                periodKey,
                label: archiveLabelForKey(periodKey),
                done: 0,
                cancelled: 0,
            });
        }
        const entry = summary.get(periodKey);
        if (row.status === "done") {
            entry.done += 1;
        } else if (row.status === "cancelled") {
            entry.cancelled += 1;
        }
    }
    return [...summary.values()].sort((left, right) => {
        if (left.periodKey === right.periodKey) {
            return 0;
        }
        if (left.periodKey === "undated") {
            return 1;
        }
        if (right.periodKey === "undated") {
            return -1;
        }
        return right.periodKey.localeCompare(left.periodKey);
    });
}

function renderTaskSection(title, rows) {
    const lines = [`## ${title}`, "", TABLE_HEADER, TABLE_DIVIDER];
    for (const row of rows) {
        lines.push(renderRow(row));
    }
    return lines;
}

function renderRow(row) {
    return [
        "|",
        sanitizeCell(row.id),
        "|",
        sanitizeCell(row.status),
        "|",
        sanitizeCell(row.area),
        "|",
        sanitizeCell(row.task),
        "|",
        sanitizeCell(row.owner),
        "|",
        sanitizeCell(row.notes),
        "|",
        sanitizeCell(row.links),
        "|",
    ].join(" ");
}

function sanitizeCell(value) {
    return String(value || "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
}

function renderArchiveIndexSection(archiveSummary) {
    const lines = [
        "## Archive Index",
        "",
        "Older `done` and `cancelled` history lives under [docs/planning/archive/index.md](archive/index.md) and is meant for on-demand reading instead of auto-loading into the active backlog context.",
        "",
    ];

    if (!archiveSummary.length) {
        lines.push("- No archive files yet.");
        return lines;
    }

    for (const entry of archiveSummary) {
        lines.push(
            `- [${entry.label}](archive/${archiveFilenameForKey(entry.periodKey)}) - ${entry.done} done / ${entry.cancelled} cancelled`,
        );
    }
    return lines;
}

function renderBacklog(state) {
    const taskSections = new Set(["Archive Index", ...TASK_SECTIONS]);
    const renderedSections = [];
    let archiveInserted = false;

    for (const section of state.parsedBacklog.sections) {
        if (taskSections.has(section.title)) {
            continue;
        }
        renderedSections.push(renderGenericSection(section.title, section.lines));
        if (section.title === "Area Legend") {
            renderedSections.push(renderArchiveIndexSection(state.archiveSummary));
            archiveInserted = true;
        }
    }

    if (!archiveInserted) {
        renderedSections.push(renderArchiveIndexSection(state.archiveSummary));
    }

    renderedSections.push(renderTaskSection("Now", state.activeRows.Now));
    renderedSections.push(renderTaskSection("Next", state.activeRows.Next));
    renderedSections.push(renderTaskSection("Later", state.activeRows.Later));
    renderedSections.push(renderTaskSection("Done", state.mainDone));
    renderedSections.push(renderTaskSection("Cancelled", state.mainCancelled));

    const blocks = [
        state.parsedBacklog.preamble.join("\n").trimEnd(),
        ...renderedSections.map((lines) => lines.join("\n").trimEnd()),
    ].filter(Boolean);

    return `${blocks.join("\n\n").trimEnd()}\n`;
}

function renderGenericSection(title, lines) {
    const body = trimBlankEdges(lines).join("\n");
    return [`## ${title}`, ...(body ? ["", body] : [])];
}

function trimBlankEdges(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && !String(lines[start] || "").trim()) {
        start += 1;
    }
    while (end > start && !String(lines[end - 1] || "").trim()) {
        end -= 1;
    }
    return lines.slice(start, end);
}

function groupArchiveRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const periodKey = row.periodKey || periodKeyForDate(row.completionDate);
        if (!grouped.has(periodKey)) {
            grouped.set(periodKey, {
                done: [],
                cancelled: [],
            });
        }
        grouped.get(periodKey)[row.status].push(row);
    }
    return grouped;
}

function renderArchiveFile(periodKey, rowsByStatus) {
    const label = archiveLabelForKey(periodKey);
    const doneRows = sortHistoricalRows(rowsByStatus.done || []);
    const cancelledRows = sortHistoricalRows(rowsByStatus.cancelled || []);
    const sections = [
        `# Backlog Archive: ${label}`,
        "",
        "This file stores older `done` and `cancelled` rows moved out of `docs/planning/backlog.md` by `.opencode/scripts/normalize-backlog.js` so the main backlog can stay focused on active work.",
        "",
        ...renderTaskSection("Done", doneRows),
        "",
        ...renderTaskSection("Cancelled", cancelledRows),
    ];
    return `${sections.join("\n").trimEnd()}\n`;
}

function renderArchiveIndexFile(archiveSummary) {
    const lines = [
        "# Backlog Archive Index",
        "",
        "Older `done` and `cancelled` history from `docs/planning/backlog.md` lives here. These files are meant to be read on demand when task IDs, checkpoints, or older notes matter again.",
        "",
        "## Files",
        "",
        "| File | Period | Done | Cancelled | Notes |",
        "| --- | --- | --- | --- | --- |",
    ];

    if (!archiveSummary.length) {
        lines.push("| (none) | n/a | 0 | 0 | No archive files have been created yet. |");
    } else {
        for (const entry of archiveSummary) {
            const note =
                entry.periodKey === "undated"
                    ? "Rows without a machine-readable completion date in Notes."
                    : "Older completed rows archived out of the active backlog.";
            lines.push(
                `| [${archiveFilenameForKey(entry.periodKey)}](${archiveFilenameForKey(entry.periodKey)}) | ${entry.label} | ${entry.done} | ${entry.cancelled} | ${note} |`,
            );
        }
    }

    lines.push(
        "",
        "## Retrieval",
        "",
        '- Search by task ID: `rg "P0-DOCS-006" docs/planning/archive docs/checkpoints`',
        '- Search by theme or component/profile names the same way when a checkpoint path alone is not enough.',
    );
    return `${lines.join("\n").trimEnd()}\n`;
}

function desiredOutputs(state) {
    const outputs = new Map();
    outputs.set(state.backlogPath, renderBacklog(state));

    const archiveGroups = groupArchiveRows(state.archiveRows);
    const archiveSummary = [...archiveGroups.keys()]
        .sort((left, right) => {
            if (left === right) {
                return 0;
            }
            if (left === "undated") {
                return 1;
            }
            if (right === "undated") {
                return -1;
            }
            return right.localeCompare(left);
        })
        .map((periodKey) => {
            const rows = archiveGroups.get(periodKey);
            outputs.set(
                path.join(state.archiveDir, archiveFilenameForKey(periodKey)),
                renderArchiveFile(periodKey, rows),
            );
            return {
                periodKey,
                label: archiveLabelForKey(periodKey),
                done: rows.done.length,
                cancelled: rows.cancelled.length,
            };
        });

    outputs.set(path.join(state.archiveDir, "index.md"), renderArchiveIndexFile(archiveSummary));
    return {
        outputs,
        archiveSummary,
    };
}

function computeDiffState(outputs, archiveDir) {
    const changed = [];
    const currentManaged = fs.existsSync(archiveDir)
        ? fs
              .readdirSync(archiveDir)
              .filter((name) => MANAGED_ARCHIVE_PATTERN.test(name))
              .map((name) => path.join(archiveDir, name))
        : [];
    const desiredArchivePaths = [...outputs.keys()].filter(
        (filePath) =>
            path.dirname(filePath) === archiveDir && path.basename(filePath) !== "index.md",
    );
    const desiredSet = new Set(desiredArchivePaths);

    for (const [filePath, content] of outputs.entries()) {
        const current = fs.existsSync(filePath) ? readFileNormalized(filePath) : "";
        if (current !== content) {
            changed.push(filePath);
        }
    }

    const removed = currentManaged.filter((filePath) => !desiredSet.has(filePath));
    return {
        changed,
        removed,
    };
}

function writeOutputs(outputs, archiveDir, removed) {
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const [filePath, content] of outputs.entries()) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
    }
    for (const filePath of removed) {
        fs.rmSync(filePath, { force: true });
    }
}

function renderSummary(state, archiveSummary, diffState) {
    const lines = [
        `Normalized backlog at ${path.relative(REPO_ROOT, state.backlogPath) || state.backlogPath}`,
        `- Now: ${state.activeRows.Now.length} active rows`,
        `- Next: ${state.activeRows.Next.length} active rows`,
        `- Later: ${state.activeRows.Later.length} active rows`,
        `- Done kept in main backlog: ${state.mainDone.length}`,
        `- Cancelled kept in main backlog: ${state.mainCancelled.length}`,
    ];

    if (!archiveSummary.length) {
        lines.push("- Archive files: none");
    } else {
        lines.push(`- Archive files: ${archiveSummary.length}`);
        for (const entry of archiveSummary) {
            lines.push(
                `  - ${archiveFilenameForKey(entry.periodKey)}: ${entry.done} done / ${entry.cancelled} cancelled`,
            );
        }
    }

    if (diffState.changed.length || diffState.removed.length) {
        lines.push(
            `- Pending file updates: ${diffState.changed.length} changed, ${diffState.removed.length} removed`,
        );
    } else {
        lines.push("- Pending file updates: none");
    }

    return lines.join("\n");
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(options.backlogPath)) {
        throw new BacklogError(`Backlog file not found: ${options.backlogPath}`);
    }

    const state = buildState(options.backlogPath, options.archiveDir, {
        mainDoneLimit: options.mainDoneLimit,
        mainCancelledLimit: options.mainCancelledLimit,
    });
    const { outputs, archiveSummary } = desiredOutputs(state);
    const diffState = computeDiffState(outputs, options.archiveDir);
    const summary = renderSummary(state, archiveSummary, diffState);

    if (options.check) {
        if (diffState.changed.length || diffState.removed.length) {
            throw new BacklogError(`Backlog cleanup required.\n${summary}`);
        }
        process.stdout.write(`${summary}\n`);
        return;
    }

    writeOutputs(outputs, options.archiveDir, diffState.removed);
    process.stdout.write(`${summary}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
    try {
        main();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    }
}
