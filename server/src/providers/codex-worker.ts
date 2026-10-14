import {runProviderWorker} from '../worker-protocol.js'
import {createCodexDriver} from './codex/driver.js'

await runProviderWorker(createCodexDriver())
