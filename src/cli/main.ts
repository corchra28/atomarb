import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, resolveEndpoints } from '../config/load.js'
import { JsonlLogger } from '../telemetry/log.js'
import { nowUtcIso } from '../util/time.js'
const COMMANDS = ['doctor', 'discover', 'quote', 'simulate', 'shadow', 'report', 'stop'] as const
type Command = typeof COMMANDS[number]
export interface Args { command: Command; flags: Record<string, string | true> }
export function parseArgs(argv: string[]): Args {
  const [cmd, ...rest] = argv
  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) throw new Error(`usage: atomarb <${COMMANDS.join('|')}> [--config <file>] [--flag value]`)
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const k = a.slice(2); const v = rest[i + 1]
    if (v !== undefined && !v.startsWith('--')) { flags[k] = v; i++ } else flags[k] = true
  }
  return { command: cmd as Command, flags }
}
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = typeof args.flags['config'] === 'string' ? args.flags['config'] : 'config/config.example.json'
  const loaded = loadConfig(configPath)
  const { config } = loaded
  const log = new JsonlLogger({ path: join(config.paths.dataDir, 'logs', `${args.command}.jsonl`), minLevel: args.flags['verbose'] ? 'debug' : 'info' })
  const stopFile = join(config.paths.dataDir, 'STOP')
  switch (args.command) {
    case 'stop': { mkdirSync(config.paths.dataDir, { recursive: true }); writeFileSync(stopFile, nowUtcIso()); console.log(`STOP file written: ${stopFile} (running shadow/discover loops terminate at the next checkpoint)`); return 0 }
    case 'doctor': { const { doctor } = await import('./doctor.js'); return doctor(loaded, log) }
    case 'discover': { const { discover } = await import('./discover.js'); return discover(loaded, args.flags, log) }
    case 'quote': { const { quote } = await import('./quote.js'); return quote(loaded, args.flags, log) }
    case 'simulate': { const { simulate } = await import('./simulate.js'); return simulate(loaded, args.flags, log) }
    case 'shadow': { if (existsSync(stopFile)) { console.error(`STOP file present at ${stopFile}; remove it to start`); return 2 } const { shadow } = await import('./shadow.js'); return shadow(loaded, args.flags, log) }
    case 'report': { const { report } = await import('./report.js'); return report(loaded, args.flags, log) }
  }
  void resolveEndpoints
  return 1
}
main().then(code => process.exit(code)).catch(err => { console.error(`ERROR: ${(err as Error).message}`); process.exit(1) })
