import { useTranslation } from 'react-i18next'

export function Document(): any {
  const { t } = useTranslation('Document')

  return (
    <div>
      <iframe
        className="w-100 mb-2"
        style={ { minHeight: '400px' } }
        src="https://storage.googleapis.com/accounting-documents-public/Invoice_Example_German.pdf"
        title="Document"
      ></iframe>

      <form>
        <div className="mb-3">
          <label htmlFor="netAmount" className="form-label">{ t('Net amount') }</label>
          <div className="input-group">
            <input
              type="number"
              className="form-control"
              id="netAmount"
              min="0"
              defaultValue={ 780 }
            />
            <span className="input-group-text">€</span>
          </div>
        </div>

        <div className="mb-3">
          <label htmlFor="netAmount" className="form-label">{ t('Taxes') }</label>
          <div className="input-group">
            <input
              type="number"
              className="form-control"
              id="netAmount"
              min="0"
              defaultValue={ 148.20 }
            />
            <span className="input-group-text">€</span>
          </div>
        </div>

        <div>
          <label htmlFor="grossAmount" className="form-label">{ t('Gross amount') }</label>
          <div className="input-group">
            <input
              type="number"
              className="form-control"
              id="grossAmount"
              min="0"
              defaultValue={ 928.20 }
            />
            <span className="input-group-text">€</span>
          </div>
        </div>
      </form>
    </div>
  )
}
