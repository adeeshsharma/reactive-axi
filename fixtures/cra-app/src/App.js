import logo from './logo.svg';
import * as Accordion from '@radix-ui/react-accordion';
import * as Dialog from '@radix-ui/react-dialog';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.js</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>

      <section id="vendor-components">
        <h2>Radix Accordion &amp; Dialog examples</h2>
        <p>
          Rendered by real npm dependencies (<code>@radix-ui/react-accordion</code>,{' '}
          <code>@radix-ui/react-dialog</code>), not application code.
        </p>
        <Accordion.Root type="single" collapsible>
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
            <Dialog.Overlay />
            <Dialog.Content id="vendor-dialog-content">
              <Dialog.Title>Vendor dialog</Dialog.Title>
              <Dialog.Description>
                Rendered by @radix-ui/react-dialog, portaled to document.body.
              </Dialog.Description>
              <Dialog.Close id="vendor-dialog-close">Close</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </section>
    </div>
  );
}

export default App;
