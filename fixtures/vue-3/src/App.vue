<script setup>
import HelloWorld from './components/HelloWorld.vue'
import {
  AccordionRoot as RekaAccordionRoot,
  AccordionItem as RekaAccordionItem,
  AccordionHeader as RekaAccordionHeader,
  AccordionTrigger as RekaAccordionTrigger,
  AccordionContent as RekaAccordionContent,
} from 'reka-ui'
import { Accordion, Dialog } from '@fixture/vue-vendor-ui-kit'
</script>

<template>
  <HelloWorld />

  <section id="vendor-components">
    <h2>reka-ui &amp; @fixture/vue-vendor-ui-kit examples</h2>
    <p>
      Two different vendor cases on purpose: <code>reka-ui</code> is a real published
      headless-UI library (ships precompiled output, so its own SFC source is never compiled by
      this app's Vite instance - documented in fixtures/README.md as a non-reproducing case), and
      <code>@fixture/vue-vendor-ui-kit</code> is a real local workspace package (raw, uncompiled
      .vue SFC source, linked via <code>workspace:*</code> - a symlink, exactly like a real
      monorepo-local design-system package) - this one genuinely reproduces resolving into
      <code>node_modules</code> before the fix, and is the live test that a symlinked local
      package correctly resolves as app code afterward, not vendor.
    </p>

    <h3>reka-ui (real published library, precompiled - does not reproduce the bug)</h3>
    <RekaAccordionRoot type="single" collapsible>
      <RekaAccordionItem value="item-1">
        <RekaAccordionHeader>
          <RekaAccordionTrigger id="reka-accordion-trigger">
            reka-ui accordion trigger
          </RekaAccordionTrigger>
        </RekaAccordionHeader>
        <RekaAccordionContent id="reka-accordion-content">
          reka-ui accordion content
        </RekaAccordionContent>
      </RekaAccordionItem>
    </RekaAccordionRoot>

    <h3>@fixture/vue-vendor-ui-kit (local workspace package, raw SFC source)</h3>
    <Accordion.Root>
      <Accordion.Item value="item-1">
        <Accordion.Trigger id="vendor-accordion-trigger">
          Vendor accordion trigger
        </Accordion.Trigger>
        <Accordion.Content id="vendor-accordion-content">
          Vendor accordion content
        </Accordion.Content>
      </Accordion.Item>
    </Accordion.Root>
    <Dialog.Root>
      <Dialog.Trigger id="vendor-dialog-trigger">Open vendor dialog</Dialog.Trigger>
      <Dialog.Content id="vendor-dialog-content">
        <p>Vendor dialog content, teleported to document.body.</p>
      </Dialog.Content>
    </Dialog.Root>
  </section>
</template>
