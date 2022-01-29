import React, { useCallback, useState } from 'react'

export function DocumentUpload() {
  const [isUploading, setIsUploading] = useState(false)
  const onSubmit = useCallback(
    () => {
      setIsUploading(true)
    },
    [],
  )

  return (
    <div className="container">
      <div className="row">
        <div className="col">
          <h1>Document upload</h1>
          {
            isUploading ?
              <div>
                <div className="progress" style={ { height: '36px' } }>
                  <div
                    className="progress-bar"
                    role="progressbar"
                    aria-valuenow={ 0 }
                    aria-valuemin={ 0 }
                    aria-valuemax={ 100 }
                  />
                </div>
              </div> :
              <form onSubmit={ onSubmit }>
                <div className="mb-3">
                  <label htmlFor="formFileLg" className="form-label">Document</label>
                  <input
                    className="form-control form-control-lg"
                    id="formFileLg"
                    type="file"
                    accept=".pdf"
                  />
                </div>

                <div className="text-end">
                  <button type="submit" className="btn btn-primary btn-lg">Upload</button>
                </div>
              </form>
          }
        </div>
      </div>
    </div>
  )
}
