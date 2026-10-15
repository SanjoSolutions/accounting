'use client'

import { useTranslations } from 'next-intl'
import { LocalCurrency } from './LocalNumber'
import { meinElsterFormsUrl, taxReviewDownload, taxReviewFieldUnit, type TaxPreparationResult } from './taxReview'

export function TaxReviewPanel({ result, preparedAt, kindLabel }: { result: TaxPreparationResult; preparedAt: string; kindLabel: string }) {
  const t = useTranslations('Tax.review')
  function download() {
    const file = taxReviewDownload(result, preparedAt)
    const url = URL.createObjectURL(new Blob([file.contents], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = file.fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="card panel mt-4" aria-labelledby="tax-review-title">
    <h2 id="tax-review-title">{t('title')}</h2>
    <p className="mb-2"><strong>{kindLabel}</strong> · {result.dataset.period}</p>
    <p className="alert alert-info">{t('localOnly')}</p>
    <ol className="ps-3">
      <li>{t('check')}</li>
      <li>{t('transfer')}</li>
      <li>{t('save')}</li>
    </ol>
    <p className="text-body-secondary">{t('limitation')}</p>
    <div className="d-flex flex-wrap gap-2 mb-3">
      <button type="button" className="btn btn-outline-primary" onClick={download}>{t('download')}</button>
      <a className="btn btn-outline-secondary" href={meinElsterFormsUrl} target="_blank" rel="noopener noreferrer">{t('openElster')}</a>
    </div>
    <p className="small text-body-secondary">{t('snapshot')}</p>
    <details>
      <summary>{t('values')}</summary>
      <p className="small text-body-secondary mt-2">{t('valuesHint')}</p>
      <div className="table-responsive"><table className="table table-sm">
        <thead><tr><th scope="col">{t('field')}</th><th scope="col">{t('value')}</th></tr></thead>
        <tbody>{Object.entries(result.dataset.fields).map(([field, value]) => <tr key={field}>
          <th scope="row" className="text-break">{field}</th>
          <td className="text-break">{taxReviewFieldUnit(field, value) === 'cents' ? <LocalCurrency cents={value as number} currency="EUR" /> : taxReviewFieldUnit(field, value) === 'basis-points' ? `${(value as number) / 100} %` : String(value)}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
  </section>
}
