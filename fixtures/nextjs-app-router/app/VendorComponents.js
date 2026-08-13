"use client";

// A real Client Component boundary ("use client") - App Router's default is Server Components,
// which have no client-side Fiber presence at all (confirmed real, techContext.md's RSC
// findings) and so are permanently unresolvable to a click-to-source location, by design, not
// a bug. This file exists specifically to give the fixture something clickable at all - without
// it, `page.js` alone has zero elements reachable via click-to-source, vendor or not.
import * as Accordion from "@radix-ui/react-accordion";
import * as Dialog from "@radix-ui/react-dialog";

export default function VendorComponents() {
  return (
    <section id="vendor-components">
      <h2>Radix Accordion &amp; Dialog examples</h2>
      <p>
        Rendered by real npm dependencies (<code>@radix-ui/react-accordion</code>,{" "}
        <code>@radix-ui/react-dialog</code>), not application code - inside a real Client
        Component boundary, since Server Components have no click-to-source target at all.
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
  );
}
