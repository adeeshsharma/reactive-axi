import { createFileRoute } from '@tanstack/react-router'
import * as Accordion from '@radix-ui/react-accordion'
import * as Dialog from '@radix-ui/react-dialog'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main>
      <div className="hero">
        <span className="badge">TanStack Start</span>
        <h1>Welcome to TanStack Start</h1>
        <p>
          Edit <code>src/routes/index.tsx</code> to get started.
        </p>
      </div>

      <section id="vendor-components" className="card">
        <h2>Radix Accordion &amp; Dialog examples</h2>
        <p>
          Rendered by real npm dependencies (<code>@radix-ui/react-accordion</code>,{' '}
          <code>@radix-ui/react-dialog</code>), not application code.
        </p>
        <Accordion.Root type="single" collapsible className="accordion">
          <Accordion.Item value="item-1" className="accordion-item">
            <Accordion.Header>
              <Accordion.Trigger id="vendor-accordion-trigger" className="accordion-trigger">
                Vendor accordion trigger
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content id="vendor-accordion-content" className="accordion-content">
              Vendor accordion content
            </Accordion.Content>
          </Accordion.Item>
        </Accordion.Root>
        <Dialog.Root>
          <Dialog.Trigger id="vendor-dialog-trigger" className="btn">
            Open vendor dialog
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content id="vendor-dialog-content" className="dialog-content">
              <Dialog.Title>Vendor dialog</Dialog.Title>
              <Dialog.Description>
                Rendered by @radix-ui/react-dialog, portaled to document.body.
              </Dialog.Description>
              <Dialog.Close id="vendor-dialog-close" className="btn btn-ghost">
                Close
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
    </main>
  )
}
