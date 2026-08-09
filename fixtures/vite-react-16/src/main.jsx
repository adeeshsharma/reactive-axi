// React 16 predates the concurrent root API (createRoot, from react-dom/client, is 18+) -
// this is the legacy ReactDOM.render entry point instead.
import React, { StrictMode } from 'react'
import ReactDOM from 'react-dom'
import './index.css'
import App from './App.jsx'

ReactDOM.render(
  <StrictMode>
    <App />
  </StrictMode>,
  document.getElementById('root'),
)
