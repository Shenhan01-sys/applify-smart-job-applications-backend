import { parentPort, workerData } from 'node:worker_threads'
import { extractText, extractTextItems, getDocumentProxy } from 'unpdf'

/**
 * Worker thread terpisah untuk mengurai PDF dengan `unpdf` (audit 47.1 P2-6).
 * Bila timeout terjadi di thread utama, `worker.terminate()` memutus proses CPU `pdf.js` secara nyata.
 */
async function run() {
  const bytes = workerData?.buffer
  const maxPages = Number(workerData?.maxPages) || 25
  if (!(bytes instanceof Uint8Array)) {
    parentPort?.postMessage({ ok: false, errorName: 'InvalidInput' })
    return
  }

  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try {
    if (pdf.numPages > maxPages) {
      parentPort?.postMessage({ ok: false, errorCode: 'pdf_too_long', numPages: pdf.numPages })
      return
    }

    let itemsPerPage = null
    try {
      const extracted = await extractTextItems(pdf)
      if (Array.isArray(extracted?.items) && extracted.items.length > 0) {
        itemsPerPage = extracted.items
      }
    } catch {
      itemsPerPage = null
    }

    if (itemsPerPage) {
      parentPort?.postMessage({ ok: true, itemsPerPage })
      return
    }

    const { text } = await extractText(pdf, { mergePages: false })
    const fallbackPages = Array.isArray(text) ? text : [String(text ?? '')]
    parentPort?.postMessage({ ok: true, fallbackPages })
  } finally {
    try {
      await pdf?.destroy?.()
    } catch {
      // Abaikan kegagalan pembersihan memori pdf.js
    }
  }
}

run().catch((err) => {
  parentPort?.postMessage({ ok: false, errorName: err?.name ?? 'Error' })
})
