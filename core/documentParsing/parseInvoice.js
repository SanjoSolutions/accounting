import { v1 } from '@google-cloud/documentai';
const { DocumentProcessorServiceClient } = v1;
export async function parseInvoice(gcsSourceUri, gcsDestinationUri) {
    const projectId = 'accounting-339615';
    const location = 'eu';
    const processorId = '9ca545f0ab145267';
    const client = new DocumentProcessorServiceClient({ apiEndpoint: 'eu-documentai.googleapis.com' });
    const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;
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
    };
    try {
        const [operation] = await client.batchProcessDocuments(request);
        await operation.promise();
    }
    catch (error) {
        console.error(error);
    }
}
//# sourceMappingURL=parseInvoice.js.map