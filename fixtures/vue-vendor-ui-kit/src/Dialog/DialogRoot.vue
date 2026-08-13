<script setup>
import { provide, ref } from "vue";

const isOpen = ref(false);
provide("dialog-open", isOpen);
</script>

<template>
  <div class="vendor-dialog-root">
    <slot />
  </div>
</template>
