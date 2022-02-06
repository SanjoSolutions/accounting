import { useTranslation } from "react-i18next"

export function CreateBalanceSheet(): any {
  const { t } = useTranslation('CreateBalanceSheet')

  return (
    <div>
      <h1>{ t('Create balance sheet') }</h1>
      <form>
        <div className="mb-3">
          <label htmlFor="forYear" className="form-label">{ t('For year') }</label>
          <input type="number" className="form-control" id="forYear" defaultValue={new Date().getFullYear()} />
        </div>

        <div className="mb-3">
          <label htmlFor="type" className="form-label">{ t('Type') }</label>
          <select className="form-select" defaultValue="openingBalanceSheet">
            <option value="openingBalanceSheet">{ t('Opening balance sheet') }</option>
          </select>
        </div>
        
        <div className="text-end">
          <button className="btn btn-primary">{ t('Create balance sheet') }</button>
        </div>
      </form>
    </div>
  )
}
