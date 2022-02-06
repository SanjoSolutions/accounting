import { v1 as vision } from '@google-cloud/vision';
export async function parseDocument(gcsSourceUri, gcsDestinationUri) {
    const client = new vision.ImageAnnotatorClient();
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
    };
    const [operation] = await client.asyncBatchAnnotateFiles(request);
    const [filesResponse] = await operation.promise();
    console.log(filesResponse);
    const destinationUri = filesResponse.responses[0].outputConfig.gcsDestination.uri;
    return destinationUri;
}
//# sourceMappingURL=parseDocument.js.map