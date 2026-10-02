/** Parsed command-line options: positionals, values by name (repeatable ones keep every occurrence), and flags. */
export interface ParsedOptions {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export interface OptionSpec {
  /** Options that take one value each time they appear, such as `--root dir`. */
  values: readonly string[];
  /** Value options that may repeat, such as `--portal wealth --portal advisor`. */
  repeatable?: readonly string[];
  flags: readonly string[];
}

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export function parseOptions(args: readonly string[], spec: OptionSpec): ParsedOptions {
  const parsed: ParsedOptions = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      parsed.positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (spec.flags.includes(argument)) {
      parsed.flags.add(name);
      continue;
    }
    if (!spec.values.includes(argument) && !(spec.repeatable ?? []).includes(argument)) throw new CliUsageError(`Unknown option ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliUsageError(`Missing value for ${argument}`);
    const existing = parsed.values.get(name) ?? [];
    if (existing.length > 0 && !(spec.repeatable ?? []).includes(argument)) throw new CliUsageError(`${argument} may be given only once`);
    parsed.values.set(name, [...existing, value]);
    index += 1;
  }
  return parsed;
}

export function single(parsed: ParsedOptions, name: string): string | undefined {
  return parsed.values.get(name)?.[0];
}

export function integer(parsed: ParsedOptions, name: string): number | undefined {
  const value = single(parsed, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliUsageError(`--${name} must be a positive integer`);
  return Number(value);
}
