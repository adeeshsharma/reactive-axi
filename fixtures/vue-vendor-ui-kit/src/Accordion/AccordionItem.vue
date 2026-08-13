<script setup>
import { provide } from "vue";

const props = defineProps({ value: { type: String, required: true } });
provide("accordion-item-value", props.value);
</script>

<template>
  <div class="vendor-accordion-item">
    <slot />
  </div>
</template>
