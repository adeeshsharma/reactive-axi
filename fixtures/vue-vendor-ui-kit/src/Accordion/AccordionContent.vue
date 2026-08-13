<script setup>
import { inject, computed } from "vue";

const openValue = inject("accordion-open-value");
const itemValue = inject("accordion-item-value");
const isOpen = computed(() => openValue.value === itemValue);
</script>

<template>
  <div v-if="isOpen" class="vendor-accordion-content">
    <slot />
  </div>
</template>
