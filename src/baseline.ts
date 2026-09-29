import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NoticesDocument } from "foss-notices-viewer";

export const DEFAULT_BASELINE_PATH = ".compliance/baseline.json";

/** Returns `undefined` if no baseline has been saved yet (first run). */
export async function loadBaseline(
  path: string,
): Promise<NoticesDocument | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as NoticesDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveBaseline(
  path: string,
  document: NoticesDocument,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(document, null, 2), "utf8");
}
