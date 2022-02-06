import React from 'react'
import { Route, Routes } from 'react-router-dom'
import './App.css'
import { CreateBalanceSheet } from './CreateBalanceSheet'
import { CreateBookingRecord } from './CreateBookingRecord'
import { LanguageSelect } from './LanguageSelect.js'
import { Navbar } from './Navbar'
import { Settings } from './Settings'

export function App() {
  return (
    <div>
      <Navbar />

      <div className="container">
        <div className="row mb-2">
          <div className="col">
            <Routes>
              <Route path="/" element={ <CreateBookingRecord /> } />
              <Route path="balance-sheets/create" element={ <CreateBalanceSheet /> } />
              <Route path="settings" element={ <Settings /> } />
            </Routes>

            <div className="mt-5 border-top pt-2 text-end">
              <LanguageSelect />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
