<script setup>
import { inject } from "vue";

const openValue = inject("accordion-open-value");
const itemValue = inject("accordion-item-value");

function toggle() {
  openValue.value = openValue.value === itemValue ? null : itemValue;
}
</script>

<template>
  <button type="button" class="vendor-accordion-trigger" @click="toggle">
    <slot />
  </button>
</template>
