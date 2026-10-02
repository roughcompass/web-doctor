import fs from "node:fs/promises";
import path from "node:path";
import { parseContract, type RepositoryConfig } from "../contracts/index.js";

export const REPOSITORY_CONFIG_FILE = "web-doctor.config.json";
const MAX_CONFIG_BYTES = 65_536;

export interface LoadedRepositoryConfig {
  /** The configuration file's path relative to the application root, or null when there is none. */
  path: string | null;
  config: RepositoryConfig | null;
}

export class RepositoryConfigError extends Error {
  override readonly name = "RepositoryConfigError";
}

/**
 * Reads the optional `web-doctor.config.json` at the application root as
 * data. A link, an oversized file, invalid JSON, or an invalid document is an
 * error rather than an ignored configuration.
 */
export async function loadRepositoryConfig(root: string): Promise<LoadedRepositoryConfig> {
  const file = path.join(root, REPOSITORY_CONFIG_FILE);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path: null, config: null };
    throw error;
  }
  if (!stat.isFile()) throw new RepositoryConfigError(`${REPOSITORY_CONFIG_FILE} must be a regular file, not a link or directory`);
  if (stat.size > MAX_CONFIG_BYTES) throw new RepositoryConfigError(`${REPOSITORY_CONFIG_FILE} exceeds ${MAX_CONFIG_BYTES} bytes`);
  let input: unknown;
  try {
    input = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new RepositoryConfigError(`${REPOSITORY_CONFIG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { path: REPOSITORY_CONFIG_FILE, config: parseContract("repositoryConfig", input) as RepositoryConfig };
  } catch (error) {
    throw new RepositoryConfigError(`${REPOSITORY_CONFIG_FILE} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}
