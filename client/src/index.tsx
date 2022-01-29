import 'bootstrap/dist/css/bootstrap.css'

import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import React from 'react'
import ReactDOM from 'react-dom'
import App from './App'
import { firebaseConfig } from './firebaseConfig.js'
import './index.css'
import reportWebVitals from './reportWebVitals'

initializeApp(firebaseConfig)

window.signIn = async function (email: string, password: string) {
  const auth = getAuth()
  await signInWithEmailAndPassword(auth, email, password)
}
declare global {
  interface Window {
    signIn(email: string, password: string): Promise<void>
  }
}

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root'),
)

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals()
