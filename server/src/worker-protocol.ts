import type {ProviderDriver, WorkerRequest, WorkerResponse, WorkerUpdate} from './provider-types.js'

export async function runProviderWorker(driver: ProviderDriver) {
  let closing = false
  let ready = false
  const emit = () => {
    if (process.connected && !closing && ready) process.send?.({type: 'state', state: driver.state()} satisfies WorkerUpdate)
  }
  const timer = setInterval(emit, 500)
  const shutdown = async () => {
    if (closing) return
    closing = true
    clearInterval(timer)
    await driver.shutdown()
  }
  process.on('message', (raw: WorkerRequest) => {
    if (!raw || raw.type !== 'request' || !Number.isSafeInteger(raw.id) || typeof raw.action !== 'string') return
    void (async () => {
      try {
        const result = raw.action === 'shutdown' ? await shutdown() : await driver.request(raw.action, raw.args ?? {})
        if (raw.action !== 'shutdown') emit()
        if (process.connected) process.send?.({type: 'response', id: raw.id, ok: true, result} satisfies WorkerResponse)
        if (raw.action === 'shutdown') setImmediate(() => process.exit(0))
      } catch {
        if (process.connected) process.send?.({type: 'response', id: raw.id, ok: false, error: 'La operación del proveedor no pudo completarse. Revisa su estado y registro.'} satisfies WorkerResponse)
        emit()
      }
    })()
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)) })
  process.on('disconnect', () => { void shutdown().finally(() => process.exit(0)) })
  await driver.boot()
  ready = true
  emit()
}
