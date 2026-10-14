import {ClaudeDriver} from './claude/driver.js'
import {runProviderWorker} from '../worker-protocol.js'

process.env.DISABLE_UPDATES = '1'
await runProviderWorker(new ClaudeDriver())
