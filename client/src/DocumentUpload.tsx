import { getStorage, ref, uploadBytesResumable } from 'firebase/storage'
import React, { useCallback, useRef, useState } from 'react'

export function DocumentUpload() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const onSubmit = useCallback(
    (event) => {
      event.preventDefault()

      setIsUploading(true)
      const storage = getStorage()
      const storageRef = ref(storage, `${ Date.now() }.pdf`)

      const files = fileInput.current!.files!
      if (files.length >= 1) {
        const file = files.item(0)!
        const uploadTask = uploadBytesResumable(storageRef, file)
        uploadTask.on(
          'state_changed',
          ({ bytesTransferred, totalBytes, state }) => {
            setUploadProgress(bytesTransferred * 100 / totalBytes)
          },
          (error) => {
            console.error(error)
          },
          () => {
            setIsUploading(false)
          },
        )
      }
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
                    aria-valuenow={ uploadProgress }
                    aria-valuemin={ 0 }
                    aria-valuemax={ 100 }
                  />
                </div>
              </div> :
              <form onSubmit={ onSubmit }>
                <div className="mb-3">
                  <label htmlFor="file" className="form-label">Document</label>
                  <input
                    ref={ fileInput }
                    className="form-control form-control-lg"
                    id="file"
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
