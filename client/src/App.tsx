import React from 'react'
import './App.css'
import { BookingRecordEditor } from './BookingRecordEditor'
import { DocumentUpload } from './DocumentUpload'

function App() {
  return (
    <div className="container">
      <div className="row">
        <div className="col">
          <h1>Document upload</h1>
          <div className="mb-3">
            <DocumentUpload />
          </div>
          <BookingRecordEditor />
        </div>
      </div>
    </div>
  )
}

export default App
