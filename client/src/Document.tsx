import { useTranslation } from 'react-i18next'

export function Document({
  url,
  netAmount,
  taxAmount,
  grossAmount,
}: { url: string | null, netAmount: number | null, taxAmount: number | null, grossAmount: number | null }): any {
  const { t } = useTranslation('Document')

  return (
    <div>
      {
        url ?
          <iframe
            className="w-100 mb-2"
            style={ { minHeight: '80vh' } }
            src={ url }
            title="Document"
          ></iframe> :
          null
      }

      <form>
        <div className="mb-3">
          <label htmlFor="netAmount" className="form-label">{ t('Net amount') }</label>
          <div className="input-group">
            <input
              type="number"
              className="form-control"
              id="netAmount"
              min="0"
              defaultValue={ typeof netAmount === 'number' ? netAmount.toFixed(2) : '' }
            />
            <span className="input-group-text">€</span>
          </div>
        </div>

        <div className="mb-3">
          <label htmlFor="taxAmount" className="form-label">{ t('Taxes') }</label>
          <div className="input-group">
            <input
              type="number"
              className="form-control"
              id="taxAmount"
              min="0"
              defaultValue={ typeof taxAmount === 'number' ? taxAmount.toFixed(2) : '' }
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
              defaultValue={ typeof grossAmount === 'number' ? grossAmount.toFixed(2) : '' }
            />
            <span className="input-group-text">€</span>
          </div>
        </div>
      </form>
    </div>
  )
}
