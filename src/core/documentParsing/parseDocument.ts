import { v1 as vision } from '@google-cloud/vision'
import { google } from '@google-cloud/vision/build/protos/protos.js'
import IAsyncBatchAnnotateFilesRequest = google.cloud.vision.v1.IAsyncBatchAnnotateFilesRequest

export async function parseDocument(gcsSourceUri: string, gcsDestinationUri: string): Promise<string> {
  const client = new vision.ImageAnnotatorClient()

  const request = {
    requests: [
      {
        inputConfig: {
          mimeType: 'application/pdf',
          gcsSource: {
            uri: gcsSourceUri,
          },
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION',
          },
        ],
        outputConfig: {
          gcsDestination: {
            uri: gcsDestinationUri,
          },
        },
      },
    ],
  } as IAsyncBatchAnnotateFilesRequest

  const [operation] = await client.asyncBatchAnnotateFiles(request)
  const [filesResponse] = await operation.promise()
  console.log(filesResponse)
  const destinationUri = filesResponse.responses![0].outputConfig!.gcsDestination!.uri!
  return destinationUri
}
