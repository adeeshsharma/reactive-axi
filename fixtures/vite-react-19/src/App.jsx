import { useState } from 'react'
import * as Accordion from '@radix-ui/react-accordion'
import * as Dialog from '@radix-ui/react-dialog'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Get Started Now</h1>
          <p>
            Edit <code>src/App.jsx</code> and save to test <code>HMR</code>
          </p>
          <p className="hmr-note">
            Under the hood, Vite swaps just the edited module in over a
            WebSocket connection, so the page updates instantly without a
            full reload — and state like the counter below survives.
          </p>
        </div>
        <button
          type="button"
          className="counter"
          onClick={() => setCount((count) => count + 1)}
        >
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="next-steps">
        <div id="docs">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#documentation-icon"></use>
          </svg>
          <h2>Documentation</h2>
          <p>Your questions, answered</p>
          <ul>
            <li>
              <a href="https://vite.dev/" target="_blank">
                <img className="logo" src={viteLogo} alt="" />
                Explore Vite
              </a>
            </li>
            <li>
              <a href="https://react.dev/" target="_blank">
                <img className="button-icon" src={reactLogo} alt="" />
                Learn more
              </a>
            </li>
          </ul>
        </div>
        <div id="social">
          <svg className="icon" role="presentation" aria-hidden="true">
            <use href="/icons.svg#social-icon"></use>
          </svg>
          <h2>Connect with us</h2>
          <p>Join the Vite community</p>
          <ul>
            <li>
              <a href="https://github.com/vitejs/vite" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#github-icon"></use>
                </svg>
                GitHub
              </a>
            </li>
            <li>
              <a href="https://chat.vite.dev/" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#discord-icon"></use>
                </svg>
                Discord
              </a>
            </li>
            <li>
              <a href="https://x.com/vite_js" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#x-icon"></use>
                </svg>
                X.com
              </a>
            </li>
            <li>
              <a href="https://bsky.app/profile/vite.dev" target="_blank">
                <svg
                  className="button-icon"
                  role="presentation"
                  aria-hidden="true"
                >
                  <use href="/icons.svg#bluesky-icon"></use>
                </svg>
                Bluesky
              </a>
            </li>
          </ul>
        </div>
      </section>

      <div className="ticks"></div>

      <section id="vendor-components">
        <h2>Radix Accordion &amp; Dialog examples</h2>
        <p>
          Rendered by real npm dependencies (<code>@radix-ui/react-accordion</code>,{' '}
          <code>@radix-ui/react-dialog</code>), not application code — used to verify
          click-to-source resolves here, not into the library's own internals.
        </p>
        <Accordion.Root type="single" collapsible className="vendor-accordion">
          <Accordion.Item value="item-1">
            <Accordion.Header>
              <Accordion.Trigger id="vendor-accordion-trigger">
                Vendor accordion trigger
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content id="vendor-accordion-content">
              Vendor accordion content
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
        <Dialog.Root>
          <Dialog.Trigger id="vendor-dialog-trigger">Open vendor dialog</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="vendor-dialog-overlay" />
            <Dialog.Content id="vendor-dialog-content" className="vendor-dialog-content">
              <Dialog.Title>Vendor dialog</Dialog.Title>
              <Dialog.Description>
                Rendered by @radix-ui/react-dialog, portaled to document.body.
              </Dialog.Description>
              <Dialog.Close id="vendor-dialog-close">Close</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
    </>
  )
}

export default App
