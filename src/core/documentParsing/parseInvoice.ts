import { v1 } from '@google-cloud/documentai'
import { google } from '@google-cloud/documentai/build/protos/protos'

const { DocumentProcessorServiceClient } = v1

export async function parseInvoice(gcsSourceUri: string, gcsDestinationUri: string): Promise<void> {
  const projectId = 'accounting-339615'
  const location = 'eu'
  const processorId = '9ca545f0ab145267'

  const client = new DocumentProcessorServiceClient({ apiEndpoint: 'eu-documentai.googleapis.com' })

  const name = `projects/${ projectId }/locations/${ location }/processors/${ processorId }`

  const request = {
    name,
    inputDocuments: {
      gcsDocuments: {
        documents: [
          {
            gcsUri: gcsSourceUri,
            mimeType: 'application/pdf',
          },
        ],
      },
    },
    documentOutputConfig: {
      gcsOutputConfig: {
        gcsUri: gcsDestinationUri,
      },
    },
  }

  try {
    const [operation] = await client.batchProcessDocuments(request)
    await operation.promise()
  } catch (error: any) {
    console.error(error)
  }
}
