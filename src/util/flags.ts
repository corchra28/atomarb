/**
 * Explicit CLI flag parsing for the one-off scripts.
 *
 * Reason (independent audit F6): `Number(argv[argv.indexOf('--max-requests') + 1] || 120)` reads argv[0] — the node binary path — whenever the flag is
 * ABSENT, because indexOf() returns -1. The result is NaN, and NaN silently disables every budget check (`usage >= NaN` is always false), so a "limited"
 * diagnostic run has no limit at all. A missing flag must therefore fall back to its documented default, and a PRESENT flag must carry a valid value or
 * the caller stops with a clear message instead of guessing.
 */
export type FlagErrorCode = 'FLAG_BAD_NAME' | 'FLAG_REPEATED' | 'FLAG_VALUE_MISSING' | 'FLAG_NOT_AN_INTEGER' | 'FLAG_NOT_POSITIVE'
export class FlagError extends Error {
  constructor(readonly code: FlagErrorCode, readonly flag: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FlagError'
  }
}

/**
 * Raw string value of `--name value` or `--name=value`. Returns null when the flag is absent (the caller then applies its documented default).
 * Throws FlagError when the flag appears more than once (ambiguous) or carries no value (end of argv, empty `--name=`, or another flag next).
 * `argv` must be the user's arguments only (`process.argv.slice(2)`), never the raw process.argv.
 */
export function flagValue(argv: readonly string[], name: string): string | null {
  if (!name.startsWith('--') || name.length <= 2 || name.includes('=')) throw new FlagError('FLAG_BAD_NAME', name, `flag name must look like --some-flag, got ${JSON.stringify(name)}`)
  let found: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    let raw: string | null = null
    if (a === name) {
      const next = i + 1 < argv.length ? argv[i + 1]! : null
      if (next === null || next.startsWith('--')) throw new FlagError('FLAG_VALUE_MISSING', name, `${name} needs a value (got ${next === null ? 'end of arguments' : JSON.stringify(next)})`)
      raw = next; i++
    } else if (a.startsWith(`${name}=`)) {
      raw = a.slice(name.length + 1)
      if (raw === '') throw new FlagError('FLAG_VALUE_MISSING', name, `${name}= needs a value after the '='`)
    } else continue
    if (found !== null) throw new FlagError('FLAG_REPEATED', name, `${name} given more than once (${JSON.stringify(found)} then ${JSON.stringify(raw)})`)
    found = raw
  }
  return found
}

/**
 * A count/limit flag: absent -> `defaultValue` (documented by the caller's usage string), present -> must be a decimal, finite, positive, safe integer.
 * Anything else (NaN, 1e3, 12.5, -1, 0, a value larger than Number.MAX_SAFE_INTEGER) is a hard error: a budget that cannot be honoured exactly is not a budget.
 */
export function positiveIntFlag(argv: readonly string[], name: string, defaultValue: number): number {
  const raw = flagValue(argv, name)
  if (raw === null) {
    if (!Number.isSafeInteger(defaultValue) || defaultValue <= 0) throw new FlagError('FLAG_NOT_POSITIVE', name, `default for ${name} must be a positive integer, got ${defaultValue}`)
    return defaultValue
  }
  const s = raw.trim()
  if (!/^[0-9]+$/.test(s)) throw new FlagError('FLAG_NOT_AN_INTEGER', name, `${name} must be a decimal integer, got ${JSON.stringify(raw)}`)
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new FlagError('FLAG_NOT_AN_INTEGER', name, `${name}=${s} is above Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`)
  if (n <= 0) throw new FlagError('FLAG_NOT_POSITIVE', name, `${name} must be > 0, got ${n}`)
  return n
}

/** Runs a parse block; a FlagError prints code + message + usage on stderr and exits 2 (scripts only — libraries must let the FlagError propagate). */
export function exitOnFlagError<T>(parse: () => T, usage: string): T {
  try {
    return parse()
  } catch (e) {
    if (e instanceof FlagError) {
      console.error(e.message)
      console.error(usage)
      process.exit(2)
    }
    throw e
  }
}
