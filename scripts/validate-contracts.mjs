import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const CONTRACT_PATH = path.join(ROOT, 'contracts', 'GovernanceArb.sol')
const SOURCE_NAME = 'GovernanceArb.sol'

function fail(message) {
  console.error(`[contracts:check] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(CONTRACT_PATH)) {
  fail(`contract not found: ${CONTRACT_PATH}`)
}

const source = fs.readFileSync(CONTRACT_PATH, 'utf8')
const input = {
  language: 'Solidity',
  sources: {
    [SOURCE_NAME]: { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object'],
      },
    },
  },
}

const compile = spawnSync(
  'npx',
  ['--yes', 'solc@0.8.34', '--standard-json'],
  {
    input: JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  },
)

if (compile.error) {
  fail(`failed to execute solc via npx: ${compile.error.message}`)
}
if (compile.status !== 0) {
  fail(`solc exited with code ${compile.status}: ${compile.stderr || compile.stdout}`)
}

const rawOutput = compile.stdout.trim()
const jsonStart = rawOutput.indexOf('{')
if (jsonStart < 0) {
  fail(`unexpected solc output (no JSON): ${rawOutput.slice(0, 500)}`)
}

const output = JSON.parse(rawOutput.slice(jsonStart))
const messages = output.errors ?? []
const errors = messages.filter((m) => m.severity === 'error')
const warnings = messages.filter((m) => m.severity === 'warning')

for (const w of warnings) {
  console.warn(`[contracts:check] warning: ${w.formattedMessage?.trim() ?? w.message}`)
}

if (errors.length > 0) {
  for (const e of errors) {
    console.error(`[contracts:check] error: ${e.formattedMessage?.trim() ?? e.message}`)
  }
  fail(`solidity compile failed (${errors.length} error(s))`)
}

const contractOutput = output.contracts?.[SOURCE_NAME]?.GovernanceArb
if (!contractOutput?.evm?.bytecode?.object) {
  fail('compile output missing GovernanceArb bytecode')
}

console.log('[contracts:check] GovernanceArb.sol compiled successfully')
