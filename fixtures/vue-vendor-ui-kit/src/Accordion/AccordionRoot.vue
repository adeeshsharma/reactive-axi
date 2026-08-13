<script setup>
import { provide, ref } from "vue";

const openValue = ref(null);
provide("accordion-open-value", openValue);
</script>

<template>
  <div class="vendor-accordion-root">
    <slot />
  </div>
</template>
